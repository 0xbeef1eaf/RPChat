/**
 * Helper types shared by every module's typings. Declared once, before the
 * `Sdk` interface, in the generated `sdk.d.ts`. Module `typings` may reference
 * these names freely but must not redeclare them.
 *
 * The media option interfaces mirror `@rp/shared/media` exactly (a test enforces
 * it); `Json` mirrors `@rp/shared/ids`.
 */
export const SDK_PREAMBLE_TYPINGS = `/** Any JSON-serialisable value. Everything passed to or returned from the sdk must be Json. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A file inside the current pack, as returned by sdk.pack.asset() / sdk.pack.listAssets().
 * Pass it (or just its path string) to the media functions.
 */
interface AssetRef {
  /** Path relative to the pack root, forward slashes, e.g. "media/images/smile.png". */
  readonly path: string;
  /** Detected from the file extension. */
  readonly kind: 'image' | 'video' | 'audio' | 'text' | 'other';
  /** MIME type, e.g. "image/png". */
  readonly mime: string;
  /** File size in bytes. */
  readonly bytes: number;
}

/** Anchor preset on the chosen monitor. */
type MediaPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Stacking layer of an overlay (wlr-layer-shell naming): 'background' and 'bottom' sit
 * under normal windows, 'top' and 'overlay' float above them. Check
 * sdk.display.backend() for the layers the current desktop actually supports; unsupported
 * layers fall back to the nearest supported one.
 */
type OverlayLayer = 'background' | 'bottom' | 'top' | 'overlay';

/** 'primary', 'cursor' (monitor under the pointer), a zero-based index, or a monitor name such as 'DP-1'. */
type MonitorSelector = 'primary' | 'cursor' | number | string;

interface OverlayPlacement {
  /** Which monitor to use (see sdk.display.monitors()). Default 'primary'. */
  monitor?: MonitorSelector;
  /** Anchor preset on that monitor. Default 'center'. Ignored when x/y are given. */
  position?: MediaPosition;
  /** Explicit left offset from the monitor's left edge: 0..1 = fraction of its width, > 1 = logical px. */
  x?: number;
  /** Explicit top offset from the monitor's top edge: 0..1 = fraction of its height, > 1 = logical px. */
  y?: number;
  /** Gap kept from the monitor edges for anchor presets, in px. Default 24. */
  marginPx?: number;
}

interface OverlayOptions extends OverlayPlacement {
  /** Stacking layer. Default 'top'. */
  layer?: OverlayLayer;
  /** Window opacity 0..1 (1 = fully opaque). Default 1. */
  opacity?: number;
  /** When true, clicks pass through the overlay to whatever is underneath and it never takes focus. Default false. */
  clickThrough?: boolean;
  /** Max width in CSS px. Default 480. */
  width?: number;
  /** Max height in CSS px. Default: fit content. */
  height?: number;
}

interface ShowImageOptions extends OverlayOptions {
  /** Auto-close after this many milliseconds. Omit to keep the image open until closed. */
  durationMs?: number;
  /** Caption rendered under the image. */
  caption?: string;
}

interface PlayVideoOptions extends OverlayOptions {
  /** 0..1, default 1. */
  volume?: number;
  /** Restart when playback ends. Default false. */
  loop?: boolean;
  /** Close the window automatically when playback ends. Default true. */
  closeOnEnd?: boolean;
  /** Start muted. Default false. */
  muted?: boolean;
}

interface PlayAudioOptions {
  /** 0..1, default 1. */
  volume?: number;
  /** Restart when playback ends. Default false. */
  loop?: boolean;
}

/** Live changes to an open overlay, for sdk.media.update(). Only the given fields change. */
interface OverlayUpdate extends OverlayPlacement {
  layer?: OverlayLayer;
  opacity?: number;
  clickThrough?: boolean;
  width?: number;
  height?: number;
}

/** One monitor as reported by sdk.display.monitors(). Geometry is in logical pixels. */
interface MonitorInfo {
  /** Stable id; pass it (or name/index) as a MonitorSelector. */
  id: string;
  /** Connector or display name, e.g. 'DP-1'. */
  name: string;
  /** Zero-based index. */
  index: number;
  primary: boolean;
  /** Work-area geometry in the global coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  /** Whether the mouse pointer is currently on this monitor. */
  hasCursor: boolean;
}

/** What the active display backend can do, from sdk.display.backend(). */
interface DisplayBackendInfo {
  /** 'electron' (generic), 'hyprland' (Hyprland IPC), or a plugin name. */
  name: string;
  platform: 'linux' | 'win32' | 'darwin' | string;
  windowSystem: 'wayland' | 'x11' | 'native' | 'unknown';
  supports: {
    /** Layers that are honoured (others fall back). */
    layers: OverlayLayer[];
    opacity: boolean;
    clickThrough: boolean;
    monitorSelection: boolean;
    /** Whether explicit x/y placement works (false when the compositor forbids client positioning). */
    exactPosition: boolean;
  };
}

/** A media item currently shown/playing. Returned by sdk.media.* and accepted by sdk.media.close(). */
interface MediaHandle {
  /** Opaque id of the media item. */
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio';
  /** Pack-relative path of the asset being shown. */
  readonly asset: string;
}

/** A long-term memory as returned by sdk.memory.*. */
interface MemoryEntry {
  id: string;
  /** The remembered note, in your voice. */
  text: string;
  tags: string[];
  /** 1 (trivia) .. 5 (defining). */
  importance: 1 | 2 | 3 | 4 | 5;
  /** 'character' = you stored it; 'consolidation' = the app distilled it from a conversation; 'user' = the user wrote it. */
  source: 'character' | 'consolidation' | 'user';
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** One transcript message as returned by sdk.chat.history(). */
interface HistoryMessage {
  /** 'user' is the human; 'assistant' is you (the character). */
  role: 'user' | 'assistant';
  /** Plain text of the message (action code and results are not included). */
  text: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/** A scheduled timer as returned by sdk.timers.schedule() / sdk.timers.list(). */
interface TimerInfo {
  /** Opaque id; pass to sdk.timers.cancel(). */
  id: string;
  /** ISO-8601 time at which the timer fires. */
  fireAt: string;
  /** The Json payload given to schedule(); handed back to you when it fires. */
  payload: unknown;
  /** Optional human-readable label (shown in the UI). */
  label?: string;
}
`;
