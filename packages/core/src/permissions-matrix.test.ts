/**
 * Permission matrix. Permissions are app-wide and per function: the only control is the user's
 * policy under Settings → Permissions (`settings.permissions.functionAllow`). For every module and
 * every policy state (unset / allowed / denied) the answer must agree across:
 * `permissions.effective`, the dispatcher verdict, the sandbox surface, the pack view and the
 * system prompt the character reads — for every installed pack alike, since packs neither
 * request nor are granted anything.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json } from '@rp/shared';
import { ECHO_REF, LUNA_ID, LUNA_REF, MINIMAL_DIR, MINIMAL_ID, RecordingHandler, createTestEngine, createTestRegistryWithProbe, installLunaWith } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

type Policy = 'unset' | 'allow' | 'deny';
const POLICIES: Policy[] = ['unset', 'allow', 'deny'];

/** One cheap, argument-light method per non-trusted module (unknown ids fall back to the first method). */
const PROBE_CALL: Record<string, { method: string; args: Json[] }> = {
  desktop: { method: 'getVolume', args: [] },
  wallpaper: { method: 'restore', args: [] },
  media: { method: 'list', args: [] },
  ui: { method: 'notify', args: ['hi'] },
  web: { method: 'fetch', args: ['https://example.com'] },
  files: { method: 'list', args: ['.'] },
};

function nonTrustedModules(): string[] {
  return createTestRegistryWithProbe()
    .list()
    .filter((s) => s.permission !== 'trusted')
    .map((s) => s.id);
}

/** Every module of the test registry, in registry order (what `effective` reports untouched). */
function allModules(): string[] {
  return createTestRegistryWithProbe().list().map((s) => s.id);
}

/** Module ids of an `effective` result, in order. */
function idsOf(effective: Array<{ id: string }>): string[] {
  return effective.map((m) => m.id);
}

function cases(): Array<{ module: string; policy: Policy }> {
  const out: Array<{ module: string; policy: Policy }> = [];
  for (const module of Object.keys(PROBE_CALL)) for (const policy of POLICIES) out.push({ module, policy });
  return out;
}

const contextFor = (engine: TestEngine['engine'], packId: string, characterId: string, sessionId: string): ActionContext => ({
  packId,
  characterId,
  sessionId,
  packRoot: engine.packs.getLoaded(packId).root,
  trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
});

