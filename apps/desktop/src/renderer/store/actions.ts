/**
 * Side-effecting operations: talk to `window.rp`, then commit results to the
 * store through the pure reducers. Components call these; they never call the
 * API directly except for one-off reads that do not touch shared state.
 */
import type { AppRestrictions, CharacterRef, PackInspection, PermissionDecision, PolicySnapshot, Session, SessionId, UiPromptAnswer } from '@rp/shared';
import { clampChatZoom } from '@rp/shared';
import { api, errorMessage } from '../api';
import { truncate } from '../lib/format';
import { applyTheme } from '../lib/theme';
import { newId } from '../lib/ids';
import {
  applyChatEvent,
  clearExchanges,
  clearUnread,
  closeMemoriesPanel,
  openMemoriesPanel,
  dequeuePermissionRequest,
  dequeueUiPrompt,
  enqueuePermissionRequest,
  enqueueUiPrompt,
  pushToast,
  removeSession as removeSessionReducer,
  removeToast,
  setMessages,
  setSessions,
  upsertSession,
} from './reducers';
import type { AppState, MemoriesPanelTarget, RouteName, SettingsTab, Toast } from './state';
import { appStore, update } from './store';

export function toast(kind: Toast['kind'], text: string, ttlMs = kind === 'error' ? 8000 : 3500): void {
  const id = newId('toast');
  update((s) => pushToast(s, { id, kind, text }));
  window.setTimeout(() => update((s) => removeToast(s, id)), ttlMs);
}

export function dismissToast(id: string): void {
  update((s) => removeToast(s, id));
}

export function reportError(context: string, err: unknown): void {
  const msg = errorMessage(err);
  console.error(context, err);
  toast('error', `${context}: ${msg}`);
}

/** Routes the policy can withhold, and the restriction each needs. */
const ROUTE_NEEDS: Partial<Record<RouteName, keyof AppRestrictions>> = { editor: 'allowPackEditor', sandbox: 'allowSandbox' };

export function navigate(route: RouteName): void {
  update((s) => {
    if (s.route === route) return s;
    // The nav hides these, but a stale deep link or a keyboard shortcut must not reach them either.
    const needs = ROUTE_NEEDS[route];
    if (needs && !s.restrictions[needs]) return s;
    const editor = route === 'editor' && !s.editor.visited ? { ...s.editor, visited: true } : s.editor;
    const next = { ...s, route, editor };
    // Coming back to the chat is reading it.
    return route === 'chat' && next.activeSessionId ? clearUnread(next, next.activeSessionId) : next;
  });
}

/** Open the Settings view on one tab (e.g. `openSettings('permissions')` from a pack card). */
export function openSettings(tab: SettingsTab): void {
  update((s) => ({ ...s, settingsTab: tab }));
  navigate('settings');
}

export function setEditorLocation(patch: Partial<Omit<AppState['editor'], 'visited'>>): void {
  update((s) => ({ ...s, editor: { ...s.editor, ...patch } }));
}

export async function refreshSettings(): Promise<void> {
  const rp = api();
  const [settings, managed] = await Promise.all([
    rp.settings.get(),
    rp.settings.managed().catch((err: unknown) => {
      console.warn('settings.managed failed', err);
      return [] as string[];
    }),
  ]);
  update((s) => ({ ...s, settings, managed }));
  applyTheme(settings.theme);
}

/** What the system policy forbids; permissive defaults when the call fails (main still enforces). */
export async function refreshRestrictions(): Promise<void> {
  const restrictions = await api()
    .app.restrictions()
    .catch((err: unknown) => {
      console.warn('app.restrictions failed', err);
      return null;
    });
  if (restrictions) update((s) => ({ ...s, restrictions }));
}

/**
 * A policy that changed while the app was running (`app.onPolicyChange`): adopt what it now
 * forbids, leave a view it withdrew, and re-read the settings — main resolves the forced values
 * into them, so the managed fields and their values arrive together.
 */
export function applyPolicySnapshot(snapshot: PolicySnapshot): void {
  const before = appStore.getState().restrictions;
  update((s) => {
    const needs = ROUTE_NEEDS[s.route];
    // The view the policy just withheld is open: step back to the chat rather than sit on a
    // screen whose every action main would now refuse.
    const route: RouteName = needs && !snapshot.restrictions[needs] ? 'chat' : s.route;
    return { ...s, restrictions: snapshot.restrictions, managed: snapshot.managed, route };
  });
  const changed = (Object.keys(snapshot.restrictions) as Array<keyof AppRestrictions>).some((k) => snapshot.restrictions[k] !== before[k]);
  if (changed) toast('info', `The system policy changed${snapshot.managedBy ? ` (managed by ${snapshot.managedBy})` : ''}: what this app allows was updated.`, 6000);
  void refreshSettings().catch((err: unknown) => console.warn('settings refresh after a policy change failed', err));
  void enterRequiredSession().catch((err: unknown) => console.warn('entering the required session after a policy change failed', err));
}

