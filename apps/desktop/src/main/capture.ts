/** Screen capture + PNG downscale with Electron's desktopCapturer / nativeImage (X11, Windows, macOS). */
import { desktopCapturer, nativeImage } from 'electron';
import type { MonitorInfo } from '@rp/shared';
import type { Capturer } from './capabilities/screen.js';
import { SCREENSHOT_MAX_PX } from './capabilities/screen.js';

export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxPx || longest === 0) return { width, height };
  const scale = maxPx / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function electronCapturer(): Capturer {
  return {
    async capture(monitor: MonitorInfo) {
      const size = fitWithin(Math.round(monitor.width * monitor.scale), Math.round(monitor.height * monitor.scale), SCREENSHOT_MAX_PX);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      if (sources.length === 0) return undefined;
      const source = sources.find((s) => s.display_id === monitor.id) ?? sources[monitor.index] ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) return undefined;
      const { width, height } = source.thumbnail.getSize();
      return { png: source.thumbnail.toPNG(), width, height };
    },
    async downscale(png: Buffer, maxPx: number) {
      const image = nativeImage.createFromBuffer(png);
      const { width, height } = image.getSize();
      const target = fitWithin(width, height, maxPx);
      const out = target.width === width && target.height === height ? image : image.resize({ width: target.width, height: target.height, quality: 'good' });
      return { png: out.toPNG(), width: target.width, height: target.height };
    },
  };
}
