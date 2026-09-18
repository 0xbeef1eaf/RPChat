import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext, AppSettings, HostEvent, LoadedPack, MediaCommand, MediaConcurrencySettings, MediaWindowEvent, MonitorInfo, OverlayUpdate } from '@rp/shared';
import type { DisplayBackend, OverlayEvent, OverlayHandle, OverlaySpec, OverlayWindowLike } from '../display/backend.js';
import { MediaManager, mediaLimits } from './media.js';

/** Minimal listener registry (importing the Electron backend's one here would enter its import cycle first). */
class OverlayEvents {
  private readonly listeners = new Map<string, Set<(detail?: unknown) => void>>();
  on(event: OverlayEvent, listener: (detail?: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(event: OverlayEvent, detail?: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(detail);
  }
}

const MONITOR: MonitorInfo = { id: 'm0', name: 'Main', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true };
const SECOND: MonitorInfo = { id: 'm1', name: 'Side', index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 1024, scale: 1, hasCursor: false };

class FakeHandle implements OverlayHandle {
  readonly events = new OverlayEvents();
  readonly updates: OverlayUpdate[] = [];
  closed = false;
  constructor(readonly id: string) {}
  async update(patch: OverlayUpdate): Promise<void> {
    this.updates.push(patch);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.events.emit('closed', { reason: 'api' });
  }
  async send(_command: MediaCommand): Promise<void> {}
  on(event: OverlayEvent, listener: (detail?: unknown) => void): () => void {
    return this.events.on(event, listener);
  }
}

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-media-test-'));
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'media', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'media', 'v.webm'), 'x');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** The hidden audio window, enough of it for the manager: `play-audio`/`close` in, reports out. */
class FakeAudioWindow {
  readonly sent: MediaCommand[] = [];
  private report: ((event: MediaWindowEvent) => void) | undefined;
  async whenReady(): Promise<void> {}
  send(command: MediaCommand): void {
    this.sent.push(command);
  }
  onReport(listener: (event: MediaWindowEvent) => void): void {
    this.report = listener;
  }
  onClosed(): void {}
  isDestroyed(): boolean {
    return false;
  }
  end(id: string): void {
    this.report?.({ type: 'ended', id });
  }
}

