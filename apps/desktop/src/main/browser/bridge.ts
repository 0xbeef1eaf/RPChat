/**
 * The app side of the browser-extension bridge (docs/browser-extension.md): accepts WebSocket
 * connections on the loopback server's `/bridge` path from `chrome-extension://<id>` origins,
 * asks the user once per extension id, keeps one live connection per id (newest wins), and turns
 * `request(op, args)` into `{ id, op, args }` frames answered by `{ id, ok, value | error }`.
 * Events the extension pushes (`{ event, data }`) reach `onEvent` listeners. The connection
 * handling works over `BridgeSocket`, a minimal interface both `ws` and a test fake satisfy.
 */
import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { BrowserBridgeEvent, BrowserBridgeStatus, Json } from '@rp/shared';
import { EXTENSION_ID_RE, RpError } from '@rp/shared';

export const BRIDGE_PATH = '/bridge';
export const REQUEST_TIMEOUT_MS = 15_000;
export const HELLO_TIMEOUT_MS = 5_000;
export const NOT_CONNECTED_MESSAGE = 'The browser extension is not connected (Settings → Browser: install the extension policy or load it unpacked)';

/** Close codes the bridge uses (4000–4999 are application-defined). */
export const CLOSE_CODES = {
  badOrigin: 4000,
  noHello: 4001,
  badHello: 4002,
  refused: 4003,
  replaced: 4004,
  untrusted: 4005,
  shutdown: 4006,
} as const;

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: string) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface BrowserBridgeDeps {
  /** Currently trusted extension ids (settings). */
  trusted(): Promise<string[]>;
  /** Persist a newly allowed id. */
  remember(id: string): Promise<void>;
  /** Ask the user; resolves false when they decline or the question could not be shown. */
  confirm(id: string, browser: string): Promise<boolean>;
  /** Loopback port facts for `status()`. */
  ports(): { port: number; requested: number };
  extension: {
    id(): Promise<string | undefined>;
    version(): Promise<string | undefined>;
    dir(): string | undefined;
    updateUrl(): string;
  };
  logger: Pick<Console, 'info' | 'warn' | 'debug'>;
  /** `settings.browser.homePage`, reported in `status()`. */
  homePage?: () => Promise<string>;
  /** Smoke/dev: trust every extension that says hello without asking. */
  autoTrust?: boolean;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
}

interface Connection {
  id: string;
  socket: BridgeSocket;
  state: 'hello' | 'authorising' | 'active' | 'closed';
  browser: string;
  version: string;
  helloTimer: NodeJS.Timeout | undefined;
}

interface Pending {
  op: string;
  connection: Connection;
  resolve(value: Json): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** `chrome-extension://<id>` → id, or undefined for any other origin (including none). */
export function extensionIdFromOrigin(origin: string | undefined): string | undefined {
  if (typeof origin !== 'string') return undefined;
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin.trim());
  return m ? m[1] : undefined;
}

/** Map the extension's error codes onto `RpError` codes so callers see familiar failures. */
export function rpChatFor(code: string): 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'CAPABILITY_FAILED' {
  switch (code) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'INVALID_ARGUMENT':
    case 'INVALID_URL':
      return 'INVALID_ARGUMENT';
    default:
      return 'CAPABILITY_FAILED';
  }
}

