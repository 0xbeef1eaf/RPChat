/**
 * Image effects (pure): map an effect preset (or a custom `{ css }`) onto the CSS `filter` the
 * page helper applies to images, pictures and videos. `pixelate` is approximate — CSS has no
 * true pixelation filter, so it combines `image-rendering: pixelated` with a blur/contrast trick.
 */

export const EFFECT_PRESETS: Record<string, string> = {
  blur: 'blur(6px)',
  grayscale: 'grayscale(1)',
  sepia: 'sepia(1)',
  invert: 'invert(1)',
  hue: 'hue-rotate(180deg)',
  pixelate: 'blur(1px) contrast(2)',
  none: '',
};

export const DEFAULT_EFFECT_SELECTOR = 'img, picture, video';
export const MAX_EFFECT_CSS_LENGTH = 512;
export const MAX_EFFECT_DURATION_MS = 24 * 60 * 60 * 1000;

export interface BuiltEffect {
  /** The `filter` value, or null for `none` (remove the style). */
  filter: string | null;
  /** Extra declarations appended to the rule (`image-rendering: pixelated` for pixelate). */
  extra: string;
  name: string;
}

/** Validate an effect argument and build the CSS for it; throws with a reason on bad input. */
export function buildEffect(effect: unknown): BuiltEffect {
  if (typeof effect === 'string') {
    const preset = EFFECT_PRESETS[effect.trim().toLowerCase()];
    if (preset === undefined) throw new Error(`Unknown effect "${effect}" (use ${Object.keys(EFFECT_PRESETS).join(', ')} or { css })`);
    const name = effect.trim().toLowerCase();
    return { filter: preset.length > 0 ? preset : null, extra: name === 'pixelate' ? 'image-rendering: pixelated !important;' : '', name };
  }
  if (effect && typeof effect === 'object' && typeof (effect as { css?: unknown }).css === 'string') {
    const css = (effect as { css: string }).css.trim();
    if (css.length === 0) return { filter: null, extra: '', name: 'none' };
    if (css.length > MAX_EFFECT_CSS_LENGTH) throw new Error(`css must be at most ${MAX_EFFECT_CSS_LENGTH} characters`);
    if (/[{};<>]|url\s*\(|expression|@import|javascript:/i.test(css)) throw new Error('css must be a plain filter value such as "blur(4px) sepia(0.6)" (no braces, semicolons, url() or markup)');
    return { filter: css, extra: '', name: 'custom' };
  }
  throw new Error('effect must be a preset name or { css: "<filter value>" }');
}

/** The selector the style rule targets: the caller's, or images/pictures/videos. */
export function effectSelector(selector: unknown): string {
  if (typeof selector !== 'string') return DEFAULT_EFFECT_SELECTOR;
  const s = selector.trim();
  if (s.length === 0 || s.length > 300) return DEFAULT_EFFECT_SELECTOR;
  if (/[{}<>]/.test(s)) throw new Error('selector must be a CSS selector (no braces or markup)');
  return s;
}

/** Full stylesheet text the page helper puts into `<style data-rp-effect>`. */
export function effectStylesheet(built: BuiltEffect, selector: string): string {
  if (built.filter === null && built.extra.length === 0) return '';
  const filter = built.filter ? `filter: ${built.filter} !important;` : '';
  return `${selector} { ${filter} ${built.extra} }`.replace(/\s+/g, ' ').trim();
}
