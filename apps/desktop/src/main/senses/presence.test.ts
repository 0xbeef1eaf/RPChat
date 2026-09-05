import { describe, expect, it } from 'vitest';
import type { NowPlaying } from '@rp/shared';
import { PresenceProvider, dayPartOf, detectEdges, initialEdgeState, toSnapshot } from './presence.js';
import type { PresenceSample } from './presence.js';
import { parseActiveWindowOutput, parseHyprActiveWindow, parseHyprActiveWindowEvent, parseNowPlayingOutput } from './samplers.js';
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
    s = detectEdges(s.state, { ...base, idleMs: 200_000 }, opts, at);
    expect(s.events).toEqual([]);
    s = detectEdges(s.state, { ...base, idleMs: 1000 }, opts, at);
    expect(s.events.map((e) => e.name)).toEqual(['user-back']);
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
