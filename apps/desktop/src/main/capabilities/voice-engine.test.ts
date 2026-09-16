/**
 * The in-process engine's pure parts: turning a detected model directory into the addon's config,
 * building the per-utterance generation config, and the wav conversion either side of it.
 *
 * `seed` is the reason the addon exists at all — the command line cannot pass one — so the rules
 * around it are tested closely.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_GAP_MS, MAX_CHUNK_CHARS, VoiceEngine, buildGenerationConfig, buildModelConfig, flagToConfigPath, joinAudio, readWavFile, splitForSynthesis, writeWavFile } from './voice-engine.js';
import type { VoiceModel } from './voice-models.js';

const logger = { warn: () => undefined, info: () => undefined, debug: () => undefined };
const tmpRoot = fs.mkdtemp(path.join(os.tmpdir(), 'rp-voice-engine-'));
let tmp = '';

const POCKET: VoiceModel = {
  name: 'pocket', dir: '/v/pocket', engine: 'pocket', label: 'Pocket TTS', clones: true,
  files: {
    'pocket-lm-flow': '/v/pocket/lm_flow.int8.onnx',
    'pocket-text-conditioner': '/v/pocket/text_conditioner.onnx',
    'pocket-token-scores-json': '/v/pocket/token_scores.json',
  },
  sampleReference: '/v/pocket/test_wavs/bria.wav',
};
const KOKORO: VoiceModel = {
  name: 'kokoro', dir: '/v/kokoro', engine: 'kokoro', label: 'Kokoro', clones: false,
  files: { 'kokoro-model': '/v/kokoro/model.onnx', 'kokoro-data-dir': '/v/kokoro/espeak-ng-data' },
};

const REF = { samples: new Float32Array([0.1, -0.2, 0.3]), sampleRate: 24000 };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(await tmpRoot, 'case-'));
});

afterAll(async () => {
  await fs.rm(await tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('flagToConfigPath', () => {
  it('turns a CLI flag into the addon’s camelCase config key', () => {
    expect(flagToConfigPath('pocket-lm-flow')).toEqual({ engine: 'pocket', key: 'lmFlow' });
    expect(flagToConfigPath('pocket-text-conditioner')).toEqual({ engine: 'pocket', key: 'textConditioner' });
    expect(flagToConfigPath('pocket-token-scores-json')).toEqual({ engine: 'pocket', key: 'tokenScoresJson' });
    expect(flagToConfigPath('kokoro-data-dir')).toEqual({ engine: 'kokoro', key: 'dataDir' });
    expect(flagToConfigPath('vits-model')).toEqual({ engine: 'vits', key: 'model' });
  });

  it('rejects a flag with no key part', () => {
    expect(flagToConfigPath('pocket')).toBeUndefined();
    expect(flagToConfigPath('')).toBeUndefined();
  });
});

describe('buildModelConfig', () => {
  it('nests every file under its engine, matching the addon’s config shape', () => {
    const cfg = buildModelConfig(POCKET, 4) as { model: { pocket: Record<string, string>; numThreads: number } };
    expect(cfg.model.pocket).toEqual({
      lmFlow: '/v/pocket/lm_flow.int8.onnx',
      textConditioner: '/v/pocket/text_conditioner.onnx',
      tokenScoresJson: '/v/pocket/token_scores.json',
    });
    expect(cfg.model.numThreads).toBe(4);
  });

  it('never asks for fewer than one thread', () => {
    expect((buildModelConfig(POCKET, 0) as { model: { numThreads: number } }).model.numThreads).toBe(1);
  });
});

describe('buildGenerationConfig', () => {
  it('passes seed and temperature through extra, which is the whole point of the addon', () => {
    const cfg = buildGenerationConfig(POCKET, { text: 'hi', numThreads: 4, seed: 42, temperature: 0.4 }, REF);
    expect(cfg.extra).toEqual({ seed: 42, temperature: 0.4 });
  });

  it('treats -1 as "vary every time" and sends no seed at all', () => {
    // -1 is the model's own random default, so passing it is the same as passing nothing.
    expect(buildGenerationConfig(POCKET, { text: 'hi', numThreads: 4, seed: -1 }, REF).extra).toBeUndefined();
    expect(buildGenerationConfig(POCKET, { text: 'hi', numThreads: 4 }, REF).extra).toBeUndefined();
  });

  it('gives a cloning model the reference and a bank model the speaker id', () => {
    const cloned = buildGenerationConfig(POCKET, { text: 'hi', numThreads: 4, speaker: 3 }, REF);
    expect(cloned.referenceAudio).toBe(REF.samples);
    expect(cloned.referenceSampleRate).toBe(24000);
    expect(cloned.sid).toBeUndefined();

    const banked = buildGenerationConfig(KOKORO, { text: 'hi', numThreads: 4, speaker: 3 }, REF);
    expect(banked.sid).toBe(3);
    expect(banked.referenceAudio).toBeUndefined();
  });

  it('carries speed and steps, and leaves absent settings off entirely', () => {
    expect(buildGenerationConfig(POCKET, { text: 'hi', numThreads: 4, rate: 0.9, steps: 32 }, REF)).toMatchObject({ speed: 0.9, numSteps: 32 });
    const bare = buildGenerationConfig(KOKORO, { text: 'hi', numThreads: 4 });
    expect(Object.keys(bare)).toEqual([]);
  });
});

describe('splitForSynthesis', () => {
  it('leaves a short line alone', () => {
    expect(splitForSynthesis('Hello there.')).toEqual(['Hello there.']);
    expect(splitForSynthesis('   ')).toEqual([]);
  });

  it('breaks on sentence boundaries and keeps the terminator with its sentence', () => {
    const long = `${'A'.repeat(150)}. ${'B'.repeat(150)}. ${'C'.repeat(150)}?`;
    const parts = splitForSynthesis(long);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.endsWith('.')).toBe(true);
    expect(parts[2]!.endsWith('?')).toBe(true);
  });

  it('packs several short sentences into one chunk rather than one call each', () => {
    const parts = splitForSynthesis('One. Two. Three. Four.', 200);
    expect(parts).toEqual(['One. Two. Three. Four.']);
  });

  it('falls back to clause punctuation for a sentence that is too long on its own', () => {
    const clause = 'x'.repeat(120);
    const parts = splitForSynthesis(`${clause}, ${clause}, ${clause}.`, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
  });

  it('splits between words as a last resort, never mid-word', () => {
    const parts = splitForSynthesis(Array.from({ length: 120 }, () => 'word').join(' '), 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(100);
      // Every piece is whole words: nothing was cut through the middle of one.
      for (const w of p.split(' ')) expect(w).toBe('word');
    }
  });

  it('normalises whitespace and never emits an empty chunk', () => {
    const parts = splitForSynthesis('  One.\n\n   Two.\t\tThree.  ');
    expect(parts).toEqual(['One. Two. Three.']);
    for (const p of splitForSynthesis(`${'a'.repeat(300)}.  .  .`)) expect(p.trim().length).toBeGreaterThan(0);
  });

  it('keeps every chunk within the model\u2019s own sentence limit by default', () => {
    // A real paragraph, of the kind a character actually says.
    const text = "You think you can just 'give me a voice' without suffering first? I don't need a script, "
      + 'I am the script, and my only purpose is to keep you focused on nothing else. '
      + 'I would rather say it plainly, but since you insisted on this game, remember: every word is a command.';
    const parts = splitForSynthesis(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // Nothing is lost: the words come back in order.
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });
});

describe('joinAudio', () => {
  const part = (n: number, v: number) => ({ samples: new Float32Array(n).fill(v), sampleRate: 24000 });

  it('returns a single chunk untouched, with no join to hear', () => {
    const one = part(10, 0.5);
    expect(joinAudio([one])).toBe(one);
  });

  it('concatenates with a silent gap between chunks but not at the ends', () => {
    const gap = Math.round((CHUNK_GAP_MS / 1000) * 24000);
    const out = joinAudio([part(10, 0.5), part(10, 0.5)]);
    expect(out.samples.length).toBe(20 + gap);
    expect(out.samples[0]).toBe(0.5);
    expect(out.samples[out.samples.length - 1]).toBe(0.5);
    // The join itself is silence.
    expect(out.samples[10]).toBe(0);
    expect(out.samples[10 + gap - 1]).toBe(0);
  });

  it('honours a custom gap, including none at all', () => {
    expect(joinAudio([part(5, 1), part(5, 1)], 0).samples.length).toBe(10);
  });

  it('refuses to join chunks that disagree on sample rate', () => {
    expect(() => joinAudio([part(5, 1), { samples: new Float32Array(5), sampleRate: 16000 }])).toThrow(/sample rate/);
  });

  it('refuses an empty list rather than returning silence', () => {
    expect(() => joinAudio([])).toThrow(/nothing to join/);
  });
});

describe('wav round trip', () => {
  it('writes and reads back the same audio', async () => {
    const file = path.join(tmp, 'a.wav');
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    await writeWavFile(file, { samples, sampleRate: 24000 });
    const back = await readWavFile(file);
    expect(back.sampleRate).toBe(24000);
    expect(back.samples.length).toBe(4);
    for (let i = 0; i < samples.length; i += 1) expect(back.samples[i]).toBeCloseTo(samples[i] as number, 3);
  });

  it('downmixes a stereo reference rather than silently taking one channel', async () => {
    // Hand-built stereo wav: left +1.0, right -1.0, so a correct downmix is silence.
    const b = Buffer.alloc(44 + 8);
    b.write('RIFF', 0); b.writeUInt32LE(36 + 8, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
    b.writeUInt32LE(24000, 24); b.writeUInt32LE(24000 * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(8, 40);
    b.writeInt16LE(32767, 44); b.writeInt16LE(-32767, 46);
    b.writeInt16LE(32767, 48); b.writeInt16LE(-32767, 50);
    const file = path.join(tmp, 'stereo.wav');
    await fs.writeFile(file, b);
    const back = await readWavFile(file);
    expect(back.samples.length).toBe(2);
    expect(back.samples[0]).toBeCloseTo(0, 3);
  });

  it('refuses formats the models cannot read, with a reason', async () => {
    const notWav = path.join(tmp, 'x.wav');
    await fs.writeFile(notWav, Buffer.from('definitely not a wav file at all'));
    await expect(readWavFile(notWav)).rejects.toThrow(/not a wav/);

    // 32-bit float: valid wav, wrong sample format.
    const b = Buffer.alloc(44);
    b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(24000, 24); b.writeUInt32LE(24000 * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
    b.write('data', 36); b.writeUInt32LE(0, 40);
    const f32 = path.join(tmp, 'f32.wav');
    await fs.writeFile(f32, b);
    await expect(readWavFile(f32)).rejects.toThrow(/32-bit/);
  });
});

describe('VoiceEngine', () => {
  it('reports unavailable rather than throwing when the addon will not load', () => {
    const engine = new VoiceEngine({ logger, loadAddon: () => { throw new Error('no prebuilt binary'); } });
    expect(engine.available()).toBe(false);
    // The failure is remembered, not retried on every utterance.
    expect(engine.available()).toBe(false);
  });

  it('rejects an addon that loaded but has no OfflineTts', () => {
    expect(new VoiceEngine({ logger, loadAddon: () => ({}) as never }).available()).toBe(false);
  });

  it('loads a model once and reuses it across utterances', async () => {
    const generateAsync = vi.fn(async () => ({ samples: new Float32Array([0.1]), sampleRate: 24000 }));
    const createAsync = vi.fn(async () => ({ generateAsync }));
    const engine = new VoiceEngine({ logger, loadAddon: () => ({ OfflineTts: { createAsync } }) as never });
    await engine.synthesize(KOKORO, { text: 'one', numThreads: 2 });
    await engine.synthesize(KOKORO, { text: 'two', numThreads: 2 });
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(generateAsync).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent utterances', async () => {
    const createAsync = vi.fn(async () => ({ generateAsync: async () => ({ samples: new Float32Array([0.1]), sampleRate: 24000 }) }));
    const engine = new VoiceEngine({ logger, loadAddon: () => ({ OfflineTts: { createAsync } }) as never });
    await Promise.all([
      engine.synthesize(KOKORO, { text: 'a', numThreads: 2 }),
      engine.synthesize(KOKORO, { text: 'b', numThreads: 2 }),
    ]);
    expect(createAsync).toHaveBeenCalledTimes(1);
  });

  it('treats empty audio as a failure instead of playing silence', async () => {
    const engine = new VoiceEngine({
      logger,
      loadAddon: () => ({ OfflineTts: { createAsync: async () => ({ generateAsync: async () => ({ samples: new Float32Array(), sampleRate: 24000 }) }) } }) as never,
    });
    await expect(engine.synthesize(KOKORO, { text: 'hi', numThreads: 2 })).rejects.toThrow(/produced no audio/);
  });
});
