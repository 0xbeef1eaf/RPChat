/**
 * Natural dimensions and length of a pack asset, read on this side: Chromium decodes everything
 * the editor can show and `rp-asset://` serves ranges, so loading metadata alone is enough — none
 * of the bytes go through main (unlike `frames.ts`, which needs a canvas it is allowed to read).
 */

import type { EditorAsset } from '@rp/shared';
import { formatDuration } from './format';

/** What a probe could read. Each field is absent when the format does not carry it. */
export interface MediaMeta {
  width?: number;
  height?: number;
  durationMs?: number;
}

/** How long to wait for one file's metadata before giving up on it. */
export const META_TIMEOUT_MS = 10_000;

/** `1920 × 1080 · 1 min 30 s` — whichever parts are known, in that order. */
export function formatMediaMeta(meta: MediaMeta | undefined): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.width && meta.height) parts.push(`${meta.width} × ${meta.height}`);
  const length = meta.durationMs === undefined ? '' : formatDuration(meta.durationMs);
  if (length) parts.push(length);
  return parts.join(' · ');
}

/** Drop a reading that says nothing, so callers can keep asking or show nothing at all. */
function known(meta: MediaMeta | undefined): MediaMeta | undefined {
  if (!meta) return undefined;
  return meta.width !== undefined || meta.durationMs !== undefined ? meta : undefined;
}

/**
 * Size and length of one asset, or `undefined` when the file carries neither (text, archives) or
 * the browser cannot read it. Images give a size, audio a length, video both.
 */
export async function probeMedia(asset: EditorAsset): Promise<MediaMeta | undefined> {
  if (asset.kind === 'image') return probeImage(asset.url);
  if (asset.kind === 'video' || asset.kind === 'audio') return probeElement(asset.kind, asset.url);
  return undefined;
}

async function probeImage(url: string): Promise<MediaMeta | undefined> {
  const image = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => resolve(false), META_TIMEOUT_MS);
    image.onload = () => (window.clearTimeout(timer), resolve(true));
    image.onerror = () => (window.clearTimeout(timer), resolve(false));
    image.src = url;
  });
  if (!loaded || image.naturalWidth === 0) return undefined;
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function probeElement(kind: 'video' | 'audio', url: string): Promise<MediaMeta | undefined> {
  const el = document.createElement(kind);
  el.preload = 'metadata';
  el.src = url;
  return new Promise<MediaMeta | undefined>((resolve) => {
    /** Whatever the last read gave us: a timeout mid-seek still reports the size we already have. */
    let partial: MediaMeta | undefined;
    const done = (value: MediaMeta | undefined): void => {
      window.clearTimeout(timer);
      el.removeAttribute('src');
      el.load(); // let go of the file
      resolve(known(value));
    };
    const timer = window.setTimeout(() => done(partial), META_TIMEOUT_MS);
    const read = (): MediaMeta => {
      const seconds = el.duration;
      return {
        ...(el instanceof HTMLVideoElement && el.videoWidth > 0 ? { width: el.videoWidth, height: el.videoHeight } : {}),
        ...(Number.isFinite(seconds) && seconds > 0 ? { durationMs: seconds * 1000 } : {}),
      };
    };
    el.onerror = () => done(partial);
    el.onloadedmetadata = () => {
      partial = read();
      // Files written by a recorder (WebM, Ogg) often admit no duration until something seeks past
      // the end; the seek below makes Chromium work it out and fire `durationchange`.
      if (partial.durationMs === undefined && el.seekable.length > 0) {
        el.ondurationchange = () => done(read());
        el.currentTime = 1e9;
        return;
      }
      done(partial);
    };
  });
}
