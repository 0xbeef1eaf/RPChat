import { describe, expect, it } from 'vitest';
import { MockProvider } from '@rp/llm';
import { DEFAULT_MEMORY_SETTINGS, type MemoryEntry } from '@rp/shared';
import { MemoryStorage } from '../storage/memory.js';
import { FakeClock, MOCK_PROVIDER } from '../test/helpers.js';
import { NOOP_LOGGER } from '../types.js';
import { EmbeddingService, cosine, decodeVector, embedText, encodeVector } from './embeddings.js';
import { SettingsService } from './settings.js';

const REF = 'com.example.luna/luna';

/** Three axes to write memories against: family, the cat, work. A text scores on the words it mentions. */
const AXES: ReadonlyArray<[string, RegExp]> = [
  ['family', /sister|hannah|family|mother/i],
  ['cat', /cat|miso|vet|purr/i],
  ['work', /work|deadline|office|standup/i],
];

function toyVector(text: string): number[] {
  const raw = AXES.map(([, pattern]) => (pattern.test(text) ? 1 : 0.05));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

function mem(id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    characterRef: REF,
    text,
    tags: [],
    importance: 3,
    source: 'character',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    recallCount: 0,
    ...extra,
  };
}

function harness(options: { embed?: (text: string) => number[]; model?: string | undefined } = {}) {
  const storage = new MemoryStorage();
  const clock = new FakeClock('2026-03-10T12:00:00.000Z');
  const provider = new MockProvider(MOCK_PROVIDER, { embed: options.embed ?? toyVector });
  const settings = new SettingsService(storage, () => provider);
  const embeddings = new EmbeddingService({ storage, settings, providerFactory: () => provider, now: clock.now, logger: NOOP_LOGGER });
  const ready = settings.update({
    providers: [MOCK_PROVIDER],
    defaultProviderId: MOCK_PROVIDER.id,
    memory: { ...DEFAULT_MEMORY_SETTINGS, embeddingModel: 'model' in options ? options.model : 'embed-1' },
  });
  return { storage, clock, provider, settings, embeddings, ready };
}

const POOL = [
  mem('a', 'Hannah calls every Sunday evening'),
  mem('b', 'Miso the cat hates the vet'),
  mem('c', 'The standup at work moved to nine'),
  mem('d', 'They finished the deadline early and slept'),
];

async function seed(h: ReturnType<typeof harness>, entries: MemoryEntry[] = POOL): Promise<void> {
  await h.ready;
  for (const entry of entries) await h.storage.memories.upsert(entry);
}

