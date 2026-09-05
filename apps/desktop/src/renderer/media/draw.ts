/** Pure geometry for the `draw` overlay page: `DrawShape` → SVG element descriptions. */
import type { DrawShape } from '@rp/shared';

export interface Viewport {
  width: number;
  height: number;
}

export const DEFAULT_DRAW_COLOR = '#ff3b30';
export const DEFAULT_STROKE = 3;

/** Values in 0..1 are fractions of the monitor axis; larger values are logical px. */
export function resolveCoord(value: number | undefined, extent: number, fallback = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value >= 0 && value <= 1) return value * extent;
  return value;
}

export type SvgGeometry =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; head: string }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'text'; x: number; y: number; text: string; fontSize: number };

export interface ResolvedShape {
  shapeId: string;
  color: string;
  strokeWidth: number;
  durationMs?: number;
  geometry: SvgGeometry;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Polygon points for an arrowhead ending at (x2, y2), pointing away from (x1, y1). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const p1 = [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)];
  const p2 = [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)];
  return [[x2, y2], p1, p2].map(([x, y]) => `${round(x!)},${round(y!)}`).join(' ');
}

export function resolveShape(shape: DrawShape & { shapeId: string }, viewport: Viewport): ResolvedShape {
  const strokeWidth = shape.strokeWidth && shape.strokeWidth > 0 ? shape.strokeWidth : DEFAULT_STROKE;
  const color = shape.color?.trim() || DEFAULT_DRAW_COLOR;
  const x = round(resolveCoord(shape.x, viewport.width));
  const y = round(resolveCoord(shape.y, viewport.height));
  const common = { shapeId: shape.shapeId, color, strokeWidth, durationMs: shape.durationMs };
  switch (shape.type) {
    case 'line': {
      const x2 = round(resolveCoord(shape.x2, viewport.width, x));
      const y2 = round(resolveCoord(shape.y2, viewport.height, y));
      return { ...common, geometry: { kind: 'line', x1: x, y1: y, x2, y2 } };
    }
    case 'arrow': {
      const x2 = round(resolveCoord(shape.x2, viewport.width, x));
      const y2 = round(resolveCoord(shape.y2, viewport.height, y));
      return { ...common, geometry: { kind: 'arrow', x1: x, y1: y, x2, y2, head: arrowHead(x, y, x2, y2, Math.max(10, strokeWidth * 4)) } };
    }
    case 'circle': {
      const r = round(resolveCoord(shape.radius, Math.min(viewport.width, viewport.height), 24));
      return { ...common, geometry: { kind: 'circle', cx: x, cy: y, r: Math.max(1, r) } };
    }
    case 'rect': {
      const width = round(resolveCoord(shape.width, viewport.width, 100));
      const height = round(resolveCoord(shape.height, viewport.height, 60));
      return { ...common, geometry: { kind: 'rect', x, y, width: Math.max(1, width), height: Math.max(1, height) } };
    }
    case 'text':
    default:
      return { ...common, geometry: { kind: 'text', x, y, text: shape.text ?? '', fontSize: Math.max(12, strokeWidth * 6) } };
  }
}

export function resolveShapes(shapes: Array<DrawShape & { shapeId: string }>, viewport: Viewport): ResolvedShape[] {
  return shapes.map((s) => resolveShape(s, viewport));
}

/** Only allow plain CSS colours (names, hex, rgb()/hsl()) so a shape cannot inject SVG attributes. */
export function isSafeColor(color: string): boolean {
  return /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\(\s*[\d.%, ]+\s*\))$/i.test(color.trim());
}
