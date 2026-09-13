import { describe, expect, it } from 'vitest';
import type { Json } from '@rp/shared';
import { BrowserHandler, NOT_CONNECTED_MESSAGE } from './browser.js';
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
