/**
 * Pure state transitions. Nothing here touches `window`, the API or React so
 * everything can be unit tested in plain Node.
 */
import type {
  ActionRecord,
  ChatEvent,
  ChatMessage,
  PermissionRequest,
  Session,
  SessionId,
  UiPromptRequest,
} from '@rp/shared';
import { EMPTY_RUNTIME, type AppState, type MemoriesPanelTarget, type SessionRuntime, type Toast } from './state';

const MAX_TOASTS = 4;
const MAX_EVENT_MARKERS = 30;

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function patchMessage(
  state: AppState,
  sessionId: SessionId,
  messageId: string,
  patch: (m: ChatMessage) => ChatMessage,
): AppState {
  const list = state.messages[sessionId];
  if (!list) return state;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return state;
  const next = list.slice();
  next[idx] = patch(list[idx]!);
  return { ...state, messages: { ...state.messages, [sessionId]: next } };
}

function patchRuntime(state: AppState, sessionId: SessionId, patch: Partial<SessionRuntime>): AppState {
  const current = state.runtime[sessionId] ?? EMPTY_RUNTIME;
  return { ...state, runtime: { ...state.runtime, [sessionId]: { ...current, ...patch } } };
}

function upsertAction(actions: ActionRecord[] | undefined, action: ActionRecord): ActionRecord[] {
  return upsertById(actions ?? [], action);
}

/**
 * Apply one streaming chat event. Events for sessions whose messages have not
 * been loaded are ignored (the full list is fetched when the session opens);
 * runtime state (turn/status/error) is tracked for every session.
 */
export function applyChatEvent(state: AppState, event: ChatEvent): AppState {
  switch (event.type) {
    case 'turn-started':
      return patchRuntime(state, event.sessionId, { turnId: event.turnId, error: null });
    case 'turn-finished': {
      const rt = state.runtime[event.sessionId];
      if (!rt || rt.turnId !== event.turnId) return patchRuntime(state, event.sessionId, { turnId: null });
      return patchRuntime(state, event.sessionId, { turnId: null });
    }
    case 'status':
      return patchRuntime(state, event.sessionId, { status: event.text });
    case 'error':
      return patchRuntime(state, event.sessionId, { error: event.error, turnId: null });
    case 'message-added': {
      const list = state.messages[event.sessionId];
      if (!list) return state;
      return { ...state, messages: { ...state.messages, [event.sessionId]: upsertById(list, event.message) } };
    }
    case 'message-updated': {
      const list = state.messages[event.sessionId];
      if (!list) return state;
      return { ...state, messages: { ...state.messages, [event.sessionId]: upsertById(list, event.message) } };
    }
    case 'text-delta':
      return patchMessage(state, event.sessionId, event.messageId, (m) => ({ ...m, content: m.content + event.delta }));
    case 'message-removed': {
      const list = state.messages[event.sessionId];
      if (!list) return state;
      return { ...state, messages: { ...state.messages, [event.sessionId]: list.filter((m) => m.id !== event.messageId) } };
    }
    case 'messages-cleared': {
      const runtime = state.runtime[event.sessionId];
      const next = { ...state, messages: { ...state.messages, [event.sessionId]: [] } };
      return runtime ? patchRuntime(next, event.sessionId, { turnId: null, error: null, eventMarkers: [] }) : next;
    }
    case 'memory-added':
      return { ...state, memoryVersion: state.memoryVersion + 1 };
    case 'mood-changed':
    case 'routine-changed': {
      const session = state.sessions.find((s) => s.id === event.sessionId);
      if (!session) return state;
      const ref = session.characterRef;
      return { ...state, characterStatusVersion: { ...state.characterStatusVersion, [ref]: (state.characterStatusVersion[ref] ?? 0) + 1 } };
    }
    case 'event-fired': {
      const rt = state.runtime[event.sessionId] ?? EMPTY_RUNTIME;
      const marker = { id: `${event.subscriptionId}:${rt.eventsVersion + 1}`, at: new Date().toISOString(), event: event.event, subscriptionId: event.subscriptionId };
      const eventMarkers = [...rt.eventMarkers, marker].slice(-MAX_EVENT_MARKERS);
      return patchRuntime(state, event.sessionId, { eventMarkers, eventsVersion: rt.eventsVersion + 1 });
    }
    case 'action-started':
    case 'action-finished':
      return patchMessage(state, event.sessionId, event.messageId, (m) => ({
        ...m,
        actions: upsertAction(m.actions, event.action),
      }));
    default:
      return state;
  }
}

export function setMessages(state: AppState, sessionId: SessionId, messages: ChatMessage[]): AppState {
  return { ...state, messages: { ...state.messages, [sessionId]: messages } };
}

export function sortSessions(sessions: Session[]): Session[] {
  return sessions.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export function setSessions(state: AppState, sessions: Session[]): AppState {
  const sorted = sortSessions(sessions);
  const activeStillExists = state.activeSessionId != null && sorted.some((s) => s.id === state.activeSessionId);
  return { ...state, sessions: sorted, activeSessionId: activeStillExists ? state.activeSessionId : null };
}

export function upsertSession(state: AppState, session: Session): AppState {
  return { ...state, sessions: sortSessions(upsertById(state.sessions, session)) };
}

export function removeSession(state: AppState, sessionId: SessionId): AppState {
  const { [sessionId]: _dropped, ...messages } = state.messages;
  const { [sessionId]: _rt, ...runtime } = state.runtime;
  return {
    ...state,
    sessions: state.sessions.filter((s) => s.id !== sessionId),
    messages,
    runtime,
    activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
  };
}

export function enqueuePermissionRequest(state: AppState, request: PermissionRequest): AppState {
  if (state.permissionRequests.some((r) => r.requestId === request.requestId)) return state;
  return { ...state, permissionRequests: [...state.permissionRequests, request] };
}

export function dequeuePermissionRequest(state: AppState, requestId: string): AppState {
  return { ...state, permissionRequests: state.permissionRequests.filter((r) => r.requestId !== requestId) };
}

export function enqueueUiPrompt(state: AppState, request: UiPromptRequest): AppState {
  if (state.uiPrompts.some((r) => r.promptId === request.promptId)) return state;
  return { ...state, uiPrompts: [...state.uiPrompts, request] };
}

export function dequeueUiPrompt(state: AppState, promptId: string): AppState {
  return { ...state, uiPrompts: state.uiPrompts.filter((r) => r.promptId !== promptId) };
}

export function pushToast(state: AppState, toast: Toast): AppState {
  const toasts = [...state.toasts, toast];
  return { ...state, toasts: toasts.slice(Math.max(0, toasts.length - MAX_TOASTS)) };
}

export function removeToast(state: AppState, id: string): AppState {
  return { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
}

export function openMemoriesPanel(state: AppState, target: MemoriesPanelTarget): AppState {
  return { ...state, memoriesPanel: target };
}

export function closeMemoriesPanel(state: AppState): AppState {
  return state.memoriesPanel ? { ...state, memoriesPanel: null } : state;
}
