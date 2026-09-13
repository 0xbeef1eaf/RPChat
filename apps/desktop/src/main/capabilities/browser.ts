/**
 * `sdk.browser`: `open` runs the user's browser command (or the extension when connected); every
 * other method drives tabs through the browser-extension bridge and fails with `CAPABILITY_FAILED`
 * while no extension is connected. URLs opened, navigated to, bookmarked, redirected to or set as
 * home page must be http(s) and, when the user set `settings.web.allowlist`, on it. Page blocking,
 * JavaScript injection and history access are switchable in Settings → Browser
 * (`settings.browser.allowBlocking` / `allowEval` / `allowHistory`); block durations are capped by
 * `settings.browser.maxBlockMs`.
 */
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import type { ActionContext, AppSettings, BrowserBridgeEvent, BrowserTabInfo, CapabilityHandler, Json, LoadedPack } from '@rp/shared';
import { RpError } from '@rp/shared';
import { resolveAssetPath } from '@rp/pack';
import type { CommandRunner } from './commands-runner.js';
import { commandFailed, isConfigured } from '../commands.js';
import { isAllowlisted } from './allowlist.js';
import { httpUrlArg } from './system.js';

/** The slice of `BrowserBridge` the handler needs (injectable for tests). */
export interface BrowserBridgeLike {
  readonly connected: boolean;
  request(op: string, args?: Record<string, Json>, opts?: { timeoutMs?: number }): Promise<Json>;
  status(): Promise<{ connected: boolean; browser?: string }>;
  onEvent?(listener: (event: BrowserBridgeEvent) => void): () => void;
}

export type BrowserSettingsSlice = Pick<AppSettings['browser'], 'allowBlocking' | 'maxBlockMs' | 'allowEval' | 'allowHistory' | 'homePage'>;

export interface BrowserHandlerDeps {
  commands: CommandRunner;
  openExternal?: (url: string) => Promise<void>;
  bridge?: BrowserBridgeLike;
  /** `settings.web.allowlist` (empty = any host). */
  allowlist?: () => Promise<string[]>;
  /** `settings.browser` toggles and caps (defaults apply when absent). */
  browserSettings?: () => Promise<BrowserSettingsSlice>;
  /** Persist `settings.browser.homePage` (the handler pushes it to the extension itself). */
  setHomePage?: (url: string) => Promise<void>;
  /** Name of the acting character, shown on the extension's blocked page. */
  characterName?: (context: ActionContext) => string;
  /** Loaded packs, to validate `replaceWith` pack assets. */
  packs?: { getLoaded(packId: string): LoadedPack };
  /** The http URL under which the browser can load a pack asset (the loopback server's asset route). */
  assetUrl?: (packId: string, asset: string) => string;
}

export const NOT_CONNECTED_MESSAGE = 'The browser extension is not connected (Settings → Browser: install the extension policy or load it unpacked)';
export const BLOCKING_DISABLED_MESSAGE = 'Blocking pages is disabled in Settings → Browser';
export const EVAL_DISABLED_MESSAGE = 'JavaScript injection is disabled in Settings → Browser';
export const HISTORY_DISABLED_MESSAGE = 'Browser history access is disabled in Settings → Browser';
export const DEFAULT_MAX_BLOCK_MS = 4 * 60 * 60_000;
export const MAX_BLOCK_PATTERNS = 50;
/** Longest `eval` wait; the bridge request is stretched to fit it. */
export const EVAL_TIMEOUT_MAX_MS = 60_000;
export const EVAL_TIMEOUT_DEFAULT_MS = 10_000;
export const HISTORY_LIMIT_MAX = 500;
export const DEFAULT_BROWSER_SETTINGS: BrowserSettingsSlice = { allowBlocking: true, maxBlockMs: DEFAULT_MAX_BLOCK_MS, allowEval: true, allowHistory: true, homePage: '' };

function record(v: Json | undefined): Record<string, Json> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

function tabIdArg(v: Json | undefined, what = 'tabId'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RpError('INVALID_ARGUMENT', `${what} must be a tab id (non-negative integer) from sdk.browser.tabs() or openTab()`);
  return v;
}

