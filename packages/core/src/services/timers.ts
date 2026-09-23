import { randomUUID } from 'node:crypto';
import type { ActionContext, Json, ScheduledTimer, Storage, TimerKind } from '@rp/shared';
import { DEFAULT_SETTINGS, RpError, characterRef } from '@rp/shared';
import type { Clock, Logger } from '../types.js';
import { KeyedQueue } from '../keyed-queue.js';

export type TimerFireHandler = (timer: ScheduledTimer) => Promise<void>;

/** Longest delay a single `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const TIMER_MIN_DELAY_MS = 1000;
export const TIMER_MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const TIMER_CODE_MAX_BYTES = 16 * 1024;
export const TIMER_LABEL_MAX = 80;
export const TIMER_PROMPT_MAX = 2000;

export interface TimerLimits {
  maxTimersPerSession: number;
  minRepeatIntervalMs: number;
  /** Floor for every delay; lower values are raised to it (see `validateDelay`). */
  minDelayMs?: number;
}

export interface RunLaterOptions {
  input?: Json;
  label?: string;
  repeatEveryMs?: number;
  maxRuns?: number;
}

/**
 * A usable delay: must be a finite non-negative number no larger than 7 days. Values below the
 * configured minimum (`minDelayMs`, default 30 s; never below 1 s) are raised to it rather than
 * rejected — characters routinely ask for a few seconds, and an error there only costs a round.
 */
export function validateDelay(delayMs: unknown, minDelayMs: number = TIMER_MIN_DELAY_MS): number {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) throw new RpError('INVALID_ARGUMENT', 'delayMs must be a non-negative number');
  if (delayMs > TIMER_MAX_DELAY_MS) {
    throw new RpError('INVALID_ARGUMENT', `delayMs must be at most ${TIMER_MAX_DELAY_MS} (7 days)`, { max: TIMER_MAX_DELAY_MS });
  }
  const floor = Math.max(TIMER_MIN_DELAY_MS, Number.isFinite(minDelayMs) ? Math.floor(minDelayMs) : TIMER_MIN_DELAY_MS);
  return Math.max(floor, Math.floor(delayMs));
}

/** The delay floor from the limits (settings), never below the hard minimum. */
export function minDelayOf(limits: Pick<TimerLimits, 'minDelayMs'>): number {
  return Math.max(TIMER_MIN_DELAY_MS, limits.minDelayMs ?? DEFAULT_SETTINGS.autonomy.minDelayMs);
}

