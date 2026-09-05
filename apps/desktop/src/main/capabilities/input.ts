/** `sdk.input`: bounded keyboard/mouse lock through the user's command templates. */
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandRunner } from './commands-runner.js';

export const INPUT_LOCK_MIN_MS = 1000;
export const INPUT_TEXT_MAX = 2000;
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
}

export class InputHandler implements CapabilityHandler {
  readonly moduleId = 'input';
  private until: number | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: InputHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'lock':
        return this.lock(args[0], args[1]);
      case 'unlock':
        await this.unlock();
        return;
      case 'status':
        return this.status();
      case 'type': {
        if (typeof args[0] !== 'string' || args[0].length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
        if (args[0].length > INPUT_TEXT_MAX) throw new RpError('INVALID_ARGUMENT', `text is longer than ${INPUT_TEXT_MAX} characters`);
        await this.runInput('inputType', { text: args[0] }, 'input type');
        return;
      }
      case 'key': {
        if (typeof args[0] !== 'string' || !KEY_COMBO.test(args[0])) throw new RpError('INVALID_ARGUMENT', 'combo must look like "ctrl+shift+s"');
        await this.runInput('inputKey', { combo: args[0] }, 'input key');
        return;
      }
      case 'click': {
        const { x, y } = pointArgs(args[0], args[1]);
        const button = buttonArg(args[2]);
        await this.runInput('inputClick', { x: String(x), y: String(y), ...button }, 'input click');
        return;
      }
      case 'moveMouse': {
        const { x, y } = pointArgs(args[0], args[1]);
        await this.runInput('inputMove', { x: String(x), y: String(y) }, 'input move');
        return;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.input.${method}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async runInput(name: 'inputType' | 'inputKey' | 'inputClick' | 'inputMove', vars: Record<string, string>, what: string): Promise<void> {
    const result = await this.deps.commands.run(name, vars, what);
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `${what} command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  status(): { locked: boolean; until?: string } {
    if (this.until !== undefined && this.until > this.now()) return { locked: true, until: new Date(this.until).toISOString() };
    return { locked: false };
  }

  private async lock(durationArg: unknown, optionsArg: unknown): Promise<{ until: string; durationMs: number }> {
    if (typeof durationArg !== 'number' || !Number.isFinite(durationArg)) throw new RpError('INVALID_ARGUMENT', 'durationMs must be a number');
    const max = Math.max(INPUT_LOCK_MIN_MS, await this.deps.maxLockMs());
    const durationMs = Math.min(max, Math.max(INPUT_LOCK_MIN_MS, Math.round(durationArg)));
    const reason = optionsArg && typeof optionsArg === 'object' && typeof (optionsArg as { reason?: unknown }).reason === 'string' ? (optionsArg as { reason: string }).reason : '';
    const seconds = String(Math.ceil(durationMs / 1000));
    const result = await this.deps.commands.run('inputLock', { seconds, durationMs: String(durationMs), reason }, 'input lock');
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `Input lock command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.clearTimer();
    this.until = this.now() + durationMs;
    this.deps.logger.info(`[input] locked for ${durationMs} ms${reason ? ` (${reason})` : ''}`);
    this.timer = setTimeout(() => {
      void this.release('timer');
    }, durationMs);
    this.timer.unref?.();
    return { until: new Date(this.until).toISOString(), durationMs };
  }

  private async unlock(): Promise<void> {
    const wasLocked = this.status().locked;
    this.clearTimer();
    await this.release(wasLocked ? 'unlock' : 'idle');
  }

  private async release(why: string): Promise<void> {
    this.until = undefined;
    if (!(await this.deps.commands.isConfigured('inputUnlock'))) return;
    try {
      const result = await this.deps.commands.run('inputUnlock', {}, 'input unlock');
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
