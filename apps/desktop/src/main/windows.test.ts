/**
 * A prompt window is keyed by the id its question is answered by, so `permissions.respond` /
 * `ui.respondPrompt` can close the right window. Those two ids come from different fields.
 *
 * And: a main window that is gone — closed with `closeToTray` off, or destroyed with the session
 * at logout while the app stayed up — is replaced by the next thing that asks for one, which must
 * arrive wired exactly like the window opened at startup.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, UiPromptRequest } from '@rp/shared';
import { WindowManager, promptIdOf } from './windows.js';

/** Enough BrowserWindow for the manager: a listener registry the test can fire into, and the loads it ends with. */
vi.mock('electron', () => {
  let nextContentsId = 1;
  class FakeWindow {
    static readonly created: FakeWindow[] = [];
    private readonly listeners = new Map<string, Array<() => void>>();
    readonly webContents = {
      id: nextContentsId++,
      on: () => undefined,
      once: () => undefined,
      isDestroyed: () => false,
      setWindowOpenHandler: () => undefined,
    };
    private destroyed = false;
    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.created.push(this);
    }
    on(event: string, listener: () => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    once(event: string, listener: () => void): void {
      this.on(event, listener);
    }
    /** The compositor taking the window away (logout), or any other close. */
    emit(event: string): void {
      if (event === 'closed') this.destroyed = true;
      for (const l of [...(this.listeners.get(event) ?? [])]) l();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    loadFile(): void {}
    loadURL(): void {}
    show(): void {}
    focus(): void {}
  }
  return { BrowserWindow: FakeWindow, shell: {} };
});

const request: PermissionRequest = {
  requestId: 'req-1',
  call: { callId: 'c1', module: 'system', method: 'exec', args: ['ls'] },
  context: { packId: 'com.x.p', characterId: 'luna', sessionId: 's' },
  description: 'Run a command',
  dangerous: true,
};
const prompt: UiPromptRequest = { promptId: 'prompt-1', sessionId: 's', characterName: 'Luna', kind: 'confirm', question: 'ok?' };

describe('promptIdOf', () => {
  it('is the id the answer comes back with', () => {
    expect(promptIdOf({ kind: 'permission', request, characterName: 'Luna', packName: 'Luna pack' })).toBe('req-1');
    expect(promptIdOf({ kind: 'ui', prompt })).toBe('prompt-1');
  });
});

interface FakeMainWindow {
  emit(event: string): void;
}

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('main window creation', () => {
  it('reports every window it creates, so a reopened one is wired like the first', () => {
    const created: FakeMainWindow[] = [];
    const windows = new WindowManager({ outDir: '/nowhere/out', logger, onMainCreated: (win) => created.push(win as unknown as FakeMainWindow) });

    const first = windows.createMainWindow() as unknown as FakeMainWindow;
    expect(created).toHaveLength(1);

    // Asking again while it is up hands back the same window: its handlers are still on it.
    windows.createMainWindow();
    expect(created).toHaveLength(1);

    first.emit('closed');
    expect(windows.getMainWindow()).toBeUndefined();

    const second = windows.createMainWindow() as unknown as FakeMainWindow;
    expect(created).toEqual([first, second]);
  });
});
