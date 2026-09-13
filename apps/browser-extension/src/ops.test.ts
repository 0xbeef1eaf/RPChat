import { describe, expect, it } from 'vitest';
import type { BookmarkNodeLike } from './lib/bookmarks.js';
import { BridgeOps } from './lib/ops.js';
import type { ChromeLike, TabLike, TabsUpdatedListener } from './lib/ops.js';
import { dispatch } from './lib/protocol.js';
import { RULES_ALARM, RULES_STORAGE_KEY } from './lib/rules.js';

function bookmarkTree(): BookmarkNodeLike[] {
  return [
    {
      id: '0',
      title: '',
      children: [
        { id: '1', parentId: '0', title: 'Bookmarks bar', children: [{ id: '10', parentId: '1', title: 'Docs', url: 'https://docs.test/' }] },
        { id: '2', parentId: '0', title: 'Other bookmarks', children: [{ id: '20', parentId: '2', title: 'Recipes', children: [{ id: '21', parentId: '20', title: 'Soup', url: 'https://soup.test/' }] }] },
      ],
    },
  ];
}

/** In-memory tabs + a scripting stub that runs the injected function against a fake page object. */
function fakeChrome(page: Record<string, unknown> = {}) {
  const tabs = new Map<number, TabLike>();
  let nextId = 10;
  const listeners = new Set<TabsUpdatedListener>();
  const calls: string[] = [];
  const storage = new Map<string, unknown>();
  const dynamicRules = new Map<number, { id: number }>();
  const alarms = new Map<string, { when?: number }>();
  const tree = bookmarkTree();
  let nextBookmarkId = 100;
  const findNode = (nodes: BookmarkNodeLike[], id: string): BookmarkNodeLike | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const inner = findNode(n.children ?? [], id);
      if (inner) return inner;
    }
    return undefined;
  };
  const allNodes = (nodes: BookmarkNodeLike[]): BookmarkNodeLike[] => nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);
  const history = [
    { url: 'https://a.test/', title: 'A', lastVisitTime: Date.now() - 1000, visitCount: 3 },
    { url: 'https://old.test/', title: 'Old', lastVisitTime: Date.now() - 30 * 86_400_000, visitCount: 1 },
    { url: 'https://b.test/x', title: 'B', lastVisitTime: Date.now() - 60_000, visitCount: 1 },
  ];
  const emitComplete = (tabId: number): void => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.status = 'complete';
    delete tab.pendingUrl;
    for (const l of [...listeners]) l(tabId, { status: 'complete' }, tab);
  };
  const chrome: ChromeLike = {
    tabs: {
      query: async () => [...tabs.values()],
      get: async (id) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return t;
      },
      create: async ({ url, active }) => {
        const tab: TabLike = { id: nextId++, windowId: 1, pendingUrl: url, title: '', active: active !== false, index: tabs.size, status: 'loading' };
        tabs.set(tab.id!, tab);
        calls.push(`create ${url}`);
        setTimeout(() => {
          tab.url = url;
          tab.title = `Page ${url}`;
          emitComplete(tab.id!);
        }, 5);
        return tab;
      },
      update: async (id, props) => {
        const tab = tabs.get(id)!;
        calls.push(`update ${id} ${JSON.stringify(props)}`);
        if (props.active) for (const t of tabs.values()) t.active = t.id === id;
        if (props.url) {
          tab.status = 'loading';
          tab.pendingUrl = props.url;
          setTimeout(() => {
            tab.url = props.url;
            emitComplete(id);
          }, 5);
        }
        return tab;
      },
      remove: async (id) => {
        calls.push(`remove ${id}`);
        tabs.delete(id);
      },
      goBack: async (id) => {
        calls.push(`back ${id}`);
        setTimeout(() => emitComplete(id), 5);
      },
      goForward: async (id) => {
        calls.push(`forward ${id}`);
        setTimeout(() => emitComplete(id), 5);
      },
      reload: async (id) => {
        calls.push(`reload ${id}`);
        setTimeout(() => emitComplete(id), 5);
      },
      captureVisibleTab: async (windowId, options) => {
        calls.push(`capture ${windowId} ${options.format}`);
        return `data:image/${options.format};base64,AAAA`;
      },
      onUpdated: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
    },
    windows: {
      create: async ({ url }) => {
        const tab: TabLike = { id: nextId++, windowId: 2, url, title: 'new window', active: true, index: 0, status: 'complete' };
        tabs.set(tab.id!, tab);
        calls.push(`window ${url}`);
        return { id: 2, tabs: [tab] };
      },
      update: async (id, props) => {
        calls.push(`focus ${id} ${JSON.stringify(props)}`);
      },
    },
    scripting: {
      executeScript: async ({ target, func, args, world }) => {
        calls.push(`inject ${target.tabId} ${func.name}${world ? ` ${world}` : ''}`);
        const impl = page[func.name];
        if (typeof impl !== 'function') return [{ result: undefined }];
        return [{ result: (await (impl as (...a: unknown[]) => unknown)(...(args ?? []))) as never }];
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [...dynamicRules.values()],
      updateDynamicRules: async ({ addRules, removeRuleIds }) => {
        for (const id of removeRuleIds ?? []) dynamicRules.delete(id);
        for (const r of addRules ?? []) {
          if (dynamicRules.has(r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
          dynamicRules.set(r.id, r);
        }
        calls.push(`dnr +${(addRules ?? []).length} -${(removeRuleIds ?? []).length}`);
      },
    },
    storage: {
      local: {
        get: async (key) => {
          const keys = key === null ? [...storage.keys()] : Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => storage.has(k)).map((k) => [k, storage.get(k)]));
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (key) => {
          for (const k of Array.isArray(key) ? key : [key]) storage.delete(k);
        },
      },
    },
    alarms: {
      create: (name, info) => {
        alarms.set(name, info);
      },
      clear: (name) => alarms.delete(name),
    },
    runtime: { getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}` },
    bookmarks: {
      getTree: async () => JSON.parse(JSON.stringify(tree)) as BookmarkNodeLike[],
      getSubTree: async (id) => {
        const n = findNode(tree, id);
        if (!n) throw new Error(`Can't find bookmark for id.`);
        return [JSON.parse(JSON.stringify(n)) as BookmarkNodeLike];
      },
      get: async (id) => {
        const n = findNode(tree, id);
        if (!n) throw new Error(`Can't find bookmark for id.`);
        const { children, ...rest } = n;
        void children;
        return [rest];
      },
      search: async (query) => {
        const nodes = allNodes(tree).filter((n) => n.id !== '0');
        if (typeof query === 'string') {
          const q = query.toLowerCase();
          return nodes.filter((n) => n.title.toLowerCase().includes(q) || (n.url ?? '').toLowerCase().includes(q)).map(({ children, ...rest }) => (void children, rest));
        }
        return nodes.filter((n) => (query.url ? n.url === query.url : true) && (query.title ? n.title === query.title : true)).map(({ children, ...rest }) => (void children, rest));
      },
      create: async ({ parentId, title, url }) => {
        const parent = findNode(tree, parentId ?? '2');
        if (!parent) throw new Error('Can\'t find parent bookmark for id.');
        const node: BookmarkNodeLike = { id: String(nextBookmarkId++), parentId: parent.id, title: title ?? '', ...(url ? { url } : { children: [] }) };
        (parent.children ??= []).push(node);
        calls.push(`bookmark ${url ? 'add' : 'folder'} ${parent.id}/${title}`);
        return node;
      },
      remove: async (id) => {
        const node = findNode(tree, id);
        if (!node) throw new Error(`Can't find bookmark for id.`);
        const parent = findNode(tree, node.parentId ?? '0')!;
        parent.children = (parent.children ?? []).filter((c) => c.id !== id);
        calls.push(`bookmark remove ${id}`);
      },
    },
    history: {
      search: async ({ text, startTime, endTime, maxResults }) =>
        history
          .filter((h) => (text ? h.url.includes(text) || h.title.includes(text) : true) && h.lastVisitTime >= (startTime ?? 0) && h.lastVisitTime <= (endTime ?? Number.MAX_SAFE_INTEGER))
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
          .slice(0, maxResults ?? 100),
      getVisits: async ({ url }) => (history.some((h) => h.url === url) ? [{ visitTime: Date.now() - 1000, transition: 'link' }, { visitTime: Date.now() - 500, transition: 'typed' }] : []),
    },
  };
  return { chrome, tabs, calls, storage, dynamicRules, alarms, add: (tab: TabLike) => tabs.set(tab.id!, tab) };
}

