/** `sdk.input`: bounded keyboard/mouse lock through the user's command templates. */
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandRunner } from './commands-runner.js';

export const INPUT_LOCK_MIN_MS = 1000;

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
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.input.${method}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
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
