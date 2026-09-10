/** `sdk.input`: bounded keyboard/mouse lock and input injection through the rp-coded system daemon. */
import type { ActionContext, CapabilityHandler, DaemonRequest, DaemonResponse, Json, LockDevices } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import { toRpError } from '../system/daemon-client.js';
import type { DaemonClient } from '../system/daemon-client.js';

export const INPUT_LOCK_MIN_MS = 1000;
export const INPUT_TEXT_MAX = 2000;
export const INPUT_DAEMON_REQUIRED_MESSAGE = 'Input control needs the rp-code system integration (Settings → System → Install); the daemon is not connected';
type LockResponse = Extract<DaemonResponse, { op: 'lock' }>;
type StatusResponse = Extract<DaemonResponse, { op: 'status' }>;
type MouseButton = 'left' | 'right' | 'middle';
const KEY_COMBO = /^[a-zA-Z0-9_+\-]{1,64}$/;
const BUTTONS: ReadonlySet<string> = new Set<MouseButton>(['left', 'middle', 'right']);

export function pointArgs(x: unknown, y: unknown): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new RpError('INVALID_ARGUMENT', 'x and y must be numbers');
  return { x: Math.round(x), y: Math.round(y) };
}

const LOCK_DEVICES: ReadonlySet<string> = new Set(['keyboard', 'mouse', 'both']);

/** `devices` option of `lock`: keyboard | mouse | both (default both). */
export function lockDevicesArg(v: unknown): LockDevices {
  if (v === undefined || v === null) return 'both';
  if (typeof v !== 'string' || !LOCK_DEVICES.has(v)) throw new RpError('INVALID_ARGUMENT', "devices must be 'keyboard', 'mouse' or 'both'");
  return v as LockDevices;
}

/** `button` argument of `click`: left | right | middle (default left). */
export function buttonArg(v: unknown): MouseButton {
  const name = typeof v === 'string' ? v.toLowerCase() : 'left';
  if (!BUTTONS.has(name)) throw new RpError('INVALID_ARGUMENT', 'button must be left, right or middle');
  return name as MouseButton;
}

export interface InputHandlerDeps {
  maxLockMs(): Promise<number>;
  logger: Logger;
  now?: () => number;
  /** rp-coded client (Linux). Every method fails with CAPABILITY_FAILED while it is missing or unreachable. */
  daemon?: DaemonClient;
}

export class InputHandler implements CapabilityHandler {
  readonly moduleId = 'input';
  private until: number | undefined;
  private lockedDevices: LockDevices = 'both';

  constructor(private readonly deps: InputHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'lock':
        return this.lock(args[0], args[1]);
      case 'unlock':
        await this.unlock();
        return;
      case 'status':
        return this.daemonStatus(await this.requireDaemon());
      case 'type': {
        if (typeof args[0] !== 'string' || args[0].length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
        if (args[0].length > INPUT_TEXT_MAX) throw new RpError('INVALID_ARGUMENT', `text is longer than ${INPUT_TEXT_MAX} characters`);
        await this.viaDaemon(await this.requireDaemon(), { op: 'type', text: args[0] });
        return;
      }
      case 'key': {
        if (typeof args[0] !== 'string' || !KEY_COMBO.test(args[0])) throw new RpError('INVALID_ARGUMENT', 'combo must look like "ctrl+shift+s"');
        await this.viaDaemon(await this.requireDaemon(), { op: 'key', combo: args[0] });
        return;
      }
      case 'click': {
        const { x, y } = pointArgs(args[0], args[1]);
        const button = buttonArg(args[2]);
        await this.viaDaemon(await this.requireDaemon(), { op: 'click', x, y, button });
        return;
      }
      case 'moveMouse': {
        const { x, y } = pointArgs(args[0], args[1]);
        await this.viaDaemon(await this.requireDaemon(), { op: 'move', x, y });
        return;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.input.${method}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The connected daemon client, or CAPABILITY_FAILED when the system integration is missing or unreachable. */
  private async requireDaemon(): Promise<DaemonClient> {
    const d = this.deps.daemon;
    if (d && (await d.isAvailable())) return d;
    throw new RpError('CAPABILITY_FAILED', INPUT_DAEMON_REQUIRED_MESSAGE);
  }

  private async viaDaemon<R extends DaemonResponse>(daemon: DaemonClient, req: DaemonRequest): Promise<Extract<R, { ok: true }>> {
    try {
      return await daemon.request<R>(req);
    } catch (err) {
      throw toRpError(err, req.op);
    }
  }

  private async daemonStatus(daemon: DaemonClient): Promise<{ locked: boolean; until?: string; devices?: LockDevices }> {
    const res = await this.viaDaemon<StatusResponse>(daemon, { op: 'status' });
    if (res.locked) return { locked: true, until: res.locked.until, devices: res.locked.devices ?? 'both' };
    return { locked: false };
  }

  /** What the app last heard from the daemon (no round trip); used to decide whether `dispose` should unlock. */
  status(): { locked: boolean; until?: string; devices?: LockDevices } {
    if (this.until !== undefined && this.until > this.now()) return { locked: true, until: new Date(this.until).toISOString(), devices: this.lockedDevices };
    return { locked: false };
  }

  private async lock(durationArg: unknown, optionsArg: unknown): Promise<{ until: string; durationMs: number; devices: LockDevices }> {
    if (typeof durationArg !== 'number' || !Number.isFinite(durationArg)) throw new RpError('INVALID_ARGUMENT', 'durationMs must be a number');
    const max = Math.max(INPUT_LOCK_MIN_MS, await this.deps.maxLockMs());
    const durationMs = Math.min(max, Math.max(INPUT_LOCK_MIN_MS, Math.round(durationArg)));
    const options = optionsArg && typeof optionsArg === 'object' ? (optionsArg as { reason?: unknown; devices?: unknown }) : {};
    const reason = typeof options.reason === 'string' ? options.reason : '';
    const devices = lockDevicesArg(options.devices);
    const daemon = await this.requireDaemon();
    // The daemon clamps again against the root-owned policy and unlocks by itself.
    const res = await this.viaDaemon<LockResponse>(daemon, { op: 'lock', durationMs, devices, ...(reason ? { reason } : {}) });
    this.until = new Date(res.until).getTime();
    this.lockedDevices = res.devices ?? devices;
    this.deps.logger.info(`[input] locked ${this.lockedDevices} via rp-coded for ${res.durationMs} ms${reason ? ` (${reason})` : ''}`);
    return { until: res.until, durationMs: res.durationMs, devices: this.lockedDevices };
  }

  private async unlock(): Promise<void> {
    const daemon = await this.requireDaemon();
    this.until = undefined;
    await this.viaDaemon(daemon, { op: 'unlock' });
  }

  async dispose(): Promise<void> {
    if (!this.status().locked) return;
    try {
      await this.unlock();
    } catch (err) {
      this.deps.logger.warn('[input] unlock on dispose failed', err);
    }
  }
}
