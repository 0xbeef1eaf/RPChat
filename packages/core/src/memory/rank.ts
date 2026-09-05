import type { MemoryEntry } from '@rp/shared';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'from', 'into', 'over', 'under', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have',
  'has', 'had', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we',
  'our', 'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her', 'hers', 'not', 'no', 'yes', 'as', 'up', 'down',
  'out', 'just', 'very', 'really', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'there', 'here', 'what',
  'which', 'who', 'when', 'where', 'how', 'why', 'than', 'too', 'also', 'like', 'get', 'got', 'one', 'some', 'any',
]);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Lower-case word tokens without punctuation or stop-words, deduplicated. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const word = raw.trim();
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

/** |A ∩ B| / |A ∪ B|; 0 when both are empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ScoredMemory {
  entry: MemoryEntry;
  /** Full relevance score (match + importance + recency). */
  score: number;
  /** Query match only (tag hits + text overlap); 0 means the memory does not match the query at all. */
  match: number;
}

function withinDays(iso: string | undefined, nowMs: number, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t >= -60_000 && nowMs - t <= days * (SEVEN_DAYS_MS / 7);
}

/** Query match component: tag hits × 2 + Jaccard overlap of the text tokens with the query tokens. */
export function matchScore(entry: MemoryEntry, queryTokens: Set<string>): number {
  let score = 0;
  for (const tag of entry.tags) {
    if (queryTokens.has(tag.toLowerCase()) || [...tokenize(tag)].some((t) => queryTokens.has(t))) score += 2;
  }
  if (queryTokens.size > 0) score += jaccard(queryTokens, tokenize(entry.text));
  return score;
}

/**
 * Relevance of one memory for a query:
 * tag hits × 2 + text-token overlap (Jaccard) + importance × 0.15
 * + recency (created ≤ 7 days: +0.2; recalled ≤ 7 days: +0.1).
 */
export function scoreMemory(entry: MemoryEntry, queryTokens: Set<string>, now: Date): number {
  const nowMs = now.getTime();
  let score = matchScore(entry, queryTokens);
  score += entry.importance * 0.15;
  if (withinDays(entry.createdAt, nowMs, 7)) score += 0.2;
  if (withinDays(entry.lastRecalledAt, nowMs, 7)) score += 0.1;
  return score;
}

/** Rank entries for `query`, best first; ties broken by `updatedAt` desc. */
export function rankMemories(entries: MemoryEntry[], query: string, now: Date): ScoredMemory[] {
  const queryTokens = tokenize(query);
  return entries
    .map((entry) => ({ entry, score: scoreMemory(entry, queryTokens, now), match: matchScore(entry, queryTokens) }))
    .sort((a, b) => b.score - a.score || (a.entry.updatedAt < b.entry.updatedAt ? 1 : a.entry.updatedAt > b.entry.updatedAt ? -1 : 0));
}

/** Stable prompt order: importance desc, then createdAt asc. */
export function promptOrder(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.importance - a.importance || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