export async function refreshCapabilities(): Promise<void> {
  const capabilities = await api().capabilities.list();
  update((s) => ({ ...s, capabilities }));
}

export async function refreshPacks(): Promise<void> {
  const packs = await api().packs.list();
  update((s) => ({ ...s, packs }));
}

export async function refreshCharacters(): Promise<void> {
  const characters = await api().characters.list();
  update((s) => ({ ...s, characters }));
}

export async function refreshSessions(): Promise<void> {
  const sessions = await api().sessions.list();
  update((s) => setSessions(s, sessions));
}

let sessionsRefreshTimer: number | null = null;
function scheduleSessionsRefresh(): void {
  if (sessionsRefreshTimer !== null) return;
  sessionsRefreshTimer = window.setTimeout(() => {
    sessionsRefreshTimer = null;
    refreshSessions().catch((err) => console.error('sessions refresh failed', err));
  }, 250);
}

/**
 * Tell main which conversation is on screen, whenever that changes. Main decides from it whether
 * a character speaking on its own initiative deserves a desktop notification: being in the app
 * with Settings open is not the same as watching that chat.
 */
function watchVisibleSession(): void {
  let reported: string | null | undefined;
  const push = (): void => {
    const state = appStore.getState();
    const visible = state.route === 'chat' ? state.activeSessionId : null;
    if (visible === reported) return;
    reported = visible;
    void api().app.setVisibleSession(visible).catch((err: unknown) => console.warn('app.setVisibleSession failed', err));
  };
  appStore.subscribe(push);
  push();
}

/** Load everything the shell needs and wire the push channels. Idempotent per page load. */
let booted = false;
export async function bootstrap(): Promise<void> {
  if (booted) return;
  booted = true;

  const rp = api();
  rp.chat.onEvent((event) => {
    update((s) => applyChatEvent(s, event));
    if (event.type === 'turn-finished' || event.type === 'message-added' || event.type === 'error' || event.type === 'message-removed' || event.type === 'messages-cleared') {
      scheduleSessionsRefresh();
    }
    if (event.type === 'memory-added' && event.sessionId === appStore.getState().activeSessionId) {
      toast('info', `remembered: ${truncate(event.memory.text, 90)}`, 4500);
    }
  });
  // A notification about a character's unprompted message opens that conversation.
  rp.app.onShowSession((sessionId) => void openSession(sessionId));
  // A policy written, replaced or removed while the app runs, so its restrictions do not wait for a restart.
  rp.app.onPolicyChange((snapshot) => applyPolicySnapshot(snapshot));
  watchVisibleSession();
  rp.permissions.onRequest((request) => update((s) => enqueuePermissionRequest(s, request)));
  rp.ui.onPrompt((request) => update((s) => enqueueUiPrompt(s, request)));

  try {
    const [version] = await Promise.all([rp.app.version(), refreshSettings(), refreshPacks(), refreshCharacters(), refreshSessions(), refreshCapabilities(), refreshRestrictions()]);
    update((s) => ({ ...s, appVersion: version, booting: false, bootError: null }));
    await enterRequiredSession();
  } catch (err) {
    update((s) => ({ ...s, booting: false, bootError: errorMessage(err) }));
  }
}

/**
 * `requireCharacterSession`: keep the app inside a conversation. Opens the most recent session,
 * or starts one with the first installed character when there is none, and pins the view to the
 * chat. A no-op unless the policy asks for it, or when no character is installed to talk to.
 */
