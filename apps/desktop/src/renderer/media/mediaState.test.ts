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

describe('avatar / widget / draw pages', () => {
  const avatarState = {
    visible: true,
    expression: 'neutral',
    imageUrl: 'rp-asset://com.example.pack/characters/luna/neutral.png',
    size: 200,
    lookAtCursor: true,
    overlay: { layer: 'top' as const, opacity: 1, clickThrough: false },
  };

  it('avatar show/set/hide and click reporting', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, { type: 'avatar-show', id: 'av', state: avatarState }).state;
    expect(s.avatar?.id).toBe('av');
    s = applyMediaCommand(s, { type: 'avatar-set', id: 'av', patch: { expression: 'happy', bubble: { text: 'hey' } } }).state;
    expect(s.avatar?.state.expression).toBe('happy');
    const click = applyMediaLocalEvent(s, { type: 'avatar-click', id: 'av' });
    expect(click.reports).toEqual([{ type: 'avatar-clicked', id: 'av' }]);
    const expired = applyMediaLocalEvent(s, { type: 'bubble-expired', id: 'av' });
    expect(expired.state.avatar?.state.bubble).toBeUndefined();
    const size = applyMediaLocalEvent(s, { type: 'content-size', id: 'av', width: 200, height: 260 });
    expect(size.reports[0]?.type).toBe('content-size');
    const hide = applyMediaCommand(s, { type: 'avatar-hide', id: 'av' });
    expect(hide.state.avatar).toBeNull();
    expect(hide.reports).toEqual([{ type: 'closed', id: 'av' }]);
  });

  it('update applies the visual subset to avatars and widgets', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, { type: 'avatar-show', id: 'av', state: avatarState }).state;
    s = applyMediaCommand(s, { type: 'update', id: 'av', options: { opacity: 0.3, clickThrough: true, x: 0.5 } }).state;
    expect(s.avatar).toMatchObject({ opacity: 0.3, clickThrough: true });
    s = applyMediaCommand(s, { type: 'widget-show', id: 'w', widget: { id: 'w', html: '<p>x</p>', width: 100, height: 50 }, options: {} }).state;
    s = applyMediaCommand(s, { type: 'update', id: 'w', options: { width: 300, layer: 'overlay' } }).state;
    expect(s.widgets[0]?.options).toEqual({ width: 300 });
  });

  it('widget messages are validated before being reported, outbox drains after delivery', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, { type: 'widget-show', id: 'w', widget: { id: 'w', html: '<p>x</p>', width: 100, height: 50 }, options: {} }).state;
    expect(applyMediaLocalEvent(s, { type: 'widget-message', id: 'w', data: { clicked: 'ok' } }).reports).toEqual([{ type: 'widget-message', id: 'w', message: { clicked: 'ok' } }]);
    expect(applyMediaLocalEvent(s, { type: 'widget-message', id: 'w', data: () => 1 }).reports[0]?.type).toBe('error');
    expect(applyMediaLocalEvent(s, { type: 'widget-message', id: 'nope', data: 1 }).reports).toEqual([]);
    s = applyMediaCommand(s, { type: 'widget-update', id: 'w', postMessage: { a: 1 } }).state;
    expect(s.widgets[0]?.outbox).toHaveLength(1);
    s = applyMediaLocalEvent(s, { type: 'widget-delivered', id: 'w', seq: 1 }).state;
    expect(s.widgets[0]?.outbox).toEqual([]);
  });

  it('draw-set replaces the surface, draw-clear empties it, close removes it', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, { type: 'draw-set', id: 'mon0', shapes: [{ shapeId: 'a', type: 'circle', x: 0.5, y: 0.5 }, { shapeId: '', type: 'rect', x: 1, y: 1 }] }).state;
    expect(s.draws[0]?.shapes.map((x) => x.shapeId)).toEqual(['a']);
    s = applyMediaCommand(s, { type: 'draw-set', id: 'mon0', shapes: [{ shapeId: 'b', type: 'text', x: 10, y: 10, text: 'hi' }] }).state;
    expect(s.draws).toHaveLength(1);
    expect(s.draws[0]?.shapes[0]?.shapeId).toBe('b');
    s = applyMediaCommand(s, { type: 'draw-clear', id: 'mon0' }).state;
    expect(s.draws[0]?.shapes).toEqual([]);
    const r = applyMediaCommand(s, { type: 'close', id: 'mon0' });
    expect(r.state.draws).toEqual([]);
    expect(r.reports).toEqual([{ type: 'closed', id: 'mon0' }]);
  });

  it('close-all closes every page kind', () => {
    let s = applyMediaCommand(INITIAL_MEDIA_STATE, img('a')).state;
    s = applyMediaCommand(s, { type: 'avatar-show', id: 'av', state: avatarState }).state;
    s = applyMediaCommand(s, { type: 'widget-show', id: 'w', widget: { id: 'w', html: '', width: 10, height: 10 }, options: {} }).state;
    s = applyMediaCommand(s, { type: 'draw-set', id: 'd', shapes: [] }).state;
    const r = applyMediaCommand(s, { type: 'close-all' });
    expect(r.state).toEqual(INITIAL_MEDIA_STATE);
    expect(r.reports.map((e) => e.id).sort()).toEqual(['a', 'av', 'd', 'w']);
  });
});

describe('helpers', () => {
  it('isAllowedMediaUrl', () => {
    expect(isAllowedMediaUrl('rp-asset://com.example.pack/media/a.png')).toBe(true);
    expect(isAllowedMediaUrl('http://127.0.0.1:4321/t/abcDEF_-9/asset/com.example.pack/media/a.png')).toBe(true);
    expect(isAllowedMediaUrl('http://localhost:80/t/tok/asset/com.example.pack/v.mp4')).toBe(true);
    expect(isAllowedMediaUrl('http://127.0.0.1:4321/t/tok/media.html')).toBe(false);
    expect(isAllowedMediaUrl('http://evil.example/t/tok/asset/com.example.pack/a.png')).toBe(false);
    expect(isAllowedMediaUrl('https://127.0.0.1/t/tok/asset/com.example.pack/a.png')).toBe(false);
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
