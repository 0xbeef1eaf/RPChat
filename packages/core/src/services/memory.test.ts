import { describe, expect, it } from 'vitest';
import { MockProvider } from '@rp/llm';
import { estimateTokens } from '@rp/llm';
import type { ChatEvent, ChatMessage, LlmChatRequest, MemoryEntry } from '@rp/shared';
import { TypedEmitter } from '../emitter.js';
import { MemoryStorage } from '../storage/memory.js';
import { FakeClock, MOCK_PROVIDER } from '../test/helpers.js';
import type { EngineEvents } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
import { memoryFocus } from './chat.js';
import { MemoryService, memoryLine, parseJsonArray } from './memory.js';
import { SettingsService } from './settings.js';

const REF = 'com.example.luna/luna';

function harness(respond?: (request: LlmChatRequest) => { text: string }) {
  const storage = new MemoryStorage();
  const clock = new FakeClock('2026-03-10T12:00:00.000Z');
  const provider = new MockProvider(MOCK_PROVIDER, respond ? { respond } : {});
  const settings = new SettingsService(storage, () => provider);
  const emitter = new TypedEmitter<EngineEvents>();
  const events: ChatEvent[] = [];
  emitter.on('chat', (e) => events.push(e));
  const packs = {
    tryGetLoaded: () => ({}) as never,
    getCharacter: () => ({ pack: {} as never, character: { definition: { name: 'Luna' } } as never }),
  };
  const memories = new MemoryService({ storage, settings, packs, providerFactory: () => provider, emitter, now: clock.now, logger: NOOP_LOGGER });
  return { storage, clock, provider, settings, memories, events };
}

async function seedSession(h: ReturnType<typeof harness>, id = 's1', turns: string[] = []) {
  await h.settings.update({ providers: [MOCK_PROVIDER], defaultProviderId: MOCK_PROVIDER.id });
  await h.storage.sessions.upsert({ id, characterRef: REF, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 });
  let i = 0;
  for (const text of turns) {
    i += 1;
    await h.storage.messages.append({ id: `m${i}`, sessionId: id, role: i % 2 === 1 ? 'user' : 'assistant', content: text, createdAt: h.clock.now().toISOString() });
  }
}

