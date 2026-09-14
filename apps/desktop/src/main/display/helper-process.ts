/**
 * Driver for the native `rp-overlay-wlr` helper (docs/spec/overlay-helper.md):
 * spawn, `hello`, JSON-lines reader, request/response matched by `seq`,
 * restart with backoff on crash, `quit` on dispose. The child process factory
 * is injectable so tests can run a fake helper in-process.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { MonitorInfo } from '@rp/shared';

export const HELPER_PROTOCOL_VERSION = 1;

export interface HelperReady {
  ev: 'ready';
  version: number;
  features: { layers: string[]; opacity: boolean; clickThrough: boolean; exactPosition: boolean; video: boolean };
}

export interface HelperEvent {
  ev: string;
  seq?: number;
  id?: string;
  [key: string]: unknown;
}

/** The subset of `ChildProcess` the driver uses (fakeable). */
export interface HelperChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  pid?: number | undefined;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type HelperSpawner = (binary: string, args: string[]) => HelperChildLike;

export interface HelperProcessOptions {
  binary: string;
  args?: string[];
  logger?: Pick<Console, 'info' | 'warn' | 'debug'>;
  spawnImpl?: HelperSpawner;
  /** Time to wait for `ready` after `hello`. Default 5000. */
  helloTimeoutMs?: number;
  /** Per-request timeout. Default 10000. */
  requestTimeoutMs?: number;
  /** Delays before a restart after consecutive crashes. Default [1000, 2000, 5000, 10000]. */
  restartBackoffMs?: number[];
}

interface Pending {
  resolve(ev: HelperEvent): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const defaultSpawn: HelperSpawner = (binary, args) =>
  spawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // The helper is a Wayland layer-shell client: force GTK onto Wayland even when DISPLAY is
    // also set (GTK would otherwise pick X11, where there is no layer shell). RP_OVERLAY_WAYLAND_DISPLAY /
    // RP_OVERLAY_XDG_RUNTIME_DIR let the helper target a different compositor than the app itself
    // (used by the layer-shell smoke test, where the app runs on X11 and the helper on a nested Sway).
    env: {
      ...process.env,
      GDK_BACKEND: 'wayland',
      ...(process.env.RP_OVERLAY_WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.RP_OVERLAY_WAYLAND_DISPLAY } : {}),
      ...(process.env.RP_OVERLAY_XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.RP_OVERLAY_XDG_RUNTIME_DIR } : {}),
    },
  }) as unknown as HelperChildLike;

/**
 * Events: `event` (every helper event), `message` (page payloads), `closed`,
 * `error`, `log`, `monitors`, `exit` (unexpected exit — overlays are gone).
 */
export class HelperProcess extends EventEmitter {
  private readonly binary: string;
  private readonly args: string[];
  private readonly logger: HelperProcessOptions['logger'];
  private readonly spawnImpl: HelperSpawner;
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoff: number[];
  private child: HelperChildLike | undefined;
  private starting: Promise<HelperReady> | undefined;
  private ready: HelperReady | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private lastStderr = '';
  private crashes = 0;
  private lastCrashAt = 0;
  private disposed = false;

  constructor(opts: HelperProcessOptions) {
    super();
    this.binary = opts.binary;
    this.args = opts.args ?? [];
    this.logger = opts.logger;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.backoff = opts.restartBackoffMs ?? [1000, 2000, 5000, 10_000];
  }

  get isRunning(): boolean {
    return this.child !== undefined && this.ready !== undefined;
  }

  get features(): HelperReady | undefined {
    return this.ready;
  }

