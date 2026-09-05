import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@rp/shared';
import { clampImportance, filterMemories, parseTags, sortMemories } from './memory';

function mem(id: string, text: string, tags: string[], importance: 1 | 2 | 3 | 4 | 5, updatedAt = '2026-01-01T00:00:00Z'): MemoryEntry {
  return { id, characterRef: 'p/c', text, tags, importance, source: 'character', createdAt: updatedAt, updatedAt, recallCount: 0 };
}

describe('memory helpers', () => {
  it('parseTags normalises, strips # and de-duplicates', () => {
    expect(parseTags('Food, coffee #Coffee  music,')).toEqual(['food', 'coffee', 'music']);
    expect(parseTags('')).toEqual([]);
  });

  it('clampImportance', () => {
    expect(clampImportance(0)).toBe(1);
    expect(clampImportance(3.4)).toBe(3);
    expect(clampImportance(9)).toBe(5);
  });

  it('filterMemories matches all terms across text and tags, #tag matches tags only', () => {
    const list = [mem('a', 'Likes strong coffee in the morning', ['coffee', 'habits'], 3), mem('b', 'Plays guitar', ['music'], 2)];
    expect(filterMemories(list, '').map((m) => m.id)).toEqual(['a', 'b']);
    expect(filterMemories(list, 'COFFEE morning').map((m) => m.id)).toEqual(['a']);
    expect(filterMemories(list, '#music').map((m) => m.id)).toEqual(['b']);
    expect(filterMemories(list, '#guitar')).toEqual([]);
    expect(filterMemories(list, 'coffee guitar')).toEqual([]);
  });

  it('sortMemories orders by importance then recency without mutating', () => {
    const list = [mem('old-high', 'x', [], 5, '2026-01-01T00:00:00Z'), mem('low', 'y', [], 1, '2026-03-01T00:00:00Z'), mem('new-high', 'z', [], 5, '2026-02-01T00:00:00Z')];
    expect(sortMemories(list).map((m) => m.id)).toEqual(['new-high', 'old-high', 'low']);
    expect(list.map((m) => m.id)).toEqual(['old-high', 'low', 'new-high']);
  });
});
