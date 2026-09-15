import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import {
  BEHAVIOUR_HOOKS,
  addAssetFile,
  behaviourScriptPath,
  behaviourTemplates,
  formatLibraryFile,
  hookFileStem,
  libraryFunctionTemplate,
  libraryNameProblem,
  libraryReadme,
  loadPack,
  parseLibraryFile,
  personaTemplate,
  readCharacterLibrary,
  removeAsset,
  removeLibraryFunction,
  scaffoldPack,
  slugify,
  validatePack,
  writeCharacter,
  writeLibraryFunction,
  writeManifest,
  writeMediaManifest,
  writeReadme,
} from './index.js';
import { listFiles, makeTempDir } from './test/helpers.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => fs.rm(t, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const t = await makeTempDir('rp-write-');
  temps.push(t);
  return t;
}
async function scaffolded(): Promise<string> {
  const dir = path.join(await temp(), 'pack');
  await scaffoldPack(dir, { packId: 'com.test.scaffold', name: 'Scaffold', characterId: 'nova', characterName: 'Nova' });
  return dir;
}
async function expectRpError(p: Promise<unknown>, code: string): Promise<RpError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RpError);
  expect((caught as RpError).code).toBe(code);
  return caught as RpError;
}

describe('scaffoldPack', () => {
  it('creates a pack that loads and validates cleanly', async () => {
    const dir = await scaffolded();
    expect(await listFiles(dir)).toEqual([
      'README.md',
      'characters/nova/character.json',
      'characters/nova/lib/README.md',
      'characters/nova/persona.md',
      'media.json',
      'pack.json',
    ]);
    expect(await fs.readFile(path.join(dir, 'characters/nova/lib/README.md'), 'utf8')).toBe(libraryReadme('Nova'));
    expect(libraryReadme('Nova')).toContain('`lib/cheer.ts`');
    for (const sub of ['media/images', 'media/video', 'media/audio', 'characters/nova/scripts']) {
      expect((await fs.stat(path.join(dir, sub))).isDirectory()).toBe(true);
    }
    const pack = await loadPack(dir);
    expect(pack.manifest).toMatchObject({ id: 'com.test.scaffold', name: 'Scaffold', version: '0.1.0' });
    expect('capabilities' in pack.manifest).toBe(false); // never written: permissions are app-wide
    expect(pack.characters[0]!.definition).toMatchObject({ id: 'nova', name: 'Nova', persona: 'persona.md' });
    expect(pack.characters[0]!.personaText).toContain('# Nova');
    expect(pack.characters[0]!.personaText).toContain('## Using your abilities');
    expect(pack.characters[0]!.behaviourSources).toEqual({});
    expect(pack.character.library).toEqual({}); // the README in lib/ is not a function
    expect(pack.readme).toContain('# Scaffold');
    expect(pack.tagDescriptions).toEqual({});
    expect(await validatePack(dir)).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('refuses to scaffold over an existing pack and validates inputs first', async () => {
    const dir = await scaffolded();
    await expectRpError(scaffoldPack(dir, { packId: 'com.x.y', name: 'X', characterId: 'x', characterName: 'X' }), 'PACK_CONFLICT');
    const fresh = path.join(await temp(), 'bad');
    await expectRpError(scaffoldPack(fresh, { packId: 'Bad Id', name: 'X', characterId: 'x', characterName: 'X' }), 'PACK_INVALID');
    await expectRpError(scaffoldPack(fresh, { packId: 'com.x.y', name: 'X', characterId: 'Bad Id', characterName: 'X' }), 'PACK_INVALID');
    await expect(fs.stat(fresh)).rejects.toThrow();
  });
});

describe('writeManifest / writeMediaManifest / writeReadme', () => {
  it('round-trips through loadPack with a stable key order', async () => {
    const dir = await scaffolded();
    const pack = await loadPack(dir);
    await writeManifest(dir, { ...pack.manifest, tags: ['b', 'a'], license: 'MIT', name: 'Renamed' });
    const text = await fs.readFile(path.join(dir, 'pack.json'), 'utf8');
    expect(Object.keys(JSON.parse(text))).toEqual(['formatVersion', 'id', 'name', 'version', 'description', 'license', 'tags', 'characters', 'mediaRoot']);
    expect(text.endsWith('\n')).toBe(true);
    expect((await loadPack(dir)).manifest).toMatchObject({ name: 'Renamed', license: 'MIT', tags: ['b', 'a'] });

    await writeMediaManifest(dir, { entries: [{ match: 'media/images/*.png', tags: ['Pic'] }], tags: { pic: 'a picture' } });
    const media = JSON.parse(await fs.readFile(path.join(dir, 'media.json'), 'utf8'));
    expect(Object.keys(media)).toEqual(['tags', 'entries']);
    expect(media.entries[0].tags).toEqual(['pic']);

    await writeReadme(dir, '# Hello\n');
    expect((await loadPack(dir)).readme).toBe('# Hello\n');
  });

  it('rejects invalid input before touching disk', async () => {
    const dir = await scaffolded();
    const before = await fs.readFile(path.join(dir, 'pack.json'), 'utf8');
    const pack = await loadPack(dir);
    await expectRpError(writeManifest(dir, { ...pack.manifest, version: 'nope' }), 'PACK_INVALID');
    await expectRpError(writeManifest(dir, { ...pack.manifest, characters: ['../x'] }), 'PACK_INVALID');
    expect(await fs.readFile(path.join(dir, 'pack.json'), 'utf8')).toBe(before);
    await expectRpError(writeMediaManifest(dir, { entries: [{ match: '/abs' }] }), 'PACK_INVALID');
    expect(await listFiles(dir, { includeDotfiles: true })).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });
});

describe('writeCharacter', () => {
  it('writes scripts per hook, removes stale hook scripts, keeps files it does not own', async () => {
    const dir = await scaffolded();
    const charDir = 'characters/nova';
    const charAbs = path.join(dir, 'characters', 'nova');
    await fs.writeFile(path.join(charAbs, 'avatar.png'), 'png');
    await fs.mkdir(path.join(charAbs, 'faces'), { recursive: true });
    await fs.writeFile(path.join(charAbs, 'faces', 'neutral.png'), 'png');
    await fs.writeFile(path.join(charAbs, 'scripts', 'helper.ts'), '// mine');

    const definition = (await loadPack(dir)).characters[0]!.definition;
    const def2 = {
      ...definition,
      avatar: 'avatar.png',
      tagline: 'shiny',
      avatarSet: { expressions: { neutral: 'faces/neutral.png' }, defaultExpression: 'neutral' },
      behaviours: { onTimer: 'something/else.ts' }, // ignored: the writer owns the mapping
    };
    await writeCharacter(dir, charDir, def2, '# Nova v2\n', {
      onSessionStart: '// start',
      onTimer: '// timer',
    });
    let pack = await loadPack(dir);
    let nova = pack.characters[0]!;
    expect(nova.definition.behaviours).toEqual({ onSessionStart: 'scripts/on-session-start.ts', onTimer: 'scripts/on-timer.ts' });
    expect(nova.behaviourSources).toEqual({ onSessionStart: '// start', onTimer: '// timer' });
    expect(nova.personaText).toBe('# Nova v2\n');
    expect(nova.avatarPath).toBe('characters/nova/avatar.png');
    expect(nova.definition.avatarSet?.expressions.neutral).toBe('faces/neutral.png');
    expect(pack.assets.map((a) => a.path)).toEqual(['characters/nova/avatar.png', 'characters/nova/faces/neutral.png']);
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(charAbs, 'character.json'), 'utf8')))).toEqual([
      'id', 'name', 'tagline', 'avatar', 'persona', 'greeting', 'behaviours', 'avatarSet',
    ]);

    await writeCharacter(dir, charDir, nova.definition, nova.personaText, { onTimer: '// timer 2' });
    pack = await loadPack(dir);
    nova = pack.characters[0]!;
    expect(nova.definition.behaviours).toEqual({ onTimer: 'scripts/on-timer.ts' });
    expect(nova.behaviourSources).toEqual({ onTimer: '// timer 2' });
    expect(await listFiles(charAbs)).toEqual([
      'avatar.png', 'character.json', 'faces/neutral.png', 'lib/README.md', 'persona.md', 'scripts/helper.ts', 'scripts/on-timer.ts',
    ]);

    await writeCharacter(dir, charDir, nova.definition, nova.personaText, {});
    expect((await loadPack(dir)).characters[0]!.definition.behaviours).toBeUndefined();
    expect(await listFiles(charAbs)).not.toContain('scripts/on-timer.ts');
  });

  it('validates before writing and refuses escaping directories', async () => {
    const dir = await scaffolded();
    const definition = (await loadPack(dir)).characters[0]!.definition;
    const before = await listFiles(dir);
    await expectRpError(writeCharacter(dir, 'characters/nova', { ...definition, id: 'Bad Id' }, 'p', { onTimer: 'x' }), 'PACK_INVALID');
    await expectRpError(writeCharacter(dir, '../outside', definition, 'p', {}), 'PATH_ESCAPE');
    await expectRpError(writeCharacter(dir, 'characters/nova', { ...definition, persona: '../../pack.json' }, 'p', {}), 'PACK_INVALID');
    expect(await listFiles(dir)).toEqual(before);
    expect((await loadPack(dir)).characters[0]!.personaText).toContain('# Nova');
  });
});

