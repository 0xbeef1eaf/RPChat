import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@rp/llm';
import type { ChatMessage, LlmChatRequest } from '@rp/shared';
import { TypedEmitter } from '../emitter.js';
import { MemoryStorage } from '../storage/memory.js';
import { ECHO_REF, FakeClock, MOCK_PROVIDER, MINIMAL_DIR, createTestEngine } from '../test/helpers.js';
import type { TestEngine } from '../test/helpers.js';
import type { EngineEvents } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
import { COMPRESSION_MIN_MESSAGES, HistoryService, transcriptTokens } from './history.js';
import { SettingsService } from './settings.js';

const REF = 'com.example.luna/luna';

function harness(respond?: (request: LlmChatRequest) => { text: string }) {
  const storage = new MemoryStorage();
  const clock = new FakeClock('2026-03-10T12:00:00.000Z');
  const provider = new MockProvider(MOCK_PROVIDER, respond ? { respond } : {});
  const settings = new SettingsService(storage, () => provider);
  const emitter = new TypedEmitter<EngineEvents>();
  const packs = {
    tryGetLoaded: () => ({}) as never,
    getCharacter: () => ({ pack: {} as never, character: { definition: { name: 'Luna' } } as never }),
  };
  const history = new HistoryService({ storage, settings, packs, providerFactory: () => provider, emitter, now: clock.now, logger: NOOP_LOGGER });
  return { storage, clock, provider, settings, history };
}

async function seed(h: ReturnType<typeof harness>, count: number, sessionId = 's1'): Promise<void> {
  await h.settings.update({ providers: [MOCK_PROVIDER], defaultProviderId: MOCK_PROVIDER.id });
  await h.storage.sessions.upsert({ id: sessionId, characterRef: REF, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 });
  for (let i = 1; i <= count; i++) {
    await h.storage.messages.append({
      id: `m${i}`,
      sessionId,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `message number ${i} with enough words in it to cost a few tokens`,
      createdAt: h.clock.now().toISOString(),
    });
  }
}

function msg(i: number, role: ChatMessage['role'], content: string, actions?: ChatMessage['actions']): ChatMessage {
  return { id: `m${i}`, sessionId: 's1', role, content, createdAt: new Date(i).toISOString(), ...(actions ? { actions } : {}) };
}

