/**
 * Pure state for the media overlay window. The React page feeds it
 * `MediaCommand`s from main and local user/playback events; it returns the
 * next item list plus the `MediaWindowEvent`s that must be reported back.
 */
import type {
  DrawShape,
  FullscreenOverlayOptions,
  Json,
  MediaCloseReason,
  MediaCommand,
  MediaItemId,
  MediaWindowEvent,
  OverlayOptions,
  OverlayUpdate,
  PlayAudioOptions,
  PlayVideoOptions,
  ShowImageOptions,
} from '@rp/shared';
import { applyAvatarCommand, isAvatarCommand, type AvatarPageState } from './avatar';
import { applyWidgetCommand, drainWidgetOutbox, isWidgetCommand, validateWidgetMessage, type WidgetEntry } from './widget';

export type MediaEntry =
  | { id: MediaItemId; kind: 'image'; url: string; options: ShowImageOptions }
  | { id: MediaItemId; kind: 'video'; url: string; options: PlayVideoOptions }
  | { id: MediaItemId; kind: 'audio'; url: string; options: PlayAudioOptions };

/** A screen-filling, click-through image/video surface (`sdk.media.overlay`). */
export interface FullscreenEntry {
  id: MediaItemId;
  url: string;
  options: FullscreenOverlayOptions;
}

export interface DrawSurface {
  id: MediaItemId;
  shapes: Array<DrawShape & { shapeId: string }>;
}

export interface MediaState {
  items: MediaEntry[];
  /** `avatar` page: at most one avatar per window. */
  avatar: AvatarPageState | null;
  /** `widget` page. */
  widgets: WidgetEntry[];
  /** `draw` page: one surface per monitor id. */
  draws: DrawSurface[];
  /** `fullscreen` page: the one surface covering this window's screen. */
  fullscreens: FullscreenEntry[];
}

export type MediaLocalEvent =
  /** The item goes away: the user dismissed it (`click`, the default) or its `durationMs` elapsed (`timeout`). */
  | { type: 'dismiss'; id: MediaItemId; reason?: MediaCloseReason }
  /** The user clicked an image/video (reported whether or not the click also dismisses it). */
  | { type: 'click'; id: MediaItemId }
  /** Playback reached the end. */
  | { type: 'ended'; id: MediaItemId }
  /** The media element failed to load/play. */
  | { type: 'error'; id: MediaItemId; message: string }
  /** The item has rendered; main uses the size to fit the window. */
  | { type: 'content-size'; id: MediaItemId; width: number; height: number }
  /** The user clicked the avatar. */
  | { type: 'avatar-click'; id: MediaItemId }
  /** The avatar's speech bubble expired. */
  | { type: 'bubble-expired'; id: MediaItemId }
  /** A widget iframe posted a message (raw, validated here). */
  | { type: 'widget-message'; id: MediaItemId; data: unknown }
  /** The view delivered outbox messages up to `seq` to the iframe. */
  | { type: 'widget-delivered'; id: MediaItemId; seq: number };

export interface MediaTransition {
  state: MediaState;
  reports: MediaWindowEvent[];
}

export const INITIAL_MEDIA_STATE: MediaState = { items: [], avatar: null, widgets: [], draws: [], fullscreens: [] };

function without(state: MediaState, id: MediaItemId): MediaState {
  return { ...state, items: state.items.filter((i) => i.id !== id) };
}

function has(state: MediaState, id: MediaItemId): boolean {
  return state.items.some((i) => i.id === id);
}

/** Every open overlay id in this window, regardless of page kind. */
export function openIds(state: MediaState): MediaItemId[] {
  return [
    ...state.items.map((i) => i.id),
    ...(state.avatar ? [state.avatar.id] : []),
    ...state.widgets.map((w) => w.id),
    ...state.draws.map((d) => d.id),
    ...state.fullscreens.map((f) => f.id),
  ];
}