describe('addAssetFile / removeAsset', () => {
  it('copies into the kind folder, de-duplicates names and returns a tagged entry', async () => {
    const dir = await scaffolded();
    const src = path.join(await temp(), 'My Photo (1).PNG');
    await fs.writeFile(src, 'png-bytes');
    await writeMediaManifest(dir, { entries: [{ match: 'media/images/**', tags: ['pic'], description: 'a pic' }] });

    const a = await addAssetFile(dir, src);
    expect(a).toEqual({ path: 'media/images/My-Photo-1.PNG', kind: 'image', bytes: 9, mime: 'image/png', tags: ['pic'], description: 'a pic' });
    const b = await addAssetFile(dir, src);
    const c = await addAssetFile(dir, src);
    expect([b.path, c.path]).toEqual(['media/images/My-Photo-1-2.PNG', 'media/images/My-Photo-1-3.PNG']);
    expect(await fs.readFile(src, 'utf8')).toBe('png-bytes'); // copied, not moved
    expect(await fs.readFile(path.join(dir, 'media', 'images', 'My-Photo-1-3.PNG'), 'utf8')).toBe('png-bytes');

    const wav = path.join(path.dirname(src), 'beep.wav');
    await fs.writeFile(wav, 'wav');
    expect((await addAssetFile(dir, wav)).path).toBe('media/audio/beep.wav');
    const txt = path.join(path.dirname(src), 'notes.md');
    await fs.writeFile(txt, 'md');
    expect((await addAssetFile(dir, txt)).path).toBe('media/text/notes.md');

    const pack = await loadPack(dir);
    expect(pack.assets.map((x) => x.path)).toContain('media/images/My-Photo-1-2.PNG');
    expect(await validatePack(dir)).toMatchObject({ ok: true });
  });

  it('rejects unsupported kinds unless kind is given, and missing sources', async () => {
    const dir = await scaffolded();
    const bin = path.join(await temp(), 'model.bin');
    await fs.writeFile(bin, 'x');
    await expectRpError(addAssetFile(dir, bin), 'INVALID_ARGUMENT');
    await expectRpError(addAssetFile(dir, bin, { kind: 'sprite' as never }), 'INVALID_ARGUMENT');
    expect(await addAssetFile(dir, bin, { kind: 'other' })).toMatchObject({ path: 'media/other/model.bin', kind: 'other', tags: [] });
    await expectRpError(addAssetFile(dir, path.join(path.dirname(bin), 'nope.png')), 'NOT_FOUND');
    await expectRpError(addAssetFile(path.join(dir, 'characters'), bin, { kind: 'other' }), 'NOT_FOUND');
  });

  it('places files in a subdir whose folder names become tags', async () => {
    const dir = await scaffolded();
    const src = path.join(await temp(), 'sunset.jpg');
    await fs.writeFile(src, 'jpg');
    const a = await addAssetFile(dir, src, { subdir: 'wallpapers' });
    expect(a).toMatchObject({ path: 'media/images/wallpapers/sunset.jpg', kind: 'image', tags: ['wallpapers'] });
    const b = await addAssetFile(dir, src, { subdir: 'outfits/summer/' });
    expect(b).toMatchObject({ path: 'media/images/outfits/summer/sunset.jpg', tags: ['outfits', 'summer'] });
    const c = await addAssetFile(dir, src, { subdir: 'wallpapers' });
    expect(c.path).toBe('media/images/wallpapers/sunset-2.jpg');
    const pack = await loadPack(dir);
    expect(pack.assets.find((x) => x.path === a.path)).toMatchObject({ tags: ['wallpapers'] });
    expect(pack.assets.find((x) => x.path === b.path)).toMatchObject({ tags: ['outfits', 'summer'] });
  });

  it('rejects invalid subdirs without copying', async () => {
    const dir = await scaffolded();
    const src = path.join(await temp(), 'x.png');
    await fs.writeFile(src, 'x');
    for (const subdir of ['../escape', '/abs', 'Wallpapers', 'wall papers', 'a/../b', '', '.', 'wall\\papers', 'ünïcode', '-lead']) {
      await expectRpError(addAssetFile(dir, src, { subdir }), 'INVALID_ARGUMENT');
    }
    expect(await listFiles(path.join(dir, 'media'))).toEqual([]);
  });

  it('removes the file and exact-path media.json entries only', async () => {
    const dir = await scaffolded();
    const src = path.join(await temp(), 'a.png');
    await fs.writeFile(src, 'x');
    const added = await addAssetFile(dir, src);
    await writeMediaManifest(dir, {
      entries: [
        { match: added.path, tags: ['gone'] },
        { match: './media/images/a.png', tags: ['gone-too'] },
        { match: 'media/images/*.png', tags: ['glob-kept'] },
      ],
      tags: { kept: 'still here' },
    });
    await removeAsset(dir, added.path);
    await expect(fs.stat(path.join(dir, added.path))).rejects.toThrow();
    const media = JSON.parse(await fs.readFile(path.join(dir, 'media.json'), 'utf8'));
    expect(media.entries).toEqual([{ match: 'media/images/*.png', tags: ['glob-kept'] }]);
    expect(media.tags).toEqual({ kept: 'still here' });

    await expectRpError(removeAsset(dir, added.path), 'NOT_FOUND');
    await expectRpError(removeAsset(dir, '../etc/passwd'), 'PATH_ESCAPE');
    await expectRpError(removeAsset(dir, 'pack.json'), 'INVALID_ARGUMENT');
    await expectRpError(removeAsset(dir, 'characters/nova/persona.md'), 'INVALID_ARGUMENT');
    expect(await fs.stat(path.join(dir, 'pack.json'))).toBeTruthy();
  });
});

