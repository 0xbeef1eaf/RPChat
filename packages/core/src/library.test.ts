import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, CapabilityHandler, Json, LibFunction } from '@rp/shared';
import { loadPack } from '@rp/pack';
import { createStandardRegistry } from '@rp/sdk';
import { PromptBuilder, libraryLine } from './prompt.js';
import type { PromptInput } from './prompt.js';
import { EMPTY_PRELUDE, LIB_STATE_KEY, buildPrelude } from './services/library.js';
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
/** The functions the character itself may call — what `<library>` lists; the service also reports the author's internal ones. */
const visible = async (packId: string, characterId: string): Promise<LibFunction[]> =>
  (await t!.engine.library.functions({ packId, characterId })).filter((f) => f.internal !== true);

/**
 * Run a prelude the way the sandbox would, with a stand-in for the bootstrap's `__rp_lib`
 * that hands back what it was given: the object of exports and the internal names.
 */
function evaluatePrelude(prelude: string, sdk: unknown = {}): { lib: Record<string, (...args: never[]) => unknown>; internal: string[] | undefined } {
  const rpLib = (lib: Record<string, (...args: never[]) => unknown>, internal?: string[]) => ({ lib, internal });
  return new Function('__rp_lib', 'sdk', `${prelude.replace(/^const lib = /, 'return ')}`)(rpLib, sdk);
}

/** Opening of the prompt section (the SDK index also mentions `<library>` in prose). */
const SECTION = '<library>\nYour own functions (call them as lib.<name>(...) or sdk.lib.<name>(...), the same object):';

/** A shipped library: a public function, a private helper, and an `@internal` export a sibling imports. */
const LUNA_LIB = {
  'characters/luna/lib/pictures.ts': [
    "import { pick } from './util/pick';",
    '',
    'const SHOW_MS = 6000;',
    '',
    '/** Show a picture for a mood. */',
    'export async function cheer(mood: string) {',
    '  const pic = await pick(mood);',
    '  if (pic) await sdk.media.showImage(pic, { durationMs: SHOW_MS });',
    '  return Boolean(pic);',
    '}',
  ].join('\n'),
  'characters/luna/lib/util/pick.ts': '/** @internal Pick a picture for a mood. */\nexport const pick = async (mood: string) => (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];\n',
};

describe('LibraryService helpers', () => {
  it('builds the prelude as the bootstrap library factory over the bundled library', () => {
    expect(buildPrelude({ code: '', functions: {} })).toBe(EMPTY_PRELUDE);
    expect(buildPrelude({ code: '({ a })', functions: { a: { name: 'a', file: 'lib/a.ts', params: '' } } })).toBe('const lib = __rp_lib(({ a }));');
  });

  it('names the internal functions in the prelude instead of hiding them in a second scope', () => {
    const functions: Record<string, LibFunction> = {
      cheer: { name: 'cheer', file: 'lib/p.ts', params: 'mood: string' },
      pick: { name: 'pick', file: 'lib/u.ts', params: 'mood: string', internal: true },
    };
    expect(buildPrelude({ code: '({ cheer, pick })', functions })).toBe('const lib = __rp_lib(({ cheer, pick }), ["pick"]);');
  });

  it('renders one prompt line per function', () => {
    expect(libraryLine({ name: 'cheer', params: 'mood: string', description: 'show a picture for a mood' })).toBe('- lib.cheer(mood: string) — show a picture for a mood');
    expect(libraryLine({ name: 'tick', params: '' })).toBe('- lib.tick()');
  });
});

