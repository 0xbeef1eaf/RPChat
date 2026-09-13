/**
 * The ops the app can ask for, implemented over a small `ChromeLike` subset of the extension APIs
 * so tests can drive them with a fake. Every op validates its arguments (bad input → `BridgeError`
 * with a code the app relays) and only ever touches web pages (`isWebUrl`).
 */
import { flattenBookmarks, otherBookmarksFolder, pathIndex, resolveFolder, BOOKMARK_LIST_CAP } from './bookmarks.js';
import type { BookmarkNodeLike, FlatBookmark } from './bookmarks.js';
import { MAX_EFFECT_DURATION_MS, buildEffect, effectSelector, effectStylesheet } from './effects.js';
import { pageClearImageEffects, pageClick, pageEval, pageFind, pageImageEffect, pageQuery, pageRead, pageScroll, pageType } from './page.js';
import { BridgeError, DEFAULT_MAX_CHARS, describeTab, isNavigableUrl, isWebUrl, normaliseText, positiveInt } from './protocol.js';
import type { OpHandler, TabInfo } from './protocol.js';
import { RULES_ALARM, RULES_STORAGE_KEY, describeRule, dnrRulesFor, expiredRules, nextExpiry, normalisePatterns, readTable, urlMatchesPattern } from './rules.js';
import type { BlockRule, DnrRuleLike, RuleTable } from './rules.js';

/** How long `tabs.open` / `tabs.navigate` wait for the page to finish loading before answering. */
export const LOAD_WAIT_MS = 10_000;
export const QUERY_LIMIT_DEFAULT = 50;
export const QUERY_LIMIT_MAX = 500;
/** Raw innerText requested from the page: generous so the whitespace collapse has room to work. */
const RAW_TEXT_FACTOR = 3;
export const EVAL_TIMEOUT_DEFAULT_MS = 10_000;
export const EVAL_TIMEOUT_MAX_MS = 60_000;
/** Largest JSON result `page.eval` hands back. */
export const EVAL_RESULT_MAX_BYTES = 64 * 1024;
export const EVAL_CODE_MAX_CHARS = 64 * 1024;
export const HISTORY_DEFAULT_RESULTS = 100;
export const HISTORY_MAX_RESULTS = 500;
export const HISTORY_DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
/** `chrome.storage.local` key of the character's home page (read by newtab.html). */
export const HOME_PAGE_KEY = 'homePage';

export interface TabLike {
  id?: number;
  windowId?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  index?: number;
  status?: string;
}

export interface TabsUpdatedListener {
  (tabId: number, changeInfo: { status?: string; url?: string; title?: string }, tab: TabLike): void;
}

export interface ChromeLike {
  tabs: {
    query(info: { windowType?: string }): Promise<TabLike[]>;
    get(tabId: number): Promise<TabLike>;
    create(props: { url: string; active?: boolean; windowId?: number }): Promise<TabLike>;
    update(tabId: number, props: { url?: string; active?: boolean }): Promise<TabLike | undefined>;
    remove(tabId: number): Promise<void>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    reload(tabId: number): Promise<void>;
    captureVisibleTab(windowId: number, options: { format: 'png' | 'jpeg'; quality?: number }): Promise<string>;
    onUpdated: { addListener(l: TabsUpdatedListener): void; removeListener(l: TabsUpdatedListener): void };
  };
  windows: {
    create(props: { url: string; focused?: boolean }): Promise<{ id?: number; tabs?: TabLike[] } | undefined>;
    update(windowId: number, props: { focused?: boolean }): Promise<unknown>;
  };
  scripting: {
    executeScript<T>(injection: { target: { tabId: number }; func: (...args: never[]) => T; args?: unknown[]; world?: 'ISOLATED' | 'MAIN' }): Promise<Array<{ result?: T }>>;
  };
  declarativeNetRequest: {
    getDynamicRules(): Promise<Array<{ id: number }>>;
    updateDynamicRules(options: { addRules?: DnrRuleLike[]; removeRuleIds?: number[] }): Promise<void>;
  };
  storage: {
    local: {
      get(key: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string | string[]): Promise<void>;
    };
  };
  alarms: {
    create(name: string, info: { when?: number; periodInMinutes?: number }): Promise<void> | void;
    clear(name: string): Promise<boolean> | boolean | void;
  };
  runtime: {
    getURL(path: string): string;
  };
  bookmarks: {
    getTree(): Promise<BookmarkNodeLike[]>;
    getSubTree(id: string): Promise<BookmarkNodeLike[]>;
    get(id: string): Promise<BookmarkNodeLike[]>;
    search(query: string | { url?: string; title?: string; query?: string }): Promise<BookmarkNodeLike[]>;
    create(bookmark: { parentId?: string; title?: string; url?: string }): Promise<BookmarkNodeLike>;
    remove(id: string): Promise<void>;
  };
  history: {
    search(query: { text: string; startTime?: number; endTime?: number; maxResults?: number }): Promise<Array<{ id?: string; url?: string; title?: string; lastVisitTime?: number; visitCount?: number }>>;
    getVisits(details: { url: string }): Promise<Array<{ visitTime?: number; transition?: string }>>;
  };
}

