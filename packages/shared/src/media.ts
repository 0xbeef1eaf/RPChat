import type { Json, MediaItemId } from './ids.js';

/**
 * Where a media overlay is anchored on the chosen monitor. `random` (the default when neither a
 * preset nor x/y is given) picks a spot once per window such that the whole window stays on the
 * monitor, and keeps it when the content size arrives.
 */
export type MediaPosition = 'random' | 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Stacking layer of an overlay, modelled on wlr-layer-shell.
 * `background`/`bottom` sit under normal windows, `top`/`overlay` above them.
 * Backends that cannot honour a layer fall back to the nearest one they support.
 */
export type OverlayLayer = 'background' | 'bottom' | 'top' | 'overlay';

/** `primary`, the monitor under the cursor, a zero-based index, or a monitor name (e.g. `DP-1`). */
/** `random` (the default for media overlays) picks one of the connected monitors per window. */
export type MonitorSelector = 'random' | 'primary' | 'cursor' | number | string;

export interface OverlayPlacement {
  /** Which monitor to use. Default `primary`. */
  monitor?: MonitorSelector;
  /** Anchor preset on that monitor. Default `center`. Ignored when `x`/`y` are given. */
  position?: MediaPosition;
  /** Explicit left offset from the monitor's left edge: 0..1 = fraction of monitor width, > 1 = logical px. */
  x?: number;
  /** Explicit top offset from the monitor's top edge: 0..1 = fraction of monitor height, > 1 = logical px. */
  y?: number;
  /** Gap kept from the monitor edges for anchor presets, in px. Default 24. */
  marginPx?: number;
}

export interface OverlayOptions extends OverlayPlacement {
  /** Stacking layer. Default `top`. */
  layer?: OverlayLayer;
  /** Window opacity 0..1. Default 1. */
  opacity?: number;
  /** When true, mouse input passes through the overlay to whatever is underneath. Default false. */
  clickThrough?: boolean;
  /** Max width in CSS px. Default for images/video: a random size, 5%–50% of the monitor (drawn once per overlay). */
  width?: number;
  /** Max height in CSS px. Default: fit content within the random box; give both width and height to fix the size. */
  height?: number;
}

export interface ShowImageOptions extends OverlayOptions {
  /** Auto-close after this many ms. Omit to keep open until closed. */
  durationMs?: number;
  /** Caption rendered under the image. */
  caption?: string;
  /**
   * Whether a click closes the image. Default: true, except for a timed image (`durationMs`), which
   * closes by itself. Either way a click raises the `media-clicked` host event.
   */
  closeOnClick?: boolean;
}

/**
 * Options for `sdk.media.overlay`: one image or video washed over whole screens. Placement, size,
 * layer and click-through are not negotiable — the overlay covers each screen it is given, sits on
 * the `overlay` layer and always lets clicks through.
 */
export interface MediaOverlayOptions {
  /** Which screen to cover: `all` (the default) for every connected monitor, or one `MonitorSelector`. */
  monitor?: MonitorSelector | 'all';
  /** 0..1, default 0.25. Over 0.5 the screen is mostly the overlay: keep it low unless the user asked for more. */
  opacity?: number;
  /** Auto-close after this many ms. Omit to keep it up until `close()`. */
  durationMs?: number;
  /** Video volume 0..1, default 0.5. With several screens covered only one of them plays sound. */
  volume?: number;
  /** Restart the video when it ends. Default: true with `durationMs`, false without. */
  loop?: boolean;
  /** Start the video muted. Default false. */
  muted?: boolean;
}

/**
 * What the media page needs to paint one full-screen overlay. The picture is fitted into the screen
 * keeping its aspect ratio and copies repeat outwards from that centred one, so a shape that does
 * not match the screen tiles instead of stretching.
 */
export interface FullscreenOverlayOptions {
  /** Whether `url` is an image or a video. */
  media: 'image' | 'video';
  /** 0..1 CSS opacity of the whole surface. */
  opacity: number;
  /** Video volume 0..1; the copies on the other screens get 0 so one soundtrack plays. */
  volume?: number;
  loop?: boolean;
  muted?: boolean;
}

export interface PlayVideoOptions extends OverlayOptions {
  /** 0..1, default 1. */
  volume?: number;
  loop?: boolean;
  /** Close the window automatically when playback ends. Default true. */
  closeOnEnd?: boolean;
  muted?: boolean;
  /**
   * Stop the video and close its window after this many ms, even if it is still playing. Omit to
   * let it run to its end (or forever with `loop`). Combine with `loop` to fill the whole time.
   */
  durationMs?: number;
}

/** Live changes to an open overlay via `sdk.media.update`. */
export interface OverlayUpdate extends OverlayPlacement {
  layer?: OverlayLayer;
  opacity?: number;
  clickThrough?: boolean;
  width?: number;
  height?: number;
}

