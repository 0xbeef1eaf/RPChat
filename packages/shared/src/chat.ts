import type { ActionRecord } from './action.js';
import type { SerializedError } from './errors.js';
import type { CharacterRef, MessageId, SessionId } from './ids.js';
import type { MemoryEntry } from './memory.js';
import type { MoodState, RoutineStatus } from './senses.js';

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
  /** Origin of assistant text: LLM, a behaviour script (`sdk.chat.say`), a timer, an event or a routine transition. */
  origin?: 'llm' | 'behaviour' | 'timer' | 'event' | 'routine' | 'greeting';
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
  /** One message was deleted from the history. */
  | { type: 'message-removed'; sessionId: SessionId; messageId: MessageId }
  /** Every message of the session was deleted (the session itself stays). */
  | { type: 'messages-cleared'; sessionId: SessionId }
  | { type: 'action-started'; sessionId: SessionId; messageId: MessageId; action: ActionRecord }
  | { type: 'action-finished'; sessionId: SessionId; messageId: MessageId; action: ActionRecord }
  | { type: 'status'; sessionId: SessionId; text: string | null }
  | { type: 'memory-added'; sessionId: SessionId; memory: MemoryEntry }
  | { type: 'mood-changed'; sessionId: SessionId; mood: MoodState }
  | { type: 'routine-changed'; sessionId: SessionId; routine: RoutineStatus }
  | { type: 'event-fired'; sessionId: SessionId; subscriptionId: string; event: string }
  | { type: 'turn-finished'; sessionId: SessionId; turnId: string }
  | { type: 'error'; sessionId: SessionId; error: SerializedError };

/**
 * What happens when a timer fires:
 * - `wake`: run the `onTimer` behaviour if the character has one, else wake the LLM with `payload`.
 * - `code`: execute `code` (a stored action body) in the sandbox with `input` available; no LLM call unless the code asks for one.
 * - `prompt`: wake the LLM with `prompt` as a self-authored system message (from `sdk.llm.wake`).
 */
export type TimerKind = 'wake' | 'code' | 'prompt';

export interface ScheduledTimer {
  id: string;
  sessionId: SessionId;
  characterRef: CharacterRef;
  kind: TimerKind;
  fireAt: string;
  payload: unknown;
  createdAt: string;
  /** Optional human label supplied by the character. */
  label?: string;
  /** `code` timers: TypeScript action body to run. */
  code?: string;
  /** `code` timers: value exposed to the code as `input`. */
  input?: unknown;
  /** `prompt` timers: the self-authored prompt. */
  prompt?: string;
  /** Repeat after firing. `remaining` counts down; undefined = unlimited. */
  repeat?: { everyMs: number; remaining?: number };
  /** How many times it has fired so far. */
  runs?: number;
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
