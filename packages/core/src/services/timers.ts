import type { ScheduledTimer, Storage } from '@rp/shared';
import type { Clock, Logger } from '../types.js';

export type TimerFireHandler = (timer: ScheduledTimer) => Promise<void>;

/** Longest delay a single `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Persistent timers. `schedule()` stores the timer and, once `start()` was
 * called, arms a real (unref'd) `setTimeout`. `fireDue(now)` fires everything
 * due at `now` synchronously-in-order for deterministic tests. Firing a timer
 * removes it from storage *before* the handler runs, so a handler may re-arm.
 */
export class TimerService {
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private started = false;
  private onFire: TimerFireHandler = async () => undefined;
  private firing: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: Storage,
    private readonly now: Clock,
    private readonly logger: Logger,
  ) {}

  /** Set what happens when a timer fires (wired by the Engine to the chat service). */
  setFireHandler(handler: TimerFireHandler): void {
    this.onFire = handler;
  }

  async list(filter: { sessionId?: string; characterRef?: string } = {}): Promise<ScheduledTimer[]> {
    const all = await this.storage.timers.list();
    return all
      .filter((t) => (filter.sessionId === undefined || t.sessionId === filter.sessionId) &&
        (filter.characterRef === undefined || t.characterRef === filter.characterRef))
      .sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0));
  }

  async get(id: string): Promise<ScheduledTimer | undefined> {
    return (await this.storage.timers.list()).find((t) => t.id === id);
  }

  async schedule(timer: ScheduledTimer): Promise<ScheduledTimer> {
    await this.storage.timers.upsert(timer);
    if (this.started) this.arm(timer);
    return timer;
  }

  /** `true` when the timer was pending and is now removed. */
  async cancel(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    this.disarm(id);
    await this.storage.timers.remove(id);
    return true;
  }

  async removeForSession(sessionId: string): Promise<void> {
    for (const t of await this.list({ sessionId })) {
      this.disarm(t.id);
      await this.storage.timers.remove(t.id);
    }
  }

  async removeForPack(packId: string): Promise<void> {
    for (const t of await this.storage.timers.list()) {
      if (t.characterRef.startsWith(`${packId}/`)) {
        this.disarm(t.id);
        await this.storage.timers.remove(t.id);
      }
    }
  }

  /** Arm every stored timer; overdue ones fire right away (in fireAt order). */
  async start(): Promise<void> {
    this.started = true;
    const timers = await this.list();
    const nowMs = this.now().getTime();
    for (const t of timers) {
      if (Date.parse(t.fireAt) <= nowMs) this.enqueueFire(t.id);
      else this.arm(t);
    }
  }

  /** Clear every armed timeout; nothing fires after this until `start()` again. */
  async stop(): Promise<void> {
    this.started = false;
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
    await this.firing.catch(() => undefined);
  }

  /** Fire every timer due at `at` (default: the injected clock), oldest first. Returns how many fired. */
  async fireDue(at: Date = this.now()): Promise<number> {
    const due = (await this.list()).filter((t) => Date.parse(t.fireAt) <= at.getTime());
    let count = 0;
    for (const t of due) {
      if (await this.fire(t.id)) count += 1;
    }
    return count;
  }

  /** Wait until every fire currently in flight has finished. */
  async idle(): Promise<void> {
    await this.firing.catch(() => undefined);
  }

  private arm(timer: ScheduledTimer): void {
    this.disarm(timer.id);
    const delay = Date.parse(timer.fireAt) - this.now().getTime();
    if (delay <= 0) {
      this.enqueueFire(timer.id);
      return;
    }
    const handle = setTimeout(() => {
      this.handles.delete(timer.id);
      if (Date.parse(timer.fireAt) - this.now().getTime() > 0) {
        // Long delay: re-arm for the remainder.
        this.arm(timer);
        return;
      }
      this.enqueueFire(timer.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    handle.unref?.();
    this.handles.set(timer.id, handle);
  }

  private disarm(id: string): void {
    const handle = this.handles.get(id);
    if (handle) {
      clearTimeout(handle);
      this.handles.delete(id);
    }
  }

  /** Serialise fires so two timers never run their handlers concurrently. */
  private enqueueFire(id: string): void {
    this.firing = this.firing.then(() => this.fire(id)).then(() => undefined, (err) => {
      this.logger.error('[timers] fire failed', err);
    });
  }

  private async fire(id: string): Promise<boolean> {
    const timer = await this.get(id);
    if (!timer) return false;
    this.disarm(id);
    await this.storage.timers.remove(id);
    try {
      await this.onFire(timer);
    } catch (err) {
      this.logger.error(`[timers] handler for timer ${id} failed`, err);
    }
    return true;
  }
}
