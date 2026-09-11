import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, ChatEvent, Json } from '@rp/shared';
import { ASK_DEFAULT_SYSTEM } from './handlers/llm.js';
import { ECHO_REF, MINIMAL_DIR, MINIMAL_ID, createTestEngine, runAction } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

function ctxFor(sessionId: string, trigger: ActionContext['trigger'] = { kind: 'llm', actionId: 'a', messageId: 'm' }): ActionContext {
  return { packId: MINIMAL_ID, characterId: 'echo', sessionId, packRoot: t!.engine.packs.getLoaded(MINIMAL_ID).root, trigger };
}

const invoke = (context: ActionContext, module: string, method: string, ...args: Json[]) =>
  t!.engine.dispatcher.invoke({ callId: `${module}.${method}`, module, method, args, context });

describe('timers.runLater (code timers)', () => {
  it('validates arguments and the per-session cap', async () => {
    t = await createTestEngine();
    await t.engine.settings.update({ autonomy: { maxSelfWakesPerHour: 30, maxConsecutiveSelfWakes: 10, maxTimersPerSession: 2, minRepeatIntervalMs: 60_000 } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxFor(session.id);
    const bad = async (...args: Json[]) => (await invoke(ctx, 'timers', 'runLater', ...args)) as { ok: boolean; error?: { code: string } };

    expect((await bad(-5, 'return 1;')).error?.code).toBe('INVALID_ARGUMENT');
    expect((await bad(5000, '   ')).error?.code).toBe('INVALID_ARGUMENT');
    expect((await bad(5000, 'x'.repeat(17_000))).error?.code).toBe('INVALID_ARGUMENT');
    expect((await bad(5000, 'return 1;', { repeatEveryMs: 1000 })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await bad(5000, 'return 1;', { maxRuns: 2 })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await bad(5000, 'return 1;', { repeatEveryMs: 60_000, maxRuns: 0 })).error?.code).toBe('INVALID_ARGUMENT');

    expect((await invoke(ctx, 'timers', 'runLater', 5000, 'return 1;')).ok).toBe(true);
    expect((await invoke(ctx, 'timers', 'schedule', 5000, { reason: 'x' })).ok).toBe(true);
    expect((await bad(5000, 'return 1;')).error?.code).toBe('INVALID_ARGUMENT'); // cap of 2 reached
    const list = (await invoke(ctx, 'timers', 'list')) as { ok: true; value: Array<{ kind: string }> };
    expect(list.value.map((v) => v.kind)).toEqual(['code', 'wake']);
  });

  it('fires the code with input on the timer trigger, can speak, repeats up to maxRuns and audits each run', async () => {
    const runs: string[] = [];
    t = await createTestEngine({
      runnerHandler: async (request, runner) => {
        if (request.context.trigger.kind !== 'timer') return;
        runs.push(request.code);
        expect(request.surface.modules.map((m) => m.id)).toContain('timers');
        await runner.call(request, 'chat', 'say', `tick ${runs.length}`);
        return { ok: true, returnValue: runs.length, logs: [], calls: [] };
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    const ctx = ctxFor(session.id);

    const created = (await invoke(ctx, 'timers', 'runLater', 5000, 'await sdk.chat.say(input.msg);', {
      input: { msg: 'hi' },
      label: 'ticker',
      repeatEveryMs: 60_000,
      maxRuns: 3,
    })) as { ok: true; value: { id: string; kind: string; fireAt: string; repeat: { everyMs: number; remaining: number } } };
    expect(created.value).toMatchObject({ kind: 'code', label: 'ticker', repeat: { everyMs: 60_000, remaining: 2 }, fireAt: '2026-01-01T12:00:05.000Z' });
    const id = created.value.id;

    t.clock.advance(5000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.startsWith('const input = {"msg":"hi"}; await sdk.chat.say(input.msg);')).toBe(true);
    expect(t.runner.requests.at(-1)!.context.trigger).toEqual({ kind: 'timer', timerId: id });
    let messages = await t.engine.sessions.messages(session.id);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', origin: 'timer', content: 'tick 1' });
    expect(t.events.filter((e) => e.type === 'message-added').at(-1)).toMatchObject({ message: { content: 'tick 1' } });
    expect(t.provider.requests).toHaveLength(0); // no LLM turn for code timers

    // re-armed: fireAt += everyMs, remaining counted down, runs++
    let pending = await t.engine.timers.list({ sessionId: session.id });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id, kind: 'code', fireAt: '2026-01-01T12:01:05.000Z', runs: 1, repeat: { everyMs: 60_000, remaining: 1 } });

    t.clock.advance(60_000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    t.clock.advance(60_000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    expect(runs).toHaveLength(3);
    expect(await t.engine.timers.list({ sessionId: session.id })).toEqual([]); // maxRuns reached → gone
    t.clock.advance(60_000);
    expect(await t.engine.timers.fireDue()).toBe(0);
    messages = await t.engine.sessions.messages(session.id);
    expect(messages.filter((m) => m.content.startsWith('tick ')).length).toBe(3);

    const audit = await t.engine.audit.list({ sessionId: session.id });
    const runEntries = audit.filter((a) => a.module === 'timers' && a.method === 'run');
    expect(runEntries.map((a) => a.outcome)).toEqual(['allowed', 'allowed', 'allowed']);
    expect(runEntries[0]!.args[0]).toBe(id);

    // cancel works for code timers; unlimited repeat keeps going until cancelled
    const forever = (await invoke(ctx, 'timers', 'runLater', 1000, 'return 1;', { repeatEveryMs: 60_000 })) as { ok: true; value: { id: string } };
    t.clock.advance(1000);
    await t.engine.timers.fireDue();
    pending = await t.engine.timers.list({ sessionId: session.id });
    expect(pending[0]).toMatchObject({ id: forever.value.id, runs: 1, repeat: { everyMs: 60_000 } });
    expect(await invoke(ctx, 'timers', 'cancel', forever.value.id)).toEqual({ ok: true, value: true });
    expect(await t.engine.timers.list({ sessionId: session.id })).toEqual([]);
  });

  it('audits a failing code run and treats stored timers without kind as wake', async () => {
    t = await createTestEngine({ runnerHandler: async () => ({ ok: false, error: { code: 'SANDBOX_RUNTIME', message: 'boom' }, logs: [], calls: [] }) });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.timers.runLater(ctxFor(session.id), 1000, 'throw new Error("boom");');
    t.clock.advance(1000);
    await t.engine.timers.fireDue();
    const entry = (await t.engine.audit.list({ sessionId: session.id })).find((a) => a.method === 'run')!;
    expect(entry.outcome).toBe('failed');
    expect(entry.error?.message).toBe('boom');

    const legacy = { id: 'legacy', sessionId: session.id, characterRef: ECHO_REF, fireAt: '2030-01-01T00:00:00.000Z', payload: null, createdAt: 't' };
    await t.storage.timers.upsert(legacy as never);
    expect((await t.engine.timers.get('legacy'))?.kind).toBe('wake');
    expect((await t.engine.timers.list({ sessionId: session.id })).map((x) => x.kind)).toEqual(['wake']);
  });
});

describe('self-wakes', () => {
  it('runs an immediate wake right after turn-finished with the past-self prompt', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Let me think.', toolCalls: [runAction('await sdk.llm.wake("Continue the story, one scene.");', 'wake', 'tu_w')] },
        { text: 'Back in a moment.' },
        { text: 'The story continues.' },
      ],
      runnerHandler: async (request, runner) => {
        if (request.context.trigger.kind !== 'llm') return;
        const first = await runner.call(request, 'llm', 'wake', 'Continue the story, one scene.');
        expect(first).toEqual({ queued: true });
        const second = await runner.call(request, 'llm', 'wake', 'And describe the weather.');
        expect(second).toEqual({ queued: true });
        return null;
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    t.events.length = 0;
    await t.engine.chat.send(session.id, 'tell me a story');
    await t.engine.chat.idle();

    const types = t.eventTypes(session.id);
    const firstFinish = types.indexOf('turn-finished');
    expect(firstFinish).toBeGreaterThan(0);
    expect(types.slice(firstFinish + 1)).toEqual(['message-added', 'turn-started', 'message-added', 'text-delta', 'text-delta', 'message-updated', 'turn-finished']);
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => [m.role, m.origin ?? '', m.content])).toEqual([
      ['user', '', 'tell me a story'],
      ['assistant', 'llm', 'Let me think.\n\nBack in a moment.'],
      ['system', 'timer', '[self-wake] Continue the story, one scene.\nAnd describe the weather.'],
      ['assistant', 'timer', 'The story continues.'],
    ]);
    const wakeRequest = t.provider.requests.at(-1)!;
    expect(wakeRequest.tools).toBeDefined();
    // the past-self note follows the tool_result parts of the same user message (tool results must come first)
    expect(wakeRequest.messages.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: '[system] Message from your past self: Continue the story, one scene.\nAnd describe the weather.' });
    expect(await t.storage.state.get(`session:${session.id}`, 'autonomy.consecutive')).toBe(1);
    const audit = await t.engine.audit.list({ sessionId: session.id });
    expect(audit.filter((a) => a.module === 'llm' && a.method === 'wake').map((a) => a.outcome)).toEqual(['allowed', 'allowed']);
  });

  it('schedules a delayed wake as a prompt timer that fires a turn later', async () => {
    t = await createTestEngine({ script: [{ text: 'Later!' }] });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.settings.update({ autonomy: { ...(await t.engine.settings.get()).autonomy, minDelayMs: 5000 } });
    const result = (await invoke(ctxFor(session.id), 'llm', 'wake', 'Ask how the interview went.', { delayMs: 5000, label: 'interview' })) as {
      ok: true;
      value: { queued: boolean; timer: { id: string; kind: string; label: string; fireAt: string } };
    };
    expect(result.value.queued).toBe(false);
    expect(result.value.timer).toMatchObject({ kind: 'prompt', label: 'interview', fireAt: '2026-01-01T12:00:05.000Z' });
    expect((await t.engine.timers.get(result.value.timer.id))?.prompt).toBe('Ask how the interview went.');
    // Too short is raised to the configured minimum, not rejected.
    const short = (await invoke(ctxFor(session.id), 'llm', 'wake', 'x', { delayMs: 500 })) as { ok: true; value: { timer: { id: string; fireAt: string } } };
    expect(short.ok).toBe(true);
    expect(short.value.timer.fireAt).toBe('2026-01-01T12:00:05.000Z');
    expect(await t.engine.timers.cancel(short.value.timer.id)).toBe(true);
    expect(await invoke(ctxFor(session.id), 'llm', 'wake', 'x', { delayMs: -1 })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await invoke(ctxFor(session.id), 'llm', 'wake', 'y'.repeat(2001))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });

    expect(t.provider.requests).toHaveLength(0);
    t.clock.advance(5000);
    expect(await t.engine.timers.fireDue()).toBe(1);
    await t.engine.chat.idle();
    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['system', '[self-wake] Ask how the interview went.'],
      ['assistant', 'Later!'],
    ]);
    expect(await t.engine.timers.list()).toEqual([]);
  });

  it('drops wakes beyond the consecutive limit (audit + status), resets on a user message, and enforces the hourly window', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'ok' }) });
    await t.engine.settings.update({ autonomy: { maxSelfWakesPerHour: 3, maxConsecutiveSelfWakes: 1, maxTimersPerSession: 20, minRepeatIntervalMs: 60_000 } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    expect(await t.engine.chat.selfWake(session.id, 'one')).toBe(true);
    expect(await t.engine.chat.selfWake(session.id, 'two')).toBe(false);
    const status = t.events.filter((e): e is Extract<ChatEvent, { type: 'status' }> => e.type === 'status');
    expect(status.at(-1)).toMatchObject({ sessionId: session.id, text: 'paused: autonomy limit reached' });
    let denied = (await t.engine.audit.list({ sessionId: session.id })).filter((a) => a.module === 'llm' && a.method === 'wake' && a.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.args[0]).toBe('two');
    expect(denied[0]!.error?.message).toContain('consecutive limit');
    expect((await t.engine.sessions.messages(session.id)).filter((m) => m.role === 'system')).toHaveLength(1);

    // a user message resets the consecutive counter
    await t.engine.chat.send(session.id, 'hello?');
    expect(await t.storage.state.get(`session:${session.id}`, 'autonomy.consecutive')).toBe(0);
    expect(await t.engine.chat.selfWake(session.id, 'three')).toBe(true);

    // per-hour window: 2 wakes used; allow many consecutive, so the third succeeds and the fourth is dropped
    await t.engine.settings.update({ autonomy: { maxSelfWakesPerHour: 3, maxConsecutiveSelfWakes: 10, maxTimersPerSession: 20, minRepeatIntervalMs: 60_000 } });
    expect(await t.engine.chat.selfWake(session.id, 'four')).toBe(true);
    expect(await t.engine.chat.selfWake(session.id, 'five')).toBe(false);
    denied = (await t.engine.audit.list({ sessionId: session.id })).filter((a) => a.method === 'wake' && a.outcome === 'denied');
    expect(denied.at(-1)!.error?.message).toContain('per-hour limit');
    t.clock.advance(61 * 60 * 1000);
    expect(await t.engine.chat.selfWake(session.id, 'six')).toBe(true);

    // wake-kind timers that reach the LLM count too
    await t.engine.settings.update({ autonomy: { maxSelfWakesPerHour: 1, maxConsecutiveSelfWakes: 10, maxTimersPerSession: 20, minRepeatIntervalMs: 60_000 } });
    await t.engine.timers.scheduleWake(ctxFor(session.id), 1000, { reason: 'x' });
    t.clock.advance(1000);
    const before = t.provider.requests.length;
    await t.engine.timers.fireDue();
    await t.engine.chat.idle();
    expect(t.provider.requests.length).toBe(before);
    expect((await t.engine.audit.list({ sessionId: session.id })).at(-1)).toMatchObject({ module: 'llm', method: 'wake', outcome: 'denied' });
  });
});

