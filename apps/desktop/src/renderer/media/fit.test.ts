import { describe, expect, it } from 'vitest';
import { fitMedia } from './fit';

describe('fitMedia', () => {
  it('scales to the box width, up or down, keeping the aspect ratio', () => {
    expect(fitMedia({ width: 200, height: 100 }, { width: 800 })).toEqual({ width: 800, height: 400 });
    expect(fitMedia({ width: 1600, height: 900 }, { width: 400 })).toEqual({ width: 400, height: 225 });
  });

  it('lets the height cap win for tall content', () => {
    expect(fitMedia({ width: 400, height: 1200 }, { width: 800, height: 600 })).toEqual({ width: 200, height: 600 });
    // A cap that does not bite changes nothing.
    expect(fitMedia({ width: 400, height: 100 }, { width: 800, height: 600 })).toEqual({ width: 800, height: 200 });
  });

  it('falls back to the box for unknown natural sizes', () => {
    expect(fitMedia({ width: 0, height: 0 }, { width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    expect(fitMedia({ width: NaN, height: 10 }, { width: 300 })).toEqual({ width: 300, height: 300 });
  });
});
