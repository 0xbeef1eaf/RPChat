import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json, LibFunctionInfo } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_SOURCE_BYTES, LIB_MAX_TOTAL_BYTES } from '@rp/shared';
import { loadPack } from '@rp/pack';
import { createStandardRegistry } from '@rp/sdk';
import { PromptBuilder, libraryLine } from './prompt.js';
import type { PromptInput } from './prompt.js';
import { EMPTY_PRELUDE, LIB_STATE_KEY, buildPrelude, functionParams, functionSourceProblem, unwrapFunctionSource } from './services/library.js';
import { characterScope } from './handlers/state.js';
import { ECHO_REF, FakeSenses, LUNA_DIR, LUNA_ID, LUNA_REF, MINIMAL_DIR, MINIMAL_ID, createTestEngine, runAction } from './test/helpers.js';
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

/** Opening of the prompt section (the SDK index also mentions `<library>` in prose). */
const SECTION = '<library>\nYour own functions (call them as lib.<name>(...); sdk.lib.define adds or replaces one):';
/** What the sandbox sends for a function argument (docs/spec/sandbox.md §4). */
const asHandlerArg = (fn: string): string => `return await (${fn})(input);`;
const CHEER = `async (mood) => {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}`;

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
  });

  it('accepts function expressions and rejects everything else, with the parser message', () => {
    expect(functionSourceProblem(CHEER)).toBeUndefined();
    expect(functionSourceProblem('async (mood: string): Promise<boolean> => true')).toBeUndefined();
    expect(functionSourceProblem('function (a, b) { return a + b; }')).toBeUndefined();
    expect(functionSourceProblem('async function named() {}')).toBeUndefined();
    expect(functionSourceProblem('x => x')).toBeUndefined();
    expect(functionSourceProblem('')).toMatch(/function/);
    expect(functionSourceProblem('1 + 2')).toMatch(/function expression/);
    expect(functionSourceProblem('sdk.chat.say("hi")')).toMatch(/function expression/);
    expect(functionSourceProblem('async ( => 1')).toMatch(/does not parse/);
    expect(functionSourceProblem('x => 1); (y => 2')).toMatch(/single function expression/);
    expect(functionSourceProblem('x => 1); await sdk.state.set("k", 1); (y => 2')).toMatch(/does not parse|single function expression/);
  });

  it('builds the prelude as a frozen object of parenthesised sources', () => {
    expect(buildPrelude([])).toBe(EMPTY_PRELUDE);
    const prelude = buildPrelude([
      { name: 'double', source: '(n: number) => n * 2', bytes: 1, updatedAt: 't' },
      { name: 'cheer', source: CHEER, bytes: 1, updatedAt: 't' },
    ]);
    expect(prelude.startsWith('const lib = Object.freeze({\n  "double": ((n: number) => n * 2),\n  "cheer": (async (mood) => {')).toBe(true);
    expect(prelude.endsWith('}),\n});')).toBe(true);
  });

  it('renders one prompt line per function', () => {
    expect(libraryLine({ name: 'cheer', source: 'async (mood: string) => 1', description: 'show a picture for a mood' })).toBe('- lib.cheer(mood: string) — show a picture for a mood');
    expect(libraryLine({ name: 'tick', source: '() => 1' })).toBe('- lib.tick()');
  });
});

