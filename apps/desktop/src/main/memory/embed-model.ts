/**
 * The on-device embedding model: which files it is, and where they come from.
 *
 * BGE-small at int8 is the trade this feature wants — 34 MB and a few milliseconds a batch on a
 * CPU, against the ~130 MB and slower answer of the float32 build or the weaker output of a static
 * word-vector table. It is the fallback for people whose provider has no embeddings endpoint
 * (Anthropic publishes none), so it has to be small enough that offering it is not an imposition.
 *
 * Not fetched on start, and not fetched behind the user's back when a turn wants a vector: this is
 * a download, and a download that begins because a character happened to reach for a memory is a
 * surprise. Settings asks, `EmbedModelInstaller.ensure()` does it, and until then memories are
 * ranked by their words.
 *
 * The revision is pinned to a commit rather than `main` because the file sizes below are the only
 * integrity check Hugging Face offers here, and they only mean anything against a fixed revision.
 */
import { HfModelInstaller } from '../capabilities/hf-install.js';
import type { HfModelSpec } from '../capabilities/hf-install.js';

/** Xenova's ONNX export of `BAAI/bge-small-en-v1.5`, quantised to int8. */
export const EMBED_MODEL = {
  name: 'bge-small-en-v1.5',
  repo: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  label: 'BGE-small v1.5 (int8)',
  files: [
    { path: 'onnx/model_quantized.onnx', bytes: 34_014_426 },
    { path: 'vocab.txt', bytes: 231_508 },
  ],
} as const satisfies HfModelSpec;

/** Vector width the model produces. Recorded so a wrong file is caught on the first batch. */
export const EMBED_DIMS = 384;

/** Positions the graph has embeddings for; a longer memory is truncated, which none of ours are. */
export const EMBED_MAX_TOKENS = 512;

/** How the sentence vector is read out of `last_hidden_state`: BGE trains the `[CLS]` position for it. */
export const EMBED_POOLING = 'cls';

export interface EmbedInstallerDeps {
  /** `<userData>/models`. */
  modelsDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** The manifest to fetch; defaults to the real model, so a test needs no 34 MB. */
  files?: HfModelSpec['files'];
}

export class EmbedModelInstaller extends HfModelInstaller {
  constructor(deps: EmbedInstallerDeps) {
    super(
      { ...EMBED_MODEL, files: deps.files ?? EMBED_MODEL.files },
      {
        rootDir: deps.modelsDir,
        logger: deps.logger,
        tag: 'embed-model',
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
    );
  }
}
