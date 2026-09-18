import { describe, expect, it } from 'vitest';
import { DEFAULT_SNIPPET, errorLocation, lineCount, loadSnippet, parseInputJson, saveSnippet } from './sandbox';
import type { StorageLike } from './sandbox';

class MemoryStore implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('lineCount / parseInputJson', () => {
  it('counts lines', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(3);
  });
  it('treats a blank field as no input and reports JSON errors', () => {
    expect(parseInputJson('  \n')).toEqual({ ok: true, value: undefined });
    expect(parseInputJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseInputJson('{a:1}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
  });
});

describe('snippet storage', () => {
  it('remembers a snippet per character and falls back to the default', () => {
    const store = new MemoryStore();
    expect(loadSnippet('com.x/luna', store)).toBe(DEFAULT_SNIPPET);
    saveSnippet('com.x/luna', 'return 1;', store);
    expect(loadSnippet('com.x/luna', store)).toBe('return 1;');
    expect(loadSnippet('com.x/echo', store)).toBe(DEFAULT_SNIPPET);
  });
  it('never throws when the storage does', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
    };
    expect(() => saveSnippet('r', 'x', broken)).not.toThrow();
    expect(loadSnippet('r', broken)).toBe(DEFAULT_SNIPPET);
  });
});

describe('errorLocation', () => {
  it('reads line/column/frame from mapped sandbox errors only', () => {
    expect(errorLocation(undefined)).toEqual({});
    expect(errorLocation({ code: 'SANDBOX_RUNTIME', message: 'x', details: 'text' })).toEqual({});
    expect(errorLocation({ code: 'SANDBOX_RUNTIME', message: 'x', details: { line: 2, column: 5, frame: '2 | y' } })).toEqual({ line: 2, column: 5, frame: '2 | y' });
  });
});
