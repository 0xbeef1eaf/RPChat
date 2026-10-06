import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json, MediaSourceProvider, MediaSourceQuery } from '@rp/shared';
import { MediaSourceService, normaliseQuery } from './services/media-sources.js';
import { LUNA_ID, LUNA_REF, RecordingHandler, createTestEngine, installLunaWith } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const ctx: ActionContext = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const ALBUMS = { id: 'com.test.photos/albums', pluginId: 'com.test.photos', title: 'Albums', description: 'Holiday photos and clips.', kinds: ['image', 'video'] as Array<'image' | 'video'> };

/** A provider that answers every search with `items` and records the queries it was given. */
function provider(items: unknown[], location: unknown = { url: 'https://photos.example/x.jpg' }): MediaSourceProvider & { queries: MediaSourceQuery[] } {
  const queries: MediaSourceQuery[] = [];
  return {
    queries,
    search: (query) => {
      queries.push(query);
      return items as never;
    },
    fetch: () => location as never,
  };
}

describe('MediaSourceService', () => {
  it('checks what a provider returns and remembers the results', async () => {
    const service = new MediaSourceService({ logger });
    const p = provider([
      { id: 'beach/1', kind: 'image', mime: 'image/JPEG', tags: ['Beach', 'sea', 'beach', 3], description: '  Sunset at the pier  ', bytes: 1234.7 },
      { id: 'clip', kind: 'video' },
      { id: 'song', kind: 'audio' }, // not a kind the source serves
      { id: '', kind: 'image' },
      { id: 'tab\there', kind: 'image' },
      'nonsense',
    ]);
    service.register(ALBUMS, p);
    const results = await service.search('com.test.photos/albums', { text: '  beach  ', tags: ['Sea', ''], limit: 10, page: 2, extra: true }, ctx);
    expect(p.queries).toEqual([{ text: 'beach', tags: ['sea'], limit: 10, page: 2 }]);
    expect(results).toEqual([
      { source: 'remote', path: 'com.test.photos/albums/beach/1', kind: 'image', mime: 'image/jpeg', bytes: 1234, tags: ['beach', 'sea'], description: 'Sunset at the pier' },
      { source: 'remote', path: 'com.test.photos/albums/clip', kind: 'video', mime: 'video/*', bytes: 0, tags: [] },
    ]);
    expect(service.describe('com.test.photos/albums/clip')?.kind).toBe('video');
    // A kind filter is passed on and enforced on what comes back.
    expect((await service.search('com.test.photos/albums', { kind: 'video' }, ctx)).map((r) => r.path)).toEqual(['com.test.photos/albums/clip']);
    // limit caps what the character gets, whatever the provider sends.
    expect(await service.search('com.test.photos/albums', { limit: 1 }, ctx)).toHaveLength(1);
  });

  it('refuses bad queries, unknown sources and bad locations', async () => {
    const service = new MediaSourceService({ logger });
    expect(() => normaliseQuery({ kind: 'audio' }, ALBUMS)).toThrow(/has no audio/);
    expect(() => normaliseQuery({ limit: 0 }, ALBUMS)).toThrow(/limit/);
    expect(() => normaliseQuery({ page: 1.5 }, ALBUMS)).toThrow(/page/);
    expect(() => normaliseQuery([], ALBUMS)).toThrow(/object/);
    expect(normaliseQuery({ limit: 500 }, ALBUMS).limit).toBe(50);
    await expect(service.search('com.test.photos/albums', {}, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/none are installed/) });

    service.register(ALBUMS, provider([{ id: 'a', kind: 'image' }], { url: 'file:///etc/passwd' }));
    expect(() => service.register(ALBUMS, provider([]))).toThrow(/already registered/);
    expect(() => service.register({ ...ALBUMS, id: 'albums' }, provider([]))).toThrow(/<pluginId>\/<id>/);
    expect(() => service.register({ ...ALBUMS, id: 'com.other/albums' }, provider([]))).toThrow(/<pluginId>\/<id>/);
    expect(() => service.register({ ...ALBUMS, id: 'com.test.photos/x', kinds: [] }, provider([]))).toThrow(/at least one/);
    await expect(service.locate('com.test.photos/albums/a', ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringMatching(/only http\(s\)/) });
    await expect(service.locate('nonsense', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('turns provider failures and hangs into CAPABILITY_FAILED naming the source', async () => {
    const service = new MediaSourceService({ logger, timeoutMs: 20 });
    service.register(ALBUMS, { search: () => Promise.reject(new Error('API key rejected')), fetch: () => new Promise(() => undefined) });
    await expect(service.search('com.test.photos/albums', {}, ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringMatching(/search com\.test\.photos\/albums failed: API key rejected/) });
    await expect(service.locate('com.test.photos/albums/a', ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringMatching(/took longer/) });
  });

  it('forgets a source\'s results when it goes, and the oldest results past the limit', async () => {
    const service = new MediaSourceService({ logger, remembered: 2 });
    service.register(ALBUMS, provider([{ id: 'a', kind: 'image' }, { id: 'b', kind: 'image' }, { id: 'c', kind: 'image' }]));
    await service.search('com.test.photos/albums', {}, ctx);
    expect(service.describe('com.test.photos/albums/a')).toBeUndefined();
    expect(service.describe('com.test.photos/albums/c')).toBeDefined();
    let changes = 0;
    service.onChange(() => changes++);
    expect(service.unregister('com.test.photos/albums')).toBe(true);
    expect(service.unregister('com.test.photos/albums')).toBe(false);
    expect(changes).toBe(1);
    expect(service.describe('com.test.photos/albums/c')).toBeUndefined();
  });
});

describe('sdk.mediaSources in the engine', () => {
  it('is a module only while there are sources, and its results go to sdk.media', async () => {
    const media = new RecordingHandler('media', { id: 'h1' });
    const wallpaper = new RecordingHandler('wallpaper', null);
    t = await createTestEngine({ respond: () => ({ text: 'ok' }), hostHandlers: [media, wallpaper] });
    await installLunaWith(t.engine, t.packsDir);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context: ActionContext = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: t.engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
    let n = 0;
    const call = (module: string, method: string, args: Json[] = []) => t!.engine.dispatcher.invoke({ callId: `c${++n}`, module, method, args, context });

    expect(t.engine.capabilities.list().some((c) => c.id === 'mediaSources')).toBe(false);
    expect(await call('mediaSources', 'list')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect(() => t!.engine.capabilities.register({ id: 'mediaSources' } as never, new RecordingHandler('mediaSources'))).toThrow(/reserved/);

    t.engine.mediaSources.register(ALBUMS, provider([{ id: 'beach.jpg', kind: 'image', mime: 'image/jpeg' }, { id: 'clip', kind: 'video' }]));
    expect(t.engine.capabilities.list().find((c) => c.id === 'mediaSources')?.methods.map((m) => m.name)).toEqual(['list', 'search']);
    await t.engine.chat.send(session.id, 'show me the beach');
    const system = t.provider.requests.at(-1)!.system;
    expect(system).toContain('## sdk.mediaSources');
    expect(system).toContain('`com.test.photos/albums` — Albums (image, video): Holiday photos and clips.');

    expect(await call('mediaSources', 'list')).toEqual({ ok: true, value: [{ id: ALBUMS.id, title: 'Albums', description: ALBUMS.description, kinds: ['image', 'video'] }] });
    const found = await call('mediaSources', 'search', [ALBUMS.id, { text: 'beach' }]);
    expect(found.ok).toBe(true);
    const [pic, clip] = (found as { value: Json[] }).value as Array<{ path: string; kind: string }>;

    // A remote AssetRef (or its "remote:" string) reaches the media handler as "remote:<path>".
    expect(await call('media', 'showImage', [pic as unknown as Json])).toMatchObject({ ok: true });
    expect(await call('media', 'playVideo', [`remote:${clip!.path}`])).toMatchObject({ ok: true });
    expect(media.calls.map((c) => c.args[0])).toEqual(['remote:com.test.photos/albums/beach.jpg', 'remote:com.test.photos/albums/clip']);
    // The kind the search reported is what the dispatcher checks.
    expect(await call('media', 'playVideo', [`remote:${pic!.path}`])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringMatching(/needs a video asset/) } });
    // Not every call takes a remote item.
    expect(await call('wallpaper', 'set', [pic as unknown as Json])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringMatching(/remote media source/) } });
    // A string no search returned has no kind to go by; a whole ref still does.
    expect(await call('media', 'showImage', ['remote:com.test.photos/albums/never-seen'])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: expect.stringMatching(/search the source again/) } });
    expect(await call('media', 'showImage', [{ source: 'remote', path: 'com.test.photos/albums/never-seen', kind: 'image' }])).toMatchObject({ ok: true });

    // Once the source goes, so does the module, and its items are refused.
    t.engine.mediaSources.unregister(ALBUMS.id);
    expect(t.engine.capabilities.list().some((c) => c.id === 'mediaSources')).toBe(false);
    expect(await call('media', 'showImage', [pic as unknown as Json])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: expect.stringMatching(/not available any more/) } });
  });
});
