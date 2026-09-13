import { randomUUID } from 'node:crypto';
import type { ActionContext, EventName, EventSubscription, HostEvent, HostEventName, Json, Session, Storage } from '@rp/shared';
import { RpError, parseCharacterRef, serializeError } from '@rp/shared';
import type { BehaviourRunner } from '../behaviours.js';
import type { AuditService } from './audit.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';

export const HOST_EVENT_NAMES: readonly HostEventName[] = [
  'user-idle', 'user-back', 'window-changed', 'app-launched', 'file-added', 'battery-low', 'screen-locked',
  'screen-unlocked', 'song-changed', 'time', 'widget-message', 'avatar-clicked', 'routine-changed', 'browser-navigated',
];
export const SUBSCRIPTIONS_PER_SESSION = 30;
export const SUBSCRIPTION_CODE_MAX_BYTES = 16 * 1024;
export const EVENT_DEBOUNCE_MS = 2000;
/**
 * A subscription with no `filter.idleMs` fires as soon as the host says the
 * user is idle — that is what "run when they go idle" means, and the host's own
 * threshold (`settings.senses.idleThresholdMs`) is what the user configured.
 * The previous default of five minutes was above that threshold, so with the
 * host reporting the crossing only, such a subscription never fired at all.
 */
export const DEFAULT_IDLE_MS = 0;
export const DEFAULT_BATTERY_PERCENT = 20;
const CUSTOM_PREFIX = 'custom:';
const CUSTOM_NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface SubscribeOptions {
  filter?: Record<string, Json>;
  input?: Json;
  once?: boolean;
  label?: string;
}

export interface EventServiceOptions {
  storage: Pick<Storage, 'subscriptions' | 'sessions'>;
  packs: { tryGetLoaded(packId: string): unknown };
  behaviours: Pick<BehaviourRunner, 'runScript' | 'has' | 'run'>;
  audit: Pick<AuditService, 'record'>;
  emitter: EngineEmitter;
  now: Clock;
  logger: Logger;
  /** Serialise a run with the session's turns (the chat queue). */
  runExclusive: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  /** Called with the union of event names live subscriptions need (plus `time`). */
  setInterest?: (events: HostEventName[]) => void;
}

interface EdgeState {
  idle?: boolean;
  lowBattery?: boolean;
}

/** Events whose repeats an `onEvent` behaviour should not be run for again. */
const REPEATING_EVENTS: ReadonlySet<string> = new Set(['user-idle']);

export function isCustomEvent(name: string): boolean {
  return name.startsWith(CUSTOM_PREFIX) && CUSTOM_NAME_RE.test(name.slice(CUSTOM_PREFIX.length));
}

export function isKnownEvent(name: string): boolean {
  return (HOST_EVENT_NAMES as readonly string[]).includes(name) || isCustomEvent(name);
}

function includesCi(haystack: unknown, needle: unknown): boolean {
  return typeof haystack === 'string' && typeof needle === 'string' && haystack.toLowerCase().includes(needle.toLowerCase());
}

function field(data: Json, key: string): Json | undefined {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Json>)[key] : undefined;
}

/**
 * Pure filter match for non-edge events. Returns `true` when every filter key is satisfied.
 * Edge events (`user-idle`, `battery-low`) are handled by `EventService.matches` with per-subscription state.
 */
export function matchesFilter(event: string, data: Json, filter: Record<string, Json> | undefined): boolean {
  if (!filter) return true;
  for (const [key, wanted] of Object.entries(filter)) {
    if (wanted === undefined || wanted === null) continue;
    switch (`${event}:${key}`) {
      case 'time:hour':
      case 'time:minute':
      case 'time:weekday': {
        const actual = field(data, key);
        const list = Array.isArray(wanted) ? wanted : [wanted];
        if (!list.some((w) => Number(w) === Number(actual))) return false;
        break;
      }
      case 'window-changed:app':
      case 'app-launched:app':
        if (!includesCi(field(data, 'app'), wanted)) return false;
        break;
      case 'window-changed:title':
      case 'browser-navigated:title':
        if (!includesCi(field(data, 'title'), wanted)) return false;
        break;
      case 'browser-navigated:url':
        if (!includesCi(field(data, 'url'), wanted)) return false;
        break;
      case 'file-added:dir':
        if (!includesCi(field(data, 'dir'), wanted) && !includesCi(field(data, 'path'), wanted)) return false;
        break;
      case 'file-added:ext': {
        const name = field(data, 'name') ?? field(data, 'path');
        const ext = typeof wanted === 'string' ? wanted.replace(/^\./, '').toLowerCase() : '';
        if (typeof name !== 'string' || !name.toLowerCase().endsWith(`.${ext}`)) return false;
        break;
      }
      case 'widget-message:widgetId':
        if (field(data, 'widgetId') !== wanted) return false;
        break;
      case 'user-idle:idleMs':
      case 'battery-low:percent':
        break; // thresholds are evaluated with edge state
      default:
        if (JSON.stringify(field(data, key)) !== JSON.stringify(wanted)) return false;
    }
  }
  if (event === 'time' && filter.hour !== undefined && filter.hour !== null && (filter.minute === undefined || filter.minute === null)) {
    if (Number(field(data, 'minute')) !== 0) return false; // `minute` defaults to 0 when only `hour` is given
  }
  return true;
}

