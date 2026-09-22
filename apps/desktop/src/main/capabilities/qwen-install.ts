/**
 * Fetching the Qwen3-TTS weights, so choosing that engine is a click rather than an afternoon.
 *
 * Unlike the Pocket model this is **not** fetched on start. It is ~2.5 GB against Pocket's 98 MB,
 * and Qwen is opt-in per character — making every user pay that for a voice they may never select
 * would be a poor trade. It is fetched when someone actually asks for it.
 *
 * Hugging Face serves the files individually rather than as an archive, so there is nothing to
 * unpack; each file is fetched straight into a staging directory that is renamed into place only
 * once every file is present and the right size. A part-downloaded tree is therefore never visible
 * to the model scanner, and an interrupted download resumes by skipping the files already there.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetInstallStatus } from '@rp/shared';
import { RpError } from '@rp/shared';
import { downloadArchive } from './archive-install.js';

const HF_BASE = 'https://huggingface.co';

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

/** Bytes the whole model costs, for the progress report. */
export function qwenModelBytes(): number {
  return QWEN_MODEL_FILES.reduce((n, f) => n + f.bytes, 0);
}

/** Where one model file is served from. */
export function qwenFileUrl(file: string): string {
  return `${HF_BASE}/${QWEN_MODEL.repo}/resolve/${QWEN_MODEL.revision}/${file}`;
}

export interface QwenInstallerDeps {
  /** `<userData>/voices`. */
  voicesDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** The manifest to fetch; defaults to the real model. Injectable so tests need no 2.5 GB. */
  files?: ReadonlyArray<{ path: string; bytes: number }>;
}

export class QwenModelInstaller {
  private state: AssetInstallStatus = { state: 'absent', version: QWEN_MODEL.name };
  private job: Promise<string | undefined> | undefined;
  private readonly files: ReadonlyArray<{ path: string; bytes: number }>;

  constructor(private readonly deps: QwenInstallerDeps) {
    this.files = deps.files ?? QWEN_MODEL_FILES;
  }

  /** Where the model lands, whether or not it is there yet. */
  modelDir(): string {
    return path.join(this.deps.voicesDir, QWEN_MODEL.name);
  }

  status(): AssetInstallStatus {
    return { ...this.state };
  }

  /** The model directory, if every file is present at the size it should be. */
  async installed(): Promise<string | undefined> {
    const dir = this.modelDir();
    for (const file of this.files) {
      const stat = await fs.stat(path.join(dir, file.path)).catch(() => undefined);
      if (!stat?.isFile() || stat.size !== file.bytes) return undefined;
    }
    return dir;
  }

  /**
   * Fetch the model unless it is already there. Idempotent and single-flight; resolves to the model
   * directory, or `undefined` on failure. Never throws — this is started from a click and reported
   * through `status()`, so a failed download must not take anything else down.
   */
  async ensure(): Promise<string | undefined> {
    const already = await this.installed();
    if (already) {
      this.state = { state: 'ready', version: QWEN_MODEL.name, path: already };
      return already;
    }
    this.job ??= this.run().finally(() => {
      this.job = undefined;
    });
    return this.job;
  }

  private async run(): Promise<string | undefined> {
    const target = this.modelDir();
    const staging = `${target}.incoming`;
    const total = this.files.reduce((n, f) => n + f.bytes, 0);
    try {
      this.deps.logger.info(`[qwen-model] fetching ${QWEN_MODEL.repo} (${Math.round(total / 1e6)} MB)`);
      await fs.mkdir(staging, { recursive: true });

      let done = 0;
      for (const file of this.files) {
        const dest = path.join(staging, file.path);
        // A file already at the right size is one an interrupted run finished; 2.5 GB is far too
        // much to fetch again for the sake of uniformity.
        const have = await fs.stat(dest).catch(() => undefined);
        if (have?.isFile() && have.size === file.bytes) {
          done += file.bytes;
          this.state = { state: 'downloading', version: QWEN_MODEL.name, received: done, total };
          continue;
        }
        await downloadArchive(
          { file: file.path, bytes: file.bytes, url: qwenFileUrl(file.path) },
          dest,
          {
            ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
            onProgress: (received) => {
              this.state = { state: 'downloading', version: QWEN_MODEL.name, received: done + received, total };
            },
          },
        );
        done += file.bytes;
      }

      // Nothing is visible to the scanner until every file is down, so a half install can never be
      // detected as a model and driven.
      for (const file of this.files) {
        const stat = await fs.stat(path.join(staging, file.path)).catch(() => undefined);
        if (!stat?.isFile() || stat.size !== file.bytes) {
          throw new RpError('CAPABILITY_FAILED', `${file.path} is missing or the wrong size after download`);
        }
      }
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(staging, target);

      this.state = { state: 'ready', version: QWEN_MODEL.name, path: target };
      this.deps.logger.info(`[qwen-model] ${QWEN_MODEL.name} ready at ${target}`);
      return target;
    } catch (err) {
      const message = (err as Error).message;
      // The staging tree is deliberately left in place: it is most of a 2.5 GB download, and the
      // next attempt skips whatever finished.
      this.state = { state: 'failed', version: QWEN_MODEL.name, error: message };
      this.deps.logger.warn(`[qwen-model] could not install ${QWEN_MODEL.name}: ${message}`);
      return undefined;
    }
  }
}
