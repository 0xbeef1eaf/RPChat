import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistry, editorAssetHost, isProjectKey, keyFromAssetHost, projectKey } from './registry.js';
import type { TagMediaOptions } from '@rp/shared';
import { EditorService, MAX_TAG_BATCH, extensionsFor, mediaFilters, normalizeSubfolder, voicePickFilters, voicePickTitle } from './service.js';
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

describe('EditorService library (lib/**/*.ts)', () => {
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

  it('creates, lists, renames, reports and deletes library files', async () => {
    const s = svc();
    const project = await s.create({ packId: 'com.test.scripts', name: 'Scripts', characterId: 'mia', characterName: 'Mia' });
    const key = project.summary.key;
    const dir = project.summary.dir;
    const libDir = path.join(dir, 'characters', 'mia', 'lib');
    const mia = project.characters[0]!;
    expect(mia.library).toEqual({ files: [], functions: [], problems: [] });
    expect(fs.existsSync(path.join(libDir, 'README.md'))).toBe(true);
    expect(s.libraryFileTemplate()).toMatch(/^\/\*\* .*\*\/\nexport async function cheer\(mood: string\) \{/);

    // add: the file is written as given, and what it exports is listed with its JSDoc summary
    const cheer = '/** show a picture for a mood */\nexport async function cheer(mood: string) {\n  return mood;\n}\n';
    let p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'cheer.ts', source: cheer });
    expect(p.characters[0]!.library.files).toEqual([{ path: 'cheer.ts', file: 'characters/mia/lib/cheer.ts', source: cheer, bytes: Buffer.byteLength(cheer) }]);
    expect(p.characters[0]!.library.functions).toEqual([{ name: 'cheer', file: 'characters/mia/lib/cheer.ts', params: 'mood: string', description: 'show a picture for a mood' }]);
    expect(p.characters[0]!.library.problems).toEqual([]);
    expect(fs.readFileSync(path.join(libDir, 'cheer.ts'), 'utf8')).toBe(cheer);
    expect(p.validation.ok).toBe(true);

    // a file in a sub-folder that imports a private helper from another; `@internal` hides an export
    const dice = 'export function roll(sides: number) { return 1 + Math.floor(Math.random() * sides); }\n';
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'games/dice.ts', source: dice });
    const simon = "import { roll } from './dice';\n\n/**\n * pick a colour\n * @internal\n */\nexport const pick = () => ['red', 'blue'][roll(2) - 1];\n";
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'games/simon.ts', source: simon });
    expect(p.characters[0]!.library.files.map((f) => f.path)).toEqual(['cheer.ts', 'games/dice.ts', 'games/simon.ts']);
    expect(p.characters[0]!.library.functions.map((f) => [f.name, f.description, f.internal])).toEqual([
      ['cheer', 'show a picture for a mood', undefined],
      ['pick', 'pick a colour', true],
      ['roll', undefined, undefined],
    ]);
    expect(p.characters[0]!.library.problems).toEqual([]);

    // rename: the old file goes once the new one is written; renaming onto another file is refused
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'games/simonSays.ts', source: simon, previousPath: 'games/simon.ts' });
    expect(p.characters[0]!.library.files.map((f) => f.path)).toEqual(['cheer.ts', 'games/dice.ts', 'games/simonSays.ts']);
    expect(fs.readdirSync(path.join(libDir, 'games')).sort()).toEqual(['dice.ts', 'simonSays.ts']);
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: 'cheer.ts', source: dice, previousPath: 'games/dice.ts' })).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(libDir, 'cheer.ts'), 'utf8')).toBe(cheer);
    // saving under its own path (previousPath unchanged) just rewrites it
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'cheer.ts', source: cheer, previousPath: 'cheer.ts' });
    expect(p.characters[0]!.library.files).toHaveLength(3);

    // a broken file is saved (the author is mid-edit) and reported against its line, as the loader reports it
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'half.ts', source: 'export const half = async ( => 1;\n' });
    const lib = p.characters[0]!.library;
    expect(lib.files.find((f) => f.path === 'half.ts')!.source).toBe('export const half = async ( => 1;\n');
    expect(lib.functions).toEqual([]);
    expect(lib.problems).toEqual([expect.objectContaining({ file: 'characters/mia/lib/half.ts', line: 1, column: expect.any(Number) })]);
    expect(p.validation.ok).toBe(true);
    expect(p.validation.warnings).toEqual([expect.stringMatching(/^warning: characters\/mia\/lib\/half\.ts:1:\d+: /)]);
    // `export default` has no name: the rest of the library still builds
    p = await s.saveLibraryFile(key, { dir: mia.dir, path: 'half.ts', source: 'export default () => 1;\n', previousPath: 'half.ts' });
    expect(p.characters[0]!.library.functions.map((f) => f.name)).toEqual(['cheer', 'pick', 'roll']);
    expect(p.characters[0]!.library.problems).toEqual([expect.objectContaining({ file: 'characters/mia/lib/half.ts', message: expect.stringMatching(/export default/) })]);

    // rejections
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: 'notes.md', source: 'x' })).rejects.toThrow(/\.ts/);
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: 'types.d.ts', source: 'x' })).rejects.toThrow(/\.d\.ts/);
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: '../escape.ts', source: 'x' })).rejects.toThrow(/Invalid library file/);
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: '.hidden.ts', source: 'x' })).rejects.toThrow(/start with "\."/);
    await expect(s.saveLibraryFile(key, { dir: mia.dir, path: 'empty.ts', source: '   ' })).rejects.toThrow(/source is required/);
    await expect(s.saveLibraryFile(key, { dir: '../mia', path: 'x.ts', source: 'export const x = 1;' })).rejects.toThrow(/Unsafe/);

    // delete
    p = await s.removeLibraryFile(key, mia.dir, 'half.ts');
    expect(p.characters[0]!.library.files.map((f) => f.path)).toEqual(['cheer.ts', 'games/dice.ts', 'games/simonSays.ts']);
    expect(p.characters[0]!.library.problems).toEqual([]);
    await expect(s.removeLibraryFile(key, mia.dir, 'half.ts')).rejects.toThrow(/No library file/);
    await expect(s.removeLibraryFile(key, mia.dir, '../persona.md')).rejects.toThrow(/Invalid library file/);
    // the read path (tolerant or not) carries the same library
    expect((await s.read(key)).characters[0]!.library.functions.map((f) => f.name)).toEqual(['cheer', 'pick', 'roll']);
  }, 30_000);

  it('checkScript with kind "module" parses one library file as an ES module, with a position when esbuild gives one', async () => {
    const s = svc();
    expect(await s.checkScript('/** cheer */\nexport async function cheer(mood: string) {\n  return mood;\n}', 'module')).toEqual([]);
    expect(await s.checkScript('  ', 'module')).toEqual([]);
    // imports are not resolved here: only the saved, bundled library knows its siblings
    expect(await s.checkScript("import { roll } from './dice';\nexport const two = () => roll(2);", 'module')).toEqual([]);
    const [broken] = await s.checkScript('export async function f(a: string) {\n  return a +;\n}', 'module');
    expect(broken?.message).toMatch(/Unexpected/);
    expect(broken).toMatchObject({ line: 2, column: expect.any(Number) });
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

  it('drops a .qvoice profile from the batch, and refuses one on its own', async () => {
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
    const project = await svc.create({ packId: 'com.test.qvoice', name: 'Qvoice', characterId: 'mia', characterName: 'Mia' });
    const key = project.summary.key;
    const dir = project.summary.dir;
    fs.mkdirSync(path.join(dir, 'media', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media', 'images', 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'media', 'mia.qvoice'), Buffer.from('QVCE'));

    // "Auto-tag…" over a whole list still tags the list; the profile is simply not in it.
    const out = await svc.suggestMediaTags(key, ['media/images/card.png', 'media/mia.qvoice']);
    expect(out.map((s) => s.path)).toEqual(['media/images/card.png']);
    expect(tagger.calls.at(-1)!.assets.map((a) => a.path)).toEqual(['media/images/card.png']);

    await expect(svc.suggestMediaTags(key, ['media/mia.qvoice'])).rejects.toThrow(/nothing to tag/);
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

describe('voice reference picker', () => {
  const exts = (engine?: string) => voicePickFilters(engine).flatMap((f) => f.extensions);

  it('offers profiles, and only profiles, for Qwen', () => {
    // A wav is useless to this engine: it speaks from a .qvoice built by a separate model, so
    // offering one would let an author pick a file that is then silently ignored.
    expect(exts('qwen')).toEqual(['qvoice']);
    expect(voicePickTitle('qwen')).toBe('Choose a voice profile');
  });

  it('offers recordings, and only recordings, for the sherpa engines', () => {
    for (const engine of ['pocket', 'kokoro', 'kitten', 'vits']) {
      expect(exts(engine)).toEqual(['wav']);
      expect(voicePickTitle(engine)).toBe('Choose a voice recording');
    }
  });

  it('offers both when no model has been chosen yet', () => {
    expect(exts(undefined)).toContain('wav');
    expect(exts(undefined)).toContain('qvoice');
    // The combined entry comes first, so the dialog opens showing everything usable.
    expect(voicePickFilters(undefined)[0]?.extensions).toEqual(['wav', 'qvoice']);
  });
});
