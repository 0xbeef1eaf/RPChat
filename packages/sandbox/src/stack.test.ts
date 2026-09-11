import { describe, expect, it } from 'vitest';
import { SourceMapper, decodeMappings } from './sourcemap.js';
import { ACTION_FILE, codeFrame, mapStack } from './stack.js';
import { ASYNC_WRAPPER_LINES, PRELUDE_LINES, transpile } from './transpile.js';

/** The wrappers around the model's code, mirroring what the runner evaluates. */
function mapperFor(source: string): SourceMapper {
  const { map } = transpile(source, 'ts');
  expect(map).toBeDefined();
  return new SourceMapper(map as string, ASYNC_WRAPPER_LINES, PRELUDE_LINES);
}

describe('decodeMappings', () => {
  it('decodes base64-VLQ segments, keeping the running original position', () => {
    // "AAAA,CAAC" = one segment at 0:0 → 0:0, then +1 generated col → +0 line, +1 col.
    expect(decodeMappings('AAAA,CAAC')).toEqual([[{ generatedColumn: 0, originalLine: 0, originalColumn: 0 }, { generatedColumn: 1, originalLine: 0, originalColumn: 1 }]]);
    expect(decodeMappings('')).toEqual([[]]);
    expect(decodeMappings(';;')).toEqual([[], [], []]);
  });
});

describe('SourceMapper', () => {
  it('maps a position in the transpiled output back to the line the model wrote', () => {
    const source = ['const items = [1, 2, 3];', 'function pick(list: any[]) {', '  return list.find((x) => x.missing.deep);', '}', 'return pick(items);'].join('\n');
    const mapper = mapperFor(source);
    // esbuild reformats and the runner wraps, so generated lines are shifted;
    // whatever the shift, the mapped line is the one in the model's source.
    const { js } = transpile(source, 'ts');
    const generatedLine = js.split('\n').findIndex((l) => l.includes('list.find')) + 1 + ASYNC_WRAPPER_LINES;
    expect(mapper.originalPositionFor(generatedLine, 10)?.line).toBe(3);
  });

  it('returns undefined for the wrapper lines around the code', () => {
    const mapper = mapperFor('return 1;');
    expect(mapper.originalPositionFor(1, 1)).toBeUndefined();
    expect(mapper.originalPositionFor(9999, 1)).toBeUndefined();
  });
});

describe('mapStack', () => {
  const source = ['const items = [1, 2, 3];', 'function pick(list: any[]) {', '  return list.find((x) => x.missing.deep);', '}', 'return pick(items);'].join('\n');

  /** A QuickJS stack for `source`, with the line numbers the isolate would report. */
  function rawStack(): string {
    const { js } = transpile(source, 'ts');
    const lines = js.split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1 + ASYNC_WRAPPER_LINES;
    return [
      `    at <anonymous> (action.js:${at('list.find')}:38)`,
      '    at find (native)',
      `    at pick (action.js:${at('list.find')}:5)`,
      `    at __rp_main (action.js:${at('pick(items)')}:14)`,
      '    at <anonymous> (bootstrap.js:12:3)',
      '',
    ].join('\n');
  }

  it('rewrites frames into the model own file and drops sandbox frames', () => {
    const mapped = mapStack(rawStack(), mapperFor(source), source.split('\n').length);
    expect(mapped.stack.split('\n')).toEqual([
      `    at <anonymous> (${ACTION_FILE}:3:29)`,
      '    at find (native)',
      `    at pick (${ACTION_FILE}:3:3)`,
      `    at <your code> (${ACTION_FILE}:5:8)`,
    ]);
    expect(mapped.stack).not.toContain('bootstrap.js');
    expect(mapped.stack).not.toContain('__rp_main');
    expect(mapped.at).toEqual({ line: 3, column: 29 });
  });

  it('drops frames that map past the end of the code (the wrapper own lines)', () => {
    const beyond = `    at __rp_main (action.js:999:1)\n${rawStack()}`;
    const mapped = mapStack(beyond, mapperFor(source), source.split('\n').length);
    expect(mapped.stack).not.toContain('999');
    expect(mapped.at?.line).toBe(3);
  });

  it('is a no-op without a stack or a mapper', () => {
    expect(mapStack(undefined, undefined)).toEqual({ stack: '' });
    expect(mapStack(rawStack(), undefined).stack).toBe('    at find (native)');
  });
});

describe('codeFrame', () => {
  const source = ['const a = 1;', 'const b = 2;', 'return a.missing.deep;', 'const c = 3;', 'const d = 4;'].join('\n');

  it('quotes the failing line with a caret and its neighbours', () => {
    expect(codeFrame(source, { line: 3, column: 10 })).toBe(
      ['  1 | const a = 1;', '  2 | const b = 2;', '> 3 | return a.missing.deep;', '    |          ^', '  4 | const c = 3;', '  5 | const d = 4;'].join('\n'),
    );
  });

  it('clamps to the start of the source and returns nothing for a line outside it', () => {
    expect(codeFrame(source, { line: 1, column: 1 })).toBe(['> 1 | const a = 1;', '    | ^', '  2 | const b = 2;', '  3 | return a.missing.deep;'].join('\n'));
    expect(codeFrame(source, { line: 99, column: 1 })).toBeUndefined();
  });
});
