import type { ActionRecord } from './action.js';
import type { SerializedError } from './errors.js';
import type { CharacterRef, MessageId, SessionId } from './ids.js';
import type { MemoryEntry } from './memory.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  /** Markdown text shown to the user. For assistant messages this is the full visible text. */
  content: string;
  createdAt: string;
  /** Actions executed as part of producing this assistant message. */
  actions?: ActionRecord[];
  /** Origin of assistant text: LLM, a behaviour script (`sdk.chat.say`) or a timer. */
  origin?: 'llm' | 'behaviour' | 'timer' | 'greeting';
  /** Emotes (`sdk.chat.emote`) are rendered in italics. */
  kind?: 'text' | 'emote';
  /** Provider usage for the turn that produced this message. */
  usage?: { inputTokens: number; outputTokens: number };
  error?: SerializedError;
}

export interface Session {
  id: SessionId;
  characterRef: CharacterRef;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Optional user-written scenario prepended to the prompt. */
  scenario?: string;
  /** Provider/model override for this session. */
  providerId?: string;
  model?: string;
  messageCount: number;
  lastMessagePreview?: string;
}

export interface CreateSessionInput {
  characterRef: CharacterRef;
  title?: string;
  scenario?: string;
  providerId?: string;
  model?: string;
}

/**
 * Streaming events emitted by the engine while a turn is in progress.
 * Delivered to the renderer over IPC and consumed by tests.
 */
export type ChatEvent =
  | { type: 'turn-started'; sessionId: SessionId; turnId: string }
  | { type: 'message-added'; sessionId: SessionId; message: ChatMessage }
  | { type: 'text-delta'; sessionId: SessionId; messageId: MessageId; delta: string }
  | { type: 'message-updated'; sessionId: SessionId; message: ChatMessage }
  | { type: 'action-started'; sessionId: SessionId; messageId: MessageId; action: ActionRecord }
  | { type: 'action-finished'; sessionId: SessionId; messageId: MessageId; action: ActionRecord }
  | { type: 'status'; sessionId: SessionId; text: string | null }
  | { type: 'memory-added'; sessionId: SessionId; memory: MemoryEntry }
  | { type: 'turn-finished'; sessionId: SessionId; turnId: string }
  | { type: 'error'; sessionId: SessionId; error: SerializedError };

export interface ScheduledTimer {
  id: string;
  sessionId: SessionId;
  characterRef: CharacterRef;
  fireAt: string;
  payload: unknown;
  createdAt: string;
  /** Optional human label supplied by the character. */
  label?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  sessionId: SessionId;
  characterRef: CharacterRef;
  module: string;
  method: string;
  args: unknown[];
  outcome: 'allowed' | 'denied' | 'failed';
  error?: SerializedError;
  durationMs?: number;
}
