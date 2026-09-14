/**
 * The keepalive registration with `rp-coded` (docs/spec/system.md "Keepalive"): a dedicated
 * long-lived connection — `DaemonClient` connects on demand and the daemon only relaunches an
 * app whose *registered* connection dropped — that says `hello`, sends `register` with how to
 * start this app again, and then just stays open. Whenever it drops (daemon restart, socket
 * gone) it reconnects with exponential backoff and registers again; `unregister()` tells the
 * daemon an exit is intended (update restart, ordinary quit) so it does not relaunch anything.
 *
 * Registering is cheap and always done; the daemon decides from the policy whether it matters.
 *
 * The same connection carries the daemon's pushed events (`subscribe` after `register`): lines
 * with an `ev` key instead of `ok`/`op` — `guard-attempt` from the session guard — which go to
 * `onEvent` listeners rather than to the pending request. A daemon that does not know
 * `subscribe` answers INVALID; the link stays registered and simply gets no events.
 */
import * as net from 'node:net';
import type { DaemonEvent, DaemonEventName, DaemonRequest, DaemonResponse } from '@rp/shared';
import { DAEMON_EVENT_NAMES, DAEMON_SOCKET_PATH } from '@rp/shared';
import type { LaunchSpec } from '../quit-guard.js';

export interface KeepaliveLinkOptions {
  socketPath?: string;
  registration: LaunchSpec;
  logger?: Pick<Console, 'debug' | 'info' | 'warn'>;
  /** Injectable for tests (defaults to `net.connect`). */
  connect?: (socketPath: string) => net.Socket;
  /** Reconnect delay after a drop: `initial` doubling up to `max`. Default 1000 → 30 000 ms. */
  backoffMs?: { initial?: number; max?: number };
  /** Timeout for one request/response on the link (`hello`, `register`, `unregister`). Default 10 000. */
  timeoutMs?: number;
  /** Events to subscribe to after registering. Default: every `DaemonEventName`; `[]` subscribes to nothing. */
  events?: DaemonEventName[];
}

export type KeepaliveLinkState = 'idle' | 'connecting' | 'registered' | 'waiting' | 'stopped';

interface Pending {
  resolve(res: DaemonResponse): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** Pure: the delay before reconnect attempt `attempt` (1-based) — `initial * 2^(attempt-1)`, capped at `max`. */
export function reconnectDelay(attempt: number, backoff: { initial: number; max: number }): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(backoff.max, backoff.initial * 2 ** Math.min(n - 1, 30));
}

export class KeepaliveLink {
  readonly socketPath: string;
  private readonly backoff: { initial: number; max: number };
  private readonly timeoutMs: number;
  private readonly connectImpl: (socketPath: string) => net.Socket;
  private readonly logger: KeepaliveLinkOptions['logger'];
  private socket: net.Socket | undefined;
  private buffer = '';
  private readonly pending: Pending[] = [];
  private stateValue: KeepaliveLinkState = 'idle';
  private attempt = 0;
  private registrations = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private registration: LaunchSpec;
  private readonly events: DaemonEventName[];
  private readonly listeners = new Set<(event: DaemonEvent) => void>();
  private subscribedValue = false;

  constructor(opts: KeepaliveLinkOptions) {
    this.socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
    this.backoff = { initial: opts.backoffMs?.initial ?? 1000, max: opts.backoffMs?.max ?? 30_000 };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.connectImpl = opts.connect ?? ((p) => net.connect(p));
    this.logger = opts.logger;
    this.registration = opts.registration;
    this.events = opts.events ?? [...DAEMON_EVENT_NAMES];
  }

  /** Whether the daemon acknowledged the event subscription on the current connection. */
  get subscribed(): boolean {
    return this.registered && this.subscribedValue;
  }

  /** Receive pushed daemon events (`guard-attempt`). Returns the unsubscribe function. */
  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get state(): KeepaliveLinkState {
    return this.stateValue;
  }

  /** Whether the daemon currently holds this app's registration on an open connection. */
  get registered(): boolean {
    return this.stateValue === 'registered' && this.socket !== undefined && !this.socket.destroyed;
  }

  /** How many times `register` was acknowledged (first connection plus every reconnect). */
  get registrationCount(): number {
    return this.registrations;
  }

  /** Connection attempts since the last successful registration (drives the backoff). */
  get attempts(): number {
    return this.attempt;
  }

  /** Open the link and keep it open until `unregister()`/`close()`. Idempotent. */
  start(): void {
    if (this.stopped || this.stateValue !== 'idle') return;
    void this.connectAndRegister();
  }

  /**
   * Tell the daemon this exit is intended and stop reconnecting. Resolves once the daemon
   * acknowledged (or the link was not registered anyway); never rejects — a daemon that is
   * gone cannot relaunch anything either. Bounded by `timeoutMs`.
   */
  async unregister(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearRetry();
    if (this.registered) {
      try {
        await this.send({ op: 'unregister' });
        this.logger?.info?.('[keepalive] unregistered from rp-coded');
      } catch (err) {
        this.logger?.warn?.(`[keepalive] unregister failed: ${(err as Error).message}`);
      }
    }
    this.dropSocket(new Error('keepalive link closed'));
    this.stateValue = 'stopped';
  }

