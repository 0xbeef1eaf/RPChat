import { randomUUID } from 'node:crypto';
import { RUN_ACTION_TOOL, extractFencedActions, stripFencedActions } from '@rp/llm';
import type {
  ActionContext,
  ActionRecord,
  CapabilityInvoker,
  ChatMessage,
  CodeRunResult,
  CodeRunner,
  ContentPart,
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmProvider,
  RunLimits,
  SdkSurface,
  Session,
} from '@rp/shared';
import { RUN_ACTION_TOOL_NAME, RpError, serializeError } from '@rp/shared';
import { recordExchange } from './services/exchanges.js';
import type { Clock, EngineEmitter, Logger } from './types.js';
import { NOOP_LOGGER } from './types.js';

export interface ActionLoopOptions {
  runner: CodeRunner;
  invoker: CapabilityInvoker;
  /** Persists messages; `add` must emit `message-added`. */
  messages: {
    add(message: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>): Promise<ChatMessage>;
    persist(message: ChatMessage): Promise<void>;
  };
  emitter: EngineEmitter;
  now?: Clock;
  logger?: Logger;
}

export interface TurnInput {
  session: Session;
  provider: LlmProvider;
  model: string;
  system: string;
  /** See `LlmChatRequest.systemStablePrefixChars`. */
  systemStablePrefixChars?: number;
  messages: LlmMessage[];
  useTools: boolean;
  maxActionRounds: number;
  temperature?: number;
  maxTokens?: number;
  /** Who is acting (trigger is filled in per action). */
  actor: Pick<ActionContext, 'packId' | 'characterId' | 'packRoot'>;
  surface: SdkSurface;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  origin?: 'llm' | 'timer';
  /** Emit a `model-exchange` event per provider call (`settings.debug.showModelTraffic`). Default false. */
  captureExchanges?: boolean;
  /** Provider config label/id written into the exchange records. */
  providerLabel?: string;
}

export const ACTION_LIMIT_NOTICE = '[system] action limit reached, reply with text only';

interface PendingAction {
  purpose: string;
  code: string;
  source: ActionRecord['source'];
  /** Tool-use id when the action came from a tool call. */
  toolUseId?: string;
}

function textOf(response: LlmChatResponse): string {
  return response.message.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function joinText(a: string, b: string): string {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return `${a}\n\n${b}`;
}

function toolInput(input: unknown): { purpose: string; code: string } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { purpose, code } = input as { purpose?: unknown; code?: unknown };
  if (typeof code !== 'string' || code.trim().length === 0) return undefined;
  return { purpose: typeof purpose === 'string' ? purpose : '', code };
}

/** Result payload sent back to the model. */
export function resultPayload(result: CodeRunResult): Record<string, unknown> {
  const payload: Record<string, unknown> = { ok: result.ok, returnValue: result.returnValue ?? null };
  if (result.error) payload.error = { code: result.error.code, message: result.error.message, details: result.error.details };
  if (result.logs.length > 0) payload.logs = result.logs.map((l) => `${l.level}: ${l.message}`);
  return payload;
}

/**
 * One assistant turn: call the provider, run every requested action in the
 * sandbox, feed the results back, repeat until the model answers with text
 * only or the round limit is hit. Emits the `ChatEvent` stream while doing so.
 */
export class ActionLoop {
  private readonly runner: CodeRunner;
  private readonly invoker: CapabilityInvoker;
  private readonly messages: ActionLoopOptions['messages'];
  private readonly emitter: EngineEmitter;
  private readonly now: Clock;
  private readonly logger: Logger;

