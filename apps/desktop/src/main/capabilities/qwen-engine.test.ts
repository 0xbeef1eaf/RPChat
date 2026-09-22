/**
 * The Qwen3-TTS command line, and the two guards around it.
 *
 * The flag spellings are the ones `qwen_tts --help` prints; a rename upstream should break these
 * rather than produce a process that exits non-zero when a character tries to speak. The collapse
 * check matters just as much: that failure is silent — the binary exits 0 and writes a valid wav
 * that simply stops early — so nothing else would catch it.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceModel } from './voice-models.js';
import { writeWavFile } from './voice-engine.js';
import type { QwenRunnerDeps } from './qwen-engine.js';
import {
  QVOICE_MAGIC,
  QWEN_DEFAULTS,
  QwenRunner,
  buildQwenArgs,
  collapsed,
  expectedSeconds,
  qwenProfileFor,
  readQvoiceVersion,
  retrySeed,
} from './qwen-engine.js';

const MODEL: VoiceModel = {
  name: 'qwen3-tts-0.6b',
  dir: '/v/qwen3-tts-0.6b',
  engine: 'qwen',
  label: 'Qwen3-TTS',
  clones: true,
  files: { 'qwen-config': '/v/qwen3-tts-0.6b/config.json' },
};

/** `['-T', '2.5']` → `{ '-T': '2.5' }`, so assertions do not depend on flag order. */
const flags = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-') && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) {
      out[a] = args[++i]!;
    } else if (a.startsWith('-')) {
      out[a] = '';
    }
  }
  return out;
};