describe('HistoryService', () => {
  it('summarises everything but the most recent messages and remembers how far it got', async () => {
    const h = harness(() => ({ text: 'Luna and Sam talked about the rain and she promised to remind him at six.' }));
    await seed(h, 30);
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10 } });

    const summary = await h.history.compress('s1');
    expect(summary).toMatchObject({ throughMessageId: 'm20', messageCount: 20, text: expect.stringContaining('promised to remind him') });
    expect(await h.history.summaryFor('s1')).toEqual(summary);
    // The summariser only ever sees the messages it is asked to cover.
    const sent = h.provider.requests.at(-1)!;
    expect(sent.messages[0]!.content[0]).toMatchObject({ text: expect.stringContaining('message number 20') });
    expect(JSON.stringify(sent.messages)).not.toContain('message number 21');
    expect(sent.system).toContain('There is no earlier summary');
  });

  it('extends an existing summary with only the messages added since', async () => {
    const h = harness(() => ({ text: 'First pass summary.' }));
    await seed(h, 30);
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10 } });
    await h.history.compress('s1');

    for (let i = 31; i <= 45; i++) {
      await h.storage.messages.append({ id: `m${i}`, sessionId: 's1', role: i % 2 === 1 ? 'user' : 'assistant', content: `later message ${i}`, createdAt: 't' });
    }
    const second = await h.history.compress('s1');
    expect(second).toMatchObject({ throughMessageId: 'm35', messageCount: 35 });
    const sent = h.provider.requests.at(-1)!;
    expect(sent.system).toContain('The summary so far:\nFirst pass summary.');
    const body = JSON.stringify(sent.messages);
    expect(body).toContain('later message 31'); // new since the last summary
    expect(body).not.toContain('message number 12'); // already covered by the carried summary
  });

  it('does nothing without enough summarisable messages, and serialises concurrent calls', async () => {
    const h = harness(() => ({ text: 'summary' }));
    await seed(h, COMPRESSION_MIN_MESSAGES + 2);
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 16 } });
    expect(await h.history.compress('s1')).toBeUndefined();
    expect(h.provider.requests).toHaveLength(0);

    await seed(h, 40, 's2');
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10 } });
    const [a, b] = await Promise.all([h.history.compress('s2'), h.history.compress('s2')]);
    expect(a).toEqual(b);
    expect(h.provider.requests).toHaveLength(1); // one model call, not two
    expect(h.history.isCompressing('s2')).toBe(false);
  });

  it('honours the master switch for automatic runs and never throws on provider failure', async () => {
    const h = harness(() => {
      throw new Error('provider is down');
    });
    await seed(h, 40);
    await h.settings.update({ history: { ...(await h.settings.get()).history, compress: false, keepRecentMessages: 10 } });
    expect(await h.history.compress('s1', { auto: true })).toBeUndefined();
    expect(h.provider.requests).toHaveLength(0);

    // An explicit call still runs, and a failing provider leaves no summary behind.
    expect(await h.history.compress('s1')).toBeUndefined();
    expect(await h.history.summaryFor('s1')).toBeUndefined();
  });

  it('clear() forgets the summary', async () => {
    const h = harness(() => ({ text: 'summary' }));
    await seed(h, 40);
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10 } });
    expect(await h.history.compress('s1')).toBeDefined();
    await h.history.clear('s1');
    expect(await h.history.summaryFor('s1')).toBeUndefined();
  });

  it('shouldCompress weighs action code and results, not just the visible text', async () => {
    const h = harness();
    const plain = Array.from({ length: 20 }, (_, i) => msg(i, i % 2 === 0 ? 'user' : 'assistant', 'short'));
    const settings = { compress: true, compressAboveTokens: 400, keepRecentMessages: 4 };
    expect(h.history.shouldCompress(plain, settings)).toBe(false);

    const heavy = plain.map((m, i) =>
      i % 2 === 1
        ? msg(i, 'assistant', 'short', [
            {
              id: `a${i}`,
              purpose: 'show a picture',
              code: 'x'.repeat(400),
              language: 'ts',
              source: 'tool',
              result: { ok: true, returnValue: 'y'.repeat(200), logs: [], durationMs: 1 },
            },
          ])
        : m,
    );
    expect(transcriptTokens(heavy)).toBeGreaterThan(transcriptTokens(plain));
    expect(h.history.shouldCompress(heavy, settings)).toBe(true);
    expect(h.history.shouldCompress(heavy, { ...settings, compress: false })).toBe(false);
    // Too few messages to be worth a call, however heavy they are.
    expect(h.history.shouldCompress(heavy.slice(0, 5), settings)).toBe(false);
  });
});

describe('history compression through the engine', () => {
  let t: TestEngine | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });

  it('compresses in the background after a turn and uses the summary in the next prompt', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'Sam and Echo have been chatting all afternoon; Sam asked for reminders.' }) });
    await t.engine.packs.install(MINIMAL_DIR);
    await t.engine.settings.update({ history: { ...(await t.engine.settings.get()).history, compressAboveTokens: 200, keepRecentMessages: 4 } });
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    for (let i = 0; i < 6; i++) await t.engine.chat.send(session.id, `turn ${i}: a message long enough to push the transcript over the threshold`);
    await t.engine.history.idle();

    const summary = await t.engine.history.summaryFor(session.id);
    expect(summary?.text).toContain('Sam and Echo');
    expect(summary?.messageCount).toBeGreaterThan(0);

    await t.engine.chat.send(session.id, 'and now?');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('<history_summary>');
    expect(system).toContain('Sam and Echo have been chatting');

    // Clearing the session's history throws the summary away with the messages it described.
    await t.engine.chat.clearMessages(session.id);
    expect(await t.engine.history.summaryFor(session.id)).toBeUndefined();
  });
});