export interface HistoryItem {
  url: string;
  title: string;
  lastVisitTime: string;
  visitCount: number;
}

function tabIdArg(args: Record<string, unknown>): number {
  const id = args['tabId'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) throw new BridgeError('INVALID_ARGUMENT', 'tabId must be a non-negative integer');
  return id;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) throw new BridgeError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  return v;
}

function urlArg(args: Record<string, unknown>): string {
  const url = stringArg(args, 'url');
  if (!isNavigableUrl(url, { allowFile: args['allowFile'] === true })) throw new BridgeError('INVALID_URL', `Only http(s) URLs can be opened (got ${url.slice(0, 80)})`);
  return url;
}

export class BridgeOps {
  constructor(
    private readonly chrome: ChromeLike,
    private readonly opts: { loadWaitMs?: number } = {},
  ) {}

  /** `op` → handler, for `dispatch()`. */
  handlers(): Record<string, OpHandler> {
    return {
      'tabs.list': () => this.list(),
      'tabs.open': (a) => this.open(a),
      'tabs.activate': (a) => this.activate(tabIdArg(a)),
      'tabs.close': (a) => this.close(tabIdArg(a)),
      'tabs.navigate': (a) => this.navigate(tabIdArg(a), urlArg(a)),
      'tabs.back': (a) => this.history(tabIdArg(a), 'back'),
      'tabs.forward': (a) => this.history(tabIdArg(a), 'forward'),
      'tabs.reload': (a) => this.history(tabIdArg(a), 'reload'),
      'page.read': (a) => this.read(tabIdArg(a), positiveInt(a['maxChars'], DEFAULT_MAX_CHARS, 200_000)),
      'page.query': (a) => this.query(tabIdArg(a), stringArg(a, 'selector'), positiveInt(a['limit'], QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX)),
      'page.click': (a) => this.click(tabIdArg(a), stringArg(a, 'selector'), positiveInt(a['index'], 0, 100_000)),
      'page.type': (a) => this.type(tabIdArg(a), stringArg(a, 'selector'), typeof a['text'] === 'string' ? a['text'] : '', a['submit'] === true),
      'page.scroll': (a) => this.scroll(tabIdArg(a), a),
      'page.screenshot': (a) => this.screenshot(tabIdArg(a), a['format'] === 'jpeg' ? 'jpeg' : 'png'),
      'page.find': (a) => this.find(tabIdArg(a), stringArg(a, 'text')),
      'page.imageEffect': (a) => this.imageEffect(tabIdArg(a), a),
      'page.clearImageEffects': (a) => this.clearImageEffects(tabIdArg(a)),
      'page.eval': (a) => this.eval(tabIdArg(a), a),
      'rules.block': (a) => this.block(a),
      'rules.unblock': (a) => this.unblock(stringArg(a, 'id')),
      'rules.list': () => this.listBlocks(),
      'rules.clear': () => this.clearBlocks(),
      'home.set': (a) => this.setHome(a['url']),
      'home.get': () => this.getHome(),
      'bookmarks.list': (a) => this.bookmarks(typeof a['folder'] === 'string' ? a['folder'] : undefined),
      'bookmarks.search': (a) => this.searchBookmarks(stringArg(a, 'query')),
      'bookmarks.add': (a) => this.addBookmark(urlArg(a), typeof a['title'] === 'string' ? a['title'] : '', typeof a['folder'] === 'string' ? a['folder'] : undefined),
      'bookmarks.remove': (a) => this.removeBookmark(a),
      'history.search': (a) => this.historySearch(a),
      'history.visits': (a) => this.historyVisits(urlArg(a)),
      'history.recent': (a) => this.historyRecent(positiveInt(a['maxResults'], 20, HISTORY_MAX_RESULTS)),
    };
  }

