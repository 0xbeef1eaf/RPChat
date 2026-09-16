/**
 * The voice bank: turning the Hugging Face listing into a catalogue, paging through it, and
 * downloading recordings safely. Nothing here touches the network — `fetchImpl` is injected.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_PREVIEW_SENTENCE } from '@rp/shared';
import { VoiceBank, buildCatalogue, describeMissingEngine, describeMissingModel, nextLink, previewId } from './voice-bank.js';
import type { VoiceModel } from './voice-models.js';

const logger = { warn: () => undefined, info: () => undefined, debug: () => undefined };
const tmpRoot = fs.mkdtemp(path.join(os.tmpdir(), 'rp-voice-bank-'));
let tmp = '';

const POCKET: VoiceModel = {
  name: 'pocket', dir: '/v/pocket', engine: 'pocket', label: 'Pocket TTS', clones: true,
  files: { 'pocket-lm-flow': '/v/pocket/lm_flow.int8.onnx' }, sampleReference: '/v/pocket/test_wavs/bria.wav',
};
const KOKORO: VoiceModel = { name: 'kokoro', dir: '/v/kokoro', engine: 'kokoro', label: 'Kokoro', clones: false, files: {} };

/** A 64-byte RIFF blob: enough to pass the wav sniff in `download`. */
const wav = (): Buffer => Buffer.concat([Buffer.from('RIFF....WAVEfmt ', 'ascii'), Buffer.alloc(64)]);

const okResponse = (body: Buffer | unknown, headers: Record<string, string> = {}): Response =>
  ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
  }) as unknown as Response;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(await tmpRoot, 'case-'));
});

