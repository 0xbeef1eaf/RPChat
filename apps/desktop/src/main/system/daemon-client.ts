/**
 * Client for the `rp-coded` root daemon (docs/spec/system.md): JSON lines over a unix
 * socket, connect on demand, `hello` handshake, one request in flight at a time with a
 * 10 s timeout, reconnect on the next request after the socket drops.
 */
import * as net from 'node:net';
import type { DaemonRequest, DaemonResponse, DaemonStatus } from '@rp/shared';
import { DAEMON_SOCKET_PATH, RpError } from '@rp/shared';

export type HelloResponse = Extract<DaemonResponse, { op: 'hello' }>;
export type StatusResponse = Extract<DaemonResponse, { op: 'status' }>;
export type DaemonErrorResponse = Extract<DaemonResponse, { ok: false }>;

/** Thrown for `{ ok: false }` answers; `code` is the daemon's code. */
export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorResponse['code'],
    message: string,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export interface DaemonClientOptions {
  socketPath?: string;
  /** Per-request timeout. Default 10 000. */
  timeoutMs?: number;
  /** How long a failed connection attempt is remembered before `isAvailable` retries. Default 5000. */
  retryDelayMs?: number;
  logger?: Pick<Console, 'debug' | 'warn'>;
  /** Injectable for tests (defaults to `net.connect`). */
  connect?: (socketPath: string) => net.Socket;
}

interface Pending {
  resolve(res: DaemonResponse): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class DaemonClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly logger: DaemonClientOptions['logger'];
  private readonly connectImpl: (socketPath: string) => net.Socket;
  private socket: net.Socket | undefined;
  private hello: HelloResponse | undefined;
  private buffer = '';
  private readonly pending: Pending[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private lastFailureAt = 0;
  private lastError: string | undefined;

  constructor(opts: DaemonClientOptions = {}) {
    this.socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retryDelayMs = opts.retryDelayMs ?? 5000;
    this.logger = opts.logger;
    this.connectImpl = opts.connect ?? ((p) => net.connect(p));
  }

  /** Whether a socket is open and `hello` succeeded. */
  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed && this.hello !== undefined;
  }

  get helloInfo(): HelloResponse | undefined {
    return this.hello;
  }

  /**
   * Connected, or connects now (with a short timeout). A failed attempt is remembered for
   * `retryDelayMs`, so callers can check before every input call without hammering the socket.
   */
  async isAvailable(): Promise<boolean> {
    if (this.connected) return true;
    if (Date.now() - this.lastFailureAt < this.retryDelayMs) return false;
    try {
      await this.ensureHello(Math.min(this.timeoutMs, 2000));
      return true;
    } catch (err) {
      this.lastFailureAt = Date.now();
      this.lastError = (err as Error).message;
      return false;
    }
  }

  /** Send a request; connects and performs `hello` first when needed. Rejects with `DaemonError` for `{ ok: false }`. */
  async request<R extends DaemonResponse = DaemonResponse>(req: DaemonRequest): Promise<Extract<R, { ok: true }>> {
    if (req.op !== 'hello') await this.ensureHello(this.timeoutMs);
    const res = await this.send(req, this.timeoutMs);
    if (!res.ok) throw new DaemonError(res.code, res.error);
    return res as Extract<R, { ok: true }>;
  }

  async status(): Promise<DaemonStatus> {
    try {
      const hello = await this.ensureHello(this.timeoutMs);
      const status = await this.request<StatusResponse>({ op: 'status' });
      return { connected: true, version: hello.version, socketPath: this.socketPath, devices: hello.devices, locked: status.locked };
    } catch (err) {
      return { connected: false, socketPath: this.socketPath, error: (err as Error).message };
    }
  }

  close(): void {
    this.dropSocket(new Error('daemon client closed'));
  }

  private async ensureHello(timeoutMs: number): Promise<HelloResponse> {
    if (this.connected && this.hello) return this.hello;
    await this.connect(timeoutMs);
    const res = await this.send({ op: 'hello', version: 1 }, timeoutMs);
    if (!res.ok) {
      this.dropSocket(new Error(res.error));
      throw new DaemonError(res.code, res.error);
    }
    if (res.op !== 'hello' || res.protocol !== 1) {
      this.dropSocket(new Error('bad hello'));
      throw new RpError('CAPABILITY_FAILED', `rp-coded answered hello with protocol ${String((res as { protocol?: unknown }).protocol)}; expected 1`);
    }
    this.hello = res;
    this.lastError = undefined;
    return res;
  }

  private connect(timeoutMs: number): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.connectImpl(this.socketPath);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new RpError('CAPABILITY_FAILED', `rp-coded did not accept the connection within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.buffer = '';
        resolve();
      });
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new RpError('CAPABILITY_FAILED', `rp-coded is not reachable at ${this.socketPath}: ${err.message}`));
          return;
        }
        if (this.socket === socket) this.dropSocket(err);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.dropSocket(new Error('rp-coded closed the connection'));
      });
    });
  }

  private send(req: DaemonRequest, timeoutMs: number): Promise<DaemonResponse> {
    const run = (): Promise<DaemonResponse> =>
      new Promise((resolve, reject) => {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
          reject(new RpError('CAPABILITY_FAILED', 'rp-coded is not connected'));
          return;
        }
        const timer = setTimeout(() => {
          const idx = this.pending.findIndex((p) => p.timer === timer);
          if (idx >= 0) this.pending.splice(idx, 1);
          this.dropSocket(new Error(`rp-coded did not answer "${req.op}" within ${timeoutMs} ms`));
          reject(new RpError('CAPABILITY_FAILED', `rp-coded did not answer "${req.op}" within ${timeoutMs} ms`));
        }, timeoutMs);
        this.pending.push({ resolve, reject, timer });
        socket.write(`${JSON.stringify(req)}\n`, (err) => {
          if (err) this.dropSocket(err);
        });
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      const pending = this.pending.shift();
      if (!pending) {
        this.logger?.debug?.(`[daemon] unsolicited line: ${line.slice(0, 200)}`);
        continue;
      }
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line) as DaemonResponse);
      } catch {
        pending.reject(new RpError('CAPABILITY_FAILED', `rp-coded sent invalid JSON: ${line.slice(0, 120)}`));
      }
    }
  }

  private dropSocket(err: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.hello = undefined;
    this.buffer = '';
    if (socket && !socket.destroyed) socket.destroy();
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err instanceof RpError ? err : new RpError('CAPABILITY_FAILED', err.message));
    }
    if (this.pending.length === 0 && err.message !== 'daemon client closed') this.logger?.debug?.(`[daemon] disconnected: ${err.message}`);
  }
}