describe('sdk.lib through the engine', () => {
  it('defines from a serialised function, lists and returns the source, and validates input', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);

    const defined = (await invoke(ctx, 'define', 'cheer', asHandlerArg(CHEER), { description: '  show a picture for a mood ' })) as { ok: true; value: LibFunctionInfo };
    expect(defined.ok).toBe(true);
    expect(defined.value).toEqual({ name: 'cheer', description: 'show a picture for a mood', bytes: Buffer.byteLength(CHEER), updatedAt: t.clock.now().toISOString() });
    expect(await invoke(ctx, 'source', 'cheer')).toEqual({ ok: true, value: CHEER });
    // a string holding a function expression works too, and redefining replaces
    expect((await invoke(ctx, 'define', 'double', '(n: number) => n * 2')).ok).toBe(true);
    expect((await invoke(ctx, 'define', 'double', 'async (n: number) => n + n', { description: 'twice' })).ok).toBe(true);
    const listed = (await invoke(ctx, 'list')) as { ok: true; value: LibFunctionInfo[] };
    expect(listed.value.map((f) => [f.name, f.description])).toEqual([['cheer', 'show a picture for a mood'], ['double', 'twice']]);
    expect(await invoke(ctx, 'source', 'double')).toEqual({ ok: true, value: 'async (n: number) => n + n' });
    expect(await invoke(ctx, 'source', 'nope')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // stored in the character scope, under one key
    const stored = await t.storage.state.get(characterScope(ctx), LIB_STATE_KEY);
    expect(Object.keys(stored as Record<string, unknown>)).toEqual(['cheer', 'double']);

    const bad = async (...args: Json[]) => ((await invoke(ctx, 'define', ...args)) as { ok: boolean; error?: { code: string; message: string } }).error;
    for (const name of ['', '1abc', 'a-b', 'class', 'await', '__proto__', 'x'.repeat(65), 'has space']) {
      expect((await bad(name, 'x => x'))?.code, name).toBe('INVALID_ARGUMENT');
    }
    expect((await bad('ok', 1))?.code).toBe('INVALID_ARGUMENT');
    expect((await bad('ok', '1 + 2'))?.message).toMatch(/function expression/);
    expect((await bad('ok', 'async ( => 1'))?.message).toMatch(/does not parse/);
    expect((await bad('ok', asHandlerArg('x => 1); (y => 2')))?.message).toMatch(/single function expression/);
    expect((await bad('ok', `(x) => "${'a'.repeat(LIB_MAX_SOURCE_BYTES)}"`))?.message).toMatch(/bytes/);
    expect((await bad('ok', 'x => x', { description: 5 }))?.code).toBe('INVALID_ARGUMENT');
    expect((await invoke(ctx, 'list')) as { value: LibFunctionInfo[] }).toMatchObject({ value: [{ name: 'cheer' }, { name: 'double' }] });
  });

  it('caps the number of functions and their total size', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    for (let i = 0; i < LIB_MAX_FUNCTIONS; i++) expect((await invoke(ctx, 'define', `f${i}`, '() => 1')).ok, `f${i}`).toBe(true);
    expect(await invoke(ctx, 'define', 'oneMore', '() => 1')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining(String(LIB_MAX_FUNCTIONS)) } });
    expect((await invoke(ctx, 'define', 'f0', '() => 2')).ok).toBe(true); // replacing is fine at the cap
    expect(await invoke(ctx, 'remove', 'f1')).toEqual({ ok: true, value: true });
    expect((await invoke(ctx, 'define', 'oneMore', '() => 1')).ok).toBe(true);

    for (const f of ((await invoke(ctx, 'list')) as { value: LibFunctionInfo[] }).value) expect(await invoke(ctx, 'remove', f.name)).toEqual({ ok: true, value: true });
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
    const big = `() => "${'b'.repeat(4000)}"`;
    let defined = 0;
    let error: { code: string; message: string } | undefined;
    for (let i = 0; i < LIB_MAX_FUNCTIONS; i++) {
      const r = (await invoke(ctx, 'define', `f${i}`, big)) as { ok: boolean; error?: { code: string; message: string } };
      if (!r.ok) {
        error = r.error;
        break;
      }
      defined += 1;
    }
    expect(defined).toBe(Math.floor(LIB_MAX_TOTAL_BYTES / Buffer.byteLength(big)));
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('in total') });
  });

  it('prepends the prelude to LLM actions, and lists the library in the prompt after <sdk_reference>', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Saving that.', toolCalls: [runAction('await sdk.lib.define("cheer", async (mood: string) => {}, { description: "show a picture for a mood" }); return 1;', 'define', 'tu_1')] },
        { text: 'Done.' },
        { text: 'Cheering.', toolCalls: [runAction('return await lib.cheer("happy");', 'cheer', 'tu_2')] },
        { text: 'Cheered.' },
      ],
      runnerHandler: async (request, runner) => {
        if (request.code.includes('sdk.lib.define')) {
          await runner.call(request, 'lib', 'define', 'cheer', asHandlerArg('async (mood: string) => {\n}'), { description: 'show a picture for a mood' });
          return 1;
        }
        return true;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    await t.engine.chat.send(session.id, 'remember how to cheer');
    const first = t.runner.requests[0]!;
    expect(first.code).toContain('sdk.lib.define');
    expect(first.prelude).toBe(EMPTY_PRELUDE); // nothing defined yet when the turn started
    expect(t.provider.requests[0]!.system).not.toContain(SECTION);

    await t.engine.chat.send(session.id, 'cheer me up');
    const second = t.runner.requests[1]!;
    expect(second.code).toBe('return await lib.cheer("happy");');
    expect(second.prelude).toBe('const lib = Object.freeze({\n  "cheer": (async (mood: string) => {\n}),\n});');
    const system = t.provider.requests[2]!.system;
    expect(system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n</library>`);
    expect(system.indexOf(SECTION)).toBeGreaterThan(system.indexOf('</sdk_reference>'));
    expect(system.indexOf(SECTION)).toBeLessThan(system.indexOf('\n<memory>\n<state>'));
    // the raw sources stay out of <state>
    expect(system).not.toContain(LIB_STATE_KEY);
    expect(system).toContain('sdk.lib.define and call it as lib.<name>(...)');
  });

  it('prepends the prelude to timer handlers, event handlers and behaviour hooks, and drops it after remove', async () => {
    const senses = new FakeSenses();
    t = await createTestEngine({ senses, script: [{ text: 'ok' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    expect((await invoke(ctx, 'define', 'double', asHandlerArg('(n) => n * 2'))).ok).toBe(true);
    const expected = 'const lib = Object.freeze({\n  "double": ((n) => n * 2),\n});';
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

    // remove invalidates the cached prelude
    expect(await invoke(ctx, 'remove', 'double')).toEqual({ ok: true, value: true });
    expect(await invoke(ctx, 'remove', 'double')).toEqual({ ok: true, value: false });
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
    expect(await t.storage.state.get(characterScope(ctx), LIB_STATE_KEY)).toBeUndefined();
  });

  it('survives across sessions of the same character and is invisible to another character', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.packs.install(LUNA_DIR);
    const first = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect((await invoke(ctxOf(MINIMAL_ID, 'echo', first.id), 'define', 'double', '(n: number) => n * 2')).ok).toBe(true);

    await t.engine.sessions.remove(first.id);
    const second = await t.engine.sessions.create({ characterRef: ECHO_REF });
    expect(second.id).not.toBe(first.id);
    expect(((await invoke(ctxOf(MINIMAL_ID, 'echo', second.id), 'list')) as { value: LibFunctionInfo[] }).value.map((f) => f.name)).toEqual(['double']);
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toContain('"double"');

    const luna = await t.engine.sessions.create({ characterRef: LUNA_REF });
    expect((await invoke(ctxOf(LUNA_ID, 'luna', luna.id), 'list')) as { value: LibFunctionInfo[] }).toMatchObject({ value: [] });
    expect(await t.engine.library.preludeFor(LUNA_ID, 'luna')).toBe(EMPTY_PRELUDE);
    expect(await invoke(ctxOf(LUNA_ID, 'luna', luna.id), 'source', 'double')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('PromptBuilder <library>', () => {
  it('adds the section with parameters only when the library is non-empty, in the dynamic tail', async () => {
    const pack = await loadPack(LUNA_DIR);
    const base: PromptInput = {
      pack,
      character: pack.characters[0]!,
      registry: createStandardRegistry(),
      allowedModules: ['chat', 'log', 'lib', 'state', 'pack', 'timers'],
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
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.stablePrefixLength);
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.system.indexOf('</sdk_reference>'));
    expect(built.system.slice(0, built.stablePrefixLength)).not.toContain(SECTION);
  });
});
