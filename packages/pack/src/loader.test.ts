import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { loadPack, requestedCapabilities, summariseTags, validatePack } from './index.js';
import { LUNA_DIR, MAKIMA_DIR, MINIMAL_DIR, makeTempDir, minimalPackFiles, writeTree } from './test/helpers.js';

describe('loadPack', () => {
  it('loads the luna example pack', async () => {
    const pack = await loadPack(LUNA_DIR);
    expect(pack.root).toBe(path.resolve(LUNA_DIR));
    expect(pack.manifest.id).toBe('com.example.luna');
    expect(pack.manifest.capabilities).toEqual(['media', 'ui']);
    expect(pack.readme).toContain('# Luna');

    expect(pack.characters).toHaveLength(1);
    const luna = pack.characters[0]!;
    expect(luna.dir).toBe('characters/luna');
    expect(luna.definition.id).toBe('luna');
    expect(luna.definition.name).toBe('Luna');
    expect(luna.personaText).toContain('You are Luna');
    expect(luna.personaText).toContain('sdk.timers.schedule');
    expect(luna.avatarPath).toBe('characters/luna/avatar.png');

    expect(Object.keys(luna.behaviourSources).sort()).toEqual(['onSessionStart', 'onTimer']);
    expect(luna.behaviourSources.onSessionStart).toContain('sdk.chat.say(');
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
    expect(requestedCapabilities(pack)).toEqual(['media', 'ui']);
  });

  it('loads the makima example pack (every pack feature)', async () => {
    const pack = await loadPack(MAKIMA_DIR);
    expect(pack.manifest.id).toBe('com.example.makima');
    expect(requestedCapabilities(pack)).toEqual(['avatar', 'browser', 'calendar', 'desktop', 'events', 'files', 'input', 'media', 'messaging', 'presence', 'screen', 'system', 'ui', 'voice', 'wallpaper', 'web', 'widgets']);
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
      'media/images/wallpapers/dim-office.png',
      'media/images/wallpapers/red-dusk.png',
      'media/images/wallpapers/ring-motif.png',
      'media/video/ring-pulse.webm',
    ]);
    expect(byPath.get('media/images/wallpapers/red-dusk.png')).toMatchObject({ kind: 'image', tags: ['control', 'dusk', 'wallpaper', 'wallpapers'] });
    expect(byPath.get('characters/makima/expressions/stare.png')).toMatchObject({ kind: 'image', tags: ['expression', 'expressions', 'makima', 'portrait'] });
    expect(byPath.get('media/video/ring-pulse.webm')).toMatchObject({ kind: 'video', mime: 'video/webm', tags: ['pulse', 'ring'] });
    expect(byPath.get('media/audio/attention.wav')!.bytes).toBeLessThan(100 * 1024);
    for (const a of pack.assets) expect(a.description ?? (a.tags.length > 0 ? 'x' : '')).not.toBe('');
    expect(summariseTags(pack.assets, pack.tagDescriptions).slice(0, 2)).toEqual([
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
    expect(requestedCapabilities(pack)).toEqual([]);
    expect(await validatePack(MINIMAL_DIR)).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('merges pack and character capabilities, deduplicated and sorted', async () => {
    const pack = await loadPack(LUNA_DIR);
    const withExtra = {
      ...pack,
      manifest: { ...pack.manifest, capabilities: ['ui', 'media'] },
      characters: [
        { ...pack.characters[0]!, definition: { ...pack.characters[0]!.definition, capabilities: ['system', 'media'] } },
      ],
    };
    expect(requestedCapabilities(withExtra)).toEqual(['media', 'system', 'ui']);
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
    expect((await validatePack(dir2)).problems).toEqual(['pack.json: character directory "characters/ghost" does not exist']);
  });

  it('reports duplicate character ids across directories', async () => {
    const files = minimalPackFiles();
    const manifest = JSON.parse(files['pack.json']!) as { characters: string[] };
    manifest.characters = ['characters/a', 'characters/b'];
    files['pack.json'] = JSON.stringify(manifest);
    files['characters/b/character.json'] = JSON.stringify({ id: 'a', name: 'B', persona: 'persona.md' });
    files['characters/b/persona.md'] = 'B';
    const dir = await packWith(files);
    const { problems } = await validatePack(dir);
    expect(problems).toEqual(['characters/b/character.json: duplicate character id "a" (also in characters/a)']);
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
