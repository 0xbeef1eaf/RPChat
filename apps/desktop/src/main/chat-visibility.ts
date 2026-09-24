/**
 * The chat window coming and going, as host events characters can subscribe to: `chat-shown` when
 * the rpchat window becomes visible (startup, the tray, a notification click, a second `rpchat`)
 * and `chat-hidden` when it goes away (hidden to the tray, closed for real with `closeToTray` off).
 *
 * The tracker is app-level rather than per-window: the main window is recreated whenever it is
 * gone (windows.ts `onMainCreated`), and a character should hear one `chat-shown` when the user
 * brings the app back, not one per BrowserWindow. It also holds the last transition's time, so an
 * event says how long the window had been away (`hiddenMs`) or up (`shownMs`).
 */
import type { HostEvent, Json } from '@rp/shared';

/** What this needs of a BrowserWindow — so the tracker is unit-tested without Electron. */
export interface VisibilityWindow {
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown;
}

export interface ChatVisibilityOptions {
  emit(event: HostEvent): void;
  now?(): number;
  /**
   * False once the app is shutting down: the window going away with the app is not the user
   * putting it away, and a character woken by it would be writing into a closing engine.
   */
  active?(): boolean;
}

export class ChatVisibility {
  private visible = false;
  /** When the current state began; undefined until the first transition, which has no duration to report. */
  private since: number | undefined;
  /** The window that speaks for the chat right now: a replaced one's late `closed` is not the chat going away. */
  private current: VisibilityWindow | undefined;

  constructor(private readonly o: ChatVisibilityOptions) {}

  /** Follow one main window; the newest one watched is the chat. Call it for every window the manager creates. */
  watch(win: VisibilityWindow): void {
    this.current = win;
    win.on('show', () => this.from(win, true));
    win.on('hide', () => this.from(win, false));
    // Closing with `closeToTray` off destroys the window without a `hide`; the chat is gone all the same.
    win.on('closed', () => this.from(win, false));
  }

  private from(win: VisibilityWindow, visible: boolean): void {
    if (this.current === win) this.set(visible);
  }

  private set(visible: boolean): void {
    if (visible === this.visible) return; // `show()` on a window that is already up only focuses it
    const at = this.o.now?.() ?? Date.now();
    const forMs = this.since === undefined ? undefined : Math.max(0, at - this.since);
    this.visible = visible;
    this.since = at;
    if (this.o.active?.() === false) return;
    const data: Record<string, Json> = forMs === undefined ? {} : visible ? { hiddenMs: forMs } : { shownMs: forMs };
    this.o.emit({ name: visible ? 'chat-shown' : 'chat-hidden', data, at: new Date(at).toISOString() });
  }
}
