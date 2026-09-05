import type { LoadedCharacter, MoodState, RoutineStateName, Storage } from '@rp/shared';
import { RpError, parseCharacterRef } from '@rp/shared';
import type { Clock, EngineEmitter } from '../types.js';

export const MOOD_STATE_KEY = 'mood';
export const MOOD_DEFAULT_BASELINE = 0.2;
export const ENERGY_DEFAULT_BASELINE = 0.7;
export const MOOD_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
export const ENERGY_HALF_LIFE_MS = 3 * 60 * 60 * 1000;
export const MOOD_MAX_DELTA = 0.5;
export const MOOD_RECENT_MAX = 5;
export const MOOD_TAGS_MAX = 8;

/** How the routine state scales the energy baseline. */
export const ROUTINE_ENERGY_FACTOR: Record<RoutineStateName, number> = { asleep: 0.2, away: 0.6, busy: 0.8, available: 1 };

export interface MoodServiceOptions {
  storage: Pick<Storage, 'state'>;
  packs: { getCharacter(ref: string): { character: LoadedCharacter } };
  /** Current routine state of a character (scales the energy baseline). */
  routineState: (characterRef: string, now: Date) => Promise<RoutineStateName>;
  emitter: EngineEmitter;
  now: Clock;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v * 1000) / 1000;

export function moodWord(mood: number): string {
  if (mood <= -0.6) return 'miserable';
  if (mood <= -0.2) return 'low';
  if (mood < 0.2) return 'neutral';
  if (mood < 0.6) return 'content';
  return 'elated';
}

export function energyWord(energy: number): string {
  if (energy < 0.2) return 'exhausted';
  if (energy < 0.4) return 'tired';
  if (energy < 0.6) return 'steady';
  if (energy < 0.8) return 'lively';
  return 'energised';
}

/** One line for the `<mood>` prompt block. */
export function moodPromptText(state: MoodState): string {
  const parts = [`Mood: ${moodWord(state.mood)} (${state.mood.toFixed(2)}), energy: ${energyWord(state.energy)}`];
  if (state.tags.length > 0) parts.push(`tags: ${state.tags.join(', ')}`);
  if (state.recent.length > 0) parts.push(`recent: ${state.recent.map((r) => r.reason).join('; ')}`);
  return parts.join('; ');
}

/** Exponential decay of `value` toward `baseline` with the given half-life. */
export function decayToward(value: number, baseline: number, elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0 || !Number.isFinite(elapsedMs)) return value;
  return baseline + (value - baseline) * Math.pow(0.5, elapsedMs / halfLifeMs);
}

/**
 * Per-character mood and energy. Stored under `char:<ref>` / `mood`; every read applies decay toward
 * the character's baseline (energy baseline scaled by the routine state). Writes emit `mood-changed`.
 */
export class MoodService {
  constructor(private readonly o: MoodServiceOptions) {}

  /** The character's configured baselines (`character.json` → `mood`). */
  baselines(characterRef: string): { mood: number; energy: number } {
    let character: LoadedCharacter | undefined;
    try {
      character = this.o.packs.getCharacter(characterRef).character;
    } catch {
      character = undefined;
    }
    const cfg = character?.definition.mood;
    return {
      mood: clamp(typeof cfg?.baseline === 'number' ? cfg.baseline : MOOD_DEFAULT_BASELINE, -1, 1),
      energy: clamp(typeof cfg?.energyBaseline === 'number' ? cfg.energyBaseline : ENERGY_DEFAULT_BASELINE, 0, 1),
    };
  }