describe('EmbeddingService', () => {
  it('encodes vectors compactly and reads them back', () => {
    const vector = [0.5, -0.25, 0.125];
    expect([...decodeVector(encodeVector(vector))]).toEqual(vector);
    expect(cosine(decodeVector(encodeVector(vector)), Float32Array.from(vector))).toBeCloseTo(0.328125);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('embeds the memory text together with its tags', () => {
    expect(embedText(mem('a', 'Hannah calls'))).toBe('Hannah calls');
    expect(embedText(mem('a', 'Hannah calls', { tags: ['family', 'sister'] }))).toBe('Hannah calls [family, sister]');
  });

  it('scores a memory that shares no word with the query', async () => {
    const h = harness();
    await seed(h);
    const sims = await h.embeddings.similarities(REF, POOL, 'how is your sister doing?');
    expect(sims).toBeDefined();
    expect(sims?.get('a')).toBeGreaterThan(sims?.get('b') ?? 1);
    expect(sims?.get('a')).toBeGreaterThan(sims?.get('c') ?? 1);
  });

  it('embeds each memory once and re-uses the cached vectors', async () => {
    const h = harness();
    await seed(h);
    await h.embeddings.similarities(REF, POOL, 'the cat');
    expect(h.provider.embedRequests.map((r) => r.texts.length)).toEqual([1, 4]);

    await h.embeddings.similarities(REF, POOL, 'the cat');
    expect(h.provider.embedRequests).toHaveLength(2); // query cached too

    await h.embeddings.similarities(REF, POOL, 'work');
    expect(h.provider.embedRequests.map((r) => r.texts.length)).toEqual([1, 4, 1]);

    const cache = await h.storage.embeddings.get(REF);
    expect(cache?.embedder).toBe('Mock / embed-1');
    expect(cache?.dims).toBe(3);
    expect(Object.keys(cache?.vectors ?? {}).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('re-embeds an edited memory and drops the vectors of deleted ones', async () => {
    const h = harness();
    await seed(h);
    await h.embeddings.similarities(REF, POOL, 'the cat');
    h.provider.embedRequests.length = 0;

    const edited = [mem('a', 'Hannah moved to another city'), ...POOL.slice(1, 3)];
    await h.embeddings.similarities(REF, edited, 'the cat');
    expect(h.provider.embedRequests.map((r) => r.texts)).toEqual([['Hannah moved to another city']]);
    expect(Object.keys((await h.storage.embeddings.get(REF))?.vectors ?? {}).sort()).toEqual(['a', 'b', 'c']);
  });

  it('starts over when the embedding model changes', async () => {
    const h = harness();
    await seed(h);
    await h.embeddings.similarities(REF, POOL, 'the cat');
    await h.settings.update({ memory: { ...DEFAULT_MEMORY_SETTINGS, embeddingModel: 'embed-2' } });
    h.provider.embedRequests.length = 0;

    await h.embeddings.similarities(REF, POOL, 'the cat');
    expect(h.provider.embedRequests.map((r) => r.texts.length)).toEqual([1, 4]);
    expect((await h.storage.embeddings.get(REF))?.embedder).toBe('Mock / embed-2');
  });

  it('ranks by keywords alone when nothing can embed', async () => {
    const h = harness({ model: undefined });
    await seed(h);
    expect(await h.embeddings.similarities(REF, POOL, 'the cat')).toBeUndefined();
    expect(h.provider.embedRequests).toHaveLength(0);
    expect(await h.embeddings.check()).toMatchObject({ source: 'none' });
  });

  it('stays quiet when semantic ranking is switched off', async () => {
    const h = harness();
    await h.ready;
    await h.settings.update({ memory: { ...DEFAULT_MEMORY_SETTINGS, embeddingModel: 'embed-1', semanticRanking: false } });
    expect(await h.embeddings.similarities(REF, POOL, 'the cat')).toBeUndefined();
    expect(h.provider.embedRequests).toHaveLength(0);
  });

  it('falls back to keywords on failure and leaves the embedder alone for a minute', async () => {
    let failing = true;
    const h = harness({
      embed: (text) => {
        if (failing) throw new Error('connection refused');
        return toyVector(text);
      },
    });
    await seed(h);

    expect(await h.embeddings.similarities(REF, POOL, 'the cat')).toBeUndefined();
    expect(h.provider.embedRequests).toHaveLength(1);

    failing = false;
    expect(await h.embeddings.similarities(REF, POOL, 'the cat')).toBeUndefined();
    expect(h.provider.embedRequests).toHaveLength(1); // still cooling down, nothing asked

    h.clock.advance(60_001);
    expect(await h.embeddings.similarities(REF, POOL, 'the cat')).toBeDefined();
  });

  it('reports what the settings screen shows', async () => {
    const h = harness();
    await h.ready;
    expect(await h.embeddings.check()).toEqual({ source: 'provider', label: 'Mock / embed-1', dims: 3 });

    const broken = harness({
      embed: () => {
        throw new Error('no such model');
      },
    });
    await broken.ready;
    expect(await broken.embeddings.check()).toMatchObject({ source: 'provider', problem: expect.stringContaining('no such model') });
  });

  it('uses an on-device embedder when no provider can embed', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock('2026-03-10T12:00:00.000Z');
    const provider = new MockProvider(MOCK_PROVIDER);
    const settings = new SettingsService(storage, () => provider);
    let loads = 0;
    const embeddings = new EmbeddingService({
      storage,
      settings,
      providerFactory: () => provider,
      now: clock.now,
      logger: NOOP_LOGGER,
      localEmbedder: async () => {
        loads += 1;
        return { label: 'on-device / toy', source: 'local', embed: async (texts) => texts.map(toyVector) };
      },
    });
    await settings.update({ providers: [MOCK_PROVIDER], defaultProviderId: MOCK_PROVIDER.id });
    for (const entry of POOL) await storage.memories.upsert(entry);

    const sims = await embeddings.similarities(REF, POOL, 'is the cat alright?');
    expect(sims?.get('b')).toBeGreaterThan(sims?.get('a') ?? 1);
    expect(await embeddings.check()).toMatchObject({ source: 'local', label: 'on-device / toy' });
    expect(loads).toBe(1);
  });

  it('spots a paraphrase of a memory the pool already holds', async () => {
    const h = harness();
    const pool = [...POOL, mem('e', 'They took the mother to the office once')];
    await seed(h, pool);
    expect(await h.embeddings.duplicateOf(REF, pool, 'The cat, Miso, is frightened of the vet')).toMatchObject({ id: 'b' });
    expect(await h.embeddings.duplicateOf(REF, pool, 'They are learning to bake sourdough')).toBeUndefined();
    expect(await h.embeddings.duplicateOf(REF, pool.slice(0, 3), 'Miso hates the vet')).toBeUndefined(); // pool too small to judge
  });
});
