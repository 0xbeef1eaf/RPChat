/**
 * Fetching the Qwen weights.
 *
 * The things worth pinning are all about a 2.5 GB download going wrong halfway: a part-finished
 * tree must never look like an installed model, a retry must not start from zero, and a file that
 * comes back the wrong size must fail rather than be handed to the engine.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QWEN_MODEL, QWEN_MODEL_FILES, QwenModelInstaller, qwenFileUrl, qwenModelBytes } from './qwen-install.js';

const FILES = [
  { path: 'config.json', bytes: 4 },
  { path: 'model.safetensors', bytes: 16 },
  { path: 'speech_tokenizer/config.json', bytes: 8 },
] as const;

const silent = { warn: () => {}, info: () => {}, debug: () => {} };

/** A fetch that serves `bytes` of filler for any file, counting what it was asked for. */
const server = (sizeFor: (file: string) => number) => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const name = String(url).split('/resolve/main/')[1] ?? '';
    asked.push(name);
    return new Response(new Uint8Array(sizeFor(name)), { status: 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
};

const sizeOf = (file: string): number => FILES.find((f) => f.path === file)?.bytes ?? 0;

describe('QwenModelInstaller', () => {
  let voicesDir = '';

  beforeEach(async () => {
    voicesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-install-'));
  });
  afterEach(async () => {
    await fs.rm(voicesDir, { recursive: true, force: true });
  });

  const make = (fetchImpl: typeof fetch) => new QwenModelInstaller({ voicesDir, logger: silent, fetchImpl, files: FILES });

  it('fetches every file and reports ready', async () => {
    const { asked, fetchImpl } = server(sizeOf);
    const installer = make(fetchImpl);
    const dir = await installer.ensure();
    expect(dir).toBe(path.join(voicesDir, QWEN_MODEL.name));
    expect(asked.sort()).toEqual(FILES.map((f) => f.path).sort());
    expect(installer.status()).toMatchObject({ state: 'ready' });
    // Including the nested one, which the model will not load without.
    expect((await fs.stat(path.join(dir!, 'speech_tokenizer/config.json'))).size).toBe(8);
  });

  it('does nothing the second time', async () => {
    const first = server(sizeOf);
    await make(first.fetchImpl).ensure();
    const second = server(sizeOf);
    await make(second.fetchImpl).ensure();
    expect(second.asked).toEqual([]);
  });

  it('never leaves a part-finished download where the scanner would find it', async () => {
    // The middle file comes back short, so the install must fail with nothing in place.
    const { fetchImpl } = server((f) => (f === 'model.safetensors' ? 3 : sizeOf(f)));
    const installer = make(fetchImpl);
    expect(await installer.ensure()).toBeUndefined();
    expect(installer.status().state).toBe('failed');
    await expect(fs.stat(path.join(voicesDir, QWEN_MODEL.name))).rejects.toThrow();
    expect(await installer.installed()).toBeUndefined();
  });

  it('resumes rather than re-fetching what already arrived', async () => {
    const bad = server((f) => (f === 'speech_tokenizer/config.json' ? 1 : sizeOf(f)));
    await make(bad.fetchImpl).ensure();

    // The two good files survive in staging, so only the failed one is asked for again.
    const retry = server(sizeOf);
    const installer = make(retry.fetchImpl);
    expect(await installer.ensure()).toBeDefined();
    expect(retry.asked).toEqual(['speech_tokenizer/config.json']);
    expect(installer.status()).toMatchObject({ state: 'ready' });
  });

  it('treats a file of the wrong size on disk as absent', async () => {
    const { fetchImpl } = server(sizeOf);
    const installer = make(fetchImpl);
    await installer.ensure();
    const dir = installer.modelDir();
    await fs.writeFile(path.join(dir, 'config.json'), 'truncated-but-wrong-length');
    expect(await installer.installed()).toBeUndefined();
  });

  it('sees a model an earlier run left behind, without being asked to fetch it', async () => {
    const first = server(sizeOf);
    await make(first.fetchImpl).ensure();

    // A fresh installer, as after a restart: nothing has called ensure(), so its in-memory status
    // is 'absent' and only a look at the disk can tell the truth.
    const fresh = make(server(sizeOf).fetchImpl);
    expect(fresh.status().state).toBe('absent');
    expect((await fresh.currentStatus()).state).toBe('ready');
  });

  it('reports a download as under way before any file is touched', () => {
    const installer = make(server(sizeOf).fetchImpl);
    expect(installer.status().state).toBe('absent');
    installer.begin();
    // Synchronous on purpose: the caller returns to the UI long before ensure() can say anything.
    expect(installer.status()).toMatchObject({ state: 'downloading', received: 0 });
  });

  it('does not re-open a finished install by marking it started', async () => {
    const installer = make(server(sizeOf).fetchImpl);
    await installer.ensure();
    installer.begin();
    expect(installer.status().state).toBe('ready');
  });

  it('shares one download between concurrent callers', async () => {
    const { asked, fetchImpl } = server(sizeOf);
    const installer = make(fetchImpl);
    const [a, b] = await Promise.all([installer.ensure(), installer.ensure()]);
    expect(a).toBe(b);
    expect(asked).toHaveLength(FILES.length);
  });
});

describe('the real manifest', () => {
  it('names the files the engine loads, weights included', () => {
    const paths = QWEN_MODEL_FILES.map((f) => f.path);
    // voice-models.ts detects the engine from exactly these three.
    expect(paths).toContain('config.json');
    expect(paths).toContain('model.safetensors');
    expect(paths).toContain('speech_tokenizer/model.safetensors');
  });

  it('is the ~2.5 GB the panel warns about', () => {
    expect(qwenModelBytes()).toBeGreaterThan(2.4e9);
    expect(qwenModelBytes()).toBeLessThan(2.6e9);
  });

  it('builds a Hugging Face url, nested paths included', () => {
    expect(qwenFileUrl('model.safetensors')).toBe('https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice/resolve/main/model.safetensors');
    expect(qwenFileUrl('speech_tokenizer/config.json')).toContain('/resolve/main/speech_tokenizer/config.json');
  });

  it('pins a size for every file, since there are no checksums to fall back on', () => {
    for (const f of QWEN_MODEL_FILES) expect(f.bytes).toBeGreaterThan(0);
  });
});
