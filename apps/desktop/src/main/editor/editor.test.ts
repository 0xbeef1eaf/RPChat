import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistry, editorAssetHost, isProjectKey, keyFromAssetHost, projectKey } from './registry.js';
import type { TagMediaOptions } from '@rp/shared';
import { EditorService, MAX_TAG_BATCH, extensionsFor, mediaFilters, normalizeSubfolder } from './service.js';
import type { MediaTagger, TagAsset, TagPackContext } from './tagger.js';
import { parseAssetUrl } from '../asset-protocol.js';

describe('project registry', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('derives stable 12-hex keys from the resolved directory', () => {
    const a = projectKey('/tmp/packs/luna');
    expect(a).toMatch(/^[a-f0-9]{12}$/);
    expect(projectKey('/tmp/packs/../packs/luna/')).toBe(a);
    expect(projectKey('/tmp/packs/other')).not.toBe(a);
    expect(isProjectKey(a)).toBe(true);
    expect(isProjectKey('short')).toBe(false);
    expect(editorAssetHost(a)).toBe(`editor-${a}`);
    expect(keyFromAssetHost(`editor-${a}`)).toBe(a);
    expect(keyFromAssetHost('com.example.luna')).toBeUndefined();
    expect(keyFromAssetHost('editor-nope')).toBeUndefined();
  });

  it('persists entries across instances and removes them', () => {
    const file = path.join(tmp, 'data', 'editor-projects.json');
    const reg = new ProjectRegistry(file);
    const entry = reg.add(path.join(tmp, 'p1'));
    expect(reg.add(path.join(tmp, 'p1'))).toEqual(entry); // idempotent
    reg.add(path.join(tmp, 'p2'));
    expect(reg.list()).toHaveLength(2);
    const again = new ProjectRegistry(file);
    expect(again.list().map((e) => e.key)).toEqual(reg.list().map((e) => e.key));
    expect(again.get(entry.key)?.dir).toBe(path.join(tmp, 'p1'));
    expect(again.byDir(path.join(tmp, 'p2'))).toBeDefined();
    expect(again.remove(entry.key)).toBe(true);
    expect(again.remove(entry.key)).toBe(false);
    expect(new ProjectRegistry(file).list()).toHaveLength(1);
    fs.writeFileSync(file, 'garbage');
    expect(new ProjectRegistry(file).list()).toEqual([]);
  });
});

describe('asset URL mapping', () => {
  it('parses editor hosts like pack ids', () => {
    const key = projectKey('/x');
    expect(parseAssetUrl(`rp-asset://editor-${key}/media/images/a.png`)).toEqual({ packId: `editor-${key}`, relativePath: 'media/images/a.png' });
    expect(parseAssetUrl('rp-asset://editor-zz/x.png')).toBeUndefined();
  });
});