export interface MonitorInfo {
  /** Stable id for this monitor (backend specific). */
  id: string;
  /** Connector or display name, e.g. `DP-1`, `Built-in Retina Display`. */
  name: string;
  /** Zero-based index in the backend's monitor order. */
  index: number;
  primary: boolean;
  /** Logical (scaled) work-area geometry in the global coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  /** Whether the pointer is currently on this monitor. */
  hasCursor: boolean;
}

/** What the active display backend can do; the LLM sees this via `sdk.display.backend()`. */
export interface DisplayBackendInfo {
  /** `electron` (generic BrowserWindow), `hyprland` (Hyprland IPC), or a plugin name. */
  name: string;
  platform: 'linux' | 'win32' | 'darwin' | string;
  /** Whether the session is Wayland, X11 or native. */
  windowSystem: 'wayland' | 'x11' | 'native' | 'unknown';
  supports: {
    layers: OverlayLayer[];
    opacity: boolean;
    clickThrough: boolean;
    monitorSelection: boolean;
    exactPosition: boolean;
  };
}

export interface PlayAudioOptions {
  volume?: number;
  loop?: boolean;
  /**
   * Stop the sound after this many ms, even if it is still playing. Omit to let it run to its end
   * (or forever with `loop`). Combine with `loop` to fill the whole time.
   */
  durationMs?: number;
}

export type MediaKind = 'image' | 'video' | 'audio';

/** Everything the display backend can put on screen. `image`/`video`/`fullscreen` come from `sdk.media`. */
export type OverlayKind = 'image' | 'video' | 'fullscreen' | 'avatar' | 'widget' | 'draw';

export type AvatarAnimation = 'bounce' | 'shake' | 'nod' | 'wave' | 'pulse' | 'spin' | 'fade-in' | 'fade-out';

export interface AvatarState {
  visible: boolean;
  expression: string;
  /** rp-asset:// or loopback URL of the current expression image. */
  imageUrl: string;
  size: number;
  lookAtCursor: boolean;
  bubble?: { text: string; until?: string };
  overlay: Required<Pick<OverlayOptions, 'layer' | 'opacity' | 'clickThrough'>> & { monitorId?: string; x?: number; y?: number; position?: MediaPosition };
}

export interface DrawShape {
  type: 'arrow' | 'circle' | 'rect' | 'text' | 'line';
  /** Coordinates in monitor logical px; fractions 0..1 are relative to the monitor. */
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  width?: number;
  height?: number;
  radius?: number;
  text?: string;
  color?: string;
  strokeWidth?: number;
  /** Auto-remove after this many ms. */
  durationMs?: number;
}

export interface WidgetSpec {
  id: string;
  title?: string;
  /** Character-authored HTML rendered in a sandboxed iframe (`allow-scripts` only). */
  html: string;
  width: number;
  height: number;
}

/**
 * Whether a media item is on screen/playing (`open`) or waiting for one of its kind to go away
 * (`queued`, see `AppSettings.media`). A queued item already has its id and can be closed — closing
 * it takes it out of the queue instead of off the screen.
 */
export type MediaState = 'open' | 'queued';

export interface MediaItem {
  id: MediaItemId;
  kind: MediaKind;
  /** Asset path relative to the pack root. */
  asset: string;
  packId: string;
  /** When the item started; for a queued item, when it will have started — set as it opens. */
  startedAt: string;
  state: MediaState;
  /** Set on a queued item: when it joined the queue. */
  queuedAt?: string;
  /** Effective overlay settings after backend fallbacks. Absent until a queued item opens. */
  overlay?: Required<Pick<OverlayOptions, 'layer' | 'opacity' | 'clickThrough'>> & { monitorId?: string };
}

/**
 * Commands sent from main to an overlay page (media.html). `url` is an `rp-asset://` URL in
 * Electron windows or a loopback URL inside the native helper.
 */
export type MediaCommand =
  | { type: 'show-image'; id: MediaItemId; url: string; options: ShowImageOptions }
  | { type: 'play-video'; id: MediaItemId; url: string; options: PlayVideoOptions }
  | { type: 'play-audio'; id: MediaItemId; url: string; options: PlayAudioOptions }
  /** One screen-filling, click-through image/video surface (`sdk.media.overlay`). */
  | { type: 'show-fullscreen'; id: MediaItemId; url: string; options: FullscreenOverlayOptions }
  | { type: 'update'; id: MediaItemId; options: OverlayUpdate }
  | { type: 'close'; id: MediaItemId }
  | { type: 'close-all' }
  // avatar page
  | { type: 'avatar-show'; id: MediaItemId; state: AvatarState }
  | { type: 'avatar-set'; id: MediaItemId; patch: Partial<Pick<AvatarState, 'expression' | 'imageUrl' | 'size' | 'lookAtCursor' | 'bubble'>> & { animation?: AvatarAnimation; opacity?: number; clickThrough?: boolean } }
  | { type: 'avatar-hide'; id: MediaItemId }
  // widget page
  | { type: 'widget-show'; id: MediaItemId; widget: WidgetSpec; options: OverlayOptions }
  | { type: 'widget-update'; id: MediaItemId; html?: string; title?: string; postMessage?: Json }
  // draw page (one full-monitor click-through surface per monitor)
  | { type: 'draw-set'; id: MediaItemId; shapes: Array<DrawShape & { shapeId: string }> }
  | { type: 'draw-clear'; id: MediaItemId };