describe('templates and slugify', () => {
  it('offers one starter script per hook, explaining input', () => {
    const templates = behaviourTemplates();
    expect(templates.map((t) => t.hook)).toEqual([...BEHAVIOUR_HOOKS]);
    for (const t of templates) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.source).toMatch(/`input`/);
      expect(t.source).toContain('return');
    }
    const start = templates.find((t) => t.hook === 'onSessionStart')!;
    expect(start.source).toContain('getHours()');
    expect(start.source).toContain("sdk.state.set('sessions'");
    expect(templates.find((t) => t.hook === 'onUserMessage')!.source).toContain('skipLlm');
    expect(templates.find((t) => t.hook === 'onTimer')!.source).toContain('timer');
    expect(templates.find((t) => t.hook === 'onEvent')!.source).toContain('event');
  });

  it('personaTemplate has the four sections', () => {
    const text = personaTemplate('Nova');
    for (const h of ['# Nova', '## Who you are', '## How you talk', '## What you care about', '## Using your abilities']) {
      expect(text).toContain(h);
    }
    expect(personaTemplate('  ')).toContain('# The character');
  });

  it('maps hooks to kebab-case script paths', () => {
    expect(hookFileStem('onSessionStart')).toBe('on-session-start');
    expect(behaviourScriptPath('onUserMessage')).toBe('scripts/on-user-message.ts');
    expect(behaviourScriptPath('onEvent')).toBe('scripts/on-event.ts');
  });

  it('slugify produces valid character ids', () => {
    expect(slugify('Luna')).toBe('luna');
    expect(slugify('Luna Nightingale!')).toBe('luna-nightingale');
    expect(slugify('  Éloïse  Ça va ')).toBe('eloise-ca-va');
    expect(slugify('---')).toBe('character');
    expect(slugify('')).toBe('character');
    expect(slugify('42 Dogs')).toBe('42-dogs');
  });
});

