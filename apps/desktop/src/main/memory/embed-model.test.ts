/**
 * Fetching the on-device embedding model.
 *
 * The installer itself is `hf-install.ts`, tested through the Qwen model; what is checked here is
 * this model's own wiring — that the files land where `LocalEmbedder` looks for them, nested path
 * and all, and that nothing is fetched until someone asks.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_MODEL, EmbedModelInstaller } from './embed-model.js';

const FILES = [
  { path: 'onnx/model_quantized.onnx', bytes: 12 },
  { path: 'vocab.txt', bytes: 4 },
] as const;

const silent = { warn: () => {}, info: () => {}, debug: () => {} };

/** A fetch that serves filler of the right size for any of the model's files. */
function server() {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const name = String(url).split(`/resolve/${EMBED_MODEL.revision}/`)[1] ?? '';
    asked.push(name);
    const bytes = FILES.find((f) => f.path === name)?.bytes ?? 0;
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe('EmbedModelInstaller', () => {
  let modelsDir = '';

  beforeEach(async () => {
    modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'embed-install-'));
  });

  afterEach(async () => {
    await fs.rm(modelsDir, { recursive: true, force: true });
  });

  it('reports nothing installed until it is asked to fetch', async () => {
    const { asked, fetchImpl } = server();
    const installer = new EmbedModelInstaller({ modelsDir, logger: silent, fetchImpl, files: [...FILES] });
    expect(installer.status()).toMatchObject({ state: 'absent', version: EMBED_MODEL.name });
    expect(await installer.installed()).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('lands the files where the embedder looks for them', async () => {
    const { asked, fetchImpl } = server();
    const installer = new EmbedModelInstaller({ modelsDir, logger: silent, fetchImpl, files: [...FILES] });
    const dir = await installer.ensure();
    expect(dir).toBe(path.join(modelsDir, EMBED_MODEL.name));
    expect(asked).toEqual(['onnx/model_quantized.onnx', 'vocab.txt']);
    expect((await fs.stat(path.join(dir as string, 'onnx', 'model_quantized.onnx'))).size).toBe(12);
    expect((await fs.stat(path.join(dir as string, 'vocab.txt'))).size).toBe(4);
    expect(await installer.currentStatus()).toMatchObject({ state: 'ready', path: dir });

    // Already there: a second call fetches nothing.
    await installer.ensure();
    expect(asked).toHaveLength(2);
  });

  it('pins a commit, since the file sizes are the only integrity check', () => {
    expect(EMBED_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(EMBED_MODEL.files.map((f) => f.path)).toEqual(['onnx/model_quantized.onnx', 'vocab.txt']);
  });
});