export class BrowserBridge {
  private readonly live = new Map<string, Connection>();
  private current: Connection | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: BrowserBridgeEvent) => void>();
  private readonly statusListeners = new Set<(status: BrowserBridgeStatus) => void>();
  private readonly denied = new Set<string>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private wss: WebSocketServer | undefined;
  private closed = false;

  constructor(private readonly deps: BrowserBridgeDeps) {}

  // ---- transport ---------------------------------------------------------------------------

  /** Take over `/bridge` upgrades on the loopback server (`LoopbackServer.onUpgrade`). */
  upgradeHandler(): (req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) => boolean {
    return (req, socket, head, url) => {
      if (url.pathname !== BRIDGE_PATH) return false;
      const origin = firstHeader(req.headers.origin);
      const id = extensionIdFromOrigin(origin);
      if (!id) {
        this.deps.logger.warn(`[browser] refused a /bridge upgrade from origin ${origin ?? '(none)'}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return true;
      }
      if (!this.wss) this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(adaptWs(ws), origin));
      return true;
    };
  }

  /**
   * Adopt a socket whose upgrade already happened. Returns false (and closes it) when the origin is
   * not an extension. Public so tests can drive the bridge with a fake socket.
   */
  handleConnection(socket: BridgeSocket, origin: string | undefined): boolean {
    const id = extensionIdFromOrigin(origin);
    if (!id || this.closed) {
      socket.close(CLOSE_CODES.badOrigin, 'origin must be chrome-extension://<id>');
      return false;
    }
    const conn: Connection = { id, socket, state: 'hello', browser: '', version: '', helloTimer: undefined };
    conn.helloTimer = setTimeout(() => {
      if (conn.state === 'hello') this.drop(conn, CLOSE_CODES.noHello, 'no hello');
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    conn.helloTimer.unref?.();
    socket.on('message', (data) => this.onMessage(conn, data));
    socket.on('error', (err) => this.deps.logger.debug(`[browser] socket error (${id}): ${err.message}`));
    socket.on('close', () => this.onClose(conn));
    return true;
  }

  private onMessage(conn: Connection, data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return;
    const frame = json as Record<string, unknown>;
    if (conn.state === 'hello') {
      const hello = frame['hello'];
      if (!hello || typeof hello !== 'object') {
        this.drop(conn, CLOSE_CODES.badHello, 'expected hello');
        return;
      }
      const h = hello as Record<string, unknown>;
      if (h['extensionId'] !== conn.id) {
        this.drop(conn, CLOSE_CODES.badHello, 'hello.extensionId does not match the origin');
        return;
      }
      conn.browser = typeof h['browser'] === 'string' ? h['browser'].slice(0, 200) : 'unknown browser';
      conn.version = typeof h['version'] === 'string' ? h['version'].slice(0, 40) : '';
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      conn.state = 'authorising';
      void this.authorise(conn);
      return;
    }
    if (conn.state !== 'active') return;
    if (typeof frame['id'] === 'string' && typeof frame['ok'] === 'boolean') {
      this.settle(frame as { id: string; ok: boolean; value?: unknown; error?: { code?: unknown; message?: unknown } });
      return;
    }
    if (typeof frame['event'] === 'string' && frame['data'] && typeof frame['data'] === 'object') {
      const event = frame['event'];
      if (event !== 'tab-updated' && event !== 'tab-activated' && event !== 'tab-removed') return;
      const ev: BrowserBridgeEvent = { event, data: frame['data'] as BrowserBridgeEvent['data'] };
      for (const l of [...this.eventListeners]) {
        try {
          l(ev);
        } catch (err) {
          this.deps.logger.warn('[browser] event listener failed', err);
        }
      }
    }
  }

  private async authorise(conn: Connection): Promise<void> {
    try {
      const trusted = await this.deps.trusted();
      let allowed = trusted.includes(conn.id);
      if (!allowed && this.deps.autoTrust) {
        await this.deps.remember(conn.id);
        this.deps.logger.info(`[browser] auto-trusted extension ${conn.id} (${conn.browser})`);
        allowed = true;
      }
      if (!allowed && this.denied.has(conn.id)) {
        this.drop(conn, CLOSE_CODES.refused, 'refused by the user');
        return;
      }
      if (!allowed) {
        let ask = this.asking.get(conn.id);
        if (!ask) {
          this.deps.logger.info(`[browser] extension ${conn.id} (${conn.browser}) asks to connect`);
          ask = this.deps.confirm(conn.id, conn.browser).catch(() => false);
          this.asking.set(conn.id, ask);
          ask.finally(() => this.asking.delete(conn.id)).catch(() => undefined);
        }
        allowed = await ask;
        if (allowed && !(await this.deps.trusted()).includes(conn.id)) await this.deps.remember(conn.id);
      }
      if (conn.state !== 'authorising') return; // closed while we asked
      if (!allowed) {
        this.denied.add(conn.id);
        this.deps.logger.info(`[browser] extension ${conn.id} refused`);
        this.drop(conn, CLOSE_CODES.refused, 'refused by the user');
        this.emitStatus();
        return;
      }
      this.activate(conn);
    } catch (err) {
      this.deps.logger.warn('[browser] authorisation failed', err);
      this.drop(conn, CLOSE_CODES.refused, 'authorisation failed');
    }
  }

  private activate(conn: Connection): void {
    const previous = this.live.get(conn.id);
    if (previous && previous !== conn) this.drop(previous, CLOSE_CODES.replaced, 'replaced by a newer connection');
    conn.state = 'active';
    this.live.set(conn.id, conn);
    this.current = conn;
    this.denied.delete(conn.id);
    this.deps.logger.info(`[browser] extension ${conn.id} connected (${conn.browser}, extension ${conn.version || '?'})`);
    this.emitStatus();
  }

  private drop(conn: Connection, code: number, reason: string): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    try {
      conn.socket.close(code, reason);
    } catch {
      /* already gone */
    }
    this.onClose(conn);
  }

  private onClose(conn: Connection): void {
    const wasActive = this.live.get(conn.id) === conn;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.state = 'closed';
    if (wasActive) {
      this.live.delete(conn.id);
      if (this.current === conn) this.current = [...this.live.values()].pop();
      this.deps.logger.info(`[browser] extension ${conn.id} disconnected`);
    }
    for (const [id, p] of [...this.pending]) {
      if (p.connection === conn) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new RpError('CAPABILITY_FAILED', `The browser extension disconnected while handling ${p.op}`));
      }
    }
    if (wasActive) this.emitStatus();
  }

  private settle(frame: { id: string; ok: boolean; value?: unknown; error?: { code?: unknown; message?: unknown } }): void {
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) {
      p.resolve((frame.value === undefined ? null : frame.value) as Json);
      return;
    }
    const code = typeof frame.error?.code === 'string' ? frame.error.code : 'FAILED';
    const message = typeof frame.error?.message === 'string' ? frame.error.message : 'the browser extension reported an error';
    p.reject(new RpError(rpChatFor(code), `${p.op}: ${message}`, { extensionCode: code }));
  }

  // ---- API ---------------------------------------------------------------------------------

  get connected(): boolean {
    return this.current !== undefined && this.current.state === 'active';
  }

  /**
   * Send one op to the connected extension; `CAPABILITY_FAILED` when none is connected or it does
   * not answer in time (15 s, or `opts.timeoutMs` for ops that legitimately take longer, e.g. eval).
   */
  request(op: string, args: Record<string, Json> = {}, opts: { timeoutMs?: number } = {}): Promise<Json> {
    const conn = this.current;
    if (!conn || conn.state !== 'active') return Promise.reject(new RpError('CAPABILITY_FAILED', NOT_CONNECTED_MESSAGE));
    const id = randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpError('CAPABILITY_FAILED', `The browser extension did not answer ${op} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { op, connection: conn, resolve, reject, timer });
      try {
        conn.socket.send(JSON.stringify({ id, op, args }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RpError('CAPABILITY_FAILED', `Could not send ${op} to the browser extension: ${(err as Error).message}`));
      }
    });
  }

  /**
   * Resolve as soon as an extension is connected, or false when none is within `timeoutMs` — how
   * the `sdk.browser` handler waits out a browser it has just started.
   */
  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      const off = this.onStatus((s) => {
        if (s.connected) done(true);
      });
    });
  }

  onEvent(listener: (event: BrowserBridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStatus(listener: (status: BrowserBridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  async status(): Promise<BrowserBridgeStatus> {
    const { port, requested } = this.deps.ports();
    const [trusted, installedExtensionId, extensionVersion] = await Promise.all([
      this.deps.trusted(),
      this.deps.extension.id().catch(() => undefined),
      this.deps.extension.version().catch(() => undefined),
    ]);
    const conn = this.current;
    const status: BrowserBridgeStatus = {
      connected: Boolean(conn && conn.state === 'active'),
      port,
      requestedPort: requested,
      trusted: [...trusted],
      updateUrl: this.deps.extension.updateUrl(),
      denied: [...this.denied],
      homePage: (await this.deps.homePage?.().catch(() => '')) ?? '',
    };
    if (conn && conn.state === 'active') {
      status.extensionId = conn.id;
      status.browser = conn.browser;
    }
    if (installedExtensionId) status.installedExtensionId = installedExtensionId;
    if (extensionVersion) status.extensionVersion = extensionVersion;
    const dir = this.deps.extension.dir();
    if (dir) status.extensionDir = dir;
    return status;
  }

  /** Allow an id (also clears a refusal so the extension's next retry connects). */
  async trust(id: string): Promise<void> {
    if (!EXTENSION_ID_RE.test(id)) throw new RpError('INVALID_ARGUMENT', 'an extension id is 32 letters a–p');
    this.denied.delete(id);
    if (!(await this.deps.trusted()).includes(id)) await this.deps.remember(id);
    this.emitStatus();
  }

  /** Forget an id and close its live connection (the caller removes it from settings). */
  untrust(id: string): void {
    const conn = this.live.get(id);
    if (conn) this.drop(conn, CLOSE_CODES.untrusted, 'no longer trusted');
    this.emitStatus();
  }

  /** Close every connection (shutdown / port change); the extension reconnects on its own. */
  close(): void {
    for (const conn of [...this.live.values()]) this.drop(conn, CLOSE_CODES.shutdown, 'app closing');
    this.wss?.close();
    this.wss = undefined;
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    void this.status().then((s) => {
      for (const l of [...this.statusListeners]) {
        try {
          l(s);
        } catch (err) {
          this.deps.logger.warn('[browser] status listener failed', err);
        }
      }
    });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `ws` socket → `BridgeSocket`. */
function adaptWs(ws: WebSocket): BridgeSocket {
  const on = (event: string, listener: (...args: never[]) => void): void => {
    if (event === 'message') ws.on('message', (data, isBinary) => (listener as unknown as (d: string) => void)(isBinary ? '' : data.toString()));
    else if (event === 'close') ws.on('close', () => (listener as unknown as () => void)());
    else ws.on('error', (err) => (listener as unknown as (e: Error) => void)(err));
  };
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: on as BridgeSocket['on'],
  };
}
