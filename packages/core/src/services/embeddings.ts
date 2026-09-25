/**
 * Vectors for memory retrieval, so a character remembers by meaning and not only by wording.
 *
 * Keyword ranking has a hard floor: "how is your sister?" never reaches "Hannah calls every
 * Sunday", because the two share no word. An embedding closes that gap, but only if getting one
 * is never allowed to become a way for a turn to fail or to hang — so everything here degrades to
 * "no vectors, rank lexically" rather than throwing, and a backlog of un-embedded memories is
 * worked off a batch per call instead of all at once.
 *
 * Vectors come from a provider's embeddings endpoint when one is configured, otherwise from an
 * embedder the host supplies (the desktop app's on-device model). They are cached per character in
 * `Storage.embeddings`, keyed by a hash of the embedded text so an edited memory re-embeds itself
 * and a changed model invalidates the lot.
 */
import { createHash } from 'node:crypto';
import type { AppSettings, EmbeddingStatus, MemoryEntry, MemoryVectorCache, Storage } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { ProviderFactory, SettingsService } from './settings.js';
import type { Clock, Logger } from '../types.js';

/** Texts embedded per request: large enough to amortise the round trip, small enough for a local server's context. */
export const EMBED_BATCH_SIZE = 64;

/**
 * Memories embedded per `similarities` call. A character at the 500-memory cap whose cache is cold
 * would otherwise make the first reply of a session wait for all 500; instead the backlog is worked
 * off over the next few turns, and until then ranking is lexical for the memories still missing.
 */
export const EMBED_BACKLOG_PER_CALL = 128;

/** Below this many existing memories there is no baseline to judge "unusually close" against. */
export const SEMANTIC_DUPLICATE_MIN_POOL = 5;

/**
 * How far from the pool's baseline towards a perfect match a candidate has to sit to count as a
 * duplicate. High on purpose: keeping two similar memories costs a prompt line, while merging two
 * different ones loses a fact.
 */
export const SEMANTIC_DUPLICATE_FRACTION = 0.75;

/** Query vectors kept in memory. The focus text repeats across the turns of a conversation. */
const QUERY_CACHE_SIZE = 32;

/** How long a failed embedder is left alone before it is tried again. */
const FAILURE_COOLDOWN_MS = 60_000;

