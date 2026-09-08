/** `sdk.input`: bounded keyboard/mouse lock through the user's command templates. */
import type { ActionContext, CapabilityHandler, DaemonRequest, DaemonResponse, Json, LockDevices } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandRunner } from './commands-runner.js';
import { DaemonError } from '../system/daemon-client.js';
import type { DaemonClient } from '../system/daemon-client.js';

export const INPUT_LOCK_MIN_MS = 1000;
export const INPUT_TEXT_MAX = 2000;
type LockResponse = Extract<DaemonResponse, { op: 'lock' }>;
type StatusResponse = Extract<DaemonResponse, { op: 'status' }>;
const KEY_COMBO = /^[a-zA-Z0-9_+\-]{1,64}$/;
const BUTTONS: Record<string, { button: string; buttonNum: string; buttonHex: string }> = {
  left: { button: 'left', buttonNum: '1', buttonHex: '0xC0' },
  middle: { button: 'middle', buttonNum: '2', buttonHex: '0xC2' },
  right: { button: 'right', buttonNum: '3', buttonHex: '0xC1' },
};

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

export function buttonArg(v: unknown): { button: string; buttonNum: string; buttonHex: string } {
  const name = typeof v === 'string' ? v.toLowerCase() : 'left';
  const b = BUTTONS[name];
  if (!b) throw new RpError('INVALID_ARGUMENT', 'button must be left, right or middle');
  return b;
}

export interface InputHandlerDeps {
  commands: CommandRunner;
  maxLockMs(): Promise<number>;
  logger: Logger;
  now?: () => number;
  /** rp-coded client (Linux): used for every operation while it is reachable, templates otherwise. */
  daemon?: DaemonClient;
}

