/**
 * Turns an asset into a still a vision model can look at. The main process decodes PNG and JPEG
 * only (Electron's `nativeImage` supports nothing else), while Chromium here reads WebP, AVIF,
 * GIF, BMP and SVG — and plays video — so anything else is decoded on this side and passed to
 * `editor.suggestMediaTags` as a frame.
 */

import type { EditorAsset } from '@rp/shared';
import { needsRendererFrame } from './tagging';

/** How long to wait for a frame before giving up on a file. */
export const FRAME_TIMEOUT_MS = 15_000;

/**
 * The still to send with an asset, or `undefined` when main can read the file itself (PNG/JPEG)
 * or there is nothing to look at (audio). A failed decode also yields `undefined`: the tagger
 * then falls back to tagging by file name and says so.
 */
export async function frameFor(asset: EditorAsset, maxPx = 768): Promise<string | undefined> {
  if (!needsRendererFrame(asset)) return undefined;
  return asset.kind === 'video' ? captureVideoFrame(asset.url, maxPx) : renderImageFrame(asset.url, maxPx);
}

/**
 * Base64 PNG (no `data:` prefix) of a frame a quarter into the video, downscaled to `maxPx`.
 * Resolves `undefined` when the file cannot be decoded in time — the caller then tags by name.
 */
export async function captureVideoFrame(url: string, maxPx = 768): Promise<string | undefined> {
  const video = document.createElement('video');
  video.muted = true;
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.src = url;
  try {
    return await new Promise<string | undefined>((resolve) => {
      const timer = window.setTimeout(() => done(undefined), FRAME_TIMEOUT_MS);
      const done = (value: string | undefined): void => {
        window.clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        resolve(value);
      };
      video.onerror = () => done(undefined);
      video.onloadeddata = () => {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (duration === 0) draw(done);
        else video.currentTime = Math.min(duration * 0.25, duration - 0.05);
      };
      video.onseeked = () => draw(done);
      const draw = (finish: (value: string | undefined) => void): void => {
        const { videoWidth: w, videoHeight: h } = video;
        if (w === 0 || h === 0) return finish(undefined);
        const scale = Math.min(1, maxPx / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        finish(dataUrl.slice(dataUrl.indexOf(',') + 1) || undefined);
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * Base64 still of an image asset (no `data:` prefix), downscaled to `maxPx`: PNG when the art has
 * transparency, JPEG otherwise. Animated files give their first frame. `undefined` when the
 * browser cannot decode the file either.
 */
export async function renderImageFrame(url: string, maxPx = 768): Promise<string | undefined> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), FRAME_TIMEOUT_MS);
      image.onload = () => (window.clearTimeout(timer), resolve(true));
      image.onerror = () => (window.clearTimeout(timer), resolve(false));
      image.src = url;
    });
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (!loaded || w === 0 || h === 0) return undefined;
    const scale = Math.min(1, maxPx / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(hasAlpha(ctx, canvas) ? 'image/png' : 'image/jpeg', 0.82);
    return dataUrl.slice(dataUrl.indexOf(',') + 1) || undefined;
  } catch {
    return undefined;
  }
}

/** True when any pixel is not fully opaque — such art must stay PNG (JPEG would paint it black). */
function hasAlpha(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) return true;
    return false;
  } catch {
    return true; // tainted canvas or no pixel access: PNG is the safe choice
  }
}
