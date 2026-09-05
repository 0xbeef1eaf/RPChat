import type { Json, RoutineEntry, RoutineStateName, RoutineStatus, Storage } from '@rp/shared';
import { RpError, parseCharacterRef } from '@rp/shared';
import type { Clock, Logger } from '../types.js';

export const ROUTINE_ENTRIES_KEY = 'routine.entries';
export const ROUTINE_OVERRIDE_KEY = 'routine.override';
export const ROUTINE_LAST_STATE_KEY = 'routine.lastState';
export const ROUTINE_MAX_ENTRIES = 48;
export const ROUTINE_STATES: readonly RoutineStateName[] = ['available', 'busy', 'away', 'asleep'];
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface RoutineOverride {
  state: RoutineStateName;
  label?: string;
  until: string;
}

export interface RoutineTransition {
  characterRef: string;
  from: RoutineStateName;
  to: RoutineStateName;
  status: RoutineStatus;
  /** The entry that became active (absent for overrides / defaults). */
  entry?: RoutineEntry;
}

export interface RoutineServiceOptions {
  storage: Pick<Storage, 'state'>;
  /** Characters whose routine is checked on every tick. */
  characterRefs: () => string[];
  now: Clock;
  logger: Logger;
}

function minutesOf(at: string): number {
  const m = TIME_RE.exec(at);
  if (!m) throw new RpError('INVALID_ARGUMENT', `routine time "${at}" must be HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Validate and normalise entries (sorted by time). */
export function normalizeEntries(input: unknown): RoutineEntry[] {
  if (!Array.isArray(input)) throw new RpError('INVALID_ARGUMENT', 'entries must be an array');
  if (input.length > ROUTINE_MAX_ENTRIES) throw new RpError('INVALID_ARGUMENT', `at most ${ROUTINE_MAX_ENTRIES} routine entries`);
  const out: RoutineEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpError('INVALID_ARGUMENT', 'each entry must be an object');
    const e = raw as Record<string, unknown>;
    if (typeof e.at !== 'string') throw new RpError('INVALID_ARGUMENT', 'entry.at must be HH:MM');
    minutesOf(e.at);
    if (!ROUTINE_STATES.includes(e.state as RoutineStateName)) throw new RpError('INVALID_ARGUMENT', `entry.state must be one of ${ROUTINE_STATES.join(', ')}`);
    const entry: RoutineEntry = { at: e.at, state: e.state as RoutineStateName };
    if (e.days !== undefined && e.days !== null) {
      if (!Array.isArray(e.days) || !e.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
        throw new RpError('INVALID_ARGUMENT', 'entry.days must be integers 0 (Sunday) .. 6');
      }
      entry.days = [...new Set(e.days as number[])].sort();
    }
    if (typeof e.label === 'string' && e.label.trim()) entry.label = e.label.trim().slice(0, 80);
    if (typeof e.wakePrompt === 'string' && e.wakePrompt.trim()) entry.wakePrompt = e.wakePrompt.trim().slice(0, 2000);
    out.push(entry);
  }
  return out.sort((a, b) => minutesOf(a.at) - minutesOf(b.at));
}

function appliesOn(entry: RoutineEntry, weekday: number): boolean {
  return !entry.days || entry.days.length === 0 || entry.days.includes(weekday);
}

/** Local-time Date for `entry.at` on the calendar day of `day`. */
function atOn(day: Date, entry: RoutineEntry): Date {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const mins = minutesOf(entry.at);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

/** Pure evaluation of a routine at `now` (local time). */
export function evaluateRoutine(entries: RoutineEntry[], override: RoutineOverride | undefined, now: Date): { status: RoutineStatus; entry?: RoutineEntry } {
  if (override && Date.parse(override.until) > now.getTime()) {
    const status: RoutineStatus = { state: override.state, until: override.until };
    if (override.label) status.label = override.label;
    const upcoming = nextEntry(entries, now);
    if (upcoming) status.next = upcoming.entry;
    return { status };
  }
  if (entries.length === 0) return { status: { state: 'available' } };

  // Latest entry at or before now, looking back up to a week for day-restricted entries.
  let current: { entry: RoutineEntry; at: Date } | undefined;
  for (let back = 0; back < 8 && !current; back++) {
    const day = new Date(now.getTime() - back * DAY_MS);
    const candidates = entries
      .filter((e) => appliesOn(e, day.getDay()))
      .map((entry) => ({ entry, at: atOn(day, entry) }))
      .filter((c) => c.at.getTime() <= now.getTime())
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    current = candidates[0];
  }
  const upcoming = nextEntry(entries, now);
  if (!current) {
    const status: RoutineStatus = { state: 'available' };
    if (upcoming) {
      status.next = upcoming.entry;
      status.until = upcoming.at.toISOString();
    }
    return { status };
  }
  const status: RoutineStatus = { state: current.entry.state, since: current.at.toISOString() };
  if (current.entry.label) status.label = current.entry.label;
  if (upcoming) {
    status.next = upcoming.entry;
    status.until = upcoming.at.toISOString();
  }
  return { status, entry: current.entry };
}

function nextEntry(entries: RoutineEntry[], now: Date): { entry: RoutineEntry; at: Date } | undefined {
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = new Date(now.getTime() + ahead * DAY_MS);
    const candidates = entries
      .filter((e) => appliesOn(e, day.getDay()))
      .map((entry) => ({ entry, at: atOn(day, entry) }))
      .filter((c) => c.at.getTime() > now.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    if (candidates[0]) return candidates[0];
  }
  return undefined;
}

/** Per-character daily routine: entries + temporary overrides in `char:<ref>` state, evaluated in local time. */
export class RoutineService {
  private readonly lastStates = new Map<string, RoutineStateName>();

  constructor(private readonly o: RoutineServiceOptions) {}

  async entries(characterRef: string): Promise<RoutineEntry[]> {
    parseCharacterRef(characterRef);
    const raw = await this.o.storage.state.get(`char:${characterRef}`, ROUTINE_ENTRIES_KEY);
    try {
      return Array.isArray(raw) ? normalizeEntries(raw) : [];
    } catch {
      return [];
    }
  }

  async setEntries(characterRef: string, entries: unknown): Promise<RoutineStatus> {
    parseCharacterRef(characterRef);
    const normalized = normalizeEntries(entries);
    await this.o.storage.state.set(`char:${characterRef}`, ROUTINE_ENTRIES_KEY, normalized as unknown as Json);
    return this.status(characterRef);
  }

  async override(characterRef: string, state: RoutineStateName, opts: { minutes?: number; label?: string } = {}): Promise<RoutineStatus> {
    parseCharacterRef(characterRef);
    if (!ROUTINE_STATES.includes(state)) throw new RpError('INVALID_ARGUMENT', `state must be one of ${ROUTINE_STATES.join(', ')}`);
    const minutes = opts.minutes === undefined ? 60 : opts.minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
      throw new RpError('INVALID_ARGUMENT', 'minutes must be between 1 and 10080');
    }
    const override: RoutineOverride = { state, until: new Date(this.o.now().getTime() + minutes * 60_000).toISOString() };
    if (typeof opts.label === 'string' && opts.label.trim()) override.label = opts.label.trim().slice(0, 80);
    await this.o.storage.state.set(`char:${characterRef}`, ROUTINE_OVERRIDE_KEY, override as unknown as Json);
    return this.status(characterRef);
  }

  async clearOverride(characterRef: string): Promise<void> {
    await this.o.storage.state.delete(`char:${characterRef}`, ROUTINE_OVERRIDE_KEY);
  }

  private async readOverride(characterRef: string): Promise<RoutineOverride | undefined> {
    const raw = await this.o.storage.state.get(`char:${characterRef}`, ROUTINE_OVERRIDE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Partial<RoutineOverride>;
    if (!ROUTINE_STATES.includes(o.state as RoutineStateName) || typeof o.until !== 'string') return undefined;
    const override: RoutineOverride = { state: o.state as RoutineStateName, until: o.until };
    if (typeof o.label === 'string') override.label = o.label;
    return override;
  }

  async evaluate(characterRef: string, now: Date = this.o.now()): Promise<{ status: RoutineStatus; entry?: RoutineEntry }> {
    parseCharacterRef(characterRef);
    return evaluateRoutine(await this.entries(characterRef), await this.readOverride(characterRef), now);
  }

  async status(characterRef: string, now: Date = this.o.now()): Promise<RoutineStatus> {
    return (await this.evaluate(characterRef, now)).status;
  }

  async state(characterRef: string, now: Date = this.o.now()): Promise<RoutineStateName> {
    try {
      return (await this.status(characterRef, now)).state;
    } catch {
      return 'available';
    }
  }

  /**
   * Compare every character's routine state with the last observed one; returns the transitions.
   * The first observation of a character is recorded silently (no transition).
   */
  async tick(now: Date = this.o.now()): Promise<RoutineTransition[]> {
    const transitions: RoutineTransition[] = [];
    for (const ref of this.o.characterRefs()) {
      try {
        const { status, entry } = await this.evaluate(ref, now);
        let previous = this.lastStates.get(ref);
        if (previous === undefined) {
          const stored = await this.o.storage.state.get(`char:${ref}`, ROUTINE_LAST_STATE_KEY);
          previous = ROUTINE_STATES.includes(stored as RoutineStateName) ? (stored as RoutineStateName) : undefined;
        }
        if (previous !== status.state) {
          this.lastStates.set(ref, status.state);
          await this.o.storage.state.set(`char:${ref}`, ROUTINE_LAST_STATE_KEY, status.state);
          if (previous !== undefined) {
            const transition: RoutineTransition = { characterRef: ref, from: previous, to: status.state, status };
            if (entry) transition.entry = entry;
            transitions.push(transition);
          }
        }
      } catch (err) {
        this.o.logger.warn(`[routine] tick failed for ${ref}`, err);
      }
    }
    return transitions;
  }

  /** Text for the `<routine>` prompt block. */
  static promptText(status: RoutineStatus): string {
    const parts = [`Current state: ${status.state}${status.label ? ` (${status.label})` : ''}`];
    if (status.since) parts.push(`since ${status.since}`);
    if (status.until) parts.push(`until ${status.until}`);
    if (status.next) parts.push(`next: ${status.next.state}${status.next.label ? ` (${status.next.label})` : ''} at ${status.next.at}`);
    return parts.join('; ');
  }
}
