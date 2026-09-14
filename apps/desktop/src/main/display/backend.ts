/**
 * Display backend abstraction (docs/spec/overlay.md §1): a backend OWNS overlay
 * lifecycle (`createOverlay` → `OverlayHandle`). This module has no Electron
 * dependency; the `electron` backend receives `screen` and a window factory
 * through `BackendContext`, so everything here is unit-testable in plain Node.
 */
import type {
  AppSettings,
  AvatarState,
  DisplayBackendInfo,
  MediaPosition,
  MediaWindowEvent,
  MonitorInfo,
  OverlayKind,
  OverlayLayer,
  OverlayOptions,
  OverlayUpdate,
  PlayVideoOptions,
  ShowImageOptions,
  MediaCommand,
  MediaCloseReason,
  WidgetSpec,
} from '@rp/shared';
import type { Bounds } from './placement.js';
import { DEFAULT_MARGIN_PX, DEFAULT_OVERLAY_WIDTH, randomSizeBox, randomSizeFraction, randomSource, selectMonitor } from './placement.js';
import type { ScreenLike } from './electron.js';
import { ElectronBackend } from './electron.js';
import { createHyprlandBackend } from './hyprland.js';
import type { HyprTransport } from './hyprland.js';
import type { HelperProcess } from './helper-process.js';
import type { LoopbackServerLike } from '../loopback.js';
import { detectWindowSystem, isHyprland, isOverlayLayer, clampOpacity } from './layers.js';

export type { WindowSystem } from './layers.js';
export { LAYER_ORDER, isOverlayLayer, nearestLayer, clampOpacity, isHyprland, detectWindowSystem } from './layers.js';

/** Overlay options after defaults + monitor resolution; `x`/`y` are logical px on the monitor. */
export interface ResolvedOverlayOptions {
  monitor: MonitorInfo;
  layer: OverlayLayer;
  opacity: number;
  clickThrough: boolean;
  anchor: MediaPosition;
  marginPx: number;
  x?: number;
  y?: number;
  width: number;
  height?: number;
  /**
   * Content height cap in logical px when the character gave no size and the overlay was drawn a
   * random box (`randomSize`): the page fits the media inside `width` × `maxHeight` keeping its aspect
   * ratio, and the window itself stays content-sized (unlike `height`, which fixes it).
   */
  maxHeight?: number;
  /** For `anchor: 'random'`: fractions (0..1) of the free space, fixed when the overlay is created. */
  randomSeed?: { x: number; y: number };
}

export interface OverlaySpec {
  id: string;
  kind: OverlayKind;
  /** Absolute file path of the asset (for backends that read files themselves). */
  file: string;
  /** rp-asset:// URL (Electron windows); backends that need http rewrite it through the LoopbackServer. */
  assetUrl: string;
  packId: string;
  asset: string;
  options: ResolvedOverlayOptions;
  /** Page-level options forwarded to media.html (caption, durationMs, volume, loop, muted, closeOnEnd). */
  page: ShowImageOptions | PlayVideoOptions;
  /** `avatar` overlays: the initial avatar state (its `imageUrl` is rewritten for helper backends). */
  avatar?: AvatarState;
  /** `widget` overlays: the widget to render. */
  widget?: WidgetSpec;
}

/**
 * What an overlay reports: `clicked` (the user clicked an image/video), `closed` (detail
 * `{ reason: MediaCloseReason }` — `api` when the backend or the app closed it), `ended`, `error`
 * (detail: message), `content-size`, `avatar-clicked`, `widget-message` (detail: the message).
 */
export type OverlayEvent = 'ended' | 'closed' | 'error' | 'content-size' | 'avatar-clicked' | 'widget-message' | 'clicked';
export type OverlayEventListener = (detail?: unknown) => void;
/** Detail of a `closed` overlay event. */
export interface OverlayClosedDetail {
  reason: MediaCloseReason;
}

export interface OverlayHandle {
  readonly id: string;
  /** Placement/layer/opacity/clickThrough/size; also forwards the visual subset to the page. */
  update(patch: OverlayUpdate): Promise<void>;
  close(): Promise<void>;
  /** Send any command to the page hosting this overlay (avatar-set, widget-update, draw-set, …). */
  send(command: MediaCommand): Promise<void>;
  on(event: OverlayEvent, listener: OverlayEventListener): () => void;
}

