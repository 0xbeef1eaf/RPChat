import { describe, expect, it } from 'vitest';
import { stripCodeComments } from './comments.js';

describe('stripCodeComments', () => {
  it('drops a comment that had its line to itself, and the line with it', () => {
    expect(stripCodeComments('// pick a photo\nconst a = 1;')).toBe('const a = 1;');
    expect(stripCodeComments('const a = 1;\n  // why\nconst b = 2;')).toBe('const a = 1;\nconst b = 2;');
  });

  it('drops a trailing comment and the whitespace in front of it', () => {
    expect(stripCodeComments('const a = 1;   // one\nconst b = 2;')).toBe('const a = 1;\nconst b = 2;');
  });

  it('leaves a space where an inline block comment separated two tokens', () => {
    expect(stripCodeComments('const a = 1 /* one */ + 2;')).toBe('const a = 1 + 2;');
    expect(stripCodeComments('f(a/* x */, b);')).toBe('f(a, b);');
  });

  it('drops a multi-line block comment and keeps the code around it', () => {
    const code = 'const a = 1;\n/**\n * Explain at length.\n */\nconst b = 2;';
    expect(stripCodeComments(code)).toBe('const a = 1;\nconst b = 2;');
  });

  it('leaves one blank line where a commented block stood between two', () => {
    expect(stripCodeComments('const a = 1;\n\n// why\n\nconst b = 2;')).toBe('const a = 1;\n\nconst b = 2;');
  });

  it('keeps comment-looking text inside strings and templates', () => {
    expect(stripCodeComments('const u = "https://example.com"; // fetch it')).toBe('const u = "https://example.com";');
    expect(stripCodeComments("const s = 'a /* b */ c';")).toBe("const s = 'a /* b */ c';");
    expect(stripCodeComments('const t = `line // not a comment\n  keeps  trailing spaces  `;')).toBe(
      'const t = `line // not a comment\n  keeps  trailing spaces  `;',
    );
  });

  it('strips inside a template interpolation but not around it', () => {
    expect(stripCodeComments('const t = `a ${b /* why */} // c`;')).toBe('const t = `a ${b} // c`;');
  });

  it('handles nested templates', () => {
    const code = 'const t = `${ `${x} // inner` }`; // outer';
    expect(stripCodeComments(code)).toBe('const t = `${ `${x} // inner` }`;');
  });

  it('does not mistake a regex for a comment', () => {
    expect(stripCodeComments('const re = /https:\\/\\//; // match urls')).toBe('const re = /https:\\/\\//;');
    expect(stripCodeComments('const m = s.replace(/[/]/g, "-"); // slashes')).toBe('const m = s.replace(/[/]/g, "-");');
  });

  it('does not mistake a division for a regex', () => {
    expect(stripCodeComments('const half = total / 2; // half\nconst q = (a + b) / c;')).toBe(
      'const half = total / 2;\nconst q = (a + b) / c;',
    );
  });

  it('returns code it cannot scan unchanged', () => {
    const unterminated = 'const s = "open; // note';
    expect(stripCodeComments(unterminated)).toBe(unterminated);
    const openBlock = 'const a = 1; /* never closed';
    expect(stripCodeComments(openBlock)).toBe(openBlock);
  });

  it('returns code that is nothing but comments unchanged', () => {
    const onlyComments = '// thinking about it\n// still thinking';
    expect(stripCodeComments(onlyComments)).toBe(onlyComments);
  });

  it('leaves code without comments untouched', () => {
    const code = 'await sdk.media.show({ url: u });\nreturn { ok: true };';
    expect(stripCodeComments(code)).toBe(code);
  });
});
