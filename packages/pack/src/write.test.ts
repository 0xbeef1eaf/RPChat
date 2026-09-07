import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import {
  BEHAVIOUR_HOOKS,
  addAssetFile,
  behaviourScriptPath,
  behaviourTemplates,
  hookFileStem,
  loadPack,
  personaTemplate,
  removeAsset,
  scaffoldPack,
  slugify,
  validatePack,
  writeCharacter,
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
      'characters/nova/persona.md',
      'media.json',
      'pack.json',
    ]);
    for (const sub of ['media/images', 'media/video', 'media/audio', 'characters/nova/scripts']) {
      expect((await fs.stat(path.join(dir, sub))).isDirectory()).toBe(true);
    }
    const pack = await loadPack(dir);
    expect(pack.manifest).toMatchObject({ id: 'com.test.scaffold', name: 'Scaffold', version: '0.1.0', capabilities: ['media'] });
    expect(pack.characters[0]!.definition).toMatchObject({ id: 'nova', name: 'Nova', persona: 'persona.md' });
    expect(pack.characters[0]!.personaText).toContain('# Nova');
    expect(pack.characters[0]!.personaText).toContain('## Using your abilities');
    expect(pack.characters[0]!.behaviourSources).toEqual({});
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
    await writeManifest(dir, { ...pack.manifest, tags: ['b', 'a'], license: 'MIT', name: 'Renamed', capabilities: ['media', 'ui'] });
    const text = await fs.readFile(path.join(dir, 'pack.json'), 'utf8');
    expect(Object.keys(JSON.parse(text))).toEqual(['formatVersion', 'id', 'name', 'version', 'description', 'license', 'tags', 'characters', 'capabilities', 'mediaRoot']);
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
      'avatar.png', 'character.json', 'faces/neutral.png', 'persona.md', 'scripts/helper.ts', 'scripts/on-timer.ts',
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
