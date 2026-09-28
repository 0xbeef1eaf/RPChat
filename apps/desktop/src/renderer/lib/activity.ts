/**
 * Feeds the app's idle timer: the renderer tells main when the user is actually working in rpchat
 * (`app.activity`), which main turns into `appIdleMs` / `inApp` and the `app-idle` / `app-back`
 * events. The compositor's own idle time cannot answer this question either way round — reading a
 * long reply without touching anything looks idle to it, and typing in another editor does not.
 *
 * What counts: keys, pointer presses, the wheel and the window taking focus. Not mouse movement —
 * a cursor drifting across the window, or a nudged desk, is not someone being in the conversation.
 * Pings are throttled (one per `ACTIVITY_THROTTLE_MS` at most), so continuous typing costs one
 * small IPC call every couple of seconds instead of one per keystroke.
 */

/** Longest a ping is suppressed for after one went through. Coarser than the senses poll on purpose. */
export const ACTIVITY_THROTTLE_MS = 2000;

export type ActivityKind = 'input' | 'focus';

export interface ActivityReporterOptions {
  send(kind: ActivityKind): void;
  now?(): number;
  throttleMs?: number;
}

/**
 * The throttle on its own, without a DOM: returns a function that forwards a report at most once
 * per window and answers whether it did. Dropping a ping is safe — one only gets dropped when
 * another went through moments ago, so main's last-interaction time is already fresh.
 */
export function createActivityReporter(o: ActivityReporterOptions): (kind: ActivityKind) => boolean {
  const throttleMs = o.throttleMs ?? ACTIVITY_THROTTLE_MS;
  const now = o.now ?? Date.now;
  let lastSent = Number.NEGATIVE_INFINITY;
  return (kind) => {
    const at = now();
    if (at - lastSent < throttleMs) return false;
    lastSent = at;
    o.send(kind);
    return true;
  };
}

/** Minimal shape of the thing listened on, so tests can pass a fake instead of a real window. */
export interface ActivityTarget {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void, options?: EventListenerOptions): void;
}

/**
 * Input events that mean "the user is in the app", the kind each is reported as, and whether it is
 * listened for in the capture phase. The three input events are captured, so a handler that stops
 * propagation (a modal, the editor) cannot hide the user. `focus` deliberately is **not**: only the
 * window's own focus event reaches a bubble-phase listener, whereas capturing would also catch every
 * element focus — including the one a modal gives itself when a *character* asks a question, which
 * would reset the app timer with the user nowhere near the machine.
 */
const TRACKED: ReadonlyArray<[type: string, kind: ActivityKind, capture: boolean]> = [
  ['keydown', 'input', true],
  ['pointerdown', 'input', true],
  ['wheel', 'input', true],
  ['focus', 'focus', false],
];

/** Start reporting; call the returned function to stop (React effect cleanup). */
export function trackAppActivity(target: ActivityTarget, o: ActivityReporterOptions): () => void {
  const report = createActivityReporter(o);
  const installed = TRACKED.map(([type, kind, capture]) => {
    const listener = (): void => void report(kind);
    target.addEventListener(type, listener, { capture, passive: true });
    return { type, listener, capture };
  });
  return () => {
    for (const { type, listener, capture } of installed) target.removeEventListener(type, listener, { capture });
  };
}
