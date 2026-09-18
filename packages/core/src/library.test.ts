import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json, LibFunction, LibFunctionInfo } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_TOTAL_BYTES } from '@rp/shared';
import { loadPack } from '@rp/pack';
import { createStandardRegistry } from '@rp/sdk';
import { PromptBuilder, libraryLine } from './prompt.js';
import type { PromptInput } from './prompt.js';
import { EMPTY_PRELUDE, LIB_STATE_KEY, buildPrelude, functionParams, functionSourceProblem, unwrapFunctionSource } from './services/library.js';
import { characterScope } from './handlers/state.js';
import { ECHO_REF, EXAMPLES_DIR, FakeSenses, LUNA_DIR, LUNA_ID, LUNA_REF, MINIMAL_DIR, MINIMAL_ID, createTestEngine, installLunaWith, runAction } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ctxOf = (packId: string, characterId: string, sessionId: string): ActionContext => ({
  packId,
  characterId,
  sessionId,
  packRoot: t!.engine.packs.getLoaded(packId).root,
  trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
});
const invoke = (context: ActionContext, method: string, ...args: Json[]) =>
  t!.engine.dispatcher.invoke({ callId: `lib.${method}`, module: 'lib', method, args, context });
/** Absolute path of a library file in the installed pack. */
const libFile = (packId: string, characterId: string, name: string) => path.join(t!.engine.packs.getLoaded(packId).root, 'characters', characterId, 'lib', `${name}.ts`);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
/** The functions the character itself may call — what `<library>` lists; the service also reports the author's internal helpers. */
const visible = async (packId: string, characterId: string): Promise<LibFunction[]> =>
  (await t!.engine.library.functions({ packId, characterId })).filter((f) => f.internal !== true);

/** Opening of the prompt section (the SDK index also mentions `<library>` in prose). */
const SECTION = '<library>\nYour own functions (call them as lib.<name>(...) or sdk.lib.<name>(...), the same object; lib.register adds or replaces one):';
/** What the sandbox sends for a function argument (docs/spec/sandbox.md §4). */
const asHandlerArg = (fn: string): string => `return await (${fn})(input);`;
const CHEER = `async (mood) => {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}`;

/** The other format: helpers of the file's own, and one export — the function the character calls. */
const CHEER_MODULE = `function pick(mood: string) {
  return { anyTags: [mood], kind: "image" } as const;
}

export default async (mood: string) => {
  const found = (await sdk.pack.findAssets(pick(mood)))[0];
  if (found) await sdk.media.showImage(found, { durationMs: 6000 });
  return Boolean(found);
};`;

