import type {
  AppSettings,
  ChatMessage,
  CharacterSummary,
  InstalledPackView,
  PermissionRequest,
  SerializedError,
  Session,
  SessionId,
  UiPromptRequest,
} from '@rp/shared';

export type RouteName = 'chat' | 'packs' | 'settings' | 'log' | 'sdk';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface EventMarker {
  id: string;
  at: string;
  event: string;
  subscriptionId: string;
}

/** Per-session transient state driven by the `ChatEvent` stream. */
export interface SessionRuntime {
  /** Id of the turn currently in progress, if any. */
  turnId: string | null;
  /** Character status line (`sdk.chat.setStatus`). */
  status: string | null;
  /** Last engine error for this session; cleared when a new turn starts. */
  error: SerializedError | null;
  /** Inline markers for `event-fired`, newest last (capped). */
  eventMarkers: EventMarker[];
  /** Bumped on `event-fired` so an open Events drawer re-fetches subscriptions. */
  eventsVersion: number;
}

export interface MemoriesPanelTarget {
  characterRef: string;
  /** Open session for the character, enabling "Consolidate now". */
  sessionId?: SessionId;
}

export interface AppState {
  route: RouteName;
  appVersion: string;
  /** True until the first data load finished (or failed). */
  booting: boolean;
  bootError: string | null;
  characters: CharacterSummary[];
  packs: InstalledPackView[];
  sessions: Session[];
  activeSessionId: SessionId | null;
  /** Messages per session; a missing key means "not loaded yet". */
  messages: Record<SessionId, ChatMessage[]>;
  runtime: Record<SessionId, SessionRuntime>;
  settings: AppSettings | null;
  /** FIFO queues; the first entry is the one being shown. */
  permissionRequests: PermissionRequest[];
  uiPrompts: UiPromptRequest[];
  toasts: Toast[];
  /** Which character's memories panel is open, if any. */
  memoriesPanel: MemoriesPanelTarget | null;
  /** Bumped on every `memory-added` event so open panels re-fetch. */
  memoryVersion: number;
  /** Per character: bumped on `mood-changed` / `routine-changed` so the chat header re-fetches `characters.status`. */
  characterStatusVersion: Record<string, number>;
}

export const EMPTY_RUNTIME: SessionRuntime = { turnId: null, status: null, error: null, eventMarkers: [], eventsVersion: 0 };

export function initialState(): AppState {
  return {
    route: 'chat',
    appVersion: '',
    booting: true,
    bootError: null,
    characters: [],
    packs: [],
    sessions: [],
    activeSessionId: null,
    messages: {},
    runtime: {},
    settings: null,
    permissionRequests: [],
    uiPrompts: [],
    toasts: [],
    memoriesPanel: null,
    memoryVersion: 0,
    characterStatusVersion: {},
  };
}

export function runtimeFor(state: AppState, sessionId: SessionId | null): SessionRuntime {
  if (!sessionId) return EMPTY_RUNTIME;
  return state.runtime[sessionId] ?? EMPTY_RUNTIME;
}