describe('buildQwenArgs', () => {
  it('passes the model directory, not the individual weight files', () => {
    const f = flags(buildQwenArgs(MODEL, { text: 'Hello.', outFile: '/tmp/a.wav' }));
    expect(f['-d']).toBe('/v/qwen3-tts-0.6b');
    expect(f['-o']).toBe('/tmp/a.wav');
    expect(f['--text']).toBe('Hello.');
  });

  it('applies the tuned sampling defaults when the character sets none', () => {
    const f = flags(buildQwenArgs(MODEL, { text: 'Hello.', outFile: '/tmp/a.wav' }));
    expect(f['-T']).toBe(String(QWEN_DEFAULTS.temperature));
    expect(f['-k']).toBe(String(QWEN_DEFAULTS.topK));
    expect(f['-p']).toBe(String(QWEN_DEFAULTS.topP));
    expect(f['-r']).toBe(String(QWEN_DEFAULTS.repPenalty));
  });

  it('lets a character override the temperature', () => {
    const f = flags(buildQwenArgs(MODEL, { text: 'Hello.', outFile: '/tmp/a.wav', temperature: 1.2 }));
    expect(f['-T']).toBe('1.2');
  });

  it('loads a profile as a graft rather than the lighter x-vector path', () => {
    const args = buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/tmp/a.wav', profile: '/v/nyx.qvoice' });
    expect(flags(args)['--load-voice']).toBe('/v/nyx.qvoice');
    expect(args).toContain('--icl-only');
  });

  it('leaves the voice flags off entirely without a profile, so the built-in speakers are used', () => {
    const args = buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/tmp/a.wav' });
    expect(args).not.toContain('--load-voice');
    expect(args).not.toContain('--icl-only');
  });

  it('passes a seed only when one is pinned', () => {
    expect(flags(buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/o', seed: 99 }))['--seed']).toBe('99');
    // -1 is the documented "vary every time", and the binary's own default is time-based.
    expect(buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/o', seed: -1 })).not.toContain('--seed');
    expect(buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/o' })).not.toContain('--seed');
  });

  it('keeps the text as its own token, so dialogue needs no escaping', () => {
    const text = 'She said "no" — then left.\nDidn\'t she?';
    const args = buildQwenArgs(MODEL, { text, outFile: '/tmp/a.wav' });
    expect(args[args.length - 1]).toBe(text);
    expect(args[args.length - 2]).toBe('--text');
  });

  it('quantises on load, which is how it fits in memory at all', () => {
    expect(buildQwenArgs(MODEL, { text: 'Hi.', outFile: '/o' })).toContain('--int8');
  });
});

describe('qwenProfileFor', () => {
  it('takes a .qvoice profile', () => {
    expect(qwenProfileFor('/packs/nyx/voice.qvoice')).toBe('/packs/nyx/voice.qvoice');
    expect(qwenProfileFor('/packs/nyx/VOICE.QVOICE')).toBe('/packs/nyx/VOICE.QVOICE');
  });

  it('ignores a wav, which this model cannot clone from directly', () => {
    expect(qwenProfileFor('/packs/nyx/reference.wav')).toBeUndefined();
    expect(qwenProfileFor(undefined)).toBeUndefined();
  });
});

describe('collapsed', () => {
  const line = 'Oh, there you are. I was starting to think you had lost your nerve.';

  it('accepts a take of a plausible length', () => {
    expect(collapsed(line, expectedSeconds(line))).toBe(false);
    // Slower or faster than the estimate is still a real read.
    expect(collapsed(line, expectedSeconds(line) * 0.7)).toBe(false);
    expect(collapsed(line, expectedSeconds(line) * 2)).toBe(false);
  });

  it('catches the take that stops after a syllable', () => {
    expect(collapsed(line, 1.3)).toBe(true);
    expect(collapsed(line, 0)).toBe(true);
  });

  it('says nothing about empty text, which has no expected length', () => {
    expect(collapsed('', 0)).toBe(false);
    expect(collapsed('   ', 0)).toBe(false);
  });
});

describe('retrySeed', () => {
  it('moves off the seed that just collapsed', () => {
    expect(retrySeed(99)).not.toBe(99);
  });

  it('stays inside the range the binary accepts', () => {
    expect(retrySeed(2147483000)).toBeGreaterThanOrEqual(0);
    expect(retrySeed(2147483000)).toBeLessThan(2147483647);
  });
});

describe('QwenRunner', () => {
  const LINE = 'Oh, there you are. I was starting to think you had lost your nerve.';
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-runner-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A spawn that writes `secondsFor(callIndex)` of silence, standing in for the binary. */
  const fakeBinary = (secondsFor: (call: number) => number) => {
    const calls: string[][] = [];
    const spawn = async (_file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const out = args[args.indexOf('-o') + 1]!;
      const seconds = secondsFor(calls.length);
      calls.push(args);
      await writeWavFile(out, { samples: new Float32Array(Math.round(24000 * seconds)), sampleRate: 24000 });
      return { code: 0, stdout: '', stderr: '' };
    };
    return { calls, spawn };
  };

  const runnerWith = (spawn: QwenRunnerDeps['spawn']) =>
    new QwenRunner({ findBinary: () => '/opt/qwen_tts', spawn, timeoutMs: 1000, logger: { warn: () => {}, debug: () => {} } });

  it('renders once when the take is a plausible length', async () => {
    const { calls, spawn } = fakeBinary(() => expectedSeconds(LINE));
    const runner = runnerWith(spawn);
    const seconds = await runner.render(MODEL, { text: LINE, outFile: path.join(dir, 'a.wav'), seed: 99 });
    expect(calls).toHaveLength(1);
    expect(seconds).toBeCloseTo(expectedSeconds(LINE), 1);
  });

  it('re-rolls a collapsed take onto a different seed', async () => {
    // First call collapses, second is fine — exactly the failure seen on real renders.
    const { calls, spawn } = fakeBinary((call) => (call === 0 ? 0.4 : expectedSeconds(LINE)));
    const runner = runnerWith(spawn);
    const seconds = await runner.render(MODEL, { text: LINE, outFile: path.join(dir, 'a.wav'), seed: 99 });
    expect(calls).toHaveLength(2);
    const seeds = calls.map((a) => a[a.indexOf('--seed') + 1]);
    expect(seeds[0]).toBe('99');
    expect(seeds[1]).toBe(String(retrySeed(99)));
    expect(seconds).toBeCloseTo(expectedSeconds(LINE), 1);
  });

  it('gives up after one retry rather than looping on a model that will not speak', async () => {
    const { calls, spawn } = fakeBinary(() => 0.3);
    const runner = runnerWith(spawn);
    await runner.render(MODEL, { text: LINE, outFile: path.join(dir, 'a.wav'), seed: 7 });
    expect(calls).toHaveLength(2);
  });

  it('retries an unseeded take too, where the binary reseeds itself', async () => {
    const { calls, spawn } = fakeBinary((call) => (call === 0 ? 0.4 : expectedSeconds(LINE)));
    const runner = runnerWith(spawn);
    await runner.render(MODEL, { text: LINE, outFile: path.join(dir, 'a.wav') });
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args).not.toContain('--seed');
  });

  it('reports a non-zero exit with the binary’s own message, and leaves no half-written wav', async () => {
    const file = path.join(dir, 'a.wav');
    const runner = runnerWith(async () => ({ code: 1, stdout: '', stderr: 'could not load voice profile' }));
    await expect(runner.render(MODEL, { text: LINE, outFile: file })).rejects.toThrow(/could not load voice profile/);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('says so when there is no binary at all, rather than spawning nothing', async () => {
    const runner = new QwenRunner({
      findBinary: () => undefined,
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      timeoutMs: 1000,
      logger: { warn: () => {}, debug: () => {} },
    });
    expect(runner.available()).toBe(false);
    await expect(runner.render(MODEL, { text: LINE, outFile: path.join(dir, 'a.wav') })).rejects.toThrow(/qwen_tts/);
  });
});

describe('readQvoiceVersion', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qvoice-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A profile is magic + a little-endian version; the rest is opaque weights. */
  const write = async (name: string, head: Buffer): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, Buffer.concat([head, Buffer.alloc(64)]));
    return file;
  };

  const header = (magic: string, version: number): Buffer => {
    const b = Buffer.alloc(8);
    b.write(magic, 0, 'ascii');
    b.writeUInt32LE(version, 4);
    return b;
  };

  it('reads the version out of a profile', async () => {
    expect(await readQvoiceVersion(await write('a.qvoice', header(QVOICE_MAGIC, 3)))).toBe(3);
    // A newer profile still parses; it is the caller that decides what it can load.
    expect(await readQvoiceVersion(await write('b.qvoice', header(QVOICE_MAGIC, 9)))).toBe(9);
  });

  it('rejects anything that is not one', async () => {
    expect(await readQvoiceVersion(await write('c.qvoice', header('RIFF', 3)))).toBeUndefined();
    // Too short to hold a header at all.
    const stub = path.join(dir, 'd.qvoice');
    await fs.writeFile(stub, 'QV');
    expect(await readQvoiceVersion(stub)).toBeUndefined();
    expect(await readQvoiceVersion(path.join(dir, 'missing.qvoice'))).toBeUndefined();
  });
});
