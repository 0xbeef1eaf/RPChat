/** `startPlayback`: a refused autoplay is retried and never reported; a real failure is reported once. */
import { describe, expect, it, vi } from 'vitest';
import { PLAY_RETRY_LIMIT, PLAY_RETRY_MS, isPlaybackRefusal, startPlayback, type PlaybackTimers } from './playback';

/** Runs whatever `startPlayback` schedules, so a test can step through the retries. */
function fakeTimers(): PlaybackTimers & { run(): Promise<void>; pending(): number } {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    setTimeout(fn) {
      const handle = next++;
      queued.set(handle, fn);
      return handle;
    },
    clearTimeout(handle) {
      queued.delete(handle);
    },
    pending: () => queued.size,
    async run() {
      for (const [handle, fn] of [...queued]) {
        queued.delete(handle);
        fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

const refusal = (): DOMException | Error => {
  const err = new Error('play() failed because the user agent did not allow it');
  err.name = 'NotAllowedError';
  return err;
};

/** An element refused `refusals` times, then playing (or failing with `fatal`). */
function element(refusals: number, fatal?: Error): { play: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    play: () => {
      calls += 1;
      if (calls <= refusals) return Promise.reject(refusal());
      return fatal ? Promise.reject(fatal) : Promise.resolve();
    },
  };
}

describe('isPlaybackRefusal', () => {
  it('knows a gesture refusal from a decode failure', () => {
    expect(isPlaybackRefusal(refusal())).toBe(true);
    expect(isPlaybackRefusal(new Error('The media resource was not suitable'))).toBe(false);
    expect(isPlaybackRefusal('nope')).toBe(false);
    expect(isPlaybackRefusal(null)).toBe(false);
  });
});

describe('startPlayback', () => {
  it('retries a refusal until it takes, without reporting anything', async () => {
    const timers = fakeTimers();
    const el = element(2);
    const onFailure = vi.fn();

    startPlayback(el, onFailure, timers);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.calls()).toBe(1);

    await timers.run(); // second attempt: refused again
    await timers.run(); // third: plays
    expect(el.calls()).toBe(3);
    expect(onFailure).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('reports a failure that is not a refusal, once, and stops', async () => {
    const timers = fakeTimers();
    const el = element(0, new Error('Video failed to decode'));
    const onFailure = vi.fn();

    startPlayback(el, onFailure, timers);
    await Promise.resolve();
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('Video failed to decode');
    expect(timers.pending()).toBe(0);
  });

  it('gives up after the retry limit and still reports nothing: the frame stays, the overlay lives', async () => {
    const timers = fakeTimers();
    const el = element(Number.MAX_SAFE_INTEGER);
    const onFailure = vi.fn();

    startPlayback(el, onFailure, timers);
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < PLAY_RETRY_LIMIT + 3; i++) await timers.run();

    expect(el.calls()).toBe(PLAY_RETRY_LIMIT + 1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('stops retrying once cancelled', async () => {
    const timers = fakeTimers();
    const el = element(Number.MAX_SAFE_INTEGER);
    const onFailure = vi.fn();

    const attempt = startPlayback(el, onFailure, timers);
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending()).toBe(1);

    attempt.cancel();
    await timers.run();
    expect(el.calls()).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a play() that throws outright', async () => {
    const onFailure = vi.fn();
    startPlayback(
      {
        play: () => {
          throw new Error('no media element');
        },
      },
      onFailure,
      fakeTimers(),
    );
    expect(onFailure).toHaveBeenCalledWith('no media element');
  });

  it('retries a quarter of a second apart', () => {
    expect(PLAY_RETRY_MS).toBe(250);
  });
});