  constructor(options: ActionLoopOptions) {
    this.runner = options.runner;
    this.invoker = options.invoker;
    this.messages = options.messages;
    this.emitter = options.emitter;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async runTurn(input: TurnInput): Promise<ChatMessage> {
    const sessionId = input.session.id;
    const turnId = randomUUID();
    const emit = (event: import('@rp/shared').ChatEvent): void => this.emitter.emit('chat', event);

    emit({ type: 'turn-started', sessionId, turnId });
    const message = await this.messages.add({ sessionId, role: 'assistant', content: '', origin: input.origin ?? 'llm', actions: [] });
    const actions: ActionRecord[] = message.actions ?? (message.actions = []);
    const usage = { inputTokens: 0, outputTokens: 0 };
    const conversation: LlmMessage[] = [...input.messages];

    const callProvider = async (withTools: boolean, round: number): Promise<LlmChatResponse> => {
      const request: LlmChatRequest = { model: input.model, system: input.system, messages: conversation };
      if (input.systemStablePrefixChars) request.systemStablePrefixChars = input.systemStablePrefixChars;
      if (withTools) request.tools = [RUN_ACTION_TOOL];
      if (input.temperature !== undefined) request.temperature = input.temperature;
      if (input.maxTokens !== undefined) request.maxTokens = input.maxTokens;
      if (input.signal) request.signal = input.signal;

      const before = message.content;
      let streamed = '';
      const chat = (): Promise<LlmChatResponse> =>
        input.provider.chat(request, {
          onTextDelta: (delta) => {
            streamed += delta;
            message.content = joinText(before, streamed);
            emit({ type: 'text-delta', sessionId, messageId: message.id, delta });
          },
        });
      const response = input.captureExchanges
        ? await recordExchange(
            this.emitter,
            this.now,
            { sessionId, kind: 'turn', provider: input.providerLabel ?? input.provider.config.label ?? input.provider.id, turnId, messageId: message.id, round },
            request,
            chat,
          )
        : await chat();
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      return response;
    };

    /** Reconcile the message text with the full response (strip fences, fix non-streamed text). */
    const settleText = (before: string, response: LlmChatResponse, fenced: boolean): string => {
      const raw = textOf(response);
      const clean = fenced ? stripFencedActions(raw) : raw.trim();
      const next = joinText(before, clean);
      if (next !== message.content) {
        message.content = next;
        emit({ type: 'message-updated', sessionId, message });
      }
      return raw;
    };

    try {
      let round = 0;
      let exhausted = false;
      for (;;) {
        this.throwIfAborted(input.signal);
        const before = message.content;
        const response = await callProvider(input.useTools && round < input.maxActionRounds, round);

        const pending: PendingAction[] = [];
        if (input.useTools) {
          for (const part of response.message.content) {
            if (part.type !== 'tool_use' || part.name !== RUN_ACTION_TOOL_NAME) continue;
            const parsed = toolInput(part.input);
            if (parsed) pending.push({ ...parsed, source: 'tool', toolUseId: part.id });
          }
        }
        const rawText = textOf(response);
        const fenced = extractFencedActions(rawText);
        for (const f of fenced) pending.push({ purpose: f.purpose ?? '', code: f.code, source: 'fenced' });
        settleText(before, response, fenced.length > 0);

        if (pending.length === 0) break;
        if (round >= input.maxActionRounds) {
          // The model asked for actions after its last allowed round: refuse them and ask for text.
          this.logger.warn(`[action-loop] action limit (${input.maxActionRounds}) reached in session ${sessionId}`);
          exhausted = true;
          conversation.push(response.message);
          conversation.push({ role: 'user', content: this.refusedResults(pending) });
          round += 1; // the text-only call below is its own round in the exchange log
          break;
        }

        const ran: Array<{ action: ActionRecord; pending: PendingAction }> = [];
        for (const p of pending) {
          this.throwIfAborted(input.signal);
          const action: ActionRecord = {
            id: randomUUID(),
            purpose: p.purpose,
            code: p.code,
            language: 'ts',
            source: p.source,
            startedAt: this.now().toISOString(),
          };
          actions.push(action);
          emit({ type: 'action-started', sessionId, messageId: message.id, action });
          action.result = await this.runAction(input, action, message.id);
          emit({ type: 'action-finished', sessionId, messageId: message.id, action });
          ran.push({ action, pending: p });
        }

        // Feed results back.
        conversation.push(response.message);
        const resultParts: ContentPart[] = [];
        const fencedResults: string[] = [];
        for (const { action, pending: p } of ran) {
          const payload = resultPayload(action.result as CodeRunResult);
          if (p.toolUseId !== undefined) {
            resultParts.push({ type: 'tool_result', toolUseId: p.toolUseId, content: JSON.stringify(payload), isError: !payload.ok });
          } else {
            fencedResults.push(`<action_result>${JSON.stringify(payload)}</action_result>`);
          }
        }
        if (fencedResults.length > 0) resultParts.push({ type: 'text', text: fencedResults.join('\n') });
        conversation.push({ role: 'user', content: resultParts });
        round += 1;

        if (round >= input.maxActionRounds) {
          exhausted = true;
          break;
        }
      }

      if (exhausted) {
        conversation.push({ role: 'user', content: [{ type: 'text', text: ACTION_LIMIT_NOTICE }] });
        const before = message.content;
        const response = await callProvider(false, round);
        settleText(before, response, true);
      }
    } catch (err) {
      const rp = RpError.from(err);
      if (rp.code === 'LLM_ABORTED' || input.signal?.aborted) {
        this.logger.info(`[action-loop] turn aborted in session ${sessionId}`);
      } else {
        this.logger.error(`[action-loop] turn failed in session ${sessionId}`, err);
        message.error = serializeError(rp);
        emit({ type: 'error', sessionId, error: message.error });
      }
    }

    if (actions.length === 0) delete message.actions;
    message.usage = usage;
    await this.messages.persist(message);
    emit({ type: 'message-updated', sessionId, message });
    emit({ type: 'turn-finished', sessionId, turnId });
    return message;
  }

  private async runAction(input: TurnInput, action: ActionRecord, messageId: string): Promise<CodeRunResult> {
    const context: ActionContext = {
      packId: input.actor.packId,
      characterId: input.actor.characterId,
      sessionId: input.session.id,
      packRoot: input.actor.packRoot,
      trigger: { kind: 'llm', actionId: action.id, messageId },
    };
    const started = this.now().getTime();
    try {
      const request: import('@rp/shared').CodeRunRequest = {
        code: action.code,
        language: action.language,
        context,
        surface: input.surface,
        invoker: this.invoker,
      };
      if (input.limits) request.limits = input.limits;
      if (input.signal) request.signal = input.signal;
      return await this.runner.run(request);
    } catch (err) {
      return {
        ok: false,
        error: serializeError(RpError.from(err, 'SANDBOX_RUNTIME')),
        logs: [],
        calls: [],
        durationMs: this.now().getTime() - started,
      };
    }
  }

  private refusedResults(pending: PendingAction[]): ContentPart[] {
    const payload = JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Action limit reached; this action was not run.' } });
    const parts: ContentPart[] = [];
    const fenced: string[] = [];
    for (const p of pending) {
      if (p.toolUseId !== undefined) parts.push({ type: 'tool_result', toolUseId: p.toolUseId, content: payload, isError: true });
      else fenced.push(`<action_result>${payload}</action_result>`);
    }
    if (fenced.length > 0) parts.push({ type: 'text', text: fenced.join('\n') });
    return parts;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new RpError('LLM_ABORTED', 'Turn aborted');
  }
}