describe('LibraryService helpers', () => {
  it('unwraps the sandbox handler wrapper and accepts a bare function expression', () => {
    expect(unwrapFunctionSource(asHandlerArg(CHEER))).toBe(CHEER);
    expect(unwrapFunctionSource(`  ${CHEER}\n`)).toBe(CHEER);
    expect(unwrapFunctionSource('return await (x => x)(input);')).toBe('x => x');
  });

  it('extracts parameters from arrow and function sources', () => {
    expect(functionParams('async (mood: string) => 1')).toBe('mood: string');
    expect(functionParams('(a,   b = f(1, 2),\n  ...rest: number[]) => a')).toBe('a, b = f(1, 2), ...rest: number[]');
    expect(functionParams('async function greet(name: string, times?: number) { return name; }')).toBe('name: string, times?: number');
    expect(functionParams('x => x * 2')).toBe('x');
    expect(functionParams('async x => x')).toBe('x');
    expect(functionParams('() => 1')).toBe('');
    expect(functionParams('(s = ")") => s')).toBe('s = ")"');
    // a comment above the function is skipped, even one holding a `(` or a `=>`
    expect(functionParams('// counts (up) to => 1\nasync (mood: string) => 1')).toBe('mood: string');
    expect(functionParams('/* helper (old) */\n// keep\nx => x')).toBe('x');
    expect(functionParams('// nothing but a comment')).toBe('');
  });

  it('accepts function expressions and rejects everything else, with the parser message', () => {
    expect(functionSourceProblem(CHEER)).toBeUndefined();
    expect(functionSourceProblem('async (mood: string): Promise<boolean> => true')).toBeUndefined();
    expect(functionSourceProblem('function (a, b) { return a + b; }')).toBeUndefined();
    expect(functionSourceProblem('async function named() {}')).toBeUndefined();
    expect(functionSourceProblem('x => x')).toBeUndefined();
    // comments in front of the function, and inside it, do not hide it
    expect(functionSourceProblem(`// cheer the mood up\n/* uses the pack's pictures */\n${CHEER}`)).toBeUndefined();
    expect(functionSourceProblem('// a note\nfunction (a, b) { return a + b; }')).toBeUndefined();
    expect(functionSourceProblem('async /* here */ (mood: string) => true')).toBeUndefined();
    expect(functionSourceProblem('// looks like a function: async (x) => 1')).toMatch(/does not parse/);
    expect(functionSourceProblem('// a note\n1 + 2')).toMatch(/function expression/);
    expect(functionSourceProblem('// a note\nx => 1); sdk.chat.emote("hi"); (y => 2')).toMatch(/single function expression/);
    expect(functionSourceProblem('')).toMatch(/function/);
    expect(functionSourceProblem('1 + 2')).toMatch(/function expression/);
    expect(functionSourceProblem('sdk.chat.emote("hi")')).toMatch(/function expression/);
    expect(functionSourceProblem('async ( => 1')).toMatch(/does not parse/);
    expect(functionSourceProblem('x => 1); (y => 2')).toMatch(/single function expression/);
    expect(functionSourceProblem('x => 1); await sdk.state.set("k", 1); (y => 2')).toMatch(/does not parse|single function expression/);
  });

  it('builds the prelude as the bootstrap library factory over parenthesised sources', () => {
    expect(buildPrelude([])).toBe(EMPTY_PRELUDE);
    const prelude = buildPrelude([
      { name: 'double', source: '(n: number) => n * 2', bytes: 1, updatedAt: 't' },
      { name: 'cheer', source: CHEER, bytes: 1, updatedAt: 't' },
    ]);
    expect(prelude.startsWith('const lib = __rp_lib({\n  "double": ((n: number) => n * 2),\n  "cheer": (async (mood) => {')).toBe(true);
    expect(prelude.endsWith('}),\n});')).toBe(true);
    // a function that opens with a comment still parses inside the parentheses the prelude puts round it
    const commented = buildPrelude([{ name: 'cheer', source: '// says hi\nasync (mood) => mood', bytes: 1, updatedAt: 't' }]);
    expect(commented).toBe('const lib = __rp_lib({\n  "cheer": (// says hi\nasync (mood) => mood),\n});');
    expect(() => new Function('__rp_lib', `${commented}\nreturn lib;`)).not.toThrow();
  });

  it('names the internal functions in the prelude instead of hiding them in a second scope', () => {
    const functions = [
      { name: 'pick', source: '(n: number) => n + 1', bytes: 1, updatedAt: 't', internal: true },
      { name: 'double', source: 'async (n: number) => lib.pick(n) * 2', bytes: 1, updatedAt: 't' },
    ];
    // One `lib` holding everything: a nested one would be renamed by the transpiler (lib -> lib2) and
    // that rename would travel into any handler a library function hands to sdk.events.on. The second
    // argument is what the sandbox refuses to the action body of an LLM run.
    expect(buildPrelude(functions)).toBe(
      ['const lib = __rp_lib({', '  "pick": ((n: number) => n + 1),', '  "double": (async (n: number) => lib.pick(n) * 2),', '}, ["pick"]);'].join('\n'),
    );
    expect(buildPrelude([functions[0]!])).toBe('const lib = __rp_lib({\n  "pick": ((n: number) => n + 1),\n}, ["pick"]);');
    // without an internal function there is no second argument at all
    expect(buildPrelude([functions[1]!])).toBe('const lib = __rp_lib({\n  "double": (async (n: number) => lib.pick(n) * 2),\n});');
    expect(buildPrelude([])).toBe(EMPTY_PRELUDE);
  });

  it('builds the prelude of a function written as a module out of its statements and its export', () => {
    const prelude = buildPrelude([{ name: 'cheer', source: CHEER_MODULE, bytes: 1, updatedAt: 't' }]);
    // the file's statements run once per run inside an arrow that hands the exported function over,
    // so `pick` belongs to `cheer` alone — it is not a second entry on `lib` and not a `<library>` line
    expect(prelude).toContain('"cheer": (() => {\nfunction pick(mood: string) {');
    expect(prelude).toContain('\n;return __rp_default;\n})(),');
    expect(prelude).not.toContain('export');
    // and it evaluates: the same shape in plain JavaScript (the sandbox transpiles the TypeScript one)
    const js = buildPrelude([{ name: 'shout', source: 'const mark = "!";\nexport default (t) => t + mark;', bytes: 1, updatedAt: 't' }]);
    expect(new Function('__rp_lib', `${js}\nreturn lib;`)((o) => o).shout('hi')).toBe('hi!');
  });

  it('reads the signature of a module function from its export, not from the first helper', () => {
    expect(functionParams(CHEER_MODULE)).toBe('mood: string');
    expect(functionParams('const n = 1;\nexport function greet(name: string, loud?: boolean) { return name; }')).toBe('name: string, loud?: boolean');
    expect(libraryLine({ name: 'cheer', source: CHEER_MODULE, description: 'show a picture for a mood' })).toBe('- lib.cheer(mood: string) — show a picture for a mood');
  });

  it('renders one prompt line per function', () => {
    expect(libraryLine({ name: 'cheer', source: 'async (mood: string) => 1', description: 'show a picture for a mood' })).toBe('- lib.cheer(mood: string) — show a picture for a mood');
    expect(libraryLine({ name: 'tick', source: '() => 1' })).toBe('- lib.tick()');
  });
});

