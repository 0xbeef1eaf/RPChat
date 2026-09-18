import { describe, expect, it } from 'vitest';
import {
  exportedFunctionSource,
  functionSourceProblem,
  isLibraryModule,
  libraryFunctionShape,
  libraryValueExpression,
  unwrapFunctionSource,
} from './library-source.js';

/** Run a prelude value the way the sandbox does: transpiled inside a function body, with `sdk` in scope. */
async function callValue(source: string, sdk: unknown, ...args: unknown[]): Promise<unknown> {
  const { transformSync } = await import('esbuild');
  const js = transformSync(`return ${libraryValueExpression(source)};`, { loader: 'ts', target: 'es2020' }).code;
  const fn = new Function('sdk', js)(sdk) as (...a: unknown[]) => unknown;
  return fn(...args);
}

describe('a bare function expression', () => {
  it('is the whole source, and stays exactly that in the prelude', () => {
    const source = 'async (mood: string) => {\n  return mood;\n}';
    expect(functionSourceProblem(source)).toBeUndefined();
    expect(isLibraryModule(source)).toBe(false);
    expect(exportedFunctionSource(source)).toBe(source);
    expect(libraryValueExpression(source)).toBe(`(${source})`);
  });

  it('is refused when it is not one function, with the module format offered', () => {
    expect(functionSourceProblem('x => 1); (y => 2')).toBe('fn must be a single function expression (arrow function or `async function`)');
    expect(functionSourceProblem('sdk.chat.say("hi")')).toMatch(/not a call or a value/);
    // helpers beside the function, but no export to say which one the character calls
    expect(functionSourceProblem('function helper() { return 1; }\n() => helper()')).toMatch(/more than one statement: export the function to call/);
    expect(functionSourceProblem('const a = 1;\nasync ( => 1')).toMatch(/^fn does not parse: /);
    expect(functionSourceProblem('')).toBe('fn must be a function');
  });
});

