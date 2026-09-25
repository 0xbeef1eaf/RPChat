/**
 * Running the on-device embedding model, so semantic recall works with no provider behind it.
 *
 * The graph is a sentence transformer: token ids in, one vector per token out, and the sentence's
 * own vector read off the `[CLS]` position (what BGE is trained for) and scaled to unit length so a
 * dot product is a cosine. `wordpiece.ts` is the other half — the exact text→ids convention the
 * weights were trained with.
 *
 * ONNX Runtime is loaded on first use, not on import: it is ~46 MB of native library, and most
 * sessions never ask for a vector at all (a configured provider answers first, and without a
 * downloaded model this is never constructed).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Embedder } from '@rp/core';
import { RpError } from '@rp/shared';
import { EMBED_DIMS, EMBED_MAX_TOKENS, EMBED_MODEL } from './embed-model.js';
import { WordPieceVocab, encodeBatch } from './wordpiece.js';

/**
 * Texts per `session.run`. The cost of a batch is rows × the longest row, so a big batch with one
 * long memory in it wastes work on padding; sixteen keeps the graph busy without that mattering.
 */
export const EMBED_ROWS_PER_RUN = 16;

/** Minimal shape of what `onnxruntime-node` gives us, so the plumbing is testable without it. */
export interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}

export interface OnnxTensor {
  readonly dims: readonly number[];
  readonly data: unknown;
}

export interface OnnxRuntime {
  createSession(modelPath: string): Promise<OnnxSession>;
  tensor(type: 'int64', data: BigInt64Array, dims: number[]): OnnxTensor;
}

/** `onnxruntime-node`, imported on demand. */
export async function loadOnnxRuntime(): Promise<OnnxRuntime> {
  const ort = await import('onnxruntime-node');
  return {
    createSession: (modelPath) => ort.InferenceSession.create(modelPath) as unknown as Promise<OnnxSession>,
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims) as unknown as OnnxTensor,
  };
}

export interface LocalEmbedderOptions {
  /** Directory holding the model's files (`EmbedModelInstaller.modelDir()`). */
  modelDir: string;
  /** Injectable for tests; defaults to the real `onnxruntime-node`. */
  runtime?: () => Promise<OnnxRuntime>;
}

/**
 * Read the `[CLS]` vector of each row out of `last_hidden_state` (`rows × tokens × hidden`) and
 * normalise it. The vector is at token 0 of every row, so the stride between rows is tokens × hidden.
 */
export function poolCls(data: Float32Array, rows: number, tokens: number, hidden: number): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const start = r * tokens * hidden;
    const vector = Array.from(data.subarray(start, start + hidden));
    let sum = 0;
    for (const v of vector) sum += v * v;
    const norm = Math.sqrt(sum);
    out.push(norm > 0 ? vector.map((v) => v / norm) : vector);
  }
  return out;
}

/** The `Embedder` `@rp/core` asks for when no provider can embed. */
export class LocalEmbedder implements Embedder {
  readonly label = `on-device / ${EMBED_MODEL.name}`;
  readonly source = 'local' as const;
  private session: OnnxSession | undefined;
  private vocab: WordPieceVocab | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly o: LocalEmbedderOptions) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.load();
    const session = this.session as OnnxSession;
    const vocab = this.vocab as WordPieceVocab;
    const runtime = await (this.o.runtime ?? loadOnnxRuntime)();

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_ROWS_PER_RUN) {
      const batch = encodeBatch(vocab, texts.slice(i, i + EMBED_ROWS_PER_RUN), EMBED_MAX_TOKENS);
      const dims = [batch.rows, batch.width];
      const feeds: Record<string, OnnxTensor> = {
        input_ids: runtime.tensor('int64', batch.ids, dims),
        attention_mask: runtime.tensor('int64', batch.mask, dims),
      };
      // BERT graphs take segment ids; the export drops the input when the model never uses them.
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = runtime.tensor('int64', batch.types, dims);

      const result = await session.run(feeds);
      const name = session.outputNames[0] as string;
      const tensor = result[name];
      if (!tensor || tensor.dims.length !== 3) throw new RpError('CAPABILITY_FAILED', `The embedding model returned no usable ${name}`);
      const [rows, tokens, hidden] = tensor.dims as [number, number, number];
      if (hidden !== EMBED_DIMS) throw new RpError('CAPABILITY_FAILED', `The embedding model produced ${hidden} dimensions, expected ${EMBED_DIMS}`);
      out.push(...poolCls(tensor.data as Float32Array, rows, tokens, hidden));
    }
    return out;
  }

  /** Load the vocabulary and the graph once; concurrent first calls share the one load. */
  private async load(): Promise<void> {
    if (this.session && this.vocab) return;
    this.loading ??= this.run().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async run(): Promise<void> {
    const runtime = await (this.o.runtime ?? loadOnnxRuntime)();
    const vocabText = await fs.readFile(path.join(this.o.modelDir, 'vocab.txt'), 'utf8');
    const vocab = new WordPieceVocab(vocabText);
    const session = await runtime.createSession(path.join(this.o.modelDir, 'onnx', 'model_quantized.onnx'));
    this.vocab = vocab;
    this.session = session;
  }
}
