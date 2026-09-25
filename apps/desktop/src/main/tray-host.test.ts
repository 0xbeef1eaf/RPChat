import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './tray-host.js';
import { HOST_PROBE_COMMANDS, HOST_WAIT_MS, HOST_WATCH_MS, WATCHER_NAME, buildTrayWhenHostReady, hostRegistered, statusNotifierHostProbe, waitForHost } from './tray-host.js';

/** A clock and a sleep that only move when a wait sleeps, so the tests run instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let t = 1_000;
  return { now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()), elapsed: () => t - 1_000 };
}

describe('tray host (pure)', () => {
  it('hostRegistered reads the boolean every bus tool prints, and nothing else', () => {
    expect(hostRegistered({ code: 0, stdout: 'b true\n' })).toBe(true);
    expect(hostRegistered({ code: 0, stdout: '(<true>,)\n' })).toBe(true);
    expect(hostRegistered({ code: 0, stdout: 'method return time=1 sender=:1.31\n   variant       boolean true\n' })).toBe(true);
    expect(hostRegistered({ code: 0, stdout: 'b false\n' })).toBe(false);
    expect(hostRegistered({ code: 0, stdout: '(<false>,)\n' })).toBe(false);
    // A watcher that is not there fails, whatever it wrote.
    expect(hostRegistered({ code: 1, stdout: 'b true\n' })).toBe(false);
    expect(hostRegistered('missing')).toBe(false);
  });

  it('every probe command asks the watcher for its own property', () => {
    expect(HOST_PROBE_COMMANDS.map((c) => c.file)).toEqual(['busctl', 'gdbus', 'dbus-send']);
    for (const command of HOST_PROBE_COMMANDS) {
      expect(command.args.join(' ')).toContain(WATCHER_NAME);
      expect(command.args.join(' ')).toContain('IsStatusNotifierHostRegistered');
    }
  });

  it('waitForHost probes at once, then polls until the host answers', async () => {
    const clock = fakeClock();
    let calls = 0;
    const ready = await waitForHost({ probe: () => Promise.resolve(++calls === 4), ...clock }, { timeoutMs: 10_000, pollMs: 250 });
    expect(ready).toBe(true);
    expect(calls).toBe(4);
    expect(clock.elapsed()).toBe(750);
  });

  it('waitForHost needs no wait at all when a host is already registered', async () => {
    const clock = fakeClock();
    expect(await waitForHost({ probe: () => Promise.resolve(true), ...clock }, { timeoutMs: 10_000, pollMs: 250 })).toBe(true);
    expect(clock.elapsed()).toBe(0);
  });

  it('waitForHost gives up at the deadline', async () => {
    const clock = fakeClock();
    let calls = 0;
    const ready = await waitForHost({ probe: () => (calls++, Promise.resolve(false)), ...clock }, { timeoutMs: 1_000, pollMs: 250 });
    expect(ready).toBe(false);
    expect(clock.elapsed()).toBeLessThanOrEqual(1_000);
    expect(calls).toBe(5);
  });

  it('builds the tray once, straight away, when a host is up', async () => {
    const clock = fakeClock();
    const builds: boolean[] = [];
    await buildTrayWhenHostReady({ probe: () => Promise.resolve(true), wayland: true, ...clock }, (ready) => builds.push(ready));
    expect(builds).toEqual([true]);
    expect(clock.elapsed()).toBe(0);
  });

  it('waits for a host that appears a second into the session (the login race)', async () => {
    const clock = fakeClock();
    const builds: boolean[] = [];
    // The shell claims the name 1.2 s after we start looking, as a panel at login does.
    const probe = (): Promise<boolean> => Promise.resolve(clock.now() >= 1_000 + 1_200);
    await buildTrayWhenHostReady({ probe, wayland: true, ...clock }, (ready) => builds.push(ready));
    expect(builds).toEqual([true]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(1_200);
    expect(clock.elapsed()).toBeLessThan(HOST_WAIT_MS.wayland);
  });

  it('on Wayland builds a tray anyway, then replaces it when a host turns up late', async () => {
    const clock = fakeClock();
    const builds: boolean[] = [];
    const probe = (): Promise<boolean> => Promise.resolve(clock.now() >= 1_000 + 60_000);
    await buildTrayWhenHostReady({ probe, wayland: true, ...clock }, (ready) => builds.push(ready));
    expect(builds).toEqual([false, true]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
  });

  it('on X11 builds the XEmbed tray after a short wait and stops watching', async () => {
    const clock = fakeClock();
    const builds: boolean[] = [];
    await buildTrayWhenHostReady({ probe: () => Promise.resolve(false), wayland: false, ...clock }, (ready) => builds.push(ready));
    expect(builds).toEqual([false]);
    expect(clock.elapsed()).toBeLessThanOrEqual(HOST_WAIT_MS.other);
  });

  it('gives up on Wayland once the watch is over, leaving the tray it built', async () => {
    const clock = fakeClock();
    const builds: boolean[] = [];
    await buildTrayWhenHostReady({ probe: () => Promise.resolve(false), wayland: true, ...clock }, (ready) => builds.push(ready));
    expect(builds).toEqual([false]);
    expect(clock.elapsed()).toBeLessThanOrEqual(HOST_WAIT_MS.wayland + HOST_WATCH_MS);
  });

  it('the probe asks the next tool when one is not installed, and only once', async () => {
    const asked: string[] = [];
    const run = (file: string): Promise<ProbeResult> => {
      asked.push(file);
      if (file === 'busctl') return Promise.resolve('missing');
      return Promise.resolve({ code: 0, stdout: '(<true>,)\n' });
    };
    const probe = statusNotifierHostProbe({ platform: 'linux', run });
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(asked).toEqual(['busctl', 'gdbus', 'gdbus']);
  });

  it('with no bus tool installed the probe says go ahead rather than wait for nothing', async () => {
    const probe = statusNotifierHostProbe({ platform: 'linux', run: () => Promise.resolve('missing') });
    expect(await probe()).toBe(true);
  });

  it('off Linux nothing is spawned at all', async () => {
    let spawned = 0;
    const probe = statusNotifierHostProbe({
      platform: 'win32',
      run: () => {
        spawned++;
        return Promise.resolve('missing');
      },
    });
    expect(await probe()).toBe(true);
    expect(spawned).toBe(0);
  });

  it('a watcher with no host yet is a no', async () => {
    const probe = statusNotifierHostProbe({ platform: 'linux', run: () => Promise.resolve({ code: 0, stdout: 'b false\n' }) });
    expect(await probe()).toBe(false);
  });
});
