/**
 * Client for the `rp-coded` root daemon (docs/spec/system.md): JSON lines over a unix
 * socket, connect on demand, `hello` handshake, one request in flight at a time with a
 * 10 s timeout (`apply-update`: 5 min), reconnect on the next request after the socket drops.
 */
import * as net from 'node:net';
import type { DaemonRequest, DaemonResponse, DaemonStatus, GuardInfo, PolicyFile, RemoteInfo, RpErrorCode, RuntimeInfo, SealInfo, SealMode, TotpConfig } from '@rp/shared';
import { DAEMON_SOCKET_PATH, RpError } from '@rp/shared';

export type HelloResponse = Extract<DaemonResponse, { op: 'hello' }>;
export type StatusResponse = Extract<DaemonResponse, { op: 'status' }>;
export type GuardResponse = Extract<DaemonResponse, { op: 'guard-apply' | 'guard-status' }>;
export type SetPolicyResponse = Extract<DaemonResponse, { op: 'set-policy' }>;
export type SealPolicyResponse = Extract<DaemonResponse, { op: 'seal-policy' }>;
export type UnsealPolicyResponse = Extract<DaemonResponse, { op: 'unseal-policy' }>;
export type SealStatusResponse = Extract<DaemonResponse, { op: 'seal-status' }>;
export type RemoteApplyResponse = Extract<DaemonResponse, { op: 'remote-apply' }>;
export type SetRemoteLinkResponse = Extract<DaemonResponse, { op: 'set-remote-link' }>;
export type VerifyPackResponse = Extract<DaemonResponse, { op: 'verify-pack' }>;
export type PolicyResponse = Extract<DaemonResponse, { op: 'policy' }>;
export type ApplyUpdateResponse = Extract<DaemonResponse, { op: 'apply-update' }>;

/** `apply-update` extracts a few hundred MB and may copy the daemon: give it minutes, not seconds. */
export const APPLY_UPDATE_TIMEOUT_MS = 5 * 60_000;
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

/** `RpError` code for a daemon error code (shared by every op that goes through the daemon). */
export function rpErrorCodeFor(code: DaemonErrorResponse['code']): RpErrorCode {
  switch (code) {
    case 'REFUSED':
    case 'POLICY':
      return 'PERMISSION_DENIED';
    case 'INVALID':
    case 'EXISTS':
      return 'INVALID_ARGUMENT';
    // A missing, wrong, replayed or locked-out TOTP code: the caller may try again with a new
    // one, so it is a permission problem rather than a bad argument.
    case 'CODE':
      return 'PERMISSION_DENIED';
    default:
      return 'CAPABILITY_FAILED';
  }
}

/** Turn a `DaemonError` into the `RpError` callers expect; anything else is returned as is. */
export function toRpError(err: unknown, op: DaemonRequest['op']): unknown {
  if (err instanceof DaemonError) return new RpError(rpErrorCodeFor(err.code), `rp-coded refused ${op}: ${err.message}`, { daemonCode: err.code });
  return err;
}

