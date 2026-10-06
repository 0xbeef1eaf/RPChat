/**
 * What happens once an update has been downloaded (`UpdateStatus.state === 'ready'`).
 *
 * - `settings.updates.forceRestart` off (the default): the user is asked — `ask(status)`, which
 *   index.ts turns into the "Restart now / Later" dialog or a notification in tray mode.
 * - on (a user setting, or pinned by the policy's `settings.updates.forceRestart`): a countdown
 *   window announces the restart and the app restarts into the update when it runs out, after
 *   `settings.updates.restartCountdownSeconds`. "Restart now" in that window restarts at once;
 *   closing the window does not stop the countdown. What was on screen is saved on the way out
 *   and comes back after the restart (session-state.ts).
 *
 * Each downloaded version is announced once. Timers are injectable so the decisions are tested
 * without waiting.
 */
import type { AppSettings, RestartPromptPayload, UpdateStatus } from '@rp/shared';
import { clampRestartCountdown } from '@rp/shared';
import type { Logger } from '@rp/core';

export interface RestartCountdownDeps {
  updates: {
    subscribe(listener: (status: UpdateStatus) => void): () => void;
    install(): Promise<void>;
  };
  /** The effective settings (policy applied). */
  settings(): Promise<AppSettings>;
  /** Not forced: ask the user (dialog or notification). */
  ask(status: UpdateStatus): void;
  /** Show the countdown window; false when no window could be opened (the countdown runs anyway). */
  openWindow(payload: RestartPromptPayload): boolean;
  closeWindow(promptId: string): void;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Pure: the countdown window's payload for a downloaded version. */
export function restartPayload(status: Pick<UpdateStatus, 'latestVersion' | 'packaging'>, seconds: number, now: number): RestartPromptPayload {
  const version = status.latestVersion ?? '';
  return { kind: 'restart', promptId: `update-restart-${version}`, version, packaging: status.packaging, deadline: now + seconds * 1000 };
}

export class RestartCountdown {
  private announced: string | undefined;
  private timer: unknown;
  private active: RestartPromptPayload | undefined;
  private stopped = false;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: RestartCountdownDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Never keep the process alive just for the countdown.
        t.unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.unsubscribe = deps.updates.subscribe((status) => void this.onStatus(status));
  }

  /** The countdown in progress, if any. */
  get pending(): RestartPromptPayload | undefined {
    return this.active;
  }

  /** App shutting down: no restart from here on. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    this.cancel();
  }

  private async onStatus(status: UpdateStatus): Promise<void> {
    if (this.stopped || status.state !== 'ready' || !status.latestVersion || this.announced === status.latestVersion) return;
    this.announced = status.latestVersion;
    let forced = false;
    let seconds = 60;
    try {
      const settings = await this.deps.settings();
      forced = settings.updates.forceRestart === true;
      seconds = clampRestartCountdown(settings.updates.restartCountdownSeconds);
    } catch (err) {
      this.deps.logger.warn('[updates] could not read the restart settings; asking instead', err);
    }
    if (this.stopped) return;
    if (!forced) {
      this.deps.ask(status);
      return;
    }
    this.start(restartPayload(status, seconds, this.now()));
  }

  private start(payload: RestartPromptPayload): void {
    this.cancel();
    this.active = payload;
    const seconds = Math.round((payload.deadline - this.now()) / 1000);
    this.deps.logger.info(`[updates] ${payload.version} downloaded; restarting into it in ${seconds} s (updates.forceRestart)`);
    if (!this.deps.openWindow(payload)) this.deps.logger.warn('[updates] the restart countdown window could not be opened; restarting when the countdown ends anyway');
    this.timer = this.setTimer(() => void this.fire(payload), Math.max(0, payload.deadline - this.now()));
  }

  private async fire(payload: RestartPromptPayload): Promise<void> {
    if (this.stopped || this.active !== payload) return;
    this.timer = undefined;
    this.deps.logger.info(`[updates] restart countdown for ${payload.version} ended; restarting`);
    try {
      await this.deps.updates.install();
    } catch (err) {
      // Left `ready` with the error shown in Settings → Updates, where it can be retried.
      this.deps.logger.warn('[updates] forced restart failed', err);
      this.cancel();
    }
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.active) this.deps.closeWindow(this.active.promptId);
    this.active = undefined;
  }
}
