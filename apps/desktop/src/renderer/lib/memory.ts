import type { MemoryEntry, MemoryImportance } from '@rp/shared';

export const IMPORTANCE_LEVELS: MemoryImportance[] = [1, 2, 3, 4, 5];

export function clampImportance(n: number): MemoryImportance {
  const v = Math.round(n);
  return (v < 1 ? 1 : v > 5 ? 5 : v) as MemoryImportance;
}

/** Split free text into normalised, de-duplicated tags (comma/whitespace separated, lower-case). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const t = raw.trim().toLowerCase().replace(/^#/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Case-insensitive search over text and tags; every whitespace-separated term must match. */
export function filterMemories(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((e) => {
    const hay = `${e.text} ${e.tags.join(' ')}`.toLowerCase();
    return terms.every((t) => (t.startsWith('#') ? e.tags.includes(t.slice(1)) : hay.includes(t)));
  });
}

/** Importance desc, then most recently updated first. */
export function sortMemories(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.slice().sort((a, b) => b.importance - a.importance || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