describe('MemoryService', () => {
  it('adds with normalisation, updates, removes and searches (bumping recall stats)', async () => {
    const h = harness();
    const added = await h.memories.add(REF, '  Their cat is called Miso.  ', { tags: ['Pets', 'pets', ' cat '], importance: 9 });
    expect(added).toMatchObject({ text: 'Their cat is called Miso.', tags: ['pets', 'cat'], importance: 5, source: 'user', recallCount: 0 });
    const long = await h.memories.add(REF, 'x'.repeat(600));
    expect(long.text.length).toBeLessThanOrEqual(500);
    await expect(h.memories.add(REF, '   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    h.clock.advance(1000);
    const updated = await h.memories.update({ id: added.id, importance: 2, tags: ['pets'] });
    expect(updated).toMatchObject({ text: 'Their cat is called Miso.', importance: 2, tags: ['pets'] });
    expect(updated.updatedAt > added.updatedAt).toBe(true);
    await expect(h.memories.update({ id: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const hits = await h.memories.search(REF, 'cat', 10);
    expect(hits.map((m) => m.id)).toEqual([added.id]);
    expect((await h.memories.get(added.id))?.recallCount).toBe(1);
    expect((await h.memories.get(added.id))?.lastRecalledAt).toBe(h.clock.now().toISOString());
    expect(await h.memories.search(REF, 'zzz', 10)).toEqual([]);

    expect(await h.memories.remove(added.id)).toBe(true);
    expect(await h.memories.remove(added.id)).toBe(false);
    expect((await h.memories.list(REF)).map((m) => m.id)).toEqual([long.id]);
    expect(await h.memories.list('other/char')).toEqual([]);
  });

  it('forPrompt keeps top importance + newest + relevant within the budget, deduped and ordered', async () => {
    const h = harness();
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 20; i++) {
      h.clock.advance(60_000);
      entries.push(await h.memories.add(REF, `Fact number ${i} about ordinary days`, { importance: i === 5 ? 5 : i === 7 ? 4 : 2 }));
    }
    const relevant = await h.memories.add(REF, 'They love hiking in the mountains every spring', { tags: ['hiking'], importance: 2 });

    const picked = await h.memories.forPrompt(REF, 'want to go hiking this weekend?', 400);
    const ids = picked.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(entries[5]!.id); // top importance
    expect(ids).toContain(entries[7]!.id);
    expect(ids).toContain(relevant.id); // newest and relevant
    expect(ids).toContain(entries[19]!.id); // among the 3 newest
    const cost = picked.reduce((n, m) => n + estimateTokens(memoryLine(m)) + 1, 0);
    expect(cost).toBeLessThanOrEqual(400);
    // stable order: importance desc, createdAt asc
    for (let i = 1; i < picked.length; i++) {
      const a = picked[i - 1]!;
      const b = picked[i]!;
      expect(a.importance > b.importance || (a.importance === b.importance && a.createdAt <= b.createdAt)).toBe(true);
    }
    // forPrompt does not count as a recall
    expect((await h.memories.get(relevant.id))?.recallCount).toBe(0);

    expect(await h.memories.forPrompt(REF, 'x', 0)).toEqual([]);
    expect(await h.memories.forPrompt('nobody/here', 'x', 100)).toEqual([]);
    expect((await h.memories.forPrompt(REF, 'x', 30)).length).toBeLessThanOrEqual(2);
  });

  it('consolidates from fenced JSON: adds, dedupes, bumps importance, prunes and emits events', async () => {
    const requests: LlmChatRequest[] = [];
    const h = harness((request) => {
      requests.push(request);
      return {
        text: [
          'Here is what I found:',
          '```json',
          JSON.stringify([
            { text: 'They work as a nurse on night shifts.', tags: ['Work', 'work'], importance: 4 },
            { text: 'Their cat is called Miso and sleeps on the keyboard.', tags: ['pets'], importance: 5 },
            { text: 'They mentioned liking tea.', importance: 'high' },
            { nonsense: true },
          ]),
          '```',
        ].join('\n'),
      };
    });
    await seedSession(h, 's1', ['hi', 'hello', 'I am a nurse, night shifts', 'oh wow', 'and my cat Miso sleeps on the keyboard', 'cute']);
    const existing = await h.memories.add(REF, 'Their cat is called Miso and sleeps on the keyboard!', { importance: 3, source: 'character' });
    await h.settings.update({ memory: { enabled: true, consolidateEveryTurns: 6, maxEntriesPerCharacter: 3, promptBudgetTokens: 1500 } });

    const added = await h.memories.consolidate('s1');
    expect(added.map((m) => m.text)).toEqual(['They work as a nurse on night shifts.', 'They mentioned liking tea.']);
    expect(added[0]).toMatchObject({ source: 'consolidation', sessionId: 's1', tags: ['work'], importance: 4 });
    expect(added[1]!.importance).toBe(3);
    expect((await h.memories.get(existing.id))?.importance).toBe(5); // duplicate bumped, not re-added
    expect(h.events.filter((e) => e.type === 'memory-added')).toHaveLength(2);

    const request = requests[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.system).toContain('You maintain the long-term memory of Luna');
    expect(request.system).toContain('Their cat is called Miso');
    expect(request.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    const transcript = (request.messages[0]!.content[0] as { text: string }).text;
    expect(transcript).toContain('You: I am a nurse, night shifts');
    expect(transcript).toContain('Luna: cute');
    expect(await h.storage.state.get('session:s1', 'memory.lastConsolidatedMessageId')).toBe('m6');

    // nothing new since the marker → no provider call
    expect(await h.memories.consolidate('s1')).toEqual([]);
    expect(requests).toHaveLength(1);

    // pruning to maxEntriesPerCharacter=3 kept the three (all ≤ cap here); lower the cap and prune again
    expect(await h.memories.prune(REF, 1)).toBe(2);
    expect((await h.memories.list(REF)).map((m) => m.text)).toEqual(['Their cat is called Miso and sleeps on the keyboard!']);
  });

  it('skips short sessions, tolerates garbage replies, honours the enabled switch and locks per session', async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return { text: 'no json here' };
    });
    await seedSession(h, 'short', ['hi', 'hello', 'bye']);
    expect(await h.memories.consolidate('short')).toEqual([]);
    expect(calls).toBe(0);

    await seedSession(h, 'long', ['a', 'b', 'c', 'd', 'e']);
    expect(await h.memories.consolidate('long')).toEqual([]);
    expect(calls).toBe(1);
    expect(await h.memories.consolidate('missing-session')).toEqual([]);

    await h.settings.update({ memory: { enabled: false, consolidateEveryTurns: 6, maxEntriesPerCharacter: 500, promptBudgetTokens: 1500 } });
    await h.storage.state.delete('session:long', 'memory.lastConsolidatedMessageId');
    expect(await h.memories.consolidate('long', { auto: true })).toEqual([]);
    expect(calls).toBe(1);
    const p1 = h.memories.consolidate('long');
    const p2 = h.memories.consolidate('long');
    expect(p1).toBe(p2);
    expect(h.memories.isConsolidating('long')).toBe(true);
    await h.memories.idle();
    expect(calls).toBe(2);
    expect(h.memories.isConsolidating('long')).toBe(false);
  });

  it('parses the first JSON array out of prose and fences', () => {
    expect(parseJsonArray('Sure! ```json\n[{"a":1}]\n``` done')).toEqual([{ a: 1 }]);
    expect(parseJsonArray('[1, 2] and [3]')).toEqual([1, 2]);
    expect(parseJsonArray('nothing')).toBeUndefined();
    expect(parseJsonArray('{"a": [1]}')).toEqual([1]);
  });
});

describe('memoryFocus', () => {
  const said = (i: number, role: ChatMessage['role'], content: string): ChatMessage => ({ id: `m${i}`, sessionId: 's1', role, content, createdAt: 't' });

  it('matches against the last few messages, not only the latest one', () => {
    const transcript = [
      said(1, 'user', 'my sister is called Nell'),
      said(2, 'assistant', 'noted'),
      said(3, 'user', 'she is a vet'),
      said(4, 'assistant', 'nice'),
      said(5, 'user', 'anyway'),
      said(6, 'assistant', 'mm'),
    ];
    const focus = memoryFocus(transcript);
    expect(focus).toContain('Nell'); // three messages back, and still part of the handle
    expect(focus).toContain('mm');
    expect(focus.split('\n')).toHaveLength(6);
  });

  it('keeps only the newest `count`, skips blanks and system messages', () => {
    const transcript = [
      said(1, 'user', 'oldest'),
      said(2, 'system', 'a wake note'),
      said(3, 'assistant', '   '),
      said(4, 'user', 'newest'),
    ];
    expect(memoryFocus(transcript, 2)).toBe('oldest\nnewest');
    expect(memoryFocus(transcript, 1)).toBe('newest');
    expect(memoryFocus([], 4)).toBe('');
  });
});