/** Something that turns texts into unit-length vectors of a fixed width. */
export interface Embedder {
  /** Stable identity of the model behind the vectors; a change invalidates every cached vector. */
  readonly label: string;
  /** `provider` when the vectors cost a round trip to a configured provider, `local` for an on-device model. */
  readonly source: 'provider' | 'local';
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface EmbeddingServiceOptions {
  storage: Pick<Storage, 'embeddings'>;
  settings: SettingsService;
  providerFactory: ProviderFactory;
  now: Clock;
  logger: Logger;
  /**
   * Embedder used when no provider can embed. Resolved lazily and at most once — the desktop app
   * loads an on-device model here, which is slow to start and pointless to load unless it is used.
   */
  localEmbedder?: () => Promise<Embedder | undefined>;
}

/** Base64 of the little-endian float32 vector. Host-endian, like every other cache in the data dir. */
export function encodeVector(values: ArrayLike<number>): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(data: string): Float32Array {
  const buf = Buffer.from(data, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** Dot product of two unit-length vectors, i.e. their cosine; 0 when the widths disagree. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/**
 * What is actually embedded for a memory: its text plus its tags.
 *
 * The tags are part of what the memory means — "vet" on a line that never says the word is exactly
 * the handle a later question needs — and including them keeps the embedding in step with the
 * keyword side, which already scores tags.
 */
export function embedText(entry: MemoryEntry): string {
  return entry.tags.length > 0 ? `${entry.text} [${entry.tags.join(', ')}]` : entry.text;
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('base64').slice(0, 16);
}

/** Semantic side of memory ranking: vectors, their cache, and the embedder that produces them. */
export class EmbeddingService {
  private readonly queryCache = new Map<string, Float32Array>();
  private resolving: { key: string; task: Promise<Embedder | undefined> } | undefined;
  private resolved: { key: string; embedder: Embedder | undefined } | undefined;
  private local: { value: Embedder | undefined } | undefined;
  private readonly writing = new Map<string, Promise<void>>();
  private failure: { at: number; message: string } | undefined;
  private dims: number | undefined;

  constructor(private readonly o: EmbeddingServiceOptions) {}

  /**
   * Cosine similarity of every entry to `query`, or `undefined` when there is nothing to rank
   * with — no embedder, semantic ranking off, or the last attempt failed recently. Never throws:
   * the caller's fallback is the keyword ranking it already has.
   */
  async similarities(characterRef: string, entries: MemoryEntry[], query: string): Promise<Map<string, number> | undefined> {
    if (entries.length === 0 || query.trim().length === 0) return undefined;
    const settings = await this.o.settings.get();
    if (!settings.memory.semanticRanking) return undefined;
    const embedder = await this.embedder(settings);
    if (!embedder || this.coolingDown()) return undefined;

    try {
      const queryVector = await this.embedQuery(embedder, query);
      const vectors = await this.vectorsFor(embedder, characterRef, entries);
      const out = new Map<string, number>();
      for (const entry of entries) {
        const vector = vectors.get(entry.id);
        if (vector) out.set(entry.id, cosine(queryVector, vector));
      }
      return out.size > 0 ? out : undefined;
    } catch (err) {
      this.noteFailure(err);
      return undefined;
    }
  }

  /**
   * Whether `text` says something the pool already holds.
   *
   * The threshold is interpolated from the candidate's own baseline similarity to the pool rather
   * than fixed, for the reason `standardScores` explains: "unrelated" sits near 0.1 for one model
   * family and near 0.65 for another, so the only portable reading of "far closer than usual" is
   * one relative to what this pool usually scores.
   */
  async duplicateOf(characterRef: string, pool: MemoryEntry[], text: string): Promise<MemoryEntry | undefined> {
    if (pool.length < SEMANTIC_DUPLICATE_MIN_POOL) return undefined;
    const sims = await this.similarities(characterRef, pool, text);
    if (!sims) return undefined;
    const values = [...sims.values()];
    const baseline = values.reduce((sum, v) => sum + v, 0) / values.length;
    const threshold = baseline + (1 - baseline) * SEMANTIC_DUPLICATE_FRACTION;
    let best: { entry: MemoryEntry; score: number } | undefined;
    for (const entry of pool) {
      const score = sims.get(entry.id);
      if (score !== undefined && score >= threshold && (!best || score > best.score)) best = { entry, score };
    }
    return best?.entry;
  }

  /** Drop a character's cached vectors (their memories are gone). */
  async forget(characterRef: string): Promise<void> {
    await this.o.storage.embeddings.removeForCharacter(characterRef).catch(() => undefined);
  }

  /**
   * What the settings screen shows. Embeds one short text when an embedder is configured, which is
   * the only way to tell a working endpoint from a plausible-looking one.
   */
  async check(): Promise<EmbeddingStatus> {
    const settings = await this.o.settings.get();
    if (!settings.memory.semanticRanking) return { source: 'none', problem: 'Semantic ranking is off.' };
    const embedder = await this.embedder(settings);
    if (!embedder) {
      return {
        source: 'none',
        problem:
          settings.memory.embeddingModel === undefined
            ? 'No embedding model set, and no on-device embedder available.'
            : 'The chosen provider does not support embeddings.',
      };
    }
    try {
      const [vector] = await embedder.embed(['ping']);
      if (!vector || vector.length === 0) throw new RpError('LLM_PROVIDER', 'The embedder returned an empty vector');
      this.dims = vector.length;
      this.failure = undefined;
      return { source: embedder.source, label: embedder.label, dims: vector.length };
    } catch (err) {
      const problem = RpError.from(err, 'LLM_PROVIDER').message;
      this.noteFailure(err);
      return { source: embedder.source, label: embedder.label, problem };
    }
  }

  // ---- internals ----------------------------------------------------------

  /** The embedder for the current settings: a provider that can embed, else the host's own. */
  private async embedder(settings: AppSettings): Promise<Embedder | undefined> {
    const key = JSON.stringify([settings.memory.embeddingProviderId ?? settings.defaultProviderId, settings.memory.embeddingModel]);
    if (this.resolved?.key === key) return this.resolved.embedder;
    if (this.resolving?.key === key) return this.resolving.task;
    const task = this.resolveEmbedder(settings)
      .then((embedder) => {
        // A miss is not cached: the on-device model may be downloading right now, and the point of
        // the settings screen offering it is that the next turn picks it up without a restart.
        if (embedder) {
          this.resolved = { key, embedder };
          this.dims = undefined;
        }
        return embedder;
      })
      .finally(() => {
        if (this.resolving?.task === task) this.resolving = undefined;
      });
    this.resolving = { key, task };
    return task;
  }

  private async resolveEmbedder(settings: AppSettings): Promise<Embedder | undefined> {
    const model = settings.memory.embeddingModel?.trim();
    if (model) {
      const config = await this.o.settings
        .resolveProvider(settings.memory.embeddingProviderId)
        .catch(() => undefined);
      const provider = config ? this.o.providerFactory(config) : undefined;
      if (provider?.embed) {
        const embed = provider.embed.bind(provider);
        return {
          label: `${config?.label ?? provider.id} / ${model}`,
          source: 'provider',
          embed: async (texts, signal) => (await embed(signal ? { model, texts, signal } : { model, texts })).vectors,
        };
      }
    }
    if (!this.local?.value) this.local = { value: await this.o.localEmbedder?.().catch(() => undefined) };
    return this.local.value;
  }

  private coolingDown(): boolean {
    if (!this.failure) return false;
    if (this.o.now().getTime() - this.failure.at < FAILURE_COOLDOWN_MS) return true;
    this.failure = undefined;
    return false;
  }

  private noteFailure(err: unknown): void {
    const message = RpError.from(err, 'LLM_PROVIDER').message;
    if (this.failure?.message !== message) this.o.logger.warn(`[memory] embeddings unavailable, ranking by keywords: ${message}`);
    this.failure = { at: this.o.now().getTime(), message };
  }

  private async embedQuery(embedder: Embedder, query: string): Promise<Float32Array> {
    const key = `${embedder.label}\n${query}`;
    const hit = this.queryCache.get(key);
    if (hit) return hit;
    const [vector] = await embedder.embed([query]);
    if (!vector || vector.length === 0) throw new RpError('LLM_PROVIDER', 'The embedder returned an empty vector');
    const value = Float32Array.from(vector);
    this.dims = value.length;
    if (this.queryCache.size >= QUERY_CACHE_SIZE) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, value);
    return value;
  }

  /**
   * Cached vectors for `entries`, embedding up to `EMBED_BACKLOG_PER_CALL` of the missing ones and
   * writing the cache back. Vectors of memories that no longer exist are dropped on the way.
   */
  private async vectorsFor(embedder: Embedder, characterRef: string, entries: MemoryEntry[]): Promise<Map<string, Float32Array>> {
    const stored = await this.o.storage.embeddings.get(characterRef);
    const cache: MemoryVectorCache =
      stored && stored.embedder === embedder.label ? stored : { embedder: embedder.label, dims: this.dims ?? 0, vectors: {} };

    const out = new Map<string, Float32Array>();
    const missing: MemoryEntry[] = [];
    const wanted: Record<string, { hash: string; data: string }> = {};
    for (const entry of entries) {
      const hash = hashText(embedText(entry));
      const cached = cache.vectors[entry.id];
      if (cached && cached.hash === hash) {
        wanted[entry.id] = cached;
        out.set(entry.id, decodeVector(cached.data));
      } else if (missing.length < EMBED_BACKLOG_PER_CALL) {
        missing.push(entry);
      }
    }

    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedder.embed(batch.map(embedText));
      batch.forEach((entry, idx) => {
        const vector = vectors[idx];
        if (!vector || vector.length === 0) return;
        this.dims = vector.length;
        wanted[entry.id] = { hash: hashText(embedText(entry)), data: encodeVector(vector) };
        out.set(entry.id, Float32Array.from(vector));
      });
    }

    const pruned = Object.keys(cache.vectors).length !== Object.keys(wanted).length;
    if (missing.length > 0 || pruned) {
      await this.save(characterRef, { embedder: embedder.label, dims: this.dims ?? cache.dims, vectors: wanted });
    }
    return out;
  }

  /** Serialised per character: two turns of the same character can both backfill at once. */
  private async save(characterRef: string, cache: MemoryVectorCache): Promise<void> {
    const previous = this.writing.get(characterRef) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.o.storage.embeddings.set(characterRef, cache))
      .catch((err: unknown) => this.o.logger.warn(`[memory] could not cache embeddings for ${characterRef}`, err))
      .finally(() => {
        if (this.writing.get(characterRef) === task) this.writing.delete(characterRef);
      });
    this.writing.set(characterRef, task);
    await task;
  }
}
