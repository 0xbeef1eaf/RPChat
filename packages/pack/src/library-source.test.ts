import { describe, expect, it } from 'vitest';
import { functionParams, hasExports, jsDocSummary, scanExports } from './library-source.js';
import { buildCharacterLibrary } from './library.js';

/** Evaluate a library's code the way the prelude does, with `sdk` and `lib` as globals. */
function evaluate(code: string, globals: Record<string, unknown> = {}): Record<string, unknown> {
  return new Function(...Object.keys(globals), `return ${code};`)(...Object.values(globals)) as Record<string, unknown>;
}

describe('scanExports', () => {
  it('reads every declaration form, with its JSDoc summary and parameters', () => {
    const source = [
      'type Mood = "happy" | "sad";',
      'const GREETING = "hi";',
      '',
      '/**',
      ' * Show a picture for a mood.',
      ' * Returns whether there was one.',
      ' *',
      ' * @param mood which one',
      ' */',
      'export async function cheer(mood: Mood, opts: { ms?: number } = {}) { return mood; }',
      '/** Shout it. */',
      'export const shout = (text: string): string => `${text}!`;',
      'export const typed: (n: number) => number = (n) => n;',
      'export const generic = <T,>(x: T) => x;',
      'export const one = x => x;',
      'export function* count() {}',
      '/** @internal Not for the character. */',
      'export let helper = function (a, b) { return a + b; };',
      'export const LIMIT = 3;',
      'export class Box {}',
      'export type Exported = string;',
      'export interface Shape {}',
      'function local(a: number) { return a; }',
      '/** Renamed. */',
      'const inner = async (q: string) => q;',
      'export { local, inner as outer, GREETING };',
      'export { roll } from "./dice";',
    ].join('\n');
    const shapes = Object.fromEntries(scanExports(source));
    expect(shapes).toEqual({
      cheer: { kind: 'function', params: 'mood: Mood, opts: { ms?: number } = {}', description: 'Show a picture for a mood. Returns whether there was one.' },
      shout: { kind: 'function', params: 'text: string', description: 'Shout it.' },
      typed: { kind: 'function', params: 'n' },
      generic: { kind: 'function', params: 'x: T' },
      one: { kind: 'function', params: 'x' },
      count: { kind: 'function', params: '' },
      helper: { kind: 'function', params: 'a, b', description: 'Not for the character.', internal: true },
      LIMIT: { kind: 'value', params: '' },
      Box: { kind: 'value', params: '' },
      local: { kind: 'function', params: 'a: number' },
      outer: { kind: 'function', params: 'q: string', description: 'Renamed.' },
      GREETING: { kind: 'value', params: '' },
      roll: { kind: 'unknown', params: '' },
    });
  });

  it('is not fooled by the word in strings, comments, properties or nested code', () => {
    const source = [
      '// export function no() {}',
      'const s = "export function no2() {}";',
      'const o = { export: 1 };',
      'function f() { const inside = 1; return o.export; }',
      'const t = `${"x"} export const no3 = 1`;',
      'export function yes() { return /export const no4/.test(s); }',
    ].join('\n');
    expect([...scanExports(source).keys()]).toEqual(['yes']);
    expect(hasExports(source)).toBe(true);
    expect(hasExports('async (x: number) => x')).toBe(false);
  });
});

describe('jsDocSummary and functionParams', () => {
  it('takes the first paragraph, on one line, and flags @internal', () => {
    expect(jsDocSummary(' Hello.\n * world\n *\n * more')).toEqual({ description: 'Hello. world', internal: false });
    expect(jsDocSummary(' @internal')).toEqual({ internal: true });
    expect(jsDocSummary(' Pick one. @internal')).toEqual({ description: 'Pick one. @internal', internal: true });
    expect(jsDocSummary(' @internal Roll a die.\n * @param n sides')).toEqual({ description: 'Roll a die.', internal: true });
  });

  it('reads the parameter list of any function form', () => {
    expect(functionParams('async (mood: string) => 1')).toBe('mood: string');
    expect(functionParams('x => x')).toBe('x');
    expect(functionParams('/* (a) => */ (b) => b')).toBe('b');
    expect(functionParams('(s = ")") => s')).toBe('s = ")"');
  });
});

