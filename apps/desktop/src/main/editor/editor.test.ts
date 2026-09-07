import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistry, editorAssetHost, isProjectKey, keyFromAssetHost, projectKey } from './registry.js';
import { EditorService } from './service.js';
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
    expect(p.manifest.capabilities).toEqual(['media']);
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