function closeAny(state: MediaState, id: MediaItemId, reason: MediaCloseReason): MediaTransition {
  if (!openIds(state).includes(id)) return { state, reports: [] };
  const next: MediaState = {
    items: state.items.filter((i) => i.id !== id),
    avatar: state.avatar && state.avatar.id === id ? null : state.avatar,
    widgets: state.widgets.filter((w) => w.id !== id),
    draws: state.draws.filter((d) => d.id !== id),
    fullscreens: state.fullscreens.filter((f) => f.id !== id),
  };
  return { state: next, reports: [{ type: 'closed', id, reason }] };
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

function visualSubset(patch: OverlayUpdate): Partial<OverlayOptions> {
  const visual: Partial<OverlayOptions> = {};
  for (const key of VISUAL_UPDATE_KEYS) {
    const v = patch[key];
    if (v !== undefined) (visual as Record<string, unknown>)[key] = v;
  }
  return visual;
}

export function applyUpdate(entry: MediaEntry, patch: OverlayUpdate): MediaEntry {
  const visual = visualSubset(patch);
  if (Object.keys(visual).length === 0) return entry;
  if (entry.kind === 'audio') return entry;
  return { ...entry, options: { ...entry.options, ...visual } } as MediaEntry;
}

/**
 * Whether clicking an overlay dismisses it. A timed image closes itself when `durationMs` elapses,
 * and a click landing on it in the meantime is far more likely to be the user getting on with their
 * work than asking for it to go — so a duration takes click-to-close off. An explicit
 * `closeOnClick` on an image overrides both defaults (a game can keep a target up after a click, or
 * let a timed one go on a hit). Click-through overlays take no clicks at all, and audio has its own
 * stop button. Every click on an image/video is reported as `clicked` regardless.
 */
export function closesOnClick(entry: MediaEntry): boolean {
  if (entry.kind === 'audio') return false;
  if (entry.options.clickThrough) return false;
  if (entry.kind === 'image' && typeof entry.options.closeOnClick === 'boolean') return entry.options.closeOnClick;
  // Same condition as the auto-close timer in MediaItemView, so the two cannot disagree.
  return !(entry.kind === 'image' && Boolean(entry.options.durationMs));
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
  if (isAvatarCommand(command)) {
    const { avatar, closed } = applyAvatarCommand(state.avatar, command);
    if (avatar === state.avatar) return { state, reports: [] };
    return { state: { ...state, avatar }, reports: closed ? [{ type: 'closed', id: command.id, reason: 'api' }] : [] };
  }
  if (isWidgetCommand(command)) {
    const widgets = applyWidgetCommand(state.widgets, command);
    return { state: widgets === state.widgets ? state : { ...state, widgets }, reports: [] };
  }
  switch (command.type) {
    case 'close':
      return closeAny(state, command.id, 'api');
    case 'close-all':
      return { state: INITIAL_MEDIA_STATE, reports: openIds(state).map((id) => ({ type: 'closed', id, reason: 'api' })) };
    case 'update': {
      if (state.widgets.some((w) => w.id === command.id)) {
        const widgets = state.widgets.map((w) => (w.id === command.id ? { ...w, options: { ...w.options, ...visualSubset(command.options) } } : w));
        return { state: { ...state, widgets }, reports: [] };
      }
      const fullscreen = state.fullscreens.find((f) => f.id === command.id);
      if (fullscreen) {
        // Everything else about it is fixed: it covers its screen and lets clicks through.
        const { opacity } = visualSubset(command.options);
        if (opacity === undefined) return { state, reports: [] };
        const fullscreens = state.fullscreens.map((f) => (f.id === command.id ? { ...f, options: { ...f.options, opacity: effectiveOpacity(opacity) } } : f));
        return { state: { ...state, fullscreens }, reports: [] };
      }
      if (state.avatar && state.avatar.id === command.id) {
        const v = visualSubset(command.options);
        const avatar = { ...state.avatar, opacity: v.opacity ?? state.avatar.opacity, clickThrough: v.clickThrough ?? state.avatar.clickThrough };
        return { state: { ...state, avatar }, reports: [] };
      }
      if (!has(state, command.id)) return { state, reports: [] };
      const items = state.items.map((i) => (i.id === command.id ? applyUpdate(i, command.options) : i));
      return { state: { ...state, items }, reports: [] };
    }
    case 'show-fullscreen': {
      if (!isAllowedMediaUrl(command.url)) {
        return { state, reports: [{ type: 'error', id: command.id, message: `Refused non-asset URL: ${command.url}` }] };
      }
      const entry: FullscreenEntry = { id: command.id, url: command.url, options: command.options };
      const idx = state.fullscreens.findIndex((f) => f.id === command.id);
      const fullscreens = idx === -1 ? [...state.fullscreens, entry] : state.fullscreens.map((f, i) => (i === idx ? entry : f));
      return { state: { ...state, fullscreens }, reports: [] };
    }
    case 'draw-set': {
      const shapes = command.shapes.filter((sh) => typeof sh.shapeId === 'string' && sh.shapeId.length > 0);
      const idx = state.draws.findIndex((d) => d.id === command.id);
      const surface: DrawSurface = { id: command.id, shapes };
      const draws = idx === -1 ? [...state.draws, surface] : state.draws.map((d, i) => (i === idx ? surface : d));
      return { state: { ...state, draws }, reports: [] };
    }
    case 'draw-clear': {
      if (!state.draws.some((d) => d.id === command.id)) return { state, reports: [] };
      const draws = state.draws.map((d) => (d.id === command.id ? { ...d, shapes: [] } : d));
      return { state: { ...state, draws }, reports: [] };
    }
    default: {
      const entry = entryFromCommand(command);
      if (!entry) return { state, reports: [] };
      if (!isAllowedMediaUrl(entry.url)) {
        return { state, reports: [{ type: 'error', id: entry.id, message: `Refused non-asset URL: ${entry.url}` }] };
      }
      // Re-showing an existing id replaces it in place.
      const items = has(state, entry.id) ? state.items.map((i) => (i.id === entry.id ? entry : i)) : [...state.items, entry];
      return { state: { ...state, items }, reports: [] };
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
  switch (event.type) {
    case 'avatar-click':
      if (!state.avatar || state.avatar.id !== event.id) return { state, reports: [] };
      return { state, reports: [{ type: 'avatar-clicked', id: event.id }] };
    case 'bubble-expired': {
      if (!state.avatar || state.avatar.id !== event.id || !state.avatar.state.bubble) return { state, reports: [] };
      const { bubble: _b, ...rest } = state.avatar.state;
      return { state: { ...state, avatar: { ...state.avatar, state: rest } }, reports: [] };
    }
    case 'widget-message': {
      if (!state.widgets.some((w) => w.id === event.id)) return { state, reports: [] };
      const v = validateWidgetMessage(event.data);
      if (!v.ok) return { state, reports: [{ type: 'error', id: event.id, message: `widget message rejected: ${v.reason}` }] };
      return { state, reports: [{ type: 'widget-message', id: event.id, message: v.message as Json }] };
    }
    case 'widget-delivered':
      return { state: { ...state, widgets: drainWidgetOutbox(state.widgets, event.id, event.seq) }, reports: [] };
    case 'content-size':
      if (openIds(state).includes(event.id)) {
        return { state, reports: [{ type: 'content-size', id: event.id, width: event.width, height: event.height }] };
      }
      return { state, reports: [] };
    default:
      break;
  }
  const fullscreen = state.fullscreens.find((f) => f.id === event.id);
  if (fullscreen) {
    // A full-screen overlay takes no clicks; it ends, fails, or the host closes it.
    switch (event.type) {
      case 'ended': {
        const ended: MediaWindowEvent = { type: 'ended', id: event.id };
        if (fullscreen.options.loop) return { state, reports: [ended] };
        const closed = closeAny(state, event.id, 'ended');
        return { state: closed.state, reports: [ended, ...closed.reports] };
      }
      case 'error': {
        const closed = closeAny(state, event.id, 'error');
        return { state: closed.state, reports: [{ type: 'error', id: event.id, message: event.message }, ...closed.reports] };
      }
      case 'dismiss':
        return closeAny(state, event.id, event.reason ?? 'click');
      default:
        return { state, reports: [] };
    }
  }

  const entry = state.items.find((i) => i.id === event.id);
  if (!entry) {
    // Avatars and widgets can be dismissed locally too (Escape / close button).
    if (event.type === 'dismiss') return closeAny(state, event.id, event.reason ?? 'click');
    return { state, reports: [] };
  }
  switch (event.type) {
    case 'click':
      if (entry.kind === 'audio' || entry.options.clickThrough) return { state, reports: [] };
      return { state, reports: [{ type: 'clicked', id: event.id }] };
    case 'dismiss':
      return { state: without(state, event.id), reports: [{ type: 'closed', id: event.id, reason: event.reason ?? 'click' }] };
    case 'ended': {
      const reports: MediaWindowEvent[] = [{ type: 'ended', id: event.id }];
      if (!closesOnEnd(entry)) return { state, reports };
      reports.push({ type: 'closed', id: event.id, reason: 'ended' });
      return { state: without(state, event.id), reports };
    }
    case 'error':
      return {
        state: without(state, event.id),
        reports: [
          { type: 'error', id: event.id, message: event.message },
          { type: 'closed', id: event.id, reason: 'error' },
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
