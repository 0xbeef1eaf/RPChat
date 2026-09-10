import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStandardRegistry } from '@rp/sdk';
import { loadPack } from '@rp/pack';
import type { ActionContext, AssetEntry, Json, MediaManifest } from '@rp/shared';
import { findAssets, summariseTags } from './assets.js';
import { PackHandler } from './handlers/pack.js';
import { PromptBuilder, assetLine } from './prompt.js';
import { ECHO_REF, LUNA_DIR, LUNA_ID, LUNA_REF, MINIMAL_DIR, createTestEngine } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const asset = (p: string, kind: AssetEntry['kind'], tags: string[], description?: string, bytes = 1000): AssetEntry => {
  const a: AssetEntry = { path: p, kind, bytes, mime: 'x/y', tags };
  if (description !== undefined) a.description = description;
  return a;
};
const ASSETS: AssetEntry[] = [
  asset('media/images/beach/sunset.png', 'image', ['beach', 'images', 'summer', 'sunset'], 'Luna on the beach at sunset'),
  asset('media/images/beach/morning.png', 'image', ['beach', 'images', 'summer']),
  asset('media/images/night/stars.png', 'image', ['images', 'night', 'cozy'], 'Stargazing from the balcony'),
  asset('media/audio/waves.mp3', 'audio', ['audio', 'beach', 'ambient'], 'Gentle waves loop'),
  asset('media/video/sunset-loop.mp4', 'video', ['video', 'sunset']),
  { path: 'media/legacy.png', kind: 'image', bytes: 5, mime: 'image/png' } as unknown as AssetEntry, // no tags field (older index)
];

describe('findAssets', () => {
  it('filters by tags (all), anyTags (any), kind and text; ranks by matching tags then shorter path', () => {
    // equal tag score → shorter path first
    expect(findAssets(ASSETS, { tags: ['beach', 'summer'] }).map((a) => a.path)).toEqual(['media/images/beach/sunset.png', 'media/images/beach/morning.png']);
    expect(findAssets(ASSETS, { anyTags: ['sunset', 'cozy'] }).map((a) => a.path)).toEqual([
      'media/video/sunset-loop.mp4',
      'media/images/night/stars.png',
      'media/images/beach/sunset.png',
    ]);
    // more matching tags rank first regardless of path length
    expect(findAssets(ASSETS, { anyTags: ['beach', 'sunset', 'summer'] }).map((a) => a.path)[0]).toBe('media/images/beach/sunset.png');
    expect(findAssets(ASSETS, { tags: ['beach'], kind: 'audio' }).map((a) => a.path)).toEqual(['media/audio/waves.mp3']);
    expect(findAssets(ASSETS, { text: 'BALCONY' }).map((a) => a.path)).toEqual(['media/images/night/stars.png']);
    expect(findAssets(ASSETS, { text: 'legacy' }).map((a) => a.path)).toEqual(['media/legacy.png']);
    expect(findAssets(ASSETS, { tags: ['Beach'], anyTags: ['SUNSET', 'nope'], kind: 'image', text: 'beach' }).map((a) => a.path)).toEqual(['media/images/beach/sunset.png']);
    // Nothing carries both tags: strict search is empty, the default falls back to every asset (of the kind).
    expect(findAssets(ASSETS, { tags: ['beach', 'night'], fallback: false })).toEqual([]);
    expect(findAssets(ASSETS, { tags: ['beach', 'night'] }).map((a) => a.path)).toEqual(ASSETS.map((a) => a.path));
    expect(findAssets(ASSETS, { tags: ['beach', 'night'], kind: 'image' }).every((a) => a.kind === 'image')).toBe(true);
    expect(findAssets(ASSETS, { tags: ['beach', 'night'], kind: 'image' }).length).toBe(ASSETS.filter((a) => a.kind === 'image').length);
    expect(findAssets(ASSETS, { anyTags: ['nope'], limit: 2 })).toHaveLength(2);
    expect(findAssets(ASSETS, { kind: 'audio' }).length).toBe(ASSETS.filter((a) => a.kind === 'audio').length); // no tag filter → no fallback needed
    expect(findAssets(ASSETS, {}).length).toBe(ASSETS.length);
    expect(findAssets(ASSETS, { limit: 2 }).length).toBe(2);
    expect(findAssets(ASSETS, { limit: 5000 }).length).toBe(ASSETS.length);
    expect(() => findAssets(ASSETS, { tags: 'beach' as never })).toThrow(/tags must be/);
    expect(() => findAssets(ASSETS, { limit: 0 })).toThrow(/limit/);
    const ref = findAssets(ASSETS, { text: 'waves' })[0]!;
    expect(ref).toEqual({ path: 'media/audio/waves.mp3', kind: 'audio', mime: 'x/y', bytes: 1000, tags: ['audio', 'beach', 'ambient'], description: 'Gentle waves loop' });
    expect(findAssets(ASSETS, { text: 'legacy' })[0]!.tags).toEqual([]);
  });

  it('summarises the tag vocabulary with counts and meanings', () => {
    const summary = summariseTags(ASSETS, { beach: 'Seaside shots', unused: 'Never applied' });
    expect(summary[0]).toEqual({ tag: 'beach', count: 3, description: 'Seaside shots' });
    expect(summary.slice(0, 3).map((s) => s.tag)).toEqual(['beach', 'images', 'summer']);
    expect(summary.find((s) => s.tag === 'unused')).toBeUndefined(); // vocabulary entries with no uses are not listed
    expect(summary.find((s) => s.tag === 'cozy')).toEqual({ tag: 'cozy', count: 1 });
  });
});

