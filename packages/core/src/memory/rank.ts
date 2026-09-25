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

/**
 * What a full-strength semantic hit adds to a memory's score — one and a half tag hits.
 *
 * Deliberately not dominant: an embedding knows what a memory is *about*, while a tag is what the
 * character (or the user) decided it is *for*, and the second is the better signal when the two
 * disagree.
 */
export const SEMANTIC_WEIGHT = 3;

/** Standard score at which a memory starts earning a semantic boost, and where it earns all of it. */
export const SEMANTIC_MATCH_Z = 1;
export const SEMANTIC_FULL_Z = 3;

/** Below this many memories there is no distribution to speak of and similarities are ignored. */
export const SEMANTIC_MIN_POOL = 4;

export interface RankContext {
  /** Cosine similarity of each memory to the query, keyed by memory id (`EmbeddingService.similarities`). */
  similarities?: ReadonlyMap<string, number>;
  /** Weight of a full-strength semantic hit. Default {@link SEMANTIC_WEIGHT}. */
  semanticWeight?: number;
}

/**
 * How far above the pool's own mean each similarity sits, in standard deviations.
 *
 * Absolute cosines cannot be compared across embedding models: two unrelated sentences score about
 * 0.1 apart under OpenAI's models and about 0.65 under the BGE family, so any fixed "relevant
 * above X" threshold is wrong for one of them. The *shape* of the distribution does travel — a
 * memory that matters stands out from the character's other memories — so relevance is measured
 * against this character's own baseline instead of a constant.
 *
 * Empty when the pool is too small or the similarities are all but identical (nothing stands out).
 * Note that a sample of `n` values can reach at most `(n - 1) / √n` standard deviations, so small
 * pools naturally earn small boosts — which is the right behaviour: with a handful of memories the
 * prompt takes nearly all of them anyway.
 */
export function standardScores(similarities: ReadonlyMap<string, number> | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!similarities || similarities.size < SEMANTIC_MIN_POOL) return out;
  const values = [...similarities.values()];
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);
  if (stdev < 1e-6) return out;
  for (const [id, value] of similarities) out.set(id, (value - mean) / stdev);
  return out;
}

/** Score each memory adds for meaning alone: 0 up to {@link SEMANTIC_MATCH_Z}, the full weight from {@link SEMANTIC_FULL_Z}. */
export function semanticBoosts(similarities: ReadonlyMap<string, number> | undefined, weight = SEMANTIC_WEIGHT): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, z] of standardScores(similarities)) {
    const ramp = (z - SEMANTIC_MATCH_Z) / (SEMANTIC_FULL_Z - SEMANTIC_MATCH_Z);
    if (ramp > 0) out.set(id, Math.min(1, ramp) * weight);
  }
  return out;
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

/**
 * Rank entries for `query`, best first; ties broken by `updatedAt` desc.
 *
 * With `context.similarities` the ranking is hybrid rather than replaced: a memory that shares no
 * word with the query can still be a match on meaning alone, and one that shares a tag still
 * scores for it even when the embedder disagrees.
 */
export function rankMemories(entries: MemoryEntry[], query: string, now: Date, context: RankContext = {}): ScoredMemory[] {
  const queryTokens = tokenize(query);
  const boosts = semanticBoosts(context.similarities, context.semanticWeight);
  return entries
    .map((entry) => {
      const boost = boosts.get(entry.id) ?? 0;
      return { entry, score: scoreMemory(entry, queryTokens, now) + boost, match: matchScore(entry, queryTokens) + boost };
    })
    .sort((a, b) => b.score - a.score || (a.entry.updatedAt < b.entry.updatedAt ? 1 : a.entry.updatedAt > b.entry.updatedAt ? -1 : 0));
}

/** Stable prompt order: importance desc, then createdAt asc. */
export function promptOrder(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.importance - a.importance || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