export async function enterRequiredSession(): Promise<void> {
  const s = appStore.getState();
  if (!s.restrictions.requireCharacterSession) return;
  if (s.route !== 'chat') update((x) => ({ ...x, route: 'chat' }));
  if (s.activeSessionId && s.sessions.some((x) => x.id === s.activeSessionId)) return;
  const newest = [...s.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (newest) {
    await openSession(newest.id);
    return;
  }
  const first = s.characters[0];
  if (first) await createSession(first.ref);
}

export async function openSession(sessionId: SessionId): Promise<void> {
  update((s) => clearUnread({ ...s, activeSessionId: sessionId, route: 'chat' }, sessionId));
  if (appStore.getState().messages[sessionId]) return;
  try {
    const messages = await api().sessions.messages(sessionId);
    update((s) => setMessages(s, sessionId, messages));
  } catch (err) {
    reportError('Could not load messages', err);
  }
}

/** Re-fetch a session's transcript (used after a turn ended in error to resync). */
export async function reloadMessages(sessionId: SessionId): Promise<void> {
  const messages = await api().sessions.messages(sessionId);
  update((s) => setMessages(s, sessionId, messages));
}

/** Opens the character's chat; the engine keeps one session per character, so this creates it only the first time. */
export async function createSession(characterRef: CharacterRef): Promise<Session | null> {
  try {
    const session = await api().sessions.create({ characterRef });
    update((s) => upsertSession(s, session));
    await openSession(session.id);
    return session;
  } catch (err) {
    reportError('Could not start a chat', err);
    return null;
  }
}

export async function saveSession(session: Session): Promise<boolean> {
  try {
    const saved = await api().sessions.update(session);
    update((s) => upsertSession(s, saved));
    return true;
  } catch (err) {
    reportError('Could not save session', err);
    return false;
  }
}

export async function deleteSession(sessionId: SessionId): Promise<void> {
  try {
    await api().sessions.remove(sessionId);
    update((s) => removeSessionReducer(s, sessionId));
  } catch (err) {
    reportError('Could not delete session', err);
  }
}

export async function deleteMessage(sessionId: SessionId, messageId: string): Promise<void> {
  try {
    await api().sessions.removeMessage(sessionId, messageId);
  } catch (err) {
    reportError('Could not delete message', err);
  }
}

export async function resetSessionState(sessionId: SessionId): Promise<void> {
  try {
    await api().sessions.resetState(sessionId);
    toast('success', 'Session state reset');
  } catch (err) {
    reportError('Could not reset session state', err);
  }
}

export async function clearHistory(sessionId: SessionId): Promise<void> {
  try {
    await api().sessions.clearMessages(sessionId);
    toast('success', 'History cleared');
  } catch (err) {
    reportError('Could not clear history', err);
  }
}

export async function sendMessage(sessionId: SessionId, text: string): Promise<void> {
  try {
    await api().chat.send(sessionId, text);
  } catch (err) {
    reportError('Send failed', err);
  }
}

/** Throw away the character's last reply and ask for another one from the same history. */
export async function retryTurn(sessionId: SessionId): Promise<void> {
  try {
    await api().chat.retry(sessionId);
  } catch (err) {
    reportError('Retry failed', err);
  }
}

export async function abortTurn(sessionId: SessionId): Promise<void> {
  try {
    await api().chat.abort(sessionId);
  } catch (err) {
    reportError('Abort failed', err);
  }
}

/**
 * Change the chat text scale and remember it. The store is updated first so the transcript
 * resizes on the keypress rather than a settings round-trip later; a write that fails puts the
 * old scale back, so what is on screen is always what is stored.
 */
export async function setChatZoom(zoom: number): Promise<void> {
  const chatZoom = clampChatZoom(zoom);
  const before = appStore.getState().settings;
  if (!before || before.chatZoom === chatZoom) return;
  update((s) => (s.settings ? { ...s, settings: { ...s.settings, chatZoom } } : s));
  try {
    const next = await api().settings.update({ chatZoom });
    update((s) => ({ ...s, settings: next }));
  } catch (err) {
    update((s) => (s.settings ? { ...s, settings: { ...s.settings, chatZoom: before.chatZoom } } : s));
    reportError('Could not save the chat text size', err);
  }
}

export async function respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
  update((s) => dequeuePermissionRequest(s, requestId));
  try {
    await api().permissions.respond(requestId, decision);
  } catch (err) {
    reportError('Could not send permission decision', err);
  }
}

export async function respondUiPrompt(promptId: string, answer: UiPromptAnswer): Promise<void> {
  update((s) => dequeueUiPrompt(s, promptId));
  try {
    await api().ui.respondPrompt(promptId, answer);
  } catch (err) {
    reportError('Could not answer prompt', err);
  }
}

/** Step 1 of installing: pick a source and read it without installing. */
export async function pickAndInspectPack(kind: 'file' | 'directory'): Promise<{ sourcePath: string; inspection: PackInspection } | null> {
  try {
    const sourcePath = await api().packs.pickInstallSource(kind);
    if (!sourcePath) return null;
    const inspection = await api().packs.inspect(sourcePath);
    return { sourcePath, inspection };
  } catch (err) {
    reportError('Could not read pack', err);
    return null;
  }
}

/** Step 2: install a previously inspected source. */
export async function installPackFromPath(sourcePath: string): Promise<boolean> {
  try {
    const pack = await api().packs.install(sourcePath);
    await Promise.all([refreshPacks(), refreshCharacters()]);
    toast('success', `Installed ${pack.manifest.name} ${pack.manifest.version}`);
    return true;
  } catch (err) {
    reportError('Install failed', err);
    return false;
  }
}

export async function uninstallPack(packId: string): Promise<void> {
  try {
    await api().packs.uninstall(packId);
    await Promise.all([refreshPacks(), refreshCharacters(), refreshSessions()]);
    toast('info', 'Pack removed');
  } catch (err) {
    reportError('Uninstall failed', err);
  }
}

export async function closeAllMedia(): Promise<void> {
  try {
    await api().media.closeAll();
  } catch (err) {
    reportError('Could not close media', err);
  }
}

export function openMemories(target: MemoriesPanelTarget): void {
  update((s) => openMemoriesPanel(s, target));
}

export function closeMemories(): void {
  update((s) => closeMemoriesPanel(s));
}

/** Forget the captured model traffic of a session (Model traffic drawer → Clear). */
export function clearModelTraffic(sessionId: SessionId): void {
  update((s) => clearExchanges(s, sessionId));
}
