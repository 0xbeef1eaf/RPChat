import { randomUUID } from 'node:crypto';
import { RUN_ACTION_TOOL, extractFencedActions, stripCodeComments, stripFencedActions } from '@rp/llm';
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
  RpErrorCode,
  RunLimits,
  SdkSurface,
  SerializedError,
  Session,
} from '@rp/shared';
import { RUN_ACTION_TOOL_NAME, RpError, capOf, serializeError } from '@rp/shared';
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
  /**
   * Extra action rounds a failure may buy, on top of `maxActionRounds`, when the round that hit
   * the limit failed in a way a rewrite could fix (`isRepairable`). Without them the last thing
   * the model hears about a broken action can be "reply with text only", and the user gets an
   * apology where a working action was one fix away. `-1` (`UNLIMITED`) keeps granting them for as
   * long as the model keeps failing repairably; default 0 — the round limit is the whole budget.
   */
  maxActionRepairs?: number;
  temperature?: number;
  maxTokens?: number;
  /** Who is acting (trigger is filled in per action). */
  actor: Pick<ActionContext, 'packId' | 'characterId' | 'packRoot'>;
  surface: SdkSurface;
  /** The character's function library prelude (`CodeRunRequest.prelude`), prepended to every action of the turn. */
  prelude?: string;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  origin?: 'llm' | 'timer';
  /** Emit a `model-exchange` event per provider call (`settings.debug.showModelTraffic`). Default false. */
  captureExchanges?: boolean;
  /** Provider config label/id written into the exchange records. */
  providerLabel?: string;
}

export const ACTION_LIMIT_NOTICE = '[system] action limit reached, reply with text only';
/** Sent with the results of a failed round that bought one more (`TurnInput.maxActionRepairs`). */
export const ACTION_REPAIR_NOTICE =
  '[system] that action failed. You have one more action round: fix the cause the result names (read its `fix`) and run the corrected code — nothing new. If the result says rewriting cannot fix it, reply with text only and tell the user what is wrong, in your own voice.';

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

/**
 * The assistant's message as it goes back into the conversation for the next round: the code of
 * its `run_action` calls loses its comments, the same way `transcriptToMessages` replays it
 * on later turns. The action that ran, and the text the user sees, are untouched.
 */
function withoutCodeComments(message: LlmMessage): LlmMessage {
  if (!message.content.some((p) => p.type === 'tool_use' && p.name === RUN_ACTION_TOOL_NAME)) return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== 'tool_use' || part.name !== RUN_ACTION_TOOL_NAME) return part;
      const parsed = toolInput(part.input);
      if (!parsed) return part;
      return { ...part, input: { ...(part.input as object), purpose: parsed.purpose, code: stripCodeComments(parsed.code) } };
    }),
  };
}

/**
 * Add a line to a round's results. In fenced mode they are already one text part, so the line is
 * folded into it rather than left sitting beside it as a second one.
 */
function appendText(parts: ContentPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === 'text') last.text = `${last.text}\n\n${text}`;
  else parts.push({ type: 'text', text });
}

function toolInput(input: unknown): { purpose: string; code: string } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { purpose, code } = input as { purpose?: unknown; code?: unknown };
  if (typeof code !== 'string' || code.trim().length === 0) return undefined;
  return { purpose: typeof purpose === 'string' ? purpose : '', code };
}

/**
 * What each failure code means for the model's next move: the line of advice that goes back with
 * the error as `fix`, and whether code written differently could get past it at all. `retryable`
 * is what buys a failing round another one (`TurnInput.maxActionRepairs`): a method name typed
 * wrong is one rewrite away from working, a permission the user switched off is not.
 */
