import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNIPPET,
  errorLocation,
  indentSelection,
  lineCount,
  loadSnippet,
  newlineKeepingIndent,
  parseInputJson,
  saveSnippet,
} from './sandbox';
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

describe('indentSelection', () => {
  it('inserts two spaces at the caret when nothing is selected', () => {
    expect(indentSelection('ab', 1, 1)).toEqual({ value: 'a  b', selectionStart: 3, selectionEnd: 3 });
  });
  it('indents every line a selection touches and keeps the selection on the same text', () => {
    const text = 'one\ntwo\nthree';
    const out = indentSelection(text, 1, 9); // "ne\ntwo\nt"
    expect(out.value).toBe('  one\n  two\n  three');
    expect(out.value.slice(out.selectionStart, out.selectionEnd)).toBe('ne\n  two\n  t');
  });
  it('outdents the selected lines, at most two spaces each', () => {
    const text = '  one\n two\nthree';
    const out = indentSelection(text, 3, text.length, true);
    expect(out.value).toBe('one\ntwo\nthree');
    expect(out.selectionStart).toBe(1);
    expect(out.selectionEnd).toBe(out.value.length);
  });
  it('outdents the caret line when nothing is selected', () => {
    expect(indentSelection('  x', 3, 3, true)).toEqual({ value: 'x', selectionStart: 1, selectionEnd: 1 });
    expect(indentSelection('x', 1, 1, true)).toEqual({ value: 'x', selectionStart: 1, selectionEnd: 1 });
  });
});

describe('newlineKeepingIndent', () => {
  it('copies the indentation of the current line and replaces the selection', () => {
    expect(newlineKeepingIndent('  a', 3, 3)).toEqual({ value: '  a\n  ', selectionStart: 6, selectionEnd: 6 });
    expect(newlineKeepingIndent('ab', 1, 2)).toEqual({ value: 'a\n', selectionStart: 2, selectionEnd: 2 });
  });
});

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
