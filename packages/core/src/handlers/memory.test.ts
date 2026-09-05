import { describe, expect, it } from 'vitest';
import { MockProvider } from '@rp/llm';
import type { ActionContext } from '@rp/shared';
import { TypedEmitter } from '../emitter.js';
import { MemoryService } from '../services/memory.js';
import { SettingsService } from '../services/settings.js';
import { MemoryStorage } from '../storage/memory.js';
import { FakeClock, MOCK_PROVIDER } from '../test/helpers.js';
import type { EngineEvents } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
import { MEMORY_LIST_MAX, MemoryHandler } from './memory.js';

const ctx = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  packId: 'com.example.p',
  characterId: 'a',
  sessionId: 's1',
  packRoot: '/tmp/p',
  trigger: { kind: 'llm', actionId: 'x', messageId: 'y' },
  ...overrides,
});

function setup() {
  const storage = new MemoryStorage();
  const clock = new FakeClock();
  const provider = new MockProvider(MOCK_PROVIDER);
  const memories = new MemoryService({
    storage,
    settings: new SettingsService(storage, () => provider),
    packs: { tryGetLoaded: () => undefined, getCharacter: () => { throw new Error('unused'); } },
    providerFactory: () => provider,
    emitter: new TypedEmitter<EngineEvents>(),
    now: clock.now,
    logger: NOOP_LOGGER,
  });
  return { memories, handler: new MemoryHandler(memories), clock };
}

describe('MemoryHandler', () => {
  it('remember/recall/recent/update/forget are scoped to the acting character with SDK-shaped results', async () => {
    const { handler, memories, clock } = setup();
    const m = (await handler.invoke('remember', ['Their cat is Miso.', { tags: ['Pets'], importance: 4 }], ctx())) as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual(['createdAt', 'id', 'importance', 'source', 'tags', 'text', 'updatedAt']);
    expect(m).toMatchObject({ text: 'Their cat is Miso.', tags: ['pets'], importance: 4, source: 'character' });
    expect((await memories.get(m.id as string))?.sessionId).toBe('s1');

    clock.advance(1000);
    await handler.invoke('remember', ['They drink oat milk.'], ctx());
    const recent = (await handler.invoke('recent', [], ctx())) as Array<{ text: string }>;
    expect(recent.map((r) => r.text)).toEqual(['They drink oat milk.', 'Their cat is Miso.']);
    expect((await handler.invoke('recent', [1], ctx())) as unknown[]).toHaveLength(1);

    const hits = (await handler.invoke('recall', ['cat'], ctx())) as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toEqual([m.id]);
    expect((await handler.invoke('recall', ['cat'], ctx({ characterId: 'b' }))) as unknown[]).toEqual([]);

    const updated = (await handler.invoke('update', [m.id, { text: 'Their cat is called Miso.', importance: 5 }], ctx())) as Record<string, unknown>;
    expect(updated).toMatchObject({ text: 'Their cat is called Miso.', importance: 5, tags: ['pets'] });
    await expect(handler.invoke('update', [m.id, { text: 'hijack' }], ctx({ characterId: 'b' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await handler.invoke('forget', [m.id], ctx({ characterId: 'b' }))).toBe(false);
    expect(await handler.invoke('forget', [m.id], ctx())).toBe(true);
    expect(await handler.invoke('forget', [m.id], ctx())).toBe(false);
  });

  it('validates arguments and caps limits', async () => {
    const { handler } = setup();
    for (let i = 0; i < 60; i++) await handler.invoke('remember', [`fact ${i} about tea`], ctx());
    expect((await handler.invoke('recent', [500], ctx())) as unknown[]).toHaveLength(MEMORY_LIST_MAX);
    expect((await handler.invoke('recall', ['tea', 500], ctx())) as unknown[]).toHaveLength(MEMORY_LIST_MAX);
    expect((await handler.invoke('recall', ['tea'], ctx())) as unknown[]).toHaveLength(10);
    await expect(handler.invoke('recall', [''], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('recall', ['tea', 0], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('remember', [''], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('remember', ['x', { tags: 'pets' }], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('remember', ['x', { importance: 'high' }], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('update', ['', {}], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('nope', [], ctx())).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });
});