const FAILURE_GUIDE: Record<RpErrorCode, { retryable: boolean; hint: string }> = {
  SANDBOX_COMPILE: {
    retryable: true,
    hint: 'Your code did not compile. `line`, `column` and `frame` are action.ts coordinates — the lines you wrote: fix that line and run the corrected code.',
  },
  SANDBOX_RUNTIME: {
    retryable: true,
    hint: 'Your code threw. `line`, `column`, `frame` and `stack` are action.ts coordinates — the lines you wrote: fix the cause there and run the corrected code.',
  },
  SANDBOX_TIMEOUT: {
    retryable: true,
    hint: 'The run used up its time budget. Never sleep, poll or loop waiting inside an action: do the one thing now and leave the rest to sdk.timers.',
  },
  SANDBOX_MEMORY: {
    retryable: true,
    hint: 'The run ran out of memory. Work on less at a time: fewer items per call, no large strings built up in a loop.',
  },
  SANDBOX_CALL_BUDGET: {
    retryable: true,
    hint: 'One action may only make so many sdk calls. Reach the same result with fewer (one findAssets instead of a listAssets per folder), or split it over two actions.',
  },
  CAPABILITY_UNKNOWN: {
    retryable: true,
    hint: 'That method is not part of the sdk you have. Use one <sdk_reference> lists — `await sdk.help.module("<id>")` returns a module\'s full typings — and do not invent names.',
  },
  INVALID_ARGUMENT: {
    retryable: true,
    hint: 'The arguments did not match the method. Check its signature (`await sdk.help.module("<id>")` for the full typings) and call it again with the right shape.',
  },
  NOT_FOUND: {
    retryable: true,
    hint: 'What you named does not exist. Do not guess again: look it up first (sdk.pack.findAssets or sdk.pack.listAssets for media, the module\'s own list/get elsewhere) and use exactly what comes back.',
  },
  PATH_ESCAPE: {
    retryable: true,
    hint: 'The path left the folder this call may touch. Use one inside it, without "..", taken from a listing rather than written by hand.',
  },
  PERMISSION_DENIED: {
    retryable: false,
    hint: 'The user has this switched off, so running it again fails the same way. Tell them plainly what to switch on — the message names the place — and carry on in character.',
  },
  PERMISSION_PROMPT_REJECTED: {
    retryable: false,
    hint: 'The user said no. Accept it in character and do not ask again this turn.',
  },
  CAPABILITY_FAILED: {
    retryable: false,
    hint: 'The call failed on the host side, so rewriting the code will not help. If the message names something missing or unconfigured, say so in your own voice; otherwise carry on without it.',
  },
  LLM_PROVIDER: { retryable: false, hint: 'The model call behind this sdk method failed. Carry on without its answer.' },
  LLM_ABORTED: { retryable: false, hint: 'The turn was stopped. Do not run anything else.' },
  STORAGE: {
    retryable: false,
    hint: 'The app could not read or write its own files, which different code will not fix. Carry on, and do not count on what was being saved.',
  },
  PACK_INVALID: { retryable: false, hint: 'Something in the character pack is not valid. An action cannot fix that; carry on in character.' },
  PACK_CONFLICT: { retryable: false, hint: 'That name is already taken in the character pack. Pick another one, or carry on in character.' },
  INTERNAL: { retryable: false, hint: 'Something inside the app failed. Running the same call again is unlikely to help; carry on in character.' },
};

/**
 * The guide for one failure. An sdk call that failed and was never caught arrives as
 * `SANDBOX_RUNTIME` — it threw, inside the model's own code — carrying the capability's own code
 * under `details.code`; that inner code is the one worth advising on, so it wins.
 */
function guideFor(error: SerializedError): { retryable: boolean; hint: string } {
  const details = error.details;
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const inner = (details as { code?: unknown }).code;
    if (typeof inner === 'string' && inner in FAILURE_GUIDE) return FAILURE_GUIDE[inner as RpErrorCode];
  }
  return FAILURE_GUIDE[error.code] ?? FAILURE_GUIDE.INTERNAL;
}

/** Whether a finished run failed in a way the model could plausibly write its way out of. */
export function isRepairable(result: CodeRunResult | undefined): boolean {
  if (!result) return false;
  if (result.error && guideFor(result.error).retryable) return true;
  return result.calls.some((call) => !call.ok && call.error !== undefined && guideFor(call.error).retryable);
}

/**
 * Calls that failed without ending the run: the code caught them, or never awaited them, so the
 * run reports `ok: true` (or a different error) and the model would otherwise be told everything
 * worked. Each one names the sdk method and carries the same detail a failed run gets. The call
 * that *did* end the run is left out — it is already the run's `error`, with the line it was
 * made on.
 */
