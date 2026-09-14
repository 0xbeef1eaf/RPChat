/**
 * Generic `electron` display backend (docs/spec/overlay.md §1.1): one
 * transparent, frameless BrowserWindow (hosting media.html) per overlay.
 * Layers map to `setAlwaysOnTop`, click-through to `setIgnoreMouseEvents`,
 * opacity to `setOpacity` where Electron supports it (Windows/macOS) — the
 * media page always applies CSS opacity as well.
 */
import type { AvatarState, DisplayBackendInfo, MediaCloseReason, MediaCommand, MediaWindowEvent, MonitorInfo, OverlayLayer, OverlayUpdate, WidgetSpec } from '@rp/shared';
import type {
  BackendLogger,
  DisplayBackend,
  OverlayClosedDetail,
  OverlayEvent,
  OverlayEventListener,
  OverlayHandle,
  OverlaySpec,
  OverlayWindowLike,
  ResolvedOverlayOptions,
} from './backend.js';
import { applyOverlayUpdate, visualPatch } from './backend.js';
import type { WindowSystem } from './layers.js';
import { OVERLAY_TITLE_PREFIX, clampOpacity, nearestLayer } from './layers.js';
import type { Bounds, Size } from './placement.js';
import { DEFAULT_OVERLAY_HEIGHT, placeOverlay, sameBounds } from './placement.js';

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
  screen: ScreenLike;
  createWindow(title: string): OverlayWindowLike;
  platform: NodeJS.Platform;
  windowSystem: WindowSystem;
  logger?: BackendLogger;
  /** How long to wait for the page's first `content-size` before placing with the default height. */
  contentSizeTimeoutMs?: number;
}

export { OVERLAY_TITLE_PREFIX };
/** media.html pads the stage by 12px on every side. */
export const PAGE_PADDING_PX = 24;

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

/** Tiny per-overlay event emitter. */
export class OverlayEvents {
  private readonly listeners = new Map<OverlayEvent, Set<OverlayEventListener>>();

