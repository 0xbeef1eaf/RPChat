import { describe, expect, it } from 'vitest';
import {
  applyMediaCommand,
  applyMediaLocalEvent,
  applyUpdate,
  closesOnEnd,
  effectiveOpacity,
  effectiveVolume,
  INITIAL_MEDIA_STATE,
  isAllowedMediaUrl,
  type MediaState,
} from './mediaState';

const img = (id: string) =>
  ({ type: 'show-image', id, url: `rp-asset://com.example.pack/media/images/${id}.png`, options: { caption: id } }) as const;

describe('applyMediaCommand', () => {
  it('adds image/video/audio items and reports nothing', () => {
    let s: MediaState = INITIAL_MEDIA_STATE;
    const r1 = applyMediaCommand(s, img('a'));
    s = r1.state;
    expect(r1.reports).toEqual([]);
    const r2 = applyMediaCommand(s, { type: 'play-video', id: 'v', url: 'rp-asset://com.example.pack/media/v.mp4', options: {} });
    s = r2.state;
    const r3 = applyMediaCommand(s, { type: 'play-audio', id: 'au', url: 'rp-asset://com.example.pack/media/a.mp3', options: { loop: true } });
    s = r3.state;
    expect(s.items.map((i) => [i.id, i.kind])).toEqual([
      ['a', 'image'],
      ['v', 'video'],
      ['au', 'audio'],
    ]);
  });

  it('replaces an item shown again with the same id', () => {
    const s1 = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    const s2 = applyMediaCommand(s1, { ...img('a'), options: { caption: 'new' } }).state;
    expect(s2.items).toHaveLength(1);
    expect(s2.items[0]?.options).toEqual({ caption: 'new' });
  });

  it('refuses non rp-asset URLs with an error report', () => {
    const r = applyMediaCommand(INITIAL_MEDIA_STATE, {
      type: 'show-image',
      id: 'x',
      url: 'https://example.com/evil.png',
      options: {},
    });
    expect(r.state.items).toEqual([]);
    expect(r.reports[0]?.type).toBe('error');
  });

  it('close removes and reports closed; unknown ids are ignored', () => {
    const s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    const r = applyMediaCommand(s, { type: 'close', id: 'a' });
    expect(r.state.items).toEqual([]);
    expect(r.reports).toEqual([{ type: 'closed', id: 'a' }]);
    const r2 = applyMediaCommand(r.state, { type: 'close', id: 'a' });
    expect(r2.reports).toEqual([]);
    expect(r2.state).toBe(r.state);
  });

  it('close-all reports closed for each item', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    s = applyMediaCommand(s, img('b')).state;
    const r = applyMediaCommand(s, { type: 'close-all' });
    expect(r.state.items).toEqual([]);
    expect(r.reports).toEqual([
      { type: 'closed', id: 'a' },
      { type: 'closed', id: 'b' },
    ]);
  });
});

describe('update command', () => {
  it('applies opacity/width/height/clickThrough and ignores placement keys', () => {
    const s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    const r = applyMediaCommand(s, {
      type: 'update',
      id: 'a',
      options: { opacity: 0.5, width: 300, height: 200, clickThrough: true, x: 10, y: 20, layer: 'overlay', monitor: 'DP-1' },
    });
    expect(r.reports).toEqual([]);
    expect(r.state.items[0]?.options).toEqual({ caption: 'a', opacity: 0.5, width: 300, height: 200, clickThrough: true });
  });

  it('is a no-op for unknown ids, audio items and empty patches', () => {
    const s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    expect(applyMediaCommand(s, { type: 'update', id: 'nope', options: { opacity: 0.2 } }).state).toBe(s);
    expect(applyUpdate(s.items[0]!, { x: 0.5 })).toBe(s.items[0]);
    const audio = applyMediaCommand(INITIAL_MEDIA_STATE, {
      type: 'play-audio',
      id: 'au',
      url: 'rp-asset://com.example.pack/media/a.mp3',
      options: {},
    }).state.items[0]!;
    expect(applyUpdate(audio, { opacity: 0.1 })).toBe(audio);
  });
});

describe('applyMediaLocalEvent', () => {
  const video = (opts: Record<string, unknown>) =>
    applyMediaCommand(INITIAL_MEDIA_STATE, {
      type: 'play-video',
      id: 'v',
      url: 'rp-asset://com.example.pack/media/v.mp4',
      options: opts,
    }).state;

  it('dismiss reports closed', () => {
    const s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    const r = applyMediaLocalEvent(s, { type: 'dismiss', id: 'a' });
    expect(r.state.items).toEqual([]);
    expect(r.reports).toEqual([{ type: 'closed', id: 'a' }]);
  });

  it('ended on a video with closeOnEnd (default) reports ended then closed', () => {
    const r = applyMediaLocalEvent(video({}), { type: 'ended', id: 'v' });
    expect(r.reports).toEqual([
      { type: 'ended', id: 'v' },
      { type: 'closed', id: 'v' },
    ]);
    expect(r.state.items).toEqual([]);
  });

  it('ended on a video with closeOnEnd=false keeps the item', () => {
    const r = applyMediaLocalEvent(video({ closeOnEnd: false }), { type: 'ended', id: 'v' });
    expect(r.reports).toEqual([{ type: 'ended', id: 'v' }]);
    expect(r.state.items).toHaveLength(1);
  });

  it('looping media never closes on end', () => {
    expect(closesOnEnd(video({ loop: true }).items[0]!)).toBe(false);
  });

  it('error removes the item and reports error + closed', () => {
    const r = applyMediaLocalEvent(video({}), { type: 'error', id: 'v', message: 'decode failed' });
    expect(r.state.items).toEqual([]);
    expect(r.reports.map((e) => e.type)).toEqual(['error', 'closed']);
  });

  it('content-size is forwarded as a report without changing state', () => {
    const s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    const r = applyMediaLocalEvent(s, { type: 'content-size', id: 'a', width: 320, height: 200 });
    expect(r.state).toBe(s);
    expect(r.reports).toEqual([{ type: 'content-size', id: 'a', width: 320, height: 200 }]);
  });

  it('ignores events for unknown ids', () => {
    const r = applyMediaLocalEvent(INITIAL_MEDIA_STATE, { type: 'ended', id: 'nope' });
    expect(r.reports).toEqual([]);
  });
});

describe('helpers', () => {
  it('isAllowedMediaUrl', () => {
    expect(isAllowedMediaUrl('rp-asset://com.example.pack/media/a.png')).toBe(true);
    expect(isAllowedMediaUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedMediaUrl('rp-asset://')).toBe(false);
  });
  it('effectiveOpacity clamps', () => {
    expect(effectiveOpacity(undefined)).toBe(1);
    expect(effectiveOpacity(1.5)).toBe(1);
    expect(effectiveOpacity(-0.2)).toBe(0);
    expect(effectiveOpacity(0.35)).toBe(0.35);
  });
  it('effectiveVolume clamps', () => {
    expect(effectiveVolume(undefined)).toBe(1);
    expect(effectiveVolume(2)).toBe(1);
    expect(effectiveVolume(-1)).toBe(0);
    expect(effectiveVolume(0.4)).toBe(0.4);
  });
});
