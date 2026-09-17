/**
 * Pure protocol helpers shared by the service worker and its tests: the wire format between the
 * rpchat app and the extension, URL policy, reconnect backoff and text normalisation. Nothing in
 * here touches `chrome.*`, so it runs under plain vitest.
 */

export const DEFAULT_PORT = 47821;
export const DEFAULT_MAX_CHARS = 20_000;
/** Longest wait between reconnect attempts. */
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;

/** A request from the app. */
export interface BridgeRequest {
  id: string;
  op: string;
  args: Record<string, unknown>;
}

export type BridgeResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface BridgeEvent {
  event: 'tab-updated' | 'tab-activated' | 'tab-removed';
  data: Record<string, unknown>;
}

export interface HelloMessage {
  hello: { version: string; browser: string; extensionId: string };
}

export interface TabInfo {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Parse one text frame from the app; null when it is not a well-formed request. */
export function parseRequest(text: string): BridgeRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['id'].length === 0 || typeof r['op'] !== 'string' || r['op'].length === 0) return null;
  const args = r['args'] && typeof r['args'] === 'object' && !Array.isArray(r['args']) ? (r['args'] as Record<string, unknown>) : {};
  return { id: r['id'], op: r['op'], args };
}

export function okResponse(id: string, value: unknown): BridgeResponse {
  return { id, ok: true, value: value === undefined ? null : value };
}

export function errorResponse(id: string, code: string, message: string): BridgeResponse {
  return { id, ok: false, error: { code, message } };
}

/** Map anything thrown by an op onto the error shape. */
export function errorFrom(id: string, err: unknown): BridgeResponse {
  if (err instanceof BridgeError) return errorResponse(id, err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(id, 'FAILED', message);
}

export function helloMessage(input: { version: string; browser: string; extensionId: string }): HelloMessage {
  return { hello: { ...input } };
}

/** `navigator.userAgentData.brands` when present ("Chromium 141; Google Chrome 141"), else the UA string. */
export function describeBrowser(nav: { userAgent?: string; userAgentData?: { brands?: Array<{ brand: string; version: string }> } }): string {
  const brands = nav.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)) ?? [];
  if (brands.length > 0) return brands.map((b) => `${b.brand} ${b.version}`).join('; ');
  return nav.userAgent ?? 'unknown';
}

/**
 * Only http(s) pages may be opened or navigated to (and `file:` when the app explicitly allows
 * it). Everything else — chrome://, javascript:, data:, blob:, about: — is refused here as well as
 * in the app, so a bug on one side cannot reach browser internals.
 */
export function isNavigableUrl(url: unknown, opts: { allowFile?: boolean } = {}): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname.length > 0;
  if (parsed.protocol === 'file:') return opts.allowFile === true;
  return false;
}

/** Whether a tab's page can be read or scripted (only web pages; never chrome://, the store, etc.). */
export function isWebUrl(url: string | undefined): boolean {
  if (!url) return false;
  return isNavigableUrl(url, { allowFile: true }) && !/^https:\/\/chrome(web)?store\.google\.com\//i.test(url);
}

/** Tabs are listed whatever they show, but internal pages give away neither URL nor title. */
export function describeTab(tab: { id?: number; windowId?: number; url?: string; pendingUrl?: string; title?: string; active?: boolean; index?: number }): TabInfo {
  const url = tab.url ?? tab.pendingUrl ?? '';
  const web = isWebUrl(url);
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    url: web ? url : url ? `${new URL(url).protocol}//` : '',
    title: web ? (tab.title ?? '') : '',
    active: tab.active === true,
    index: tab.index ?? -1,
  };
}

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at 30 s. `random` is injectable for tests. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(0, Math.min(attempt, 30));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
  const jitter = Math.floor(random() * Math.min(1000, base / 4));
  return Math.min(BACKOFF_MAX_MS, base + jitter);
}

/**
 * Collapse whitespace the way a reader sees it (runs of blanks become one space, blank lines are
 * kept as single newlines), trim, and cap to `maxChars` with a marker so the model knows it was cut.
 */
export function normaliseText(raw: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length <= max) return text;
  const marker = ' […truncated]';
  return `${text.slice(0, Math.max(0, max - marker.length)).trimEnd()}${marker}`;
}

/** Positive integer or the default; used for maxChars / limit arguments. */
export function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

/** The bridge port: managed policy wins, then the user's own choice, then the default. */
export function resolvePort(managed: unknown, local: unknown, fallback: number = DEFAULT_PORT): number {
  for (const candidate of [managed, local]) {
    const n = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return fallback;
}

export function bridgeUrl(port: number): string {
  return `ws://127.0.0.1:${port}/bridge`;
}

export type OpHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Route one request to its handler and turn the outcome into a response frame (never throws). */
export async function dispatch(request: BridgeRequest, handlers: Record<string, OpHandler>): Promise<BridgeResponse> {
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.op) ? handlers[request.op] : undefined;
  if (!handler) return errorResponse(request.id, 'UNKNOWN_OP', `Unknown op "${request.op}"`);
  try {
    return okResponse(request.id, await handler(request.args));
  } catch (err) {
    return errorFrom(request.id, err);
  }
}