  /** Current state with decay applied (not persisted). */
  async get(characterRef: string, now: Date = this.o.now()): Promise<MoodState> {
    parseCharacterRef(characterRef);
    const base = this.baselines(characterRef);
    const routine = await this.o.routineState(characterRef, now);
    const energyBaseline = base.energy * ROUTINE_ENERGY_FACTOR[routine];
    const stored = await this.o.storage.state.get(`char:${characterRef}`, MOOD_STATE_KEY);
    const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Partial<MoodState>) : undefined;
    if (!raw) {
      return { mood: round(base.mood), energy: round(energyBaseline), tags: [], updatedAt: now.toISOString(), recent: [] };
    }
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now.toISOString();
    const elapsed = now.getTime() - Date.parse(updatedAt);
    const mood = typeof raw.mood === 'number' ? raw.mood : base.mood;
    const energy = typeof raw.energy === 'number' ? raw.energy : energyBaseline;
    return {
      mood: round(clamp(decayToward(mood, base.mood, elapsed, MOOD_HALF_LIFE_MS), -1, 1)),
      energy: round(clamp(decayToward(energy, energyBaseline, elapsed, ENERGY_HALF_LIFE_MS), 0, 1)),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
      updatedAt,
      recent: Array.isArray(raw.recent) ? raw.recent : [],
    };
  }

  /** Shift mood/energy by clamped deltas (±0.5) and record the reason. */
  async nudge(characterRef: string, delta: { mood?: number; energy?: number }, reason: string, sessionId?: string): Promise<MoodState> {
    const current = await this.get(characterRef);
    const dm = clamp(numberOr(delta.mood, 0), -MOOD_MAX_DELTA, MOOD_MAX_DELTA);
    const de = clamp(numberOr(delta.energy, 0), -MOOD_MAX_DELTA, MOOD_MAX_DELTA);
    return this.write(characterRef, { mood: current.mood + dm, energy: current.energy + de, tags: current.tags }, current, requireReason(reason), sessionId, {
      ...(delta.mood !== undefined ? { mood: dm } : {}),
      ...(delta.energy !== undefined ? { energy: de } : {}),
    });
  }

  /** Set absolute mood/energy/tags (omitted fields keep their current value). */
  async set(characterRef: string, state: { mood?: number; energy?: number; tags?: string[] }, reason: string, sessionId?: string): Promise<MoodState> {
    const current = await this.get(characterRef);
    const next = {
      mood: state.mood !== undefined ? numberOr(state.mood, current.mood) : current.mood,
      energy: state.energy !== undefined ? numberOr(state.energy, current.energy) : current.energy,
      tags: state.tags !== undefined ? normalizeTags(state.tags) : current.tags,
    };
    const change: { mood?: number; energy?: number } = {};
    if (state.mood !== undefined) change.mood = round(next.mood - current.mood);
    if (state.energy !== undefined) change.energy = round(next.energy - current.energy);
    return this.write(characterRef, next, current, requireReason(reason), sessionId, change);
  }

  private async write(
    characterRef: string,
    next: { mood: number; energy: number; tags: string[] },
    previous: MoodState,
    reason: string,
    sessionId: string | undefined,
    change: { mood?: number; energy?: number },
  ): Promise<MoodState> {
    const at = this.o.now().toISOString();
    const entry: MoodState['recent'][number] = { at, reason };
    if (change.mood !== undefined) entry.mood = change.mood;
    if (change.energy !== undefined) entry.energy = change.energy;
    const state: MoodState = {
      mood: round(clamp(next.mood, -1, 1)),
      energy: round(clamp(next.energy, 0, 1)),
      tags: next.tags.slice(0, MOOD_TAGS_MAX),
      updatedAt: at,
      recent: [entry, ...previous.recent].slice(0, MOOD_RECENT_MAX),
    };
    await this.o.storage.state.set(`char:${characterRef}`, MOOD_STATE_KEY, state as unknown as import('@rp/shared').Json);
    this.o.emitter.emit('chat', { type: 'mood-changed', sessionId: sessionId ?? '', mood: state });
    return state;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'reason must be a non-empty string');
  return reason.trim().slice(0, 200);
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new RpError('INVALID_ARGUMENT', 'tags must be an array of strings');
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase().slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, MOOD_TAGS_MAX);
}