function unreportedCallFailures(result: CodeRunResult): Array<Record<string, unknown>> {
  const runMessage = result.ok ? undefined : result.error?.message;
  const out: Array<Record<string, unknown>> = [];
  for (const call of result.calls) {
    if (call.ok || call.error === undefined) continue;
    if (runMessage !== undefined && runMessage.includes(call.error.message)) continue;
    out.push({ call: `sdk.${call.module}.${call.method}`, ...errorForModel(call.error) });
  }
  return out;
}

/**
 * Everything the model is told about a failure, so it can fix the code and try
 * again in the next round: the message, how to correct it (`fix`), where in *its
 * own* source the failure happened, that line quoted with a caret, and the mapped
 * stack (the sandbox maps both back through the source map before they get here).
 */
export function errorForModel(error: SerializedError): Record<string, unknown> {
  const out: Record<string, unknown> = { code: error.code, message: error.message, fix: guideFor(error).hint };
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? { ...(error.details as Record<string, unknown>) } : undefined;
  if (details) {
    // Lifted out of `details` rather than copied: the model reads them, and the
    // frame is the largest thing in the payload — sending it twice is waste.
    for (const key of ['line', 'column', 'frame'] as const) {
      const value = details[key];
      if (typeof value === (key === 'frame' ? 'string' : 'number')) out[key] = value;
      delete details[key];
    }
    if (Object.keys(details).length > 0) out['details'] = details;
  } else if (error.details !== undefined) out['details'] = error.details;
  if (error.stack !== undefined && error.stack.length > 0) out['stack'] = error.stack;
  return out;
}

/** Result payload sent back to the model. */
export function resultPayload(result: CodeRunResult): Record<string, unknown> {
  const payload: Record<string, unknown> = { ok: result.ok, returnValue: result.returnValue ?? null };
  if (result.error) payload.error = errorForModel(result.error);
  const failedCalls = unreportedCallFailures(result);
  if (failedCalls.length > 0) payload.failedCalls = failedCalls;
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
    const message = await this.messages.add({ sessionId, role: 'assistant', content: '', origin: input.origin ?? 'llm', turnId, actions: [] });
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
      /** Rounds the model may still act in; grows as failures buy repair rounds. */
      let budget = input.maxActionRounds;
      let repairs = 0;
      const maxRepairs = capOf(input.maxActionRepairs ?? 0);
      let exhausted = false;
      for (;;) {
        this.throwIfAborted(input.signal);
        const before = message.content;
        const response = await callProvider(input.useTools && round < budget, round);

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
        if (round >= budget) {
          // The model asked for actions after its last allowed round: refuse them and ask for text.
          this.logger.warn(`[action-loop] action limit (${budget}) reached in session ${sessionId}`);
          exhausted = true;
          conversation.push(withoutCodeComments(response.message));
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
          action.result = await this.runAction(input, action, message.id, turnId);
          emit({ type: 'action-finished', sessionId, messageId: message.id, action });
          ran.push({ action, pending: p });
        }

        // Feed results back.
        conversation.push(withoutCodeComments(response.message));
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
        round += 1;

        if (round >= budget) {
          // Out of rounds. A round that ended in a fixable failure buys another one, so the model
          // gets to act on the `fix` it was just handed instead of being told to stop acting.
          if (repairs < maxRepairs && ran.some(({ action }) => isRepairable(action.result))) {
            repairs += 1;
            budget += 1;
            this.logger.info(`[action-loop] granting repair round ${repairs} in session ${sessionId}`);
            appendText(resultParts, ACTION_REPAIR_NOTICE);
          } else {
            exhausted = true;
          }
        }
        conversation.push({ role: 'user', content: resultParts });
        if (exhausted) break;
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

  private async runAction(input: TurnInput, action: ActionRecord, messageId: string, turnId: string): Promise<CodeRunResult> {
    const context: ActionContext = {
      packId: input.actor.packId,
      characterId: input.actor.characterId,
      sessionId: input.session.id,
      packRoot: input.actor.packRoot,
      trigger: { kind: 'llm', actionId: action.id, messageId, turnId },
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
      if (input.prelude !== undefined) request.prelude = input.prelude;
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
