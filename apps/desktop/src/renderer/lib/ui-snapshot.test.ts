import { describe, expect, it } from 'vitest';
import type { Session, UiSnapshot } from '@rp/shared';
import { initialState } from '../store/state';
import type { AppState } from '../store/state';
import { applyUiSnapshot, uiSnapshotOf } from './ui-snapshot';

function loaded(): AppState {
  const s = initialState();
  return {
    ...s,
    sessions: [{ id: 's1' }, { id: 's2' }] as unknown as Session[],
    characters: [{ ref: 'p/c' }] as unknown as AppState['characters'],
  };
}

const SNAPSHOT: UiSnapshot = {
  route: 'editor',
  activeSessionId: 's2',
  settingsTab: 'updates',
  editor: { projectKey: 'k', section: 'scripts', characterDir: 'characters/c' },
  memoriesPanel: { characterRef: 'p/c', sessionId: 's2' },
  drafts: { s1: 'hello', gone: 'lost' },
};

describe('UI snapshots', () => {
  it('put the UI back where it was', () => {
    const s = applyUiSnapshot(loaded(), SNAPSHOT);
    expect(s.route).toBe('editor');
    expect(s.activeSessionId).toBe('s2');
    expect(s.settingsTab).toBe('updates');
    expect(s.settingsTabShown).toBe('updates');
    expect(s.editor).toEqual({ projectKey: 'k', section: 'scripts', characterDir: 'characters/c', visited: true });
    expect(s.memoriesPanel).toEqual({ characterRef: 'p/c', sessionId: 's2' });
    expect(s.drafts).toEqual({ s1: 'hello' });
    expect(uiSnapshotOf(s)).toEqual({ ...SNAPSHOT, drafts: { s1: 'hello' } });
  });

  it('leave out what is gone, unknown or withheld by the policy', () => {
    const state = loaded();
    state.restrictions = { ...state.restrictions, allowPackEditor: false };
    const s = applyUiSnapshot(state, { ...SNAPSHOT, activeSessionId: 'deleted', settingsTab: 'nonsense', editor: { ...SNAPSHOT.editor, section: 'nonsense' }, memoriesPanel: { characterRef: 'x/y' } });
    expect(s.route).toBe('chat');
    expect(s.activeSessionId).toBeNull();
    expect(s.settingsTab).toBeNull();
    expect(s.editor.section).toBe('pack');
    expect(s.editor.visited).toBe(false);
    expect(s.memoriesPanel).toBeNull();
    expect(applyUiSnapshot(loaded(), { ...SNAPSHOT, route: 'nowhere' }).route).toBe('chat');
  });
});