describe('buildCharacterLibrary', () => {
  it('bundles the folder into one expression of its exports, private helpers included', async () => {
    const { library } = await buildCharacterLibrary(
      {
        'dice.ts': '/** @internal */\nexport function roll(n: number) { return n; }\nexport const SIDES = 6;',
        'games/play.ts': "import { roll, SIDES } from '../dice';\nconst twice = (n: number) => 2 * n;\n/** Roll. */\nexport async function play() { return twice(roll(SIDES)) + (await sdk.base()); }",
      },
      'characters/x/lib',
    );
    expect(library.problems).toEqual([]);
    expect(Object.keys(library.functions)).toEqual(['play', 'roll']); // SIDES is on lib, but not a function
    const exports = evaluate(library.code, { sdk: { base: async () => 1 } });
    expect(Object.keys(exports).sort()).toEqual(['SIDES', 'play', 'roll']);
    expect(await (exports['play'] as () => Promise<number>)()).toBe(13);
    expect('twice' in exports).toBe(false);
  });

  it('leaves out an export it cannot name, and says why', async () => {
    const { library } = await buildCharacterLibrary(
      {
        'a.ts': 'export default () => 1;\nexport const ok = () => 1;',
        'b.ts': "export const ok = () => 2;\nexport { ok as delete };",
        'old.ts': 'async (mood: string) => mood',
      },
      'lib',
    );
    expect(Object.keys(library.functions)).toEqual(['ok']);
    expect(library.functions['ok']!.file).toBe('lib/a.ts');
    expect(library.problems).toEqual([
      { file: 'lib/a.ts', message: expect.stringContaining('`export default` has no name') },
      { file: 'lib/b.ts', message: expect.stringContaining('lib.delete cannot be a library name') },
      { file: 'lib/b.ts', message: 'lib.ok is already exported by lib/a.ts: a name is exported by one file only (import it from there instead of re-exporting it)' },
      { file: 'lib/old.ts', message: expect.stringContaining('exports nothing') },
    ]);
    expect((evaluate(library.code)['ok'] as () => number)()).toBe(1);
  });

  it('has no code when no file exports anything', async () => {
    const { library } = await buildCharacterLibrary({ 'types.ts': 'export type Mood = "up";\nconst unused = 1;' }, 'lib');
    expect(library).toEqual({ files: { 'lib/types.ts': 'export type Mood = "up";\nconst unused = 1;' }, functions: {}, code: '', problems: [] });
  });

  it('refuses imports from outside the folder, and top-level await', async () => {
    const outside = await buildCharacterLibrary({ 'a.ts': "import fs from 'node:fs';\nexport const a = () => fs;" }, 'lib');
    expect(outside.library.problems).toEqual([{ file: 'lib/a.ts', line: 1, column: 16, message: expect.stringContaining('can only import other files of the library') }]);
    expect(outside.library.code).toBe('');
    const up = await buildCharacterLibrary({ 'a.ts': "import { b } from '../b';\nexport const a = () => b;" }, 'lib');
    expect(up.library.problems[0]!.message).toContain('outside the lib folder');
    const missing = await buildCharacterLibrary({ 'a.ts': "import { b } from './b';\nexport const a = () => b;" }, 'lib');
    expect(missing.library.problems[0]!.message).toContain('no such file');
    const awaited = await buildCharacterLibrary({ 'a.ts': 'const x = await sdk.state.get("x");\nexport const a = () => x;' }, 'lib');
    expect(awaited.library.problems[0]).toMatchObject({ file: 'lib/a.ts', line: 1 });
  });

  it('reuses the previous build when no file changed', async () => {
    const first = await buildCharacterLibrary({ 'a.ts': 'export const a = () => 1;' }, 'lib');
    const again = await buildCharacterLibrary({ 'a.ts': 'export const a = () => 1;' }, 'lib', { previous: first.library });
    expect(again.library).toBe(first.library);
    const changed = await buildCharacterLibrary({ 'a.ts': 'export const b = () => 1;' }, 'lib', { previous: first.library });
    expect(Object.keys(changed.library.functions)).toEqual(['b']);
  });
});
