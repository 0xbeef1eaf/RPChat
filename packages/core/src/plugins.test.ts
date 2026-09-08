import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, CapabilityModuleSpec, Json } from '@rp/shared';
import { LUNA_ID, LUNA_REF, RecordingHandler, createTestEngine, installLunaWith } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const clockSpec: CapabilityModuleSpec = {
  id: 'clock',
  version: '1.0.0',
  title: 'Clock (plugin)',
  summary: 'Tells the time.',
  permission: 'pack',
  apiTypeName: 'ClockApi',
  typings: `interface ClockApi {
  /** The current time. */
  now(): Promise<{ iso: string }>;
}`,
  docs: 'Ask the clock plugin for the time.',
  methods: { now: { description: 'Read the current time.' } },
};

class DisposableRecorder extends RecordingHandler {
  disposed = 0;
  override async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

describe('engine.capabilities.register / unregister', () => {
  it('adds a plugin module end to end and removes it again', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    const handler = new DisposableRecorder('clock', { iso: '2026-01-01T12:00:00.000Z' });

    // a pack requesting an unknown module is refused before the plugin exists
    await expect(installLunaWith(t.engine, t.packsDir, ['clock'])).rejects.toMatchObject({ code: 'PACK_INVALID' });

    t.engine.capabilities.register(clockSpec, handler);
    expect(() => t!.engine.capabilities.register(clockSpec, handler)).toThrow(/already registered/);
    expect(() => t!.engine.capabilities.register({ ...clockSpec, id: 'clock2' }, handler)).toThrow(/does not match/);
    expect(t.engine.capabilities.list().find((c) => c.id === 'clock')).toMatchObject({ permission: 'pack', methods: [{ name: 'now', description: 'Read the current time.', dangerous: false }] });
    expect(t.engine.capabilities.typings()).toContain('interface ClockApi');

    // now the pack installs with a policy-default grant, and the module is visible everywhere
    await installLunaWith(t.engine, t.packsDir, ['clock']);
    expect((await t.engine.packs.view(LUNA_ID)).effectiveCapabilities).toEqual(['clock']);
    expect((await t.engine.packs.inspect(t.engine.packs.getLoaded(LUNA_ID).root)).unknownCapabilities).toEqual([]);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context: ActionContext = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: t.engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
    const call = (n: string, args: Json[] = []) => t!.engine.dispatcher.invoke({ callId: n, module: 'clock', method: 'now', args, context });

    expect(await call('c1')).toEqual({ ok: true, value: { iso: '2026-01-01T12:00:00.000Z' } });
    expect(handler.calls).toHaveLength(1);
    expect((await t.engine.audit.list({ sessionId: session.id })).at(-1)).toMatchObject({ module: 'clock', method: 'now', outcome: 'allowed' });
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.find((m) => m.id === 'clock')?.methods).toEqual(['now']);

    await t.engine.chat.send(session.id, 'what time is it?');
    let system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('## sdk.clock —');
    expect(system).toContain('## sdk.clock');
    expect(system).toContain('Granted sdk modules: ');
    expect(system).toMatch(/Granted sdk modules: .*\bclock\b/);

    // grant off → denied like any pack-level module
    await t.engine.permissions.setGrant(LUNA_ID, 'clock', false);
    expect(await call('c2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await t.engine.permissions.setGrant(LUNA_ID, 'clock', true);

    // unregister: handler disposed, calls fail CAPABILITY_UNKNOWN, prompt and list no longer mention it
    expect(await t.engine.capabilities.unregister('clock')).toBe(true);
    expect(handler.disposed).toBe(1);
    expect(await t.engine.capabilities.unregister('clock')).toBe(false);
    expect(t.engine.capabilities.list().some((c) => c.id === 'clock')).toBe(false);
    expect(await call('c3')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect((await t.engine.audit.list({ sessionId: session.id })).at(-1)).toMatchObject({ module: 'clock', outcome: 'denied' });
    expect((await t.engine.behaviours.surfaceFor(LUNA_ID)).modules.some((m) => m.id === 'clock')).toBe(false);
    await t.engine.chat.send(session.id, 'and now?');
    system = t.provider.requests.at(-1)!.system;
    expect(system).not.toContain('## sdk.clock —');
    expect(system).not.toContain('sdk.clock');
    expect((await t.engine.packs.view(LUNA_ID)).effectiveCapabilities).toEqual([]);

    // re-registering after unregister works (plugin reload)
    const again = new DisposableRecorder('clock', { iso: 'later' });
    t.engine.capabilities.register(clockSpec, again);
    expect(await call('c4')).toEqual({ ok: true, value: { iso: 'later' } });
  });

  it('rejects invalid specs without touching the dispatcher', async () => {
    t = await createTestEngine();
    const handler = new RecordingHandler('bad');
    expect(() => t!.engine.capabilities.register({ ...clockSpec, id: 'bad', methods: {} }, handler)).toThrow();
    expect(t.engine.dispatcher.handlerFor('bad')).toBeUndefined();
    expect(t.engine.capabilities.list().some((c) => c.id === 'bad')).toBe(false);
  });
});