export interface DisplayBackend {
  readonly name: string;
  info(): DisplayBackendInfo;
  monitors(): Promise<MonitorInfo[]>;
  createOverlay(spec: OverlaySpec): Promise<OverlayHandle>;
  closeAll(): Promise<void>;
  dispose(): Promise<void>;
  /**
   * The URL under which this backend's media pages can load an `rp-asset://` URL (widget HTML
   * embeds such URLs for `{{asset:…}}` placeholders). Omitted: the pages load `rp-asset://` as is.
   */
  pageAssetUrl?(assetUrl: string): string;
}

/** What the Electron backend manipulates: a BrowserWindow that hosts media.html, behind an interface (fakeable in tests). */
export interface OverlayWindowLike {
  id: string;
  title: string;
  /** Resolves once media.html is loaded and listening for commands. */
  whenReady(): Promise<void>;
  send(command: MediaCommand): void;
  onReport(listener: (event: MediaWindowEvent) => void): () => void;
  onClosed(listener: () => void): () => void;
  setBounds(b: Bounds): void;
  getBounds(): Bounds;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void;
  /** Electron: Windows/macOS only; no-op on Linux. */
  setOpacity(v: number): void;
  setFocusable(flag: boolean): void;
  show(): void;
  hide(): void;
  blur(): void;
  isDestroyed(): boolean;
  destroy(): void;
  /** Run JavaScript in the page (voice fallback via speechSynthesis). */
  runScript?(script: string): Promise<unknown>;
}

