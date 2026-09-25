/**
 * The Qwen3-TTS weights: which files they are, and where they come from.
 *
 * Unlike the Pocket model this is **not** fetched on start. It is ~2.5 GB against Pocket's 98 MB,
 * and Qwen is opt-in per character — making every user pay that for a voice they may never select
 * would be a poor trade. It is fetched when someone actually asks for it, by the shared Hugging
 * Face installer in `hf-install.ts`.
 */
import type { HfModelSpec } from './hf-install.js';
import { HfModelInstaller, hfFileUrl, modelBytes } from './hf-install.js';

/**
 * The playback model. `CustomVoice` is the half of the pair that speaks; the `Base` model builds
 * `.qvoice` profiles from reference audio and is a separate, later download.
 *
 * Sizes are what Hugging Face reports for each file and are the only integrity check available —
 * the repository publishes no checksums. They were taken from the served `content-length`, so
 * changing the revision means re-checking every one.
 */
export const QWEN_MODEL = {
  /** Directory name under `voices/`, which is what `character.json` refers to. */
  name: 'qwen3-tts-0.6b',
  repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  revision: 'main',
  label: 'Qwen3-TTS 0.6B',
} as const;

/** Every file the engine loads, with the size Hugging Face serves. */
export const QWEN_MODEL_FILES: ReadonlyArray<{ path: string; bytes: number }> = [
  { path: 'config.json', bytes: 4908 },
  { path: 'generation_config.json', bytes: 245 },
  { path: 'tokenizer_config.json', bytes: 7344 },
  { path: 'preprocessor_config.json', bytes: 127 },
  { path: 'model.safetensors', bytes: 1_811_626_576 },
  { path: 'vocab.json', bytes: 2_776_833 },
  { path: 'merges.txt', bytes: 1_671_839 },
  { path: 'speech_tokenizer/config.json', bytes: 2336 },
  { path: 'speech_tokenizer/configuration.json', bytes: 76 },
  { path: 'speech_tokenizer/model.safetensors', bytes: 682_293_092 },
  { path: 'speech_tokenizer/preprocessor_config.json', bytes: 234 },
];

export interface QwenInstallerDeps {
  /** `<userData>/voices`. */
  voicesDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** The manifest to fetch; defaults to the real model. Injectable so tests need no 2.5 GB. */
  files?: ReadonlyArray<{ path: string; bytes: number }>;
}

/** Bytes the whole model costs, for the progress report. */
export function qwenModelBytes(): number {
  return modelBytes(qwenSpec(QWEN_MODEL_FILES));
}

/** Where one model file is served from. */
export function qwenFileUrl(file: string): string {
  return hfFileUrl(qwenSpec(QWEN_MODEL_FILES), file);
}

function qwenSpec(files: ReadonlyArray<{ path: string; bytes: number }>): HfModelSpec {
  return { ...QWEN_MODEL, files };
}

export class QwenModelInstaller extends HfModelInstaller {
  constructor(deps: QwenInstallerDeps) {
    super(qwenSpec(deps.files ?? QWEN_MODEL_FILES), {
      rootDir: deps.voicesDir,
      logger: deps.logger,
      tag: 'qwen-model',
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
}