describe('a module with one export', () => {
  const source = [
    'const GREETING = "hi";',
    '',
    'function shout(text: string): string {',
    '  return `${text.toUpperCase()}!`;',
    '}',
    '',
    'export default async (name: string) => {',
    '  return shout(`${GREETING} ${name}`);',
    '};',
  ].join('\n');

  it('loads, and reports the exported function as the one the character calls', () => {
    expect(functionSourceProblem(source)).toBeUndefined();
    expect(isLibraryModule(source)).toBe(true);
    expect(exportedFunctionSource(source)).toBe('async (name: string) => {\n  return shout(`${GREETING} ${name}`);\n}');
  });

  it('keeps the helpers in the prelude value and hands back the export', async () => {
    const value = libraryValueExpression(source);
    expect(value).toContain('function shout(text: string)');
    expect(value).not.toContain('export');
    expect(await callValue(source, {}, 'ada')).toBe('HI ADA!');
  });

  it('runs its statements once per run, not once per call', async () => {
    const counted = 'let calls = 0;\ncalls += 1;\nexport default () => calls;';
    expect(await callValue(counted, {})).toBe(1);
  });

  it('takes every export form, and a named default keeps its name', async () => {
    const forms: Array<[string, unknown]> = [
      ['export default function greet() { return "a"; }', 'a'],
      ['export default async function () { return "b"; }', 'b'],
      ['export function greet() { return "c"; }', 'c'],
      ['export async function greet() { return "d"; }', 'd'],
      ['export const greet = () => "e";', 'e'],
      ['const inner = () => "f";\nexport const greet = () => inner();', 'f'],
      ['export default function fact(n: number) { return n <= 1 ? 1 : n * fact(n - 1); }', undefined],
    ];
    for (const [form, expected] of forms) {
      expect(functionSourceProblem(form), form).toBeUndefined();
      if (expected !== undefined) expect(await callValue(form, {}), form).toBe(expected);
    }
    // the default export of a named declaration is reachable by its own name inside the file
    expect(await callValue(forms[6]![0], {}, 4)).toBe(24);
  });

  it('lets the exported function use sdk and its file-local helpers', async () => {
    const said: string[] = [];
    const withSdk = [
      '// @internal not the description, just a comment',
      'async function say(sdkText: string) {',
      '  await sdk.chat.say(sdkText);',
      '}',
      'export default async (text: string) => {',
      '  await say(text);',
      '  return true;',
      '};',
    ].join('\n');
    const sdk = { chat: { say: (t: string) => void said.push(t) } };
    expect(await callValue(withSdk, sdk, 'hello')).toBe(true);
    expect(said).toEqual(['hello']);
  });

  it('erases a type-only export without taking it for the function', () => {
    const typed = 'export type Mood = "up" | "down";\nexport interface Opts { mood: Mood }\nexport default (o: Opts) => o.mood;';
    expect(functionSourceProblem(typed)).toBeUndefined();
    expect(libraryValueExpression(typed)).toContain('type Mood');
    expect(libraryValueExpression(typed)).not.toContain('export');
    expect(exportedFunctionSource(typed)).toBe('(o: Opts) => o.mood');
  });

  it('refuses a second export, a non-function export and an import', () => {
    expect(functionSourceProblem('export const a = () => 1;\nexport const b = () => 2;')).toMatch(/exports more than one thing/);
    expect(functionSourceProblem('export default 42;')).toMatch(/must be a function/);
    expect(functionSourceProblem('export default sdk.chat.say("hi");')).toMatch(/must be a function/);
    expect(functionSourceProblem('const a = () => 1;\nexport { a };')).toMatch(/not a function the character can call/);
    expect(functionSourceProblem('export * from "./other";')).toMatch(/not a function the character can call/);
    expect(functionSourceProblem('export class Greeter {}')).toMatch(/not a function the character can call/);
    expect(functionSourceProblem('import { x } from "./x";\nexport default () => x;')).toMatch(/cannot `import` anything/);
    expect(functionSourceProblem('export default () => {')).toMatch(/the file does not parse: /);
    // a module may await at its top level; the prelude runs the file inside a function, which may not
    expect(functionSourceProblem('const now = await Promise.resolve(1);\nexport default () => now;')).toMatch(/Top-level await/);
    expect(isLibraryModule('export default 42;')).toBe(true);
  });

  it('still allows dynamic import() and a property called export', () => {
    expect(functionSourceProblem('export default async () => (await import("./x")).y;')).toBeUndefined();
    expect(functionSourceProblem('const o = { export: 1 };\nexport default () => o.export;')).toBeUndefined();
  });

  it('is not fooled by the word export inside a string, a comment or a regular expression', () => {
    const inText = [
      '// an export default in a comment',
      'const note = "export default nothing";',
      'const pattern = /export default/g;',
      'const quote = `an ${note} export default`;',
      'export default () => note.replace(pattern, quote);',
    ].join('\n');
    expect(functionSourceProblem(inText)).toBeUndefined();
    expect(exportedFunctionSource(inText)).toBe('() => note.replace(pattern, quote)');
    expect(libraryValueExpression(inText)).toContain('"export default nothing"');
  });

  it('is not desynchronised by a quote inside a regular expression', () => {
    const tricky = "const strip = (s: string) => s.replace(/'/g, '');\nexport default (s: string) => strip(s);";
    expect(functionSourceProblem(tricky)).toBeUndefined();
    expect(exportedFunctionSource(tricky)).toBe('(s: string) => strip(s)');
  });
});

describe('what lib.register receives', () => {
  it('unwraps a serialised function argument, and takes a module string as it stands', () => {
    expect(unwrapFunctionSource('return await ((mood) => mood)(input);')).toBe('(mood) => mood');
    const module = 'function helper() { return 1; }\nexport default () => helper();';
    expect(unwrapFunctionSource(module)).toBe(module);
    expect(functionSourceProblem(module)).toBeUndefined();
  });
});

describe('a source with no shape', () => {
  it('falls back to the bare expression, which the loader and register refuse first', () => {
    expect(libraryFunctionShape('export default 42;')).toMatchObject({ problem: expect.any(String), module: true });
    expect(libraryValueExpression('export default 42;')).toBe('(export default 42;)');
    expect(exportedFunctionSource('export default 42;')).toBe('export default 42;');
  });
});
