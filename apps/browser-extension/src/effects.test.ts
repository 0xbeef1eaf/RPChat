import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFECT_SELECTOR, buildEffect, effectSelector, effectStylesheet } from './lib/effects.js';

describe('image effect CSS', () => {
  it('maps presets onto filter values and none onto removal', () => {
    expect(buildEffect('blur')).toEqual({ filter: 'blur(6px)', extra: '', name: 'blur' });
    expect(buildEffect('GRAYSCALE')).toMatchObject({ filter: 'grayscale(1)' });
    expect(buildEffect('hue')).toMatchObject({ filter: 'hue-rotate(180deg)' });
    expect(buildEffect('pixelate')).toEqual({ filter: 'blur(1px) contrast(2)', extra: 'image-rendering: pixelated !important;', name: 'pixelate' });
    expect(buildEffect('none')).toEqual({ filter: null, extra: '', name: 'none' });
    expect(buildEffect({ css: 'sepia(0.5) blur(2px)' })).toEqual({ filter: 'sepia(0.5) blur(2px)', extra: '', name: 'custom' });
    expect(buildEffect({ css: '' })).toMatchObject({ filter: null });
  });

  it('rejects unknown presets and css that is not a plain filter value', () => {
    expect(() => buildEffect('sparkle')).toThrow(/Unknown effect/);
    expect(() => buildEffect(42)).toThrow(/preset name/);
    expect(() => buildEffect({ css: 'blur(1px)} body{display:none' })).toThrow(/plain filter/);
    expect(() => buildEffect({ css: 'url(https://x)' })).toThrow(/plain filter/);
    expect(() => buildEffect({ css: 'x'.repeat(600) })).toThrow(/at most/);
  });

  it('builds the stylesheet for the default or a custom selector', () => {
    expect(effectSelector(undefined)).toBe(DEFAULT_EFFECT_SELECTOR);
    expect(effectSelector('  ')).toBe(DEFAULT_EFFECT_SELECTOR);
    expect(effectSelector('.hero img')).toBe('.hero img');
    expect(() => effectSelector('img{')).toThrow(/selector/);
    expect(effectStylesheet(buildEffect('grayscale'), 'img')).toBe('img { filter: grayscale(1) !important; }');
    expect(effectStylesheet(buildEffect('pixelate'), DEFAULT_EFFECT_SELECTOR)).toBe('img, picture, video { filter: blur(1px) contrast(2) !important; image-rendering: pixelated !important; }');
    expect(effectStylesheet(buildEffect('none'), 'img')).toBe('');
  });
});
