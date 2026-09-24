/**
 * What a character hears when the user puts the chat window away and brings it back: one event
 * per real transition, across the window being destroyed and replaced, and nothing at shutdown.
 */
import { describe, expect, it } from 'vitest';
import type { HostEvent } from '@rp/shared';
import { ChatVisibility } from './chat-visibility.js';

/** Enough of a BrowserWindow to fire `show` / `hide` / `closed` at the tracker. */
class FakeWindow {
  private readonly listeners = new Map<string, Array<() => void>>();
  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: 'show' | 'hide' | 'closed'): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l();
  }
}

function setup(opts: { active?: () => boolean } = {}): { events: HostEvent[]; win: FakeWindow; visibility: ChatVisibility; tick(ms: number): void } {
  const events: HostEvent[] = [];
  let clock = 1_000;
  const visibility = new ChatVisibility({ emit: (e) => events.push(e), now: () => clock, ...(opts.active ? { active: opts.active } : {}) });
  const win = new FakeWindow();
  visibility.watch(win);
  return { events, win, visibility, tick: (ms) => (clock += ms) };
}

describe('chat window visibility events', () => {
  it('raises chat-shown and chat-hidden with how long the window had been away or up', () => {
    const { events, win, tick } = setup();

    win.emit('show');
    // The first one has no duration to report: nothing is known about the time before the app started.
    expect(events).toEqual([{ name: 'chat-shown', data: {}, at: new Date(1_000).toISOString() }]);

    tick(5_000);
    win.emit('hide');
    expect(events[1]).toMatchObject({ name: 'chat-hidden', data: { shownMs: 5_000 } });

    tick(60_000);
    win.emit('show');
    expect(events[2]).toMatchObject({ name: 'chat-shown', data: { hiddenMs: 60_000 } });
  });

  it('ignores show/hide that change nothing — the tray shows a window that is already up', () => {
    const { events, win } = setup();
    win.emit('show');
    win.emit('show');
    win.emit('hide');
    win.emit('hide');
    expect(events.map((e) => e.name)).toEqual(['chat-shown', 'chat-hidden']);
  });

  it('treats a window closed for real as the chat going away, and follows the one that replaces it', () => {
    const { events, win, visibility } = setup();
    win.emit('show');
    // `closeToTray` off: the window is destroyed without a `hide` first.
    win.emit('closed');
    expect(events.map((e) => e.name)).toEqual(['chat-shown', 'chat-hidden']);

    const next = new FakeWindow();
    visibility.watch(next);
    next.emit('show');
    expect(events.map((e) => e.name)).toEqual(['chat-shown', 'chat-hidden', 'chat-shown']);
    // The old window's teardown must not be reported again as the chat going away.
    win.emit('closed');
    expect(events).toHaveLength(3);
  });

  it('says nothing while the app is shutting down, and stays in step with the window', () => {
    let active = true;
    const { events, win, tick } = setup({ active: () => active });
    win.emit('show');
    tick(1_000);

    active = false;
    win.emit('hide');
    expect(events).toHaveLength(1);

    // The state still followed the window, so coming back is one clean `chat-shown`.
    active = true;
    tick(2_000);
    win.emit('show');
    expect(events[1]).toMatchObject({ name: 'chat-shown', data: { hiddenMs: 2_000 } });
  });
});
