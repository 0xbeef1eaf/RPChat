import { describe, expect, it } from 'vitest';
import type { Json } from '@rp/shared';
import { BLOCKING_DISABLED_MESSAGE, BrowserHandler, EVAL_DISABLED_MESSAGE, HISTORY_DISABLED_MESSAGE, NOT_CONNECTED_MESSAGE } from './browser.js';
import type { BrowserBridgeLike } from './browser.js';
import type { CommandRunner } from './commands-runner.js';

const ctx = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } as const };

/** A bridge that records requests and answers from a script. */
function fakeBridge(connected: boolean, answers: Record<string, Json | ((args: Record<string, Json>) => Json)> = {}) {
  const calls: Array<{ op: string; args: Record<string, Json> }> = [];
  const bridge: BrowserBridgeLike = {
    connected,
    request: async (op, args = {}) => {
      calls.push({ op, args });
      const a = answers[op];
      return typeof a === 'function' ? a(args) : (a ?? null);
    },
    status: async () => (connected ? { connected: true, browser: 'Chromium 141' } : { connected: false }),
  };
  return { bridge, calls };
}

function fakeCommands(template = 'xdg-open {url}') {
  const runs: Array<{ command: string; vars: Record<string, string> }> = [];
  const commands = {
    resolve: async () => ({ command: template }),
    runTemplate: async (tpl: { command: string }, vars: Record<string, string>) => {
      runs.push({ command: tpl.command, vars });
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as CommandRunner;
  return { commands, runs };
}

describe('BrowserHandler without the extension', () => {
  it('open falls back to the browser command; everything else fails with the install hint', async () => {
    const { commands, runs } = fakeCommands();
    const { bridge, calls } = fakeBridge(false);
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [] });
    expect(await h.invoke('open', ['https://a.test/x', { newWindow: true }], ctx)).toBeNull();
    expect(runs).toEqual([{ command: 'xdg-open {url}', vars: { url: 'https://a.test/x', newWindow: '' } }]);
    expect(await h.invoke('status', [], ctx)).toEqual({ connected: false });
    for (const [method, args] of [
      ['tabs', []],
      ['openTab', ['https://a.test']],
      ['read', []],
      ['screenshot', []],
      ['click', [1, 'a']],
      ['type', [1, 'input', 'x']],
      ['navigate', [1, 'https://a.test']],
      ['close', [1]],
      ['find', [1, 'x']],
    ] as Array<[string, Json[]]>) {
      await expect(h.invoke(method, args, ctx), method).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: NOT_CONNECTED_MESSAGE });
    }
    expect(calls).toEqual([]);
    await expect(h.invoke('nope', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });

  it('a handler built without any bridge behaves the same', async () => {
    const { commands } = fakeCommands();
    const h = new BrowserHandler({ commands });
    expect(await h.invoke('status', [], ctx)).toEqual({ connected: false });
    await expect(h.invoke('tabs', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
  });
});

describe('BrowserHandler with the extension', () => {
  it('routes every method to the matching op with validated arguments', async () => {
    const { commands, runs } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, {
      'tabs.list': [
        { id: 1, windowId: 1, url: 'chrome://newtab/', title: '', active: true, index: 0 },
        { id: 2, windowId: 1, url: 'https://a.test/', title: 'A', active: true, index: 1 },
      ],
      'tabs.open': (args) => ({ id: 9, windowId: 1, url: args['url'], title: 'opened', active: true, index: 2 }),
      'page.read': { url: 'https://a.test/', title: 'A', text: 'hello' },
      'page.screenshot': { dataUrl: 'data:image/png;base64,AA', url: 'https://a.test/', title: 'A' },
    });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [] });
    expect(await h.invoke('status', [], ctx)).toEqual({ connected: true, browser: 'Chromium 141' });
    expect(await h.invoke('open', ['https://a.test/x'], ctx)).toMatchObject({ id: 9, url: 'https://a.test/x' });
    expect(runs).toEqual([]);
    expect(await h.invoke('openTab', ['https://b.test/', { active: false, newWindow: true }], ctx)).toMatchObject({ id: 9 });
    expect(await h.invoke('tabs', [], ctx)).toHaveLength(2);
    // read/screenshot without a tab id pick the active web tab (not the internal one).
    expect(await h.invoke('read', [undefined, { maxChars: 500 }], ctx)).toEqual({ url: 'https://a.test/', title: 'A', text: 'hello' });
    expect(await h.invoke('screenshot', [], ctx)).toMatchObject({ dataUrl: expect.stringContaining('data:image/png') });
    await h.invoke('activate', [2], ctx);
    await h.invoke('close', [2], ctx);
    await h.invoke('navigate', [2, 'https://c.test/'], ctx);
    await h.invoke('back', [2], ctx);
    await h.invoke('forward', [2], ctx);
    await h.invoke('reload', [2], ctx);
    await h.invoke('query', [2, 'a', { limit: 3 }], ctx);
    await h.invoke('click', [2, 'a', { index: 1 }], ctx);
    await h.invoke('type', [2, 'input', 'hi', { submit: true }], ctx);
    await h.invoke('scroll', [2, { y: 100 }], ctx);
    await h.invoke('scroll', [2, { selector: '#x' }], ctx);
    await h.invoke('find', [2, 'needle'], ctx);
    expect(calls.map((c) => c.op)).toEqual([
      'tabs.open', 'tabs.open', 'tabs.list', 'tabs.list', 'page.read', 'tabs.list', 'page.screenshot',
      'tabs.activate', 'tabs.close', 'tabs.navigate', 'tabs.back', 'tabs.forward', 'tabs.reload',
      'page.query', 'page.click', 'page.type', 'page.scroll', 'page.scroll', 'page.find',
    ]);
    expect(calls[0]!.args).toEqual({ url: 'https://a.test/x', active: true, newWindow: false });
    expect(calls[1]!.args).toEqual({ url: 'https://b.test/', active: false, newWindow: true });
    expect(calls[4]!.args).toEqual({ tabId: 2, maxChars: 500 });
    expect(calls[6]!.args).toEqual({ tabId: 2, format: 'png' });
    expect(calls[13]!.args).toEqual({ tabId: 2, selector: 'a', limit: 3 });
    expect(calls[14]!.args).toEqual({ tabId: 2, selector: 'a', index: 1 });
    expect(calls[15]!.args).toEqual({ tabId: 2, selector: 'input', text: 'hi', submit: true });
    expect(calls[16]!.args).toEqual({ tabId: 2, y: 100 });
    expect(calls[17]!.args).toEqual({ tabId: 2, selector: '#x' });
  });

  it('validates arguments before touching the bridge', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'tabs.list': [] });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [] });
    await expect(h.invoke('activate', ['1'], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('query', [1, ''], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('type', [1, 'input', 5], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('scroll', [1, {}], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('openTab', ['ftp://x'], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('navigate', [1, 'chrome://settings'], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual([]);
    await expect(h.invoke('read', [], ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('applies the web allowlist to open, openTab and navigate', async () => {
    const { commands, runs } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'tabs.open': { id: 1 }, 'tabs.navigate': { id: 1 } });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => ['example.com', '*.wikipedia.org'] });
    await expect(h.invoke('open', ['https://evil.test/'], ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(h.invoke('openTab', ['https://evil.test/'], ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(h.invoke('navigate', [1, 'https://notwikipedia.org/'], ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
    await h.invoke('open', ['https://example.com/a'], ctx);
    await h.invoke('openTab', ['https://en.wikipedia.org/wiki/Aurora'], ctx);
    await h.invoke('navigate', [1, 'https://example.com/b'], ctx);
    expect(calls.map((c) => c.op)).toEqual(['tabs.open', 'tabs.open', 'tabs.navigate']);
    // The command fallback is allowlisted too.
    const offline = new BrowserHandler({ commands, bridge: fakeBridge(false).bridge, allowlist: async () => ['example.com'] });
    await expect(offline.invoke('open', ['https://evil.test/'], ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await offline.invoke('open', ['https://example.com/'], ctx);
    expect(runs).toHaveLength(1);
  });
});

describe('BrowserHandler: blocking, effects, home page, bookmarks, eval, history', () => {
  const ctxNamed = { ...ctx, packId: 'com.x.p', characterId: 'mira' };
  const settingsOf = (over: Partial<{ allowBlocking: boolean; allowEval: boolean; allowHistory: boolean; homePage: string }> = {}) => async () => ({
    allowBlocking: true,
    allowEval: true,
    allowHistory: true,
    homePage: '',
    ...over,
  });

  it('block: validates patterns, protects the app and browser pages, has no duration cap, names the character', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'rules.block': (a) => ({ ...a, redirectedTabs: 1 }), 'rules.list': [{ id: 'blk-1', patterns: ['a.test'] }], 'rules.unblock': { removed: true }, 'rules.clear': { removed: 2 } });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [], browserSettings: settingsOf(), characterName: () => 'Mira' });
    const before = Date.now();
    const r = (await h.invoke('block', [['*.social.test', 'news.test/feed*'], { durationMs: 5 * 60_000, reason: 'focus time' }], ctxNamed)) as Record<string, unknown>;
    expect(r).toMatchObject({ patterns: ['*.social.test', 'news.test/feed*'], redirectedTabs: 1 });
    expect(typeof r['id']).toBe('string');
    const expires = Date.parse(r['expiresAt'] as string);
    expect(expires).toBeGreaterThanOrEqual(before + 5 * 60_000 - 5);
    expect(expires).toBeLessThan(before + 5 * 60_000 + 5_000);
    expect(calls[0]).toMatchObject({ op: 'rules.block', args: { patterns: ['*.social.test', 'news.test/feed*'], by: 'Mira', reason: 'focus time' } });
    // No cap on the duration.
    const long = (await h.invoke('block', [['a.test'], { durationMs: 10 * 60 * 60_000 }], ctxNamed)) as Record<string, unknown>;
    expect(Date.parse(long['expiresAt'] as string)).toBeGreaterThanOrEqual(before + 10 * 60 * 60_000); // no cap
    const forever = (await h.invoke('block', [['b.test']], ctxNamed)) as Record<string, unknown>;
    expect(forever['expiresAt']).toBeNull(); // indefinite until unblock/clearBlocks
    // Redirect goes through the URL check and the allowlist.
    await h.invoke('block', [['a.test'], { redirect: 'https://calm.test/' }], ctxNamed);
    expect(calls.at(-1)!.args['redirect']).toBe('https://calm.test/');
    await expect(h.invoke('block', [['a.test'], { redirect: 'javascript:1' }], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('block', [['a.test'], { redirect: 'http://127.0.0.1:47821/x' }], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const bad of [[], ['   '], 'a.test', [1], Array.from({ length: 51 }, (_, i) => `h${i}.test`)]) {
      await expect(h.invoke('block', [bad as never], ctxNamed), JSON.stringify(bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    for (const p of ['127.0.0.1', 'http://127.0.0.1:47821/extension/update.xml', 'localhost', 'localhost:47821/x', 'chrome://settings', 'chrome-extension://abc/x', 'app.localhost']) {
      await expect(h.invoke('block', [[p]], ctxNamed), p).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    await expect(h.invoke('block', [['a.test'], { durationMs: -1 }], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await h.invoke('blocks', [], ctxNamed)).toEqual([{ id: 'blk-1', patterns: ['a.test'] }]);
    expect(await h.invoke('unblock', ['blk-1'], ctxNamed)).toEqual({ removed: true });
    expect(await h.invoke('clearBlocks', [], ctxNamed)).toEqual({ removed: 2 });
    expect(calls.map((c) => c.op).slice(-3)).toEqual(['rules.list', 'rules.unblock', 'rules.clear']);
  });

  it('the toggles in Settings → Browser switch block, eval and history off with a clear message', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, {});
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [], browserSettings: settingsOf({ allowBlocking: false, allowEval: false, allowHistory: false }) });
    await expect(h.invoke('block', [['a.test']], ctxNamed)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: BLOCKING_DISABLED_MESSAGE });
    await expect(h.invoke('eval', [1, 'return 1'], ctxNamed)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: EVAL_DISABLED_MESSAGE });
    await expect(h.invoke('history', [], ctxNamed)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: HISTORY_DISABLED_MESSAGE });
    await expect(h.invoke('historyVisits', ['https://a.test/'], ctxNamed)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: HISTORY_DISABLED_MESSAGE });
    await expect(h.invoke('recentHistory', [5], ctxNamed)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: HISTORY_DISABLED_MESSAGE });
    expect(calls).toEqual([]);
    // Unblocking and listing still work while blocking is off (so the user can clean up).
    await h.invoke('blocks', [], ctxNamed);
    await h.invoke('clearBlocks', [], ctxNamed);
    expect(calls.map((c) => c.op)).toEqual(['rules.list', 'rules.clear']);
  });

  it('imageEffect resolves pack assets to the loopback URL, allowlists http replacements, validates the effect', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'page.imageEffect': { applied: true, replaced: 3, total: 3, effect: 'grayscale' }, 'page.clearImageEffects': { cleared: true, restored: 3 } });
    const packs = { getLoaded: (packId: string) => ({ root: `/packs/${packId}` }) as never };
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => ['example.com'], browserSettings: settingsOf(), packs, assetUrl: (packId, asset) => `http://127.0.0.1:4/t/tok/asset/${packId}/${asset}` });
    expect(await h.invoke('imageEffect', [1, 'grayscale', { replaceWith: 'media/cat.png', durationMs: 5000, selector: '.hero img' }], ctxNamed)).toMatchObject({ replaced: 3 });
    expect(calls[0]).toEqual({ op: 'page.imageEffect', args: { tabId: 1, effect: 'grayscale', selector: '.hero img', replaceWith: 'http://127.0.0.1:4/t/tok/asset/com.x.p/media/cat.png', durationMs: 5000 } });
    await h.invoke('imageEffect', [1, { css: 'blur(3px)' }, { replaceWith: { path: 'media/dog.png', kind: 'image' } }], ctxNamed);
    expect(calls[1]!.args).toEqual({ tabId: 1, effect: { css: 'blur(3px)' }, replaceWith: 'http://127.0.0.1:4/t/tok/asset/com.x.p/media/dog.png' });
    await h.invoke('imageEffect', [1, 'none', { replaceWith: 'https://example.com/a.png' }], ctxNamed);
    expect(calls[2]!.args['replaceWith']).toBe('https://example.com/a.png');
    await expect(h.invoke('imageEffect', [1, 'blur', { replaceWith: 'https://evil.test/a.png' }], ctxNamed)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(h.invoke('imageEffect', [1, 'blur', { replaceWith: '../../etc/passwd' }], ctxNamed)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(h.invoke('imageEffect', [1, 42], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('imageEffect', ['x', 'blur'], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await h.invoke('clearImageEffects', [1], ctxNamed)).toEqual({ cleared: true, restored: 3 });
  });

  it('setHomePage persists the setting, pushes it to the extension and allowlists it; homePage reads the setting', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'home.set': (a) => ({ url: a['url'] }) });
    let stored = '';
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => ['home.test'], browserSettings: async () => ({ ...(await settingsOf()()), homePage: stored }), setHomePage: async (url) => void (stored = url) });
    expect(await h.invoke('setHomePage', ['https://home.test/start'], ctxNamed)).toEqual({ url: 'https://home.test/start', pushedToExtension: true });
    expect(stored).toBe('https://home.test/start');
    expect(calls).toEqual([{ op: 'home.set', args: { url: 'https://home.test/start' } }]);
    expect(await h.invoke('homePage', [], ctxNamed)).toEqual({ url: 'https://home.test/start' });
    await expect(h.invoke('setHomePage', ['https://evil.test/'], ctxNamed)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(h.invoke('setHomePage', ['chrome://newtab'], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await h.invoke('setHomePage', [null], ctxNamed)).toEqual({ url: null, pushedToExtension: true });
    expect(stored).toBe('');
    expect(calls.at(-1)).toEqual({ op: 'home.set', args: { url: null } });
    // Without the extension the setting is still saved (pushed on the next connection).
    const offline = new BrowserHandler({ commands, bridge: fakeBridge(false).bridge, allowlist: async () => [], browserSettings: settingsOf(), setHomePage: async (url) => void (stored = url) });
    expect(await offline.invoke('setHomePage', ['https://home.test/'], ctxNamed)).toEqual({ url: 'https://home.test/', pushedToExtension: false });
  });

  it('bookmarks: list/search/add/remove with the allowlist on add and id-or-url on remove', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'bookmarks.list': [], 'bookmarks.search': [], 'bookmarks.add': (a) => ({ id: '9', title: a['title'], url: a['url'], parentId: '2', path: 'Other bookmarks' }), 'bookmarks.remove': { removed: 1 } });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => ['example.com'], browserSettings: settingsOf() });
    await h.invoke('bookmarks', [], ctxNamed);
    await h.invoke('bookmarks', [{ folder: 'Work/Docs' }], ctxNamed);
    await h.invoke('searchBookmarks', ['soup'], ctxNamed);
    expect(await h.invoke('addBookmark', ['https://example.com/a', 'A', { folder: 'Work' }], ctxNamed)).toMatchObject({ id: '9', url: 'https://example.com/a' });
    await expect(h.invoke('addBookmark', ['https://evil.test/', 'E'], ctxNamed)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(h.invoke('searchBookmarks', [''], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await h.invoke('removeBookmark', ['9'], ctxNamed);
    await h.invoke('removeBookmark', ['https://example.com/a'], ctxNamed);
    expect(calls.map((c) => [c.op, c.args])).toEqual([
      ['bookmarks.list', {}],
      ['bookmarks.list', { folder: 'Work/Docs' }],
      ['bookmarks.search', { query: 'soup' }],
      ['bookmarks.add', { url: 'https://example.com/a', title: 'A', folder: 'Work' }],
      ['bookmarks.remove', { id: '9' }],
      ['bookmarks.remove', { url: 'https://example.com/a' }],
    ]);
  });

  it('eval: defaults to the isolated world, caps the timeout and stretches the bridge wait to fit', async () => {
    const { commands } = fakeCommands();
    const opts: Array<{ timeoutMs?: number } | undefined> = [];
    const calls: Array<{ op: string; args: Record<string, Json> }> = [];
    const bridge: BrowserBridgeLike = {
      connected: true,
      request: async (op, args = {}, o) => {
        calls.push({ op, args });
        opts.push(o);
        return { value: 'T', world: args['world'] };
      },
      status: async () => ({ connected: true }),
    };
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [], browserSettings: settingsOf() });
    expect(await h.invoke('eval', [1, 'return document.title'], ctxNamed)).toEqual({ value: 'T', world: 'isolated' });
    expect(calls[0]).toEqual({ op: 'page.eval', args: { tabId: 1, code: 'return document.title', world: 'isolated', timeoutMs: 10_000 } });
    expect(opts[0]).toEqual({ timeoutMs: 15_000 });
    await h.invoke('eval', [1, 'return location.href', { world: 'main', timeoutMs: 120_000 }], ctxNamed);
    expect(calls[1]!.args).toMatchObject({ world: 'main', timeoutMs: 60_000 });
    expect(opts[1]).toEqual({ timeoutMs: 65_000 });
    await expect(h.invoke('eval', [1, ''], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('eval', [1, 'return 1', { world: 'worker' }], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('history: since/until as ISO or ms-ago, limit capped, visits need an http URL', async () => {
    const { commands } = fakeCommands();
    const { bridge, calls } = fakeBridge(true, { 'history.search': [], 'history.visits': [], 'history.recent': [] });
    const h = new BrowserHandler({ commands, bridge, allowlist: async () => [], browserSettings: settingsOf() });
    const now = Date.now();
    await h.invoke('history', [], ctxNamed);
    await h.invoke('history', [{ text: 'weather', since: 3_600_000, limit: 9999 }], ctxNamed);
    await h.invoke('history', [{ since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', limit: 5 }], ctxNamed);
    await h.invoke('historyVisits', ['https://a.test/'], ctxNamed);
    await h.invoke('recentHistory', [3], ctxNamed);
    await h.invoke('recentHistory', [], ctxNamed);
    expect(calls[0]).toEqual({ op: 'history.search', args: {} });
    expect(calls[1]!.args).toMatchObject({ text: 'weather', maxResults: 500 });
    expect(calls[1]!.args['startTime'] as number).toBeGreaterThanOrEqual(now - 3_600_000 - 50);
    expect(calls[2]!.args).toEqual({ startTime: Date.parse('2026-01-01T00:00:00Z'), endTime: Date.parse('2026-01-02T00:00:00Z'), maxResults: 5 });
    expect(calls[3]).toEqual({ op: 'history.visits', args: { url: 'https://a.test/' } });
    expect(calls[4]).toEqual({ op: 'history.recent', args: { maxResults: 3 } });
    expect(calls[5]).toEqual({ op: 'history.recent', args: {} });
    await expect(h.invoke('history', [{ since: 'yesterday' }], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.invoke('historyVisits', ['chrome://history'], ctxNamed)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