describe('llm.ask', () => {
  it('makes a tool-less side call and leaves the transcript alone', async () => {
    t = await createTestEngine({
      respond: (request) => {
        if (request.system === ASK_DEFAULT_SYSTEM) return { text: 'pong' };
        return request.tools && request.messages.length === 1 ? { toolCalls: [runAction('return await sdk.llm.ask("ping?");', 'ask')] } : { text: 'done' };
      },
      runnerHandler: async (request, runner) => {
        if (request.context.trigger.kind !== 'llm') return;
        await expect(runner.call(request, 'llm', 'ask', '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        await expect(runner.call(request, 'llm', 'ask', 'x', { temperature: 3 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        return runner.call(request, 'llm', 'ask', 'ping?', { maxTokens: 9999, temperature: 0.2 });
      },
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'do it');

    const asks = t.provider.requests.filter((r) => r.system === ASK_DEFAULT_SYSTEM);
    expect(asks).toHaveLength(1);
    const ask = asks[0]!;
    expect(ask.tools).toBeUndefined();
    expect(ask.maxTokens).toBe(2048);
    expect(ask.temperature).toBe(0.2);
    expect(ask.signal).toBeDefined();
    expect(ask.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'ping?' }] }]);

    const messages = await t.engine.sessions.messages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.actions?.[0]?.result?.returnValue).toBe('pong');
    expect(messages[1]!.content).toBe('done');
    const audit = await t.engine.audit.list({ sessionId: session.id });
    expect(audit.filter((a) => a.module === 'llm' && a.method === 'ask').map((a) => a.outcome)).toEqual(['failed', 'failed', 'allowed']);
  });
});

describe('validateDelay', () => {
  it('raises short delays to the configured floor (never below 1 s) and rejects only bad numbers', async () => {
    const { validateDelay, minDelayOf, TIMER_MAX_DELAY_MS } = await import('./services/timers.js');
    expect(validateDelay(500, 30_000)).toBe(30_000);
    expect(validateDelay(45_000.7, 30_000)).toBe(45_000);
    expect(validateDelay(0, 30_000)).toBe(30_000);
    expect(validateDelay(500, 10)).toBe(1000); // hard floor
    expect(validateDelay(5000)).toBe(5000);
    expect(() => validateDelay(-1, 30_000)).toThrow(/non-negative/);
    expect(() => validateDelay('5', 30_000)).toThrow(/non-negative/);
    expect(() => validateDelay(TIMER_MAX_DELAY_MS + 1, 30_000)).toThrow(/at most/);
    expect(minDelayOf({ minDelayMs: 0 })).toBe(1000);
    expect(minDelayOf({})).toBe(30_000);
  });
});
