/**
 * `sdk.system`: open links, run programs, read/write files, clipboard, virtual terminals.
 * Permission gating (level `prompt`) is done by core's dispatcher; these just execute.
 *
 * The `vt*` methods are the only ones that need help: switching console and locking switching
 * need `CAP_SYS_TTY_CONFIG` on `/dev/tty0`, so they go through the rpchatd daemon exactly as
 * `sdk.input` does, and fail with CAPABILITY_FAILED while it is not connected.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clipboard, shell } from 'electron';
import type { ActionContext, CapabilityHandler, Json, VtInfo } from '@rp/shared';
import { RpError } from '@rp/shared';
import { expandHome, isMissingExecutable } from '../commands.js';
import type { DaemonClient } from '../system/daemon-client.js';

export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 300_000;
export const EXEC_OUTPUT_CAP = 64 * 1024;
export const READ_DEFAULT_BYTES = 64 * 1024;
export const FILE_MAX_BYTES = 1024 * 1024;
/** Shortest switch lock worth taking, as for the input lock. */
export const VT_LOCK_MIN_MS = 1000;
export const VT_DAEMON_REQUIRED_MESSAGE =
  'Virtual-terminal control needs the rpchat system integration (Settings → System → Install); the daemon is not connected';

export interface SystemHandlerDeps {
  openExternal?: (url: string) => Promise<void>;
  clipboardWrite?: (text: string) => void;
  clipboardRead?: () => string;
  home?: string;
  /** rpchatd client (Linux). The `vt*` methods fail with CAPABILITY_FAILED without it. */
  daemon?: DaemonClient;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export function absolutePathArg(v: unknown, home: string = os.homedir()): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'path must be a non-empty string');
  const expanded = expandHome(v.trim(), home);
  if (!path.isAbsolute(expanded)) throw new RpError('INVALID_ARGUMENT', `path must be absolute (or start with ~): ${v}`);
  if (expanded.includes('\0')) throw new RpError('INVALID_ARGUMENT', 'path contains a NUL byte');
  return path.normalize(expanded);
}

