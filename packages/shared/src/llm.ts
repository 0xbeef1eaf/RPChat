import type { SerializedError } from './errors.js';
import type { MessageId, ProviderId, SessionId } from './ids.js';

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'mock';

/** User-configured provider instance (stored in settings). */
export interface ProviderConfig {
  id: ProviderId;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  apiKey?: string;
  /** Default model for this provider. */
  model: string;
  /** Whether the provider/model supports native tool calling. Default true. */
  supportsTools?: boolean;
  /** Whether the model accepts image content parts. Default true for Anthropic, false otherwise. */
  supportsVision?: boolean;
  extraHeaders?: Record<string, string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type ContentPart =
  | { type: 'text'; text: string }
  /** Inline image for vision-capable models (base64 payload, no data: prefix). */
  | { type: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentPart[];
}

export interface LlmChatRequest {
  model: string;
  system: string;
  /**
   * Number of leading characters of `system` that are identical from turn to turn (rules,
   * persona, pack, SDK reference). Providers with prompt caching mark that prefix cacheable;
   * the rest (memory, mood, time) changes every turn and is sent uncached.
   */
  systemStablePrefixChars?: number;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'aborted';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmChatResponse {
  message: LlmMessage;
  stopReason: StopReason;
  usage: LlmUsage;
  model: string;
}

export interface LlmStreamHandlers {
  onTextDelta?(delta: string): void;
  onToolUseStart?(id: string, name: string): void;
  /** Called once with the fully parsed tool input. */
  onToolUse?(id: string, name: string, input: unknown): void;
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  readonly config: ProviderConfig;
  /** Send a chat request; stream via handlers when supported, always resolve with the full response. */
  chat(request: LlmChatRequest, handlers?: LlmStreamHandlers): Promise<LlmChatResponse>;
  /** Optional model enumeration for the settings UI. */
  listModels?(): Promise<ModelInfo[]>;
  /** Cheap connectivity/auth check. */
  test?(): Promise<{ ok: boolean; message?: string }>;
}

/**
 * One provider call made on behalf of a chat session, captured when
 * `settings.debug.showModelTraffic` is on (`model-exchange` chat event). The request is a
 * snapshot taken before the call, so later edits to the running conversation do not alter it.
 */
export interface ModelExchange {
  id: string;
  sessionId: SessionId;
  /** Turn and assistant message the call belongs to (`turn` kind only). */
  turnId?: string;
  messageId?: MessageId;
  /**
   * `turn` = one round of a chat turn (round index from 0), `llm.ask` = `sdk.llm.ask` (and
   * screenshot descriptions), `memory` = memory extraction, `history` = background summarisation
   * of the older messages of a session.
   */
  kind: 'turn' | 'llm.ask' | 'memory' | 'history';
  round?: number;
  startedAt: string;
  durationMs?: number;
  request: {
    /** Provider config label (or id) the call went through. */
    provider: string;
    model: string;
    system: string;
    systemStablePrefixChars?: number;
    messages: LlmMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  };
  /** Present when the provider answered. */
  response?: { message: LlmMessage; stopReason: StopReason; usage: LlmUsage; model: string };
  /** Present when the call threw (aborts included). */
  error?: SerializedError;
}
