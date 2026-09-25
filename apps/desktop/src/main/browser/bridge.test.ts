import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { BrowserBridgeEvent, BrowserBridgeStatus } from '@rp/shared';
import { BrowserBridge, CLOSE_CODES, NOT_CONNECTED_MESSAGE, extensionIdFromOrigin, rpChatFor } from './bridge.js';
import type { BridgeSocket, BrowserBridgeDeps } from './bridge.js';
import { ExtensionService, START_PAGE_HTML } from './extension.js';
import { BROWSER_POLICY_DIRS, LEGACY_BROWSER_POLICY_FILENAME, browserPolicy, browserPolicyFilename, browserPolicyText, startUrlFor, updateXml } from './policy.js';

const ID_A = 'abcdefghijklmnopabcdefghijklmnop';
const ID_B = 'ppppppppppppppppaaaaaaaaaaaaaaaa';
const logger = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** A fake extension socket: what the bridge sends is collected; `receive` injects frames. */
class FakeSocket implements BridgeSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | undefined;
  private listeners: Record<string, Array<(arg?: unknown) => void>> = { message: [], close: [], error: [] };
  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const l of this.listeners.close!) l();
  }
  on(event: 'message' | 'close' | 'error', listener: (arg?: never) => void): void {
    this.listeners[event]!.push(listener as (arg?: unknown) => void);
  }
  receive(frame: unknown): void {
    for (const l of this.listeners.message!) l(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
  /** The last request frame the bridge sent, so a test can answer it. */
  lastRequest(): { id: string; op: string; args: Record<string, unknown> } {
    const frame = [...this.sent].reverse().find((f) => typeof f['op'] === 'string');
    if (!frame) throw new Error('no request sent');
    return frame as { id: string; op: string; args: Record<string, unknown> };
  }
}

function setup(overrides: Partial<BrowserBridgeDeps> = {}) {
  const trusted: string[] = [];
  const asked: string[] = [];
  let answer = true;
  const statuses: BrowserBridgeStatus[] = [];
  const deps: BrowserBridgeDeps = {
    trusted: async () => [...trusted],
    remember: async (id) => {
      trusted.push(id);
    },
    confirm: async (id) => {
      asked.push(id);
      return answer;
    },
    ports: () => ({ port: 47821, requested: 47821 }),
    extension: { id: async () => ID_B, version: async () => '0.1.0', dir: () => '/res/extension', updateUrl: () => 'http://127.0.0.1:47821/extension/update.xml' },
    logger,
    requestTimeoutMs: 60,
    helloTimeoutMs: 40,
    ...overrides,
  };
  const bridge = new BrowserBridge(deps);
  bridge.onStatus((s) => statuses.push(s));
  const connect = async (id = ID_A, hello: Record<string, unknown> = { version: '0.1.0', browser: 'Chromium 141', extensionId: id }): Promise<FakeSocket> => {
    const socket = new FakeSocket();
    expect(bridge.handleConnection(socket, `chrome-extension://${id}`)).toBe(true);
    socket.receive({ hello });
    await tick();
    return socket;
  };
  return { bridge, deps, trusted, asked, statuses, connect, setAnswer: (v: boolean) => (answer = v) };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('extensionIdFromOrigin / rpChatFor', () => {
  it('accepts only chrome-extension origins with a valid id', () => {
    expect(extensionIdFromOrigin(`chrome-extension://${ID_A}`)).toBe(ID_A);
    expect(extensionIdFromOrigin(`chrome-extension://${ID_A}/`)).toBe(ID_A);
    expect(extensionIdFromOrigin('http://127.0.0.1:47821')).toBeUndefined();
    expect(extensionIdFromOrigin('chrome-extension://short')).toBeUndefined();
    expect(extensionIdFromOrigin('chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP')).toBeUndefined();
    expect(extensionIdFromOrigin(undefined)).toBeUndefined();
    expect(extensionIdFromOrigin(`moz-extension://${ID_A}`)).toBeUndefined();
  });
  it('maps extension error codes', () => {
    expect(rpChatFor('NOT_FOUND')).toBe('NOT_FOUND');
    expect(rpChatFor('INVALID_URL')).toBe('INVALID_ARGUMENT');
    expect(rpChatFor('INJECT_FAILED')).toBe('CAPABILITY_FAILED');
  });
});

describe('BrowserBridge', () => {
  it('rejects sockets from non-extension origins', () => {
    const { bridge } = setup();
    const socket = new FakeSocket();
    expect(bridge.handleConnection(socket, 'http://evil.test')).toBe(false);
    expect(socket.closed?.code).toBe(CLOSE_CODES.badOrigin);
    expect(bridge.connected).toBe(false);
  });

  it('drops a connection that never says hello, or lies about its id', async () => {
    const { bridge } = setup();
    const silent = new FakeSocket();
    bridge.handleConnection(silent, `chrome-extension://${ID_A}`);
    await tick(60);
    expect(silent.closed?.code).toBe(CLOSE_CODES.noHello);
    const liar = new FakeSocket();
    bridge.handleConnection(liar, `chrome-extension://${ID_A}`);
    liar.receive({ hello: { version: '1', browser: 'x', extensionId: ID_B } });
    expect(liar.closed?.code).toBe(CLOSE_CODES.badHello);
    const garbage = new FakeSocket();
    bridge.handleConnection(garbage, `chrome-extension://${ID_A}`);
    garbage.receive('not json');
    garbage.receive({ event: 'tab-updated', data: {} });
    expect(garbage.closed?.code).toBe(CLOSE_CODES.badHello);
  });

  it('asks the user once for an unknown id, remembers it, and refuses when declined', async () => {
    const { bridge, asked, trusted, connect, setAnswer, statuses } = setup();
    const socket = await connect();
    expect(asked).toEqual([ID_A]);
    expect(trusted).toEqual([ID_A]);
    expect(bridge.connected).toBe(true);
    expect(socket.closed).toBeUndefined();
    const status = await bridge.status();
    expect(status).toMatchObject({ connected: true, extensionId: ID_A, browser: 'Chromium 141', port: 47821, trusted: [ID_A], installedExtensionId: ID_B, extensionVersion: '0.1.0', extensionDir: '/res/extension', denied: [] });
    expect(status.updateUrl).toBe('http://127.0.0.1:47821/extension/update.xml');
    expect(statuses.length).toBeGreaterThan(0);
    // A second connection of a trusted id is not asked again.
    const again = await connect();
    expect(asked).toEqual([ID_A]);
    expect(socket.closed?.code).toBe(CLOSE_CODES.replaced); // newest wins
    expect(again.closed).toBeUndefined();
    // Another id, declined: refused now and on every retry until trusted from Settings.
    setAnswer(false);
    const other = await connect(ID_B);
    expect(other.closed?.code).toBe(CLOSE_CODES.refused);
    expect(asked).toEqual([ID_A, ID_B]);
    const retry = await connect(ID_B);
    expect(retry.closed?.code).toBe(CLOSE_CODES.refused);
    expect(asked).toEqual([ID_A, ID_B]);
    expect((await bridge.status()).denied).toEqual([ID_B]);
    await bridge.trust(ID_B);
    expect(trusted).toContain(ID_B);
    const allowed = await connect(ID_B);
    expect(allowed.closed).toBeUndefined();
    expect((await bridge.status()).extensionId).toBe(ID_B);
    await expect(bridge.trust('nope')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('auto-trusts in smoke mode without asking', async () => {
    const { bridge, asked, trusted, connect } = setup({ autoTrust: true });
    await connect();
    expect(asked).toEqual([]);
    expect(trusted).toEqual([ID_A]);
    expect(bridge.connected).toBe(true);
  });

  it('request/response, error mapping, timeout and disconnect', async () => {
    const { bridge, connect } = setup();
    await expect(bridge.request('tabs.list')).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: NOT_CONNECTED_MESSAGE });
    const socket = await connect();
    const p = bridge.request('tabs.open', { url: 'https://a.test' });
    const req = socket.lastRequest();
    expect(req.op).toBe('tabs.open');
    expect(req.args).toEqual({ url: 'https://a.test' });
    socket.receive({ id: req.id, ok: true, value: { id: 7 } });
    expect(await p).toEqual({ id: 7 });
    // Frames for unknown ids are ignored; an error frame maps its code.
    socket.receive({ id: 'nope', ok: true, value: 1 });
    const failing = bridge.request('page.click', { tabId: 7, selector: 'a' });
    socket.receive({ id: socket.lastRequest().id, ok: false, error: { code: 'NOT_FOUND', message: 'no match' } });
    await expect(failing).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'page.click: no match', details: { extensionCode: 'NOT_FOUND' } });
    const bad = bridge.request('tabs.navigate', { tabId: 7, url: 'x' });
    socket.receive({ id: socket.lastRequest().id, ok: false, error: { code: 'INVALID_URL', message: 'nope' } });
    await expect(bad).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // No answer within the timeout.
    const slow = bridge.request('page.read', { tabId: 7 });
    await expect(slow).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringContaining('did not answer page.read') });
    // Disconnect rejects what is still pending and the bridge reports disconnected.
    const pending = bridge.request('tabs.list');
    socket.close();
    await expect(pending).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringContaining('disconnected') });
    expect(bridge.connected).toBe(false);
    expect((await bridge.status()).connected).toBe(false);
    await expect(bridge.request('tabs.list')).rejects.toBeInstanceOf(RpError);
  });

  it('forwards tab events only from an active connection and ignores unknown ones', async () => {
    const { bridge, connect } = setup();
    const events: BrowserBridgeEvent[] = [];
    const off = bridge.onEvent((e) => events.push(e));
    const socket = await connect();
    socket.receive({ event: 'tab-updated', data: { tabId: 3, url: 'https://a.test/', title: 'A', status: 'complete' } });
    socket.receive({ event: 'tab-removed', data: { tabId: 3 } });
    socket.receive({ event: 'bogus', data: { tabId: 3 } });
    socket.receive({ event: 'tab-activated', data: 'not an object' });
    expect(events).toEqual([
      { event: 'tab-updated', data: { tabId: 3, url: 'https://a.test/', title: 'A', status: 'complete' } },
      { event: 'tab-removed', data: { tabId: 3 } },
    ]);
    off();
    socket.receive({ event: 'tab-activated', data: { tabId: 3 } });
    expect(events).toHaveLength(2);
  });

  it('waitForConnection resolves on the next connection, true right away when one is live, false on timeout', async () => {
    const { bridge, connect } = setup();
    expect(await bridge.waitForConnection(20)).toBe(false);
    const waiting = bridge.waitForConnection(1000);
    await connect();
    expect(await waiting).toBe(true);
    expect(await bridge.waitForConnection(1000)).toBe(true);
  });

  it('untrust closes the live connection and close() drops everything', async () => {
    const { bridge, connect } = setup();
    const a = await connect();
    bridge.untrust(ID_A);
    expect(a.closed?.code).toBe(CLOSE_CODES.untrusted);
    expect(bridge.connected).toBe(false);
    const b = await connect();
    bridge.close();
    expect(b.closed?.code).toBe(CLOSE_CODES.shutdown);
    expect(bridge.connected).toBe(false);
  });
});

