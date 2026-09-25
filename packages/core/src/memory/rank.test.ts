import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@rp/shared';
import {
  SEMANTIC_WEIGHT,
  jaccard,
  promptOrder,
  rankMemories,
  scoreMemory,
  semanticBoosts,
  standardScores,
  tokenize,
} from './rank.js';

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

  it('measures similarity against the pool, not against a fixed threshold', () => {
    // The same three memories under two models whose "unrelated" baselines are far apart.
    const openAiLike = new Map([['a', 0.62], ['b', 0.14], ['c', 0.1], ['d', 0.08]]);
    const bgeLike = new Map([['a', 0.91], ['b', 0.68], ['c', 0.66], ['d', 0.65]]);
    const zOf = (m: Map<string, number>) => [...standardScores(m).entries()].map(([id, z]) => [id, Math.round(z * 10) / 10]);
    expect(zOf(openAiLike)).toEqual(zOf(bgeLike));

    expect(standardScores(new Map([['a', 0.9], ['b', 0.1], ['c', 0.1]]))).toEqual(new Map()); // pool too small
    expect(standardScores(new Map([['a', 0.5], ['b', 0.5], ['c', 0.5], ['d', 0.5]]))).toEqual(new Map()); // nothing stands out
    expect(standardScores(undefined)).toEqual(new Map());
  });

  it('pays a memory only for standing out, up to the full semantic weight', () => {
    const pool = new Map([['top', 0.9], ['mid', 0.45], ...Array.from({ length: 10 }, (_, i) => [`low${i}`, 0.1] as const)]);
    const boosts = semanticBoosts(pool);
    expect(boosts.get('top')).toBeCloseTo(SEMANTIC_WEIGHT); // far above the baseline: the lot
    expect(boosts.get('mid') ?? 0).toBeGreaterThan(0); // above it, but not by much
    expect(boosts.get('mid') ?? 0).toBeLessThan(SEMANTIC_WEIGHT / 2);
    expect(boosts.has('low0')).toBe(false); // at or below the baseline: nothing

    // A small pool cannot produce a large standard score at all (at most (n-1)/√n), so the boost
    // it can earn is capped by its own size — which is fine, the prompt takes such a pool whole.
    const tiny = semanticBoosts(new Map([['top', 0.9], ['a', 0.1], ['b', 0.1], ['c', 0.1]]));
    expect(tiny.get('top') ?? 0).toBeGreaterThan(0);
    expect(tiny.get('top') ?? 0).toBeLessThan(SEMANTIC_WEIGHT);
  });

  it('matches on meaning without a shared word, and still scores tags the embedder missed', () => {
    const sister = mem('sister', 'Hannah rings every Sunday evening');
    const cat = mem('cat', 'Miso the cat hates the vet');
    const work = mem('work', 'Standup moved to nine');
    const chores = mem('chores', 'The bins go out on Tuesday');
    const entries = [cat, work, chores, sister];
    const similarities = new Map([['sister', 0.82], ['cat', 0.2], ['work', 0.18], ['chores', 0.15]]);

    const lexical = rankMemories(entries, 'how is your sister?', NOW);
    expect(lexical.every((r) => r.match === 0)).toBe(true); // not one word in common

    const hybrid = rankMemories(entries, 'how is your sister?', NOW, { similarities });
    expect(hybrid[0]?.entry.id).toBe('sister');
    expect(hybrid[0]?.match).toBeGreaterThan(0);

    // A tag hit is worth more than the embedder's opinion when the two disagree.
    const tagged = mem('tagged', 'Nothing much happened', { tags: ['sister'] });
    const withTag = rankMemories([...entries, tagged], 'how is your sister?', NOW, {
      similarities: new Map([...similarities, ['tagged', 0.15]]),
    });
    expect(withTag[0]?.entry.id).toBe('tagged');
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
