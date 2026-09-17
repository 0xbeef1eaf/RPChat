import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext, AppSettings, HostEvent, LoadedPack, MediaCommand, MonitorInfo, OverlayUpdate } from '@rp/shared';
import type { DisplayBackend, OverlayEvent, OverlayHandle, OverlaySpec } from '../display/backend.js';
import { MediaManager } from './media.js';

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

function make(monitors: MonitorInfo[] = [MONITOR]) {
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
  const media = new MediaManager({
    backend: () => backend,
    audioWindow: () => {
      throw new Error('no audio in this test');
    },
    packs: { getLoaded: () => pack },
    settings: async () => ({ mediaAlwaysOnTop: true }) as AppSettings,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    emit: (e) => events.push(e),
  });
  return { media, specs, handles, events };
}

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