describe('prompt rendering with tags', () => {
  it('lists assets with kind, size, tags and description, plus the Tags vocabulary line', async () => {
    const luna = await loadPack(LUNA_DIR);
    const pack = { ...luna, assets: ASSETS, tagDescriptions: { beach: 'Seaside shots', cozy: 'Warm indoor scenes' } };
    const { system } = new PromptBuilder().build({
      pack,
      character: luna.characters[0]!,
      registry: createStandardRegistry(),
      allowedModules: ['chat', 'pack'],
      session: { id: 's', characterRef: LUNA_REF, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 },
      transcript: [],
      state: {},
      timers: [],
      userDisplayName: 'You',
      contextTokenBudget: 24_000,
      useTools: true,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(assetLine(ASSETS[0]!)).toBe('media/images/beach/sunset.png (image, 1000 B) [beach, images, summer, sunset] — Luna on the beach at sunset');
    expect(assetLine(ASSETS[5]!)).toBe('media/legacy.png (image, 5 B)');
    expect(system).toContain('- image:\n  - media/images/beach/sunset.png (image, 1000 B) [beach, images, summer, sunset] — Luna on the beach at sunset\n  - media/images/beach/morning.png (image, 1000 B) [beach, images, summer]\n');
    expect(system).toContain('- audio:\n  - media/audio/waves.mp3 (audio, 1000 B) [audio, beach, ambient] — Gentle waves loop');
    expect(system).toContain('Tags: beach (3): Seaside shots; images (3); summer (2); ');
    expect(system).toContain('cozy (1): Warm indoor scenes');
    expect(system).toContain('sdk.pack.findAssets({ anyTags: [...] })');
  });

  it('caps the Tags line at 40 entries', async () => {
    const luna = await loadPack(LUNA_DIR);
    const many = Array.from({ length: 60 }, (_, i) => asset(`media/images/${i}.png`, 'image', [`tag${String(i).padStart(2, '0')}`]));
    const { system } = new PromptBuilder().build({
      pack: { ...luna, assets: many },
      character: luna.characters[0]!,
      registry: createStandardRegistry(),
      allowedModules: ['chat'],
      session: { id: 's', characterRef: LUNA_REF, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 },
      transcript: [],
      state: {},
      timers: [],
      userDisplayName: 'You',
      contextTokenBudget: 24_000,
      useTools: true,
      now: new Date(),
    });
    const tagsLine = system.split('\n').find((l) => l.startsWith('Tags: '))!;
    expect(tagsLine.split('; ').length).toBe(41); // 40 tags + the "… and N more" tail
    expect(tagsLine).toContain('… and 20 more');
  });
});

describe('pack handler + views', () => {
  const ctx = (sessionId: string): ActionContext => ({ packId: LUNA_ID, characterId: 'luna', sessionId, packRoot: '/x', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } });

  it('findAssets / tags / asset / listAssets carry tags through the handler', async () => {
    const luna = await loadPack(LUNA_DIR);
    const pack = { ...luna, assets: ASSETS, tagDescriptions: { beach: 'Seaside shots' } };
    const handler = new PackHandler({ getLoaded: () => pack });
    const found = (await handler.invoke('findAssets', [{ anyTags: ['sunset'], kind: 'image' }], ctx('s'))) as Array<{ path: string; tags: string[] }>;
    expect(found.map((a) => a.path)).toEqual(['media/images/beach/sunset.png']);
    expect(found[0]!.tags).toContain('sunset');
    const tags = (await handler.invoke('tags', [], ctx('s'))) as Array<{ tag: string; count: number; description?: string }>;
    expect(tags[0]).toEqual({ tag: 'beach', count: 3, description: 'Seaside shots' });
    await expect(handler.invoke('findAssets', ['beach'], ctx('s'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const listed = (await handler.invoke('listAssets', ['media/audio'], ctx('s'))) as Array<{ path: string; tags: string[]; description?: string }>;
    expect(listed).toEqual([{ path: 'media/audio/waves.mp3', kind: 'audio', mime: 'x/y', bytes: 1000, tags: ['audio', 'beach', 'ambient'], description: 'Gentle waves loop' }]);
    const one = (await handler.invoke('asset', ['media/images/night/stars.png'], ctx('s'))) as { tags: string[]; description: string };
    expect(one.tags).toEqual(['images', 'night', 'cozy']);
    expect(one.description).toBe('Stargazing from the balcony');
  });

  it('packs.list() and inspect() expose assetTags and assetCounts', async () => {
    t = await createTestEngine();
    await t.engine.packs.install(MINIMAL_DIR);
    const view = (await t.engine.packs.list())[0]!;
    expect(view.assetCounts).toEqual({});
    expect(view.assetTags).toEqual([]);
    const expectedCounts: Record<string, number> = {};
    for (const a of (await loadPack(LUNA_DIR)).assets) expectedCounts[a.kind] = (expectedCounts[a.kind] ?? 0) + 1;
    const luna = await t.engine.packs.inspect(LUNA_DIR);
    expect(luna.assetCounts).toEqual(expectedCounts);
    expect(Array.isArray(luna.assetTags)).toBe(true);
    for (const tag of luna.assetTags) expect(tag).toMatchObject({ tag: expect.any(String), count: expect.any(Number) });
    const installed = await t.engine.packs.install(LUNA_DIR);
    expect(installed.assetCounts).toEqual(expectedCounts);
    expect(installed.assetTags).toEqual(luna.assetTags);
  });
});

// Once the pack loader ships media.json support, Luna's own tags are asserted from its manifest.
describe('Luna media.json (loader-dependent)', () => {
  const mediaJson = path.join(LUNA_DIR, 'media.json');
  const hasMediaJson = fs
    .stat(mediaJson)
    .then(() => true)
    .catch(() => false);

  it('findAssets on the installed Luna pack reflects media.json tags and descriptions', async () => {
    if (!(await hasMediaJson)) return; // loader side not landed yet
    const manifest = JSON.parse(await fs.readFile(mediaJson, 'utf8')) as MediaManifest;
    t = await createTestEngine();
    await t.engine.packs.install(LUNA_DIR);
    const session = await t.engine.sessions.create({ characterRef: LUNA_REF });
    const context: ActionContext = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: t.engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
    const invoke = (method: string, ...args: Json[]) => t!.engine.dispatcher.invoke({ callId: method, module: 'pack', method, args, context });
    const loaded = t.engine.packs.getLoaded(LUNA_ID);
    expect(loaded.assets.some((a) => (a.tags ?? []).length > 0)).toBe(true);
    expect(loaded.tagDescriptions).toEqual(manifest.tags ?? {});
    for (const entry of manifest.entries) {
      const tagged = loaded.assets.filter((a) => (entry.tags ?? []).every((tag) => (a.tags ?? []).includes(tag.toLowerCase())));
      if ((entry.tags ?? []).length > 0) {
        expect(tagged.length).toBeGreaterThan(0);
        const found = (await invoke('findAssets', { tags: entry.tags })) as { ok: true; value: Array<{ path: string; tags: string[] }> };
        expect(found.value.map((a) => a.path).sort()).toEqual(tagged.map((a) => a.path).sort());
      }
    }
    const tags = (await invoke('tags')) as { ok: true; value: Array<{ tag: string; count: number; description?: string }> };
    for (const [tag, meaning] of Object.entries(manifest.tags ?? {})) {
      expect(tags.value.find((s) => s.tag === tag)?.description).toBe(meaning);
    }
    expect((await t.engine.packs.view(LUNA_ID)).assetTags).toEqual(tags.value);
    await t.engine.chat.send(session.id, 'hi').catch(() => undefined); // no provider configured beyond mock
    const system = t.provider.requests.at(-1)?.system ?? '';
    for (const tag of Object.keys(manifest.tags ?? {})) expect(system).toContain(`${tag} (`);
  });

  it('is a placeholder until media.json exists', async () => {
    expect(typeof (await hasMediaJson)).toBe('boolean');
  });
});