describe('the library through the engine', () => {
  it('bundles the files the author shipped into the prelude, with the private helper inside it', async () => {
    t = await createTestEngine();
    await installLunaWith(t.engine, t.packsDir, { extraFiles: LUNA_LIB });
    expect(await t.engine.library.functions({ packId: LUNA_ID, characterId: 'luna' })).toEqual([
      { name: 'cheer', file: 'characters/luna/lib/pictures.ts', params: 'mood: string', description: 'Show a picture for a mood.' },
      { name: 'pick', file: 'characters/luna/lib/util/pick.ts', params: 'mood: string', description: 'Pick a picture for a mood.', internal: true },
    ]);
    const prelude = await t.engine.library.preludeFor(LUNA_ID, 'luna');
    expect(prelude).toMatch(/^const lib = __rp_lib\(\(\(\) => \{\n[\s\S]*\}\)\(\), \["pick"\]\);$/);
    // run it: the exports are the library, the private constant is not
    const shown: unknown[] = [];
    const sdk = { pack: { findAssets: async () => [{ path: 'media/images/happy.png' }] }, media: { showImage: async (...args: unknown[]) => shown.push(args) } };
    const { lib, internal } = evaluatePrelude(prelude, sdk);
    expect(Object.keys(lib).sort()).toEqual(['cheer', 'pick']);
    expect(internal).toEqual(['pick']);
    expect(await (lib.cheer as (m: string) => Promise<boolean>)('happy')).toBe(true);
    expect(shown).toEqual([[{ path: 'media/images/happy.png' }, { durationMs: 6000 }]]);
    // the same prelude is served from the cache until a pack changes
    expect(await t.engine.library.preludeFor(LUNA_ID, 'luna')).toBe(prelude);
  });

  it('prepends the prelude to LLM actions, and lists only the public functions in the prompt after <sdk_reference>', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Cheering.', toolCalls: [runAction('return await lib.cheer("happy");', 'cheer', 'tu_1')] },
        { text: 'Cheered.' },
      ],
      runnerHandler: async () => true,
    });
    await installLunaWith(t.engine, t.packsDir, { extraFiles: LUNA_LIB });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'cheer me up');
    const run = t.runner.requests.find((r) => r.context.trigger.kind === 'llm')!;
    expect(run.code).toBe('return await lib.cheer("happy");');
    expect(run.prelude).toBe(await t.engine.library.preludeFor(LUNA_ID, 'luna'));
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain(`${SECTION}\n- lib.cheer(mood: string) — Show a picture for a mood.\n</library>`);
    expect(system).not.toContain('lib.pick');
    expect(system.indexOf(SECTION)).toBeGreaterThan(system.indexOf('</sdk_reference>'));
    expect(system.indexOf(SECTION)).toBeLessThan(system.indexOf('\n<memory>\n<state>'));
    expect(system).toContain('The library is fixed: there is no lib.register or sdk.lib.define.');
  });

  it('prepends the same prelude to timer handlers, event handlers and behaviour hooks', async () => {
    const senses = new FakeSenses();
    t = await createTestEngine({ senses, script: [{ text: 'ok' }] });
    await installLunaWith(t.engine, t.packsDir, { extraFiles: LUNA_LIB });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const ctx = ctxOf(LUNA_ID, 'luna', session.id);
    const expected = await t.engine.library.preludeFor(LUNA_ID, 'luna');
    expect(expected).toContain('__rp_lib(');

    // timers.runLater
    const timerCall = { callId: 'timers.runLater', module: 'timers', method: 'runLater', args: [5000, 'return await lib.cheer(input.mood);', { input: { mood: 'happy' } }] as Json[], context: ctx };
    expect((await t.engine.dispatcher.invoke(timerCall)).ok).toBe(true);
    t.clock.advance(5000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    expect(t.runner.requests.find((r) => r.context.trigger.kind === 'timer')?.prelude).toBe(expected);

    // events.on — a handler calling the author's internal export reaches it through the same one prelude
    const eventCall = { callId: 'events.on', module: 'events', method: 'on', args: ['custom:ping', 'return await lib.pick("happy");'] as Json[], context: ctx };
    expect((await t.engine.dispatcher.invoke(eventCall)).ok).toBe(true);
    await t.engine.dispatcher.invoke({ callId: 'events.emit', module: 'events', method: 'emit', args: ['ping', { n: 1 }], context: ctx });
    await t.engine.eventService.idle();
    expect(t.runner.requests.find((r) => r.context.trigger.kind === 'event')?.prelude).toBe(expected);

    // behaviour hook (onUserMessage)
    t.engine.packs.getLoaded(LUNA_ID).characters[0]!.behaviourSources.onUserMessage = 'await lib.pick("happy");\nreturn { skipLlm: true };';
    await t.engine.chat.send(session.id, 'hi');
    expect(t.runner.requests.find((r) => r.context.trigger.kind === 'behaviour')?.prelude).toBe(expected);
  });

  it('has no lib module: there is nothing to register or unregister, and no plugin can take the name', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxOf(MINIMAL_ID, 'echo', session.id);
    const result = await t.engine.dispatcher.invoke({ callId: 'lib.register', module: 'lib', method: 'register', args: ['x', '() => 1'], context: ctx });
    expect(result.ok).toBe(false);
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
    expect(t.engine.capabilities.list().map((m) => m.id)).not.toContain('lib');
    const handler: CapabilityHandler = { moduleId: 'lib', invoke: async () => null };
    const spec = { ...createStandardRegistry().get('chat')!, id: 'lib' };
    expect(() => t!.engine.capabilities.register(spec, handler)).toThrow(/reserved/);
  });

  it('lists the makima example\'s shipped functions and bundles them', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(path.join(EXAMPLES_DIR, 'makima'));
    const fns = await visible('com.example.makima', 'makima');
    expect(fns.find((f) => f.name === 'glance')).toMatchObject({ params: '', description: 'show a random portrait of Makima for five seconds and return its path' });
    expect(fns.map((f) => f.name)).toEqual(['endGame', 'gameLost', 'gameSetup', 'glance', 'memoryGame', 'molePop', 'punish', 'quitGame', 'reactionTest', 'reward', 'simonSays', 'slidingPuzzle', 'whackAMole', 'writeLines']);
    const { lib } = evaluatePrelude(await t.engine.library.preludeFor('com.example.makima', 'makima'));
    expect(Object.keys(lib).sort()).toEqual(fns.map((f) => f.name));
  });

  it('keeps the old state key out of <state>, and gives another character none of this library', async () => {
    t = await createTestEngine({ script: [{ text: 'ok' }] });
    await installLunaWith(t.engine, t.packsDir, { extraFiles: LUNA_LIB });
    await t.engine.packs.install(MINIMAL_DIR);
    // what a very old version left in state is ignored, and kept out of the prompt
    await t.storage.state.set(characterScope({ packId: LUNA_ID, characterId: 'luna' }), LIB_STATE_KEY, { old: { source: '() => 1' } });
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    await t.engine.chat.send(session.id, 'hi');
    expect(t.provider.requests.at(-1)!.system).not.toContain(LIB_STATE_KEY);
    expect(await visible(MINIMAL_ID, 'echo')).toEqual([]);
    expect(await t.engine.library.preludeFor(MINIMAL_ID, 'echo')).toBe(EMPTY_PRELUDE);
  });
});