  /** Drop the connection without unregistering (the daemon treats that like a crash). */
  close(): void {
    this.stopped = true;
    this.clearRetry();
    this.dropSocket(new Error('keepalive link closed'));
    this.stateValue = 'stopped';
  }

  private async connectAndRegister(): Promise<void> {
    if (this.stopped) return;
    this.attempt += 1;
    this.stateValue = 'connecting';
    try {
      await this.connect();
      const hello = await this.send({ op: 'hello', version: 1 });
      if (!hello.ok) throw new Error(`hello refused: ${hello.error}`);
      if (hello.op !== 'hello' || hello.protocol !== 1) throw new Error('bad hello');
      const res = await this.send({ op: 'register', ...this.registration });
      if (!res.ok) throw new Error(`register refused (${res.code}): ${res.error}`);
      if (this.stopped) return;
      this.registrations += 1;
      this.attempt = 0;
      this.stateValue = 'registered';
      this.logger?.info?.(`[keepalive] registered with rp-coded (${this.registration.exec}${this.registration.args.length > 0 ? ` ${this.registration.args.join(' ')}` : ''})`);
      await this.subscribe();
    } catch (err) {
      if (this.stopped) return;
      const delay = reconnectDelay(this.attempt, this.backoff);
      const level = this.attempt === 1 ? 'info' : 'debug';
      this.logger?.[level]?.(`[keepalive] not registered (${(err as Error).message}); retrying in ${delay} ms`);
      this.dropSocket(err as Error);
      this.scheduleReconnect(delay);
    }
  }

  /** Ask for pushed events; an older daemon refuses (INVALID) and the link carries on without them. */
  private async subscribe(): Promise<void> {
    this.subscribedValue = false;
    if (this.events.length === 0) return;
    try {
      const res = await this.send({ op: 'subscribe', events: this.events });
      if (res.ok && res.op === 'subscribe') {
        this.subscribedValue = res.events.length > 0;
        this.logger?.debug?.(`[keepalive] subscribed to ${res.events.join(', ') || 'nothing'}`);
      } else if (!res.ok) {
        this.logger?.debug?.(`[keepalive] daemon has no event push (${res.code}: ${res.error})`);
      }
    } catch (err) {
      if (!this.stopped) this.logger?.debug?.(`[keepalive] subscribe failed: ${(err as Error).message}`);
    }
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped) return;
    this.stateValue = 'waiting';
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connectAndRegister();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.connectImpl(this.socketPath);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`rp-coded did not accept the connection within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
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
          reject(new Error(`rp-coded is not reachable at ${this.socketPath}: ${err.message}`));
          return;
        }
        if (this.socket === socket) this.lost(err);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.lost(new Error('rp-coded closed the connection'));
      });
    });
  }

  /** The open link dropped: forget it and reconnect (the first retry is immediate-ish). */
  private lost(err: Error): void {
    const wasRegistered = this.stateValue === 'registered';
    this.dropSocket(err);
    if (this.stopped) return;
    if (wasRegistered) {
      this.logger?.warn?.(`[keepalive] link to rp-coded lost (${err.message}); reconnecting`);
      this.attempt = 0;
      this.scheduleReconnect(reconnectDelay(1, this.backoff));
    }
  }

  private send(req: DaemonRequest): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        reject(new Error('rp-coded is not connected'));
        return;
      }
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`rp-coded did not answer "${req.op}" within ${this.timeoutMs} ms`));
        this.dropSocket(new Error('timeout'));
      }, this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      socket.write(`${JSON.stringify(req)}\n`, (err) => {
        if (err) this.lost(err);
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const pending = this.pending.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`rp-coded sent invalid JSON: ${line.slice(0, 120)}`));
        } else this.logger?.debug?.(`[keepalive] unparsable line: ${line.slice(0, 200)}`);
        continue;
      }
      // A pushed event: `{ ev: … }`, never an answer to a request.
      if (parsed && typeof parsed === 'object' && typeof (parsed as { ev?: unknown }).ev === 'string') {
        this.dispatchEvent(parsed as DaemonEvent);
        continue;
      }
      const pending = this.pending.shift();
      if (!pending) {
        this.logger?.debug?.(`[keepalive] unsolicited line: ${line.slice(0, 200)}`);
        continue;
      }
      clearTimeout(pending.timer);
      pending.resolve(parsed as DaemonResponse);
    }
  }

  private dispatchEvent(event: DaemonEvent): void {
    if (!(DAEMON_EVENT_NAMES as readonly string[]).includes(event.ev)) {
      this.logger?.debug?.(`[keepalive] unknown event ${event.ev}`);
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        this.logger?.warn?.(`[keepalive] event listener failed: ${(err as Error).message}`);
      }
    }
  }

  private dropSocket(err: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = '';
    this.subscribedValue = false;
    if (this.stateValue === 'registered') this.stateValue = 'idle';
    if (socket && !socket.destroyed) socket.destroy();
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