afterAll(async () => {
  await fs.rm(await tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function bank(overrides: Partial<ConstructorParameters<typeof VoiceBank>[0]> = {}): VoiceBank {
  return new VoiceBank({
    dir: tmp,
    logger,
    models: async () => [POCKET],
    findSherpa: () => '/bin/sherpa',
    numThreads: async () => 2,
    ...overrides,
  });
}

describe('nextLink', () => {
  it('finds the rel=next cursor and ignores the other relations', () => {
    expect(nextLink('<https://h/a?cursor=abc>; rel="next"')).toBe('https://h/a?cursor=abc');
    expect(nextLink('<https://h/prev>; rel="prev", <https://h/next>; rel="next"')).toBe('https://h/next');
    expect(nextLink('<https://h/prev>; rel="prev"')).toBeUndefined();
    expect(nextLink(null)).toBeUndefined();
  });
});

describe('buildCatalogue', () => {
  const entries = [
    { type: 'file', path: 'vctk/p329_022.wav', size: 100 },
    { type: 'file', path: 'expresso/ex03_narration_001_channel1_674s.wav', size: 200 },
    { type: 'file', path: 'cml-tts/fr/speaker_enhanced.wav', size: 300 },
    { type: 'file', path: 'voice-donations/README.md', size: 10 },
    { type: 'file', path: 'vctk/p329_022.safetensors', size: 50 },
    { type: 'directory', path: 'vctk' },
  ];

  it('keeps only wavs, so the TTS-1.6B embeddings and docs do not show up as voices', () => {
    const { voices } = buildCatalogue(entries);
    expect(voices.map((v) => v.path)).toEqual([
      'cml-tts/fr/speaker_enhanced.wav',
      'expresso/ex03_narration_001_channel1_674s.wav',
      'vctk/p329_022.wav',
    ]);
  });

  it('groups by the first path segment, so cml-tts/fr belongs to cml-tts', () => {
    const { collections, voices } = buildCatalogue(entries);
    expect(voices.find((v) => v.path.startsWith('cml-tts'))?.collection).toBe('cml-tts');
    expect(collections.map((c) => c.id).sort()).toEqual(['cml-tts', 'expresso', 'vctk']);
    expect(collections.find((c) => c.id === 'cml-tts')?.count).toBe(1);
  });

  it('carries the licence of each collection and flags the non-commercial ones', () => {
    const { collections } = buildCatalogue(entries);
    expect(collections.find((c) => c.id === 'expresso')).toMatchObject({ license: 'CC-BY-NC-4.0', nonCommercial: true });
    expect(collections.find((c) => c.id === 'vctk')).toMatchObject({ license: 'CC-BY-4.0', nonCommercial: false });
  });

  it('treats a collection the README does not describe as unknown and non-commercial, not as missing', () => {
    const { collections } = buildCatalogue([{ type: 'file', path: 'brand-new/x.wav', size: 1 }]);
    expect(collections[0]).toMatchObject({ id: 'brand-new', license: 'unknown', nonCommercial: true });
  });

  it('marks the ai-coustics cleaned variants', () => {
    const { voices } = buildCatalogue(entries);
    expect(voices.find((v) => v.path.endsWith('speaker_enhanced.wav'))?.enhanced).toBe(true);
    expect(voices.find((v) => v.path.endsWith('p329_022.wav'))?.enhanced).toBe(false);
  });
});

describe('catalogue', () => {
  it('follows the Link cursor to the end of the listing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse([{ type: 'file', path: 'vctk/a.wav', size: 1 }], { link: '<https://h/page2>; rel="next"' }))
      .mockResolvedValueOnce(okResponse([{ type: 'file', path: 'vctk/b.wav', size: 1 }]));
    const catalogue = await bank({ fetchImpl: fetchImpl as unknown as typeof fetch }).catalogue();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(catalogue.voices).toHaveLength(2);
  });

  it('falls back to the cached listing when the repo cannot be reached', async () => {
    const good = bank({ fetchImpl: vi.fn().mockResolvedValue(okResponse([{ type: 'file', path: 'vctk/a.wav', size: 1 }])) as unknown as typeof fetch });
    await good.catalogue();
    // A fresh instance reads the file the first one wrote, then survives the network being down.
    const offline = bank({ fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch });
    const catalogue = await offline.catalogue({ refresh: true });
    expect(catalogue.voices.map((v) => v.path)).toEqual(['vctk/a.wav']);
  });

  it('explains why previews are unavailable rather than showing dead play buttons', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ type: 'file', path: 'vctk/a.wav', size: 1 }])) as unknown as typeof fetch;
    // No cloning model installed.
    expect((await bank({ fetchImpl, models: async () => [KOKORO] }).catalogue()).previewsUnavailable).toContain('No cloning voice model');
    // Model present, binary missing.
    expect((await bank({ fetchImpl, findSherpa: () => undefined }).catalogue()).previewsUnavailable).toContain('sherpa-onnx-offline-tts');
    // Both present: previews work, so no explanation.
    expect((await bank({ fetchImpl }).catalogue()).previewsUnavailable).toBeUndefined();
  });

  it('lists the installed models for the editor’s model picker', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([])) as unknown as typeof fetch;
    const catalogue = await bank({ fetchImpl, models: async () => [POCKET, KOKORO] }).catalogue();
    expect(catalogue.models).toEqual([
      { name: 'pocket', label: 'Pocket TTS', engine: 'pocket', clones: true },
      { name: 'kokoro', label: 'Kokoro', engine: 'kokoro', clones: false },
    ]);
  });
});

describe('describeMissingEngine', () => {
  it('reads as "wait", not "you did something wrong", while the engine is being fetched', () => {
    expect(describeMissingEngine({ state: 'downloading', version: 'v1', received: 14_000_000, total: 28_000_000 })).toContain('50%');
    expect(describeMissingEngine({ state: 'extracting', version: 'v1' })).toContain('Unpacking');
  });

  it('says what to do instead when the engine cannot be fetched at all', () => {
    expect(describeMissingEngine({ state: 'failed', version: 'v1', error: 'no network' })).toContain('no network');
    expect(describeMissingEngine({ state: 'unsupported', version: 'v1' })).toContain('RP_SHERPA_TTS');
    expect(describeMissingEngine({ state: 'disabled', version: 'v1' })).toContain('Settings');
    expect(describeMissingEngine(undefined)).toContain('was not found');
  });

  it('does not divide by zero before the total is known', () => {
    expect(describeMissingEngine({ state: 'downloading', version: 'v1' })).toContain('0%');
  });
});

describe('describeMissingModel', () => {
  it('reads as progress while the default model is being fetched', () => {
    expect(describeMissingModel({ state: 'downloading', version: 'pocket', received: 25_000_000, total: 100_000_000 })).toContain('25%');
    expect(describeMissingModel({ state: 'extracting', version: 'pocket' })).toContain('Unpacking');
  });

  it('falls back to telling the author what to do themselves', () => {
    expect(describeMissingModel({ state: 'failed', version: 'pocket', error: 'disk full' })).toContain('disk full');
    expect(describeMissingModel({ state: 'disabled', version: 'pocket' })).toContain('Settings');
    expect(describeMissingModel(undefined)).toContain('No cloning voice model is installed');
  });
});