export function validateLabel(label: unknown): string | undefined {
  if (label === undefined || label === null) return undefined;
  if (typeof label !== 'string') throw new RpError('INVALID_ARGUMENT', 'label must be a string');
  const trimmed = label.trim().slice(0, TIMER_LABEL_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Stored timers written before `kind` existed are plain wake timers. */
export function normalizeTimer(timer: ScheduledTimer): ScheduledTimer {
  const kind: TimerKind = timer.kind === 'code' || timer.kind === 'prompt' ? timer.kind : 'wake';
  return timer.kind === kind ? timer : { ...timer, kind };
}

/**
 * Persistent timers of three kinds: `wake` (payload → onTimer behaviour or LLM turn),
 * `code` (stored action body runs later, optionally repeating) and `prompt`
 * (self-authored prompt → `ChatService.selfWake`). `schedule()` stores a timer and,
 * once `start()` was called, arms a real (unref'd) `setTimeout`. `fireDue(now)` fires
 * everything due for deterministic tests. Firing removes the timer from storage
 * *before* the handler runs; repeating timers are re-armed afterwards.
 *
 * Fires are serialised **per timer**, not globally: a repeating timer never overlaps itself and is
 * re-armed only once its run is done, while two different timers — in the same session or not —
 * fire alongside each other. A `wake` timer that ends in a long LLM turn therefore no longer keeps
 * every other timer in the app waiting for it.
 */
export class TimerService {
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private started = false;
  private onFire: TimerFireHandler = async () => undefined;
  private readonly firing = new KeyedQueue();

  constructor(
    private readonly storage: Storage,
    private readonly now: Clock,
    private readonly logger: Logger,
    private readonly limits: () => Promise<TimerLimits> = async () => DEFAULT_SETTINGS.autonomy,
  ) {}

  /** Set what happens when a timer fires (wired by the Engine to the chat service). */
  setFireHandler(handler: TimerFireHandler): void {
    this.onFire = handler;
  }

  async list(filter: { sessionId?: string; characterRef?: string } = {}): Promise<ScheduledTimer[]> {
    const all = await this.storage.timers.list();
    return all
      .map(normalizeTimer)
      .filter((t) => (filter.sessionId === undefined || t.sessionId === filter.sessionId) &&
        (filter.characterRef === undefined || t.characterRef === filter.characterRef))
      .sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0));
  }

  async get(id: string): Promise<ScheduledTimer | undefined> {
    const found = (await this.storage.timers.list()).find((t) => t.id === id);
    return found ? normalizeTimer(found) : undefined;
  }

  /** Store (and arm) a fully built timer. Use `scheduleWake`/`runLater`/`schedulePrompt` for validated creation. */
  async schedule(timer: ScheduledTimer): Promise<ScheduledTimer> {
    const normalized = normalizeTimer(timer);
    await this.storage.timers.upsert(normalized);
    if (this.started) this.arm(normalized);
    return normalized;
  }

  /** `wake` timer: the character is woken with `payload` (onTimer behaviour or an LLM turn). */
  async scheduleWake(ctx: ActionContext, delayMs: number, payload: Json, opts: { label?: string } = {}): Promise<ScheduledTimer> {
    const delay = validateDelay(delayMs, minDelayOf(await this.limits()));
    const label = validateLabel(opts.label);
    await this.assertCapacity(ctx.sessionId);
    const timer = this.base(ctx, delay, 'wake', payload ?? null);
    if (label) timer.label = label;
    return this.schedule(timer);
  }

  /** `code` timer: `code` runs later with `input` in scope, without an LLM turn; optionally repeating. */
  async runLater(ctx: ActionContext, delayMs: number, code: string, opts: RunLaterOptions = {}): Promise<ScheduledTimer> {
    const delay = validateDelay(delayMs, minDelayOf(await this.limits()));
    if (typeof code !== 'string' || code.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'code must be a non-empty string');
    if (Buffer.byteLength(code, 'utf8') > TIMER_CODE_MAX_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `code must be at most ${TIMER_CODE_MAX_BYTES} bytes`, { limit: TIMER_CODE_MAX_BYTES });
    }
    const label = validateLabel(opts.label);
    const limits = await this.limits();
    let repeat: ScheduledTimer['repeat'] | undefined;
    if (opts.repeatEveryMs !== undefined && opts.repeatEveryMs !== null) {
      const every = opts.repeatEveryMs;
      if (typeof every !== 'number' || !Number.isFinite(every) || every < limits.minRepeatIntervalMs || every > TIMER_MAX_DELAY_MS) {
        throw new RpError('INVALID_ARGUMENT', `repeatEveryMs must be between ${limits.minRepeatIntervalMs} and ${TIMER_MAX_DELAY_MS}`, {
          min: limits.minRepeatIntervalMs,
          max: TIMER_MAX_DELAY_MS,
        });
      }
      repeat = { everyMs: Math.floor(every) };
      if (opts.maxRuns !== undefined && opts.maxRuns !== null) {
        if (typeof opts.maxRuns !== 'number' || !Number.isFinite(opts.maxRuns) || opts.maxRuns < 1) {
          throw new RpError('INVALID_ARGUMENT', 'maxRuns must be a positive number');
        }
        repeat.remaining = Math.floor(opts.maxRuns) - 1;
      }
    } else if (opts.maxRuns !== undefined && opts.maxRuns !== null) {
      throw new RpError('INVALID_ARGUMENT', 'maxRuns requires repeatEveryMs');
    }
    await this.assertCapacity(ctx.sessionId, limits);
    const timer = this.base(ctx, delay, 'code', null);
    timer.code = code;
    if (opts.input !== undefined) timer.input = opts.input;
    if (label) timer.label = label;
    if (repeat) timer.repeat = repeat;
    timer.runs = 0;
    return this.schedule(timer);
  }

  /** `prompt` timer: the character wakes itself with `prompt` (subject to the autonomy limits). */
  async schedulePrompt(ctx: ActionContext, delayMs: number, prompt: string, label?: string): Promise<ScheduledTimer> {
    const delay = validateDelay(delayMs, minDelayOf(await this.limits()));
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (text.length === 0) throw new RpError('INVALID_ARGUMENT', 'prompt must be a non-empty string');
    if (text.length > TIMER_PROMPT_MAX) throw new RpError('INVALID_ARGUMENT', `prompt must be at most ${TIMER_PROMPT_MAX} characters`);
    const lbl = validateLabel(label);
    await this.assertCapacity(ctx.sessionId);
    const timer = this.base(ctx, delay, 'prompt', null);
    timer.prompt = text;
    if (lbl) timer.label = lbl;
    return this.schedule(timer);
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
    await this.firing.idle();
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
    await this.firing.idle();
  }

  // ---- internals ----------------------------------------------------------

  private base(ctx: ActionContext, delay: number, kind: TimerKind, payload: Json): ScheduledTimer {
    const at = this.now();
    return {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      characterRef: characterRef(ctx.packId, ctx.characterId),
      kind,
      fireAt: new Date(at.getTime() + delay).toISOString(),
      payload,
      createdAt: at.toISOString(),
    };
  }

  private async assertCapacity(sessionId: string, limits?: TimerLimits): Promise<void> {
    const max = (limits ?? (await this.limits())).maxTimersPerSession;
    const pending = await this.list({ sessionId });
    if (pending.length >= max) {
      throw new RpError('INVALID_ARGUMENT', `this session already has ${max} pending timers; cancel one first`, { limit: max });
    }
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
        this.arm(timer); // long delay: re-arm for the remainder
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

  /** Serialise a timer's own fires so it never overlaps itself; other timers are unaffected. */
  private enqueueFire(id: string): void {
    void this.firing.run(id, () => this.fire(id)).then(
      () => undefined,
      (err) => this.logger.error('[timers] fire failed', err),
    );
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
    await this.reschedule(timer);
    return true;
  }

  /** Re-arm a repeating timer after a run (unless it was cancelled meanwhile or its runs are used up). */
  private async reschedule(timer: ScheduledTimer): Promise<void> {
    const repeat = timer.repeat;
    if (!repeat || (repeat.remaining !== undefined && repeat.remaining <= 0)) return;
    const nowMs = this.now().getTime();
    let nextAt = Date.parse(timer.fireAt) + repeat.everyMs;
    if (nextAt <= nowMs) nextAt = nowMs + repeat.everyMs;
    const next: ScheduledTimer = {
      ...timer,
      fireAt: new Date(nextAt).toISOString(),
      runs: (timer.runs ?? 0) + 1,
      repeat: repeat.remaining === undefined ? { everyMs: repeat.everyMs } : { everyMs: repeat.everyMs, remaining: repeat.remaining - 1 },
    };
    await this.schedule(next);
  }
}
