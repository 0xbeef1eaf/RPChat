import type { MediaItemId } from './ids.js';

/** Where a media overlay is placed on the primary display. */
export type MediaPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface ShowImageOptions {
  /** Auto-close after this many ms. Omit to keep open until closed. */
  durationMs?: number;
  position?: MediaPosition;
  /** Max width in CSS px. Default 480. */
  width?: number;
  /** Caption rendered under the image. */
  caption?: string;
}

export interface PlayVideoOptions {
  position?: MediaPosition;
  width?: number;
  /** 0..1, default 1. */
  volume?: number;
  loop?: boolean;
  /** Close the window automatically when playback ends. Default true. */
  closeOnEnd?: boolean;
  muted?: boolean;
}

export interface PlayAudioOptions {
  volume?: number;
  loop?: boolean;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaItem {
  id: MediaItemId;
  kind: MediaKind;
  /** Asset path relative to the pack root. */
  asset: string;
  packId: string;
  startedAt: string;
}

/** Commands sent from main to a media window. `url` is always an `rp-asset://` URL. */
export type MediaCommand =
  | { type: 'show-image'; id: MediaItemId; url: string; options: ShowImageOptions }
  | { type: 'play-video'; id: MediaItemId; url: string; options: PlayVideoOptions }
  | { type: 'play-audio'; id: MediaItemId; url: string; options: PlayAudioOptions }
  | { type: 'close'; id: MediaItemId }
  | { type: 'close-all' };

/** Events sent from a media window back to main. */
export type MediaWindowEvent =
  | { type: 'ended'; id: MediaItemId }
  | { type: 'error'; id: MediaItemId; message: string }
  | { type: 'closed'; id: MediaItemId };

export const ASSET_PROTOCOL = 'rp-asset';

/** Build the URL under which an installed pack asset is served to renderer windows. */
export function assetUrl(packId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${ASSET_PROTOCOL}://${packId}/${clean}`;
}
