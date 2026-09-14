import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext, AppSettings, HostEvent, LoadedPack, MediaCommand, MonitorInfo } from '@rp/shared';
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

class FakeHandle implements OverlayHandle {
  readonly events = new OverlayEvents();
  closed = false;
  constructor(readonly id: string) {}
  async update(): Promise<void> {}
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

function make() {
  const specs: OverlaySpec[] = [];
  const handles: FakeHandle[] = [];
  const backend: DisplayBackend = {
    name: 'fake',
    info: () => ({ name: 'fake', platform: 'linux', windowSystem: 'x11', supports: { layers: ['top', 'bottom'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }),
    monitors: async () => [MONITOR],
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
