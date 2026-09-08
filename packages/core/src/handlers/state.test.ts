import { describe, expect, it } from 'vitest';
import type { ActionContext } from '@rp/shared';
import { MemoryStorage } from '../storage/memory.js';
import { STATE_MAX_KEYS, STATE_MAX_VALUE_BYTES, StateHandler } from './state.js';

const ctx = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  packId: 'com.example.p',
  characterId: 'a',
  sessionId: 's1',
  packRoot: '/tmp/p',
  trigger: { kind: 'behaviour', hook: 'onSessionStart' },
  ...overrides,
});

describe('StateHandler', () => {
  it('scopes character and session state separately', async () => {
    const storage = new MemoryStorage();
    const handler = new StateHandler(storage.state);
    await handler.invoke('set', ['name', 'Sam'], ctx());
    await handler.invoke('session.set', ['greeted', true], ctx());

    expect(await handler.invoke('get', ['name'], ctx())).toBe('Sam');
    expect(await handler.invoke('get', ['greeted'], ctx())).toBeUndefined();
    expect(await handler.invoke('session.get', ['greeted'], ctx())).toBe(true);
    // same character, another session shares persistent state but not session state
    expect(await handler.invoke('get', ['name'], ctx({ sessionId: 's2' }))).toBe('Sam');
    expect(await handler.invoke('session.get', ['greeted'], ctx({ sessionId: 's2' }))).toBeUndefined();
    // another character sees nothing
    expect(await handler.invoke('get', ['name'], ctx({ characterId: 'b' }))).toBeUndefined();

    expect(await storage.state.keys('char:com.example.p/a')).toEqual(['name']);
    expect(await storage.state.keys('session:s1')).toEqual(['greeted']);
    expect(await handler.invoke('all', [], ctx())).toEqual({ name: 'Sam' });
    expect(await handler.invoke('session.all', [], ctx())).toEqual({ greeted: true });

    await handler.invoke('delete', ['name'], ctx());
    expect(await handler.invoke('keys', [], ctx())).toEqual([]);
  });

  it('enforces value size and key count caps', async () => {
    const handler = new StateHandler(new MemoryStorage().state);
    await expect(handler.invoke('set', ['big', 'x'.repeat(STATE_MAX_VALUE_BYTES)], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await handler.invoke('set', ['ok', 'x'.repeat(STATE_MAX_VALUE_BYTES - 2)], ctx());
    for (let i = 1; i < STATE_MAX_KEYS; i++) await handler.invoke('set', [`k${i}`, i], ctx());
    expect((await handler.invoke('keys', [], ctx()) as string[]).length).toBe(STATE_MAX_KEYS);
    await expect(handler.invoke('set', ['one-too-many', 1], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // overwriting an existing key is still fine
    await handler.invoke('set', ['k1', 'again'], ctx());
    await expect(handler.invoke('set', ['', 1], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('set', ['novalue'], ctx())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('nope', [], ctx())).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });
});

describe('HelpHandler', () => {
  it('returns the full reference of granted modules only', async () => {
    const { HelpHandler } = await import('./help.js');
    const { createStandardRegistry } = await import('@rp/sdk');
    const registry = createStandardRegistry();
    const handler = new HelpHandler(registry, { allowedModules: async () => ['chat', 'log', 'help', 'media'] });
    const context = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/x', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } } as const;
    const modules = (await handler.invoke('modules', [], context)) as Array<{ id: string }>;
    expect(modules.map((m) => m.id)).toEqual(['chat', 'log', 'help', 'media']);
    const media = (await handler.invoke('module', ['sdk.media'], context)) as { id: string; typings: string; docs: string };
    expect(media.id).toBe('media');
    expect(media.typings).toContain('interface MediaApi');
    expect(media.docs).toContain('overlay');
    await expect(handler.invoke('module', ['system'], context)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(handler.invoke('module', [''], context)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
