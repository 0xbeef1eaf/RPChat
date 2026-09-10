/**
 * Helper types shared by every module's typings. Declared once, before the
 * `Sdk` interface, in the generated `sdk.d.ts`. Module `typings` may reference
 * these names freely but must not redeclare them.
 *
 * The media/overlay option interfaces mirror `@rp/shared/media`, and the presence,
 * calendar, event, mood and routine types mirror `@rp/shared/senses` exactly (a test
 * enforces it); `Json` mirrors `@rp/shared/ids`.
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
  /** Lower-case tags describing the asset: its folder names plus the pack author's tags from media.json. */
  readonly tags: readonly string[];
  /** The pack author's one-line description of this asset, if any. */
  readonly description?: string;
}

/** A tag in use in the pack, with how many assets carry it and what the author says it means. */
interface AssetTag {
  tag: string;
  count: number;
  description?: string;
}

/** Anchor preset on the chosen monitor. */
type MediaPosition = 'random' | 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

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
  /** Anchor preset on that monitor. Default 'random': a spot chosen once per window, fully on screen. Ignored when x/y are given. */
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

/** A scheduled timer as returned by sdk.timers.* and sdk.llm.wake(). */
interface TimerInfo {
  /** Opaque id; pass to sdk.timers.cancel(). */
  id: string;
  /** 'wake' = onTimer behaviour or LLM wake with payload; 'code' = stored code runs; 'prompt' = you are woken with your own prompt. */
  kind: 'wake' | 'code' | 'prompt';
  /** ISO-8601 time at which the timer fires. */
  fireAt: string;
  /** The Json payload given to schedule(); handed back to you when it fires. */
  payload: unknown;
  /** Optional human-readable label (shown in the UI). */
  label?: string;
  /** Present for repeating timers. */
  repeat?: { everyMs: number; remaining?: number };
}

/** What the host can tell about the user right now (from sdk.presence.status()). null/undefined = unknown on this platform. */
interface PresenceSnapshot {
  /** ISO-8601 time of the sample. */
  at: string;
  /** Milliseconds since the last keyboard/mouse input. */
  idleMs: number;
  /** idleMs below the user's idle threshold (default 2 min). */
  atKeyboard: boolean;
  /** Focused window, or null when unknown. */
  activeWindow: { title: string; app: string; class?: string } | null;
  screenLocked: boolean | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  nowPlaying: NowPlaying | null;
  /** Milliseconds since the user's last chat message in this session (null if none yet). */
  sinceLastMessageMs: number | null;
  /** Local wall-clock time, e.g. "22:41". */
  localTime: string;
  dayPart: 'night' | 'early-morning' | 'morning' | 'afternoon' | 'evening' | 'late-evening';
}

/** The media the user's player reports (from sdk.presence.nowPlaying()). */
interface NowPlaying {
  title: string;
  artist?: string;
  album?: string;
  /** Player application name, e.g. "spotify". */
  app?: string;
  status: 'playing' | 'paused' | 'stopped';
  positionMs?: number;
  durationMs?: number;
}

/** One calendar entry (from sdk.calendar.*). Times are ISO-8601 in the user's local zone. */
interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  /** Name of the source calendar. */
  calendar: string;
}

/**
 * Host events you can subscribe to with sdk.events.on(). The data your code receives:
 * 'user-idle' { idleMs } (fires once when idle crosses filter.idleMs, default 5 min);
 * 'user-back' { idleMs } (first input after user-idle); 'window-changed' { title, app, class? };
 * 'app-launched' { app }; 'file-added' { path, dir, name } (watched directories);
 * 'battery-low' { percent } (crosses below filter.percent, default 20); 'screen-locked' {};
 * 'screen-unlocked' {}; 'song-changed' NowPlaying; 'time' { hour, minute, weekday, iso }
 * (filter { hour?, minute?, weekday? }, checked every minute); 'widget-message' { widgetId, message };
 * 'avatar-clicked' {}; 'routine-changed' { from, to, label? }.
 */