describe('EditorService tolerant read', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-svc-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function service(): EditorService {
    return new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => ['com.test.broken'] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
    });
  }

  it('returns what parses from a broken pack plus validation problems', async () => {
    const dir = path.join(tmp, 'broken');
    fs.mkdirSync(path.join(dir, 'characters', 'mia', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'media', 'images', 'happy'), { recursive: true });
    // Invalid: version is not semver, a listed character dir is missing, media.json has a bad entry.
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ formatVersion: 1, id: 'com.test.broken', name: 'Broken', version: 'one', characters: ['characters/mia', 'characters/missing'], capabilities: ['media'] }));
    fs.writeFileSync(path.join(dir, 'characters', 'mia', 'character.json'), JSON.stringify({ id: 'mia', name: 'Mia', persona: 'persona.md', avatar: 'avatar.png', behaviours: { onTimer: 'scripts/on-timer.ts' } }));
    fs.writeFileSync(path.join(dir, 'characters', 'mia', 'persona.md'), '# Mia');
    fs.writeFileSync(path.join(dir, 'characters', 'mia', 'scripts', 'on-timer.ts'), 'return 1;');
    fs.writeFileSync(path.join(dir, 'characters', 'mia', 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'media', 'images', 'happy', 'smile.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify({ entries: [{ match: 'media/images/**', tags: ['portrait'] }], tags: { portrait: 'a face', unused: 'never' } }));
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello');
    const svc = service();
    const project = await svc.open(dir);
    expect(project).not.toBeNull();
    const p = project!;
    expect(p.validation.ok).toBe(false);
    expect(p.validation.problems.length).toBeGreaterThan(0);
    expect(p.summary).toMatchObject({ packId: 'com.test.broken', name: 'Broken', version: 'one', characterCount: 2, installed: true, dir });
    expect('capabilities' in p.manifest).toBe(false); // the legacy key is dropped: permissions are app-wide
    expect(p.characters).toHaveLength(1);
    expect(p.characters[0]).toMatchObject({ dir: 'characters/mia', personaText: '# Mia', behaviours: { onTimer: 'return 1;' }, avatarUrl: `rp-asset://editor-${p.summary.key}/characters/mia/avatar.png` });
    const smile = p.assets.find((a) => a.path === 'media/images/happy/smile.png');
    expect(smile).toMatchObject({ kind: 'image', folderTags: ['happy'], manifestTags: ['portrait'], url: `rp-asset://editor-${p.summary.key}/media/images/happy/smile.png` });
    expect(p.tags.map((t) => t.tag)).toEqual(expect.arrayContaining(['happy', 'portrait']));
    expect(p.mediaManifest.tags?.portrait).toBe('a face');
    expect(p.readme).toBe('hello');
    expect((await svc.listProjects())[0]).toMatchObject({ packId: 'com.test.broken', installed: true });
    // A totally unreadable manifest still yields a project keyed to the folder.
    const dir2 = path.join(tmp, 'garbage');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'pack.json'), '{not json');
    const p2 = (await svc.open(dir2))!;
    expect(p2.summary.name).toBe('garbage');
    expect(p2.validation.ok).toBe(false);
    expect(p2.characters).toEqual([]);
    await svc.forget(p2.summary.key);
    await expect(svc.read(p2.summary.key)).rejects.toThrow(/No open project/);
  });
});

describe('EditorService media options', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-media-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('builds picker filters from the kind table and validates sub-folders', () => {
    expect(extensionsFor('image')).toEqual(expect.arrayContaining(['png', 'jpg', 'webp']));
    expect(extensionsFor('audio')).not.toContain('png');
    expect(mediaFilters(['image'])).toEqual([{ name: 'Images', extensions: extensionsFor('image') }]);
    expect(mediaFilters(['image', 'audio'])[0]?.name).toBe('Media');
    expect(mediaFilters(undefined)[0]?.extensions).toEqual(expect.arrayContaining(['png', 'mp4', 'mp3', 'txt']));
    expect(normalizeSubfolder(undefined)).toBeUndefined();
    expect(normalizeSubfolder(' wallpapers/night ')).toBe('wallpapers/night');
    expect(() => normalizeSubfolder('../x')).toThrow(/Invalid subfolder/);
    expect(() => normalizeSubfolder('a b')).toThrow(/Invalid subfolder/);
  });

  it('adds files into media/<kind>/<subfolder> and honours kind restrictions', async () => {
    const svc = new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => [] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
    });
    const project = await svc.create({ packId: 'com.test.media', name: 'Media', characterId: 'mia', characterName: 'Mia' });
    const png = path.join(tmp, 'night sky.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const wav = path.join(tmp, 'chime.wav');
    fs.writeFileSync(wav, Buffer.from('RIFF'));
    const key = project.summary.key;
    const dir = project.summary.dir;
    expect(dir).toBe(path.join(tmp, 'workspace', 'com.test.media'));
    const after = await svc.addMediaFiles(key, [png], { subfolder: 'wallpapers' });
    const added = after.assets.find((a) => a.path.startsWith('media/images/wallpapers/'));
    expect(added).toBeDefined();
    expect(added?.kind).toBe('image');
    expect(added?.folderTags).toContain('wallpapers');
    expect(fs.existsSync(path.join(dir, ...added!.path.split('/')))).toBe(true);
    const again = await svc.addMediaFiles(key, [png], { subfolder: 'wallpapers' });
    expect(again.assets.filter((a) => a.path.startsWith('media/images/wallpapers/'))).toHaveLength(2);
    await expect(svc.addMediaFiles(key, [wav], { kinds: ['image'] })).rejects.toThrow(/not one of: image/);
    const plain = await svc.addMediaFiles(key, [wav]);
    expect(plain.assets.some((a) => a.path === 'media/audio/chime.wav')).toBe(true);
  });
});

describe('EditorService scripts (lib/<name>.ts)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-scripts-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function svc(): EditorService {
    return new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => [] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
    });
  }

  it('creates, lists, renames, reports and deletes function files', async () => {
    const s = svc();
    const project = await s.create({ packId: 'com.test.scripts', name: 'Scripts', characterId: 'mia', characterName: 'Mia' });
    const key = project.summary.key;
    const dir = project.summary.dir;
    const mia = project.characters[0]!;
    expect(mia.library).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'characters', 'mia', 'lib', 'README.md'))).toBe(true);
    expect(s.scriptTemplate()).toMatch(/^\/\/ .*\nasync \(mood: string\) => \{/);

    // add
    let p = await s.saveScript(key, { dir: mia.dir, name: 'cheer', source: 'async (mood: string) => {\n  return mood;\n}\n', description: ' show a picture for a mood ' });
    expect(p.characters[0]!.library).toEqual([{ name: 'cheer', description: 'show a picture for a mood', source: 'async (mood: string) => {\n  return mood;\n}', bytes: expect.any(Number), file: 'characters/mia/lib/cheer.ts' }]);
    expect(fs.readFileSync(path.join(dir, 'characters', 'mia', 'lib', 'cheer.ts'), 'utf8')).toBe('// show a picture for a mood\nasync (mood: string) => {\n  return mood;\n}\n');
    expect(p.validation.ok).toBe(true);
    // a second one without a description; sorted by name
    p = await s.saveScript(key, { dir: mia.dir, name: 'tick', source: '() => 1' });
    expect(p.characters[0]!.library.map((f) => [f.name, f.description])).toEqual([['cheer', 'show a picture for a mood'], ['tick', undefined]]);
    // rename: the old file goes once the new one is written
    p = await s.saveScript(key, { dir: mia.dir, name: 'tock', source: '() => 2', previousName: 'tick' });
    expect(p.characters[0]!.library.map((f) => f.name)).toEqual(['cheer', 'tock']);
    expect(fs.readdirSync(path.join(dir, 'characters', 'mia', 'lib')).sort()).toEqual(['README.md', 'cheer.ts', 'tock.ts']);
    // a broken function is saved (the author is mid-edit) but reported the way the loader reports it
    p = await s.saveScript(key, { dir: mia.dir, name: 'half', source: 'async ( => 1' });
    const half = p.characters[0]!.library.find((f) => f.name === 'half')!;
    expect(half.problem).toMatch(/^not a single function expression: fn does not parse/);
    expect(half.source).toBe('async ( => 1');
    expect(p.validation.ok).toBe(true);
    expect(p.validation.warnings).toEqual([expect.stringMatching(/^warning: characters\/mia\/lib\/half\.ts: not a single function expression/)]);
    // rejections
    await expect(s.saveScript(key, { dir: mia.dir, name: 'a-b', source: '() => 1' })).rejects.toThrow(/identifier/);
    await expect(s.saveScript(key, { dir: mia.dir, name: 'class', source: '() => 1' })).rejects.toThrow(/reserved/);
    await expect(s.saveScript(key, { dir: mia.dir, name: 'cheer', source: '() => 1', previousName: 'tock' })).rejects.toThrow(/already exists/);
    await expect(s.saveScript(key, { dir: mia.dir, name: 'empty', source: '   ' })).rejects.toThrow(/source is required/);
    await expect(s.saveScript(key, { dir: '../mia', name: 'x', source: '() => 1' })).rejects.toThrow(/Unsafe/);
    // delete
    p = await s.removeScript(key, mia.dir, 'half');
    expect(p.characters[0]!.library.map((f) => f.name)).toEqual(['cheer', 'tock']);
    await expect(s.removeScript(key, mia.dir, 'half')).rejects.toThrow(/No function file/);
    // the read path (tolerant or not) carries the same list
    expect((await s.read(key)).characters[0]!.library.map((f) => f.name)).toEqual(['cheer', 'tock']);
  });

  it('checkScript with kind "function" applies the loader check, with a position when esbuild gives one', async () => {
    const s = svc();
    expect(await s.checkScript('async (mood: string) => mood', 'function')).toEqual([]);
    expect(await s.checkScript('  ', 'function')).toEqual([]);
    const [call] = await s.checkScript('sdk.chat.emote("hi")', 'function');
    expect(call?.message).toMatch(/function expression/);
    expect(call?.line).toBeUndefined();
    const [broken] = await s.checkScript('async (a: string) => {\n  return a +;\n}', 'function');
    expect(broken?.message).toMatch(/does not parse/);
    expect(broken?.line).toBe(2);
    expect(broken?.lineText).toContain('return a +;');
    // the default kind still compiles a hook body
    expect(await s.checkScript('return 1;')).toEqual([]);
  });
});

describe('EditorService.checkScript', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-check-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function svc(): EditorService {
    return new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => [] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
    });
  }

  it('reports where a script stops compiling, so the editor can say so while it is typed', async () => {
    // `wake(prompt: …)` is missing its braces: one bad line costs the whole script, including the
    // `sdk.events.on` call under it.
    const broken = [
      'const n = 1;',
      'await sdk.llm.wake(prompt: `hello`);',
      'await sdk.events.on("window-changed", async () => {}, {});',
    ].join('\n');
    const [problem] = await svc().checkScript(broken);
    expect(problem?.message).toContain('Expected ")"');
    expect(problem).toMatchObject({ line: 2 });
    expect(problem?.lineText).toContain('sdk.llm.wake');
  });

  it('is quiet for a script that compiles, and for an empty one', async () => {
    const s = svc();
    expect(await s.checkScript('await sdk.events.on("window-changed", async (input) => { console.info(String(input.data)); }, {});')).toEqual([]);
    expect(await s.checkScript('   ')).toEqual([]);
    expect(await s.checkScript(undefined as unknown as string)).toEqual([]);
  });
});

describe('EditorService.suggestMediaTags', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-editor-tags-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Records what the tagger was handed instead of calling a model. */
  function fakeTagger(): { calls: Array<{ pack: TagPackContext; assets: TagAsset[]; options: TagMediaOptions }> } & Pick<MediaTagger, 'suggest'> {
    const calls: Array<{ pack: TagPackContext; assets: TagAsset[]; options: TagMediaOptions }> = [];
    return {
      calls,
      suggest: async (pack, assets, options = {}) => {
        calls.push({ pack, assets, options });
        return assets.map((a) => ({ path: a.path, tags: ['tagged'], newTags: ['tagged'], description: 'a thing', vocabulary: {}, basis: 'image' as const }));
      },
    };
  }

  it('passes the pack context, absolute paths and video frames to the tagger', async () => {
    const tagger = fakeTagger();
    const svc = new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => [] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
      tagger: tagger as unknown as MediaTagger,
    });
    const project = await svc.create({ packId: 'com.test.tags', name: 'Tags', characterId: 'mia', characterName: 'Mia' });
    const key = project.summary.key;
    const dir = project.summary.dir;
    fs.mkdirSync(path.join(dir, 'media', 'images', 'portraits'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media', 'images', 'portraits', 'smile.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await svc.saveMediaManifest(key, { entries: [{ match: 'media/images/portraits/smile.png', tags: ['smile'], description: 'Mia smiling' }], tags: { smile: 'a smile' } });

    const out = await svc.suggestMediaTags(key, ['media/images/portraits/smile.png'], { frames: { 'media/images/portraits/smile.png': 'RlJBTUU=' }, maxTags: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]?.tags).toEqual(['tagged']);
    const call = tagger.calls[0]!;
    expect(call.pack).toMatchObject({ id: 'com.test.tags', name: 'Tags', characters: ['Mia'], vocabulary: { smile: 'a smile' } });
    expect(call.pack.knownTags).toEqual(expect.arrayContaining(['smile', 'portraits']));
    expect(call.assets[0]).toMatchObject({
      path: 'media/images/portraits/smile.png',
      kind: 'image',
      folderTags: ['portraits'],
      tags: ['smile'],
      description: 'Mia smiling',
      frame: 'RlJBTUU=',
      absolutePath: path.join(dir, 'media', 'images', 'portraits', 'smile.png'),
    });
    expect(call.options.maxTags).toBe(3);

    // What earlier assets of the same run coined reaches the model even though media.json,
    // which the editor only writes when the author saves, knows nothing about it yet.
    await svc.suggestMediaTags(key, ['media/images/portraits/smile.png'], {
      learned: { tags: ['cosy', 'smile'], vocabulary: { cosy: 'Warm and relaxed', blank: '' } },
    });
    const carried = tagger.calls[1]!.pack;
    expect(carried.knownTags).toEqual(expect.arrayContaining(['smile', 'cosy']));
    expect(carried.vocabulary).toEqual({ smile: 'a smile', cosy: 'Warm and relaxed' }); // no blank meaning

    await expect(svc.suggestMediaTags(key, [])).rejects.toThrow(/non-empty array/);
    await expect(svc.suggestMediaTags(key, ['media/images/gone.png'])).rejects.toThrow(/not an asset/);
    await expect(svc.suggestMediaTags(key, ['../secrets.png'])).rejects.toThrow(/Unsafe asset path/);
    await expect(svc.suggestMediaTags(key, new Array(MAX_TAG_BATCH + 1).fill('media/images/portraits/smile.png'))).rejects.toThrow(/At most 25 assets/);
  });

  it('says so when the build has no tagger', async () => {
    const svc = new EditorService({
      userData: tmp,
      registry: new ProjectRegistry(path.join(tmp, 'data', 'editor-projects.json')),
      packs: { install: async () => { throw new Error('not in test'); }, tryGetLoaded: () => undefined, installedIds: async () => [] },
      dialogs: { openDirectory: async () => undefined, openFiles: async () => [], saveFile: async () => undefined },
      reveal: () => undefined,
      logger: { warn: () => undefined, debug: () => undefined },
    });
    const project = await svc.create({ packId: 'com.test.notagger', name: 'No tagger', characterId: 'mia', characterName: 'Mia' });
    await expect(svc.suggestMediaTags(project.summary.key, ['media/images/x.png'])).rejects.toThrow(/not available in this build/);
  });
});