  async list(): Promise<TabInfo[]> {
    const tabs = await this.chrome.tabs.query({});
    return tabs.filter((t) => typeof t.id === 'number').map(describeTab);
  }

  async open(args: Record<string, unknown>): Promise<TabInfo> {
    const url = urlArg(args);
    const active = args['active'] !== false;
    let tab: TabLike | undefined;
    if (args['newWindow'] === true) {
      const win = await this.chrome.windows.create({ url, focused: active });
      tab = win?.tabs?.[0];
      if (!tab && win?.id !== undefined) tab = (await this.chrome.tabs.query({})).find((t) => t.windowId === win.id);
    } else {
      tab = await this.chrome.tabs.create({ url, active });
    }
    if (!tab || typeof tab.id !== 'number') throw new BridgeError('FAILED', 'The browser did not create a tab');
    return this.settled(tab.id);
  }

  async activate(tabId: number): Promise<TabInfo> {
    const tab = await this.tab(tabId);
    await this.chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') await this.chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    return describeTab(await this.chrome.tabs.get(tabId));
  }

  async close(tabId: number): Promise<{ closed: true }> {
    await this.tab(tabId);
    await this.chrome.tabs.remove(tabId);
    return { closed: true };
  }

  async navigate(tabId: number, url: string): Promise<TabInfo> {
    await this.tab(tabId);
    await this.chrome.tabs.update(tabId, { url });
    return this.settled(tabId);
  }

  async history(tabId: number, what: 'back' | 'forward' | 'reload'): Promise<TabInfo> {
    await this.tab(tabId);
    if (what === 'back') await this.chrome.tabs.goBack(tabId);
    else if (what === 'forward') await this.chrome.tabs.goForward(tabId);
    else await this.chrome.tabs.reload(tabId);
    return this.settled(tabId);
  }

  async read(tabId: number, maxChars: number): Promise<{ url: string; title: string; text: string }> {
    const result = await this.inject(tabId, pageRead, [maxChars * RAW_TEXT_FACTOR]);
    return { url: result.url, title: result.title, text: normaliseText(result.text, maxChars) };
  }

  async query(tabId: number, selector: string, limit: number): Promise<unknown> {
    return this.inject(tabId, pageQuery, [selector, limit]);
  }

  async click(tabId: number, selector: string, index: number): Promise<unknown> {
    const result = await this.inject(tabId, pageClick, [selector, index]);
    if (!result.clicked) throw new BridgeError('NOT_FOUND', `No element matches "${selector}"${index > 0 ? ` at index ${index}` : ''} (${result.matches} match(es))`);
    return result;
  }

  async type(tabId: number, selector: string, text: string, submit: boolean): Promise<unknown> {
    const result = await this.inject(tabId, pageType, [selector, text, submit]);
    if (!result.typed) throw new BridgeError('NOT_FOUND', result.tag ? `"${selector}" is a <${result.tag}>, not an editable field` : `No element matches "${selector}"`);
    return result;
  }