  /** Spawn (if needed), send `hello`, resolve with the `ready` event. */
  start(): Promise<HelperReady> {
    if (this.disposed) return Promise.reject(new Error('helper disposed'));
    if (this.ready && this.child) return Promise.resolve(this.ready);
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<HelperReady> {
    const sinceCrash = Date.now() - this.lastCrashAt;
    const wait = this.crashes > 0 ? (this.backoff[Math.min(this.crashes - 1, this.backoff.length - 1)] ?? 0) - sinceCrash : 0;
    if (wait > 0) throw new Error(`helper crashed ${this.crashes} time(s); next restart allowed in ${wait} ms`);
    const child = this.spawnImpl(this.binary, this.args);
    this.child = child;
    this.buffer = '';
    this.lastStderr = '';
    child.on('error', (err) => {
      this.logger?.warn?.(`[overlay-helper] process error: ${err.message}`);
      this.onExit(child, null, null, err);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    // A helper that dies as it starts (no compositor, no layer shell) leaves us writing into a
    // closed pipe. Node reports that as an `error` on the pipe as well as to the write callback,
    // and an `error` nobody listens for is an uncaught exception — in Electron's main process
    // that is the "A JavaScript error occurred" dialog instead of the restart path below.
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      pipe?.on('error', (err: Error) => {
        this.logger?.debug?.(`[overlay-helper] pipe error: ${err.message}`);
        this.onExit(child, null, null, err);
      });
    }
    child.stdout?.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.lastStderr = text.slice(0, 200);
      this.logger?.debug?.(`[overlay-helper:stderr] ${text}`);
    });
    // A handshake that fails says "write EPIPE" or "timed out" — useless on its own. The reason
    // is on the helper's stderr (a missing libgtk-layer-shell.so.0, no compositor, …), so carry
    // the last line into the error the caller logs before it falls back.
    let ready: HelperReady;
    try {
      ready = (await this.request('hello', { version: HELPER_PROTOCOL_VERSION }, this.helloTimeoutMs)) as unknown as HelperReady;
    } catch (err) {
      const why = (err as Error).message;
      throw new Error(this.lastStderr ? `${why} (helper said: ${this.lastStderr})` : why);
    }
    if (ready.ev !== 'ready') throw new Error(`helper answered hello with "${ready.ev}"`);
    if (typeof ready.version !== 'number' || ready.version > HELPER_PROTOCOL_VERSION) {
      throw new Error(`helper protocol version ${String(ready.version)} is not supported (want ≤ ${HELPER_PROTOCOL_VERSION})`);
    }
    this.ready = ready;
    this.crashes = 0;
    return ready;
  }

  /** Send a request and await the reply that echoes its `seq`. */
  request(op: string, fields: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<HelperEvent> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return Promise.reject(new Error('helper is not running'));
    const seq = ++this.seq;
    const line = `${JSON.stringify({ op, seq, ...fields })}\n`;
    return new Promise<HelperEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`helper "${op}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      child.stdin?.write(line, (err) => {
        if (!err) return;
        const p = this.pending.get(seq);
        if (!p) return;
        this.pending.delete(seq);
        clearTimeout(p.timer);
        reject(err);
      });
    });
  }

  /** Send `quit`, then kill if it lingers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.request('quit', {}, 1500).catch(() => undefined);
    } finally {
      this.rejectAll(new Error('helper disposed'));
      if (this.child === child) {
        child.kill('SIGTERM');
        this.child = undefined;
        this.ready = undefined;
      }
    }
  }

  async monitors(): Promise<MonitorInfo[]> {
    const ev = await this.request('monitors');
    const list = ev.monitors;
    return Array.isArray(list) ? (list as MonitorInfo[]) : [];
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.onLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let ev: HelperEvent;
    try {
      ev = JSON.parse(line) as HelperEvent;
    } catch {
      this.logger?.debug?.(`[overlay-helper] unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    if (!ev || typeof ev.ev !== 'string') return;
    if (typeof ev.seq === 'number') {
      const p = this.pending.get(ev.seq);
      if (p) {
        this.pending.delete(ev.seq);
        clearTimeout(p.timer);
        if (ev.ev === 'error') p.reject(new Error(typeof ev.message === 'string' ? ev.message : 'helper error'));
        else p.resolve(ev);
        this.emit('event', ev);
        return;
      }
    }
    if (ev.ev === 'log') {
      const level = ev.level === 'error' || ev.level === 'warn' ? 'warn' : 'debug';
      this.logger?.[level]?.(`[overlay-helper] ${String(ev.message ?? '')}`);
    }
    this.emit('event', ev);
    this.emit(ev.ev, ev);
  }

  private onExit(child: HelperChildLike, code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    const wasReady = this.ready !== undefined;
    this.ready = undefined;
    this.rejectAll(err ?? new Error(`helper exited (code ${String(code)}, signal ${String(signal)})`));
    if (this.disposed) return;
    this.crashes += 1;
    this.lastCrashAt = Date.now();
    this.logger?.warn?.(`[overlay-helper] exited unexpectedly (code ${String(code)}, signal ${String(signal)}); overlays are gone`);
    this.emit('exit', { code, signal, wasReady });
  }

  private rejectAll(err: Error): void {
    for (const [seq, p] of this.pending) {
      this.pending.delete(seq);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}

/** Where the helper binary may live: env override, bundled resources, PATH. */
export function findHelperBinary(opts: {
  env: NodeJS.ProcessEnv;
  resourcesDirs: string[];
  exists(file: string): boolean;
  onPath(name: string): boolean;
}): string | undefined {
  const override = opts.env.RP_OVERLAY_HELPER;
  if (override && opts.exists(override)) return override;
  for (const dir of opts.resourcesDirs) {
    const candidate = `${dir}/bin/rp-overlay-wlr`;
    if (opts.exists(candidate)) return candidate;
  }
  return opts.onPath('rp-overlay-wlr') ? 'rp-overlay-wlr' : undefined;
}
