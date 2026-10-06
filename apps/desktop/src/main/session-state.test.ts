import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionState } from './session-state.js';
import { SessionStateFile, parseSessionState, parseUiSnapshot, restoredBounds, startHidden } from './session-state.js';

const UI = { route: 'settings', activeSessionId: 's1', settingsTab: 'updates', editor: { projectKey: null, section: 'pack', characterDir: null }, memoriesPanel: null, drafts: { s1: 'half a thought' } };

describe('parseSessionState', () => {
  it('reads nothing out of nothing', () => {
    expect(parseSessionState(null)).toEqual({ version: 1, savedAt: '', reason: 'quit', media: [], widgets: [] });
    expect(parseSessionState({ window: { bounds: { x: 0, y: 0, width: -5, height: 10 } }, ui: 'x', media: 'x', widgets: {} })).toEqual({ version: 1, savedAt: '', reason: 'quit', media: [], widgets: [] });
  });

  it('keeps every well-formed part and drops the malformed entries', () => {
    const state = parseSessionState({
      savedAt: '2026-10-06T10:00:00Z',
      reason: 'update',
      window: { bounds: { x: 10.4, y: 20, width: 900, height: 700 }, maximized: true, visible: false },
      ui: UI,
      media: [
        { id: 'm1', mode: 'show', kind: 'image', asset: 'media/a.png', packId: 'p', characterId: 'c', sessionId: 's', trigger: { kind: 'timer', timerId: 't' }, options: { x: 1 } },
        { id: 'm2', mode: 'teleport', kind: 'image', asset: 'a', packId: 'p', characterId: 'c', sessionId: 's', trigger: { kind: 'timer', timerId: 't' } },
        { id: 'm3', mode: 'audio', kind: 'audio', asset: 'a', packId: 'p', characterId: 'c', sessionId: 's' },
      ],
      widgets: [{ id: 'w', packId: 'p', characterId: 'c', html: '<p>', width: 1, height: 99999 }, { id: 'w2', packId: 'p', characterId: 'c' }],
    });
    expect(state.reason).toBe('update');
    expect(state.window).toEqual({ bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: true, fullScreen: false, visible: false });
    expect(state.ui).toEqual(UI);
    expect(state.media.map((m) => m.id)).toEqual(['m1']);
    expect(state.widgets).toEqual([{ id: 'w', packId: 'p', characterId: 'c', html: '<p>', width: 64, height: 4096, overlay: {} }]);
  });
});

describe('parseUiSnapshot', () => {
  it('needs a route, and loosens everything else to its shape', () => {
    expect(parseUiSnapshot({})).toBeNull();
    expect(parseUiSnapshot([])).toBeNull();
    expect(parseUiSnapshot({ route: 'chat', activeSessionId: 5, drafts: { a: 'x', b: '', c: 3 }, memoriesPanel: { characterRef: 'p/c', sessionId: 1 } })).toEqual({
      route: 'chat',
      activeSessionId: null,
      settingsTab: null,
      editor: { projectKey: null, section: 'pack', characterDir: null },
      memoriesPanel: { characterRef: 'p/c' },
      drafts: { a: 'x' },
    });
  });
});

describe('restoredBounds', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  it('keeps a window that is still on a screen where it was', () => {
    expect(restoredBounds({ x: 100, y: 50, width: 1000, height: 700 }, screens, { width: 760, height: 520 })).toEqual({ x: 100, y: 50, width: 1000, height: 700 });
  });
  it('lets a window from an unplugged monitor open wherever new windows go, at no less than the minimum size', () => {
    expect(restoredBounds({ x: 2500, y: 50, width: 300, height: 700 }, screens, { width: 760, height: 520 })).toEqual({ width: 760, height: 700 });
  });
});

describe('startHidden', () => {
  const base: SessionState = { version: 1, savedAt: '', reason: 'quit', media: [], widgets: [], window: { bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: false, fullScreen: false, visible: false } };
  it('only carries a hidden window over an update restart; --hidden always wins', () => {
    expect(startHidden(base, false)).toBe(false);
    expect(startHidden({ ...base, reason: 'update' }, false)).toBe(true);
    expect(startHidden({ ...base, reason: 'update', window: { ...base.window!, visible: true } }, false)).toBe(false);
    expect(startHidden(base, true)).toBe(true);
  });
});

describe('SessionStateFile', () => {
  it('round-trips a state, and reads a missing or broken file as empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-session-state-'));
    try {
      const file = new SessionStateFile(path.join(dir, 'data', 'session-state.json'));
      expect((await file.load()).media).toEqual([]);
      const state: SessionState = { version: 1, savedAt: 'now', reason: 'update', ui: UI, media: [], widgets: [{ id: 'w', packId: 'p', characterId: 'c', html: '<p>', width: 100, height: 100, overlay: { position: 'top-left' } }] };
      await Promise.all([file.save({ ...state, reason: 'quit' }), file.save(state)]);
      expect(await file.load()).toEqual(state);
      fs.writeFileSync(path.join(dir, 'data', 'session-state.json'), '{nope');
      expect((await file.load()).widgets).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