/**
 * Why a media item went away: `click` (the user dismissed it), `timeout` (`durationMs` elapsed),
 * `ended` (playback finished), `api` (`sdk.media.close`/`closeAll`, the app or the window closing),
 * `error` (it failed to load or play).
 */
export type MediaCloseReason = 'click' | 'timeout' | 'ended' | 'api' | 'error';

/** Events sent from a media window back to main. */
export type MediaWindowEvent =
  | { type: 'content-size'; id: MediaItemId; width: number; height: number }
  | { type: 'avatar-clicked'; id: MediaItemId }
  | { type: 'widget-message'; id: MediaItemId; message: Json }
  /** The user clicked an image/video item (whether or not the click also closes it). */
  | { type: 'clicked'; id: MediaItemId }
  | { type: 'ended'; id: MediaItemId }
  | { type: 'error'; id: MediaItemId; message: string }
  /** The page removed the item; `reason` says why (absent from older pages: treated as `api`). */
  | { type: 'closed'; id: MediaItemId; reason?: MediaCloseReason };

export const ASSET_PROTOCOL = 'rp-asset';

/** Build the URL under which an installed pack asset is served to renderer windows. */
export function assetUrl(packId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${ASSET_PROTOCOL}://${packId}/${clean}`;
}

/**
 * Marker on a media asset argument for a file in the character's own home directory
 * (`sdk.files`, `sdk.webcam` captures) rather than a pack asset: `home:webcam/2026-…-ab12cd34.jpg`.
 * The dispatcher normalises every `source: 'home'` `AssetRef` to this form, so a host handler sees
 * one string and knows from its prefix which root to resolve it against.
 */
export const HOME_ASSET_PREFIX = 'home:';

/** `home:<path>` for a file in the character home; pack assets stay bare pack-relative paths. */
export function homeAsset(relativePath: string): string {
  return `${HOME_ASSET_PREFIX}${relativePath}`;
}

/**
 * Marker on a media asset argument for an item of a plugin's remote media source rather than a
 * file on disk: `remote:<pluginId>/<sourceId>/<itemId>`, e.g. `remote:com.me.photos/albums/8f3a…`.
 * The part after the prefix is the `path` of the `AssetRef` that `sdk.mediaSources.search` returned.
 */
export const REMOTE_ASSET_PREFIX = 'remote:';

/** Where an asset argument points: the pack, the character home, or a plugin's remote media source. */
export type AssetSource = 'pack' | 'home' | 'remote';

/** A media source's local id inside its plugin (`plugin.json` `mediaSources[].id`). */
export const MEDIA_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** Longest item id a media source may hand out. */
export const REMOTE_ITEM_ID_MAX_LENGTH = 512;

/** `remote:<sourceId>/<itemId>` for an item of a remote media source (`sourceId` is `<pluginId>/<id>`). */
export function remoteAsset(sourceId: string, itemId: string): string {
  return `${REMOTE_ASSET_PREFIX}${sourceId}/${itemId}`;
}

/** Why `itemId` cannot name an item of a remote media source, or undefined when it can. */
export function remoteItemIdProblem(itemId: unknown): string | undefined {
  if (typeof itemId !== 'string' || itemId.length === 0) return 'an item id must be a non-empty string';
  if (itemId.length > REMOTE_ITEM_ID_MAX_LENGTH) return `an item id must be at most ${REMOTE_ITEM_ID_MAX_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(itemId)) return 'an item id must not contain control characters';
  return undefined;
}

/**
 * Split the path of a remote asset (`<pluginId>/<sourceId>/<itemId>`, without the `remote:` prefix)
 * into the source it belongs to and the item's id there. The item id is everything after the second
 * slash, so it may hold slashes of its own. Undefined when the path is not shaped like one.
 */
export function parseRemoteAssetPath(path: string): { sourceId: string; itemId: string } | undefined {
  const first = path.indexOf('/');
  if (first <= 0) return undefined;
  const second = path.indexOf('/', first + 1);
  if (second < 0) return undefined;
  const pluginId = path.slice(0, first);
  const local = path.slice(first + 1, second);
  const itemId = path.slice(second + 1);
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(pluginId) || !MEDIA_SOURCE_ID_PATTERN.test(local)) return undefined;
  if (remoteItemIdProblem(itemId) !== undefined) return undefined;
  return { sourceId: `${pluginId}/${local}`, itemId };
}

/** Split a media asset argument into the root it belongs to and its path relative to that root. */
export function parseAssetSource(asset: string): { source: AssetSource; path: string } {
  if (asset.startsWith(HOME_ASSET_PREFIX)) return { source: 'home', path: asset.slice(HOME_ASSET_PREFIX.length) };
  if (asset.startsWith(REMOTE_ASSET_PREFIX)) return { source: 'remote', path: asset.slice(REMOTE_ASSET_PREFIX.length) };
  return { source: 'pack', path: asset };
}
