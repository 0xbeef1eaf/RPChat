import { describe, expect, it } from 'vitest';
import type { OverlaySpec } from './backend.js';
import { resolveOverlayOptions } from './backend.js';
import { ElectronBackend, monitorsFromScreen } from './electron.js';
import { FakeOverlayWindow, fakeScreen } from './test-fakes.js';

function spec(id: string, options: OverlaySpec['options'], kind: 'image' | 'video' = 'image'): OverlaySpec {
  return { id, kind, file: '/p/a.png', assetUrl: 'rp-asset://com.x.p/media/a.png', packId: 'com.x.p', asset: 'media/a.png', options, page: { caption: 'hi' } };
}

function make(platform: NodeJS.Platform = 'linux', windowSystem: 'x11' | 'wayland' | 'native' = 'x11') {
  const windows: FakeOverlayWindow[] = [];
  const backend = new ElectronBackend({
    screen: fakeScreen(),
    createWindow: (title) => {
      const w = new FakeOverlayWindow(title);
      w.autoContentSize = { width: 400, height: 250 };
      windows.push(w);
      return w;
    },
    platform,
    windowSystem,
    contentSizeTimeoutMs: 50,
  });
  return { backend, windows };
}

describe('monitorsFromScreen', () => {
  it('maps displays to MonitorInfo with work areas, labels and the cursor', () => {
    const list = monitorsFromScreen(fakeScreen());
    expect(list[0]).toEqual({ id: '11', name: 'Main', index: 0, primary: true, x: 0, y: 30, width: 1920, height: 1050, scale: 1, hasCursor: false });
    expect(list[1]).toMatchObject({ id: '12', name: 'Display 2', primary: false, hasCursor: true, scale: 1.5 });
  });
});

describe('ElectronBackend', () => {
  it('shows an overlay sized by the reported content, anchored bottom-right, on top and click-through', async () => {
    const { backend, windows } = make();
    const monitors = await backend.monitors();
    const handle = await backend.createOverlay(spec('a', resolveOverlayOptions({ monitor: 'primary', position: 'bottom-right', clickThrough: true, opacity: 0.5 }, monitors, { layer: 'top' })));
    const win = windows[0]!;
    expect(win.title).toMatch(/^rp-overlay:a-\d+$/);
    expect(win.sent[0]).toMatchObject({ type: 'show-image', id: 'a', url: 'rp-asset://com.x.p/media/a.png', options: { caption: 'hi', opacity: 0.5, clickThrough: true, width: 480 } });
    // 400×250 content + 24px page padding → 424×274 window, anchored with the 24px margin.
    expect(win.bounds).toEqual({ x: 1920 - 424 - 24, y: 30 + 1050 - 274 - 24, width: 424, height: 274 });
    expect(win.shown).toBe(true);
    expect(win.alwaysOnTop).toEqual({ flag: true, level: 'screen-saver' });
    expect(win.ignoreMouse).toBe(true);
    expect(win.focusable).toBe(false);
    expect(win.opacity).toBeUndefined(); // setOpacity is a no-op on Linux
    const closed: unknown[] = [];
    handle.on('closed', () => closed.push(1));
    await handle.close();
    expect(win.destroyed).toBe(true);
    expect(closed).toHaveLength(1);
  });

  it('degrades layers, keeps size-only updates on Wayland and forwards visual patches to the page', async () => {
    const { backend, windows } = make('linux', 'wayland');
    expect(backend.info().supports).toMatchObject({ layers: ['top', 'overlay'], exactPosition: false, monitorSelection: false });
    const monitors = await backend.monitors();
    const handle = await backend.createOverlay(spec('b', resolveOverlayOptions({ layer: 'background', x: 100, y: 100 }, monitors, { layer: 'top' })));
    const win = windows[0]!;
    expect(win.alwaysOnTop?.flag).toBe(true); // background → nearest supported = top
    expect(win.bounds.x).toBe(0); // position ignored on Wayland, size applied
    expect(win.bounds.width).toBe(424);
    await handle.update({ opacity: 0.3, width: 300 });
    expect(win.sent.at(-1)).toEqual({ type: 'update', id: 'b', options: { opacity: 0.3, width: 300 } });
    expect(win.bounds.width).toBe(300);
  });

  it('uses macOS levels, real opacity, and emits ended/closed from page reports', async () => {
    const { backend, windows } = make('darwin', 'native');
    const monitors = await backend.monitors();
    const handle = await backend.createOverlay(spec('c', resolveOverlayOptions({ layer: 'top', opacity: 0.8 }, monitors, { layer: 'top' }), 'video'));
    const win = windows[0]!;
    expect(win.alwaysOnTop).toEqual({ flag: true, level: 'floating' });
    expect(win.opacity).toBe(0.8);
    const events: string[] = [];
    handle.on('ended', () => events.push('ended'));
    handle.on('closed', () => events.push('closed'));
    win.report({ type: 'ended', id: 'c' });
    win.report({ type: 'closed', id: 'c' });
    win.report({ type: 'closed', id: 'c' }); // duplicate is harmless
    expect(events).toEqual(['ended', 'closed']);
    expect(win.destroyed).toBe(true);
    await backend.closeAll();
  });
});