  on(event: OverlayEvent, listener: OverlayEventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  emit(event: OverlayEvent, detail?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(detail);
      } catch {
        /* listener errors never break the backend */
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** The command that shows `spec` in a media page (`url` is the asset URL as the page can load it). */
export function showCommand(spec: OverlaySpec, url: string): MediaCommand {
  const overlay = {
    opacity: spec.options.opacity,
    clickThrough: spec.options.clickThrough,
    width: spec.options.width,
    // The page treats `height` as a cap (max-height); a random box passes its height that way.
    ...(spec.options.height !== undefined ? { height: spec.options.height } : spec.options.maxHeight !== undefined ? { height: spec.options.maxHeight } : {}),
    layer: spec.options.layer,
  };
  switch (spec.kind) {
    case 'video':
      return { type: 'play-video', id: spec.id, url, options: { ...spec.page, ...overlay } };
    case 'avatar': {
      const state: AvatarState = spec.avatar ?? {
        visible: true,
        expression: 'neutral',
        imageUrl: url,
        size: spec.options.width,
        lookAtCursor: false,
        overlay: { layer: spec.options.layer, opacity: spec.options.opacity, clickThrough: spec.options.clickThrough },
      };
      return { type: 'avatar-show', id: spec.id, state: { ...state, imageUrl: url, overlay: { ...state.overlay, layer: spec.options.layer, opacity: spec.options.opacity, clickThrough: spec.options.clickThrough } } };
    }
    case 'widget': {
      const widget: WidgetSpec = spec.widget ?? { id: spec.id, html: '', width: spec.options.width, height: spec.options.height ?? 240 };
      return { type: 'widget-show', id: spec.id, widget, options: { ...overlay } };
    }
    case 'draw':
      return { type: 'draw-set', id: spec.id, shapes: [] };
    default:
      return { type: 'show-image', id: spec.id, url, options: { ...spec.page, ...overlay } };
  }
}

/** One overlay window driven by the electron backend. */
export class ElectronOverlay implements OverlayHandle {
  readonly id: string;
  readonly events = new OverlayEvents();
  options: ResolvedOverlayOptions;
  contentSize: Size | undefined;
  lastBounds: Bounds | undefined;
  closed = false;
  private readonly disposers: Array<() => void> = [];
  private sizeWaiters: Array<() => void> = [];

  constructor(
    readonly spec: OverlaySpec,
    readonly win: OverlayWindowLike,
    private readonly backend: ElectronBackend,
  ) {
    this.id = spec.id;
    this.options = spec.options;
    this.disposers.push(
      win.onReport((event) => this.onReport(event)),
      win.onClosed(() => this.finish()),
    );
  }

  private onReport(event: MediaWindowEvent): void {
    if (event.id !== this.id) return;
    switch (event.type) {
      case 'content-size': {
        const size = { width: Math.max(1, Math.ceil(event.width)) + PAGE_PADDING_PX, height: Math.max(1, Math.ceil(event.height)) + PAGE_PADDING_PX };
        const changed = !this.contentSize || this.contentSize.width !== size.width || this.contentSize.height !== size.height;
        this.contentSize = size;
        const waiters = this.sizeWaiters;
        this.sizeWaiters = [];
        for (const w of waiters) w();
        this.events.emit('content-size', { width: event.width, height: event.height });
        if (changed && waiters.length === 0 && !this.closed) {
          void this.backend.place(this).catch((err) => this.backend.log.warn?.('[display:electron] re-place failed', err));
        }
        return;
      }
      case 'ended':
        this.events.emit('ended');
        return;
      case 'error':
        this.events.emit('error', event.message);
        return;
      case 'closed':
        this.finish(event.reason ?? 'api');
        return;
      case 'clicked':
        this.events.emit('clicked');
        return;
      case 'avatar-clicked':
        this.events.emit('avatar-clicked');
        return;
      case 'widget-message':
        this.events.emit('widget-message', event.message);
        return;
      default:
        return;
    }
  }

  async send(command: MediaCommand): Promise<void> {
    if (this.closed || this.win.isDestroyed()) return;
    this.win.send(command);
  }

  /** Wait for the first `content-size` (or the timeout). */
  waitForContentSize(timeoutMs: number): Promise<void> {
    if (this.contentSize) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sizeWaiters = this.sizeWaiters.filter((w) => w !== done);
        resolve();
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.sizeWaiters.push(done);
    });
  }

  /**
   * Size the window should have right now (`width` is a maximum: narrower content shrinks the window).
   * Before the first `content-size` a random box opens at its full height so the page can lay the
   * content out unsqueezed; the window then shrinks to what was rendered.
   */
  desiredSize(): Size {
    const width = this.contentSize ? Math.min(this.options.width, this.contentSize.width) : this.options.width;
    const height = this.options.height ?? this.contentSize?.height ?? (this.options.maxHeight !== undefined ? this.options.maxHeight + PAGE_PADDING_PX : DEFAULT_OVERLAY_HEIGHT);
    return { width, height };
  }

  async update(patch: OverlayUpdate): Promise<void> {
    if (this.closed) return;
    const monitors = await this.backend.monitors();
    this.options = applyOverlayUpdate(this.options, patch, monitors);
    const visual = visualPatch(patch);
    if (Object.keys(visual).length > 0 && !this.win.isDestroyed()) this.win.send({ type: 'update', id: this.id, options: visual });
    await this.backend.place(this);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.win.isDestroyed()) this.win.send({ type: 'close', id: this.id });
    this.finish();
  }

  on(event: OverlayEvent, listener: OverlayEventListener): () => void {
    return this.events.on(event, listener);
  }

  /** Idempotent teardown: destroy the window, emit `closed` once (detail `{ reason }`). */
  finish(reason: MediaCloseReason = 'api'): void {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.disposers.splice(0)) d();
    for (const w of this.sizeWaiters.splice(0)) w();
    this.backend.forget(this);
    if (!this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch {
        /* already gone */
      }
    }
    const detail: OverlayClosedDetail = { reason };
    this.events.emit('closed', detail);
    this.events.clear();
  }
}