export interface DaemonClientOptions {
  socketPath?: string;
  /** Per-request timeout. Default 10 000. */
  timeoutMs?: number;
  /** Timeout for `apply-update`. Default `APPLY_UPDATE_TIMEOUT_MS`. */
  applyTimeoutMs?: number;
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
  private readonly applyTimeoutMs: number;
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
    this.applyTimeoutMs = opts.applyTimeoutMs ?? APPLY_UPDATE_TIMEOUT_MS;
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
    const res = await this.send(req, req.op === 'apply-update' ? this.applyTimeoutMs : this.timeoutMs);
    if (!res.ok) throw new DaemonError(res.code, res.error);
    return res as Extract<R, { ok: true }>;
  }

  async status(): Promise<DaemonStatus> {
    try {
      const hello = await this.ensureHello(this.timeoutMs);
      const status = await this.request<StatusResponse>({ op: 'status' });
      const out: DaemonStatus = { connected: true, version: hello.version, socketPath: this.socketPath, devices: hello.devices, locked: status.locked };
      if (status.keepalive) out.keepalive = status.keepalive;
      if (status.install) out.install = status.install;
      if (status.guard) out.guard = status.guard;
      return out;
    } catch (err) {
      return { connected: false, socketPath: this.socketPath, error: (err as Error).message };
    }
  }

  /**
   * System install: have the daemon verify, extract and swap in a downloaded AppImage. Resolves
   * with the installed version and whether the daemon restarts itself afterwards. Daemon errors
   * come back as `RpError` (`REFUSED` → `PERMISSION_DENIED`, `INVALID` → `INVALID_ARGUMENT`,
   * `INTERNAL`/`BUSY` → `CAPABILITY_FAILED`, `details.daemonCode` keeps the original).
   */
  async applyUpdate(input: { file: string; version: string; sha512: string }): Promise<{ version: string; restartDaemon: boolean }> {
    try {
      const res = await this.request<ApplyUpdateResponse>({ op: 'apply-update', file: input.file, version: input.version, sha512: input.sha512 });
      return { version: res.version, restartDaemon: res.restartDaemon };
    } catch (err) {
      throw toRpError(err, 'apply-update');
    }
  }

  /** Session guard: (re)generate and load the profiles from the policy now. Daemon errors become `RpError`s like the other ops. */
  async guardApply(): Promise<GuardInfo> {
    try {
      return (await this.request<GuardResponse>({ op: 'guard-apply' })).guard;
    } catch (err) {
      throw toRpError(err, 'guard-apply');
    }
  }

  /** Session guard: what the daemon has engaged, without touching anything. */
  async guardStatus(): Promise<GuardInfo> {
    try {
      return (await this.request<GuardResponse>({ op: 'guard-status' })).guard;
    } catch (err) {
      throw toRpError(err, 'guard-status');
    }
  }

  /**
   * Wait until `hello` succeeds (the daemon restarted after updating itself): retries with a
   * growing delay (`initialDelayMs` doubling up to 5 s) until `timeoutMs` is up. Resolves with
   * whether it is reachable; never rejects.
   */
  async waitForHello(timeoutMs: number, initialDelayMs = 500): Promise<boolean> {
    // A fresh handshake, not the cached one: the point is to prove the daemon answers *now*.
    this.dropSocket(new Error('waiting for rp-coded to come back'));
    const deadline = Date.now() + timeoutMs;
    let delay = initialDelayMs;
    for (;;) {
      try {
        await this.ensureHello(Math.min(this.timeoutMs, 2000));
        this.lastFailureAt = 0;
        return true;
      } catch (err) {
        this.lastError = (err as Error).message;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(delay, left)));
      delay = Math.min(delay * 2, 5000);
    }
  }

  /**
   * Create the policy file through the daemon, or — on a sealed machine, with `code` — replace it.
   * Rejects with `RpError` `INVALID_ARGUMENT` when the daemon rejects the object (`INVALID`) or a
   * policy already exists on an unsealed machine (`EXISTS`, `details.daemonCode`),
   * `PERMISSION_DENIED` for a missing or wrong code (`CODE`), `CAPABILITY_FAILED` otherwise.
   */
  async setPolicy(policy: PolicyFile, code?: string): Promise<{ path: string; replaced: boolean }> {
    try {
      const res = await this.request<SetPolicyResponse>(code ? { op: 'set-policy', policy, code } : { op: 'set-policy', policy });
      return { path: res.path, replaced: res.replaced };
    } catch (err) {
      throw toRpError(err, 'set-policy');
    }
  }

  /** The policy the daemon has, as it parsed it (`null` when the machine has none). */
  async policy(): Promise<{ policy: PolicyFile | null; path: string }> {
    try {
      const res = await this.request<PolicyResponse>({ op: 'policy' });
      return { policy: res.policy, path: res.path };
    } catch (err) {
      throw toRpError(err, 'policy');
    }
  }

  /**
   * Seal the machine: the daemon generates a TOTP secret, pins the policy to it and answers with
   * the secret, the `otpauth://` URI to enrol with and the remote-configuration signing key. They
   * are readable exactly once — the caller must show them before the answer is thrown away.
   */
  async sealPolicy(input: { policy?: PolicyFile; totp?: TotpConfig } = {}): Promise<{ path: string; secret: string; otpauth: string; seal: SealInfo; runtime: RuntimeInfo }> {
    const req: DaemonRequest = { op: 'seal-policy' };
    if (input.policy) req.policy = input.policy;
    if (input.totp) req.totp = input.totp;
    try {
      const res = await this.request<SealPolicyResponse>(req);
      return { path: res.path, secret: res.secret, otpauth: res.otpauth, seal: res.seal, runtime: res.runtime };
    } catch (err) {
      throw toRpError(err, 'seal-policy');
    }
  }

  /** Remove the seal with a code from the enrolled app; `removePolicy` takes the policy with it. */
  async unsealPolicy(code: string, removePolicy = false): Promise<{ path: string; removed: boolean }> {
    try {
      const res = await this.request<UnsealPolicyResponse>({ op: 'unseal-policy', code, removePolicy });
      return { path: res.path, removed: res.removed };
    } catch (err) {
      throw toRpError(err, 'unseal-policy');
    }
  }

  /** The seal, the runtime policy filesystem and the remote-configuration state. */
  async sealStatus(): Promise<{ seal: SealInfo; runtime: RuntimeInfo; remote: RemoteInfo }> {
    try {
      const res = await this.request<SealStatusResponse>({ op: 'seal-status' });
      return { seal: res.seal, runtime: res.runtime, remote: res.remote };
    } catch (err) {
      throw toRpError(err, 'seal-status');
    }
  }

  /**
   * Hand a fetched policy chain to the daemon. `document` must be the response body byte for
   * byte: the signatures cover those bytes, so re-serialising it would break them.
   */
  async remoteApply(document: string): Promise<{ changed: boolean; applied: number; seq: number; unsealed: boolean; policyHash: string; runtime: RuntimeInfo; remote: RemoteInfo }> {
    try {
      const res = await this.request<RemoteApplyResponse>({ op: 'remote-apply', document });
      return { changed: res.changed, applied: res.applied, seq: res.seq, unsealed: res.unsealed, policyHash: res.policyHash, runtime: res.runtime, remote: res.remote };
    } catch (err) {
      throw toRpError(err, 'remote-apply');
    }
  }

  /**
   * Paste a Remote Link. `code` is needed when the machine is already linked in `totp` mode; a
   * machine in `chain` mode refuses outright, because only its own chain can move its trust root.
   */
  async setRemoteLink(blob: string, code?: string): Promise<{ mode: SealMode; url: string; secret?: string; otpauth?: string; seal: SealInfo; runtime: RuntimeInfo; remote: RemoteInfo }> {
    try {
      const res = await this.request<SetRemoteLinkResponse>(code ? { op: 'set-remote-link', blob, code } : { op: 'set-remote-link', blob });
      const out: { mode: SealMode; url: string; secret?: string; otpauth?: string; seal: SealInfo; runtime: RuntimeInfo; remote: RemoteInfo } = {
        mode: res.mode,
        url: res.url,
        seal: res.seal,
        runtime: res.runtime,
        remote: res.remote,
      };
      if (res.secret !== undefined) out.secret = res.secret;
      if (res.otpauth !== undefined) out.otpauth = res.otpauth;
      return out;
    } catch (err) {
      throw toRpError(err, 'set-remote-link');
    }
  }

  /**
   * Whether a downloaded pack may be installed. The app hashes the bytes; the daemon checks that
   * hash against what the policy pins and, where the machine has a key, against the
   * administrator's signature. Resolves with whether a signature vouched for it.
   */
  async verifyPack(id: string, sha256: string): Promise<boolean> {
    try {
      return (await this.request<VerifyPackResponse>({ op: 'verify-pack', id, sha256 })).signed;
    } catch (err) {
      throw toRpError(err, 'verify-pack');
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