function make(monitors: MonitorInfo[] = [MONITOR], media?: Partial<MediaConcurrencySettings>) {
  const specs: OverlaySpec[] = [];
  const handles: FakeHandle[] = [];
  const backend: DisplayBackend = {
    name: 'fake',
    info: () => ({ name: 'fake', platform: 'linux', windowSystem: 'x11', supports: { layers: ['top', 'bottom'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }),
    monitors: async () => monitors,
    createOverlay: async (spec) => {
      specs.push(spec);
      const h = new FakeHandle(spec.id);
      handles.push(h);
      return h;
    },
    closeAll: async () => undefined,
    dispose: async () => undefined,
  };
  const events: HostEvent[] = [];
  const pack = { root, manifest: { id: 'com.x.p', mediaRoot: 'media' }, assets: [] } as unknown as LoadedPack;
  const audio = new FakeAudioWindow();
  const manager = new MediaManager({
    backend: () => backend,
    audioWindow: () => audio as unknown as OverlayWindowLike,
    packs: { getLoaded: () => pack },
    settings: async () => ({ mediaAlwaysOnTop: true, ...(media ? { media } : {}) }) as AppSettings,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    emit: (e) => events.push(e),
  });
  return { media: manager, specs, handles, events, audio };
}

/** Let the admission chain and the fire-and-forget queue pump settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'c', sessionId: 's', packRoot: '', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const summary = (e: HostEvent) => [e.name, (e.data as { mediaId: string }).mediaId, (e.data as { reason?: string }).reason];

describe('MediaManager host events', () => {
  it('reports media-clicked and media-closed (with the page reason) for a shown image, keeping closeOnClick for the page', async () => {
    const { media, specs, handles, events } = make();
    const h = await media.show('image', ctx, 'media/a.png', { closeOnClick: false, width: 100 });
    expect(specs[0]?.page).toEqual({ closeOnClick: false });
    handles[0]!.events.emit('clicked');
    handles[0]!.events.emit('clicked');
    expect(events.map(summary)).toEqual([
      ['media-clicked', h.id, undefined],
      ['media-clicked', h.id, undefined],
    ]);
    expect(events[0]?.data).toEqual({ mediaId: h.id, asset: 'media/a.png', packId: 'com.x.p', kind: 'image', characterRef: 'com.x.p/c' });
    handles[0]!.events.emit('closed', { reason: 'click' });
    expect(events.map(summary).at(-1)).toEqual(['media-closed', h.id, 'click']);
    expect(media.list()).toEqual([]);
    // a duplicate close report is harmless and reports nothing twice
    handles[0]!.events.emit('closed', { reason: 'click' });
    await media.close(h.id);
    expect(events).toHaveLength(3);
  });

  it('reports api for its own closes, timeout for the image timer, ended for a finished video and error for failures', async () => {
    const { media, handles, events } = make();
    const api = await media.show('image', ctx, 'media/a.png', {});
    await media.close(api.id);
    expect(handles[0]!.closed).toBe(true);
    const timed = await media.show('image', ctx, 'media/a.png', { durationMs: 5 });
    await new Promise((r) => setTimeout(r, 300)); // the manager's own timer fires 250 ms after durationMs
    const video = await media.show('video', ctx, 'media/v.webm', {});
    handles[2]!.events.emit('ended');
    await new Promise((r) => setTimeout(r, 0));
    const broken = await media.show('image', ctx, 'media/a.png', {});
    handles[3]!.events.emit('error', 'boom');
    await new Promise((r) => setTimeout(r, 0));
    expect(events.map(summary)).toEqual([
      ['media-closed', api.id, 'api'],
      ['media-closed', timed.id, 'timeout'],
      ['media-closed', video.id, 'ended'],
      ['media-closed', broken.id, 'error'],
    ]);
    expect(media.list()).toEqual([]);
  });

  it('closeAll reports api for every item of the character', async () => {
    const { media, events } = make();
    const a = await media.show('image', ctx, 'media/a.png', {});
    const b = await media.show('image', ctx, 'media/a.png', {});
    await media.closeAll('com.x.p/c');
    expect(events.map(summary)).toEqual([
      ['media-closed', a.id, 'api'],
      ['media-closed', b.id, 'api'],
    ]);
  });
});

describe('MediaManager.overlay', () => {
  it('covers every screen with one item: click-through, overlay layer, one handle for all of them', async () => {
    const { media, specs, handles, events } = make([MONITOR, SECOND]);
    const h = await media.overlay(ctx, 'media/a.png', { opacity: 0.4 });
    expect(specs.map((s) => [s.kind, s.options.monitor.id, s.options.width, s.options.height])).toEqual([
      ['fullscreen', 'm0', 1920, 1080],
      ['fullscreen', 'm1', 1280, 1024],
    ]);
    expect(specs.every((s) => s.options.clickThrough && s.options.layer === 'overlay' && s.options.opacity === 0.4)).toBe(true);
    expect(specs.map((s) => s.fullscreen)).toEqual([
      { media: 'image', opacity: 0.4 },
      { media: 'image', opacity: 0.4 },
    ]);
    // One item, whatever the screen count; closing it takes every screen down and reports once.
    expect(media.list()).toEqual([h]);
    await media.close(h.id);
    expect(handles.map((x) => x.closed)).toEqual([true, true]);
    expect(events.map(summary)).toEqual([['media-closed', h.id, 'api']]);
  });

  it('defaults a video to volume 0.5 and plays the sound on one screen only', async () => {
    const { media, specs } = make([SECOND, MONITOR]); // the cursor is on MONITOR
    await media.overlay(ctx, 'media/v.webm', {});
    expect(specs.map((s) => s.options.monitor.id)).toEqual(['m0', 'm1']);
    expect(specs.map((s) => s.fullscreen)).toEqual([
      { media: 'video', opacity: 0.25, volume: 0.5, loop: false, muted: false },
      { media: 'video', opacity: 0.25, volume: 0, loop: false, muted: true },
    ]);
  });

  it('takes one screen when asked, and loops a timed video for its duration', async () => {
    const { media, specs, events } = make([MONITOR, SECOND]);
    const h = await media.overlay(ctx, 'media/v.webm', { monitor: 'Side', durationMs: 20, volume: 2, opacity: 0.9 });
    expect(specs.map((s) => s.options.monitor.id)).toEqual(['m1']);
    expect(specs[0]?.fullscreen).toEqual({ media: 'video', opacity: 0.9, volume: 1, loop: true, muted: false });
    await new Promise((r) => setTimeout(r, 60));
    expect(events.map(summary)).toEqual([['media-closed', h.id, 'timeout']]);
  });

  it('closes every screen when one of them goes away, and ends with the video', async () => {
    const { media, handles, events } = make([MONITOR, SECOND]);
    const gone = await media.overlay(ctx, 'media/a.png', {});
    handles[1]!.events.emit('closed', { reason: 'api' });
    await new Promise((r) => setTimeout(r, 0));
    expect(handles[0]!.closed).toBe(true);
    const video = await media.overlay(ctx, 'media/v.webm', {});
    handles[2]!.events.emit('ended');
    await new Promise((r) => setTimeout(r, 0));
    expect(events.map(summary)).toEqual([
      ['media-closed', gone.id, 'api'],
      ['media-closed', video.id, 'ended'],
    ]);
    expect(media.list()).toEqual([]);
  });

  it('only fades on update: the overlay keeps its screens, its size and its click-through', async () => {
    const { media, handles } = make([MONITOR, SECOND]);
    const h = await media.overlay(ctx, 'media/a.png', {});
    await media.update(h.id, { opacity: 0.1, width: 100, monitor: 'primary', clickThrough: false });
    expect(handles.map((x) => x.updates)).toEqual([[{ opacity: 0.1 }], [{ opacity: 0.1 }]]);
  });

  it('refuses an asset that is neither image nor video', async () => {
    const { media } = make();
    await expect(media.overlay(ctx, 'media/song.mp3', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('mediaLimits', () => {
  it('defaults to no cap, and keeps only non-negative whole numbers', () => {
    expect(mediaLimits(undefined)).toEqual({ maxConcurrent: { image: 0, video: 0, audio: 0 }, maxQueued: { image: 8, video: 8, audio: 8 } });
    expect(mediaLimits({ maxConcurrent: { image: 2.4, video: -1, audio: Number.NaN } as never, maxQueued: { video: 0 } as never })).toEqual({
      maxConcurrent: { image: 2, video: 0, audio: 0 },
      maxQueued: { image: 8, video: 0, audio: 8 },
    });
  });
});

describe('MediaManager media limits', () => {
  it('starts what fits, queues the rest per kind, and hands the slot on as each one closes', async () => {
    const { media, handles, events } = make([MONITOR], { maxConcurrent: { image: 0, video: 1, audio: 0 } });
    // Three videos with room for one: all three calls return at once, only the first is playing.
    const [a, b, c] = await Promise.all([media.show('video', ctx, 'media/v.webm', {}), media.show('video', ctx, 'media/v.webm', {}), media.show('video', ctx, 'media/v.webm', {})]);
    expect([a?.state, b?.state, c?.state]).toEqual(['open', 'queued', 'queued']);
    expect(handles).toHaveLength(1);
    expect(media.list().map((h) => h.state)).toEqual(['open', 'queued', 'queued']);
    // An image is a different kind and is not held up by the videos.
    const pic = await media.show('image', ctx, 'media/a.png', {});
    expect(pic.state).toBe('open');

    handles[0]!.events.emit('ended'); // closeOnEnd → the first video goes, the second takes its place
    await settle();
    expect(handles).toHaveLength(3); // video a, the image, video b
    expect(events.map(summary)).toEqual([
      ['media-closed', a!.id, 'ended'],
      ['media-started', b!.id, undefined],
    ]);
    handles[2]!.events.emit('ended');
    await settle();
    expect(events.map(summary).slice(2)).toEqual([
      ['media-closed', b!.id, 'ended'],
      ['media-started', c!.id, undefined],
    ]);
    expect(media.list().map((h) => h.state)).toEqual(['open', 'open']); // the image and video c
  });

  it('refuses only when the queue is full too, and names both numbers', async () => {
    const { media } = make([MONITOR], { maxConcurrent: { image: 1, video: 0, audio: 0 }, maxQueued: { image: 1, video: 8, audio: 8 } });
    await media.show('image', ctx, 'media/a.png', {});
    await media.show('image', ctx, 'media/a.png', {}); // the one queue slot
    await expect(media.show('image', ctx, 'media/a.png', {})).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', details: { kind: 'image', maxConcurrent: 1, maxQueued: 1 } });
  });

  it('closes a queued item out of the queue without ever showing it, and update changes how it opens', async () => {
    const { media, specs, events } = make([MONITOR], { maxConcurrent: { image: 1, video: 0, audio: 0 } });
    const open = await media.show('image', ctx, 'media/a.png', {});
    const waiting = await media.show('image', ctx, 'media/a.png', { opacity: 1 });
    const dropped = await media.show('image', ctx, 'media/a.png', {});
    await media.update(waiting.id, { opacity: 0.2 });
    await media.close(dropped.id);
    expect(events.map(summary)).toEqual([['media-closed', dropped.id, 'api']]);
    expect(specs).toHaveLength(1); // nothing was ever put on screen for either queued item

    await media.close(open.id);
    await settle();
    expect(specs).toHaveLength(2);
    expect(specs[1]?.options.opacity).toBe(0.2); // the patch it was given while it waited
    expect(events.map(summary).slice(1)).toEqual([
      ['media-closed', open.id, 'api'],
      ['media-started', waiting.id, undefined],
    ]);
  });

  it('closeAll empties the queue as well as the screen', async () => {
    const { media, events } = make([MONITOR], { maxConcurrent: { image: 1, video: 0, audio: 0 } });
    const open = await media.show('image', ctx, 'media/a.png', {});
    const waiting = await media.show('image', ctx, 'media/a.png', {});
    await media.closeAll('com.x.p/c');
    await settle();
    expect(events.map(summary)).toEqual([
      ['media-closed', waiting.id, 'api'],
      ['media-closed', open.id, 'api'],
    ]);
    expect(media.list()).toEqual([]);
  });

  it('counts a full-screen overlay as its own kind, and queues audio behind audio', async () => {
    const { media, specs, audio, events } = make([MONITOR, SECOND], { maxConcurrent: { image: 1, video: 0, audio: 1 } });
    const wash = await media.overlay(ctx, 'media/a.png', {}); // one item, two screens, one image slot
    expect(wash.state).toBe('open');
    expect(specs).toHaveLength(2);
    expect((await media.show('image', ctx, 'media/a.png', {})).state).toBe('queued');

    const song = await media.playAudio(ctx, 'media/song.mp3', { volume: 0.5 });
    const next = await media.playAudio(ctx, 'media/song.mp3', {});
    expect([song.state, next.state]).toEqual(['open', 'queued']);
    expect(audio.sent).toHaveLength(1);
    audio.end(song.id);
    await settle();
    expect(audio.sent.map((c) => c.type)).toEqual(['play-audio', 'play-audio']);
    expect(events.map(summary)).toEqual([
      ['media-closed', song.id, 'ended'],
      ['media-started', next.id, undefined],
    ]);
  });
});