describe('the lib module through the engine', () => {
  it('registers from a serialised function, writes the file, and validates input', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);

    const registered = (await invoke(ctx, 'register', 'cheer', asHandlerArg(CHEER), { description: '  show a picture for a mood ' })) as { ok: true; value: LibFunctionInfo };
    expect(registered.ok).toBe(true);
    expect(registered.value).toEqual({ name: 'cheer', description: 'show a picture for a mood', bytes: Buffer.byteLength(CHEER), updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    // saved into the installed pack as one file per function: a description comment, then the function as received
    expect(await fs.readFile(libFile(MINIMAL_ID, 'echo', 'cheer'), 'utf8')).toBe(`// show a picture for a mood\n${CHEER}\n`);
    // a string holding a function expression works too, and registering the name again replaces it
    expect((await invoke(ctx, 'register', 'double', '(n: number) => n * 2')).ok).toBe(true);
    expect((await invoke(ctx, 'register', 'double', 'async (n: number) => n + n', { description: 'twice' })).ok).toBe(true);
    expect((await visible(MINIMAL_ID, 'echo')).map((f) => [f.name, f.description])).toEqual([['cheer', 'show a picture for a mood'], ['double', 'twice']]);
    // the source is in the prelude the run sees (`String(lib.double)`), not behind a capability call
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toContain('"double": (async (n: number) => n + n)');
    expect(await fs.readFile(libFile(MINIMAL_ID, 'echo', 'double'), 'utf8')).toBe('// twice\nasync (n: number) => n + n\n');
    expect((await fs.readdir(path.dirname(libFile(MINIMAL_ID, 'echo', 'x')))).sort()).toEqual(['cheer.ts', 'double.ts']);
    // nothing goes into the character state any more; the loaded pack carries the library
    expect(await t.storage.state.get(characterScope(ctx), LIB_STATE_KEY)).toBeUndefined();
    expect(Object.keys(t.engine.packs.getLoaded(MINIMAL_ID).character.library)).toEqual(['cheer', 'double']);

    const bad = async (...args: Json[]) => ((await invoke(ctx, 'register', ...args)) as { ok: boolean; error?: { code: string; message: string } }).error;
    // `register` / `unregister` are the library object's own methods, so no saved function may take those names
    for (const name of ['', '1abc', 'a-b', 'class', 'await', '__proto__', 'x'.repeat(65), 'has space', 'register', 'unregister']) {
      expect((await bad(name, 'x => x'))?.code, name).toBe('INVALID_ARGUMENT');
    }
    expect((await bad('ok', 1))?.code).toBe('INVALID_ARGUMENT');
    expect((await bad('ok', '1 + 2'))?.message).toMatch(/function expression/);
    expect((await bad('ok', 'async ( => 1'))?.message).toMatch(/does not parse/);
    expect((await bad('ok', asHandlerArg('x => 1); (y => 2')))?.message).toMatch(/single function expression/);
    // No per-file size cap: only the total and the count are capped.
    expect((await invoke(ctx, 'register', 'big', `(x) => "${'a'.repeat(20 * 1024)}"`)).ok).toBe(true);
    expect(await invoke(ctx, 'unregister', 'big')).toEqual({ ok: true, value: true });
    // a string may hold a whole module: helpers in the file, one exported function to call
    expect((await invoke(ctx, 'register', 'shout', 'function mark(t: string) { return t + "!"; }\nexport default (t: string) => mark(t);')).ok).toBe(true);
    expect(await fs.readFile(libFile(MINIMAL_ID, 'echo', 'shout'), 'utf8')).toBe('function mark(t: string) { return t + "!"; }\nexport default (t: string) => mark(t);\n');
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toContain('"shout": (() => {\nfunction mark(t: string)');
    expect((await bad('ok', 'export default 1;\nexport default 2;'))?.message).toMatch(/exports more than one thing/);
    expect((await bad('ok', 'import { x } from "./x";\nexport default () => x;'))?.message).toMatch(/cannot `import` anything/);
    expect(await invoke(ctx, 'unregister', 'shout')).toEqual({ ok: true, value: true });
    expect((await bad('ok', 'x => x', { description: 5 }))?.code).toBe('INVALID_ARGUMENT');
    expect((await bad('ok', 'x => x', { internal: 'yes' }))?.code).toBe('INVALID_ARGUMENT');
    expect(await invoke(ctx, 'nope')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    // the old capability methods are gone: `lib.<name>` is the function itself now
    for (const method of ['define', 'remove', 'list', 'source']) {
      expect(await invoke(ctx, method, 'cheer'), method).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    }
    expect((await visible(MINIMAL_ID, 'echo')).map((f) => f.name)).toEqual(['cheer', 'double']);
  });

  it('caps the number of functions and their total size', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    for (let i = 0; i < LIB_MAX_FUNCTIONS; i++) expect((await invoke(ctx, 'register', `f${i}`, '() => 1')).ok, `f${i}`).toBe(true);
    expect(await invoke(ctx, 'register', 'oneMore', '() => 1')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining(String(LIB_MAX_FUNCTIONS)) } });
    expect((await invoke(ctx, 'register', 'f0', '() => 2')).ok).toBe(true); // replacing is fine at the cap
    expect(await invoke(ctx, 'unregister', 'f1')).toEqual({ ok: true, value: true });
    expect((await invoke(ctx, 'register', 'oneMore', '() => 1')).ok).toBe(true);

    for (const f of await visible(MINIMAL_ID, 'echo')) expect(await invoke(ctx, 'unregister', f.name)).toEqual({ ok: true, value: true });
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
    const big = `() => "${'b'.repeat(4000)}"`;
    let defined = 0;
    let error: { code: string; message: string } | undefined;
    for (let i = 0; i < LIB_MAX_FUNCTIONS; i++) {
      const r = (await invoke(ctx, 'register', `f${i}`, big)) as { ok: boolean; error?: { code: string; message: string } };
      if (!r.ok) {
        error = r.error;
        break;
      }
      defined += 1;
    }
    expect(defined).toBe(Math.floor(LIB_MAX_TOTAL_BYTES / Buffer.byteLength(big)));
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('in total') });
  }, 20_000);

  it('prepends the prelude to LLM actions, and lists the library in the prompt after <sdk_reference>', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Saving that.', toolCalls: [runAction('await lib.register("cheer", async (mood: string) => {}, { description: "show a picture for a mood" }); return 1;', 'register', 'tu_1')] },
        { text: 'Done.' },
        { text: 'Cheering.', toolCalls: [runAction('return await lib.cheer("happy");', 'cheer', 'tu_2')] },
        { text: 'Cheered.' },
      ],
      runnerHandler: async (request, runner) => {
        if (request.code.includes('lib.register')) {
          await runner.call(request, 'lib', 'register', 'cheer', asHandlerArg('async (mood: string) => {\n}'), { description: 'show a picture for a mood' });
          return 1;
        }
        return true;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    await t.engine.chat.send(session.id, 'remember how to cheer');
    const first = t.runner.requests[0]!;
    expect(first.code).toContain('lib.register');
    expect(first.prelude).toBe(EMPTY_PRELUDE); // nothing defined yet when the turn started
    expect(t.provider.requests[0]!.system).not.toContain(SECTION);

    await t.engine.chat.send(session.id, 'cheer me up');
    const second = t.runner.requests[1]!;
    expect(second.code).toBe('return await lib.cheer("happy");');
    expect(second.prelude).toBe('const lib = __rp_lib({\n  "cheer": (async (mood: string) => {\n}),\n});');
    const system = t.provider.requests[2]!.system;
    expect(system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n</library>`);
    expect(system.indexOf(SECTION)).toBeGreaterThan(system.indexOf('</sdk_reference>'));
    expect(system.indexOf(SECTION)).toBeLessThan(system.indexOf('\n<memory>\n<state>'));
    // the raw sources stay out of <state>
    expect(system).not.toContain(LIB_STATE_KEY);
    expect(system).toContain('lib.register and call it as lib.<name>(...)');
    expect(system).toContain('there is no sdk.lib.define');
  });

  it('prepends the prelude to timer handlers, event handlers and behaviour hooks, and drops it after unregister', async () => {
    const senses = new FakeSenses();
    t = await createTestEngine({ senses, script: [{ text: 'ok' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    expect((await invoke(ctx, 'register', 'double', asHandlerArg('(n) => n * 2'))).ok).toBe(true);
    const expected = 'const lib = __rp_lib({\n  "double": ((n) => n * 2),\n});';
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(expected);

    // timers.runLater
    const timerCall = { callId: 'timers.runLater', module: 'timers', method: 'runLater', args: [5000, asHandlerArg('async (input) => lib.double(input.n)'), { input: { n: 2 } }] as Json[], context: ctx };
    expect((await t.engine.dispatcher.invoke(timerCall)).ok).toBe(true);
    t.clock.advance(5000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    const timerRun = t.runner.requests.find((r) => r.context.trigger.kind === 'timer');
    expect(timerRun?.prelude).toBe(expected);
    expect(timerRun?.code).toContain('lib.double(input.n)');

    // events.on
    const eventCall = { callId: 'events.on', module: 'events', method: 'on', args: ['custom:ping', asHandlerArg('async (input) => lib.double(1)')] as Json[], context: ctx };
    expect((await t.engine.dispatcher.invoke(eventCall)).ok).toBe(true);
    await t.engine.dispatcher.invoke({ callId: 'events.emit', module: 'events', method: 'emit', args: ['ping', { n: 1 }], context: ctx });
    await t.engine.eventService.idle();
    const eventRun = t.runner.requests.find((r) => r.context.trigger.kind === 'event');
    expect(eventRun?.prelude).toBe(expected);

    // behaviour hook (onUserMessage)
    const pack = t.engine.packs.getLoaded(MINIMAL_ID);
    pack.characters[0]!.behaviourSources.onUserMessage = 'return { skipLlm: true };';
    await t.engine.chat.send(session.id, 'hi');
    const hookRun = t.runner.requests.find((r) => r.context.trigger.kind === 'behaviour');
    expect(hookRun?.prelude).toBe(expected);

    // unregister deletes the file and invalidates the cached prelude
    expect(await exists(libFile(MINIMAL_ID, 'echo', 'double'))).toBe(true);
    expect(await invoke(ctx, 'unregister', 'double')).toEqual({ ok: true, value: true });
    expect(await exists(libFile(MINIMAL_ID, 'echo', 'double'))).toBe(false);
    expect(await invoke(ctx, 'unregister', 'double')).toEqual({ ok: true, value: false });
    expect(await invoke(ctx, 'unregister', 'not-a-name')).toEqual({ ok: true, value: false });
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
    expect(await t.storage.state.get(characterScope(ctx), LIB_STATE_KEY)).toBeUndefined();
  });

  it('lists functions the pack author shipped as lib/<name>.ts and puts them in the prelude from the first install', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir, { extraFiles: {
      'characters/luna/lib/wave.ts': '// wave at the user\nasync (times: number) => {\n  await sdk.chat.emote(`waves ${times}x`);\n  return times;\n}\n',
      'characters/luna/lib/broken.ts': 'async ( => 1',
    } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);
    expect(await visible(LUNA_ID, 'luna')).toEqual([{ name: 'wave', description: 'wave at the user', source: 'async (times: number) => {\n  await sdk.chat.emote(`waves ${times}x`);\n  return times;\n}', bytes: expect.any(Number), updatedAt: expect.any(String) }]);
    expect(await t.engine.library.preludeFor(LUNA_ID, 'luna')).toBe('const lib = __rp_lib({\n  "wave": (async (times: number) => {\n  await sdk.chat.emote(`waves ${times}x`);\n  return times;\n}),\n});');
    // the character's own registrations land next to the shipped one, and replacing a shipped one rewrites its file
    expect((await invoke(ctx, 'register', 'tick', '() => 1')).ok).toBe(true);
    expect((await invoke(ctx, 'register', 'wave', '() => 0', { description: 'quieter' })).ok).toBe(true);
    expect(await fs.readFile(libFile(LUNA_ID, 'luna', 'wave'), 'utf8')).toBe('// quieter\n() => 0\n');
    expect((await visible(LUNA_ID, 'luna')).map((f) => f.name)).toEqual(['tick', 'wave']);
    expect(await t.engine.library.preludeFor(LUNA_ID, 'luna')).toContain('"tick": (() => 1)');

    // the makima example ships characters/makima/lib/glance.ts
    await t.engine.packs.install(path.join(EXAMPLES_DIR, 'makima'));
    await t.engine.sessions.create({ characterRef: 'com.example.makima/makima' });
    const glance = await visible('com.example.makima', 'makima');
    expect(glance.find((f) => f.name === 'glance')).toMatchObject({ description: 'show a random portrait of Makima for five seconds and return its path' });
    // the mini games and their helpers ship alongside it (examples/packs/makima/README.md)
    expect(glance.map((f) => f.name)).toEqual(['endGame', 'gameLost', 'gameSetup', 'glance', 'memoryGame', 'molePop', 'punish', 'quitGame', 'reactionTest', 'reward', 'simonSays', 'slidingPuzzle', 'whackAMole', 'writeLines']);
    const prelude = await t.engine.library.preludeFor('com.example.makima', 'makima');
    expect(prelude).toMatch(/^const lib = __rp_lib\(\{\n  "endGame": \(async \(/);
    expect(prelude).toContain('\n  "glance": (async () => {');
  });

  it('keeps an author\'s internal helper out of the character\'s reach, but in the prelude of its own functions and hooks', async () => {
    t = await createTestEngine({ script: [{ text: 'ok' }] });
    await installLunaWith(t.engine, t.packsDir, { extraFiles: {
      'characters/luna/lib/pick.ts': '// @internal pick a picture for a mood\n(mood: string) => mood\n',
      'characters/luna/lib/cheer.ts': '// cheer the user up\nasync (mood: string) => lib.pick(mood)\n',
    } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);

    // the library the character is told about, and may reach, leaves it out
    expect((await visible(LUNA_ID, 'luna')).map((f) => f.name)).toEqual(['cheer']);

    // the character cannot take the name over blind: only a call that says `internal` too replaces it
    expect(await invoke(ctx, 'register', 'pick', '() => 1')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('reserved') } });
    expect(await exists(libFile(LUNA_ID, 'luna', 'pick'))).toBe(true);
    expect(await fs.readFile(libFile(LUNA_ID, 'luna', 'pick'), 'utf8')).toBe('// @internal pick a picture for a mood\n(mood: string) => mood\n');

    // every run gets the same prelude: one `lib` with both functions on it, `pick` named as internal
    const prelude = await t.engine.library.preludeFor(LUNA_ID, 'luna');
    expect(prelude).toBe('const lib = __rp_lib({\n  "cheer": (async (mood: string) => lib.pick(mood)),\n  "pick": ((mood: string) => mood),\n}, ["pick"]);');

    const pack = t.engine.packs.getLoaded(LUNA_ID);
    pack.characters[0]!.behaviourSources.onUserMessage = 'await lib.pick("happy");\nreturn { skipLlm: true };';
    await t.engine.chat.send(session.id, 'hi');
    const hookRun = t.runner.requests.find((r) => r.context.trigger.kind === 'behaviour');
    expect(hookRun?.prelude).toBe(prelude);
    // code the character wrote itself (a `code` timer) gets that same prelude
    const timerCall = { callId: 'timers.runLater', module: 'timers', method: 'runLater', args: [5000, asHandlerArg('async () => 1'), {}] as Json[], context: ctx };
    expect((await t.engine.dispatcher.invoke(timerCall)).ok).toBe(true);
    t.clock.advance(5000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    expect(t.runner.requests.find((r) => r.context.trigger.kind === 'timer')?.prelude).toBe(prelude);

    // and the prompt lists only what the character may call
    const system = t.provider.requests.at(-1)?.system ?? '';
    expect(system).toContain(`${SECTION}\n- lib.cheer(mood: string) — cheer the user up\n</library>`);
    expect(system).not.toContain('lib.pick');

    // a helper the character registers itself is hidden the same way, and it can take that one back
    expect((await invoke(ctx, 'register', 'pick', '() => 2', { internal: true, description: 'mine now' })).ok).toBe(true);
    expect(await fs.readFile(libFile(LUNA_ID, 'luna', 'pick'), 'utf8')).toBe('// @internal mine now\n() => 2\n');
    expect((await visible(LUNA_ID, 'luna')).map((f) => f.name)).toEqual(['cheer']);
    expect(await invoke(ctx, 'unregister', 'pick')).toEqual({ ok: true, value: true });
    expect(await exists(libFile(LUNA_ID, 'luna', 'pick'))).toBe(false);
  });

  it('lets an event handler a library function installed reach the library\'s internal helpers', async () => {
    // The shape a game in a pack has: a public starter subscribes, and the handler it hands to
    // sdk.events.on calls the author's internal helper when the widget reports a move.
    t = await createTestEngine({ runnerHandler: async () => null });
    await installLunaWith(t.engine, t.packsDir, { extraFiles: {
      'characters/luna/lib/gameLost.ts': '// @internal (games) the loss path\nasync (d: any) => d\n',
      'characters/luna/lib/startGame.ts': '// (game) start a round\nasync () => "started"\n',
    } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);

    const on = { callId: 'events.on', module: 'events', method: 'on', context: ctx,
      args: ['widget-message', 'return await lib.gameLost({ over: true });', { label: 'game:test' }] as Json[] };
    expect((await t.engine.dispatcher.invoke(on)).ok).toBe(true);
    t.engine.hostEvents.emit({ name: 'widget-message', data: { widgetId: 'g' }, at: t.clock.now().toISOString() });
    await t.engine.eventService.idle();

    // the handler ran, against the one prelude that carries the helper — no second scope to fall out of
    const eventRun = t.runner.requests.find((r) => r.context.trigger.kind === 'event');
    expect(eventRun?.prelude).toBe(await t.engine.library.preludeFor(LUNA_ID, 'luna'));
    expect(eventRun?.prelude).toContain('"gameLost"');
    // and the prompt still leaves it out
    expect((await visible(LUNA_ID, 'luna')).map((f) => f.name)).toEqual(['startGame']);
  });

  it('migrates functions still stored in character state into files on start and on install', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const target = { packId: MINIMAL_ID, characterId: 'echo' };
    const scope = characterScope(target);
    // an older app left these in state; `double` already has a file, which wins
    await t.storage.state.set(scope, LIB_STATE_KEY, {
      cheer: { name: 'cheer', source: CHEER, description: 'show a picture for a mood', bytes: Buffer.byteLength(CHEER), updatedAt: 't' },
      double: { name: 'double', source: '(n) => n * 2', bytes: 12, updatedAt: 't' },
      'bad name': { name: 'bad name', source: '() => 1', bytes: 7, updatedAt: 't' },
      junk: 'not a function',
    });
    await fs.mkdir(path.dirname(libFile(MINIMAL_ID, 'echo', 'double')), { recursive: true });
    await fs.writeFile(libFile(MINIMAL_ID, 'echo', 'double'), '// from a file\n(n: number) => n + n\n');
    await t.engine.packs.start();
    expect(await t.storage.state.get(scope, LIB_STATE_KEY)).toBeUndefined();
    expect((await fs.readdir(path.dirname(libFile(MINIMAL_ID, 'echo', 'x')))).sort()).toEqual(['cheer.ts', 'double.ts']);
    expect(await fs.readFile(libFile(MINIMAL_ID, 'echo', 'cheer'), 'utf8')).toBe(`// show a picture for a mood\n${CHEER}\n`);
    expect(await fs.readFile(libFile(MINIMAL_ID, 'echo', 'double'), 'utf8')).toBe('// from a file\n(n: number) => n + n\n');
    expect((await visible(MINIMAL_ID, 'echo')).map((f) => [f.name, f.description])).toEqual([['cheer', 'show a picture for a mood'], ['double', 'from a file']]);
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toContain('"double": ((n: number) => n + n)');

    // on (re)install the folder is replaced, so state left behind is migrated into the fresh copy too
    await t.storage.state.set(scope, LIB_STATE_KEY, { tick: { name: 'tick', source: '() => 1', bytes: 7, updatedAt: 't' } });
    await t.engine.packs.install(MINIMAL_DIR);
    expect(await t.storage.state.get(scope, LIB_STATE_KEY)).toBeUndefined();
    expect((await visible(MINIMAL_ID, 'echo')).map((f) => f.name)).toEqual(['tick']); // cheer/double lived only in the replaced folder
  });

  it('survives across sessions of the same character and is invisible to another character', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.packs.install(LUNA_DIR);
    const first = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect((await invoke(ctxOf(MINIMAL_ID, 'echo', first.id), 'register', 'double', '(n: number) => n * 2')).ok).toBe(true);

    await t.engine.sessions.remove(first.id);
    const second = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect(second.id).not.toBe(first.id);
    expect((await visible(MINIMAL_ID, 'echo')).map((f) => f.name)).toEqual(['double']);
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toContain('"double"');

    await t.engine.sessions.create({ characterRef: LUNA_REF });
    expect(await visible(LUNA_ID, 'luna')).toEqual([]);
    expect(await t.engine.library.preludeFor(LUNA_ID, 'luna')).toBe(EMPTY_PRELUDE);
  });
});

