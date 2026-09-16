/**
 * Fetching a voice model so the speech engine has something to say words with.
 *
 * The engine on its own cannot speak: it needs weights. Requiring the user to find, download and
 * unpack a 98 MB archive by hand is the difference between the voice feature working and the voice
 * feature existing, so the app fetches the default Pocket TTS model on first start the same way it
 * fetches the engine — in the background, never awaited, never fatal.
 *
 * Only the default is fetched. Anything else (Kokoro, Kitten, a Piper voice) is still unpacked into
 * the voices folder by hand, and any cloning model already installed means nothing is downloaded.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetInstallStatus } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { ArchiveSpec, SpawnFn } from './archive-install.js';
import { downloadAndUnpack } from './archive-install.js';

const MODEL_RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

/**
 * The model fetched automatically: Pocket TTS, quantised.
 *
 * It clones a voice from a few seconds of reference audio, which is what gives each character its
 * own voice; a speaker-bank model like Kokoro would give every character the same handful. The
 * `int8` build is half the size of the float one and is the point of running on the CPU at all.
 *
 * `bytes` is the size GitHub reports for the asset, and the only integrity check available — the
 * release publishes no checksums. Changing `file` means re-checking it.
 */
export const DEFAULT_VOICE_MODEL = {
  /** Directory name it unpacks to, which is what `character.json` and settings refer to. */
  name: 'sherpa-onnx-pocket-tts-int8-2026-01-26',
  file: 'sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2',
  bytes: 98_336_520,
  label: 'Pocket TTS (int8)',
} as const;

/** Files the archive must contain for the unpacked directory to be a usable Pocket TTS model. */
const REQUIRED_FILES = ['lm_flow.int8.onnx', 'lm_main.int8.onnx', 'encoder.onnx', 'decoder.int8.onnx', 'text_conditioner.onnx', 'vocab.json', 'token_scores.json'];

export function defaultModelSpec(): ArchiveSpec {
  return { file: DEFAULT_VOICE_MODEL.file, bytes: DEFAULT_VOICE_MODEL.bytes, url: `${MODEL_RELEASE_BASE}/${DEFAULT_VOICE_MODEL.file}` };
}

export interface VoiceModelInstallerDeps {
  /** `<userData>/voices`. */
  voicesDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  spawn?: SpawnFn;
}

export class VoiceModelInstaller {
  private readonly platform: NodeJS.Platform;
  private state: AssetInstallStatus = { state: 'absent', version: DEFAULT_VOICE_MODEL.name };
  private job: Promise<string | undefined> | undefined;

  constructor(private readonly deps: VoiceModelInstallerDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  /** Where the default model unpacks to, whether or not it is there yet. */
  modelDir(): string {
    return path.join(this.deps.voicesDir, DEFAULT_VOICE_MODEL.name);
  }

  status(): AssetInstallStatus {
    return { ...this.state };
  }

  /** Note that a usable cloning model is already installed, so nothing needs fetching. */
  markPresent(name: string): void {
    this.state = { state: 'present', version: name };
  }

  markDisabled(): void {
    if (this.state.state !== 'ready' && this.state.state !== 'present') this.state = { state: 'disabled', version: DEFAULT_VOICE_MODEL.name };
  }

  /** The unpacked model directory, if every weight file is present. */
  async installed(): Promise<string | undefined> {
    const dir = this.modelDir();
    for (const file of REQUIRED_FILES) {
      const stat = await fs.stat(path.join(dir, file)).catch(() => undefined);
      if (!stat?.isFile() || stat.size === 0) return undefined;
    }
    return dir;
  }

  /**
   * Fetch the default model unless it is already unpacked. Idempotent and single-flight; resolves to
   * the model directory, or `undefined` on failure. Never throws: this runs in the background at
   * startup, and failing to fetch an optional model must not take the app down with it.
   */
  async ensure(): Promise<string | undefined> {
    const already = await this.installed();
    if (already) {
      this.state = { state: 'ready', version: DEFAULT_VOICE_MODEL.name, path: already };
      return already;
    }
    this.job ??= this.run().finally(() => {
      this.job = undefined;
    });
    return this.job;
  }

  private async run(): Promise<string | undefined> {
    const spec = defaultModelSpec();
    const target = this.modelDir();
    try {
      this.deps.logger.info(`[voice-model] fetching ${spec.file} (${Math.round(spec.bytes / 1e6)} MB)`);
      await downloadAndUnpack({
        spec,
        target,
        workDir: this.deps.voicesDir,
        platform: this.platform,
        // The archive wraps everything in one directory named after the model; dropping it and
        // renaming the staging directory into place gives exactly that name back.
        strip: 1,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
        onProgress: (received, total) => {
          this.state = { state: 'downloading', version: DEFAULT_VOICE_MODEL.name, received, total };
        },
        onExtract: () => {
          this.state = { state: 'extracting', version: DEFAULT_VOICE_MODEL.name };
        },
        verify: async (staging) => {
          for (const file of REQUIRED_FILES) {
            const stat = await fs.stat(path.join(staging, file)).catch(() => undefined);
            if (!stat?.isFile()) throw new RpError('CAPABILITY_FAILED', `the archive did not contain ${file}`);
          }
        },
      });
      this.state = { state: 'ready', version: DEFAULT_VOICE_MODEL.name, path: target };
      this.deps.logger.info(`[voice-model] ${DEFAULT_VOICE_MODEL.name} ready at ${target}`);
      return target;
    } catch (err) {
      const message = (err as Error).message;
      this.state = { state: 'failed', version: DEFAULT_VOICE_MODEL.name, error: message };
      this.deps.logger.warn(`[voice-model] could not install ${DEFAULT_VOICE_MODEL.name}: ${message}`);
      return undefined;
    }
  }
}