  async scroll(tabId: number, args: Record<string, unknown>): Promise<unknown> {
    const selector = typeof args['selector'] === 'string' && args['selector'].length > 0 ? args['selector'] : null;
    const y = typeof args['y'] === 'number' && Number.isFinite(args['y']) ? args['y'] : null;
    if (selector === null && y === null) throw new BridgeError('INVALID_ARGUMENT', 'page.scroll needs y or selector');
    return this.inject(tabId, pageScroll, [y, selector]);
  }

  async screenshot(tabId: number, format: 'png' | 'jpeg'): Promise<{ dataUrl: string; url: string; title: string }> {
    const tab = await this.tab(tabId);
    if (!isWebUrl(tab.url ?? tab.pendingUrl)) throw new BridgeError('NOT_A_WEB_PAGE', 'Only web pages can be captured');
    const info = await this.activate(tabId);
    // The capture reads the visible surface; give the tab switch a frame to land.
    await new Promise((r) => setTimeout(r, 120));
    const dataUrl = await this.chrome.tabs.captureVisibleTab(info.windowId, format === 'jpeg' ? { format, quality: 80 } : { format });
    return { dataUrl, url: info.url, title: info.title };
  }

  async find(tabId: number, text: string): Promise<unknown> {
    return this.inject(tabId, pageFind, [text]);
  }

  // ---- image effects -------------------------------------------------------------------------

