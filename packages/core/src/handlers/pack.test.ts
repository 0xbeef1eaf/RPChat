import { describe, expect, it } from 'vitest';
import type { ActionContext, AssetEntry, LoadedPack } from '@rp/shared';
import { PackHandler } from './pack.js';

const entry = (path: string, extra: Partial<AssetEntry> = {}): AssetEntry => ({ path, kind: 'image', bytes: 10, mime: 'image/png', tags: ['portrait'], ...extra });

const pack = {
  root: '/tmp/p',
  manifest: { id: 'com.example.p', name: 'P', version: '1.0.0' },
  characters: [],
  assets: [
    entry('characters/a/avatar.png', { role: 'avatar' }),
    entry('characters/a/expressions/smile.png', { role: 'avatar', tags: ['portrait', 'expression'] }),
    entry('media/images/portrait.png'),
    entry('media/images/beach.png', { tags: ['beach'] }),
  ],
  tagDescriptions: {},
} as unknown as LoadedPack;

const ctx: ActionContext = { packId: 'com.example.p', characterId: 'a', sessionId: 's1', packRoot: '/tmp/p', trigger: { kind: 'behaviour', hook: 'onSessionStart' } };

describe('PackHandler', () => {
  const handler = new PackHandler({ getLoaded: () => pack });

  it('leaves the avatar and expression frames out of listings, searches and tag summaries', async () => {
    const listed = (await handler.invoke('listAssets', [], ctx)) as { path: string }[];
    expect(listed.map((a) => a.path)).toEqual(['media/images/portrait.png', 'media/images/beach.png']);
    const found = (await handler.invoke('findAssets', [{ anyTags: ['portrait'] }], ctx)) as { path: string }[];
    expect(found.map((a) => a.path)).toEqual(['media/images/portrait.png']);
    const tags = (await handler.invoke('tags', [], ctx)) as { tag: string; count: number }[];
    expect(tags).toEqual([{ tag: 'beach', count: 1 }, { tag: 'portrait', count: 1 }]);
  });

  it('still resolves an expression frame by exact path', async () => {
    const ref = (await handler.invoke('asset', ['characters/a/expressions/smile.png'], ctx)) as { path: string };
    expect(ref.path).toBe('characters/a/expressions/smile.png');
  });
});
