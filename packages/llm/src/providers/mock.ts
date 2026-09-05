import { RpError } from '@rp/shared';
import type {
  ContentPart,
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmStreamHandlers,
  ModelInfo,
  ProviderConfig,
  ProviderId,
  ProviderKind,
  StopReason,
} from '@rp/shared';
import { estimateMessageTokens, estimateTokens } from '../tokens.js';

export interface MockToolCall {
  name: string;
  input: unknown;
  /** Optional fixed tool-use id; generated (`mock_tool_N`) when omitted. */
  id?: string;
}

export interface MockTurn {
  text?: string;
  toolCalls?: MockToolCall[];
  stopReason?: StopReason;
  /** Simulated latency before streaming starts (abortable via `signal`). */
  delayMs?: number;
}

export interface MockProviderOptions {
  /** Turns consumed in order, one per `chat()` call. */
  script?: MockTurn[];
  /** Function form: compute the turn from the request. Takes precedence over `script`. */
  respond?: (request: LlmChatRequest) => MockTurn;
  /** Number of chunks the text is streamed in. Default 3. */
  chunks?: number;
}

const DEFAULT_TURN: MockTurn = { text: 'Mock response.' };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new RpError('LLM_ABORTED', 'LLM request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Split text into `n` roughly equal, non-empty chunks. */
export function chunkText(text: string, n: number): string[] {
  if (text.length === 0) return [];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Scripted provider for tests: streams the next turn through the handlers and records requests. */
export class MockProvider implements LlmProvider {
  readonly kind: ProviderKind = 'mock';
  readonly id: ProviderId;
  readonly config: ProviderConfig;
  /** Every request received, in order. */
  readonly requests: LlmChatRequest[] = [];
  /** Every response produced, in order. */
  readonly responses: LlmChatResponse[] = [];
  private readonly script: MockTurn[];
  private readonly respond: ((request: LlmChatRequest) => MockTurn) | undefined;
  private readonly chunks: number;
  private cursor = 0;
  private toolCounter = 0;

  constructor(config: ProviderConfig, options: MockProviderOptions = {}) {
    this.config = config;
    this.id = config.id;
    this.script = options.script ?? [];
    this.respond = options.respond;
    this.chunks = options.chunks ?? 3;
  }

  /** Turns not yet consumed from the script. */
  get remainingTurns(): number {
    return Math.max(0, this.script.length - this.cursor);
  }

  private nextTurn(request: LlmChatRequest): MockTurn {
    if (this.respond) return this.respond(request);
    if (this.script.length === 0) return DEFAULT_TURN;
    const turn = this.script[this.cursor];
    if (!turn) throw new RpError('LLM_PROVIDER', `MockProvider: script exhausted after ${this.script.length} turn(s)`);
    this.cursor += 1;
    return turn;
  }

  async chat(request: LlmChatRequest, handlers: LlmStreamHandlers = {}): Promise<LlmChatResponse> {
    this.requests.push(request);
    if (request.signal?.aborted) throw new RpError('LLM_ABORTED', 'LLM request aborted');
    const turn = this.nextTurn(request);
    if (turn.delayMs && turn.delayMs > 0) await sleep(turn.delayMs, request.signal);

    const content: ContentPart[] = [];
    if (turn.text) {
      for (const piece of chunkText(turn.text, this.chunks)) {
        if (request.signal?.aborted) throw new RpError('LLM_ABORTED', 'LLM request aborted');
        handlers.onTextDelta?.(piece);
        await Promise.resolve();
      }
      content.push({ type: 'text', text: turn.text });
    }
    for (const call of turn.toolCalls ?? []) {
      const id = call.id ?? `mock_tool_${++this.toolCounter}`;
      handlers.onToolUseStart?.(id, call.name);
      await Promise.resolve();
      handlers.onToolUse?.(id, call.name, call.input);
      content.push({ type: 'tool_use', id, name: call.name, input: call.input });
    }

    const message: LlmChatResponse['message'] = { role: 'assistant', content };
    const response: LlmChatResponse = {
      message,
      stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end'),
      usage: {
        inputTokens: estimateTokens(request.system) + request.messages.reduce((n, m) => n + estimateMessageTokens(m), 0),
        outputTokens: estimateMessageTokens(message),
      },
      model: request.model,
    };
    this.responses.push(response);
    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.config.model, label: `${this.config.model} (mock)` }];
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'mock provider' };
  }
}