describe('library files', () => {
  it('parses and formats the description comment + function source', () => {
    expect(parseLibraryFile('// show a picture\nasync (mood: string) => 1\n')).toEqual({ description: 'show a picture', source: 'async (mood: string) => 1' });
    expect(parseLibraryFile('async (mood: string) => 1')).toEqual({ source: 'async (mood: string) => 1' });
    expect(parseLibraryFile('//\n() => 1')).toEqual({ source: '() => 1' });
    expect(parseLibraryFile('\r\n// x\r\n() => 1\r\n')).toEqual({ source: '// x\n() => 1' }); // a blank first line means no description
    expect(formatLibraryFile('() => 1', 'tick')).toBe('// tick\n() => 1\n');
    expect(formatLibraryFile('  () => 1\n', '  two\n  lines ')).toBe('// two lines\n() => 1\n');
    expect(formatLibraryFile('() => 1')).toBe('() => 1\n');
    expect(formatLibraryFile('() => 1', '   ')).toBe('() => 1\n');
    expect(parseLibraryFile(formatLibraryFile('x => x', 'id'))).toEqual({ description: 'id', source: 'x => x' });
    // `// @internal` marks an author's helper; the rest of the line stays its description
    expect(parseLibraryFile('// @internal pick a picture\n() => 1')).toEqual({ description: 'pick a picture', internal: true, source: '() => 1' });
    expect(parseLibraryFile('// @internal\n() => 1')).toEqual({ internal: true, source: '() => 1' });
    expect(parseLibraryFile('// @internally useful\n() => 1')).toEqual({ description: '@internally useful', source: '() => 1' });
    expect(formatLibraryFile('() => 1', 'pick a picture', true)).toBe('// @internal pick a picture\n() => 1\n');
    expect(formatLibraryFile('() => 1', undefined, true)).toBe('// @internal\n() => 1\n');
    expect(parseLibraryFile(formatLibraryFile('x => x', 'id', true))).toEqual({ description: 'id', internal: true, source: 'x => x' });
    expect(parseLibraryFile(libraryFunctionTemplate())).toMatchObject({ description: expect.stringContaining('description'), source: expect.stringMatching(/^async \(mood: string\) => \{/) });
  });

  it('validates names', () => {
    expect(libraryNameProblem('cheer')).toBeUndefined();
    expect(libraryNameProblem('_$ok9')).toBeUndefined();
    for (const bad of ['', '1abc', 'a-b', 'class', 'await', '__proto__', 'x'.repeat(65), 'has space', 42]) {
      expect(libraryNameProblem(bad), String(bad)).toMatch(/name|reserved/);
    }
  });

  it('writes, reads back, replaces and removes lib/<name>.ts', async () => {
    const dir = await scaffolded();
    const rel = await writeLibraryFunction(dir, 'characters/nova', 'cheer', 'async (mood: string) => {\n  return mood;\n}', 'show a picture for a mood');
    expect(rel).toBe('characters/nova/lib/cheer.ts');
    expect(await fs.readFile(path.join(dir, rel), 'utf8')).toBe('// show a picture for a mood\nasync (mood: string) => {\n  return mood;\n}\n');
    await writeLibraryFunction(dir, 'characters/nova', 'tick', '() => 1');
    const helper = await writeLibraryFunction(dir, 'characters/nova', 'pick', '() => 1', 'pick a picture', true);
    expect(await fs.readFile(path.join(dir, helper), 'utf8')).toBe('// @internal pick a picture\n() => 1\n');
    const scan = await readCharacterLibrary(dir, 'characters/nova');
    expect(scan.problems).toEqual([]);
    expect(scan.skipped).toEqual([]);
    expect(Object.keys(scan.library)).toEqual(['cheer', 'pick', 'tick']);
    expect(scan.library['cheer']).toMatchObject({ description: 'show a picture for a mood', source: 'async (mood: string) => {\n  return mood;\n}', file: rel });
    expect(scan.library['tick']!.description).toBeUndefined();
    expect(scan.library['pick']).toMatchObject({ description: 'pick a picture', internal: true });
    expect(scan.library['cheer']!.internal).toBeUndefined();
    // the loader sees the same
    expect(Object.keys((await loadPack(dir)).character.library)).toEqual(['cheer', 'pick', 'tick']);
    // replacing keeps one file; no temp files are left behind
    await writeLibraryFunction(dir, 'characters/nova', 'tick', '() => 2', 'ticks');
    expect((await readCharacterLibrary(dir, 'characters/nova')).library['tick']).toMatchObject({ source: '() => 2', description: 'ticks' });
    expect((await fs.readdir(path.join(dir, 'characters/nova/lib'))).sort()).toEqual(['README.md', 'cheer.ts', 'pick.ts', 'tick.ts']);
    expect(await removeLibraryFunction(dir, 'characters/nova', 'tick')).toBe(true);
    expect(await removeLibraryFunction(dir, 'characters/nova', 'tick')).toBe(false);
    expect(await removeLibraryFunction(dir, 'characters/nova', 'pick')).toBe(true);
    expect(Object.keys((await readCharacterLibrary(dir, 'characters/nova')).library)).toEqual(['cheer']);
    await expectRpError(writeLibraryFunction(dir, 'characters/nova', 'a-b', '() => 1'), 'INVALID_ARGUMENT');
    await expectRpError(writeLibraryFunction(dir, '../nova', 'ok', '() => 1'), 'PATH_ESCAPE');
    await expectRpError(removeLibraryFunction(dir, 'characters/nova', 'class'), 'INVALID_ARGUMENT');
    // a broken file is reported by the scan with its content, so an editor can show it
    await fs.writeFile(path.join(dir, 'characters/nova/lib/bad.ts'), '// oops\nasync ( => 1\n');
    const withBad = await readCharacterLibrary(dir, 'characters/nova');
    expect(withBad.skipped).toEqual([{ file: 'characters/nova/lib/bad.ts', name: 'bad', message: expect.stringMatching(/^not a single function expression: fn does not parse/), source: 'async ( => 1', description: 'oops' }]);
    expect((await readCharacterLibrary(dir, 'characters/none')).library).toEqual({});
  });
});
