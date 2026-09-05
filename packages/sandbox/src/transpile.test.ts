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