/** Event subscriptions (`sdk.events`), host-event routing, `time` / `custom:*` generation and `onEvent` behaviours. */
export class EventService {
  private readonly edges = new Map<string, EdgeState>();
  /** Repeating events an `onEvent` behaviour has already been run for (cleared when they end). */
  private readonly behaviourRanFor = new Set<string>();
  private readonly lastFired = new Map<string, number>();
  private readonly firing = new Set<string>();
  private lastTimeTick: string | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: EventServiceOptions) {}

  // ---- subscriptions ------------------------------------------------------

  async on(ctx: ActionContext, event: string, code: string, opts: SubscribeOptions = {}): Promise<EventSubscription> {
    if (typeof event !== 'string' || !isKnownEvent(event)) {
      throw new RpError('INVALID_ARGUMENT', `Unknown event "${String(event)}"`, { known: HOST_EVENT_NAMES });
    }
    if (typeof code !== 'string' || code.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'code must be a non-empty string');
    if (Buffer.byteLength(code, 'utf8') > SUBSCRIPTION_CODE_MAX_BYTES) {
      throw new RpError('INVALID_ARGUMENT', `code must be at most ${SUBSCRIPTION_CODE_MAX_BYTES} bytes`);
    }
    if (opts.filter !== undefined && (opts.filter === null || typeof opts.filter !== 'object' || Array.isArray(opts.filter))) {
      throw new RpError('INVALID_ARGUMENT', 'filter must be an object');
    }
    const existing = await this.o.storage.subscriptions.list(ctx.sessionId);
    if (existing.length >= SUBSCRIPTIONS_PER_SESSION) {
      throw new RpError('INVALID_ARGUMENT', `this session already has ${SUBSCRIPTIONS_PER_SESSION} event subscriptions; remove one first`, {
        limit: SUBSCRIPTIONS_PER_SESSION,
      });
    }
    const sub: EventSubscription = {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      characterRef: `${ctx.packId}/${ctx.characterId}`,
      event: event as EventName,
      code,
      createdAt: this.o.now().toISOString(),
      fired: 0,
    };
    if (opts.filter !== undefined) sub.filter = opts.filter;
    if (opts.input !== undefined) sub.input = opts.input;
    if (opts.once) sub.once = true;
    if (typeof opts.label === 'string' && opts.label.trim()) sub.label = opts.label.trim().slice(0, 80);
    await this.o.storage.subscriptions.upsert(sub);
    await this.updateInterest();
    return sub;
  }

  /** Remove one of the session's subscriptions. */
  async off(ctx: Pick<ActionContext, 'sessionId'>, id: string): Promise<boolean> {
    const sub = (await this.o.storage.subscriptions.list(ctx.sessionId)).find((s) => s.id === id);
    if (!sub) return false;
    return this.remove(id);
  }

  list(sessionId?: string): Promise<EventSubscription[]> {
    return this.o.storage.subscriptions.list(sessionId);
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.o.storage.subscriptions.list();
    if (!all.some((s) => s.id === id)) return false;
    await this.o.storage.subscriptions.remove(id);
    this.edges.delete(id);
    await this.updateInterest();
    return true;
  }

  async removeForSession(sessionId: string): Promise<void> {
    await this.o.storage.subscriptions.removeForSession(sessionId);
    await this.updateInterest();
  }

  /**
   * Event names the host should sample: every `HostEventName` when any session's character has an
   * `onEvent` behaviour (it reacts without subscribing), otherwise the union of live subscriptions
   * plus `time`.
   */
  async interest(): Promise<HostEventName[]> {
    if (await this.anyOnEventBehaviour()) return [...HOST_EVENT_NAMES];
    const names = new Set<HostEventName>(['time']);
    for (const s of await this.o.storage.subscriptions.list()) if (!isCustomEvent(s.event)) names.add(s.event as HostEventName);
    return [...names];
  }

  private async anyOnEventBehaviour(): Promise<boolean> {
    const seen = new Set<string>();
    for (const session of await this.o.storage.sessions.list()) {
      if (seen.has(session.characterRef)) continue;
      seen.add(session.characterRef);
      if (!this.o.packs.tryGetLoaded(parseCharacterRef(session.characterRef).packId)) continue;
      if (this.o.behaviours.has(session, 'onEvent')) return true;
    }
    return false;
  }

  async updateInterest(): Promise<void> {
    if (!this.o.setInterest) return;
    try {
      this.o.setInterest(await this.interest());
    } catch (err) {
      this.o.logger.warn('[events] setInterest failed', err);
    }
  }

  // ---- dispatch -------------------------------------------------------------

  /** A character raised `sdk.events.emit(name, data)`: only its own session's subscriptions see it. */
  async emitCustom(ctx: ActionContext, name: string, data: Json = null): Promise<void> {
    if (typeof name !== 'string' || !CUSTOM_NAME_RE.test(name)) throw new RpError('INVALID_ARGUMENT', 'event name must match [a-zA-Z0-9_.-]{1,64}');
    const event: HostEvent = { name: `${CUSTOM_PREFIX}${name}`, data, at: this.o.now().toISOString() };
    await this.dispatch(event, { sessionId: ctx.sessionId, runOnEvent: false });
  }

  /** A host event arrived (from `SensesProvider.subscribe` or `engine.hostEvents.emit`). Never throws. */
  handleHostEvent(event: HostEvent, scope: { sessionId?: string; characterRef?: string } = {}): Promise<void> {
    const task = this.inFlight.then(() => this.dispatch(event, { ...scope, runOnEvent: true })).catch((err) => {
      this.o.logger.warn(`[events] dispatch of ${event.name} failed`, err);
    });
    this.inFlight = task;
    return task;
  }

  /** Wait for in-flight dispatches. */
  async idle(): Promise<void> {
    await this.inFlight.catch(() => undefined);
  }

  /** Per-minute tick: emits a `time` event once per calendar minute. Returns `true` when it fired. */
  async tick(now: Date = this.o.now()): Promise<boolean> {
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (this.lastTimeTick === key) return false;
    this.lastTimeTick = key;
    await this.handleHostEvent({
      name: 'time',
      data: { hour: now.getHours(), minute: now.getMinutes(), weekday: now.getDay(), iso: now.toISOString() },
      at: now.toISOString(),
    });
    return true;
  }

  private async dispatch(event: HostEvent, scope: { sessionId?: string; characterRef?: string; runOnEvent: boolean }): Promise<void> {
    if (event.name === 'user-back') this.resetIdleEdges(); // the user is back: every idle edge may fire again
    let subs = await this.o.storage.subscriptions.list(scope.sessionId);
    if (scope.characterRef !== undefined) subs = subs.filter((s) => s.characterRef === scope.characterRef);
    if (event.name === 'user-back') this.behaviourRanFor.delete('user-idle');
    const bySession = new Map<string, EventSubscription[]>();
    for (const s of subs) {
      if (s.event !== event.name) continue;
      const list = bySession.get(s.sessionId) ?? [];
      list.push(s);
      bySession.set(s.sessionId, list);
    }

    const handledSessions = new Set<string>();
    for (const [sessionId, list] of bySession) {
      const session = await this.o.storage.sessions.get(sessionId);
      if (!session || !this.o.packs.tryGetLoaded(parseCharacterRef(session.characterRef).packId)) {
        for (const s of list) await this.o.storage.subscriptions.remove(s.id); // orphaned
        continue;
      }
      for (const sub of list) {
        if (!this.matches(sub, event)) continue;
        if (this.debounced(sub, event)) continue;
        handledSessions.add(sessionId);
        await this.fire(session, sub, event);
      }
    }

    if (!scope.runOnEvent || event.name === 'time') return;
    // `user-idle` repeats while the user stays away (so longer subscription
    // thresholds are reached); an onEvent behaviour only wants the first one.
    if (REPEATING_EVENTS.has(event.name)) {
      if (this.behaviourRanFor.has(event.name)) return;
      this.behaviourRanFor.add(event.name);
    }
    // onEvent behaviours: for each character with one, its most recent session, unless a subscription handled it there.
    const sessions = (await this.o.storage.sessions.list()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const seen = new Set<string>();
    for (const session of sessions) {
      if (scope.sessionId !== undefined && session.id !== scope.sessionId) continue;
      if (scope.characterRef !== undefined && session.characterRef !== scope.characterRef) continue;
      if (seen.has(session.characterRef)) continue;
      seen.add(session.characterRef);
      if (handledSessions.has(session.id)) continue;
      if (!this.o.packs.tryGetLoaded(parseCharacterRef(session.characterRef).packId)) continue;
      if (!this.o.behaviours.has(session, 'onEvent')) continue;
      await this.runOnEvent(session, event);
    }
  }

  /** Filter + edge evaluation for one subscription. */
  matches(sub: EventSubscription, event: HostEvent): boolean {
    const edge = this.edges.get(sub.id) ?? {};
    switch (event.name) {
      case 'user-idle': {
        const threshold = Number(sub.filter?.idleMs ?? DEFAULT_IDLE_MS);
        const idleMs = Number(field(event.data, 'idleMs'));
        if (!Number.isFinite(idleMs) || idleMs < threshold) return false;
        if (edge.idle) return false;
        this.edges.set(sub.id, { ...edge, idle: true });
        return matchesFilter(event.name, event.data, sub.filter);
      }
      case 'user-back':
        return matchesFilter(event.name, event.data, sub.filter);
      case 'battery-low': {
        const threshold = Number(sub.filter?.percent ?? DEFAULT_BATTERY_PERCENT);
        const percent = Number(field(event.data, 'percent'));
        if (!Number.isFinite(percent)) return false;
        if (percent >= threshold) {
          if (edge.lowBattery) this.edges.set(sub.id, { ...edge, lowBattery: false });
          return false;
        }
        if (edge.lowBattery) return false;
        this.edges.set(sub.id, { ...edge, lowBattery: true });
        return matchesFilter(event.name, event.data, sub.filter);
      }
      default:
        return matchesFilter(event.name, event.data, sub.filter);
    }
  }

  /** `user-back` ends the idle period for every subscription (the host event is global). */
  private resetIdleEdges(): void {
    for (const [id, edge] of this.edges) if (edge.idle) this.edges.set(id, { ...edge, idle: false });
  }

  private debounced(sub: EventSubscription, event: HostEvent): boolean {
    const key = `${sub.id}:${event.name}`;
    const nowMs = this.o.now().getTime();
    const last = this.lastFired.get(key);
    if (last !== undefined && nowMs - last < EVENT_DEBOUNCE_MS) return true;
    this.lastFired.set(key, nowMs);
    return false;
  }

  private async fire(session: Session, sub: EventSubscription, event: HostEvent): Promise<void> {
    if (this.firing.has(sub.id)) return;
    this.firing.add(sub.id);
    const { packId, characterId } = parseCharacterRef(session.characterRef);
    const started = this.o.now().getTime();
    const baseInput = sub.input && typeof sub.input === 'object' && !Array.isArray(sub.input) ? (sub.input as Record<string, Json>) : {};
    const input: Json = { ...baseInput, event: event.name, data: event.data };
    let error: import('@rp/shared').SerializedError | undefined;
    try {
      const result = await this.o.runExclusive(session.id, () =>
        this.o.behaviours.runScript(packId, characterId, session.id, sub.code, input, { kind: 'event', subscriptionId: sub.id, event: event.name }),
      );
      if (!result.ok) error = result.error;
    } catch (err) {
      error = serializeError(err);
    } finally {
      this.firing.delete(sub.id);
    }
    if (error) this.o.logger.warn(`[events] subscription ${sub.id} (${event.name}) failed: ${error.message}`);
    const entry: Parameters<AuditService['record']>[0] = {
      sessionId: session.id,
      characterRef: session.characterRef,
      module: 'events',
      method: 'fire',
      args: [event.name, sub.id, sub.label ?? null],
      outcome: error ? 'failed' : 'allowed',
      durationMs: this.o.now().getTime() - started,
    };
    if (error) entry.error = error;
    await this.o.audit.record(entry);

    const still = (await this.o.storage.subscriptions.list(session.id)).find((s) => s.id === sub.id);
    if (still) {
      if (sub.once) {
        await this.o.storage.subscriptions.remove(sub.id);
        this.edges.delete(sub.id);
        await this.updateInterest();
      } else {
        still.fired = (still.fired ?? 0) + 1;
        still.lastFiredAt = this.o.now().toISOString();
        await this.o.storage.subscriptions.upsert(still);
      }
    }
    this.o.emitter.emit('chat', { type: 'event-fired', sessionId: session.id, subscriptionId: sub.id, event: event.name });
  }

  private async runOnEvent(session: Session, event: HostEvent): Promise<void> {
    try {
      await this.o.runExclusive(session.id, () => this.o.behaviours.run(session, 'onEvent', { event: event.name, data: event.data }));
    } catch (err) {
      this.o.logger.warn(`[events] onEvent behaviour failed in session ${session.id}`, err);
    }
  }
}