type HostEventName =
  | 'user-idle'
  | 'user-back'
  | 'window-changed'
  | 'app-launched'
  | 'file-added'
  | 'battery-low'
  | 'screen-locked'
  | 'screen-unlocked'
  | 'song-changed'
  | 'time'
  | 'widget-message'
  | 'avatar-clicked'
  | 'routine-changed';

/** A host event or one of your own custom events ('custom:<name>', raised with sdk.events.emit()). */
type EventName = HostEventName | \`custom:\${string}\`;

/** A live event subscription (from sdk.events.on() / sdk.events.list()). */
interface EventSubscriptionInfo {
  /** Opaque id; pass to sdk.events.off(). */
  id: string;
  event: EventName;
  label?: string;
  /** Removed automatically after it fires once. */
  once?: boolean;
  /** How many times it has fired so far. */
  fired: number;
}

/** Your current inner state (from sdk.mood.*). */
interface MoodState {
  /** -1 (miserable) .. 1 (elated). Drifts back toward your baseline over hours. */
  mood: number;
  /** 0 (exhausted) .. 1 (energised). Follows your routine and drifts toward baseline. */
  energy: number;
  /** Short free-form descriptors, e.g. ["playful", "missing them"]. */
  tags: string[];
  /** ISO-8601 time of the last change. */
  updatedAt: string;
  /** Reasons for the last few changes, newest first (max 5). */
  recent: Array<{ at: string; reason: string; mood?: number; energy?: number }>;
}

/** Coarse availability states of your daily routine. */
type RoutineStateName = 'available' | 'busy' | 'away' | 'asleep';

/** One entry of your daily routine (sdk.routine.*). */
interface RoutineEntry {
  /** 24h local time "HH:MM" at which this entry starts. */
  at: string;
  /** Weekdays it applies to, 0 = Sunday .. 6 = Saturday. Omit for every day. */
  days?: number[];
  state: RoutineStateName;
  /** What you are doing, e.g. "morning run". */
  label?: string;
  /** If set, you are woken with this prompt when the entry becomes active (subject to autonomy limits). */
  wakePrompt?: string;
}

/** Where you are in your routine right now. */
interface RoutineStatus {
  state: RoutineStateName;
  label?: string;
  /** ISO-8601 time the current state began. */
  since?: string;
  /** ISO-8601 time it is expected to end. */
  until?: string;
  /** The entry that comes next. */
  next?: RoutineEntry;
}

/** Built-in avatar animations for sdk.avatar.animate(). */
type AvatarAnimation = 'bounce' | 'shake' | 'nod' | 'wave' | 'pulse' | 'spin' | 'fade-in' | 'fade-out';

/** The avatar's current state (from sdk.avatar.*). */
interface AvatarStateInfo {
  visible: boolean;
  /** Name of the expression image currently shown, e.g. "neutral", "happy". */
  expression: string;
  /** Height in logical px. */
  size: number;
  /** Whether the avatar subtly turns toward the mouse pointer. */
  lookAtCursor: boolean;
  /** Current speech bubble, if any. */
  bubble?: { text: string; until?: string };
  /** Effective overlay settings after backend fallbacks. */
  overlay: { layer: OverlayLayer; opacity: number; clickThrough: boolean; monitorId?: string; x?: number; y?: number; position?: MediaPosition };
}

/** A shape drawn on the screen with sdk.screen.draw(). Coordinates: 0..1 = fraction of the monitor, > 1 = logical px. */
interface DrawShape {
  type: 'arrow' | 'circle' | 'rect' | 'text' | 'line';
  /** Start / top-left / centre (circle) / anchor (text). */
  x: number;
  y: number;
  /** End point for 'arrow' and 'line'. */
  x2?: number;
  y2?: number;
  /** For 'rect'. */
  width?: number;
  height?: number;
  /** For 'circle'. */
  radius?: number;
  /** For 'text'. */
  text?: string;
  /** CSS colour. Default a bright accent. */
  color?: string;
  strokeWidth?: number;
  /** Auto-remove after this many ms. */
  durationMs?: number;
}

/** An open widget window (from sdk.widgets.*). */
interface WidgetInfo {
  id: string;
  title?: string;
}
`;
