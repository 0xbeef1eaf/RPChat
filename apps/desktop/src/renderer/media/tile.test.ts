import { describe, expect, it } from 'vitest';
import { tileLayout, tilePositions } from './tile';

describe('tileLayout', () => {
  it('is one copy filling the screen when the aspect ratios match', () => {
    expect(tileLayout({ width: 1600, height: 900 }, { width: 1920, height: 1080 })).toEqual({
      width: 1920,
      height: 1080,
      startX: 0,
      startY: 0,
      columns: 1,
      rows: 1,
    });
  });

  it('repeats out from the centre along the axis the picture does not fill', () => {
    // A square on a 16:9 screen: as tall as the screen, so it repeats sideways, evenly overhanging.
    const layout = tileLayout({ width: 512, height: 512 }, { width: 1920, height: 1080 });
    expect(layout).toEqual({ width: 1080, height: 1080, startX: -660, startY: 0, columns: 3, rows: 1 });
    const right = layout.startX + layout.columns * layout.width - 1920;
    expect(right).toBe(-layout.startX); // the overhang is the same on both sides
  });

  it('repeats downwards for a wide picture', () => {
    const layout = tileLayout({ width: 1920, height: 480 }, { width: 1920, height: 1080 });
    expect(layout).toMatchObject({ width: 1920, height: 480, columns: 1, rows: 3, startY: -180 });
    expect(layout.startY + layout.rows * layout.height).toBeGreaterThanOrEqual(1080);
  });

  it('falls back to one screen-sized copy while the natural size is unknown', () => {
    expect(tileLayout({ width: 0, height: 0 }, { width: 800, height: 600 })).toMatchObject({ width: 800, height: 600, columns: 1, rows: 1 });
    expect(tileLayout({ width: NaN, height: 10 }, { width: 800, height: 600 })).toMatchObject({ width: 800, height: 600 });
  });

  it('never asks for a copy smaller than a pixel', () => {
    expect(tileLayout({ width: 4000, height: 1 }, { width: 100, height: 100 })).toMatchObject({ width: 100, height: 1 });
  });
});

describe('tilePositions', () => {
  it('walks the grid row by row from the first copy', () => {
    const layout = tileLayout({ width: 512, height: 512 }, { width: 1920, height: 1080 });
    expect(tilePositions(layout)).toEqual([
      { x: -660, y: 0 },
      { x: 420, y: 0 },
      { x: 1500, y: 0 },
    ]);
  });

  it('covers the screen in both directions', () => {
    const layout = tileLayout({ width: 300, height: 200 }, { width: 1000, height: 1000 });
    const positions = tilePositions(layout);
    expect(positions).toHaveLength(layout.columns * layout.rows);
    expect(Math.min(...positions.map((p) => p.x))).toBeLessThanOrEqual(0);
    expect(Math.max(...positions.map((p) => p.y)) + layout.height).toBeGreaterThanOrEqual(1000);
  });
});
