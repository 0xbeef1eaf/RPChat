import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@rp/shared';
import { jaccard, promptOrder, rankMemories, scoreMemory, tokenize } from './rank.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');

function mem(id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    characterRef: 'p/c',
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

describe('rank', () => {
  it('tokenises: lower-case, no punctuation, no stop-words, deduped', () => {
    expect([...tokenize('The Cat, the CAT! is on a keyboard.')]).toEqual(['cat', 'keyboard']);
    expect(jaccard(tokenize('cat keyboard'), tokenize('keyboard cat sleeps'))).toBeCloseTo(2 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('tag hits beat body-word overlap', () => {
    const tagged = mem('a', 'Something unrelated about the weekend', { tags: ['birthday'] });
    const body = mem('b', 'Their birthday party was fun and loud');
    const ranked = rankMemories([body, tagged], 'birthday', NOW);
    expect(ranked.map((r) => r.entry.id)).toEqual(['a', 'b']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score + 1);
  });

  it('breaks ties by importance, then recency, then updatedAt', () => {
    const low = mem('low', 'likes tea', { importance: 2 });
    const high = mem('high', 'likes tea', { importance: 5 });
    expect(rankMemories([low, high], 'tea', NOW).map((r) => r.entry.id)).toEqual(['high', 'low']);

    const old = mem('old', 'likes coffee');
    const fresh = mem('fresh', 'likes coffee', { createdAt: '2026-03-09T00:00:00.000Z' });
    const recalled = mem('recalled', 'likes coffee', { lastRecalledAt: '2026-03-09T00:00:00.000Z' });
    expect(scoreMemory(fresh, tokenize('coffee'), NOW)).toBeCloseTo(scoreMemory(old, tokenize('coffee'), NOW) + 0.2);
    expect(scoreMemory(recalled, tokenize('coffee'), NOW)).toBeCloseTo(scoreMemory(old, tokenize('coffee'), NOW) + 0.1);
    expect(rankMemories([old, recalled, fresh], 'coffee', NOW).map((r) => r.entry.id)).toEqual(['fresh', 'recalled', 'old']);

    const a = mem('a', 'same', { updatedAt: '2026-02-01T00:00:00.000Z' });
    const b = mem('b', 'same', { updatedAt: '2026-02-02T00:00:00.000Z' });
    expect(rankMemories([a, b], 'nothing', NOW).map((r) => r.entry.id)).toEqual(['b', 'a']);
  });

  it('orders for the prompt by importance desc then createdAt asc', () => {
    const out = promptOrder([
      mem('c', 'x', { importance: 3, createdAt: '2026-01-03T00:00:00.000Z' }),
      mem('a', 'x', { importance: 5, createdAt: '2026-01-02T00:00:00.000Z' }),
      mem('b', 'x', { importance: 3, createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});
