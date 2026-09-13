import { afterEach, describe, expect, it } from 'vitest';
import { LUNA_DIR, LUNA_ID, LUNA_REF, createTestEngine } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('SandboxService', () => {
  it('runs the script as the character in its session, with input bound and the sandbox trigger', async () => {
    t = await createTestEngine({
      runnerHandler: async (request, runner) => {
        if (request.context.trigger.kind !== 'sandbox') return;
        await runner.call(request, 'chat', 'say', 'from the sandbox');
        return { echoed: request.code };
      },
    });
    await t.engine.packs.install(LUNA_DIR);

    const out = await t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 'return input;', input: { n: 1 }, runId: 'run-1' });
    expect(out.runId).toBe('run-1');
    expect(out.result.ok).toBe(true);
    expect(out.result.returnValue).toEqual({ echoed: 'const input = {"n":1}; return input;' });
    expect(out.result.calls.map((c) => `${c.module}.${c.method}`)).toEqual(['chat.say']);

    // the character had no session: one was created and the script ran in it
    const session = await t.engine.sessions.forCharacter(LUNA_REF);
    expect(session?.id).toBe(out.sessionId);
    const request = t.runner.requests.find((r) => r.context.trigger.kind === 'sandbox')!;
    expect(request.context).toMatchObject({ packId: LUNA_ID, characterId: 'luna', sessionId: out.sessionId, trigger: { kind: 'sandbox', runId: 'run-1' } });
    expect(request.surface.modules.map((m) => m.id)).toEqual(expect.arrayContaining(['chat', 'pack', 'media', 'ui']));
    expect(request.prelude).toContain('const lib = Object.freeze(');
    const messages = await t.engine.sessions.messages(out.sessionId);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'from the sandbox' });

    // a second run reuses the same session; input defaults to null
    const again = await t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 'return 2;' });
    expect(again.sessionId).toBe(out.sessionId);
    expect(again.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.runner.requests.at(-1)?.code).toBe('const input = null; return 2;');

    // both runs and the chat call are in the audit log
    const audit = await t.engine.audit.list({ sessionId: out.sessionId });
    expect(audit.filter((e) => e.module === 'sandbox' && e.method === 'run').map((e) => [e.args[0], e.outcome])).toEqual([
      ['run-1', 'allowed'],
      [again.runId, 'allowed'],
    ]);
    expect(audit.some((e) => e.module === 'chat' && e.method === 'say')).toBe(true);
  });

  it('reports a failed script in the result and the audit log, without rejecting', async () => {
    t = await createTestEngine({
      runnerHandler: async () => {
        throw new Error('boom');
      },
    });
    await t.engine.packs.install(LUNA_DIR);
    const out = await t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 'throw new Error("boom")' });
    expect(out.result.ok).toBe(false);
    expect(out.result.error?.message).toBe('boom');
    const entry = (await t.engine.audit.list({ sessionId: out.sessionId })).find((e) => e.module === 'sandbox');
    expect(entry?.outcome).toBe('failed');
    expect(entry?.error?.message).toBe('boom');
  });

  it('cancel aborts a running script through the signal', async () => {
    t = await createTestEngine({
      runnerHandler: (request) => {
        if (request.context.trigger.kind !== 'sandbox') return undefined; // onSessionStart of the new session
        return new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => resolve({ ok: false, error: { code: 'SANDBOX_TIMEOUT', message: 'aborted' }, logs: [] }), { once: true });
        });
      },
    });
    await t.engine.packs.install(LUNA_DIR);
    const running = t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 'while (true) {}', runId: 'slow' });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.engine.sandbox.active()).toEqual(['slow']);
    await expect(t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: '', runId: 'slow' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await t.engine.sandbox.cancel('slow')).toBe(true);
    const out = await running;
    expect(out.result.ok).toBe(false);
    expect(out.result.error?.code).toBe('SANDBOX_TIMEOUT');
    expect(t.engine.sandbox.active()).toEqual([]);
    expect(await t.engine.sandbox.cancel('slow')).toBe(false);
  });

  it('rejects unknown characters and malformed requests', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(LUNA_DIR);
    await expect(t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'nobody', code: 'return 1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.engine.sandbox.run({ packId: 'com.example.none', characterId: 'luna', code: 'return 1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 'x', runId: 'bad id!' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(t.engine.sandbox.run({ packId: LUNA_ID, characterId: 'luna', code: 42 as unknown as string })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(t.runner.requests).toHaveLength(0);
  });
});