const POSITIONS: ReadonlySet<string> = new Set(['random', 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);

export { setRandomSource } from './placement.js';
export function newRandomSeed(): { x: number; y: number } {
  return { x: randomSource(), y: randomSource() };
}

/** 0..1 → fraction of the monitor extent, > 1 → logical px. */
export function resolveOffset(value: number | undefined, extent: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value <= 1 ? Math.round(value * extent) : Math.round(value);
}

export interface OverlayDefaults {
  layer: OverlayLayer;
  /**
   * Media overlays: when the character gives neither `width` nor `height`, draw a random box of the
   * monitor (5%–50% of its width and height, one fraction for both) instead of the fixed default width.
   */
  randomSize?: boolean;
}

/** Pure: defaults + monitor selection + validation. Layers are NOT clamped here; backends degrade them. */
export function resolveOverlayOptions(opts: OverlayOptions | undefined, monitors: MonitorInfo[], defaults: OverlayDefaults): ResolvedOverlayOptions {
  const o = opts && typeof opts === 'object' ? opts : {};
  // Media overlays land on a random monitor unless the character picks one (avatar/widgets pass 'primary').
  const monitor = selectMonitor(o.monitor ?? 'random', monitors);
  const explicitWidth = typeof o.width === 'number' && Number.isFinite(o.width) && o.width > 0 ? Math.round(o.width) : undefined;
  const explicitHeight = typeof o.height === 'number' && Number.isFinite(o.height) && o.height > 0 ? Math.round(o.height) : undefined;
  const box = defaults.randomSize === true && explicitWidth === undefined && explicitHeight === undefined ? randomSizeBox(monitor, randomSizeFraction()) : undefined;
  const resolved: ResolvedOverlayOptions = {
    monitor,
    layer: isOverlayLayer(o.layer) ? o.layer : defaults.layer,
    opacity: clampOpacity(o.opacity, 1),
    clickThrough: o.clickThrough === true,
    anchor: typeof o.position === 'string' && POSITIONS.has(o.position) ? o.position : 'random',
    marginPx: typeof o.marginPx === 'number' && Number.isFinite(o.marginPx) && o.marginPx >= 0 ? Math.round(o.marginPx) : DEFAULT_MARGIN_PX,
    width: explicitWidth ?? box?.width ?? DEFAULT_OVERLAY_WIDTH,
  };
  if (explicitHeight !== undefined) resolved.height = explicitHeight;
  if (box) resolved.maxHeight = box.height;
  const x = resolveOffset(o.x, monitor.width);
  const y = resolveOffset(o.y, monitor.height);
  if (x !== undefined) resolved.x = x;
  if (y !== undefined) resolved.y = y;
  if (resolved.anchor === 'random' && x === undefined && y === undefined) resolved.randomSeed = newRandomSeed();
  return resolved;
}

/** Merge an `OverlayUpdate` into resolved options (re-resolving the monitor and offsets). */
export function applyOverlayUpdate(current: ResolvedOverlayOptions, patch: OverlayUpdate, monitors: MonitorInfo[]): ResolvedOverlayOptions {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next: ResolvedOverlayOptions = { ...current };
  if (p.monitor !== undefined) next.monitor = selectMonitor(p.monitor, monitors);
  else {
    const refreshed = monitors.find((m) => m.id === current.monitor.id);
    if (refreshed) next.monitor = refreshed;
  }
  if (isOverlayLayer(p.layer)) next.layer = p.layer;
  if (p.opacity !== undefined) next.opacity = clampOpacity(p.opacity, current.opacity);
  if (p.clickThrough !== undefined) next.clickThrough = p.clickThrough === true;
  if (typeof p.position === 'string' && POSITIONS.has(p.position)) {
    next.anchor = p.position;
    delete next.x;
    delete next.y;
    delete next.randomSeed;
    if (p.position === 'random') next.randomSeed = newRandomSeed();
  }
  if (typeof p.marginPx === 'number' && Number.isFinite(p.marginPx) && p.marginPx >= 0) next.marginPx = Math.round(p.marginPx);
  if (typeof p.width === 'number' && Number.isFinite(p.width) && p.width > 0) next.width = Math.round(p.width);
  if (typeof p.height === 'number' && Number.isFinite(p.height) && p.height > 0) next.height = Math.round(p.height);
  // The character took over the size: the random box no longer caps the content.
  if (next.width !== current.width || next.height !== current.height) delete next.maxHeight;
  const x = resolveOffset(p.x, next.monitor.width);
  const y = resolveOffset(p.y, next.monitor.height);
  if (x !== undefined) next.x = x;
  if (y !== undefined) next.y = y;
  return next;
}

/** Keys of an `OverlayUpdate` the media page applies itself (the rest is window-level). */
export function visualPatch(patch: OverlayUpdate): OverlayUpdate {
  const out: OverlayUpdate = {};
  if (patch.opacity !== undefined) out.opacity = patch.opacity;
  if (patch.width !== undefined) out.width = patch.width;
  if (patch.height !== undefined) out.height = patch.height;
  if (patch.clickThrough !== undefined) out.clickThrough = patch.clickThrough;
  return out;
}

export interface BackendLogger extends Pick<Console, 'info' | 'warn' | 'debug'> {}

export interface BackendContext {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger: BackendLogger;
  screen: ScreenLike;
  /** Creates a hidden, transparent BrowserWindow hosting media.html with the given title. */
  createWindow(title: string): OverlayWindowLike;
  /** Path of the `rp-overlay-wlr` helper binary, if any. */
  findHelper(): string | undefined;
  /** Lazily started loopback server (helper backends only). */
  loopback(): Promise<LoopbackServerLike>;
  /** Test hooks. */
  hyprTransport?: HyprTransport;
  helperFactory?: (binary: string) => HelperProcess;
}

/** Choose the backend for the `displayBackend` setting (`auto` → hyprland when running under Hyprland). */
export async function selectBackend(setting: AppSettings['displayBackend'], ctx: BackendContext): Promise<DisplayBackend> {
  const platform = ctx.platform ?? process.platform;
  const useHyprland = setting === 'hyprland' || (setting !== 'electron' && platform === 'linux' && isHyprland(ctx.env));
  if (useHyprland) return createHyprlandBackend(ctx);
  return new ElectronBackend({
    screen: ctx.screen,
    createWindow: ctx.createWindow,
    platform,
    windowSystem: detectWindowSystem(ctx.env, platform),
    logger: ctx.logger,
  });
}
