/**
 * Fetching the default voice model. The engine cannot speak without weights, so the failure modes
 * here matter as much as the engine's: a half-unpacked model that `installed()` trusts would make
 * every `speak()` fail with a confusing sherpa error instead of downloading again.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_MODEL, VoiceModelInstaller, defaultModelSpec } from './voice-model-install.js';
import { detectVoiceModel } from './voice-models.js';

const logger = { warn: () => undefined, info: () => undefined, debug: () => undefined };
const tmpRoot = fs.mkdtemp(path.join(os.tmpdir(), 'rp-voice-model-'));
let tmp = '';

const spec = defaultModelSpec();

/** A response of exactly the published size, without allocating 98 MB in the test. */
const okResponse = (size = spec.bytes): Response =>
  ({ ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(size) }) as unknown as Response;

const WEIGHTS = ['lm_flow.int8.onnx', 'lm_main.int8.onnx', 'encoder.onnx', 'decoder.int8.onnx', 'text_conditioner.onnx', 'vocab.json', 'token_scores.json'];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(await tmpRoot, 'case-'));
});

afterAll(async () => {
  await fs.rm(await tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** A tar stand-in that lays down the files a real Pocket TTS archive unpacks to. */
function fakeTar(opts: { omit?: string; code?: number } = {}) {
  return vi.fn(async (_file: string, args: string[]) => {
    if (opts.code) return { code: opts.code, stdout: '', stderr: 'tar: broken archive' };
    const dest = args[args.indexOf('-C') + 1]!;
    await fs.mkdir(path.join(dest, 'test_wavs'), { recursive: true });
    for (const f of WEIGHTS) if (f !== opts.omit) await fs.writeFile(path.join(dest, f), 'weights');
    await fs.writeFile(path.join(dest, 'test_wavs', 'bria.wav'), 'RIFF');
    return { code: 0, stdout: '', stderr: '' };
  });
}

function installer(over: Partial<ConstructorParameters<typeof VoiceModelInstaller>[0]> = {}) {
  return new VoiceModelInstaller({
    voicesDir: tmp,
    logger,
    platform: 'linux',
    fetchImpl: vi.fn().mockResolvedValue(okResponse()) as unknown as typeof fetch,
    spawn: fakeTar(),
    ...over,
  });
}

describe('defaultModelSpec', () => {
  it('points at the quantised Pocket TTS build in the tts-models release', () => {
    expect(spec.url).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${DEFAULT_VOICE_MODEL.file}`);
    // int8: half the size of the float build, and the point of running on the CPU at all.
    expect(spec.file).toContain('int8');
    expect(spec.file).toContain('pocket');
    expect(spec.bytes).toBeGreaterThan(1_000_000);
  });

  it('unpacks to a directory name that detection reads back as a cloning Pocket model', () => {
    // The whole feature hangs on this: a name or layout change upstream must not silently produce a
    // model the app installs but then cannot recognise.
    const model = detectVoiceModel(`/voices/${DEFAULT_VOICE_MODEL.name}`, { files: WEIGHTS, dirs: ['test_wavs'], samples: ['bria.wav'] });
    expect(model?.engine).toBe('pocket');
    expect(model?.clones).toBe(true);
    expect(model?.name).toBe(DEFAULT_VOICE_MODEL.name);
  });
});

describe('ensure', () => {
  it('downloads and unpacks into the voices folder under the model’s own name', async () => {
    const inst = installer();
    const dir = await inst.ensure();
    expect(dir).toBe(path.join(tmp, DEFAULT_VOICE_MODEL.name));
    expect(inst.status()).toMatchObject({ state: 'ready', version: DEFAULT_VOICE_MODEL.name });
    for (const f of WEIGHTS) await expect(fs.stat(path.join(dir!, f))).resolves.toBeTruthy();
    // The sample clip comes too: it is the fallback reference for a character with no clip.
    await expect(fs.stat(path.join(dir!, 'test_wavs', 'bria.wav'))).resolves.toBeTruthy();
  });

  it('drops the wrapper directory rather than nesting it', async () => {
    await installer().ensure();
    // Not voices/<name>/<name>/lm_flow…
    await expect(fs.stat(path.join(tmp, DEFAULT_VOICE_MODEL.name, DEFAULT_VOICE_MODEL.name))).rejects.toThrow();
  });

  it('is idempotent and single-flight', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const inst = installer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([inst.ensure(), inst.ensure()]);
    await inst.ensure();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an archive that is not the size upstream published', async () => {
    const inst = installer({ fetchImpl: vi.fn().mockResolvedValue(okResponse(4096)) as unknown as typeof fetch });
    expect(await inst.ensure()).toBeUndefined();
    expect(inst.status()).toMatchObject({ state: 'failed' });
    expect(inst.status().error).toContain('expected');
  });

  it('never throws, because it runs at startup', async () => {
    const inst = installer({ fetchImpl: vi.fn().mockRejectedValue(new Error('no network')) as unknown as typeof fetch });
    await expect(inst.ensure()).resolves.toBeUndefined();
    expect(inst.status()).toMatchObject({ state: 'failed', error: 'no network' });
  });

  it('refuses a model missing a weight file instead of installing something unusable', async () => {
    const inst = installer({ spawn: fakeTar({ omit: 'vocab.json' }) });
    expect(await inst.ensure()).toBeUndefined();
    expect(inst.status().error).toContain('vocab.json');
    // Nothing is left where installed() would find it next start.
    await expect(fs.stat(path.join(tmp, DEFAULT_VOICE_MODEL.name))).rejects.toThrow();
  });

  it('leaves no staging directory behind when tar fails', async () => {
    const inst = installer({ spawn: fakeTar({ code: 2 }) });
    expect(await inst.ensure()).toBeUndefined();
    await expect(fs.stat(`${path.join(tmp, DEFAULT_VOICE_MODEL.name)}.incoming`)).rejects.toThrow();
  });

  it('reports a model already on disk without downloading', async () => {
    const dir = path.join(tmp, DEFAULT_VOICE_MODEL.name);
    await fs.mkdir(dir, { recursive: true });
    for (const f of WEIGHTS) await fs.writeFile(path.join(dir, f), 'weights');
    const fetchImpl = vi.fn();
    const inst = installer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await inst.ensure()).toBe(dir);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a truncated install as absent, so a failed run is retried next start', async () => {
    const dir = path.join(tmp, DEFAULT_VOICE_MODEL.name);
    await fs.mkdir(dir, { recursive: true });
    for (const f of WEIGHTS.slice(0, 3)) await fs.writeFile(path.join(dir, f), 'weights');
    expect(await installer().installed()).toBeUndefined();
  });

  it('treats a zero-byte weight as absent too', async () => {
    const dir = path.join(tmp, DEFAULT_VOICE_MODEL.name);
    await fs.mkdir(dir, { recursive: true });
    for (const f of WEIGHTS) await fs.writeFile(path.join(dir, f), f === 'encoder.onnx' ? '' : 'weights');
    expect(await installer().installed()).toBeUndefined();
  });
});

describe('status', () => {
  it('records a model the user installed themselves as present', () => {
    const inst = installer();
    inst.markPresent('my-own-pocket-model');
    expect(inst.status()).toMatchObject({ state: 'present', version: 'my-own-pocket-model' });
    inst.markDisabled();
    expect(inst.status().state).toBe('present');
  });

  it('records the download being switched off', () => {
    const inst = installer();
    inst.markDisabled();
    expect(inst.status().state).toBe('disabled');
  });
});
