import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { LIB_MAX_FUNCTIONS, LIB_MAX_TOTAL_BYTES } from '@rp/shared';
import { ignoredCapabilitiesWarning, loadPack, summariseTags, validatePack } from './index.js';
import { LUNA_DIR, MAKIMA_DIR, MINIMAL_DIR, makeTempDir, minimalPackFiles, writeTree } from './test/helpers.js';

describe('loadPack', () => {
  it('loads the luna example pack', async () => {
    const pack = await loadPack(LUNA_DIR);
    expect(pack.root).toBe(path.resolve(LUNA_DIR));
    expect(pack.manifest.id).toBe('com.example.luna');
    expect('capabilities' in pack.manifest).toBe(false); // permissions are app-wide; packs declare none
    expect(pack.readme).toContain('# Luna');

    expect(pack.characters).toHaveLength(1);
    const luna = pack.characters[0]!;
    expect(pack.character).toBe(luna);
    expect(luna.library).toEqual({ files: {}, functions: {}, code: '', problems: [] });
    expect(luna.dir).toBe('characters/luna');
    expect(luna.definition.id).toBe('luna');
    expect(luna.definition.name).toBe('Luna');
    expect(luna.personaText).toContain('You are Luna');
    expect(luna.personaText).toContain('sdk.timers.schedule');
    expect(luna.avatarPath).toBe('characters/luna/avatar.png');

    expect(Object.keys(luna.behaviourSources).sort()).toEqual(['onSessionStart', 'onTimer']);
    expect(luna.behaviourSources.onSessionStart).toContain('sdk.llm.wake(');
    expect(luna.behaviourSources.onSessionStart).toContain("sdk.state.set('sessions'");
    expect(luna.behaviourSources.onTimer).toContain('sdk.media.playAudio(');

    expect(pack.assets.map((a) => [a.path, a.kind])).toEqual([
      ['characters/luna/avatar.png', 'image'],
      ['media/audio/chime.wav', 'audio'],
      ['media/images/luna-smile.png', 'image'],
      ['media/images/luna-wave.png', 'image'],
      ['media/images/teal-card.png', 'image'],
      ['media/video/testcard.webm', 'video'],
    ]);
    const wav = pack.assets.find((a) => a.path === 'media/audio/chime.wav')!;
    expect(wav.bytes).toBeLessThan(100 * 1024);
  });

  it('loads the makima example pack (every pack feature)', async () => {
    const pack = await loadPack(MAKIMA_DIR);
    expect(pack.manifest.id).toBe('com.example.makima');
    expect(await validatePack(MAKIMA_DIR)).toMatchObject({ ok: true, warnings: [] }); // no legacy capabilities key
    expect(pack.readme).toMatch(/Tatsuki Fujimoto/);
    expect(pack.readme).toMatch(/placeholder/i);

    const makima = pack.characters[0]!;
    expect(makima.definition).toMatchObject({
      id: 'makima',
      mood: { baseline: 0.1, energyBaseline: 0.6 },
      modelHints: { temperature: 0.8 },
      avatarSet: { defaultExpression: 'neutral' },
    });
    expect(Object.keys(makima.definition.avatarSet!.expressions).sort()).toEqual(['displeased', 'neutral', 'smile', 'stare']);
    expect(makima.definition.exampleDialogue).toHaveLength(6);
    expect(Object.keys(makima.behaviourSources).sort()).toEqual(['onEvent', 'onSessionStart', 'onTimer', 'onUserMessage']);
    expect(makima.behaviourSources.onSessionStart).toContain('sdk.avatar.show(');
    expect(makima.behaviourSources.onUserMessage).toContain('sdk.mood.nudge(');
    expect(makima.behaviourSources.onUserMessage).not.toMatch(/skipLlm: true/);
    expect(makima.behaviourSources.onTimer).toContain("media/audio/attention.wav");
    expect(makima.behaviourSources.onEvent).toContain("'user-back'");
    expect(makima.behaviourSources.onEvent).toContain("'window-changed'");
    expect(makima.personaText).toMatch(/\*\*chainsaw\*\*/);
    // the shipped function library: characters/makima/lib/glance.ts plus the mini games and their helpers
    const lib = makima.library;
    expect(lib.problems).toEqual([]);
    expect(Object.keys(lib.functions)).toEqual(['endGame', 'gameLost', 'gameSetup', 'glance', 'memoryGame', 'molePop', 'punish', 'quitGame', 'reactionTest', 'reward', 'simonSays', 'slidingPuzzle', 'whackAMole', 'writeLines']);
    for (const name of ['memoryGame', 'simonSays', 'writeLines', 'whackAMole', 'reactionTest', 'slidingPuzzle']) {
      const fn = lib.functions[name]!;
      const source = lib.files[fn.file]!;
      expect(fn.file, name).toBe(`characters/makima/lib/${name}.ts`);
      expect(fn.description, name).toMatch(/^\(game\) .*lib\[onLose\]/); // the loss function is named, and what it receives is documented
      expect(fn.params, name).toMatch(/^opts: \{ onLose: string; onWin\?: string;/);
      expect(source, name).toContain('lib.gameSetup(');
      expect(source, name).toContain('lib.endGame(');
    }
    for (const name of ['memoryGame', 'simonSays', 'slidingPuzzle']) expect(lib.files[`characters/makima/lib/${name}.ts`], name).toContain('{{asset:');
    expect(lib.functions['punish']!.description).toMatch(/onLose/);
    expect(lib.functions['reward']!.description).toMatch(/onWin/);
    expect(lib.functions['glance']).toEqual({
      name: 'glance',
      file: 'characters/makima/lib/glance.ts',
      params: '',
      description: 'show a random portrait of Makima for five seconds and return its path',
    });
    expect(lib.files['characters/makima/lib/glance.ts']).toMatch(/^\/\*\* show a random portrait[^\n]*\*\/\nexport const glance = async \(\) => \{[\s\S]*sdk\.media\.showImage\(pick, \{ durationMs: 5000/);
    expect(lib.code).toContain('sdk.media.showImage(pick');
    expect(makima.personaText).toContain('sdk.wallpaper');
    const words = makima.personaText.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThan(550);
    expect(words).toBeLessThan(950);

    const byPath = new Map(pack.assets.map((a) => [a.path, a]));
    expect([...byPath.keys()]).toEqual([
      'characters/makima/avatar.png',
      'characters/makima/expressions/displeased.png',
      'characters/makima/expressions/neutral.png',
      'characters/makima/expressions/smile.png',
      'characters/makima/expressions/stare.png',
      'media/audio/attention.wav',
      'media/audio/click.wav',
      'media/images/cards/blue-square.png',
      'media/images/cards/green-diamond.png',
      'media/images/cards/orange-cross.png',
      'media/images/cards/pink-dot.png',
      'media/images/cards/purple-ring.png',
      'media/images/cards/red-circle.png',
      'media/images/cards/teal-bar.png',
      'media/images/cards/yellow-triangle.png',
      'media/images/wallpapers/dim-office.png',
      'media/images/wallpapers/red-dusk.png',
      'media/images/wallpapers/ring-motif.png',
      'media/video/ring-pulse.webm',
    ]);
    expect(byPath.get('media/images/wallpapers/red-dusk.png')).toMatchObject({ kind: 'image', tags: ['control', 'dusk', 'wallpaper', 'wallpapers'] });
    expect(byPath.get('characters/makima/expressions/stare.png')).toMatchObject({ kind: 'image', tags: ['expression', 'expressions', 'makima', 'portrait'] });
    expect(byPath.get('media/video/ring-pulse.webm')).toMatchObject({ kind: 'video', mime: 'video/webm', tags: ['pulse', 'ring'] });
    // the game tiles: eight tiny solid-colour PNGs tagged `card` (folder tag `cards`), under a kilobyte together
    const cards = pack.assets.filter((a) => a.path.startsWith('media/images/cards/'));
    expect(cards).toHaveLength(8);
    for (const c of cards) expect(c, c.path).toMatchObject({ kind: 'image', tags: ['card', 'cards'] });
    expect(cards.reduce((n, c) => n + c.bytes, 0)).toBeLessThan(4 * 1024);
    expect(byPath.get('media/audio/attention.wav')!.bytes).toBeLessThan(100 * 1024);
    for (const a of pack.assets) expect(a.description ?? (a.tags.length > 0 ? 'x' : '')).not.toBe('');
    expect(summariseTags(pack.assets, pack.tagDescriptions).slice(0, 4)).toEqual([
      { tag: 'card', count: 8, description: expect.stringContaining('mini games') },
      { tag: 'cards', count: 8 },
      { tag: 'makima', count: 5 },
      { tag: 'portrait', count: 5, description: expect.stringContaining('placeholder') },
    ]);
    expect(await validatePack(MAKIMA_DIR)).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('loads the minimal example pack', async () => {
    const pack = await loadPack(MINIMAL_DIR);
    expect(pack.characters).toHaveLength(1);
    expect(pack.characters[0]!.definition.id).toBe('echo');
    expect(pack.characters[0]!.avatarPath).toBeUndefined();
    expect(pack.characters[0]!.behaviourSources).toEqual({});
    expect(pack.assets).toEqual([]);
    expect(pack.tagDescriptions).toBeUndefined();
    expect(pack.readme).toBeUndefined();
    expect(await validatePack(MINIMAL_DIR)).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('accepts a legacy "capabilities" key in pack.json and character.json, drops it and warns', async () => {
    const dir = await makeTempDir();
    try {
      const files = minimalPackFiles();
      const manifest = JSON.parse(files['pack.json']!) as Record<string, unknown>;
      manifest.capabilities = ['media', 'Not-Even-Valid', 42];
      files['pack.json'] = JSON.stringify(manifest);
      const def = JSON.parse(files['characters/a/character.json']!) as Record<string, unknown>;
      def.capabilities = 'system';
      files['characters/a/character.json'] = JSON.stringify(def);
      await writeTree(dir, files);

      const pack = await loadPack(dir);
      expect('capabilities' in pack.manifest).toBe(false);
      expect('capabilities' in pack.character.definition).toBe(false);
      expect(await validatePack(dir)).toEqual({
        ok: true,
        problems: [ignoredCapabilitiesWarning('pack.json'), ignoredCapabilitiesWarning('characters/a/character.json')],
        warnings: [ignoredCapabilitiesWarning('pack.json'), ignoredCapabilitiesWarning('characters/a/character.json')],
      });
      expect(ignoredCapabilitiesWarning('pack.json')).toBe('warning: pack.json: "capabilities" is ignored; permissions are set in the app under Settings → Permissions');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validatePack / loadPack problems', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((t) => fs.rm(t, { recursive: true, force: true })));
  });

  async function packWith(files: Record<string, string>): Promise<string> {
    const tmp = await makeTempDir();
    temps.push(tmp);
    await writeTree(tmp, files);
    return tmp;
  }

  it('reports a missing root or pack.json without throwing', async () => {
    const tmp = await makeTempDir();
    temps.push(tmp);
    expect(await validatePack(path.join(tmp, 'nope'))).toMatchObject({ ok: false });
    const empty = await validatePack(tmp);
    expect(empty.ok).toBe(false);
    expect(empty.problems).toEqual(['pack.json: missing']);
    await expect(loadPack(tmp)).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });

  it('reports unparsable and invalid manifests', async () => {
    const bad = await packWith({ 'pack.json': '{ not json' });
    expect((await validatePack(bad)).problems[0]).toMatch(/^pack\.json: not valid JSON/);
    const invalid = await packWith({ ...minimalPackFiles(), 'pack.json': JSON.stringify({ formatVersion: 1, id: 'x' }) });
    const result = await validatePack(invalid);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Invalid pack.json');
  });

  it('reports missing character dirs, persona, avatar and behaviour files', async () => {
    const files = minimalPackFiles();
    files['characters/a/character.json'] = JSON.stringify({
      id: 'a',
      name: 'A',
      persona: 'missing.md',
      avatar: 'nope.png',
      behaviours: { onTimer: 'scripts/nope.ts' },
    });
    const dir = await packWith(files);
    const { ok, problems } = await validatePack(dir);
    expect(ok).toBe(false);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/persona file "missing.md" not found/);
    expect(problems.join('\n')).toMatch(/avatar "nope.png" not found/);
    expect(problems.join('\n')).toMatch(/behaviour onTimer script "scripts\/nope.ts" not found/);

    const manifest = JSON.parse(files['pack.json']!) as { characters: string[] };
    manifest.characters = ['characters/ghost'];
    const dir2 = await packWith({ ...minimalPackFiles(), 'pack.json': JSON.stringify(manifest) });
    expect((await validatePack(dir2)).problems).toEqual([
      'pack.json: character directory "characters/ghost" does not exist',
      'characters/a/character.json: a pack has exactly one character ("characters/ghost"); move "characters/a" into a pack of its own or delete it',
    ]);
  });

  it('rejects a second character, whether the manifest lists it or it only sits on disk', async () => {
    const files = minimalPackFiles();
    const manifest = JSON.parse(files['pack.json']!) as { characters: string[] };
    files['characters/b/character.json'] = JSON.stringify({ id: 'b', name: 'B', persona: 'persona.md' });
    files['characters/b/persona.md'] = 'B';
    // listed: the manifest schema refuses two entries
    const listed = await packWith({ ...files, 'pack.json': JSON.stringify({ ...manifest, characters: ['characters/a', 'characters/b'] }) });
    const viaManifest = await validatePack(listed);
    expect(viaManifest.ok).toBe(false);
    expect(viaManifest.problems).toHaveLength(1);
    expect(viaManifest.problems[0]).toMatch(/^pack\.json: .*a pack has exactly one character/);
    // not listed: the extra directory is still a problem, so the folder and the manifest cannot disagree silently
    const unlisted = await packWith(files);
    const onDisk = await validatePack(unlisted);
    expect(onDisk.ok).toBe(false);
    expect(onDisk.problems).toEqual(['characters/b/character.json: a pack has exactly one character ("characters/a"); move "characters/b" into a pack of its own or delete it']);
    await expect(loadPack(unlisted)).rejects.toMatchObject({ code: 'PACK_INVALID' });
    // a folder under characters/ without a character.json (notes, shared media) is not a character
    const notes = await packWith({ ...minimalPackFiles(), 'characters/notes/todo.md': 'x' });
    expect((await validatePack(notes)).ok).toBe(true);
  });

  it('reads every .ts file under lib/ as a module whose exports are the library', async () => {
    const dir = await packWith({
      ...minimalPackFiles(),
      'characters/a/lib/README.md': 'ignored',
      'characters/a/lib/.hidden.ts': 'export const hidden = () => 1;',
      'characters/a/lib/.git/x.ts': 'export const git = () => 1;',
      'characters/a/lib/types.d.ts': 'declare const nope: number;',
      'characters/a/lib/notes.txt': 'ignored',
      'characters/a/lib/wave.ts': '/** Wave hello. */\nexport async function wave(times: number) {\n  await sdk.chat.emote(`waves ${times}x`);\n  return times;\n}\n',
      'characters/a/lib/math/double.ts': "import { MARK } from './marks';\nexport const double = (n: number) => n * 2;\nexport const marked = (n: number) => `${n}${MARK}`;\n",
      'characters/a/lib/math/marks.ts': 'export const MARK = "!";\n',
      'characters/a/lib/pick.ts': '/**\n * @internal\n * Pick a picture.\n */\nexport const pick = (mood: string) => mood;\n',
    });
    expect(await validatePack(dir)).toEqual({ ok: true, problems: [], warnings: [] });
    const lib = (await loadPack(dir)).character.library;
    expect(Object.keys(lib.files)).toEqual(['characters/a/lib/math/double.ts', 'characters/a/lib/math/marks.ts', 'characters/a/lib/pick.ts', 'characters/a/lib/wave.ts']);
    expect(lib.functions).toEqual({
      double: { name: 'double', file: 'characters/a/lib/math/double.ts', params: 'n: number' },
      marked: { name: 'marked', file: 'characters/a/lib/math/double.ts', params: 'n: number' },
      // `@internal` marks the author's own plumbing: it loads like any other function, flagged
      pick: { name: 'pick', file: 'characters/a/lib/pick.ts', params: 'mood: string', description: 'Pick a picture.', internal: true },
      wave: { name: 'wave', file: 'characters/a/lib/wave.ts', params: 'times: number', description: 'Wave hello.' },
    });
    expect(lib.code).toMatch(/^\(\(\) => \{/);
  });

  it('loads a pack whose library does not build, with the reason as a warning', async () => {
    const dir = await packWith({
      ...minimalPackFiles(),
      'characters/a/lib/good.ts': 'export const good = () => 1;',
      'characters/a/lib/broken.ts': '// half\nexport const broken = async ( => 1;',
    });
    const result = await validatePack(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['warning: characters/a/lib/broken.ts:2:31: Unexpected "=>"']);
    const lib = (await loadPack(dir)).character.library;
    expect(lib.functions).toEqual({});
    expect(Object.keys(lib.files)).toEqual(['characters/a/lib/broken.ts', 'characters/a/lib/good.ts']);
  });

  it('warns about a file in the old one-function format, which now adds nothing', async () => {
    const dir = await packWith({
      ...minimalPackFiles(),
      'characters/a/lib/old.ts': '// show a picture\nasync (mood: string) => mood\n',
      'characters/a/lib/new.ts': 'export const fresh = () => 1;',
    });
    const result = await validatePack(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringMatching(/^warning: characters\/a\/lib\/old\.ts: this file exports nothing and no other file imports it/)]);
    expect(Object.keys((await loadPack(dir)).character.library.functions)).toEqual(['fresh']);
  });

  it('enforces the library caps as warnings', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= LIB_MAX_FUNCTIONS; i++) many[`characters/a/lib/f${i}.ts`] = `export const f${i} = () => 1;`;
    // internal exports are not listed in the prompt, so they do not count
    many['characters/a/lib/plumbing.ts'] = '/** @internal */\nexport const plumbing = () => 1;';
    const tooMany = await packWith({ ...minimalPackFiles(), ...many });
    const manyResult = await validatePack(tooMany);
    expect(manyResult.ok).toBe(true);
    expect(manyResult.warnings).toEqual([
      `warning: characters/a/lib: ${LIB_MAX_FUNCTIONS + 1} public functions (over the advisory ${LIB_MAX_FUNCTIONS}); each one adds a <library> line to every prompt`,
    ]);
    expect(Object.keys((await loadPack(tooMany)).character.library.functions)).toHaveLength(LIB_MAX_FUNCTIONS + 2);

    const chunk = `export const PAD = "${'c'.repeat(16 * 1024)}";`;
    const files: Record<string, string> = {};
    const count = Math.floor(LIB_MAX_TOTAL_BYTES / Buffer.byteLength(chunk)) + 1;
    for (let i = 0; i < count; i++) files[`characters/a/lib/g${i}.ts`] = chunk.replace('PAD', `PAD${i}`);
    const tooMuch = await packWith({ ...minimalPackFiles(), ...files });
    const muchResult = await validatePack(tooMuch);
    expect(muchResult.ok).toBe(true);
    expect(muchResult.warnings).toEqual([
      expect.stringMatching(/^warning: characters\/a\/lib: \d+ bytes in total \(over the advisory \d+ bytes\); the whole library is evaluated on every run$/),
    ]);
  });

  it('reports a mediaRoot that is a file, but tolerates a missing one', async () => {
    const ok = await packWith({ ...minimalPackFiles() });
    expect((await validatePack(ok)).ok).toBe(true);
    const bad = await packWith({ ...minimalPackFiles(), media: 'i am a file' });
    expect((await validatePack(bad)).problems).toEqual(['pack.json: mediaRoot "media" is not a directory']);
  });

  it('rejects a persona reached through a symlink that leaves the pack', async () => {
    const files = minimalPackFiles();
    files['characters/a/character.json'] = JSON.stringify({ id: 'a', name: 'A', persona: 'link.md' });
    const dir = await packWith(files);
    const outside = await makeTempDir();
    temps.push(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(path.join(outside, 'secret.md'), path.join(dir, 'characters', 'a', 'link.md'));
    const { ok, problems } = await validatePack(dir);
    expect(ok).toBe(false);
    expect(problems[0]).toMatch(/symlink/);
  });

  it('reports an invalid or unparsable media.json as a problem', async () => {
    const bad = await packWith({ ...minimalPackFiles(), 'media.json': '{ nope' });
    expect((await validatePack(bad)).problems).toEqual([expect.stringMatching(/^media\.json: not valid JSON/)]);
    const invalid = await packWith({ ...minimalPackFiles(), 'media.json': JSON.stringify({ entries: [{ match: '../x' }] }) });
    const result = await validatePack(invalid);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/^media\.json: Invalid media\.json: entries\.0\.match/);
    await expect(loadPack(invalid)).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });

  it('warns about media.json entries matching nothing and unused vocabulary tags, without failing', async () => {
    const dir = await packWith({
      ...minimalPackFiles(),
      'media/images/a.png': 'x',
      'media.json': JSON.stringify({
        entries: [
          { match: 'media/images/a.png', tags: ['used'] },
          { match: 'media/video/**', tags: ['never'] },
        ],
        tags: { used: 'is used', orphan: 'is not' },
      }),
    });
    const result = await validatePack(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      'warning: media.json entry 1 ("media/video/**") matches no asset',
      'info: media.json vocabulary tag "orphan" is not used by any asset',
    ]);
    expect(result.problems).toEqual(result.warnings);
    const pack = await loadPack(dir);
    expect(pack.assets[0]).toMatchObject({ path: 'media/images/a.png', tags: ['used'] });
    expect(pack.tagDescriptions).toEqual({ used: 'is used', orphan: 'is not' });
  });

  it('rejects an asset that ends up with more than 20 tags after merging', async () => {
    const entries = Array.from({ length: 3 }, (_, e) => ({
      match: 'media/**',
      tags: Array.from({ length: 8 }, (_, i) => `t${e}-${i}`),
    }));
    const dir = await packWith({ ...minimalPackFiles(), 'media/x.png': 'x', 'media.json': JSON.stringify({ entries }) });
    const result = await validatePack(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['asset "media/x.png" has 24 tags (max 20)']);
  });

  it('loadPack throws RpError(PACK_INVALID) carrying the problems', async () => {
    const dir = await packWith({ 'pack.json': JSON.stringify({ formatVersion: 1 }) });
    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpError);
    expect((caught as RpError).code).toBe('PACK_INVALID');
    expect((caught as RpError).details).toMatchObject({ problems: expect.any(Array) });
  });
});