function stringArg(v: Json | undefined, what: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new RpError('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  return v;
}

function optionalNumber(v: Json | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The host a block pattern names (scheme, port and path stripped), lower-cased; empty when unparseable. */
export function blockPatternHost(pattern: string): string {
  let p = pattern.trim().toLowerCase().replace(/^[a-z*]+:\/\//, '');
  if (p.startsWith('*.')) p = p.slice(2);
  const slash = p.indexOf('/');
  return (slash >= 0 ? p.slice(0, slash) : p).replace(/:\d+$/, '');
}

/** Hosts a character may never block: the app's own loopback pages (media, assets, the extension update URL) and browser internals. */
export function isProtectedBlockPattern(pattern: string): boolean {
  const raw = pattern.trim().toLowerCase();
  if (/^(chrome|chrome-extension|edge|brave|about|devtools|file):/.test(raw)) return true;
  const host = blockPatternHost(pattern);
  return host === '' || host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || host === '[::1]';
}

/** `since` / `until` for history: an ISO date-time, or a number of milliseconds ago. */
function historyTime(v: Json | undefined, what: string, now: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return now - v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new RpError('INVALID_ARGUMENT', `${what} must be an ISO date-time or a number of milliseconds ago`);
}

export class BrowserHandler implements CapabilityHandler {
  readonly moduleId = 'browser';

  constructor(private readonly deps: BrowserHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'open':
        return this.open(httpUrlArg(args[0]), record(args[1]));
      case 'status': {
        if (!this.deps.bridge) return { connected: false };
        const s = await this.deps.bridge.status();
        return s.browser ? { connected: s.connected, browser: s.browser } : { connected: s.connected };
      }
      case 'tabs':
        return this.bridged('tabs.list');
      case 'openTab': {
        const url = await this.allowed(httpUrlArg(args[0]));
        const o = record(args[1]);
        return this.bridged('tabs.open', { url, active: o['active'] !== false, newWindow: o['newWindow'] === true });
      }
      case 'activate':
        return this.bridged('tabs.activate', { tabId: tabIdArg(args[0]) });
      case 'close':
        await this.bridged('tabs.close', { tabId: tabIdArg(args[0]) });
        return;
      case 'navigate':
        return this.bridged('tabs.navigate', { tabId: tabIdArg(args[0]), url: await this.allowed(httpUrlArg(args[1])) });
      case 'back':
        return this.bridged('tabs.back', { tabId: tabIdArg(args[0]) });
      case 'forward':
        return this.bridged('tabs.forward', { tabId: tabIdArg(args[0]) });
      case 'reload':
        return this.bridged('tabs.reload', { tabId: tabIdArg(args[0]) });
      case 'read': {
        const tabId = args[0] === undefined || args[0] === null ? await this.activeTabId() : tabIdArg(args[0]);
        const o = record(args[1]);
        const maxChars = optionalNumber(o['maxChars']);
        return this.bridged('page.read', { tabId, ...(maxChars !== undefined ? { maxChars } : {}) });
      }
      case 'query': {
        const o = record(args[2]);
        const limit = optionalNumber(o['limit']);
        return this.bridged('page.query', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), ...(limit !== undefined ? { limit } : {}) });
      }
      case 'click': {
        const o = record(args[2]);
        const index = optionalNumber(o['index']);
        return this.bridged('page.click', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), ...(index !== undefined ? { index } : {}) });
      }
      case 'type': {
        if (typeof args[2] !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
        const o = record(args[3]);
        return this.bridged('page.type', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), text: args[2], submit: o['submit'] === true });
      }
      case 'scroll': {
        const o = record(args[1]);
        const y = optionalNumber(o['y']);
        const selector = typeof o['selector'] === 'string' ? o['selector'] : undefined;
        if (y === undefined && !selector) throw new RpError('INVALID_ARGUMENT', 'scroll needs { y } or { selector }');
        return this.bridged('page.scroll', { tabId: tabIdArg(args[0]), ...(y !== undefined ? { y } : {}), ...(selector ? { selector } : {}) });
      }
      case 'screenshot': {
        const tabId = args[0] === undefined || args[0] === null ? await this.activeTabId() : tabIdArg(args[0]);
        return this.bridged('page.screenshot', { tabId, format: 'png' });
      }
      case 'find':
        return this.bridged('page.find', { tabId: tabIdArg(args[0]), text: stringArg(args[1], 'text') });
      // ---- blocking ----
      case 'block':
        return this.block(args[0], record(args[1]), context);
      case 'unblock':
        return this.bridged('rules.unblock', { id: stringArg(args[0], 'id') });
      case 'blocks':
        return this.bridged('rules.list');
      case 'clearBlocks':
        return this.bridged('rules.clear');
      // ---- image effects ----
      case 'imageEffect':
        return this.imageEffect(tabIdArg(args[0]), args[1], record(args[2]), context);
      case 'clearImageEffects':
        return this.bridged('page.clearImageEffects', { tabId: tabIdArg(args[0]) });
      // ---- home page ----
      case 'setHomePage':
        return this.setHomePage(args[0]);
      case 'homePage':
        return { url: (await this.settings()).homePage || null };
      // ---- bookmarks ----
      case 'bookmarks': {
        const o = record(args[0]);
        return this.bridged('bookmarks.list', typeof o['folder'] === 'string' && o['folder'].trim().length > 0 ? { folder: o['folder'] } : {});
      }
      case 'searchBookmarks':
        return this.bridged('bookmarks.search', { query: stringArg(args[0], 'query') });
      case 'addBookmark': {
        const url = await this.allowed(httpUrlArg(args[0]));
        const title = typeof args[1] === 'string' ? args[1] : '';
        const o = record(args[2]);
        return this.bridged('bookmarks.add', { url, title, ...(typeof o['folder'] === 'string' && o['folder'].trim().length > 0 ? { folder: o['folder'] } : {}) });
      }
      case 'removeBookmark': {
        const idOrUrl = stringArg(args[0], 'idOrUrl');
        return this.bridged('bookmarks.remove', /^https?:\/\//i.test(idOrUrl) ? { url: idOrUrl } : { id: idOrUrl });
      }
      // ---- eval ----
      case 'eval':
        return this.eval(tabIdArg(args[0]), args[1], record(args[2]));
      // ---- history ----
      case 'history':
        return this.history(record(args[0]));
      case 'historyVisits':
        await this.requireHistory();
        return this.bridged('history.visits', { url: httpUrlArg(args[0]) });
      case 'recentHistory': {
        await this.requireHistory();
        const limit = optionalNumber(args[0]);
        return this.bridged('history.recent', limit !== undefined ? { maxResults: Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(limit))) } : {});
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.browser.${method}`);
    }
  }

  // ---- blocking ----------------------------------------------------------------------------

  private async block(rawPatterns: Json | undefined, options: Record<string, Json>, context: ActionContext): Promise<Json> {
    const settings = await this.settings();
    if (!settings.allowBlocking) throw new RpError('CAPABILITY_FAILED', BLOCKING_DISABLED_MESSAGE);
    if (!Array.isArray(rawPatterns) || rawPatterns.length === 0 || !rawPatterns.every((p) => typeof p === 'string' && p.trim().length > 0)) {
      throw new RpError('INVALID_ARGUMENT', 'patterns must be a non-empty array of strings such as "example.com", "*.example.com" or "example.com/path*"');
    }
    if (rawPatterns.length > MAX_BLOCK_PATTERNS) throw new RpError('INVALID_ARGUMENT', `at most ${MAX_BLOCK_PATTERNS} patterns per block`);
    const patterns = (rawPatterns as string[]).map((p) => p.trim());
    const protectedOne = patterns.find(isProtectedBlockPattern);
    if (protectedOne) throw new RpError('PERMISSION_DENIED', `"${protectedOne}" cannot be blocked: the app's own pages (127.0.0.1, localhost) and browser pages are protected`);
    const maxBlockMs = Number.isFinite(settings.maxBlockMs) && settings.maxBlockMs > 0 ? settings.maxBlockMs : DEFAULT_MAX_BLOCK_MS;
    const wanted = optionalNumber(options['durationMs']);
    if (wanted !== undefined && wanted <= 0) throw new RpError('INVALID_ARGUMENT', 'durationMs must be a positive number of milliseconds');
    const durationMs = Math.min(wanted ?? maxBlockMs, maxBlockMs);
    const expiresAt = new Date(Date.now() + Math.max(1000, Math.round(durationMs))).toISOString();
    const redirect = options['redirect'] !== undefined && options['redirect'] !== null ? await this.allowed(httpUrlArg(options['redirect'])) : undefined;
    if (redirect && isProtectedBlockPattern(blockPatternHost(redirect))) throw new RpError('INVALID_ARGUMENT', 'redirect must be a public http(s) page');
    const reason = typeof options['reason'] === 'string' && options['reason'].trim().length > 0 ? options['reason'].trim().slice(0, 300) : undefined;
    const id = `blk-${randomUUID().slice(0, 8)}`;
    const by = this.deps.characterName ? this.deps.characterName(context) : context.characterId;
    const result = record(await this.bridged('rules.block', { id, patterns, expiresAt, by, ...(redirect ? { redirect } : {}), ...(reason ? { reason } : {}) }));
    return { id, expiresAt, patterns, cappedToMs: durationMs < (wanted ?? maxBlockMs) ? maxBlockMs : null, ...(redirect ? { redirect } : {}), redirectedTabs: result['redirectedTabs'] ?? 0 };
  }

  // ---- image effects -----------------------------------------------------------------------

  private async imageEffect(tabId: number, effect: Json | undefined, options: Record<string, Json>, context: ActionContext): Promise<Json> {
    if (typeof effect !== 'string' && !(effect && typeof effect === 'object' && typeof (effect as Record<string, Json>)['css'] === 'string')) {
      throw new RpError('INVALID_ARGUMENT', 'effect must be "blur" | "grayscale" | "sepia" | "invert" | "hue" | "pixelate" | "none" or { css: "<filter value>" }');
    }
    const args: Record<string, Json> = { tabId, effect: typeof effect === 'string' ? effect : { css: (effect as Record<string, Json>)['css'] as string } };
    if (typeof options['selector'] === 'string' && options['selector'].trim().length > 0) args['selector'] = options['selector'];
    const raw = options['replaceWith'];
    // An AssetRef from sdk.pack arrives as an object with `path` (the dispatcher only unwraps first arguments).
    const replaceWith = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, Json>)['path'] === 'string' ? ((raw as Record<string, Json>)['path'] as string) : raw;
    if (replaceWith !== undefined && replaceWith !== null) {
      if (typeof replaceWith !== 'string' || replaceWith.length === 0) throw new RpError('INVALID_ARGUMENT', 'replaceWith must be an http(s) image URL, a pack asset path or an AssetRef');
      args['replaceWith'] = /^https?:\/\//i.test(replaceWith) ? await this.allowed(httpUrlArg(replaceWith)) : this.packAssetUrl(context.packId, replaceWith);
    }
    const durationMs = optionalNumber(options['durationMs']);
    if (durationMs !== undefined && durationMs > 0) args['durationMs'] = Math.round(durationMs);
    return this.bridged('page.imageEffect', args);
  }

  /** The loopback URL of a pack asset the page can load (`http://127.0.0.1:<port>/t/<token>/asset/<pack>/<path>`). */
  private packAssetUrl(packId: string, asset: string): string {
    if (!this.deps.packs || !this.deps.assetUrl) throw new RpError('CAPABILITY_FAILED', 'Pack assets are not served to the browser in this build');
    const pack = this.deps.packs.getLoaded(packId);
    resolveAssetPath(pack.root, asset);
    return this.deps.assetUrl(packId, asset);
  }

  // ---- home page ---------------------------------------------------------------------------

  private async setHomePage(raw: Json | undefined): Promise<Json> {
    const url = raw === null || raw === undefined || raw === '' ? '' : await this.allowed(httpUrlArg(raw));
    if (this.deps.setHomePage) await this.deps.setHomePage(url);
    if (this.deps.bridge?.connected) await this.deps.bridge.request('home.set', { url: url || null });
    else if (!this.deps.setHomePage) throw new RpError('CAPABILITY_FAILED', NOT_CONNECTED_MESSAGE);
    return { url: url || null, pushedToExtension: Boolean(this.deps.bridge?.connected) };
  }

  // ---- eval --------------------------------------------------------------------------------

  private async eval(tabId: number, code: Json | undefined, options: Record<string, Json>): Promise<Json> {
    if (!(await this.settings()).allowEval) throw new RpError('CAPABILITY_FAILED', EVAL_DISABLED_MESSAGE);
    const src = stringArg(code, 'code');
    const world = options['world'] === 'main' ? 'main' : options['world'] === undefined || options['world'] === 'isolated' ? 'isolated' : undefined;
    if (!world) throw new RpError('INVALID_ARGUMENT', 'world must be "isolated" (default) or "main"');
    const wanted = optionalNumber(options['timeoutMs']);
    const timeoutMs = wanted !== undefined && wanted > 0 ? Math.min(EVAL_TIMEOUT_MAX_MS, Math.round(wanted)) : EVAL_TIMEOUT_DEFAULT_MS;
    return this.bridge().request('page.eval', { tabId, code: src, world, timeoutMs }, { timeoutMs: timeoutMs + 5_000 });
  }

  // ---- history -----------------------------------------------------------------------------

  private async requireHistory(): Promise<void> {
    if (!(await this.settings()).allowHistory) throw new RpError('CAPABILITY_FAILED', HISTORY_DISABLED_MESSAGE);
  }

  private async history(options: Record<string, Json>): Promise<Json> {
    await this.requireHistory();
    const now = Date.now();
    const startTime = historyTime(options['since'], 'since', now);
    const endTime = historyTime(options['until'], 'until', now);
    const limit = optionalNumber(options['limit']);
    return this.bridged('history.search', {
      ...(typeof options['text'] === 'string' ? { text: options['text'] } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(limit !== undefined ? { maxResults: Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(limit))) } : {}),
    });
  }

  // ---- helpers -----------------------------------------------------------------------------

  private async settings(): Promise<BrowserSettingsSlice> {
    return this.deps.browserSettings ? { ...DEFAULT_BROWSER_SETTINGS, ...(await this.deps.browserSettings()) } : DEFAULT_BROWSER_SETTINGS;
  }

  /** Enforce the user's host allowlist (empty = any http(s) host). */
  private async allowed(url: string): Promise<string> {
    const allowlist = this.deps.allowlist ? await this.deps.allowlist() : [];
    if (allowlist.length > 0 && !isAllowlisted(url, allowlist)) {
      throw new RpError('PERMISSION_DENIED', `The host of ${url} is not on the user's web allowlist; they can add it under Settings → Integrations → Web access`, { url, allowlist });
    }
    return url;
  }

  private bridge(): BrowserBridgeLike {
    const bridge = this.deps.bridge;
    if (!bridge || !bridge.connected) throw new RpError('CAPABILITY_FAILED', NOT_CONNECTED_MESSAGE);
    return bridge;
  }

  private bridged(op: string, args: Record<string, Json> = {}): Promise<Json> {
    return this.bridge().request(op, args);
  }

  private async activeTabId(): Promise<number> {
    const tabs = (await this.bridged('tabs.list')) as unknown as BrowserTabInfo[];
    const active = Array.isArray(tabs) ? tabs.find((t) => t.active && t.url.startsWith('http')) ?? tabs.find((t) => t.active) : undefined;
    if (!active) throw new RpError('NOT_FOUND', 'No active browser tab; pass a tabId from sdk.browser.tabs()');
    return active.id;
  }

  private async open(url: string, options: Record<string, Json>): Promise<Json | void> {
    await this.allowed(url);
    const newWindow = options['newWindow'] === true;
    if (this.deps.bridge?.connected) {
      return this.deps.bridge.request('tabs.open', { url, active: true, newWindow });
    }
    const tpl = await this.deps.commands.resolve('browser');
    if (!isConfigured(tpl)) {
      // Only reachable when the platform has no default (it always has one); still never silent.
      await (this.deps.openExternal ?? ((u: string) => shell.openExternal(u)))(url);
      return null;
    }
    const flag = newWindow && tpl.command.includes('{newWindow}') ? '--new-window' : '';
    const result = await this.deps.commands.runTemplate(tpl, { url, newWindow: flag }, 'browser');
    if (result.code !== 0) throw commandFailed('browser', tpl, result);
    return null;
  }
}
