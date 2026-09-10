/** Pure placement math for overlay windows (docs/spec/overlay.md §1). */
import type { MediaPosition, MonitorInfo, MonitorSelector, OverlayPlacement } from '@rp/shared';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_OVERLAY_WIDTH = 480;
export const DEFAULT_OVERLAY_HEIGHT = 320;
export const DEFAULT_MARGIN_PX = 24;
export const MIN_OVERLAY_SIZE = 16;

/**
 * Pick a monitor: `primary` (default), `cursor` (the one holding the pointer),
 * a zero-based index, or an id/name. Unknown selectors fall back to the primary.
 */
export function selectMonitor(selector: MonitorSelector | undefined, monitors: MonitorInfo[]): MonitorInfo {
  if (monitors.length === 0) throw new Error('No monitors available');
  const primary = monitors.find((m) => m.primary) ?? (monitors[0] as MonitorInfo);
  if (selector === undefined || selector === null || selector === 'primary') return primary;
  if (selector === 'cursor') return monitors.find((m) => m.hasCursor) ?? primary;
  if (typeof selector === 'number') {
    if (!Number.isInteger(selector)) return primary;
    return monitors.find((m) => m.index === selector) ?? monitors[selector] ?? primary;
  }
  if (typeof selector === 'string') {
    const wanted = selector.trim().toLowerCase();
    if (wanted.length === 0) return primary;
    return monitors.find((m) => m.id.toLowerCase() === wanted) ?? monitors.find((m) => m.name.toLowerCase() === wanted) ?? primary;
  }
  return primary;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Random anchor: `seed` fraction of the space left after the window and the margins, so it is always fully visible. */
function randomOffset(seed: number | undefined, extent: number, size: number, margin: number): number {
  const free = Math.max(0, extent - size - 2 * margin);
  const f = typeof seed === 'number' && Number.isFinite(seed) ? Math.min(1, Math.max(0, seed)) : 0.5;
  return Math.min(margin, Math.max(0, extent - size)) + Math.round(f * free);
}

function anchorX(position: MediaPosition, monitor: MonitorInfo, width: number, margin: number, seed?: number): number {
  switch (position) {
    case 'random':
      return monitor.x + randomOffset(seed, monitor.width, width, margin);
    case 'top-left':
    case 'bottom-left':
      return monitor.x + margin;
    case 'top-right':
    case 'bottom-right':
      return monitor.x + monitor.width - width - margin;
    default:
      return monitor.x + Math.round((monitor.width - width) / 2);
  }
}

function anchorY(position: MediaPosition, monitor: MonitorInfo, height: number, margin: number, seed?: number): number {
  switch (position) {
    case 'random':
      return monitor.y + randomOffset(seed, monitor.height, height, margin);
    case 'top-left':
    case 'top-right':
      return monitor.y + margin;
    case 'bottom-left':
    case 'bottom-right':
      return monitor.y + monitor.height - height - margin;
    default:
      return monitor.y + Math.round((monitor.height - height) / 2);
  }
}

/** 0..1 → fraction of the monitor extent, > 1 → logical px offset. */
function explicitOffset(value: number, extent: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 0 && value <= 1) return Math.round(value * extent);
  return Math.round(value);
}

const POSITIONS: ReadonlySet<string> = new Set(['random', 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);

export interface PlacementInput {
  monitor: MonitorInfo;
  anchor: MediaPosition;
  marginPx: number;
  /** Already resolved to logical px on the monitor. */
  x?: number;
  y?: number;
  /** `anchor: 'random'`: fixed fractions of the free space (missing → centre). */
  randomSeed?: { x: number; y: number };
}

/** Absolute bounds for a window of `size` placed per `input`, clamped to stay fully on the monitor. */
export function placeOverlay(input: PlacementInput, size: Size): Bounds {
  const { monitor } = input;
  const width = clamp(Math.round(positive(size.width) ?? DEFAULT_OVERLAY_WIDTH), Math.min(MIN_OVERLAY_SIZE, monitor.width), Math.max(1, monitor.width));
  const height = clamp(Math.round(positive(size.height) ?? DEFAULT_OVERLAY_HEIGHT), Math.min(MIN_OVERLAY_SIZE, monitor.height), Math.max(1, monitor.height));
  const margin = Math.max(0, input.marginPx);
  let x = typeof input.x === 'number' ? monitor.x + Math.round(input.x) : anchorX(input.anchor, monitor, width, margin, input.randomSeed?.x);
  let y = typeof input.y === 'number' ? monitor.y + Math.round(input.y) : anchorY(input.anchor, monitor, height, margin, input.randomSeed?.y);
  x = clamp(x, monitor.x, monitor.x + monitor.width - width);
  y = clamp(y, monitor.y, monitor.y + monitor.height - height);
  return { x, y, width, height };
}

/**
 * Resolve monitor + absolute bounds for an overlay from raw placement options.
 * `size` is the content size reported by the media window (or a default);
 * explicit `width`/`height` in `opts` win. The result always lies fully inside
 * the monitor's work area.
 */
export function resolvePlacement(
  opts: OverlayPlacement & { width?: number; height?: number },
  monitors: MonitorInfo[],
  size: Size,
  randomSeed?: { x: number; y: number },
): { monitor: MonitorInfo; bounds: Bounds } {
  const monitor = selectMonitor(opts.monitor, monitors);
  const input: PlacementInput = {
    monitor,
    anchor: opts.position && POSITIONS.has(opts.position) ? opts.position : 'random',
    marginPx: positive(opts.marginPx) ?? (opts.marginPx === 0 ? 0 : DEFAULT_MARGIN_PX),
  };
  if (input.anchor === 'random' && typeof opts.x !== 'number' && typeof opts.y !== 'number') input.randomSeed = randomSeed ?? { x: Math.random(), y: Math.random() };
  if (typeof opts.x === 'number') input.x = explicitOffset(opts.x, monitor.width);
  if (typeof opts.y === 'number') input.y = explicitOffset(opts.y, monitor.height);
  const bounds = placeOverlay(input, {
    width: positive(opts.width) ?? positive(size.width) ?? DEFAULT_OVERLAY_WIDTH,
    height: positive(opts.height) ?? positive(size.height) ?? DEFAULT_OVERLAY_HEIGHT,
  });
  return { monitor, bounds };
}

function positive(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function sameBounds(a: Bounds | undefined, b: Bounds): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
