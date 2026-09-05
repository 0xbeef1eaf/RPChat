import type { ActionContext, CapabilityHandler, EventSubscription, Json, RoutineStateName } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import type { EventService } from '../services/events.js';
import type { MoodService } from '../services/mood.js';
import type { RoutineService } from '../services/routine.js';

function objectArg(value: unknown, what: string): Record<string, Json> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new RpError('INVALID_ARGUMENT', `${what} must be an object`);
  return value as Record<string, Json>;
}

/** `EventSubscriptionInfo` as declared in the SDK preamble. */
export function subscriptionInfo(sub: EventSubscription): Json {
  const info: Record<string, Json> = { id: sub.id, event: sub.event, fired: sub.fired };
  if (sub.label !== undefined) info.label = sub.label;
  if (sub.once) info.once = true;
  return info;
}

/** `sdk.events`: on / off / list / emit. */
export class EventsHandler implements CapabilityHandler {
  readonly moduleId = 'events';

  constructor(private readonly events: EventService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'on': {
        const opts = objectArg(args[2], 'opts');
        const options: Parameters<EventService['on']>[3] = {};
        if (opts.filter !== undefined) options.filter = objectArg(opts.filter, 'opts.filter');
        if (opts.input !== undefined) options.input = opts.input;
        if (opts.once !== undefined) options.once = opts.once === true;
        if (typeof opts.label === 'string') options.label = opts.label;
        return subscriptionInfo(await this.events.on(context, args[0] as string, args[1] as string, options));
      }
      case 'off': {
        if (typeof args[0] !== 'string' || args[0].length === 0) throw new RpError('INVALID_ARGUMENT', 'id must be a non-empty string');
        return this.events.off(context, args[0]);
      }
      case 'list':
        return (await this.events.list(context.sessionId)).map(subscriptionInfo);
      case 'emit':
        await this.events.emitCustom(context, args[0] as string, args.length > 1 ? (args[1] as Json) : null);
        return;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.events.${method}`);
    }
  }
}

/** `sdk.mood`: get / nudge / set for the acting character. */
export class MoodHandler implements CapabilityHandler {
  readonly moduleId = 'mood';

  constructor(private readonly mood: MoodService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'get':
        return (await this.mood.get(ref)) as unknown as Json;
      case 'nudge': {
        const delta = objectArg(args[0], 'delta');
        const d: { mood?: number; energy?: number } = {};
        if (delta.mood !== undefined) d.mood = numberArg(delta.mood, 'delta.mood');
        if (delta.energy !== undefined) d.energy = numberArg(delta.energy, 'delta.energy');
        return (await this.mood.nudge(ref, d, args[1] as string, context.sessionId)) as unknown as Json;
      }
      case 'set': {
        const state = objectArg(args[0], 'state');
        const s: { mood?: number; energy?: number; tags?: string[] } = {};
        if (state.mood !== undefined) s.mood = numberArg(state.mood, 'state.mood');
        if (state.energy !== undefined) s.energy = numberArg(state.energy, 'state.energy');
        if (state.tags !== undefined) s.tags = state.tags as string[];
        return (await this.mood.set(ref, s, args[1] as string, context.sessionId)) as unknown as Json;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.mood.${method}`);
    }
  }
}

/** `sdk.routine`: set / get / now / override for the acting character. */
export class RoutineHandler implements CapabilityHandler {
  readonly moduleId = 'routine';

  constructor(private readonly routine: RoutineService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'set':
        return (await this.routine.setEntries(ref, args[0])) as unknown as Json;
      case 'get':
        return { entries: (await this.routine.entries(ref)) as unknown as Json, status: (await this.routine.status(ref)) as unknown as Json };
      case 'now':
        return (await this.routine.status(ref)) as unknown as Json;
      case 'override': {
        const opts = objectArg(args[1], 'opts');
        const o: { minutes?: number; label?: string } = {};
        if (opts.minutes !== undefined) o.minutes = numberArg(opts.minutes, 'opts.minutes');
        if (typeof opts.label === 'string') o.label = opts.label;
        return (await this.routine.override(ref, args[0] as RoutineStateName, o)) as unknown as Json;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.routine.${method}`);
    }
  }
}

function numberArg(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RpError('INVALID_ARGUMENT', `${what} must be a number`);
  return value;
}
