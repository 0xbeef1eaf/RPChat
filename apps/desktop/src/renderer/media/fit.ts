/** Aspect-preserving fit of an image/video into the box the overlay was given. */

export interface NaturalSize {
  width: number;
  height: number;
}

export interface FitBox {
  /** The box width; the content is scaled (up or down) to this unless the height cap bites first. */
  width: number;
  /** Optional height cap. */
  height?: number | undefined;
}

/**
 * Scale `natural` so it fills `box.width`, then shrink it further if it would exceed `box.height`,
 * keeping the aspect ratio throughout. Upscaling is allowed: a small picture drawn a large box
 * appears large. Unknown/zero natural sizes fall back to the box itself.
 */
export function fitMedia(natural: NaturalSize, box: FitBox): { width: number; height: number } {
  const w = Number.isFinite(natural.width) && natural.width > 0 ? natural.width : 0;
  const h = Number.isFinite(natural.height) && natural.height > 0 ? natural.height : 0;
  const boxW = Math.max(1, Math.round(box.width));
  const cap = typeof box.height === 'number' && Number.isFinite(box.height) && box.height > 0 ? Math.round(box.height) : undefined;
  if (w === 0 || h === 0) return { width: boxW, height: cap ?? boxW };
  let scale = boxW / w;
  if (cap !== undefined && h * scale > cap) scale = cap / h;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
