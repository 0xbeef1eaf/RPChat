import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@rp/llm';
import { DEFAULT_HISTORY_SETTINGS } from '@rp/shared';
import type { ChatMessage, HistorySettings, LlmChatRequest } from '@rp/shared';
import { TypedEmitter } from '../emitter.js';
import { MemoryStorage } from '../storage/memory.js';
import { ECHO_REF, FakeClock, MOCK_PROVIDER, MINIMAL_DIR, createTestEngine } from '../test/helpers.js';
import type { TestEngine } from '../test/helpers.js';
import type { EngineEvents } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
import { COMPRESSION_MIN_MESSAGES, COMPRESS_BUDGET_FRACTION, COMPRESS_MIN_THRESHOLD, HistoryService, compressionThreshold, transcriptTokens } from './history.js';
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
    expect(sent.system).toContain('These are the earliest messages');
    expect(summary?.segments).toEqual([{ text: expect.stringContaining('promised to remind him'), messageCount: 20 }]);
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
    // The earlier summary is context for the new segment, not something to rewrite.
    expect(sent.system).toContain('for context only');
    expect(sent.system).toContain('First pass summary.');
    const body = JSON.stringify(sent.messages);
    expect(body).toContain('later message 31'); // new since the last summary
    expect(body).not.toContain('message number 12'); // already covered by the carried summary
  });

  it('appends a segment per pass and leaves the earlier ones word for word', async () => {
    let pass = 0;
    const h = harness(() => ({ text: `pass ${++pass} recap` }));
    await seed(h, 30);
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10, summaryBudgetTokens: 4_000 } });
    await h.history.compress('s1');

    for (let i = 31; i <= 45; i++) {
      await h.storage.messages.append({ id: `m${i}`, sessionId: 's1', role: 'user', content: `later message ${i}`, createdAt: 't' });
    }
    const second = await h.history.compress('s1');
    expect(second!.segments).toEqual([
      { text: 'pass 1 recap', messageCount: 20 },
      { text: 'pass 2 recap', messageCount: 15 },
    ]);
    // `text` is what the prompt shows: the segments in order, the first untouched by the second pass.
    expect(second!.text).toBe('pass 1 recap\n\npass 2 recap');
    expect(second!.segments.reduce((n, seg) => n + seg.messageCount, 0)).toBe(second!.messageCount);
  });

  it('folds the older segments into one only once the summary outgrows its budget', async () => {
    let pass = 0;
    const h = harness((request) => ({ text: request.system.includes('condensing') ? 'folded recap' : `${'pass'.repeat(100)} ${++pass}` }));
    await seed(h, 30);
    // A 400-character budget caps a segment at 300, so two full ones cannot both fit.
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 10, summaryBudgetTokens: 40 } });
    await h.history.compress('s1');

    for (let i = 31; i <= 45; i++) {
      await h.storage.messages.append({ id: `m${i}`, sessionId: 's1', role: 'user', content: `later message ${i}`, createdAt: 't' });
    }
    const second = await h.history.compress('s1');
    expect(second!.segments).toHaveLength(2);
    expect(second!.segments[0]).toEqual({ text: 'folded recap', messageCount: 20 });
    expect(second!.segments[1]!.messageCount).toBe(15); // the newest pass survives the fold as written
    expect(second!.messageCount).toBe(35);
  });

  it('reads a summary written before segments existed as one segment', async () => {
    const h = harness(() => ({ text: 'new recap' }));
    await seed(h, 30);
    await h.storage.state.set('session:s1', 'history.summary', {
      text: 'legacy recap',
      throughMessageId: 'm20',
      messageCount: 20,
      updatedAt: 't',
    });
    const loaded = await h.history.summaryFor('s1');
    expect(loaded!.segments).toEqual([{ text: 'legacy recap', messageCount: 20 }]);
  });

  it('tells the summariser what the character did, not only what was said', async () => {
    const h = harness(() => ({ text: 'recap' }));
    await h.settings.update({ providers: [MOCK_PROVIDER], defaultProviderId: MOCK_PROVIDER.id });
    await h.storage.sessions.upsert({ id: 's1', characterRef: REF, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 });
    for (let i = 1; i <= 10; i++) {
      const actions: ChatMessage['actions'] =
        i === 4
          ? [{ id: 'a1', purpose: 'show the photo from the lake', code: 'x', language: 'ts', source: 'tool', startedAt: 't', result: { ok: true, returnValue: null, logs: [], durationMs: 1 } }]
          : i === 6
            ? [{ id: 'a2', purpose: 'set the wallpaper', code: 'x', language: 'ts', source: 'tool', startedAt: 't', result: { ok: false, error: { code: 'PERMISSION_DENIED', message: 'no' }, logs: [], durationMs: 1 } as never }]
            : undefined;
      await h.storage.messages.append({
        id: `m${i}`,
        sessionId: 's1',
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `said thing ${i}`,
        createdAt: 't',
        ...(actions ? { actions } : {}),
      });
    }
    await h.settings.update({ history: { ...(await h.settings.get()).history, keepRecentMessages: 2 } });
    await h.history.compress('s1');

    const transcript = JSON.stringify(h.provider.requests.at(-1)!.messages);
    expect(transcript).toContain('[Luna: show the photo from the lake]');
    expect(transcript).toContain('[Luna tried to set the wallpaper — it failed]');
    expect(transcript).not.toContain('a1'); // the purpose travels, the code does not
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
    const settings: HistorySettings = { ...DEFAULT_HISTORY_SETTINGS, compressAboveTokens: 400, keepRecentMessages: 4, keepActionDetailFor: 99 };
    expect(h.history.shouldCompress(plain, settings, 10_000)).toBe(false);

    const heavy = plain.map((m, i) =>
      i % 2 === 1
        ? msg(i, 'assistant', 'short', [
            {
              id: `a${i}`,
              purpose: 'show a picture',
              code: 'x'.repeat(400),
              language: 'ts',
              source: 'tool',
              startedAt: 't',
              result: { ok: true, returnValue: 'y'.repeat(200), logs: [], durationMs: 1 },
            },
          ])
        : m,
    );
    expect(transcriptTokens(heavy)).toBeGreaterThan(transcriptTokens(plain));
    expect(h.history.shouldCompress(heavy, settings, 10_000)).toBe(true);
    expect(h.history.shouldCompress(heavy, { ...settings, compress: false }, 10_000)).toBe(false);
    // Too few messages to be worth a call, however heavy they are.
    expect(h.history.shouldCompress(heavy.slice(0, 5), settings, 10_000)).toBe(false);

    // ...but only for the messages that will still carry that detail into the prompt. At the
    // default of 0 the same transcript costs what its visible text costs, and does not trigger.
    expect(transcriptTokens(heavy, 0)).toBe(transcriptTokens(plain, 0));
    expect(h.history.shouldCompress(heavy, { ...settings, keepActionDetailFor: 0 }, 10_000)).toBe(false);
    expect(transcriptTokens(heavy, 1)).toBeLessThan(transcriptTokens(heavy, 99));
  });

  it('derives the threshold from the room the transcript has, unless one is pinned', () => {
    expect(compressionThreshold({ compressAboveTokens: 6_000 }, 50_000)).toBe(6_000);
    expect(compressionThreshold({ compressAboveTokens: 0 }, 50_000)).toBe(50_000 * COMPRESS_BUDGET_FRACTION);
    // A bigger budget moves the threshold with it, which is the point of deriving it.
    expect(compressionThreshold({ compressAboveTokens: 0 }, 180_000)).toBeGreaterThan(compressionThreshold({ compressAboveTokens: 0 }, 50_000));
    expect(compressionThreshold({ compressAboveTokens: 0 }, 100)).toBe(COMPRESS_MIN_THRESHOLD);
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

  it('compresses when the window had to drop messages, however high the threshold is', async () => {
    t = await createTestEngine({ respond: () => ({ text: 'Sam and Echo went over the plan for the week.' }) });
    await t.engine.packs.install(MINIMAL_DIR);
    // A threshold that can never be reached, and a budget too small for the transcript: without
    // the drop check the oldest messages would fall out of the prompt uncompressed, remembered
    // by nothing.
    await t.engine.settings.update({
      contextTokenBudget: 1_000,
      history: { ...(await t.engine.settings.get()).history, compressAboveTokens: 1_000_000, keepRecentMessages: 4 },
    });
    const session = await t.engine.sessions.create({ characterRef: ECHO_REF });

    for (let i = 0; i < 6; i++) {
      await t.engine.chat.send(session.id, `turn ${i}: ${'a message with a fair few words in it '.repeat(20)}`);
    }
    await t.engine.history.idle();

    const summary = await t.engine.history.summaryFor(session.id);
    expect(summary?.text).toContain('Sam and Echo');
    expect(summary!.messageCount).toBeGreaterThan(0);
  });
});
