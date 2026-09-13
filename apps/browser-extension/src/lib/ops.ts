/**
 * The ops the app can ask for, implemented over a small `ChromeLike` subset of the extension APIs
 * so tests can drive them with a fake. Every op validates its arguments (bad input → `BridgeError`
 * with a code the app relays) and only ever touches web pages (`isWebUrl`).
 */
import { pageClick, pageFind, pageQuery, pageRead, pageScroll, pageType } from './page.js';
import { BridgeError, DEFAULT_MAX_CHARS, describeTab, isNavigableUrl, isWebUrl, normaliseText, positiveInt } from './protocol.js';
import type { OpHandler, TabInfo } from './protocol.js';

/** How long `tabs.open` / `tabs.navigate` wait for the page to finish loading before answering. */
export const LOAD_WAIT_MS = 10_000;
export const QUERY_LIMIT_DEFAULT = 50;
export const QUERY_LIMIT_MAX = 500;
/** Raw innerText requested from the page: generous so the whitespace collapse has room to work. */
const RAW_TEXT_FACTOR = 3;

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
    executeScript<T>(injection: { target: { tabId: number }; func: (...args: never[]) => T; args?: unknown[] }): Promise<Array<{ result?: T }>>;
  };
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

  private async tab(tabId: number): Promise<TabLike> {
    try {
      return await this.chrome.tabs.get(tabId);
    } catch {
      throw new BridgeError('NOT_FOUND', `No tab with id ${tabId}`);
    }
  }

  private async inject<T>(tabId: number, func: (...args: never[]) => T, args: unknown[]): Promise<T> {
    const tab = await this.tab(tabId);
    if (!isWebUrl(tab.url ?? tab.pendingUrl)) throw new BridgeError('NOT_A_WEB_PAGE', 'This tab shows a browser page, not a web page; only http(s) pages can be read or controlled');
    let results: Array<{ result?: T }>;
    try {
      results = await this.chrome.scripting.executeScript({ target: { tabId }, func, args });
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
