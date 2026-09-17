/**
 * Tiling of one picture over a whole screen (`sdk.media.overlay`). The media is fitted into the
 * screen keeping its aspect ratio — so it is as large as it can be while fully visible — and copies
 * of that tile repeat outwards from the centred one to cover what is left. A picture whose shape
 * matches the screen is therefore exactly one tile and nothing repeats.
 */
import type { NaturalSize } from './fit';

export interface ScreenSize {
  width: number;
  height: number;
}

export interface TileLayout {
  /** Size of one copy in CSS px. */
  width: number;
  height: number;
  /** Left/top of the first copy: the centred tile stepped back by whole tiles, so it is ≤ 0. */
  startX: number;
  startY: number;
  columns: number;
  rows: number;
}

/** Start offset and count along one axis: centred, then stepped back until the axis is covered. */
function axis(extent: number, tile: number): { start: number; count: number } {
  const centre = (extent - tile) / 2;
  const start = Math.round(centre - Math.ceil(centre / tile) * tile);
  return { start, count: Math.max(1, Math.ceil((extent - start) / tile)) };
}

/**
 * How `natural` tiles over a `screen`. An unknown or zero natural size falls back to a single copy
 * filling the screen (the page has nothing better to go on until the media reports its size).
 */
export function tileLayout(natural: NaturalSize, screen: ScreenSize): TileLayout {
  const sw = Math.max(1, Math.round(screen.width));
  const sh = Math.max(1, Math.round(screen.height));
  const nw = Number.isFinite(natural.width) && natural.width > 0 ? natural.width : 0;
  const nh = Number.isFinite(natural.height) && natural.height > 0 ? natural.height : 0;
  if (nw === 0 || nh === 0) return { width: sw, height: sh, startX: 0, startY: 0, columns: 1, rows: 1 };
  const scale = Math.min(sw / nw, sh / nh);
  const width = Math.max(1, Math.round(nw * scale));
  const height = Math.max(1, Math.round(nh * scale));
  const x = axis(sw, width);
  const y = axis(sh, height);
  return { width, height, startX: x.start, startY: y.start, columns: x.count, rows: y.count };
}

/** Top-left corner of every copy, row by row — what a canvas has to paint (CSS repeats by itself). */
export function tilePositions(layout: TileLayout): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let column = 0; column < layout.columns; column++) {
      out.push({ x: layout.startX + column * layout.width, y: layout.startY + row * layout.height });
    }
  }
  return out;
}
