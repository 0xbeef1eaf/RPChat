/**
 * The pack editor's voice panel: what models are installed, and rendering a line so an author can
 * hear a setting before saving it.
 *
 * `seed` is the reason this exists. The model samples, so an unseeded character says the same line
 * with different pacing every time; pinning a seed makes it consistent. That is only tunable if the
 * author can audition seeds, which needs synthesis on demand from the editor rather than at chat
 * time. Previews therefore always run in process — the command-line engine cannot pass a seed.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetInstallStatus, VoicePreview, VoiceStudioState } from '@rp/shared';
import { RpError, VOICE_PREVIEW_MAX, VOICE_PREVIEW_SENTENCE, assetUrl } from '@rp/shared';
import type { VoiceEngine } from './voice-engine.js';
import { writeWavFile } from './voice-engine.js';
import type { VoiceModel } from './voice-models.js';

/** Synthetic pack id under which rendered previews are served to the editor. */
export const VOICE_PREVIEW_PACK_ID = 'app.rpchat.voice-preview';
/** Directory under `userData` holding rendered previews. */
export const VOICE_PREVIEW_DIRNAME = 'voice-preview';
/** Previews kept on disk; the oldest are dropped so auditioning seeds cannot fill the disk. */
export const MAX_PREVIEWS = 40;

export interface VoicePreviewRequest {
  text?: string;
  /** Absolute path of the character's reference clip, when it has one. */
  reference?: string;
  referenceText?: string;
  model?: string;
  seed?: number;
  temperature?: number;
  steps?: number;
  rate?: number;
  speaker?: number;
}

export interface VoiceStudioDeps {
  /** `<userData>/voice-preview`. */
  dir: string;
  models(): Promise<VoiceModel[]>;
  engine: VoiceEngine;
  engineStatus?(): AssetInstallStatus;
  modelStatus?(): AssetInstallStatus;
  numThreads(): Promise<number>;
  logger: Pick<Console, 'warn' | 'debug'>;
}

export class VoiceStudio {
  constructor(private readonly deps: VoiceStudioDeps) {}

  async state(): Promise<VoiceStudioState> {
    const models = await this.deps.models();
    const out: VoiceStudioState = {
      models: models.map((m) => ({ name: m.name, label: m.label, engine: m.engine, clones: m.clones })),
    };
    const engine = this.deps.engineStatus?.();
    if (engine) out.engine = engine;
    const model = this.deps.modelStatus?.();
    if (model) out.model = model;
    const why = this.unavailable(models);
    if (why) out.unavailable = why;
    return out;
  }

  private unavailable(models: VoiceModel[]): string | undefined {
    if (!this.deps.engine.available()) {
      return 'The bundled speech engine could not be loaded on this machine, so voices cannot be previewed here.';
    }
    if (models.length === 0) {
      const status = this.deps.modelStatus?.();
      if (status?.state === 'downloading') {
        const pct = status.total ? Math.floor(((status.received ?? 0) / status.total) * 100) : 0;
        return `Downloading the Pocket TTS voice model (${pct}%). Previews will work once it finishes.`;
      }
      if (status?.state === 'extracting') return 'Unpacking the Pocket TTS voice model. Previews will work once it finishes.';
      if (status?.state === 'failed') return `The voice model could not be downloaded (${status.error ?? 'unknown error'}); unpack one under the voices folder yourself.`;
      return 'No voice model is installed yet.';
    }
    return undefined;
  }

  /**
   * Which model to render with: the one asked for, else the character's, else the only installed
   * one. A name that is not installed is an error rather than a silent substitution — hearing a
   * different model than the one you named would be worse than hearing nothing.
   */
  private pick(models: VoiceModel[], requested?: string): VoiceModel {
    if (models.length === 0) throw new RpError('CAPABILITY_FAILED', 'No voice model is installed');
    if (requested) {
      const hit = models.find((m) => m.name === requested);
      if (!hit) {
        throw new RpError('CAPABILITY_FAILED', `Voice model "${requested}" is not installed (installed: ${models.map((m) => m.name).join(', ')})`, { model: requested });
      }
      return hit;
    }
    return models[0] as VoiceModel;
  }

  /** Render one line and return its asset URL. Nothing is saved to the pack. */
  async preview(req: VoicePreviewRequest): Promise<VoicePreview> {
    if (!this.deps.engine.available()) {
      throw new RpError('CAPABILITY_FAILED', 'The bundled speech engine is not available, so previews cannot be generated');
    }
    const raw = (req.text ?? '').trim();
    const text = (raw.length > 0 ? raw : VOICE_PREVIEW_SENTENCE).slice(0, VOICE_PREVIEW_MAX);
    const models = await this.deps.models();
    const model = this.pick(models, req.model);

    const reference = req.reference ?? model.sampleReference;
    if (model.clones && !reference) {
      throw new RpError('CAPABILITY_FAILED', `${model.label} speaks in the voice of a reference clip; add one to the character first`, { model: model.name });
    }
    // An unseeded take cannot be recovered once it plays, so pick the seed here and report it back.
    const seed = req.seed !== undefined && req.seed >= 0 ? Math.round(req.seed) : Math.floor(Math.random() * 2_147_483_647);

    const audio = await this.deps.engine.synthesize(model, {
      text,
      numThreads: await this.deps.numThreads(),
      seed,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.steps !== undefined ? { steps: req.steps } : {}),
      ...(req.rate !== undefined ? { rate: req.rate } : {}),
      ...(req.speaker !== undefined ? { speaker: req.speaker } : {}),
      ...(reference ? { reference } : {}),
      ...(req.referenceText ? { referenceText: req.referenceText } : {}),
    });

    await fs.mkdir(this.deps.dir, { recursive: true });
    const name = `${randomUUID()}.wav`;
    await writeWavFile(path.join(this.deps.dir, name), audio);
    void this.prune();
    return { url: assetUrl(VOICE_PREVIEW_PACK_ID, name), duration: audio.samples.length / audio.sampleRate, seed };
  }

  /** Keep the preview directory bounded; auditioning seeds writes a file every time. */
  private async prune(): Promise<void> {
    try {
      const names = await fs.readdir(this.deps.dir);
      if (names.length <= MAX_PREVIEWS) return;
      const stats = await Promise.all(
        names.map(async (n) => ({ n, t: (await fs.stat(path.join(this.deps.dir, n)).catch(() => undefined))?.mtimeMs ?? 0 })),
      );
      stats.sort((a, b) => a.t - b.t);
      for (const { n } of stats.slice(0, stats.length - MAX_PREVIEWS)) {
        await fs.rm(path.join(this.deps.dir, n), { force: true }).catch(() => undefined);
      }
    } catch (err) {
      this.deps.logger.debug?.(`[voice-studio] could not prune previews: ${(err as Error).message}`);
    }
  }
}
