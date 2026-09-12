/**
 * Grabs a still from a video asset so a vision model has something to look at. Main cannot decode
 * video (no ffmpeg dependency), but the renderer already plays these files through `rp-asset://`.
 */

/** How long to wait for a frame before giving up on a file. */
export const FRAME_TIMEOUT_MS = 15_000;

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
