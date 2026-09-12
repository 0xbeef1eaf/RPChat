/** Electron-backed image decoding for the editor's auto-tagging (kept out of `tagger.ts` so that stays testable). */
import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { fitWithin } from '../capture.js';
import type { ImageReader } from './tagger.js';

/** True when any pixel is not fully opaque — such an image must stay PNG (JPEG would paint it black). */
export function hasTransparency(image: NativeImage): boolean {
  const bitmap = image.toBitmap();
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i]! < 250) return true;
  return false;
}

/**
 * Decode an image file and downscale its longest edge to `maxPx`. Opaque art is sent as JPEG
 * (a fraction of the bytes, which matters for a local server); cut-outs keep their alpha as PNG.
 * Animated files give their first frame.
 */
export function electronImageReader(): ImageReader {
  return async (absolutePath, maxPx) => {
    const image = nativeImage.createFromPath(absolutePath);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    const target = fitWithin(width, height, maxPx);
    const out = target.width === width && target.height === height ? image : image.resize({ ...target, quality: 'good' });
    const png = hasTransparency(out);
    return {
      mime: png ? 'image/png' : 'image/jpeg',
      data: (png ? out.toPNG() : out.toJPEG(82)).toString('base64'),
      width: target.width,
      height: target.height,
    };
  };
}
