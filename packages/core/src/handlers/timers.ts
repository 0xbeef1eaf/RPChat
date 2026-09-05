import type { ActionContext, CapabilityHandler, Json, ScheduledTimer } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import type { RunLaterOptions, TimerService } from '../services/timers.js';

export { TIMER_MAX_DELAY_MS, TIMER_MIN_DELAY_MS } from '../services/timers.js';

/** The `TimerInfo` shape declared in the SDK preamble. */
export function timerInfo(timer: ScheduledTimer): Json {
  const info: Record<string, Json> = { id: timer.id, kind: timer.kind, fireAt: timer.fireAt, payload: (timer.payload ?? null) as Json };
  if (timer.label !== undefined) info.label = timer.label;
  if (timer.repeat) {
    const repeat: Record<string, Json> = { everyMs: timer.repeat.everyMs };
    if (timer.repeat.remaining !== undefined) repeat.remaining = timer.repeat.remaining;
    info.repeat = repeat;
  }
  return info;
}

function optionsArg(value: unknown): Record<string, Json> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new RpError('INVALID_ARGUMENT', 'opts must be an object');
  return value as Record<string, Json>;
}

function optionalNumber(value: Json | undefined, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new RpError('INVALID_ARGUMENT', `${name} must be a number`);
  return value;
}

function optionalString(value: Json | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpError('INVALID_ARGUMENT', `${name} must be a string`);
  return value;
}

/** `sdk.timers`: schedule / runLater / cancel / list, persisted through `TimerService`. */
export class TimersHandler implements CapabilityHandler {
  readonly moduleId = 'timers';

  constructor(private readonly timers: TimerService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'schedule': {
        const opts = optionsArg(args[2]);
        const wakeOpts: { label?: string } = {};
        const label = optionalString(opts.label, 'opts.label');
        if (label !== undefined) wakeOpts.label = label;
        return timerInfo(await this.timers.scheduleWake(context, args[0] as number, (args.length > 1 ? args[1] : null) as Json, wakeOpts));
      }
      case 'runLater': {
        const opts = optionsArg(args[2]);
        const runOpts: RunLaterOptions = {};
        if (opts.input !== undefined) runOpts.input = opts.input;
        const label = optionalString(opts.label, 'opts.label');
        if (label !== undefined) runOpts.label = label;
        const every = optionalNumber(opts.repeatEveryMs, 'opts.repeatEveryMs');
        if (every !== undefined) runOpts.repeatEveryMs = every;
        const maxRuns = optionalNumber(opts.maxRuns, 'opts.maxRuns');
        if (maxRuns !== undefined) runOpts.maxRuns = maxRuns;
        return timerInfo(await this.timers.runLater(context, args[0] as number, args[1] as string, runOpts));
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
