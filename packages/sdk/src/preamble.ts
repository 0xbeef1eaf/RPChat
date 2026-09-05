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

/** Where a media overlay window is placed on the user's primary display. */
type MediaPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface ShowImageOptions {
  /** Auto-close after this many milliseconds. Omit to keep the image open until closed. */
  durationMs?: number;
  /** Default 'center'. */
  position?: MediaPosition;
  /** Max width in CSS px. Default 480. */
  width?: number;
  /** Caption rendered under the image. */
  caption?: string;
}

interface PlayVideoOptions {
  /** Default 'center'. */
  position?: MediaPosition;
  /** Max width in CSS px. Default 480. */
  width?: number;
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

/** A media item currently shown/playing. Returned by sdk.media.* and accepted by sdk.media.close(). */
interface MediaHandle {
  /** Opaque id of the media item. */
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio';
  /** Pack-relative path of the asset being shown. */
  readonly asset: string;
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
