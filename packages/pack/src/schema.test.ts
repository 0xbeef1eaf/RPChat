import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import {
  BEHAVIOUR_HOOKS,
  characterDefinitionSchema,
  packManifestSchema,
  validateCharacter,
  validateManifest,
} from './index.js';
import { LUNA_DIR, MINIMAL_DIR } from './test/helpers.js';

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const goodManifest = () => ({
  formatVersion: 1,
  id: 'com.example.x',
  name: 'X',
  version: '1.0.0',
  characters: ['characters/x'],
});

const goodCharacter = () => ({ id: 'x', name: 'X', persona: 'persona.md' });

describe('packManifestSchema', () => {
  it('accepts the example packs', async () => {
    for (const dir of [LUNA_DIR, MINIMAL_DIR]) {
      const json = await readJson(path.join(dir, 'pack.json'));
      expect(packManifestSchema.safeParse(json).success).toBe(true);
      expect(validateManifest(json).id).toMatch(/^com\.example\./);
    }
  });

  it('rejects bad ids', () => {
    for (const id of ['Luna', 'luna', 'com..luna', '.com.luna', 'com.luna.', 'com/luna', 'com.Luna', '']) {
      expect(packManifestSchema.safeParse({ ...goodManifest(), id }).success, id).toBe(false);
    }
  });

  it('rejects bad versions and format versions', () => {
    expect(packManifestSchema.safeParse({ ...goodManifest(), version: '1.0' }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...goodManifest(), version: 'v1.0.0' }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...goodManifest(), version: '1.0.0-beta.1' }).success).toBe(true);
    expect(packManifestSchema.safeParse({ ...goodManifest(), formatVersion: 2 }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...goodManifest(), minAppVersion: 'latest' }).success).toBe(false);
  });

  it('requires exactly one character', () => {
    const { characters: _drop, ...noCharacters } = goodManifest();
    expect(packManifestSchema.safeParse(noCharacters).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...goodManifest(), characters: [] }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...goodManifest(), characters: ['a', 'a'] }).success).toBe(false);
    const two = packManifestSchema.safeParse({ ...goodManifest(), characters: ['characters/a', 'characters/b'] });
    expect(two.success).toBe(false);
    expect(JSON.stringify(two.error?.issues)).toContain('a pack has exactly one character');
  });

  it('rejects `..` segments and absolute paths', () => {
    for (const bad of ['../x', 'characters/../../x', '/etc/x', 'C:\\x', 'chars\\..\\x', '\\\\server\\share']) {
      expect(packManifestSchema.safeParse({ ...goodManifest(), characters: [bad] }).success, bad).toBe(false);
      expect(packManifestSchema.safeParse({ ...goodManifest(), mediaRoot: bad }).success, bad).toBe(false);
    }
  });

  it('accepts and strips the legacy "capabilities" key whatever its value', () => {
    for (const value of [['media', 'ui'], ['Media'], 'system', 42, null, { media: true }]) {
      const result = packManifestSchema.safeParse({ ...goodManifest(), capabilities: value });
      expect(result.success, JSON.stringify(value)).toBe(true);
      expect('capabilities' in result.data!).toBe(false);
    }
    const character = characterDefinitionSchema.safeParse({ id: 'x', name: 'X', persona: 'persona.md', capabilities: ['system'] });
    expect(character.success).toBe(true);
    expect('capabilities' in character.data!).toBe(false);
  });

  it('throws RpError(PACK_INVALID) with issues from validateManifest', () => {
    let caught: unknown;
    try {
      validateManifest({ ...goodManifest(), id: 'bad id', characters: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpError);
    const e = caught as RpError;
    expect(e.code).toBe('PACK_INVALID');
    const issues = (e.details as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues.map((i) => i.path).sort()).toEqual(['characters', 'id']);
    expect(e.message).toContain('pack.json');
  });
});