describe('catalogue engine status', () => {
  it('carries the engine state so the picker can show a download in progress', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ type: 'file', path: 'vctk/a.wav', size: 1 }])) as unknown as typeof fetch;
    const c = await bank({
      fetchImpl,
      findSherpa: () => undefined,
      engineStatus: () => ({ state: 'downloading' as const, version: 'v1.13.8', received: 7_000_000, total: 28_000_000 }),
    }).catalogue();
    expect(c.engine).toMatchObject({ state: 'downloading' });
    expect(c.previewsUnavailable).toContain('25%');
  });

  it('reports the model download ahead of the engine, since without weights nothing can speak', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ type: 'file', path: 'vctk/a.wav', size: 1 }])) as unknown as typeof fetch;
    const c = await bank({
      fetchImpl,
      models: async () => [],
      findSherpa: () => undefined,
      modelStatus: () => ({ state: 'downloading' as const, version: 'pocket', received: 50_000_000, total: 100_000_000 }),
    }).catalogue();
    expect(c.model).toMatchObject({ state: 'downloading' });
    expect(c.previewsUnavailable).toContain('Pocket TTS voice model (50%)');
  });
});

describe('ensureVoice', () => {
  it('downloads once and reuses the file afterwards', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(wav()));
    const b = bank({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const first = await b.ensureVoice('vctk/p329_022.wav');
    expect(first).toBe(path.join(tmp, 'files', 'vctk', 'p329_022.wav'));
    await b.ensureVoice('vctk/p329_022.wav');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one download between concurrent callers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(wav()));
    const b = bank({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([b.ensureVoice('vctk/a.wav'), b.ensureVoice('vctk/a.wav'), b.ensureVoice('vctk/a.wav')]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a response that is not a wav, so an error page is never cached as a voice', async () => {
    const html = Buffer.from('<html>not found</html>');
    const b = bank({ fetchImpl: vi.fn().mockResolvedValue(okResponse(html)) as unknown as typeof fetch });
    await expect(b.ensureVoice('vctk/a.wav')).rejects.toThrow(/did not come back as a wav/);
    // Nothing half-written is left behind for the next call to trust.
    await expect(fs.stat(path.join(tmp, 'files', 'vctk', 'a.wav'))).rejects.toThrow();
  });

  it('refuses a path that would escape the bank directory', async () => {
    const b = bank({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(b.ensureVoice('../../etc/passwd')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });
});

describe('ensurePreview', () => {
  it('synthesises the shared sample sentence once, then serves it from cache', async () => {
    const spawn = vi.fn(async (_f: string, args: string[]) => {
      const out = args.find((a) => a.startsWith('--output-filename='))!.slice('--output-filename='.length);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, wav());
      return { code: 0, stdout: '', stderr: '' };
    });
    const b = bank({ fetchImpl: vi.fn().mockResolvedValue(okResponse(wav())) as unknown as typeof fetch, spawn });
    const rel = await b.ensurePreview('vctk/a.wav');
    expect(rel).toBe(`pocket/${previewId('vctk/a.wav', VOICE_PREVIEW_SENTENCE)}.wav`);
    expect(spawn.mock.calls[0]?.[1]).toContain(VOICE_PREVIEW_SENTENCE);
    // The reference passed to sherpa is the downloaded clip, not the model's own sample.
    expect(spawn.mock.calls[0]?.[1]).toContain(`--reference-audio=${path.join(tmp, 'files', 'vctk', 'a.wav')}`);
    await b.ensurePreview('vctk/a.wav');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports a failed synthesis instead of caching a broken file', async () => {
    const spawn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'bad model' }));
    const b = bank({ fetchImpl: vi.fn().mockResolvedValue(okResponse(wav())) as unknown as typeof fetch, spawn });
    await expect(b.ensurePreview('vctk/a.wav')).rejects.toThrow(/bad model/);
  });

  it('refuses when no cloning model is installed', async () => {
    const b = bank({ models: async () => [KOKORO] });
    await expect(b.ensurePreview('vctk/a.wav')).rejects.toThrow(/No cloning voice model/);
  });
});
