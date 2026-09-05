import type { MoodState, RoutineStatus } from '@rp/shared';

const MOOD_WORDS = ['miserable', 'low', 'even', 'good', 'elated'] as const;
const ENERGY_WORDS = ['exhausted', 'tired', 'steady', 'lively', 'energised'] as const;

function bucket(value: number, min: number, max: number): 0 | 1 | 2 | 3 | 4 {
  const v = Math.min(max, Math.max(min, Number.isFinite(value) ? value : (min + max) / 2));
  const t = (v - min) / (max - min);
  return Math.min(4, Math.floor(t * 5)) as 0 | 1 | 2 | 3 | 4;
}

/** -1..1 → one of five words. */
export function moodWord(mood: number): string {
  return MOOD_WORDS[bucket(mood, -1, 1)];
}

/** 0..1 → one of five words. */
export function energyWord(energy: number): string {
  return ENERGY_WORDS[bucket(energy, 0, 1)];
}

/** Emoji-free glyph for the mood so the header stays compact. */
export function moodGlyph(mood: number): string {
  return ['☹', '🙁', '😐', '🙂', '😄'][bucket(mood, -1, 1)]!;
}

export function describeMood(m: MoodState): string {
  const tags = m.tags.length ? ` · ${m.tags.slice(0, 3).join(', ')}` : '';
  return `${moodWord(m.mood)} (${m.mood.toFixed(2)}), energy ${energyWord(m.energy)} (${m.energy.toFixed(2)})${tags}`;
}

export function describeRoutine(r: RoutineStatus): string {
  const parts = [r.label ? `${r.state} — ${r.label}` : r.state];
  if (r.until) {
    const t = new Date(r.until);
    if (!Number.isNaN(t.getTime())) parts.push(`until ${t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
  }
  if (r.next) parts.push(`next: ${r.next.state} at ${r.next.at}`);
  return parts.join(' · ');
}
