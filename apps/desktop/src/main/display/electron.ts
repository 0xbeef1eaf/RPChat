/** Generic `electron` display backend (docs/spec/overlay.md §1.1). */
import type { DisplayBackendInfo, MonitorInfo, OverlayLayer, OverlayUpdate } from '@rp/shared';
import type { DisplayBackend, OverlayWindowLike, ResolvedOverlayOptions } from './backend.js';
import type { WindowSystem } from './layers.js';
import { clampOpacity, isOverlayLayer, nearestLayer } from './layers.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of Electron's `Display` the backend reads. */
export interface DisplayLike {
  id: number;
  label?: string;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

/** The subset of Electron's `screen` module the backend needs (injected so tests need no Electron). */
export interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getPrimaryDisplay(): DisplayLike;
  getCursorScreenPoint(): { x: number; y: number };
}

export interface ElectronBackendOptions {
  platform: NodeJS.Platform;
  windowSystem: WindowSystem;
  logger?: Pick<Console, 'info' | 'warn' | 'debug'>;
}

function inside(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

export function monitorsFromScreen(screen: ScreenLike): MonitorInfo[] {
  const displays = screen.getAllDisplays();
  const primaryId = safe(() => screen.getPrimaryDisplay().id, displays[0]?.id);
  const cursor = safe(() => screen.getCursorScreenPoint(), undefined);
  let cursorAssigned = false;
  return displays.map((d, index) => {
    const hasCursor = !cursorAssigned && cursor !== undefined && inside(d.bounds, cursor);
    if (hasCursor) cursorAssigned = true;
    return {
      id: String(d.id),
      name: d.label && d.label.trim().length > 0 ? d.label : `Display ${index + 1}`,
      index,
      primary: d.id === primaryId,
      x: d.workArea.x,
      y: d.workArea.y,
      width: d.workArea.width,
      height: d.workArea.height,
      scale: d.scaleFactor || 1,
      hasCursor,
    };
  });
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Drives overlays with plain BrowserWindow calls. Layers map to
 * `setAlwaysOnTop`, click-through to `setIgnoreMouseEvents`; opacity via
 * `setOpacity` where Electron supports it (Windows/macOS) — the media window
 * always applies CSS opacity as well.
 */
export class ElectronBackend implements DisplayBackend {
  private readonly platform: NodeJS.Platform;
  private readonly windowSystem: WindowSystem;
  private readonly logger: ElectronBackendOptions['logger'];

  constructor(
    private readonly screen: ScreenLike,
    opts: ElectronBackendOptions,
  ) {
    this.platform = opts.platform;
    this.windowSystem = opts.windowSystem;
    this.logger = opts.logger;
  }

  info(): DisplayBackendInfo {
    const wayland = this.windowSystem === 'wayland';
    const layers: OverlayLayer[] = wayland ? ['top', 'overlay'] : ['bottom', 'top', 'overlay'];
    return {
      name: 'electron',
      platform: this.platform,
      windowSystem: this.windowSystem,
      supports: {
        layers,
        opacity: this.platform === 'win32' || this.platform === 'darwin',
        clickThrough: true,
        monitorSelection: !wayland,
        exactPosition: !wayland,
      },
    };
  }

  async monitors(): Promise<MonitorInfo[]> {
    return monitorsFromScreen(this.screen);
  }

  async apply(win: OverlayWindowLike, opts: ResolvedOverlayOptions): Promise<void> {
    if (win.isDestroyed()) return;
    const info = this.info();
    if (info.supports.exactPosition) win.setBounds(opts.bounds);
    else {
      const current = win.getBounds();
      win.setBounds({ x: current.x, y: current.y, width: opts.bounds.width, height: opts.bounds.height });
    }
    this.applyLayer(win, nearestLayer(opts.layer, info.supports.layers));
    this.applyClickThrough(win, opts.clickThrough);
    this.applyOpacity(win, opts.opacity);
  }

  async update(win: OverlayWindowLike, patch: OverlayUpdate): Promise<void> {
    if (win.isDestroyed()) return;
    const info = this.info();
    if (patch.layer !== undefined && isOverlayLayer(patch.layer)) this.applyLayer(win, nearestLayer(patch.layer, info.supports.layers));
    if (patch.clickThrough !== undefined) this.applyClickThrough(win, Boolean(patch.clickThrough));
    if (patch.opacity !== undefined) this.applyOpacity(win, clampOpacity(patch.opacity));
    if (patch.width !== undefined || patch.height !== undefined) {
      const b = win.getBounds();
      win.setBounds({
        x: b.x,
        y: b.y,
        width: typeof patch.width === 'number' && patch.width > 0 ? Math.round(patch.width) : b.width,
        height: typeof patch.height === 'number' && patch.height > 0 ? Math.round(patch.height) : b.height,
      });
    }
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }

  private applyLayer(win: OverlayWindowLike, layer: OverlayLayer): void {
    if (layer === 'top' || layer === 'overlay') {
      const level = this.platform === 'darwin' ? (layer === 'top' ? 'floating' : 'screen-saver') : 'screen-saver';
      win.setAlwaysOnTop(true, level);
      return;
    }
    win.setAlwaysOnTop(false);
    // Best effort "lower" on Windows/X11: never focused, pushed back by blurring.
    win.setFocusable(false);
    try {
      win.blur();
    } catch (err) {
      this.logger?.debug?.('[display:electron] blur failed', err);
    }
  }

  private applyClickThrough(win: OverlayWindowLike, clickThrough: boolean): void {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.setFocusable(false);
  }

  private applyOpacity(win: OverlayWindowLike, opacity: number): void {
    if (!this.info().supports.opacity) return;
    try {
      win.setOpacity(clampOpacity(opacity));
    } catch (err) {
      this.logger?.debug?.('[display:electron] setOpacity failed', err);
    }
  }
}