describe('policy', () => {
  it('builds the Chromium policy JSON and update manifest', () => {
    const policy = browserPolicy(ID_A, 47821);
    expect(policy).toEqual({
      ExtensionInstallForcelist: [`${ID_A};http://127.0.0.1:47821/extension/update.xml`],
      ExtensionInstallSources: ['http://127.0.0.1:47821/*'],
      '3rdparty': { extensions: { [ID_A]: { policy: { port: 47821 } } } },
    });
    expect(JSON.parse(browserPolicyText(ID_A, 5000, 'http://127.0.0.1:5000/extension/update.xml'))).toEqual(browserPolicy(ID_A, 5000));
    // The home page is a character's to set (sdk.browser.setHomePage), so the policy never carries one.
    expect(browserPolicy(ID_A, 5000)).not.toHaveProperty('HomepageLocation');
    expect(browserPolicy(ID_A, 5000)).not.toHaveProperty('HomepageIsNewTabPage');
    const xml = updateXml(ID_A, '0.1.0', 'http://127.0.0.1:47821/extension/rpchat.crx');
    expect(xml).toContain(`<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`);
    expect(xml).toContain(`<app appid='${ID_A}'>`);
    expect(xml).toContain(`<updatecheck codebase='http://127.0.0.1:47821/extension/rpchat.crx' version='0.1.0' />`);
    expect(updateXml(ID_A, "1'<", 'http://x/a&b')).toContain(`version='1&apos;&lt;'`);
    expect(BROWSER_POLICY_DIRS.map((d) => d.dir)).toEqual([
      '/etc/chromium/policies/managed',
      '/etc/opt/chrome/policies/managed',
      '/etc/brave/policies/managed',
      '/etc/opt/edge/policies/managed',
      '/etc/vivaldi/policies/managed',
      '/etc/opera/policies/managed',
    ]);
  });

  it('names the policy file after the user it is for, and falls back to the uid', () => {
    expect(browserPolicyFilename('alice', 1000)).toBe('rpchat-alice.json');
    expect(browserPolicyFilename('rpchat.test-user_1', 1000)).toBe('rpchat-rpchat.test-user_1.json');
    // Names a policy directory should not carry (winbind/sssd, spaces, path separators) use the uid.
    expect(browserPolicyFilename('CORP\\alice', 1000)).toBe('rpchat-uid-1000.json');
    expect(browserPolicyFilename('a/b', 1001)).toBe('rpchat-uid-1001.json');
    expect(browserPolicyFilename('', 1002)).toBe('rpchat-uid-1002.json');
    // The machine-wide file older versions wrote; the installer deletes it wherever it finds one.
    expect(LEGACY_BROWSER_POLICY_FILENAME).toBe('rpchat.json');
  });
});

describe('the start page', () => {
  it('is served under /extension/start, the URL a launched browser opens', async () => {
    expect(startUrlFor(47821)).toBe('http://127.0.0.1:47821/extension/start');
    const service = new ExtensionService({ resourcesDirs: [], keyFile: '/nonexistent/key.pem', port: () => 47821, logger });
    const head: Array<[number, Record<string, string>]> = [];
    let body: string | undefined;
    const res = {
      writeHead: (status: number, headers: Record<string, string>) => head.push([status, headers]),
      end: (data?: string) => (body = data),
    } as unknown as http.ServerResponse;
    await service.handle({ method: 'GET' } as http.IncomingMessage, res, new URL(startUrlFor(47821)));
    expect(head[0]![0]).toBe(200);
    expect(head[0]![1]['Content-Type']).toBe('text/html; charset=utf-8');
    expect(body).toBe(START_PAGE_HTML);
    expect(body).toContain('rpchat opened your browser');
  });
});