export class InputHandler implements CapabilityHandler {
  readonly moduleId = 'input';
  private until: number | undefined;
  private lockedDevices: LockDevices = 'both';
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: InputHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    const daemon = await this.daemonIfAvailable();
    switch (method) {
      case 'lock':
        return this.lock(args[0], args[1], daemon);
      case 'unlock':
        await this.unlock(daemon);
        return;
      case 'status':
        return daemon ? this.daemonStatus(daemon) : this.status();
      case 'type': {
        if (typeof args[0] !== 'string' || args[0].length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
        if (args[0].length > INPUT_TEXT_MAX) throw new RpError('INVALID_ARGUMENT', `text is longer than ${INPUT_TEXT_MAX} characters`);
        if (daemon) await this.viaDaemon(daemon, { op: 'type', text: args[0] });
        else await this.runInput('inputType', { text: args[0] }, 'input type');
        return;
      }
      case 'key': {
        if (typeof args[0] !== 'string' || !KEY_COMBO.test(args[0])) throw new RpError('INVALID_ARGUMENT', 'combo must look like "ctrl+shift+s"');
        if (daemon) await this.viaDaemon(daemon, { op: 'key', combo: args[0] });
        else await this.runInput('inputKey', { combo: args[0] }, 'input key');
        return;
      }
      case 'click': {
        const { x, y } = pointArgs(args[0], args[1]);
        const button = buttonArg(args[2]);
        if (daemon) await this.viaDaemon(daemon, { op: 'click', x, y, button: button.button as 'left' | 'right' | 'middle' });
        else await this.runInput('inputClick', { x: String(x), y: String(y), ...button }, 'input click');
        return;
      }
      case 'moveMouse': {
        const { x, y } = pointArgs(args[0], args[1]);
        if (daemon) await this.viaDaemon(daemon, { op: 'move', x, y });
        else await this.runInput('inputMove', { x: String(x), y: String(y) }, 'input move');
        return;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.input.${method}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async daemonIfAvailable(): Promise<DaemonClient | undefined> {
    const d = this.deps.daemon;
    if (!d) return undefined;
    return (await d.isAvailable()) ? d : undefined;
  }

  private async viaDaemon<R extends DaemonResponse>(daemon: DaemonClient, req: DaemonRequest): Promise<Extract<R, { ok: true }>> {
    try {
      return await daemon.request<R>(req);
    } catch (err) {
      if (err instanceof DaemonError) {
        const code = err.code === 'REFUSED' || err.code === 'POLICY' ? 'PERMISSION_DENIED' : err.code === 'INVALID' ? 'INVALID_ARGUMENT' : 'CAPABILITY_FAILED';
        throw new RpError(code, `rp-coded refused ${req.op}: ${err.message}`, { daemonCode: err.code });
      }
      throw err;
    }
  }

  private async daemonStatus(daemon: DaemonClient): Promise<{ locked: boolean; until?: string; devices?: LockDevices }> {
    const res = await this.viaDaemon<StatusResponse>(daemon, { op: 'status' });
    if (res.locked) return { locked: true, until: res.locked.until, devices: res.locked.devices ?? 'both' };
    return { locked: false };
  }

  private async runInput(name: 'inputType' | 'inputKey' | 'inputClick' | 'inputMove', vars: Record<string, string>, what: string): Promise<void> {
    const result = await this.deps.commands.run(name, vars, what);
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `${what} command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  status(): { locked: boolean; until?: string; devices?: LockDevices } {
    if (this.until !== undefined && this.until > this.now()) return { locked: true, until: new Date(this.until).toISOString(), devices: this.lockedDevices };
    return { locked: false };
  }

  private async lock(durationArg: unknown, optionsArg: unknown, daemon?: DaemonClient): Promise<{ until: string; durationMs: number; devices: LockDevices }> {
    if (typeof durationArg !== 'number' || !Number.isFinite(durationArg)) throw new RpError('INVALID_ARGUMENT', 'durationMs must be a number');
    const max = Math.max(INPUT_LOCK_MIN_MS, await this.deps.maxLockMs());
    const durationMs = Math.min(max, Math.max(INPUT_LOCK_MIN_MS, Math.round(durationArg)));
    const options = optionsArg && typeof optionsArg === 'object' ? (optionsArg as { reason?: unknown; devices?: unknown }) : {};
    const reason = typeof options.reason === 'string' ? options.reason : '';
    const devices = lockDevicesArg(options.devices);
    if (daemon) {
      // The daemon clamps again against the root-owned policy and unlocks by itself.
      const res = await this.viaDaemon<LockResponse>(daemon, { op: 'lock', durationMs, devices, ...(reason ? { reason } : {}) });
      this.clearTimer();
      this.until = new Date(res.until).getTime();
      this.lockedDevices = res.devices ?? devices;
      this.deps.logger.info(`[input] locked ${this.lockedDevices} via rp-coded for ${res.durationMs} ms${reason ? ` (${reason})` : ''}`);
      return { until: res.until, durationMs: res.durationMs, devices: this.lockedDevices };
    }
    const seconds = String(Math.ceil(durationMs / 1000));
    const result = await this.deps.commands.run('inputLock', { seconds, durationMs: String(durationMs), reason, devices }, 'input lock');
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `Input lock command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.clearTimer();
    this.until = this.now() + durationMs;
    this.lockedDevices = devices;
    this.deps.logger.info(`[input] locked ${devices} for ${durationMs} ms${reason ? ` (${reason})` : ''}`);
    this.timer = setTimeout(() => {
      void this.release('timer');
    }, durationMs);
    this.timer.unref?.();
    return { until: new Date(this.until).toISOString(), durationMs, devices };
  }

  private async unlock(daemon?: DaemonClient): Promise<void> {
    const wasLocked = this.status().locked;
    this.clearTimer();
    if (daemon) {
      this.until = undefined;
      await this.viaDaemon(daemon, { op: 'unlock' });
      return;
    }
    await this.release(wasLocked ? 'unlock' : 'idle');
  }

  private async release(why: string): Promise<void> {
    const devices = this.lockedDevices;
    this.until = undefined;
    if (!(await this.deps.commands.isConfigured('inputUnlock'))) return;
    try {
      const result = await this.deps.commands.run('inputUnlock', { devices }, 'input unlock');
      if (result.code !== 0) this.deps.logger.warn(`[input] unlock (${why}) exited with ${result.code}: ${result.stderr.trim()}`);
    } catch (err) {
      this.deps.logger.warn(`[input] unlock (${why}) failed`, err);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async dispose(): Promise<void> {
    if (this.status().locked) await this.unlock();
    this.clearTimer();
  }
}