const ARGS = (o: Record<string, unknown>) => o;

describe('BridgeOps', () => {
  it('lists tabs, hiding internal page details', async () => {
    const f = fakeChrome();
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', title: 'A', active: true, index: 0 });
    f.add({ id: 2, windowId: 1, url: 'chrome://extensions/', title: 'Extensions', active: false, index: 1 });
    const ops = new BridgeOps(f.chrome);
    expect(await ops.list()).toEqual([
      { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', active: true, index: 0 },
      { id: 2, windowId: 1, url: 'chrome://', title: '', active: false, index: 1 },
    ]);
  });

  it('opens a tab and waits for it to load', async () => {
    const f = fakeChrome();
    const ops = new BridgeOps(f.chrome, { loadWaitMs: 500 });
    const info = await ops.open(ARGS({ url: 'https://a.test/x' }));
    expect(info).toMatchObject({ url: 'https://a.test/x', title: 'Page https://a.test/x', active: true });
    expect(f.calls).toContain('create https://a.test/x');
    const win = await ops.open(ARGS({ url: 'https://b.test/', newWindow: true }));
    expect(win.windowId).toBe(2);
  });

  it('refuses non-http URLs for open and navigate', async () => {
    const f = fakeChrome();
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', status: 'complete' });
    const h = new BridgeOps(f.chrome, { loadWaitMs: 100 }).handlers();
    expect(await dispatch({ id: '1', op: 'tabs.open', args: { url: 'chrome://settings' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await dispatch({ id: '2', op: 'tabs.navigate', args: { tabId: 1, url: 'javascript:alert(1)' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await dispatch({ id: '3', op: 'tabs.navigate', args: { tabId: 1, url: 'file:///tmp/x.html' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await dispatch({ id: '4', op: 'tabs.navigate', args: { tabId: 1, url: 'file:///tmp/x.html', allowFile: true } }, h)).toMatchObject({ ok: true, value: { url: 'file:///tmp/x.html' } });
    expect(f.calls.filter((c) => c.startsWith('update'))).toHaveLength(1);
  });

  it('validates tab ids and reports unknown tabs', async () => {
    const f = fakeChrome();
    const h = new BridgeOps(f.chrome).handlers();
    expect(await dispatch({ id: '1', op: 'tabs.close', args: { tabId: 'x' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: '2', op: 'tabs.close', args: { tabId: 99 } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatch({ id: '3', op: 'page.query', args: { tabId: 1 } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('activate, close, back/forward/reload', async () => {
    const f = fakeChrome();
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', active: false, status: 'complete' });
    f.add({ id: 2, windowId: 1, url: 'https://b.test/', active: true, status: 'complete' });
    const ops = new BridgeOps(f.chrome, { loadWaitMs: 200 });
    expect((await ops.activate(1)).active).toBe(true);
    expect(f.calls).toContain('focus 1 {"focused":true}');
    await ops.history(1, 'back');
    await ops.history(1, 'forward');
    await ops.history(1, 'reload');
    expect(f.calls).toEqual(expect.arrayContaining(['back 1', 'forward 1', 'reload 1']));
    expect(await ops.close(2)).toEqual({ closed: true });
    expect(f.tabs.has(2)).toBe(false);
  });

  it('page ops inject on demand and only into web pages', async () => {
    const f = fakeChrome({
      pageRead: (max: number) => ({ url: 'https://a.test/', title: 'A', text: `  Hello   world \n\n\n from   the page ${'x'.repeat(max)}` }),
      pageQuery: (selector: string, limit: number) => [{ index: 0, tag: 'a', text: `${selector}:${limit}`, href: 'https://a.test/next' }],
      pageClick: (selector: string, index: number) => (selector === 'a' ? { clicked: true, tag: 'a', text: 'next', matches: 1 } : { clicked: false, matches: 0 + index }),
      pageType: (selector: string, text: string, submit: boolean) => (selector === 'input' ? { typed: true, submitted: submit, tag: 'input' } : { typed: false, submitted: false }),
      pageScroll: (y: number | null, selector: string | null) => ({ x: 0, y: y ?? 999, height: 5000, found: selector !== null }),
      pageFind: (text: string) => ({ count: text === 'hello' ? 2 : 0 }),
    });
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', active: true, status: 'complete' });
    f.add({ id: 2, windowId: 1, url: 'chrome://newtab/', active: false, status: 'complete' });
    const h = new BridgeOps(f.chrome).handlers();
    const read = await dispatch({ id: 'r', op: 'page.read', args: { tabId: 1, maxChars: 30 } }, h);
    expect(read).toMatchObject({ ok: true, value: { url: 'https://a.test/', title: 'A' } });
    const text = (read as { value: { text: string } }).value.text;
    expect(text.startsWith('Hello world\nfrom')).toBe(true);
    expect(text.endsWith('[…truncated]')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(30);
    expect(await dispatch({ id: 'q', op: 'page.query', args: { tabId: 1, selector: 'a', limit: 5 } }, h)).toMatchObject({ ok: true, value: [{ tag: 'a', text: 'a:5' }] });
    expect(await dispatch({ id: 'c', op: 'page.click', args: { tabId: 1, selector: 'a' } }, h)).toMatchObject({ ok: true, value: { clicked: true } });
    expect(await dispatch({ id: 'c2', op: 'page.click', args: { tabId: 1, selector: 'nope', index: 2 } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatch({ id: 't', op: 'page.type', args: { tabId: 1, selector: 'input', text: 'hi', submit: true } }, h)).toMatchObject({ ok: true, value: { typed: true, submitted: true } });
    expect(await dispatch({ id: 't2', op: 'page.type', args: { tabId: 1, selector: 'div', text: 'hi' } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatch({ id: 's', op: 'page.scroll', args: { tabId: 1, y: 120 } }, h)).toMatchObject({ ok: true, value: { y: 120 } });
    expect(await dispatch({ id: 's2', op: 'page.scroll', args: { tabId: 1 } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: 'f', op: 'page.find', args: { tabId: 1, text: 'hello' } }, h)).toMatchObject({ ok: true, value: { count: 2 } });
    // Internal pages are never injected into.
    expect(await dispatch({ id: 'x', op: 'page.read', args: { tabId: 2 } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_A_WEB_PAGE' } });
    expect(f.calls.filter((c) => c.startsWith('inject 2'))).toHaveLength(0);
  });

  it('screenshot activates the tab and captures its window', async () => {
    const f = fakeChrome();
    f.add({ id: 1, windowId: 7, url: 'https://a.test/', active: false, status: 'complete' });
    f.add({ id: 2, windowId: 7, url: 'chrome://about', active: true, status: 'complete' });
    const ops = new BridgeOps(f.chrome);
    const shot = await ops.screenshot(1, 'png');
    expect(shot.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(f.calls).toContain('capture 7 png');
    expect(f.tabs.get(1)?.active).toBe(true);
    await expect(ops.screenshot(2, 'png')).rejects.toMatchObject({ code: 'NOT_A_WEB_PAGE' });
  });
});

describe('BridgeOps: blocking, effects, eval, home, bookmarks, history', () => {
  it('installs DNR rules per pattern, moves tabs already on a blocked page, lists, unblocks and clears', async () => {
    const f = fakeChrome();
    f.add({ id: 1, windowId: 1, url: 'https://news.example.com/top', status: 'complete' });
    f.add({ id: 2, windowId: 1, url: 'https://fine.test/', status: 'complete' });
    const ops = new BridgeOps(f.chrome, { loadWaitMs: 0 });
    const h = ops.handlers();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const blocked = await dispatch({ id: 'b', op: 'rules.block', args: { id: 'r1', patterns: ['example.com', 'other.test/x*'], expiresAt, by: 'Mira' } }, h);
    expect(blocked).toMatchObject({ ok: true, value: { id: 'r1', patterns: ['example.com', 'other.test/x*'], expiresAt, by: 'Mira', redirectedTabs: 1 } });
    expect([...f.dynamicRules.keys()]).toEqual([1, 2]);
    expect(f.dynamicRules.get(1)).toMatchObject({ action: { type: 'redirect', redirect: { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html?rule=r1' } }, condition: { resourceTypes: ['main_frame'] } });
    expect(f.calls).toContain('update 1 {"url":"chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html?rule=r1"}');
    expect(f.calls.some((c) => c.startsWith('update 2'))).toBe(false);
    expect(f.alarms.get(RULES_ALARM)?.when).toBe(Date.parse(expiresAt));
    // A redirect target is used instead of the blocked page, and the table survives (storage).
    await dispatch({ id: 'b2', op: 'rules.block', args: { id: 'r2', patterns: ['*.video.test'], redirect: 'https://calm.test/' } }, h);
    expect(f.dynamicRules.get(3)).toMatchObject({ action: { type: 'redirect', redirect: { url: 'https://calm.test/' } } });
    expect((f.storage.get(RULES_STORAGE_KEY) as { rules: unknown[] }).rules).toHaveLength(2);
    expect(await ops.listBlocks()).toMatchObject([{ id: 'r1' }, { id: 'r2', redirect: 'https://calm.test/' }]);
    // Re-blocking the same id replaces its rules.
    await dispatch({ id: 'b3', op: 'rules.block', args: { id: 'r1', patterns: ['example.com'] } }, h);
    expect([...f.dynamicRules.keys()].sort()).toEqual([3, 4]);
    expect(await ops.unblock('r1')).toEqual({ removed: true });
    expect(await ops.unblock('r1')).toEqual({ removed: false });
    expect([...f.dynamicRules.keys()]).toEqual([3]);
    expect(await ops.clearBlocks()).toEqual({ removed: 1 });
    expect(f.dynamicRules.size).toBe(0);
    expect(f.alarms.has(RULES_ALARM)).toBe(false);
  });

  it('refuses protected hosts, bad patterns, past expiries and non-http redirects', async () => {
    const f = fakeChrome();
    const h = new BridgeOps(f.chrome).handlers();
    expect(await dispatch({ id: '1', op: 'rules.block', args: { id: 'x', patterns: ['127.0.0.1'] } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('protected') } });
    expect(await dispatch({ id: '2', op: 'rules.block', args: { id: 'x', patterns: ['chrome://settings'] } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: '3', op: 'rules.block', args: { id: 'x', patterns: [] } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: '4', op: 'rules.block', args: { id: 'x', patterns: ['a.test'], expiresAt: '2000-01-01T00:00:00Z' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('past') } });
    expect(await dispatch({ id: '5', op: 'rules.block', args: { id: 'x', patterns: ['a.test'], redirect: 'javascript:1' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await dispatch({ id: '6', op: 'rules.block', args: { id: 'x', patterns: ['a.test'], redirect: 'https://a.test/calm' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('itself') } });
    expect(f.dynamicRules.size).toBe(0);
  });

  it('purges expired rules on the alarm and keeps the alarm for the rest', async () => {
    const f = fakeChrome();
    const ops = new BridgeOps(f.chrome);
    const soon = new Date(Date.now() + 1000).toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await ops.block({ id: 'soon', patterns: ['a.test'], expiresAt: soon });
    await ops.block({ id: 'later', patterns: ['b.test'], expiresAt: later });
    await ops.block({ id: 'forever', patterns: ['c.test'] });
    expect(await ops.purgeExpired(Date.now() + 2000)).toBe(1);
    expect((await ops.listBlocks()).map((r) => r.id)).toEqual(['later', 'forever']);
    expect([...f.dynamicRules.keys()]).toEqual([2, 3]);
    expect(f.alarms.get(RULES_ALARM)?.when).toBe(Date.parse(later));
    expect(await ops.purgeExpired(Date.now() + 2000)).toBe(0);
  });

  it('applies image effects through the page helper and validates the effect', async () => {
    const injected: unknown[][] = [];
    const f = fakeChrome({
      pageImageEffect: (...args: unknown[]) => (injected.push(args), { applied: true, replaced: 2, total: 3 }),
      pageClearImageEffects: () => ({ cleared: true, restored: 2 }),
    });
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', status: 'complete' });
    const h = new BridgeOps(f.chrome).handlers();
    expect(await dispatch({ id: 'e', op: 'page.imageEffect', args: { tabId: 1, effect: 'grayscale', replaceWith: 'http://127.0.0.1:1/t/x/asset/p/a.png', durationMs: 5000 } }, h)).toMatchObject({ ok: true, value: { replaced: 2, effect: 'grayscale' } });
    expect(injected[0]).toEqual(['img, picture, video { filter: grayscale(1) !important; }', 'img, picture, video', 'http://127.0.0.1:1/t/x/asset/p/a.png', 5000]);
    await dispatch({ id: 'e2', op: 'page.imageEffect', args: { tabId: 1, effect: { css: 'blur(2px)' }, selector: '.hero img' } }, h);
    expect(injected[1]).toEqual(['.hero img { filter: blur(2px) !important; }', '.hero img', null, 0]);
    expect(await dispatch({ id: 'e3', op: 'page.imageEffect', args: { tabId: 1, effect: 'sparkle' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: 'e4', op: 'page.imageEffect', args: { tabId: 1, effect: 'blur', replaceWith: 'data:image/png;base64,AA' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatch({ id: 'c', op: 'page.clearImageEffects', args: { tabId: 1 } }, h)).toMatchObject({ ok: true, value: { cleared: true, restored: 2 } });
  });

  it('evaluates code in the isolated world by default, main on request, with timeout and size caps', async () => {
    const f = fakeChrome({
      pageEval: async (src: string) => {
        if (src.includes('throw')) return { ok: false, error: 'TypeError: boom' };
        if (src.includes('slow')) return new Promise((r) => setTimeout(() => r({ ok: true, json: '1' }), 200));
        if (src.includes('big')) return { ok: true, json: JSON.stringify('x'.repeat(70_000)) };
        return { ok: true, json: JSON.stringify({ title: 'T', src }) };
      },
    });
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', status: 'complete' });
    const h = new BridgeOps(f.chrome).handlers();
    expect(await dispatch({ id: '1', op: 'page.eval', args: { tabId: 1, code: 'return document.title' } }, h)).toEqual({ id: '1', ok: true, value: { value: { title: 'T', src: 'return document.title' }, world: 'isolated' } });
    expect(f.calls.at(-1)).toBe('inject 1 pageEval ISOLATED');
    expect(await dispatch({ id: '2', op: 'page.eval', args: { tabId: 1, code: 'return 1', world: 'main' } }, h)).toMatchObject({ ok: true, value: { world: 'main' } });
    expect(f.calls.at(-1)).toBe('inject 1 pageEval MAIN');
    expect(await dispatch({ id: '3', op: 'page.eval', args: { tabId: 1, code: 'throw 1' } }, h)).toMatchObject({ ok: false, error: { code: 'EVAL_FAILED', message: 'TypeError: boom' } });
    expect(await dispatch({ id: '4', op: 'page.eval', args: { tabId: 1, code: 'slow', timeoutMs: 50 } }, h)).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(await dispatch({ id: '5', op: 'page.eval', args: { tabId: 1, code: 'big' } }, h)).toMatchObject({ ok: false, error: { code: 'RESULT_TOO_LARGE' } });
    expect(await dispatch({ id: '6', op: 'page.eval', args: { tabId: 1 } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('falls back to the main world when the isolated world refuses eval (extension CSP), and remembers it', async () => {
    const worlds: string[] = [];
    const f = fakeChrome({
      pageEval: async (src: string) => {
        const world = f.calls.at(-1)!.endsWith('MAIN') ? 'MAIN' : 'ISOLATED';
        worlds.push(world);
        if (world === 'ISOLATED') return { ok: false, error: "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"." };
        if (src.includes('pagecsp')) return { ok: false, error: "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src https:\"." };
        return { ok: true, json: JSON.stringify(src) };
      },
    });
    f.add({ id: 1, windowId: 1, url: 'https://a.test/', status: 'complete' });
    const ops = new BridgeOps(f.chrome);
    const first = await ops.eval(1, { code: 'return 1' });
    expect(first).toEqual({ value: 'return 1', world: 'main', fallback: expect.stringContaining('isolated world refuses eval') });
    expect(worlds).toEqual(['ISOLATED', 'MAIN']);
    const second = await ops.eval(1, { code: 'return 2' });
    expect(second.world).toBe('main');
    expect(worlds).toEqual(['ISOLATED', 'MAIN', 'MAIN']);
    // A page CSP that also forbids eval in the main world is reported as such.
    await expect(ops.eval(1, { code: 'pagecsp', world: 'main' })).rejects.toMatchObject({ code: 'EVAL_FAILED', message: expect.stringContaining("page's Content Security Policy") });
  });

  it('stores the home page (http(s) only) and clears it with null', async () => {
    const f = fakeChrome();
    const h = new BridgeOps(f.chrome).handlers();
    expect(await dispatch({ id: '1', op: 'home.get', args: {} }, h)).toMatchObject({ ok: true, value: { url: null } });
    expect(await dispatch({ id: '2', op: 'home.set', args: { url: 'https://home.test/' } }, h)).toMatchObject({ ok: true, value: { url: 'https://home.test/' } });
    expect(f.storage.get('homePage')).toBe('https://home.test/');
    expect(await dispatch({ id: '3', op: 'home.set', args: { url: 'chrome://newtab' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await dispatch({ id: '4', op: 'home.get', args: {} }, h)).toMatchObject({ ok: true, value: { url: 'https://home.test/' } });
    expect(await dispatch({ id: '5', op: 'home.set', args: { url: null } }, h)).toMatchObject({ ok: true, value: { url: null } });
    expect(f.storage.has('homePage')).toBe(false);
  });

  it('lists, searches, adds (creating folders under Other bookmarks) and removes bookmarks', async () => {
    const f = fakeChrome();
    const ops = new BridgeOps(f.chrome);
    const h = ops.handlers();
    expect((await ops.bookmarks()).map((b) => b.path + '|' + b.title)).toEqual(['|Bookmarks bar', 'Bookmarks bar|Docs', '|Other bookmarks', 'Other bookmarks|Recipes', 'Other bookmarks/Recipes|Soup']);
    expect(await ops.bookmarks('Recipes')).toEqual([{ id: '21', title: 'Soup', url: 'https://soup.test/', parentId: '20', path: 'Other bookmarks/Recipes' }]);
    expect(await dispatch({ id: 'l', op: 'bookmarks.list', args: { folder: 'Nope' } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await ops.searchBookmarks('soup')).toEqual([{ id: '21', title: 'Soup', url: 'https://soup.test/', parentId: '20', path: 'Other bookmarks/Recipes' }]);
    const added = await ops.addBookmark('https://bread.test/', 'Bread', 'Recipes/Baking');
    expect(added).toMatchObject({ title: 'Bread', url: 'https://bread.test/', path: 'Other bookmarks/Recipes/Baking' });
    expect(f.calls).toContain('bookmark folder 20/Baking');
    const loose = await ops.addBookmark('https://loose.test/', '', undefined);
    expect(loose).toMatchObject({ title: 'https://loose.test/', parentId: '2', path: 'Other bookmarks' });
    const fresh = await ops.addBookmark('https://new.test/', 'New', 'Brand new');
    expect(fresh.path).toBe('Other bookmarks/Brand new');
    expect(await dispatch({ id: 'a', op: 'bookmarks.add', args: { url: 'javascript:1', title: 'x' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect(await ops.removeBookmark({ id: added.id })).toEqual({ removed: 1 });
    expect(await ops.removeBookmark({ url: 'https://loose.test/' })).toEqual({ removed: 1 });
    expect(await dispatch({ id: 'r', op: 'bookmarks.remove', args: { id: '20' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('folder') } });
    expect(await dispatch({ id: 'r2', op: 'bookmarks.remove', args: { url: 'https://none.test/' } }, h)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatch({ id: 'r3', op: 'bookmarks.remove', args: {} }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('searches history (last 7 days by default), lists visits and the most recent entries', async () => {
    const f = fakeChrome();
    const ops = new BridgeOps(f.chrome);
    const h = ops.handlers();
    const recent = await ops.historySearch({});
    expect(recent.map((i) => i.url)).toEqual(['https://a.test/', 'https://b.test/x']);
    expect(recent[0]).toMatchObject({ title: 'A', visitCount: 3, lastVisitTime: expect.stringMatching(/^\d{4}-/) });
    expect((await ops.historySearch({ text: 'b.test' })).map((i) => i.url)).toEqual(['https://b.test/x']);
    expect((await ops.historySearch({ startTime: 0 })).map((i) => i.url)).toContain('https://old.test/');
    expect((await ops.historySearch({ startTime: new Date(0).toISOString(), maxResults: 1 })).length).toBe(1);
    expect(await ops.historyVisits('https://a.test/')).toEqual([{ visitTime: expect.any(String), transition: 'link' }, { visitTime: expect.any(String), transition: 'typed' }]);
    expect(await dispatch({ id: 'v', op: 'history.visits', args: { url: 'chrome://history' } }, h)).toMatchObject({ ok: false, error: { code: 'INVALID_URL' } });
    expect((await ops.historyRecent(2)).map((i) => i.url)).toEqual(['https://a.test/', 'https://b.test/x']);
  });
});
