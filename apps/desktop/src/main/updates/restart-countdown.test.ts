import { describe, expect, it } from 'vitest';
import type { AppSettings, RestartPromptPayload, UpdateStatus } from '@rp/shared';
import { RestartCountdown, restartPayload } from './restart-countdown.js';

const READY: UpdateStatus = { state: 'ready', currentVersion: '1.0.0', latestVersion: '1.1.0', packaging: 'appimage', canInstallInPlace: true, managed: false };

function make(updates: Partial<AppSettings['updates']>, install: () => Promise<void> = async () => undefined) {
  let listener: ((s: UpdateStatus) => void) | undefined;
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const log = { asked: [] as string[], opened: [] as RestartPromptPayload[], closed: [] as string[], installs: 0 };
  const countdown = new RestartCountdown({
    updates: {
      subscribe: (l) => {
        listener = l;
        return () => (listener = undefined);
      },
      install: async () => {
        log.installs++;
        await install();
      },
    },
    settings: async () => ({ updates: { automatic: true, checkIntervalHours: 6, forceRestart: false, restartCountdownSeconds: 60, ...updates } }) as AppSettings,
    ask: (s) => log.asked.push(s.latestVersion ?? ''),
    openWindow: (p) => {
      log.opened.push(p);
      return true;
    },
    closeWindow: (id) => log.closed.push(id),
    logger: { info: () => undefined, warn: () => undefined },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const emit = async (s: UpdateStatus) => {
    listener?.(s);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  const fire = async () => {
    const t = timers.find((x) => !x.cleared);
    t?.fn();
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return { countdown, emit, fire, timers, log, advance: (ms: number) => (now += ms) };
}

describe('restartPayload', () => {
  it('names the version and ends the countdown that many seconds from now', () => {
    expect(restartPayload(READY, 30, 5_000)).toEqual({ kind: 'restart', promptId: 'update-restart-1.1.0', version: '1.1.0', packaging: 'appimage', deadline: 35_000 });
  });
});

describe('RestartCountdown', () => {
  it('asks, once per version, when the restart is not forced', async () => {
    const t = make({ forceRestart: false });
    await t.emit({ ...READY, state: 'downloading' });
    await t.emit(READY);
    await t.emit(READY);
    expect(t.log.asked).toEqual(['1.1.0']);
    expect(t.log.opened).toEqual([]);
    await t.emit({ ...READY, latestVersion: '1.2.0' });
    expect(t.log.asked).toEqual(['1.1.0', '1.2.0']);
  });

  it('when forced, shows the countdown and restarts when it runs out, with the seconds held to their range', async () => {
    const t = make({ forceRestart: true, restartCountdownSeconds: 2 });
    await t.emit(READY);
    expect(t.log.asked).toEqual([]);
    expect(t.log.opened).toEqual([{ kind: 'restart', promptId: 'update-restart-1.1.0', version: '1.1.0', packaging: 'appimage', deadline: 1_000_000 + 10_000 }]);
    expect(t.timers[0]?.ms).toBe(10_000);
    expect(t.countdown.pending?.version).toBe('1.1.0');
    expect(t.log.installs).toBe(0);
    await t.fire();
    expect(t.log.installs).toBe(1);
  });

  it('closes the window and stays put when the restart fails, so Settings → Updates can retry', async () => {
    const t = make({ forceRestart: true }, async () => {
      throw new Error('daemon gone');
    });
    await t.emit(READY);
    await t.fire();
    expect(t.log.installs).toBe(1);
    expect(t.log.closed).toEqual(['update-restart-1.1.0']);
    expect(t.countdown.pending).toBeUndefined();
  });

  it('does nothing more once the app is shutting down', async () => {
    const t = make({ forceRestart: true });
    await t.emit(READY);
    t.countdown.stop();
    expect(t.timers[0]?.cleared).toBe(true);
    expect(t.log.closed).toEqual(['update-restart-1.1.0']);
    await t.emit({ ...READY, latestVersion: '1.2.0' });
    expect(t.log.opened).toHaveLength(1);
    expect(t.log.installs).toBe(0);
  });
});
