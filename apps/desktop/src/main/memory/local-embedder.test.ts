/**
 * Driving the on-device model: the parts that are ours rather than ONNX Runtime's.
 *
 * The graph is stubbed here. What is worth pinning is everything around it — which feeds it is
 * given, that the work is split into runs rather than one enormous padded batch, that the sentence
 * vector is read off the right position and normalised, and that a model producing the wrong shape
 * is refused rather than quietly ranked with.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIMS } from './embed-model.js';
import { EMBED_ROWS_PER_RUN, LocalEmbedder, poolCls } from './local-embedder.js';
import type { OnnxRuntime, OnnxSession, OnnxTensor } from './local-embedder.js';

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'a', 'b', 'c'].join('\n');

interface FakeRun {
  feeds: Record<string, OnnxTensor>;
}

/** A session that answers with a `rows × tokens × hidden` tensor counting up from the row index. */
function fakeRuntime(options: { hidden?: number; inputs?: string[]; dims?: (rows: number, tokens: number, hidden: number) => number[] } = {}) {
  const runs: FakeRun[] = [];
  const hidden = options.hidden ?? EMBED_DIMS;
  const opened: string[] = [];
  const session: OnnxSession = {
    inputNames: options.inputs ?? ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    async run(feeds) {
      runs.push({ feeds });
      const rows = (feeds.input_ids as OnnxTensor).dims[0] as number;
      const tokens = (feeds.input_ids as OnnxTensor).dims[1] as number;
      const data = new Float32Array(rows * tokens * hidden);
      for (let r = 0; r < rows; r += 1) data[r * tokens * hidden] = r + 1; // one-hot at [CLS]
      const dims = options.dims ? options.dims(rows, tokens, hidden) : [rows, tokens, hidden];
      return { last_hidden_state: { dims, data } };
    },
  };
  const runtime: OnnxRuntime = {
    createSession: async (modelPath) => {
      opened.push(modelPath);
      return session;
    },
    tensor: (_type, data, dims) => ({ dims, data }),
  };
  return { runtime, runs, opened };
}

describe('poolCls', () => {
  it('takes token 0 of each row and scales it to unit length', () => {
    const rows = 2;
    const tokens = 3;
    const hidden = 2;
    const data = Float32Array.from([3, 4, 9, 9, 9, 9, 0, 5, 1, 1, 1, 1]);
    expect(poolCls(data, rows, tokens, hidden)).toEqual([
      [0.6, 0.8],
      [0, 1],
    ]);
  });

  it('leaves an all-zero row alone rather than dividing by nothing', () => {
    expect(poolCls(Float32Array.from([0, 0]), 1, 1, 2)).toEqual([[0, 0]]);
  });
});

describe('LocalEmbedder', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'embedder-'));
    await fs.writeFile(path.join(dir, 'vocab.txt'), VOCAB);
    await fs.mkdir(path.join(dir, 'onnx'), { recursive: true });
    await fs.writeFile(path.join(dir, 'onnx', 'model_quantized.onnx'), 'not really a model');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('embeds a batch, loading the vocabulary and the graph once', async () => {
    const { runtime, runs, opened } = fakeRuntime();
    const embedder = new LocalEmbedder({ modelDir: dir, runtime: async () => runtime });
    expect(embedder.source).toBe('local');
    expect(embedder.label).toContain('bge-small');

    const vectors = await embedder.embed(['a b', 'c']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBED_DIMS);
    expect(vectors[0]?.[0]).toBe(1); // one-hot at [CLS], already unit length
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0]!.feeds).sort()).toEqual(['attention_mask', 'input_ids', 'token_type_ids']);
    expect(runs[0]!.feeds.input_ids?.dims).toEqual([2, 4]); // padded to the longer of the two rows

    await embedder.embed(['a']);
    expect(opened).toHaveLength(1); // the session is reused
    expect(await embedder.embed([])).toEqual([]);
  });

  it('leaves out the segment ids a graph does not declare', async () => {
    const { runtime, runs } = fakeRuntime({ inputs: ['input_ids', 'attention_mask'] });
    await new LocalEmbedder({ modelDir: dir, runtime: async () => runtime }).embed(['a']);
    expect(Object.keys(runs[0]!.feeds).sort()).toEqual(['attention_mask', 'input_ids']);
  });

  it('splits a long list into runs instead of one padded batch', async () => {
    const { runtime, runs } = fakeRuntime();
    const texts = Array.from({ length: EMBED_ROWS_PER_RUN + 3 }, (_, i) => (i % 2 === 0 ? 'a' : 'b c'));
    const vectors = await new LocalEmbedder({ modelDir: dir, runtime: async () => runtime }).embed(texts);
    expect(vectors).toHaveLength(texts.length);
    expect(runs.map((r) => r.feeds.input_ids?.dims?.[0])).toEqual([EMBED_ROWS_PER_RUN, 3]);
  });

  it('refuses output of the wrong shape rather than ranking with it', async () => {
    const narrow = fakeRuntime({ hidden: 8 });
    await expect(new LocalEmbedder({ modelDir: dir, runtime: async () => narrow.runtime }).embed(['a'])).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
    });

    const flat = fakeRuntime({ dims: (rows, _tokens, hidden) => [rows, hidden] });
    await expect(new LocalEmbedder({ modelDir: dir, runtime: async () => flat.runtime }).embed(['a'])).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
    });
  });

  it('fails loudly when the model directory is not there', async () => {
    const { runtime } = fakeRuntime();
    const missing = new LocalEmbedder({ modelDir: path.join(dir, 'nope'), runtime: async () => runtime });
    await expect(missing.embed(['a'])).rejects.toThrow();
  });
});