describe('PromptBuilder <library>', () => {
  it('adds the section with parameters only when the library is non-empty, in the dynamic tail', async () => {
    const pack = await loadPack(LUNA_DIR);
    const base: PromptInput = {
      pack,
      character: pack.characters[0]!,
      registry: createStandardRegistry(),
      sdkSelection: { modules: ['chat', 'state', 'pack', 'timers'] },
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
        { name: 'cheer', file: 'lib/cheer.ts', params: 'mood: string', description: 'show a picture for a mood' },
        { name: 'tick', file: 'lib/tick.ts', params: '' },
      ],
    });
    expect(built.system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n- lib.tick()\n</library>`);
    // an internal helper is never listed; a library holding nothing else gets no section at all
    const withHelper = new PromptBuilder().build({
      ...base,
      library: [
        { name: 'cheer', file: 'lib/cheer.ts', params: 'mood: string', description: 'show a picture for a mood' },
        { name: 'pick', file: 'lib/pick.ts', params: 'mood: string', description: 'pick a picture', internal: true },
      ],
    });
    expect(withHelper.system).toContain(`${SECTION}\n- lib.cheer(mood: string) — show a picture for a mood\n</library>`);
    expect(withHelper.system).not.toContain('lib.pick');
    expect(new PromptBuilder().build({ ...base, library: [{ name: 'pick', file: 'lib/pick.ts', params: 'mood: string', internal: true }] }).system).not.toContain(SECTION);
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.stablePrefixLength);
    expect(built.system.indexOf(SECTION)).toBeGreaterThan(built.system.indexOf('</sdk_reference>'));
    expect(built.system.slice(0, built.stablePrefixLength)).not.toContain(SECTION);
  });
});
