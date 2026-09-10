import { afterEach, describe, expect, it } from 'vitest';
import type { ModelExchange } from '@rp/shared';
import { ASK_DEFAULT_SYSTEM } from './handlers/llm.js';
import { ECHO_REF, MINIMAL_DIR, createTestEngine, runAction } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

function exchanges(engine: TestEngine): ModelExchange[] {
  return engine.events.flatMap((e) => (e.type === 'model-exchange' ? [e.exchange] : []));
}

describe('model-exchange capture (settings.debug.showModelTraffic)', () => {
  it('records one exchange per provider call of a turn, with a mutation-safe request snapshot', async () => {
    t = await createTestEngine({
      script: [
        { text: 'Let me check.', toolCalls: [runAction('return await sdk.state.get("mood");', 'read mood', 'tu_1')] },
        { text: 'You seem happy!' },
      ],
      runnerHandler: async () => ({ ok: true, returnValue: 'happy', logs: [] }),
    });
    await t.engine.settings.update({ debug: { showModelTraffic: true } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    t.events.length = 0;

    await t.engine.chat.send(session.id, 'how do I seem?');

    const list = exchanges(t);
    expect(list).toHaveLength(2);
    const [first, second] = list as [ModelExchange, ModelExchange];
    expect(list.map((x) => [x.kind, x.round])).toEqual([
      ['turn', 0],
      ['turn', 1],
    ]);
    expect(list.every((x) => x.sessionId === session.id)).toBe(true);
    expect(first.id).not.toBe(second.id);

    // Turn and message ids match the surrounding events.
    const started = t.events.find((e) => e.type === 'turn-started');
    const turnId = started?.type === 'turn-started' ? started.turnId : undefined;
    expect(turnId).toBeDefined();
    const reply = (await t.engine.sessions.messages(session.id)).at(-1)!;
    expect(first.turnId).toBe(turnId);
    expect(first.messageId).toBe(reply.id);
    expect(second.turnId).toBe(turnId);

    // Request snapshot: provider label, model, system, tools, and the growing conversation.
    expect(first.request.provider).toBe('Mock');
    expect(first.request.model).toBe('mock-model');
    expect(first.request.system).toContain('You are Echo');
    expect(first.request.systemStablePrefixChars).toBeGreaterThan(0);
    expect(first.request.tools?.map((tool) => tool.name)).toEqual(['run_action']);
    expect(first.request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'how do I seem?' }] }]);
    const tail = second.request.messages.slice(-2);
    expect(tail[0]!.role).toBe('assistant');
    expect(tail[0]!.content.some((p) => p.type === 'tool_use' && p.id === 'tu_1')).toBe(true);
    expect(tail[1]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu_1', isError: false });
    // The round-0 snapshot was taken before the tool_use/tool_result pair was appended to the conversation.
    expect(first.request.messages).toHaveLength(1);
    expect(first.request.messages.some((m) => m.content.some((p) => p.type === 'tool_result'))).toBe(false);
    expect(second.request.messages.length).toBeGreaterThan(first.request.messages.length);

    // Response: message, stop reason, usage, model, timing.
    expect(first.response?.stopReason).toBe('tool_use');
    expect(first.response?.message.content.some((p) => p.type === 'tool_use')).toBe(true);
    expect(second.response?.stopReason).toBe('end');
    expect(second.response?.message.content).toEqual([{ type: 'text', text: 'You seem happy!' }]);
    for (const x of list) {
      expect(x.response?.usage.inputTokens).toBeGreaterThan(0);
      expect(x.response?.usage.outputTokens).toBeGreaterThan(0);
      expect(x.response?.model).toBe('mock-model');
      expect(typeof x.durationMs).toBe('number');
      expect(Date.parse(x.startedAt)).not.toBeNaN();
      expect(x.error).toBeUndefined();
    }
    // The snapshot is independent of the provider's own request objects.
    expect(first.request.messages).not.toBe(t.provider.requests[0]!.messages);

    // The rest of the event stream is unchanged apart from the two new events.
    expect(t.eventTypes().filter((type) => type !== 'model-exchange')).toEqual([
      'message-added',
      'turn-started',
      'message-added',
      'text-delta',
      'text-delta',
      'action-started',
      'action-finished',
      'text-delta',
      'text-delta',
      'message-updated',
      'turn-finished',
    ]);
  });

  it('emits nothing while the setting is off', async () => {
    t = await createTestEngine({
      script: [{ text: 'Hi.', toolCalls: [runAction('return 1;')] }, { text: 'Done.' }],
      runnerHandler: async () => 1,
    });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'hello');
    expect(t.provider.requests).toHaveLength(2);
    expect(exchanges(t)).toEqual([]);
  });

  it('includes the text-only call after the action limit as its own round', async () => {
    t = await createTestEngine({
      respond: (request) => (request.tools ? { toolCalls: [runAction('return 1;')] } : { text: 'Done.' }),
      runnerHandler: async () => 1,
    });
    await t.engine.settings.update({ maxActionRounds: 2, debug: { showModelTraffic: true } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'loop');
    const list = exchanges(t);
    expect(list.map((x) => [x.round, x.request.tools !== undefined])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    expect(list[2]!.request.messages.at(-1)!.content[0]).toEqual({ type: 'text', text: '[system] action limit reached, reply with text only' });
  });

  it('records a failed call with the serialized error and no response', async () => {
    t = await createTestEngine({
      respond: () => {
        throw new Error('rate limited');
      },
    });
    await t.engine.settings.update({ debug: { showModelTraffic: true } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'hello');
    const list = exchanges(t);
    expect(list).toHaveLength(1);
    expect(list[0]!.response).toBeUndefined();
    expect(list[0]!.error).toMatchObject({ message: 'rate limited' });
    expect(t.eventTypes()).toContain('error');
  });

  it('records sdk.llm.ask calls with kind llm.ask', async () => {
    t = await createTestEngine({
      respond: (request) => {
        if (request.system === ASK_DEFAULT_SYSTEM) return { text: 'pong' };
        return request.tools && request.messages.length === 1 ? { toolCalls: [runAction('return await sdk.llm.ask("ping?");', 'ask')] } : { text: 'done' };
      },
      runnerHandler: async (request, runner) => (request.context.trigger.kind === 'llm' ? runner.call(request, 'llm', 'ask', 'ping?', { maxTokens: 64 }) : undefined),
    });
    await t.engine.settings.update({ debug: { showModelTraffic: true } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'do it');

    const list = exchanges(t);
    expect(list.map((x) => x.kind)).toEqual(['turn', 'llm.ask', 'turn']);
    const ask = list[1]!;
    expect(ask.sessionId).toBe(session.id);
    expect(ask.round).toBeUndefined();
    expect(ask.turnId).toBeUndefined();
    expect(ask.request).toMatchObject({ provider: 'Mock', system: ASK_DEFAULT_SYSTEM, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping?' }] }] });
    expect(ask.request.tools).toBeUndefined();
    expect(ask.response?.message.content).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('records memory extraction with kind memory', async () => {
    t = await createTestEngine({
      respond: (request) =>
        request.system.startsWith('You maintain the long-term memory') ? { text: '[{"text":"Their cat is called Miso.","tags":["cat"],"importance":3}]' } : { text: 'ok' },
    });
    await t.engine.settings.update({ debug: { showModelTraffic: true }, memory: { enabled: true, consolidateEveryTurns: 100, maxEntriesPerCharacter: 500, promptBudgetTokens: 1500 } });
    await t.engine.packs.install(MINIMAL_DIR);
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });
    await t.engine.chat.send(session.id, 'I have a cat');
    await t.engine.chat.send(session.id, 'called Miso');
    t.events.length = 0;
    const added = await t.engine.memories.consolidate(session.id);
    expect(added).toHaveLength(1);
    const list = exchanges(t);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'memory', sessionId: session.id });
    expect(list[0]!.request.system).toContain('You maintain the long-term memory');
    expect(list[0]!.request.temperature).toBe(0);
    expect(list[0]!.response?.message.content[0]).toMatchObject({ type: 'text' });
  });
});
