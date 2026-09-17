/**
 * How the media page talks to its host. `media.html` runs either inside an
 * Electron BrowserWindow (commands/reports over `window.rp.media`) or inside
 * the native layer-shell helper's WebKit view, where the initial command is
 * in `location.hash`, later commands arrive through a global hook, and reports
 * are posted to the helper's script message handler.
 */
import type { IpcApi, MediaCommand, MediaWindowEvent } from '@rp/shared';

export interface MediaTransport {
  onCommand(listener: (command: MediaCommand) => void): () => void;
  report(event: MediaWindowEvent): void;
}

const COMMAND_TYPES = new Set<MediaCommand['type']>([
  'show-image',
  'play-video',
  'play-audio',
  'show-fullscreen',
  'update',
  'close',
  'close-all',
  'avatar-show',
  'avatar-set',
  'avatar-hide',
  'widget-show',
  'widget-update',
  'draw-set',
  'draw-clear',
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Decode base64url (RFC 4648 §5, padding optional) into a UTF-8 string. Throws on garbage. */
export function decodeBase64Url(input: string): string {
  const b64 = input.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Validate a decoded JSON value as a `MediaCommand` (shape check only; URLs are checked by the state machine). */
export function parseCommandJson(json: string): MediaCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const cmd = value as Record<string, unknown>;
  if (typeof cmd.type !== 'string' || !COMMAND_TYPES.has(cmd.type as MediaCommand['type'])) return null;
  if (cmd.type !== 'close-all' && typeof cmd.id !== 'string') return null;
  if ((cmd.type === 'show-image' || cmd.type === 'play-video' || cmd.type === 'play-audio' || cmd.type === 'show-fullscreen') && typeof cmd.url !== 'string') return null;
  if (cmd.type === 'show-fullscreen' && !(isObject(cmd.options) && (cmd.options.media === 'image' || cmd.options.media === 'video'))) return null;
  if (cmd.type === 'update' && !isObject(cmd.options)) return null;
  if (cmd.type === 'avatar-show' && !(isObject(cmd.state) && typeof cmd.state.imageUrl === 'string')) return null;
  if (cmd.type === 'avatar-set' && !isObject(cmd.patch)) return null;
  if (cmd.type === 'widget-show' && !(isObject(cmd.widget) && typeof cmd.widget.html === 'string')) return null;
  if (cmd.type === 'draw-set' && !Array.isArray(cmd.shapes)) return null;
  return value as MediaCommand;
}

/** Read `#cmd=<base64url JSON>` from a location hash. */
export function parseHashCommand(hash: string): MediaCommand | null {
  const m = /(?:^#|[#&])cmd=([A-Za-z0-9_-]+=*)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return parseCommandJson(decodeBase64Url(m[1]));
  } catch {
    return null;
  }
}

export function createElectronTransport(media: IpcApi['media']): MediaTransport {
  return {
    onCommand: (listener) => media.onCommand(listener),
    report(event) {
      media.report(event).catch((err) => console.error('media.report failed', err));
    },
  };
}

/** The pieces of the helper's page environment the transport touches (faked in tests). */
export interface HelperEnv {
  /** `location.hash` at page load. */
  hash: string;
  /** Install/remove the global `window.__rpMediaCommand(json)` hook the helper calls. */
  setCommandHook(hook: ((json: string) => void) | undefined): void;
  /** `window.webkit.messageHandlers.rp.postMessage`; may be missing when opened in a plain browser. */
  postMessage: ((json: string) => void) | undefined;
}

interface HelperWindow {
  __rpHelper?: boolean;
  __rpMediaCommand?: (json: string) => void;
  webkit?: { messageHandlers?: { rp?: { postMessage(json: string): void } } };
}

export function browserHelperEnv(win: Window & HelperWindow): HelperEnv {
  return {
    hash: win.location.hash,
    setCommandHook(hook) {
      if (hook) win.__rpMediaCommand = hook;
      else delete win.__rpMediaCommand;
    },
    postMessage: win.webkit?.messageHandlers?.rp ? (json) => win.webkit!.messageHandlers!.rp!.postMessage(json) : undefined,
  };
}

/**
 * Helper-mode transport. The hook is installed immediately so commands issued
 * before React subscribes are buffered, then replayed (initial hash command
 * first) to the first listener.
 */
export function createHelperTransport(env: HelperEnv): MediaTransport {
  const pending: MediaCommand[] = [];
  let listener: ((command: MediaCommand) => void) | null = null;

  const initial = parseHashCommand(env.hash);
  if (initial) pending.push(initial);

  const deliver = (command: MediaCommand) => {
    if (listener) listener(command);
    else pending.push(command);
  };
  env.setCommandHook((json) => {
    const command = parseCommandJson(json);
    if (!command) {
      console.warn('[media] ignoring malformed command', json);
      return;
    }
    deliver(command);
  });

  return {
    onCommand(fn) {
      listener = fn;
      while (pending.length > 0) fn(pending.shift()!);
      return () => {
        if (listener === fn) listener = null;
      };
    },
    report(event) {
      const post = env.postMessage;
      if (!post) {
        console.warn('[media] no message handler; dropping report', event);
        return;
      }
      post(JSON.stringify(event));
    },
  };
}

export type TransportMode = 'electron' | 'helper';

export function detectTransportMode(win: { rp?: unknown; __rpHelper?: boolean }): TransportMode {
  if (win.rp) return 'electron';
  return 'helper';
}

/** Pick the transport for the current page. */
export function createTransportForWindow(win: Window): MediaTransport {
  const w = win as Window & HelperWindow & { rp?: IpcApi };
  if (detectTransportMode(w) === 'electron' && w.rp) return createElectronTransport(w.rp.media);
  return createHelperTransport(browserHelperEnv(w));
}