describe('PromptBuilder <library>', () => {
  it('adds the section with parameters only when the library is non-empty, in the dynamic tail', async () => {
    const pack = await loadPack(LUNA_DIR);
    const base: PromptInput = {
      pack,
      character: pack.characters[0]!,
      registry: createStandardRegistry(),
      sdkSelection: { modules: ['chat', 'lib', 'state', 'pack', 'timers'] },
      session: { id: 's1', characterRef: LUNA_REF, title: 'x', createdAt: 't', updatedAt: 't' } as PromptInput['session'],
      transcript: [],
      state: {},
      timers: [],
      userDisplayName: 'Sam',
      contextTokenBudget: 24_000,
      useTools: true,
      now: new Date('2026-01-01T11:00:00.000Z'),
    };
    const empty = new PromptBuilder().build({ ...base, library: [] });
    expect(empty.system).not.toContain(SECTION);
    const built = new PromptBuilder().build({
      ...base,
      library: [
        { name: 'cheer', source: 'async (mood: string) => {\n  return 1;\n}', description: 'show a picture for a mood', bytes: 10, updatedAt: 't' },
        { name: 'tick', source: '() => 1', bytes: 7, updatedAt: 't' },
      ],
    });
    expect(built.system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n- lib.tick()\n</library>`);
    // an internal helper is never listed; a library holding nothing else gets no section at all
    const withHelper = new PromptBuilder().build({
      ...base,
      library: [
        { name: 'cheer', source: 'async (mood: string) => 1', description: 'show a picture for a mood', bytes: 10, updatedAt: 't' },
        { name: 'pick', source: '(mood: string) => mood', description: 'pick a picture', bytes: 10, updatedAt: 't', internal: true },
      ],
    });
    expect(withHelper.system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n</library>`);
    expect(withHelper.system).not.toContain('lib.pick');
    expect(new PromptBuilder().build({ ...base, library: [{ name: 'pick', source: '(mood: string) => mood', bytes: 10, updatedAt: 't', internal: true }] }).system).not.toContain(SECTION);
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.stablePrefixLength);
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.system.indexOf('</sdk_reference>'));
    expect(built.system.slice(0, built.stablePrefixLength)).not.toContain(SECTION);
  });
});
