/**
 * Starting video/audio playback, where being refused is not the same as failing.
 *
 * The layer-shell helper's pages are WebKit, which will not start a *video* until the page has seen
 * a user gesture — `media-playback-requires-user-gesture: false`, which the helper sets, does not
 * lift it, and sound plays either way. The helper therefore synthesises a click into the view as
 * the page loads (docs/spec/overlay-helper.md), and `play()` is only refused while that is still in
 * flight, so a refusal is retried rather than reported.
 *
 * Reporting it would be worse than useless: main closes an item the moment its page reports an
 * error, so a refused `play()` took the whole overlay down — an empty player that vanished a
 * heartbeat after it appeared, whatever `loop` or `closeOnEnd` asked for. Anything that is not a
 * refusal is a real failure (a file the page cannot decode) and goes straight back to main, which
 * still closes the item as it always has. If every retry is refused the element simply stays on its
 * first frame: visible and closable, rather than gone.
 */

/** Gap between attempts. */
export const PLAY_RETRY_MS = 250;
/** Attempts after the first, i.e. ~5s of trying before the frame is left as it is. */
export const PLAY_RETRY_LIMIT = 20;

/** A `play()` rejection that means "not without a user gesture", not "this file is broken". */
export function isPlaybackRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotAllowedError';
}

export function playbackErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PlaybackAttempt {
  /** Stop retrying (the item went away, or its URL changed). */
  cancel(): void;
}

export interface PlaybackTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const windowTimers: PlaybackTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/**
 * Play `element`, retrying while the page is refused a gesture. `onFailure` is called only for a
 * genuine failure, at most once.
 */
export function startPlayback(
  element: Pick<HTMLMediaElement, 'play'>,
  onFailure: (message: string) => void,
  timers: PlaybackTimers = windowTimers,
): PlaybackAttempt {
  let cancelled = false;
  let retries = 0;
  let handle: number | undefined;

  const attempt = (): void => {
    let started: Promise<void> | undefined;
    try {
      started = element.play() as Promise<void> | undefined;
    } catch (err) {
      if (!cancelled) onFailure(playbackErrorMessage(err));
      return;
    }
    if (!started) return; // a browser old enough not to return a promise has already started or not
    void started.catch((err: unknown) => {
      if (cancelled) return;
      if (!isPlaybackRefusal(err)) {
        onFailure(playbackErrorMessage(err));
        return;
      }
      if (retries >= PLAY_RETRY_LIMIT) return;
      retries += 1;
      handle = timers.setTimeout(attempt, PLAY_RETRY_MS);
    });
  };

  attempt();
  return {
    cancel() {
      cancelled = true;
      if (handle !== undefined) timers.clearTimeout(handle);
    },
  };
}