export class ElectronBackend implements DisplayBackend {
  readonly name: string = 'electron';
  readonly log: BackendLogger;
  protected readonly overlays = new Map<string, ElectronOverlay>();
  protected readonly platform: NodeJS.Platform;
  protected readonly windowSystem: WindowSystem;
  private readonly screen: ScreenLike;
  private readonly createWindow: (title: string) => OverlayWindowLike;
  private readonly contentSizeTimeoutMs: number;
  private counter = 0;

  constructor(opts: ElectronBackendOptions) {
    this.screen = opts.screen;
    this.createWindow = opts.createWindow;
    this.platform = opts.platform;
    this.windowSystem = opts.windowSystem;
    this.log = opts.logger ?? { info: () => undefined, warn: () => undefined, debug: () => undefined };
    this.contentSizeTimeoutMs = opts.contentSizeTimeoutMs ?? 2500;
  }

  info(): DisplayBackendInfo {
    const wayland = this.windowSystem === 'wayland';
    const layers: OverlayLayer[] = wayland ? ['top', 'overlay'] : ['bottom', 'top', 'overlay'];
    return {
      name: this.name,
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

  async createOverlay(spec: OverlaySpec): Promise<OverlayHandle> {
    const title = `${OVERLAY_TITLE_PREFIX}${spec.id}-${++this.counter}`;
    const win = this.createWindow(title);
    const overlay = new ElectronOverlay(spec, win, this);
    this.overlays.set(spec.id, overlay);
    try {
      await win.whenReady();
      if (overlay.closed) return overlay;
      const initial = placeOverlay(spec.options, overlay.desiredSize());
      if (this.info().supports.exactPosition) win.setBounds(initial);
      else win.setBounds({ ...win.getBounds(), width: initial.width, height: initial.height });
      overlay.lastBounds = initial;
      win.send(showCommand(spec, spec.assetUrl));
      if (spec.options.height === undefined) await overlay.waitForContentSize(this.contentSizeTimeoutMs);
      if (overlay.closed) return overlay;
      await this.place(overlay, true);
    } catch (err) {
      overlay.finish();
      throw err;
    }
    return overlay;
  }

  /** (Re)compute bounds from the current options + content size, then apply everything to the window. */
  async place(overlay: ElectronOverlay, first = false): Promise<void> {
    if (overlay.closed || overlay.win.isDestroyed()) return;
    const bounds = placeOverlay(overlay.options, overlay.desiredSize());
    const moved = !sameBounds(overlay.lastBounds, bounds);
    overlay.lastBounds = bounds;
    await this.applyWindow(overlay, bounds, first || moved);
  }

  /** Apply bounds/layer/click-through/opacity. Subclasses (hyprland-ipc) extend this. */
  protected async applyWindow(overlay: ElectronOverlay, bounds: Bounds, boundsChanged: boolean): Promise<void> {
    const { win, options } = overlay;
    if (win.isDestroyed()) return;
    const info = this.info();
    if (boundsChanged) {
      if (info.supports.exactPosition) win.setBounds(bounds);
      else {
        const current = win.getBounds();
        win.setBounds({ x: current.x, y: current.y, width: bounds.width, height: bounds.height });
      }
    }
    this.applyLayer(win, nearestLayer(options.layer, info.supports.layers));
    this.applyClickThrough(win, options.clickThrough);
    this.applyOpacity(win, options.opacity);
    win.show();
    this.log.debug?.(`[display:${this.name}] ${overlay.id} → ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y} on ${options.monitor.name} (${options.layer}, opacity ${options.opacity}${options.clickThrough ? ', click-through' : ''})`);
  }

  forget(overlay: ElectronOverlay): void {
    if (this.overlays.get(overlay.id) === overlay) this.overlays.delete(overlay.id);
  }

  async closeAll(): Promise<void> {
    for (const overlay of [...this.overlays.values()]) await overlay.close();
  }

  async dispose(): Promise<void> {
    await this.closeAll();
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
      this.log.debug?.('[display:electron] blur failed', err);
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
      this.log.debug?.('[display:electron] setOpacity failed', err);
    }
  }
}
