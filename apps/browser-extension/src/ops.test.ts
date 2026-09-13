import { describe, expect, it } from 'vitest';
import { BridgeOps } from './lib/ops.js';
import type { ChromeLike, TabLike, TabsUpdatedListener } from './lib/ops.js';
import { dispatch } from './lib/protocol.js';

/** In-memory tabs + a scripting stub that runs the injected function against a fake page object. */
function fakeChrome(page: Record<string, unknown> = {}) {
  const tabs = new Map<number, TabLike>();
  let nextId = 10;
  const listeners = new Set<TabsUpdatedListener>();
  const calls: string[] = [];
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
      executeScript: async ({ target, func, args }) => {
        calls.push(`inject ${target.tabId} ${func.name}`);
        const impl = page[func.name];
        if (typeof impl !== 'function') return [{ result: undefined }];
        return [{ result: (impl as (...a: unknown[]) => unknown)(...(args ?? [])) as never }];
      },
    },
  };
  return { chrome, tabs, calls, add: (tab: TabLike) => tabs.set(tab.id!, tab) };
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
