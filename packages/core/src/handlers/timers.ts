import { randomUUID } from 'node:crypto';
import type { ActionContext, CapabilityHandler, Json, ScheduledTimer } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import type { TimerService } from '../services/timers.js';
import type { Clock } from '../types.js';

export const TIMER_MIN_DELAY_MS = 1000;
export const TIMER_MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const TIMERS_PER_SESSION = 20;
const LABEL_MAX = 80;

export function timerInfo(timer: ScheduledTimer): Json {
  const info: Record<string, Json> = { id: timer.id, fireAt: timer.fireAt, payload: (timer.payload ?? null) as Json };
  if (timer.label !== undefined) info.label = timer.label;
  return info;
}

/** `sdk.timers`: schedule / cancel / list, persisted through `TimerService`. */
export class TimersHandler implements CapabilityHandler {
  readonly moduleId = 'timers';

  constructor(
    private readonly timers: TimerService,
    private readonly now: Clock,
  ) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'schedule': {
        const delay = args[0];
        if (typeof delay !== 'number' || !Number.isFinite(delay)) {
          throw new RpError('INVALID_ARGUMENT', 'delayMs must be a number');
        }
        if (delay < TIMER_MIN_DELAY_MS || delay > TIMER_MAX_DELAY_MS) {
          throw new RpError('INVALID_ARGUMENT', `delayMs must be between ${TIMER_MIN_DELAY_MS} and ${TIMER_MAX_DELAY_MS}`, {
            min: TIMER_MIN_DELAY_MS,
            max: TIMER_MAX_DELAY_MS,
          });
        }
        const payload = args.length > 1 ? args[1] : null;
        const opts = args[2];
        let label: string | undefined;
        if (opts !== undefined && opts !== null) {
          if (typeof opts !== 'object' || Array.isArray(opts)) throw new RpError('INVALID_ARGUMENT', 'opts must be an object');
          const raw = (opts as Record<string, Json>).label;
          if (raw !== undefined && raw !== null) {
            if (typeof raw !== 'string') throw new RpError('INVALID_ARGUMENT', 'opts.label must be a string');
            label = raw.trim().slice(0, LABEL_MAX);
          }
        }
        const pending = await this.timers.list({ sessionId: context.sessionId });
        if (pending.length >= TIMERS_PER_SESSION) {
          throw new RpError('INVALID_ARGUMENT', `this session already has ${TIMERS_PER_SESSION} pending timers; cancel one first`, {
            limit: TIMERS_PER_SESSION,
          });
        }
        const at = this.now();
        const timer: ScheduledTimer = {
          id: randomUUID(),
          sessionId: context.sessionId,
          characterRef: ref,
          fireAt: new Date(at.getTime() + Math.floor(delay)).toISOString(),
          payload: payload ?? null,
          createdAt: at.toISOString(),
        };
        if (label) timer.label = label;
        await this.timers.schedule(timer);
        return timerInfo(timer);
      }
      case 'cancel': {
        const id = args[0];
        if (typeof id !== 'string' || id.length === 0) throw new RpError('INVALID_ARGUMENT', 'id must be a string');
        const existing = await this.timers.get(id);
        if (!existing || existing.characterRef !== ref) return false;
        return this.timers.cancel(id);
      }
      case 'list':
        return (await this.timers.list({ characterRef: ref })).map(timerInfo);
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.timers.${method}`);
    }
  }
}
