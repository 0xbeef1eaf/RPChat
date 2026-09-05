/**
 * Pure state for the media overlay window. The React page feeds it
 * `MediaCommand`s from main and local user/playback events; it returns the
 * next item list plus the `MediaWindowEvent`s that must be reported back.
 */
import type {
  MediaCommand,
  MediaItemId,
  MediaWindowEvent,
  OverlayOptions,
  OverlayUpdate,
  PlayAudioOptions,
  PlayVideoOptions,
  ShowImageOptions,
} from '@rp/shared';

export type MediaEntry =
  | { id: MediaItemId; kind: 'image'; url: string; options: ShowImageOptions }
  | { id: MediaItemId; kind: 'video'; url: string; options: PlayVideoOptions }
  | { id: MediaItemId; kind: 'audio'; url: string; options: PlayAudioOptions };

export interface MediaState {
  items: MediaEntry[];
}

export type MediaLocalEvent =
  /** The user dismissed the item (click) or its `durationMs` elapsed. */
  | { type: 'dismiss'; id: MediaItemId }
  /** Playback reached the end. */
  | { type: 'ended'; id: MediaItemId }
  /** The media element failed to load/play. */
  | { type: 'error'; id: MediaItemId; message: string }
  /** The item has rendered; main uses the size to fit the window. */
  | { type: 'content-size'; id: MediaItemId; width: number; height: number };

export interface MediaTransition {
  state: MediaState;
  reports: MediaWindowEvent[];
}

export const INITIAL_MEDIA_STATE: MediaState = { items: [] };

function without(state: MediaState, id: MediaItemId): MediaState {
  return { items: state.items.filter((i) => i.id !== id) };
}

function has(state: MediaState, id: MediaItemId): boolean {
  return state.items.some((i) => i.id === id);
}

function entryFromCommand(command: MediaCommand): MediaEntry | null {
  switch (command.type) {
    case 'show-image':
      return { id: command.id, kind: 'image', url: command.url, options: command.options ?? {} };
    case 'play-video':
      return { id: command.id, kind: 'video', url: command.url, options: command.options ?? {} };
    case 'play-audio':
      return { id: command.id, kind: 'audio', url: command.url, options: command.options ?? {} };
    default:
      return null;
  }
}

/** Visual subset of an `OverlayUpdate`; placement/layer are handled by the main-process backend. */
const VISUAL_UPDATE_KEYS = ['opacity', 'width', 'height', 'clickThrough'] as const;

export function applyUpdate(entry: MediaEntry, patch: OverlayUpdate): MediaEntry {
  const visual: Partial<OverlayOptions> = {};
  for (const key of VISUAL_UPDATE_KEYS) {
    const v = patch[key];
    if (v !== undefined) (visual as Record<string, unknown>)[key] = v;
  }
  if (Object.keys(visual).length === 0) return entry;
  if (entry.kind === 'audio') return entry;
  return { ...entry, options: { ...entry.options, ...visual } } as MediaEntry;
}

/** CSS opacity for an item container: clamp to 0..1, default 1. */
export function effectiveOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return 1;
  return Math.min(1, Math.max(0, opacity));
}

/**
 * Only pack assets are ever rendered: `rp-asset://` (Electron) or the app's
 * loopback media server (`http://127.0.0.1:<port>/t/<token>/asset/...`) used by
 * native overlay helpers. Anything else is rejected with an error report.
 */
export function isAllowedMediaUrl(url: string): boolean {
  if (/^rp-asset:\/\/[a-z0-9][a-z0-9.-]*\/.+/i.test(url)) return true;
  return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/t\/[A-Za-z0-9_-]+\/asset\/[a-z0-9][a-z0-9.-]*\/.+/i.test(url);
}

export function applyMediaCommand(state: MediaState, command: MediaCommand): MediaTransition {
  switch (command.type) {
    case 'close':
      if (!has(state, command.id)) return { state, reports: [] };
      return { state: without(state, command.id), reports: [{ type: 'closed', id: command.id }] };
    case 'close-all':
      return { state: { items: [] }, reports: state.items.map((i) => ({ type: 'closed', id: i.id })) };
    case 'update': {
      if (!has(state, command.id)) return { state, reports: [] };
      const items = state.items.map((i) => (i.id === command.id ? applyUpdate(i, command.options) : i));
      return { state: { items }, reports: [] };
    }
    default: {
      const entry = entryFromCommand(command);
      if (!entry) return { state, reports: [] };
      if (!isAllowedMediaUrl(entry.url)) {
        return { state, reports: [{ type: 'error', id: entry.id, message: `Refused non-asset URL: ${entry.url}` }] };
      }
      // Re-showing an existing id replaces it in place.
      const items = has(state, entry.id) ? state.items.map((i) => (i.id === entry.id ? entry : i)) : [...state.items, entry];
      return { state: { items }, reports: [] };
    }
  }
}

/** Whether playback finishing should remove the item (main also auto-closes, this keeps the overlay tidy if it does not). */
export function closesOnEnd(entry: MediaEntry): boolean {
  if (entry.kind === 'image') return false;
  if (entry.options.loop) return false;
  if (entry.kind === 'video') return entry.options.closeOnEnd !== false;
  return true;
}

export function applyMediaLocalEvent(state: MediaState, event: MediaLocalEvent): MediaTransition {
  const entry = state.items.find((i) => i.id === event.id);
  if (!entry) return { state, reports: [] };
  switch (event.type) {
    case 'dismiss':
      return { state: without(state, event.id), reports: [{ type: 'closed', id: event.id }] };
    case 'ended': {
      const reports: MediaWindowEvent[] = [{ type: 'ended', id: event.id }];
      if (!closesOnEnd(entry)) return { state, reports };
      reports.push({ type: 'closed', id: event.id });
      return { state: without(state, event.id), reports };
    }
    case 'content-size':
      return { state, reports: [{ type: 'content-size', id: event.id, width: event.width, height: event.height }] };
    case 'error':
      return {
        state: without(state, event.id),
        reports: [
          { type: 'error', id: event.id, message: event.message },
          { type: 'closed', id: event.id },
        ],
      };
    default:
      return { state, reports: [] };
  }
}

/** Effective volume for a media element: clamp to 0..1, default 1. */
export function effectiveVolume(volume: number | undefined): number {
  if (volume === undefined || !Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}
