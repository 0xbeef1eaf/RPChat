import { describe, expect, it } from 'vitest';
import type { ActionContext, LoadedPack, MediaCommand, MonitorInfo } from '@rp/shared';
import type { DisplayBackend, OverlayHandle, OverlaySpec } from '../display/backend.js';
import { WidgetsHandler, substituteAssetPlaceholders } from './widgets.js';

const MONITOR: MonitorInfo = { id: 'm0', name: 'Main', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true };

class FakeHandle implements OverlayHandle {
  readonly sent: MediaCommand[] = [];
  closed = false;
  constructor(readonly id: string) {}
  async update(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(command: MediaCommand): Promise<void> {
    this.sent.push(command);
  }
  on(): () => void {
    return () => undefined;
  }
}

function fakeBackend(pageAssetUrl?: (url: string) => string): DisplayBackend & { specs: OverlaySpec[]; handles: FakeHandle[] } {
  const specs: OverlaySpec[] = [];
  const handles: FakeHandle[] = [];
  return {
    name: 'fake',
    specs,
    handles,
    info: () => ({ name: 'fake', platform: 'linux', windowSystem: 'x11', supports: { layers: ['top'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }),
    monitors: async () => [MONITOR],
    createOverlay: async (spec) => {
      specs.push(spec);
      const h = new FakeHandle(spec.id);
      handles.push(h);
      return h;
    },
    closeAll: async () => undefined,
    dispose: async () => undefined,
    ...(pageAssetUrl ? { pageAssetUrl } : {}),
  };
}

const PACK = {
  root: '/nonexistent/packs/com.x.p',
  manifest: { id: 'com.x.p', mediaRoot: 'media' },
  assets: [
    { path: 'media/images/a.png', kind: 'image', mime: 'image/png', bytes: 10, tags: [] },
    { path: 'media/images/cards/b.png', kind: 'image', mime: 'image/png', bytes: 10, tags: ['card'] },
  ],
} as unknown as LoadedPack;

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'c', sessionId: 's', packRoot: PACK.root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };

function make(pageAssetUrl?: (url: string) => string) {
  const backend = fakeBackend(pageAssetUrl);
  const events: unknown[] = [];
  const handler = new WidgetsHandler({ backend: () => backend, emit: (e) => events.push(e), defaultLayer: async () => 'top', packs: { getLoaded: () => PACK } });
  return { backend, handler, events };
}

describe('substituteAssetPlaceholders', () => {
  it('replaces every placeholder, resolving each distinct path once, and leaves other braces alone', () => {
    const seen: string[] = [];
    const out = substituteAssetPlaceholders('<img src="{{asset:media/a.png}}"> {{ asset: media/b.png }} url({{asset:media/a.png}}) {{nope}} {x}', (p) => {
      seen.push(p);
      return `u:${p}`;
    });
    expect(out).toBe('<img src="u:media/a.png"> u:media/b.png url(u:media/a.png) {{nope}} {x}');
    expect(seen).toEqual(['media/a.png', 'media/b.png']);
  });

  it('propagates what the resolver throws', () => {
    expect(() =>
      substituteAssetPlaceholders('{{asset:media/x.png}}', (p) => {
        throw new Error(`bad ${p}`);
      }),
    ).toThrow('bad media/x.png');
  });
});

describe('WidgetsHandler asset placeholders', () => {
  it('shows widget HTML with rp-asset URLs for pack assets (media-root-relative paths too)', async () => {
    const { backend, handler } = make();
    const info = await handler.invoke('show', [{ id: 'game', html: '<img src="{{asset:media/images/a.png}}"><i style="background:url({{asset:images/cards/b.png}})">', width: 200, height: 100 }], ctx);
    expect(info).toEqual({ id: 'game' });
    expect(backend.specs[0]?.widget?.html).toBe('<img src="rp-asset://com.x.p/media/images/a.png"><i style="background:url(rp-asset://com.x.p/media/images/cards/b.png)">');
  });

  it('substitutes again on update and on re-show of the same id', async () => {
    const { backend, handler } = make();
    await handler.invoke('show', [{ id: 'game', html: '<p>one</p>' }], ctx);
    await handler.invoke('update', ['game', { html: '<img src="{{asset:media/images/a.png}}">', postMessage: { go: 1 } }], ctx);
    expect(backend.handles[0]?.sent.at(-1)).toMatchObject({ type: 'widget-update', html: '<img src="rp-asset://com.x.p/media/images/a.png">', postMessage: { go: 1 } });
    await handler.invoke('show', [{ id: 'game', html: '{{asset:media/images/cards/b.png}}' }], ctx);
    expect(backend.handles[0]?.sent.at(-1)).toMatchObject({ type: 'widget-update', html: 'rp-asset://com.x.p/media/images/cards/b.png' });
    expect(backend.handles).toHaveLength(1);
  });

  it('uses the backend page URL when the backend cannot load rp-asset:// (native helper views)', async () => {
    const { backend, handler } = make((url) => url.replace('rp-asset://', 'http://127.0.0.1:1/t/tok/asset/'));
    await handler.invoke('show', [{ id: 'w', html: '<img src="{{asset:media/images/a.png}}">' }], ctx);
    expect(backend.specs[0]?.widget?.html).toBe('<img src="http://127.0.0.1:1/t/tok/asset/com.x.p/media/images/a.png">');
  });

  it('rejects a placeholder that is not a pack asset, naming it, and shows nothing', async () => {
    const { backend, handler } = make();
    await expect(handler.invoke('show', [{ id: 'w', html: '<img src="{{asset:media/images/missing.png}}">' }], ctx)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('{{asset:media/images/missing.png}}'),
    });
    await expect(handler.invoke('show', [{ id: 'w', html: '{{asset:../../etc/passwd}}' }], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('{{asset:../../etc/passwd}}') });
    expect(backend.specs).toHaveLength(0);
    // a bad update leaves the widget as it was
    await handler.invoke('show', [{ id: 'w', html: '<p>fine</p>' }], ctx);
    await expect(handler.invoke('update', ['w', { html: '{{asset:nope.png}}' }], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(backend.handles[0]?.sent).toHaveLength(0);
    expect(await handler.invoke('list', [], ctx)).toEqual([{ id: 'w' }]);
  });
});