  async imageEffect(tabId: number, args: Record<string, unknown>): Promise<{ applied: boolean; replaced: number; total: number; effect: string }> {
    let built;
    let selector: string;
    try {
      built = buildEffect(args['effect']);
      selector = effectSelector(args['selector']);
    } catch (err) {
      throw new BridgeError('INVALID_ARGUMENT', (err as Error).message);
    }
    const replaceWith = typeof args['replaceWith'] === 'string' && args['replaceWith'].length > 0 ? args['replaceWith'] : null;
    if (replaceWith !== null && !/^https?:\/\//i.test(replaceWith)) throw new BridgeError('INVALID_ARGUMENT', 'replaceWith must be an http(s) image URL');
    const durationMs = positiveInt(args['durationMs'], 0, MAX_EFFECT_DURATION_MS);
    const result = await this.inject(tabId, pageImageEffect, [effectStylesheet(built, selector), selector, replaceWith, durationMs]);
    return { ...result, effect: built.name };
  }

  async clearImageEffects(tabId: number): Promise<{ cleared: boolean; restored: number }> {
    return this.inject(tabId, pageClearImageEffects, []);
  }

  // ---- eval --------------------------------------------------------------------------------

  /**
   * Whether the isolated world refused `new Function` (the extension's own CSP, `script-src
   * 'self'`, applies to content scripts in MV3, and `executeScript` serialises `func` from its
   * real source, so there is no way around it). Verified against Chromium 141; remembered after
   * the first refusal so later calls go straight to the main world.
   */
  private isolatedEvalRefused = false;

  async eval(tabId: number, args: Record<string, unknown>): Promise<{ value: unknown; world: 'isolated' | 'main'; fallback?: string }> {
    const code = stringArg(args, 'code');
    if (code.length > EVAL_CODE_MAX_CHARS) throw new BridgeError('INVALID_ARGUMENT', `code must be at most ${EVAL_CODE_MAX_CHARS} characters`);
    const wanted: 'isolated' | 'main' = args['world'] === 'main' ? 'main' : 'isolated';
    const timeoutMs = positiveInt(args['timeoutMs'], EVAL_TIMEOUT_DEFAULT_MS, EVAL_TIMEOUT_MAX_MS);
    const deadline = Date.now() + timeoutMs;
    const run = async (world: 'isolated' | 'main'): Promise<{ ok: boolean; json?: string; error?: string }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError('TIMEOUT', `The code did not finish within ${Math.round(timeoutMs / 1000)} s`)), Math.max(1, deadline - Date.now()));
      });
      try {
        return await Promise.race([this.inject(tabId, pageEval, [code], world === 'main' ? 'MAIN' : 'ISOLATED'), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let world = wanted;
    let fallback: string | undefined;
    if (world === 'isolated' && this.isolatedEvalRefused) {
      world = 'main';
      fallback = 'The isolated world refuses eval (extension CSP); ran in the main world';
    }
    let result = await run(world);
    if (!result.ok && world === 'isolated' && /unsafe-eval|Content Security Policy/i.test(result.error ?? '')) {
      this.isolatedEvalRefused = true;
      world = 'main';
      fallback = 'The isolated world refuses eval (extension CSP); ran in the main world';
      result = await run(world);
    }
    if (!result.ok) throw new BridgeError('EVAL_FAILED', `${result.error ?? 'The code threw'}${world === 'main' && /unsafe-eval|Content Security Policy/i.test(result.error ?? '') ? " (the page's Content Security Policy forbids eval in the main world)" : ''}`);
    const json = result.json ?? 'null';
    if (json.length > EVAL_RESULT_MAX_BYTES) throw new BridgeError('RESULT_TOO_LARGE', `The result is ${json.length} bytes; return at most ${EVAL_RESULT_MAX_BYTES}`);
    return { value: JSON.parse(json) as unknown, world, ...(fallback ? { fallback } : {}) };
  }

  // ---- blocking ----------------------------------------------------------------------------

  private async table(): Promise<RuleTable> {
    return readTable((await this.chrome.storage.local.get(RULES_STORAGE_KEY))[RULES_STORAGE_KEY]);
  }

  private async saveTable(table: RuleTable): Promise<void> {
    await this.chrome.storage.local.set({ [RULES_STORAGE_KEY]: table });
    const when = nextExpiry(table);
    if (when === undefined) await this.chrome.alarms.clear(RULES_ALARM);
    else await this.chrome.alarms.create(RULES_ALARM, { when });
  }

  private blockedPageUrl(id: string): string {
    return this.chrome.runtime.getURL(`blocked.html?rule=${encodeURIComponent(id)}`);
  }

  async block(args: Record<string, unknown>): Promise<ReturnType<typeof describeRule> & { redirectedTabs: number }> {
    const id = stringArg(args, 'id');
    if (id.length > 100) throw new BridgeError('INVALID_ARGUMENT', 'id is too long');
    let patterns: string[];
    try {
      patterns = normalisePatterns(args['patterns']);
    } catch (err) {
      throw new BridgeError('INVALID_ARGUMENT', (err as Error).message);
    }
    const redirect = typeof args['redirect'] === 'string' && args['redirect'].length > 0 ? args['redirect'] : undefined;
    if (redirect !== undefined && !isNavigableUrl(redirect)) throw new BridgeError('INVALID_URL', 'redirect must be an http(s) URL');
    if (redirect !== undefined && patterns.some((p) => urlMatchesPattern(redirect, p))) throw new BridgeError('INVALID_ARGUMENT', 'redirect must not itself match a blocked pattern');
    let expiresAt: string | undefined;
    if (args['expiresAt'] !== undefined && args['expiresAt'] !== null) {
      const at = typeof args['expiresAt'] === 'string' ? Date.parse(args['expiresAt']) : Number.NaN;
      if (!Number.isFinite(at)) throw new BridgeError('INVALID_ARGUMENT', 'expiresAt must be an ISO date-time');
      if (at <= Date.now()) throw new BridgeError('INVALID_ARGUMENT', 'expiresAt is already in the past');
      expiresAt = new Date(at).toISOString();
    }
    const by = typeof args['by'] === 'string' && args['by'].trim().length > 0 ? args['by'].trim().slice(0, 80) : undefined;
    const reason = typeof args['reason'] === 'string' && args['reason'].trim().length > 0 ? args['reason'].trim().slice(0, 300) : undefined;
    const table = await this.table();
    const existing = table.rules.find((r) => r.id === id);
    if (existing) {
      await this.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.ruleIds });
      table.rules = table.rules.filter((r) => r !== existing);
    }
    const target = redirect ?? this.blockedPageUrl(id);
    const dnr = dnrRulesFor(patterns, table.nextRuleId, target);
    if (dnr.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'no usable pattern');
    try {
      await this.chrome.declarativeNetRequest.updateDynamicRules({ addRules: dnr });
    } catch (err) {
      throw new BridgeError('FAILED', `The browser refused the blocking rules: ${(err as Error).message}`);
    }
    const rule: BlockRule = {
      id,
      patterns,
      ...(redirect ? { redirect } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(by ? { by } : {}),
      ...(reason ? { reason } : {}),
      ruleIds: dnr.map((r) => r.id),
      createdAt: new Date().toISOString(),
    };
    table.nextRuleId += dnr.length;
    table.rules.push(rule);
    await this.saveTable(table);
    // Tabs already showing a blocked page are moved off it right away.
    let redirectedTabs = 0;
    for (const tab of await this.chrome.tabs.query({})) {
      const url = tab.url ?? tab.pendingUrl ?? '';
      if (typeof tab.id !== 'number' || !/^https?:/i.test(url)) continue;
      if (!patterns.some((p) => urlMatchesPattern(url, p))) continue;
      await this.chrome.tabs.update(tab.id, { url: target }).catch(() => undefined);
      redirectedTabs++;
    }
    return { ...describeRule(rule), redirectedTabs };
  }

  async unblock(id: string): Promise<{ removed: boolean }> {
    const table = await this.table();
    const rule = table.rules.find((r) => r.id === id);
    if (!rule) return { removed: false };
    await this.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rule.ruleIds }).catch(() => undefined);
    table.rules = table.rules.filter((r) => r !== rule);
    await this.saveTable(table);
    return { removed: true };
  }

  async listBlocks(): Promise<Array<ReturnType<typeof describeRule>>> {
    await this.purgeExpired();
    return (await this.table()).rules.map(describeRule);
  }

  async clearBlocks(): Promise<{ removed: number }> {
    const table = await this.table();
    const ids = table.rules.flatMap((r) => r.ruleIds);
    // Also drop dynamic rules the table no longer knows about (a crash between the two writes).
    const live = (await this.chrome.declarativeNetRequest.getDynamicRules().catch(() => [])).map((r) => r.id);
    const removeRuleIds = [...new Set([...ids, ...live])];
    if (removeRuleIds.length > 0) await this.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => undefined);
    const removed = table.rules.length;
    await this.saveTable({ nextRuleId: table.nextRuleId, rules: [] });
    return { removed };
  }

  /** Remove every rule whose expiry has passed (the alarm and `rules.list` call this). */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    const table = await this.table();
    const expired = expiredRules(table, now);
    if (expired.length === 0) {
      // Keep the alarm honest for a table restored from disk.
      const when = nextExpiry(table, now);
      if (when !== undefined) await this.chrome.alarms.create(RULES_ALARM, { when });
      return 0;
    }
    await this.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: expired.flatMap((r) => r.ruleIds) }).catch(() => undefined);
    table.rules = table.rules.filter((r) => !expired.includes(r));
    await this.saveTable(table);
    return expired.length;
  }

  // ---- home page ---------------------------------------------------------------------------

  async setHome(url: unknown): Promise<{ url: string | null }> {
    if (url === null || url === undefined || url === '') {
      await this.chrome.storage.local.remove(HOME_PAGE_KEY);
      return { url: null };
    }
    if (!isNavigableUrl(url)) throw new BridgeError('INVALID_URL', 'The home page must be an http(s) URL');
    await this.chrome.storage.local.set({ [HOME_PAGE_KEY]: url });
    return { url: url as string };
  }

  async getHome(): Promise<{ url: string | null }> {
    const v = (await this.chrome.storage.local.get(HOME_PAGE_KEY))[HOME_PAGE_KEY];
    return { url: isNavigableUrl(v) ? (v as string) : null };
  }

  // ---- bookmarks ---------------------------------------------------------------------------

  async bookmarks(folder?: string): Promise<FlatBookmark[]> {
    const tree = await this.chrome.bookmarks.getTree();
    if (folder === undefined || folder.trim().length === 0) return flattenBookmarks(tree, BOOKMARK_LIST_CAP);
    const found = resolveFolder(tree, folder);
    if (!found || found.missing.length > 0) throw new BridgeError('NOT_FOUND', `No bookmark folder "${folder}"`);
    const paths = pathIndex(tree);
    return flattenBookmarks(found.node.children ?? [], BOOKMARK_LIST_CAP, paths.get(found.node.id) ? `${paths.get(found.node.id)}/${found.node.title}` : found.node.title);
  }

  async searchBookmarks(query: string): Promise<FlatBookmark[]> {
    const [nodes, tree] = await Promise.all([this.chrome.bookmarks.search(query), this.chrome.bookmarks.getTree()]);
    const paths = pathIndex(tree);
    return nodes.slice(0, BOOKMARK_LIST_CAP).map((n) => ({ id: n.id, title: n.title, ...(n.url ? { url: n.url } : {}), parentId: n.parentId ?? '', path: paths.get(n.id) ?? '' }));
  }

  async addBookmark(url: string, title: string, folder?: string): Promise<FlatBookmark> {
    const tree = await this.chrome.bookmarks.getTree();
    let parent: BookmarkNodeLike | undefined;
    if (folder !== undefined && folder.trim().length > 0) {
      const found = resolveFolder(tree, folder);
      let missing: string[];
      if (found) {
        parent = found.node;
        missing = found.missing;
      } else {
        parent = otherBookmarksFolder(tree);
        missing = folder
          .split('/')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      if (!parent) throw new BridgeError('FAILED', 'The browser has no bookmark folders');
      for (const segment of missing) parent = await this.chrome.bookmarks.create({ parentId: parent.id, title: segment });
    } else {
      parent = otherBookmarksFolder(tree);
      if (!parent) throw new BridgeError('FAILED', 'The browser has no bookmark folders');
    }
    const created = await this.chrome.bookmarks.create({ parentId: parent.id, title: title || url, url });
    const paths = pathIndex(await this.chrome.bookmarks.getTree());
    return { id: created.id, title: created.title, ...(created.url ? { url: created.url } : {}), parentId: created.parentId ?? parent.id, path: paths.get(created.id) ?? '' };
  }

  async removeBookmark(args: Record<string, unknown>): Promise<{ removed: number }> {
    const id = typeof args['id'] === 'string' && args['id'].length > 0 ? args['id'] : undefined;
    const url = typeof args['url'] === 'string' && args['url'].length > 0 ? args['url'] : undefined;
    if (!id && !url) throw new BridgeError('INVALID_ARGUMENT', 'bookmarks.remove needs id or url');
    let nodes: BookmarkNodeLike[];
    if (id) {
      try {
        nodes = await this.chrome.bookmarks.get(id);
      } catch {
        throw new BridgeError('NOT_FOUND', `No bookmark with id ${id}`);
      }
    } else {
      nodes = await this.chrome.bookmarks.search({ url: url! });
    }
    if (nodes.length === 0) throw new BridgeError('NOT_FOUND', id ? `No bookmark with id ${id}` : `No bookmark for ${url}`);
    let removed = 0;
    for (const node of nodes) {
      if (!node.url) throw new BridgeError('INVALID_ARGUMENT', `"${node.title}" is a folder; only bookmarks can be removed`);
      await this.chrome.bookmarks.remove(node.id);
      removed++;
    }
    return { removed };
  }

  // ---- history -----------------------------------------------------------------------------

  private historyItem(item: { url?: string; title?: string; lastVisitTime?: number; visitCount?: number }): HistoryItem {
    return { url: item.url ?? '', title: item.title ?? '', lastVisitTime: new Date(item.lastVisitTime ?? 0).toISOString(), visitCount: item.visitCount ?? 0 };
  }

  async historySearch(args: Record<string, unknown>): Promise<HistoryItem[]> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const timeArg = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : undefined;
      }
      return undefined;
    };
    const endTime = timeArg(args['endTime']);
    const startTime = timeArg(args['startTime']) ?? (endTime ?? Date.now()) - HISTORY_DEFAULT_RANGE_MS;
    const maxResults = positiveInt(args['maxResults'], HISTORY_DEFAULT_RESULTS, HISTORY_MAX_RESULTS);
    const items = await this.chrome.history.search({ text, startTime, ...(endTime !== undefined ? { endTime } : {}), maxResults });
    return items.filter((i) => typeof i.url === 'string').map((i) => this.historyItem(i));
  }

  async historyVisits(url: string): Promise<Array<{ visitTime: string; transition: string }>> {
    const visits = await this.chrome.history.getVisits({ url });
    return visits.map((v) => ({ visitTime: new Date(v.visitTime ?? 0).toISOString(), transition: v.transition ?? '' }));
  }

  async historyRecent(maxResults: number): Promise<HistoryItem[]> {
    const items = await this.chrome.history.search({ text: '', startTime: 0, maxResults });
    return items
      .filter((i) => typeof i.url === 'string')
      .map((i) => this.historyItem(i))
      .sort((a, b) => (a.lastVisitTime < b.lastVisitTime ? 1 : a.lastVisitTime > b.lastVisitTime ? -1 : 0))
      .slice(0, maxResults);
  }

  private async tab(tabId: number): Promise<TabLike> {
    try {
      return await this.chrome.tabs.get(tabId);
    } catch {
      throw new BridgeError('NOT_FOUND', `No tab with id ${tabId}`);
    }
  }

  private async inject<T>(tabId: number, func: (...args: never[]) => T, args: unknown[], world?: 'ISOLATED' | 'MAIN'): Promise<Awaited<T>> {
    const tab = await this.tab(tabId);
    if (!isWebUrl(tab.url ?? tab.pendingUrl)) throw new BridgeError('NOT_A_WEB_PAGE', 'This tab shows a browser page, not a web page; only http(s) pages can be read or controlled');
    let results: Array<{ result?: Awaited<T> }>;
    try {
      results = await this.chrome.scripting.executeScript({ target: { tabId }, func, args, ...(world ? { world } : {}) }) as Array<{ result?: Awaited<T> }>;
    } catch (err) {
      throw new BridgeError('INJECT_FAILED', `Could not run in the page: ${(err as Error).message}`);
    }
    const first = results[0];
    if (!first || first.result === undefined) throw new BridgeError('INJECT_FAILED', 'The page returned nothing');
    return first.result;
  }

  /** Wait (bounded) for the tab to finish loading, then describe it. */
  private async settled(tabId: number): Promise<TabInfo> {
    const wait = this.opts.loadWaitMs ?? LOAD_WAIT_MS;
    const initial = await this.tab(tabId);
    if (initial.status === 'complete' && wait === 0) return describeTab(initial);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener: TabsUpdatedListener = (id, change) => {
        if (id === tabId && change.status === 'complete') finish();
      };
      const timer = setTimeout(finish, wait);
      this.chrome.tabs.onUpdated.addListener(listener);
      // The load may already have finished between `get` and adding the listener.
      void this.chrome.tabs
        .get(tabId)
        .then((t) => {
          if (t.status === 'complete' && !t.pendingUrl) finish();
        })
        .catch(() => finish());
    });
    return describeTab(await this.tab(tabId));
  }
}
