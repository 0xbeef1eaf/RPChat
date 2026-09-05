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

function anchorX(position: MediaPosition, monitor: MonitorInfo, width: number, margin: number): number {
  switch (position) {
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

function anchorY(position: MediaPosition, monitor: MonitorInfo, height: number, margin: number): number {
  switch (position) {
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

const POSITIONS: ReadonlySet<string> = new Set(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);

/**
 * Resolve monitor + absolute bounds for an overlay. `size` is the content size
 * reported by the media window (or a default); explicit `width`/`height` in
 * `opts` win. The result always lies fully inside the monitor's work area.
 */
export function resolvePlacement(
  opts: OverlayPlacement & { width?: number; height?: number },
  monitors: MonitorInfo[],
  size: Size,
): { monitor: MonitorInfo; bounds: Bounds } {
  const monitor = selectMonitor(opts.monitor, monitors);
  const wantedW = positive(opts.width) ?? positive(size.width) ?? DEFAULT_OVERLAY_WIDTH;
  const wantedH = positive(opts.height) ?? positive(size.height) ?? DEFAULT_OVERLAY_HEIGHT;
  const width = clamp(Math.round(wantedW), Math.min(MIN_OVERLAY_SIZE, monitor.width), Math.max(1, monitor.width));
  const height = clamp(Math.round(wantedH), Math.min(MIN_OVERLAY_SIZE, monitor.height), Math.max(1, monitor.height));
  const margin = Math.max(0, positive(opts.marginPx) ?? DEFAULT_MARGIN_PX);
  const position: MediaPosition = opts.position && POSITIONS.has(opts.position) ? opts.position : 'center';

  let x = typeof opts.x === 'number' ? monitor.x + explicitOffset(opts.x, monitor.width) : anchorX(position, monitor, width, margin);
  let y = typeof opts.y === 'number' ? monitor.y + explicitOffset(opts.y, monitor.height) : anchorY(position, monitor, height, margin);
  x = clamp(x, monitor.x, monitor.x + monitor.width - width);
  y = clamp(y, monitor.y, monitor.y + monitor.height - height);
  return { monitor, bounds: { x, y, width, height } };
}

function positive(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function sameBounds(a: Bounds | undefined, b: Bounds): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