export function httpUrlArg(v: unknown): string {
  if (typeof v !== 'string') throw new RpError('INVALID_ARGUMENT', 'url must be a string');
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new RpError('INVALID_ARGUMENT', `Invalid URL: ${v}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new RpError('INVALID_ARGUMENT', 'Only http/https URLs can be opened');
  return parsed.toString();
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProgram(command: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const append = (current: string, chunk: Buffer): string => (current.length >= EXEC_OUTPUT_CAP ? current : (current + chunk.toString('utf8')).slice(0, EXEC_OUTPUT_CAP));
    child.stdout?.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = append(stderr, c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const missing = isMissingExecutable(err);
      reject(
        new RpError(
          'CAPABILITY_FAILED',
          missing ? `Cannot run "${command}": it is not installed or not on PATH` : `Cannot run "${command}": ${err.message}`,
          { command, args, ...(missing ? { code: 'ENOENT' } : {}) },
          { cause: err },
        ),
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) stderr = `${stderr}${stderr.length === 0 || stderr.endsWith('\n') ? '' : '\n'}[rp] process killed after ${opts.timeoutMs} ms`;
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

export class SystemHandler implements CapabilityHandler {
  readonly moduleId = 'system';
  private readonly home: string;
  /** Whether a switch lock was taken and not given back, so `dispose` can release it. */
  private vtLocked = false;

  constructor(private readonly deps: SystemHandlerDeps = {}) {
    this.home = deps.home ?? os.homedir();
  }

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'openExternal': {
        const url = httpUrlArg(args[0]);
        await (this.deps.openExternal ?? ((u: string) => shell.openExternal(u)))(url);
        return;
      }
      case 'exec':
        return (await this.exec(args[0], args[1], args[2])) as unknown as Json;
      case 'readFile':
        return this.readFile(args[0], args[1]);
      case 'writeFile':
        await this.writeFile(args[0], args[1]);
        return;
      case 'clipboardWrite': {
        if (typeof args[0] !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
        (this.deps.clipboardWrite ?? ((t: string) => clipboard.writeText(t)))(args[0]);
        return;
      }
      case 'clipboardRead':
        return String(await (this.deps.clipboardRead ?? (() => clipboard.readText()))()).slice(0, 256 * 1024);
      case 'vtStatus':
        return this.vtStatus();
      case 'vtSwitchBack': {
        const res = await (await this.requireDaemon()).vtActivate();
        this.deps.logger?.info(`[system] switched back to VT ${res.vt}${res.switched ? '' : ' (already there)'}`);
        return res;
      }
      case 'vtPreventSwitching':
        return this.vtPreventSwitching(args[0], args[1]);
      case 'vtAllowSwitching':
        await (await this.requireDaemon()).vtUnlock();
        this.vtLocked = false;
        return;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.system.${method}`);
    }
  }

  /** The connected daemon, or CAPABILITY_FAILED when the system integration is missing. */
  private async requireDaemon(): Promise<DaemonClient> {
    const d = this.deps.daemon;
    if (d && (await d.isAvailable())) return d;
    throw new RpError('CAPABILITY_FAILED', VT_DAEMON_REQUIRED_MESSAGE);
  }

  /**
   * Which console is in front and whether switching is locked. Unlike the other `vt*` methods
   * this one answers without the daemon — `available: false` is the honest answer on a machine
   * that has no system integration, and a character can read it without handling an error.
   */
  private async vtStatus(): Promise<{ available: boolean; vt?: number; ourVt?: number; ours: boolean; locked: boolean; until?: string }> {
    const daemon = this.deps.daemon;
    let info: VtInfo | undefined;
    if (daemon && (await daemon.isAvailable())) {
      try {
        info = await daemon.vtStatus();
      } catch (err) {
        this.deps.logger?.warn?.('[system] vt-status failed', err);
      }
    }
    if (!info?.available) return { available: false, ours: false, locked: false };
    const out: { available: boolean; vt?: number; ourVt?: number; ours: boolean; locked: boolean; until?: string } = {
      available: true,
      ours: info.active !== undefined && info.active === info.session,
      locked: info.locked !== undefined,
    };
    if (info.active !== undefined) out.vt = info.active;
    if (info.session !== undefined) out.ourVt = info.session;
    if (info.locked) out.until = info.locked.until;
    return out;
  }

  private async vtPreventSwitching(durationArg: unknown, optsArg: unknown): Promise<{ until: string; durationMs: number }> {
    if (typeof durationArg !== 'number' || !Number.isFinite(durationArg)) throw new RpError('INVALID_ARGUMENT', 'durationMs must be a number');
    // No ceiling of our own: the root-owned policy decides how long a lock may hold
    // (`vtLock.maxDurationMs`, 5 min by default) and the daemon answers with what it granted,
    // so an administrator who raises that limit is not capped by a constant in here.
    const durationMs = Math.max(VT_LOCK_MIN_MS, Math.round(durationArg));
    const opts = optsArg && typeof optsArg === 'object' ? (optsArg as { reason?: unknown }) : {};
    const reason = typeof opts.reason === 'string' ? opts.reason : '';
    const daemon = await this.requireDaemon();
    // The daemon clamps again against the root-owned policy and releases it by itself.
    const res = await daemon.vtLock(durationMs, reason || undefined);
    this.vtLocked = true;
    this.deps.logger?.info(`[system] VT switching locked for ${res.durationMs} ms${reason ? ` (${reason})` : ''}`);
    return res;
  }

  /**
   * Give the console back on shutdown. The daemon would release it anyway when our socket
   * closes (and on its timer), but doing it here means a clean quit does not depend on that.
   */
  async dispose(): Promise<void> {
    if (!this.vtLocked) return;
    this.vtLocked = false;
    try {
      await (await this.requireDaemon()).vtUnlock();
    } catch (err) {
      this.deps.logger?.warn?.('[system] releasing the VT switch lock on dispose failed', err);
    }
  }

  private async exec(command: unknown, argsArg: unknown, optsArg: unknown): Promise<ExecResult> {
    if (typeof command !== 'string' || command.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'command must be a non-empty string');
    const args = argsArg === undefined || argsArg === null ? [] : argsArg;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new RpError('INVALID_ARGUMENT', 'args must be an array of strings');
    const opts = optsArg && typeof optsArg === 'object' ? (optsArg as { timeoutMs?: unknown; cwd?: unknown }) : {};
    let timeoutMs = EXEC_DEFAULT_TIMEOUT_MS;
    if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)) timeoutMs = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1000, Math.round(opts.timeoutMs)));
    const cwd = opts.cwd === undefined || opts.cwd === null ? this.home : absolutePathArg(opts.cwd, this.home);
    return runProgram(expandHome(command.trim(), this.home), args as string[], { cwd, timeoutMs });
  }

  private async readFile(pathArg: unknown, maxBytesArg: unknown): Promise<string> {
    const file = absolutePathArg(pathArg, this.home);
    let maxBytes = READ_DEFAULT_BYTES;
    if (typeof maxBytesArg === 'number' && Number.isFinite(maxBytesArg) && maxBytesArg > 0) maxBytes = Math.min(FILE_MAX_BYTES, Math.round(maxBytesArg));
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'r');
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot read ${file}: ${(err as Error).message}`, { path: file }, { cause: err });
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RpError('INVALID_ARGUMENT', `${file} is not a regular file`);
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private async writeFile(pathArg: unknown, textArg: unknown): Promise<void> {
    const file = absolutePathArg(pathArg, this.home);
    if (typeof textArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
    if (Buffer.byteLength(textArg, 'utf8') > FILE_MAX_BYTES) throw new RpError('INVALID_ARGUMENT', `text exceeds ${FILE_MAX_BYTES} bytes`);
    try {
      await fs.writeFile(file, textArg, 'utf8');
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot write ${file}: ${(err as Error).message}`, { path: file }, { cause: err });
    }
  }
}
