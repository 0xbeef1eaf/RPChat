/**
 * The app's own idle timer: how long it has been since the user last did something **in rpchat**,
 * as opposed to somewhere on the machine (which is what `wayland-idle.ts` / `powerMonitor` answer).
 *
 * The two are independent on purpose. Someone can be typing in their editor for an hour — at the
 * keyboard the whole time, so the system timer never fires — while the conversation has been
 * sitting untouched; and someone can read the chat for ten minutes without pressing a key, which
 * the system timer calls away and this one does not (the renderer reports scrolls and clicks).
 *
 * Everything that counts as interaction calls `mark()`: the renderer pings it for keys, clicks,
 * wheel and window focus (`app.activity`), main marks the sends and prompt answers it handles, and
 * the interaction host events (`APP_INTERACTION_EVENTS`) mark it as they pass through the senses
 * provider. Nothing a character does on its own counts — a character showing an image is not the
 * user coming back.
 */
import type { EventName } from '@rp/shared';

/**
 * Host events that *are* the user touching the app: the overlay clicks and messages, and the chat
 * window being brought up. `media-started`/`media-closed` are deliberately absent — a queued image
 * opening or timing out happens without the user.
 */
export const APP_INTERACTION_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'avatar-clicked',
  'widget-message',
  'media-clicked',
  'chat-shown',
]);

export interface AppActivityOptions {
  now?: () => number;
  /** Called on every mark with what caused it, for the debug log. */
  onMark?: (reason: string) => void;
}

/** Last-interaction clock for the app timer. Trivially testable: `mark()` in, `idleMs()` out. */
export class AppActivity {
  private last: number;
  private lastReason = 'app started';

  constructor(private readonly o: AppActivityOptions = {}) {
    this.last = this.nowMs();
  }

  /**
   * The user just did something in the app. `reason` is only for the log — the app timer does not
   * care what it was, and no event is raised here: `detectEdges` turns the number into
   * `app-back` on the next poll, so one fast click cannot flood the characters.
   */
  mark(reason: string): void {
    this.last = this.nowMs();
    this.lastReason = reason;
    this.o.onMark?.(reason);
  }

  /** Milliseconds since the last interaction (since the app started, when there has been none). */
  idleMs(): number {
    return Math.max(0, this.nowMs() - this.last);
  }

  /** What was marked last, for the senses debug view and the log. */
  get reason(): string {
    return this.lastReason;
  }

  /** Mark when the event is one of the user's own interactions; ignore the rest. Returns whether it counted. */
  markFromEvent(name: EventName): boolean {
    if (!APP_INTERACTION_EVENTS.has(name)) return false;
    this.mark(name);
    return true;
  }

  private nowMs(): number {
    return (this.o.now ?? Date.now)();
  }
}
