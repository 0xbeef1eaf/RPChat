import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NowPlaying } from '@rp/shared';
import { IDLE_REPEAT_MS, PresenceProvider, dayPartOf, detectEdges, initialEdgeState, toSnapshot } from './presence.js';
import type { PresenceSample } from './presence.js';
import { parseActiveWindowOutput, parseHyprActiveWindow, parseHyprActiveWindowEvent, parseNowPlayingOutput, readLinuxBatteryPercent } from './samplers.js';
import { shouldIgnoreFile } from './watch.js';

const base: PresenceSample = { idleMs: 0, screenLocked: false, onBattery: false, batteryPercent: 80, activeWindow: { title: 'zsh', app: 'kitty' }, nowPlaying: null };
const at = '2026-09-05T12:00:00.000Z';
const opts = { idleThresholdMs: 120_000 };

describe('detectEdges', () => {
  it('emits idle/back once per crossing', () => {
    let s = detectEdges(initialEdgeState(), base, opts, at);
    expect(s.events).toEqual([]);
    s = detectEdges(s.state, { ...base, idleMs: 130_000 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['user-idle']);
    // Still idle, within the repeat pace: no second crossing event.
    s = detectEdges(s.state, { ...base, idleMs: 145_000 }, opts, at);
    expect(s.events).toEqual([]);
    s = detectEdges(s.state, { ...base, idleMs: 1000 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['user-back']);
  });

  it('keeps reporting user-idle while the user stays away, so longer subscription thresholds are reached', () => {
    // A subscription asking for "away 15 minutes" only fires on an event that
    // says so; one event at the 2-minute crossing would never reach it.
    let s = detectEdges(initialEdgeState(), base, opts, at);
    s = detectEdges(s.state, { ...base, idleMs: 120_000 }, opts, at);
    expect(s.events).toEqual([{ name: 'user-idle', data: { idleMs: 120_000 }, at }]);

    // Nothing more until it has grown by the repeat pace.
    s = detectEdges(s.state, { ...base, idleMs: 140_000 }, opts, at);
    expect(s.events).toEqual([]);
    s = detectEdges(s.state, { ...base, idleMs: 120_000 + IDLE_REPEAT_MS }, opts, at);
    expect(s.events.map((e) => e.data)).toEqual([{ idleMs: 150_000 }]);
    s = detectEdges(s.state, { ...base, idleMs: 900_000 }, opts, at);
    expect(s.events.map((e) => e.data)).toEqual([{ idleMs: 900_000 }]);

    // Back at the keyboard: one user-back, and the next absence starts over.
    s = detectEdges(s.state, { ...base, idleMs: 0 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['user-back']);
    s = detectEdges(s.state, { ...base, idleMs: 130_000 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['user-idle']);
  });

  it('emits battery-low once below the threshold, re-arming when charged', () => {
    let s = detectEdges(initialEdgeState(), base, opts, at);
    s = detectEdges(s.state, { ...base, onBattery: true, batteryPercent: 15 }, opts, at);
    expect(s.events).toEqual([{ name: 'battery-low', data: { percent: 15 }, at }]);
    s = detectEdges(s.state, { ...base, onBattery: true, batteryPercent: 10 }, opts, at);
    expect(s.events).toEqual([]);
    s = detectEdges(s.state, { ...base, onBattery: false, batteryPercent: 30 }, opts, at);
    s = detectEdges(s.state, { ...base, onBattery: true, batteryPercent: 12 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['battery-low']);
  });

  it('emits screen lock transitions, window changes, first-seen apps and song changes', () => {
    let s = detectEdges(initialEdgeState(), base, opts, at);
    s = detectEdges(s.state, { ...base, screenLocked: true }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['screen-locked']);
    s = detectEdges(s.state, { ...base, screenLocked: false, activeWindow: { title: 'Inbox', app: 'firefox', class: 'firefox' } }, opts, at);
    expect(s.events).toEqual([
      { name: 'screen-unlocked', data: {}, at },
      { name: 'window-changed', data: { title: 'Inbox', app: 'firefox', class: 'firefox' }, at },
      { name: 'app-launched', data: { app: 'firefox' }, at },
    ]);
    s = detectEdges(s.state, { ...base, activeWindow: { title: 'Docs', app: 'firefox' } }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['window-changed']);
    const song: NowPlaying = { title: 'Blue', artist: 'X', status: 'playing' };
    s = detectEdges(s.state, { ...base, activeWindow: { title: 'Docs', app: 'firefox' }, nowPlaying: song }, opts, at);
    expect(s.events).toEqual([{ name: 'song-changed', data: song, at }]);
    s = detectEdges(s.state, { ...base, activeWindow: { title: 'Docs', app: 'firefox' }, nowPlaying: { ...song, status: 'paused' } }, opts, at);
    expect(s.events).toEqual([]);
  });
});

describe('PresenceProvider', () => {
  it('samples on demand, polls only with interest, and pushes edge events to subscribers', async () => {
    let current: PresenceSample = { ...base };
    let samples = 0;
    const provider = new PresenceProvider({
      sampler: { sample: async () => (samples += 1, current) },
      settings: async () => ({ pollMs: 5000, idleThresholdMs: 60_000 }),
      logger: { warn: () => undefined, debug: () => undefined },
      snapshotCacheMs: 0,
    });
    const snap = await provider.snapshot();
    expect(snap).toMatchObject({ idleMs: 0, atKeyboard: true, activeWindow: { title: 'zsh', app: 'kitty' }, batteryPercent: 80, sinceLastMessageMs: null });
    expect(snap.localTime).toMatch(/^\w{3} \d\d:\d\d$/);
    const got: string[] = [];
    provider.subscribe((e) => got.push(e.name));
    expect(provider.polling).toBe(false);
    provider.setInterest(['time', 'custom:x' as never]);
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.polling).toBe(false);
    provider.setInterest(['user-idle']);
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.polling).toBe(true);
    current = { ...base, idleMs: 90_000 };
    await provider.tick();
    expect(got).toEqual(['user-idle']);
    provider.pushActiveWindow({ title: 'Mail', app: 'thunderbird', class: 'thunderbird' });
    expect(got).toEqual(['user-idle', 'window-changed', 'app-launched']);
    provider.setInterest([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.polling).toBe(false);
    await provider.dispose();
    expect(samples).toBeGreaterThan(0);
  });

  it('picks up a changed poll interval on refreshSettings (the loop captured the old one)', async () => {
    let pollMs = 5000;
    let samples = 0;
    const provider = new PresenceProvider({
      sampler: { sample: async () => (samples += 1, { ...base }) },
      settings: async () => ({ pollMs, idleThresholdMs: 60_000 }),
      logger: { warn: () => undefined, debug: () => undefined },
      snapshotCacheMs: 0,
    });
    provider.setInterest(['user-idle']);
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.polling).toBe(true);
    const afterFirstPoll = samples;

    // 5 s between polls: nothing more is sampled on its own within the test.
    await new Promise((r) => setTimeout(r, 30));
    expect(samples).toBe(afterFirstPoll);

    // Settings → Senses lowered the interval; the running loop has to restart.
    pollMs = 1000; // clamped to the 500 ms floor below
    await provider.refreshSettings();
    await new Promise((r) => setTimeout(r, 20));
    expect(samples).toBeGreaterThan(afterFirstPoll);
    expect(provider.polling).toBe(true);

    // Refreshing while nothing is interested does not start a loop.
    provider.setInterest([]);
    await new Promise((r) => setTimeout(r, 5));
    await provider.refreshSettings();
    expect(provider.polling).toBe(false);
    await provider.dispose();
  });

  it('derives snapshot fields', () => {
    expect(dayPartOf(new Date(2026, 0, 1, 3))).toBe('night');
    expect(dayPartOf(new Date(2026, 0, 1, 7))).toBe('early-morning');
    expect(dayPartOf(new Date(2026, 0, 1, 14))).toBe('afternoon');
    expect(dayPartOf(new Date(2026, 0, 1, 22))).toBe('late-evening');
    expect(toSnapshot({ ...base, idleMs: 200_000 }, 120_000, new Date(2026, 0, 1, 9, 5)).atKeyboard).toBe(false);
  });
});

describe('samplers + watch parsing', () => {
  it('parses active window and now-playing outputs', () => {
    expect(parseActiveWindowOutput('{"title":"Inbox","app":"firefox","class":"Firefox"}')).toEqual({ title: 'Inbox', app: 'firefox', class: 'Firefox' });
    expect(parseActiveWindowOutput('Inbox\tfirefox\n')).toEqual({ title: 'Inbox', app: 'firefox' });
    expect(parseActiveWindowOutput('')).toBeNull();
    expect(parseHyprActiveWindow('{"address":"0x1","class":"kitty","title":"zsh","initialClass":"kitty"}')).toEqual({ title: 'zsh', app: 'kitty', class: 'kitty' });
    expect(parseHyprActiveWindow('{}')).toBeNull();
    expect(parseHyprActiveWindowEvent('firefox,Inbox — Mozilla Firefox')).toEqual({ title: 'Inbox — Mozilla Firefox', app: 'firefox', class: 'firefox' });
    expect(parseHyprActiveWindowEvent(',')).toBeNull();
    expect(parseNowPlayingOutput('{"title":"Blue","artist":"X","album":"","app":"spotify","status":"Playing"}')).toEqual({ title: 'Blue', artist: 'X', app: 'spotify', status: 'playing' });
    expect(parseNowPlayingOutput('{"title":"Blue","status":"Stopped"}')).toBeNull();
    expect(parseNowPlayingOutput('No players found')).toBeNull();
  });

  it('ignores dotfiles and partial downloads', () => {
    expect(shouldIgnoreFile('.hidden')).toBe(true);
    expect(shouldIgnoreFile('movie.mp4.part')).toBe(true);
    expect(shouldIgnoreFile('x.crdownload')).toBe(true);
    expect(shouldIgnoreFile('notes.txt~')).toBe(true);
    expect(shouldIgnoreFile('report.pdf')).toBe(false);
  });
});

describe('readLinuxBatteryPercent', () => {
  /** A /sys/class/power_supply tree: each entry is name → files. */
  function sysfs(devices: Record<string, Record<string, string>>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-power-'));
    for (const [name, files] of Object.entries(devices)) {
      fs.mkdirSync(path.join(root, name));
      for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), `${value}\n`);
    }
    return root;
  }

  it('ignores peripheral batteries, which is all a desktop has', () => {
    // Verbatim from a desktop with a Logitech mouse: the only power_supply entry.
    const root = sysfs({ hidpp_battery_0: { type: 'Battery', scope: 'Device', capacity: '61', status: 'Discharging' } });
    expect(readLinuxBatteryPercent(root)).toBeNull();
  });

  it('reads the machine battery, with or without a scope file, and skips the mains adapter', () => {
    expect(readLinuxBatteryPercent(sysfs({ AC: { type: 'Mains', online: '1' }, BAT0: { type: 'Battery', capacity: '87' } }))).toBe(87);
    expect(readLinuxBatteryPercent(sysfs({ BAT0: { type: 'Battery', scope: 'System', capacity: '5' } }))).toBe(5);
    // A laptop with a wireless mouse plugged in: the laptop battery wins whichever comes first.
    expect(readLinuxBatteryPercent(sysfs({ hidpp_battery_0: { type: 'Battery', scope: 'Device', capacity: '61' }, BAT0: { type: 'Battery', capacity: '42' } }))).toBe(42);
  });

  it('clamps nonsense and returns null when there is nothing to read', () => {
    expect(readLinuxBatteryPercent(sysfs({ BAT0: { type: 'Battery', capacity: '140' } }))).toBe(100);
    expect(readLinuxBatteryPercent(sysfs({ BAT0: { type: 'Battery', capacity: 'n/a' } }))).toBeNull();
    expect(readLinuxBatteryPercent(sysfs({}))).toBeNull();
    expect(readLinuxBatteryPercent('/nope/does-not-exist')).toBeNull();
  });
});
