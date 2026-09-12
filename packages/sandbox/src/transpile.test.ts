import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { transpile, wrapAsAsyncFunctionBody } from './transpile.js';

describe('transpile', () => {
  it('strips TypeScript and keeps the async entry function', () => {
    const { js } = transpile(`const x: number = 1 satisfies number;\nreturn x;`, 'ts');
    expect(js).toContain('async function __rp_main()');
    expect(js).not.toContain(': number');
    expect(js).toContain('return x;');
  });

  it('accepts plain JavaScript', () => {
    const { js } = transpile(`return await Promise.resolve(2 ?? 1);`, 'js');
    expect(js).toContain('__rp_main');
  });

  it('throws SANDBOX_COMPILE with a 1-based line relative to the user code', () => {
    let caught: unknown;
    try {
      transpile(`const ok = 1;\nconst bad = ;`, 'ts');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpError);
    const e = caught as RpError;
    expect(e.code).toBe('SANDBOX_COMPILE');
    expect(e.details).toMatchObject({ line: 2, column: 13 });
    expect(e.message).toContain('line 2');
  });

  it('prepends a prelude inside the wrapper and counts its lines', () => {
    const out = transpile('return await lib.double(2);', 'ts', { prelude: 'const lib = Object.freeze({\n  "double": (async (n: number) => n * 2),\n});' });
    expect(out.preludeLines).toBe(3);
    expect(out.js.indexOf('const lib')).toBeGreaterThan(out.js.indexOf('async function __rp_main()'));
    expect(out.js.indexOf('const lib')).toBeLessThan(out.js.indexOf('lib.double(2)'));
    expect(transpile('return 1;', 'ts').preludeLines).toBe(0);
    expect(transpile('return 1;', 'ts', { prelude: '' }).preludeLines).toBe(0);
  });

  it('subtracts the prelude from user line numbers and flags errors inside it', () => {
    const prelude = 'const lib = Object.freeze({\n  "id": ((x: any) => x),\n});';
    expect(() => transpile('const ok = 1;\nconst bad = ;', 'ts', { prelude })).toThrow(expect.objectContaining({ details: expect.objectContaining({ line: 2 }) }));
    let caught: RpError | undefined;
    try {
      transpile('return 1;', 'ts', { prelude: 'const lib = Object.freeze({\n  "id": ((x: any) => x,\n});' });
    } catch (err) {
      caught = err as RpError;
    }
    expect(caught?.code).toBe('SANDBOX_COMPILE');
    expect(caught?.message).toMatch(/function library/);
    expect(caught?.details).toMatchObject({ library: true });
    expect((caught?.details as { line?: number }).line).toBeUndefined();
  });

  it('rejects import statements at compile time', () => {
    expect(() => transpile(`import fs from "fs";`, 'ts')).toThrow(RpError);
  });
});

describe('wrapAsAsyncFunctionBody', () => {
  it('keeps return valid', async () => {
    const src = wrapAsAsyncFunctionBody('return 1;');
    expect(src.startsWith('(async () => {')).toBe(true);
    expect(src.endsWith('})()')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    await expect(new Function(`return ${src}`)()).resolves.toBe(1);
  });
});
