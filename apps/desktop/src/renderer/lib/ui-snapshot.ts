/**
 * Where the main window's UI was, carried across a quit or an update restart (main keeps it in
 * `session-state.json`, see `IpcApi.app.uiState`). Pure: `uiSnapshotOf` reads it out of the
 * state, `applyUiSnapshot` puts it back — checking each part against what exists now, since a
 * session may have been deleted and the policy may withhold a view since the snapshot was taken.
 */
import type { AppRestrictions, UiSnapshot } from '@rp/shared';
import type { AppState, EditorSection, RouteName, SettingsTab } from '../store/state';

/** Routes the policy can withhold, and the restriction each needs. */
export const ROUTE_NEEDS: Partial<Record<RouteName, keyof AppRestrictions>> = { editor: 'allowPackEditor', sandbox: 'allowSandbox', log: 'allowActionLog' };

const ROUTES: readonly RouteName[] = ['chat', 'packs', 'settings', 'log', 'sdk', 'editor', 'sandbox'];
const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'providers', 'permissions', 'senses', 'integrations', 'commands', 'plugins', 'browser', 'system', 'updates', 'display'];
const EDITOR_SECTIONS: readonly EditorSection[] = ['pack', 'character', 'scripts', 'media', 'readme', 'publish'];

/** Whether `route` may be shown under `restrictions`. */
export function routeAllowed(route: RouteName, restrictions: AppRestrictions): boolean {
  const needs = ROUTE_NEEDS[route];
  return !needs || restrictions[needs];
}

export function uiSnapshotOf(state: AppState): UiSnapshot {
  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(state.drafts)) if (text.length > 0) drafts[id] = text;
  return {
    route: state.route,
    activeSessionId: state.activeSessionId,
    settingsTab: state.settingsTabShown,
    editor: { projectKey: state.editor.projectKey, section: state.editor.section, characterDir: state.editor.characterDir },
    memoriesPanel: state.memoriesPanel ? { characterRef: state.memoriesPanel.characterRef, ...(state.memoriesPanel.sessionId ? { sessionId: state.memoriesPanel.sessionId } : {}) } : null,
    drafts,
  };
}

/**
 * The state with `snapshot` applied, once the sessions, characters and restrictions are loaded.
 * A view the policy withholds, a session or character that is gone, or a value this build does
 * not know is left as the state already had it. The Settings tab is handed over as a request
 * (`settingsTab`), which the Settings view adopts when it mounts.
 */
export function applyUiSnapshot(state: AppState, snapshot: UiSnapshot): AppState {
  const sessionIds = new Set(state.sessions.map((s) => s.id));
  const route = (ROUTES as readonly string[]).includes(snapshot.route) && routeAllowed(snapshot.route as RouteName, state.restrictions) ? (snapshot.route as RouteName) : state.route;
  const activeSessionId = snapshot.activeSessionId && sessionIds.has(snapshot.activeSessionId) ? snapshot.activeSessionId : state.activeSessionId;
  const settingsTab = snapshot.settingsTab && (SETTINGS_TABS as readonly string[]).includes(snapshot.settingsTab) ? (snapshot.settingsTab as SettingsTab) : state.settingsTab;
  const section = (EDITOR_SECTIONS as readonly string[]).includes(snapshot.editor.section) ? (snapshot.editor.section as EditorSection) : state.editor.section;
  const editor = { ...state.editor, projectKey: snapshot.editor.projectKey, section, characterDir: snapshot.editor.characterDir, visited: state.editor.visited || route === 'editor' };
  const panel = snapshot.memoriesPanel;
  const memoriesPanel =
    panel && state.characters.some((c) => c.ref === panel.characterRef)
      ? { characterRef: panel.characterRef, ...(panel.sessionId && sessionIds.has(panel.sessionId) ? { sessionId: panel.sessionId } : {}) }
      : state.memoriesPanel;
  const drafts = { ...state.drafts };
  for (const [id, text] of Object.entries(snapshot.drafts)) if (sessionIds.has(id) && text.length > 0) drafts[id] = text;
  return { ...state, route, activeSessionId, settingsTab, settingsTabShown: settingsTab ?? state.settingsTabShown, editor, memoriesPanel, drafts };
}