describe('characterDefinitionSchema', () => {
  it('accepts the example characters', async () => {
    for (const file of [
      path.join(LUNA_DIR, 'characters/luna/character.json'),
      path.join(MINIMAL_DIR, 'characters/echo/character.json'),
    ]) {
      const json = await readJson(file);
      expect(characterDefinitionSchema.safeParse(json).success).toBe(true);
      expect(validateCharacter(json).persona).toBe('persona.md');
    }
  });

  it('rejects bad ids', () => {
    for (const id of ['Luna', '-luna', 'lu na', '', 'luna/x']) {
      expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), id }).success, id).toBe(false);
    }
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), id: 'luna_2-b' }).success).toBe(true);
  });

  it('rejects traversal in persona, avatar and behaviour paths', () => {
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), persona: '../persona.md' }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), persona: '/persona.md' }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatar: '..\\avatar.png' }).success).toBe(false);
    expect(
      characterDefinitionSchema.safeParse({ ...goodCharacter(), behaviours: { onTimer: '../../evil.ts' } }).success,
    ).toBe(false);
  });

  it('requires behaviour scripts to be .ts/.js bound to known hooks', () => {
    expect(
      characterDefinitionSchema.safeParse({ ...goodCharacter(), behaviours: { onTimer: 'scripts/t.ts' } }).success,
    ).toBe(true);
    expect(
      characterDefinitionSchema.safeParse({ ...goodCharacter(), behaviours: { onTimer: 'scripts/t.js' } }).success,
    ).toBe(true);
    expect(
      characterDefinitionSchema.safeParse({ ...goodCharacter(), behaviours: { onTimer: 'scripts/t.py' } }).success,
    ).toBe(false);
    expect(
      characterDefinitionSchema.safeParse({ ...goodCharacter(), behaviours: { onDance: 'scripts/t.ts' } }).success,
    ).toBe(false);
    expect(BEHAVIOUR_HOOKS).toEqual(['onInstall', 'onSessionStart', 'onUserMessage', 'onTimer', 'onEvent', 'onSessionEnd']);
  });

  it('validates the voice block', () => {
    const voice = { model: 'sherpa-onnx-pocket-tts-int8-2026-01-26', reference: 'voice/luna.wav', speaker: 2, rate: 1.1, steps: 8, attribution: 'VCTK (CC-BY-4.0)' };
    const parsed = characterDefinitionSchema.parse({ ...goodCharacter(), voice });
    expect(parsed.voice?.reference).toBe('voice/luna.wav');
    expect(parsed.voice?.model).toBe('sherpa-onnx-pocket-tts-int8-2026-01-26');

    const bad = (v: unknown) => characterDefinitionSchema.safeParse({ ...goodCharacter(), voice: v }).success;
    // A model name is a directory under the voices folder, never a path.
    expect(bad({ model: '../escape' })).toBe(false);
    expect(bad({ model: 'nested/dir' })).toBe(false);
    // A reference stays inside the character directory, whichever kind it is.
    expect(bad({ reference: '../../etc/passwd' })).toBe(false);
    expect(bad({ reference: 'voice/luna.mp3' })).toBe(false);
    // Out-of-range knobs are rejected rather than clamped silently.
    expect(bad({ rate: 4 })).toBe(false);
    expect(bad({ steps: 0 })).toBe(false);
    // A transcript with nothing to transcribe is a mistake worth naming.
    expect(bad({ referenceText: 'hello' })).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), voice: {} }).success).toBe(true);
  });

  it('takes a .qvoice profile as a reference, not only a recording', () => {
    // Qwen3-TTS cannot clone from a wav: its voice is a profile built by a separate model, so the
    // editor writes one here and the schema has to accept it.
    const voice = { model: 'qwen3-tts-0.6b', reference: 'voice/nyx.qvoice' };
    const parsed = characterDefinitionSchema.parse({ ...goodCharacter(), voice });
    expect(parsed.voice?.reference).toBe('voice/nyx.qvoice');

    const bad = (v: unknown) => characterDefinitionSchema.safeParse({ ...goodCharacter(), voice: v }).success;
    expect(bad({ reference: 'voice/nyx.qvoice2' })).toBe(false);
    expect(bad({ reference: '../nyx.qvoice' })).toBe(false);
  });

  it('allows a voice temperature above 2, which Qwen3-TTS needs', () => {
    const ok = (t: number) => characterDefinitionSchema.safeParse({ ...goodCharacter(), voice: { temperature: t } }).success;
    // 2.5 is the tuned default; capping at 2 would re-impose the clamp that made the engine's own
    // server mode useless.
    expect(ok(2.5)).toBe(true);
    expect(ok(10)).toBe(true);
    expect(ok(0)).toBe(true);
    expect(ok(10.5)).toBe(false);
    expect(ok(-1)).toBe(false);
  });

  it('validates avatarSet and mood', () => {
    const ok = { ...goodCharacter(), avatarSet: { expressions: { neutral: 'faces/neutral.png', talk: 'faces/talk.webm' }, defaultExpression: 'neutral', size: 240 }, mood: { baseline: 0.2, energyBaseline: -0.1 } };
    const parsed = validateCharacter(ok);
    expect(parsed.avatarSet?.expressions.talk).toBe('faces/talk.webm');
    expect(parsed.mood).toEqual({ baseline: 0.2, energyBaseline: -0.1 });
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatarSet: { expressions: {} } }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatarSet: { expressions: { neutral: 'n.mp3' } } }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatarSet: { expressions: { neutral: '../n.png' } } }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatarSet: { expressions: { neutral: 'n.png' }, defaultExpression: 'sad' } }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), mood: { baseline: 2 } }).success).toBe(false);
  });

  it('requires the avatar to be an image by extension', () => {
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatar: 'avatar.txt' }).success).toBe(false);
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), avatar: 'img/avatar.WEBP' }).success).toBe(true);
  });

  it('accepts promptFunctions as module ids and single functions, and keeps it', () => {
    const ok = characterDefinitionSchema.safeParse({ ...goodCharacter(), promptFunctions: ['avatar', 'media.showImage', 'plugin.deep.member'] });
    expect(ok.success).toBe(true);
    expect(validateCharacter({ ...goodCharacter(), promptFunctions: ['avatar'] }).promptFunctions).toEqual(['avatar']);
    // An empty list is a deliberate "nothing but sdk.lib", not a mistake.
    expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), promptFunctions: [] }).success).toBe(true);
    for (const bad of [['Avatar'], ['avatar.'], ['.show'], ['avatar show'], ['avatar', 'avatar']]) {
      expect(characterDefinitionSchema.safeParse({ ...goodCharacter(), promptFunctions: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('throws RpError(PACK_INVALID) from validateCharacter', () => {
    expect(() => validateCharacter({ id: 'x' })).toThrowError(RpError);
    try {
      validateCharacter({ id: 'x' });
    } catch (err) {
      expect((err as RpError).code).toBe('PACK_INVALID');
    }
  });
});