describe('permission matrix (app-wide policy only)', () => {
  it.each(cases())('$module: policy $policy', async ({ module, policy }) => {
    const handler = new RecordingHandler(module, null);
    t = await createTestEngine({ hostHandlers: [handler], respond: () => ({ text: 'ok' }) });
    const { engine, packsDir } = t;
    if (policy !== 'unset') await engine.settings.update({ permissions: { functionAllow: { [module]: policy === 'allow' } } });
    await installLunaWith(engine, packsDir);
    const allowed = policy !== 'deny';
    const { method, args } = PROBE_CALL[module]!;

    // 1. effective set + reason (packId is irrelevant: the answer is the same for any pack)
    const eff = await engine.permissions.effective(LUNA_ID);
    expect(idsOf(eff.effective).includes(module), 'effective').toBe(allowed);
    expect(eff.denied[`${module}.${method}`], 'denial reason').toBe(allowed ? undefined : 'policy');
    expect(await engine.permissions.effective('com.example.other')).toEqual(eff);

    // 2. dispatcher verdict (what the sandbox call actually gets)
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context = contextFor(engine, LUNA_ID, 'luna', session.id);
    const result = await engine.dispatcher.invoke({ callId: 'c', module, method, args, context });
    expect(result.ok, `dispatcher ok (${JSON.stringify(result)})`).toBe(allowed);
    if (!allowed) expect(result.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'switched off under Settings → Permissions' } });
    expect(handler.calls.length, 'handler reached').toBe(allowed ? 1 : 0);

    // 3. sandbox surface and allowed list
    expect((await engine.permissions.allowedModules(LUNA_ID)).includes(module), 'allowedModules').toBe(allowed);
    expect((await engine.behaviours.surfaceFor(LUNA_ID)).modules.some((m) => m.id === module), 'sandbox surface').toBe(allowed);

    // 4. the prompt the character reads
    await engine.chat.send(session.id, 'hello');
    const system = t.provider.requests.at(-1)!.system;
    if (allowed) {
      expect(system).toContain(`## sdk.${module} —`);
      expect(system).toMatch(new RegExp(`^Available modules: .*\\bsdk\\.${module}\\b`, 'm'));
    } else {
      // A switched-off module is absent from the prompt entirely: the character learns what is
      // missing from the PERMISSION_DENIED error, not from the prompt.
      expect(system).not.toContain(`## sdk.${module} —`);
      expect(system).not.toMatch(new RegExp(`^Available modules: .*\\bsdk\\.${module}\\b`, 'm'));
      expect(system).not.toContain('Not available');
    }
  });

  it('every non-trusted module is usable by every installed character by default; the policy switches one off for all of them', async () => {
    const handlers = nonTrustedModules().map((id) => new RecordingHandler(id, null));
    t = await createTestEngine({ hostHandlers: handlers, registry: createTestRegistryWithProbe() });
    const { engine, packsDir } = t;
    await installLunaWith(engine, packsDir);
    await engine.packs.install(MINIMAL_DIR);
    const expected = nonTrustedModules();

    for (const packId of [LUNA_ID, MINIMAL_ID]) {
      const eff = await engine.permissions.effective(packId);
      expect(idsOf(eff.effective)).toEqual(allModules());
      expect(eff.denied).toEqual({});
      expect(await engine.permissions.allowedModules(packId)).toEqual(allModules());
      expect(expected.every((id) => idsOf(eff.effective).includes(id))).toBe(true);
    }

    const wallpaperMethods = Object.keys(createTestRegistryWithProbe().get('wallpaper')!.methods);
    await engine.settings.update({ permissions: { functionAllow: { wallpaper: false } } });
    for (const packId of [LUNA_ID, MINIMAL_ID]) {
      const eff = await engine.permissions.effective(packId);
      expect(idsOf(eff.effective)).toEqual(allModules().filter((id) => id !== 'wallpaper'));
      expect(eff.denied).toEqual(Object.fromEntries(wallpaperMethods.map((m) => [`wallpaper.${m}`, 'policy'])));
      expect(await engine.permissions.deniedModules(packId)).toEqual(['wallpaper']);
    }

    // The dispatcher agrees for both characters.
    const luna = await engine.sessions.create({ characterRef: LUNA_REF });
    const echo = await engine.sessions.create({ characterRef: ECHO_REF });
    for (const [packId, characterId, sessionId] of [[LUNA_ID, 'luna', luna.id], [MINIMAL_ID, 'echo', echo.id]] as const) {
      const context = contextFor(engine, packId, characterId, sessionId);
      expect(await engine.dispatcher.invoke({ callId: 'w', module: 'wallpaper', method: 'restore', args: [], context })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await engine.dispatcher.invoke({ callId: 'u', module: 'ui', method: 'notify', args: ['hi'], context })).toMatchObject({ ok: true });
    }
  });

  it('switches trusted modules off too — every module but sdk.lib is the user\'s to turn off', async () => {
    t = await createTestEngine();
    const { engine, packsDir } = t;
    // `lib` is named as well, and ignored: it is the character's own saved functions.
    await engine.settings.update({ permissions: { functionAllow: { state: false, lib: false } } });
    await installLunaWith(engine, packsDir);
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context = contextFor(engine, LUNA_ID, 'luna', session.id);
    expect(await engine.dispatcher.invoke({ callId: 's', module: 'state', method: 'keys', args: [], context })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    expect(await engine.permissions.allowedModules(LUNA_ID)).not.toContain('state');
    expect(await engine.permissions.allowedModules(LUNA_ID)).toContain('lib');
    expect((await engine.behaviours.surfaceFor(LUNA_ID)).modules.some((m) => m.id === 'lib')).toBe(true);
  });

  it('switches off one function without touching its siblings, in the surface and in the prompt', async () => {
    t = await createTestEngine({ hostHandlers: [new RecordingHandler('media', null)], respond: () => ({ text: 'ok' }) });
    const { engine, packsDir } = t;
    await engine.settings.update({ permissions: { functionAllow: { 'media.playVideo': false } } });
    await installLunaWith(engine, packsDir);
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context = contextFor(engine, LUNA_ID, 'luna', session.id);

    const eff = await engine.permissions.effective(LUNA_ID);
    expect(eff.denied).toEqual({ 'media.playVideo': 'policy' });
    const media = eff.effective.find((m) => m.id === 'media')!;
    expect(media.methods).not.toContain('playVideo');
    expect(media.methods).toContain('showImage');
    expect(await engine.permissions.deniedModules(LUNA_ID)).toEqual([]);

    const surface = (await engine.behaviours.surfaceFor(LUNA_ID)).modules.find((m) => m.id === 'media')!;
    expect(surface.methods).not.toContain('playVideo');
    expect(surface.methods).toContain('showImage');

    expect(await engine.dispatcher.invoke({ callId: 'v', module: 'media', method: 'playVideo', args: ['x.webm'], context })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });

    await engine.chat.send(session.id, 'hello');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('## sdk.media —');
    expect(system).not.toContain('playVideo');
    expect(system).toContain('showImage');
  });

  it("narrows the prompt to the character's promptFunctions while the code keeps every function", async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    const { engine, packsDir } = t;
    await installLunaWith(engine, packsDir, {
      patchCharacter: (c) => {
        c.promptFunctions = ['chat', 'media.showImage'];
      },
    });
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context = contextFor(engine, LUNA_ID, 'luna', session.id);

    await engine.chat.send(session.id, 'hello');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('## sdk.chat —');
    expect(system).toContain('## sdk.media —');
    expect(system).toContain('showImage');
    expect(system).not.toContain('playVideo');
    expect(system).not.toContain('## sdk.state —');
    // `lib` is never narrowed away: it is the character's own library.
    expect(system).toContain('## sdk.lib —');

    // …and none of that took anything away from the code.
    expect((await engine.behaviours.surfaceFor(LUNA_ID)).modules.some((m) => m.id === 'state')).toBe(true);
    expect(await engine.dispatcher.invoke({ callId: 's', module: 'state', method: 'keys', args: [], context })).toMatchObject({ ok: true });
  });

  it('prompt-level methods still ask on each call, unless the policy switches the module off', async () => {
    const probe = new RecordingHandler('probe', 'pong');
    const decisions: Array<'allow-once' | 'allow-session' | 'deny'> = ['allow-once', 'deny'];
    t = await createTestEngine({ hostHandlers: [probe], registry: createTestRegistryWithProbe(), prompter: async () => decisions.shift() ?? 'deny' });
    const { engine, packsDir } = t;
    await installLunaWith(engine, packsDir);
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context = contextFor(engine, LUNA_ID, 'luna', session.id);
    const call = (n: number) => engine.dispatcher.invoke({ callId: `p${n}`, module: 'probe', method: 'ping', args: ['https://example.com'], context });

    // On by default, but every call goes through the prompter.
    expect(await call(1)).toEqual({ ok: true, value: 'pong' });
    expect(await call(2)).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(t.prompts).toHaveLength(2);
    expect(probe.calls).toHaveLength(1);

    // Switched off: denied outright, no prompt.
    await engine.settings.update({ permissions: { functionAllow: { probe: false } } });
    expect(await call(3)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(t.prompts).toHaveLength(2);
    expect((await engine.behaviours.surfaceFor(LUNA_ID)).modules.some((m) => m.id === 'probe')).toBe(false);
  });

  it('a legacy "capabilities" key in pack.json or character.json is ignored with a warning and grants nothing extra or less', async () => {
    const warnings: string[] = [];
    const noop = () => undefined;
    t = await createTestEngine({ logger: { debug: noop, info: noop, error: noop, warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) } });
    const { engine, packsDir } = t;
    await installLunaWith(engine, packsDir, {
      patchManifest: (m) => {
        m.capabilities = ['media', 'teleport'];
      },
      patchCharacter: (d) => {
        d.capabilities = 'not-even-a-list';
      },
    });
    expect(warnings.some((w) => w.includes('pack.json: "capabilities" is ignored; permissions are set in the app under Settings → Permissions'))).toBe(true);
    expect(warnings.some((w) => w.includes('characters/luna/character.json: "capabilities" is ignored'))).toBe(true);
    const view = await engine.packs.view(LUNA_ID);
    expect('capabilities' in view.manifest).toBe(false);
    expect('capabilities' in engine.packs.getLoaded(LUNA_ID).character.definition).toBe(false);
    expect(await engine.permissions.effective(LUNA_ID)).toEqual(await engine.permissions.effective('com.example.other'));
    // The installed copy still carries the author's file untouched.
    const installed = JSON.parse(await fs.readFile(path.join(engine.packs.getLoaded(LUNA_ID).root, 'pack.json'), 'utf8')) as Record<string, unknown>;
    expect(installed.capabilities).toEqual(['media', 'teleport']);
  });
});
