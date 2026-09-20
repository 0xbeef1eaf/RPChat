/**
 * `sdk.voice`: TTS through a neural voice model, the `tts` template, or the hidden window's
 * speechSynthesis; STT through `stt`.
 *
 * `speak()` picks the first of these that is available, in order:
 *  1. a `tts` command template the **user** set — the explicit escape hatch, so it always wins;
 *  2. a voice model installed under `<userData>/voices/`;
 *  3. the platform's default `tts` command (espeak-ng, `say`, SAPI);
 *  4. the hidden audio window's `speechSynthesis`.
 *
 * Step 2 is what makes a character sound like itself, and there are two engines behind it. A sherpa
 * model (Pocket TTS and the speaker banks) runs through the in-process addon, taking its voice from
 * the wav named by that character's `voice.reference`. Qwen3-TTS is its own binary and runs as a
 * subprocess (see `qwen-engine.ts` for why), taking its voice from a `.qvoice` profile.
 *
 * Once a model is installed, a missing binary or an unknown model name is an error rather than a
 * silent drop back to step 3 — installing a model is deliberate, and a character quietly speaking
 * in espeak's robot voice hides the problem.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CapabilityHandler, CommandTemplate, Json, LoadedPack, VoiceSettings } from '@rp/shared';
import { RpError, assetUrl } from '@rp/shared';
import { joinRelative, resolveAssetPath } from '@rp/pack';
import type { CommandRunner } from './commands-runner.js';
import { commandFailed, isConfigured, notConfigured, spawnCapture } from '../commands.js';
import type { CommandResult } from '../commands.js';
import type { OverlayWindowLike } from '../display/backend.js';
import type { VoiceModel } from './voice-models.js';
import type { SynthResult, VoiceEngine } from './voice-engine.js';
import { joinAudio, splitForSynthesis, writeWavFile } from './voice-engine.js';
import type { QwenRunner } from './qwen-engine.js';
import { qwenProfileFor } from './qwen-engine.js';
import {
  QWEN_TTS_BINARY,
  QWEN_TTS_ENV,
  SAMPLE_DIRNAME,
  SHERPA_TTS_BINARY,
  SHERPA_TTS_ENV,
  VOICES_DIRNAME,
  VOICE_MODEL_MARKER,
  buildSherpaArgs,
  detectVoiceModel,
  referenceFor,
  usesSherpa,
} from './voice-models.js';

/** Synthetic pack id under which generated speech files are served to the audio window. */
export const TTS_PACK_ID = 'app.rpchat.tts';
export const VOICE_TEXT_MAX = 2000;
export const LISTEN_MAX_SECONDS = 60;
/** How long a fire-and-forget `speak()` waits for the TTS command to fail before reporting success. */
export const SPEAK_START_GRACE_MS = 300;
/**
 * Cap for one neural synthesis. `VOICE_TEXT_MAX` characters is around two minutes of speech, which
 * even a slow CPU model finishes well inside this; the 30 s command default would cut it off.
 */
export const SYNTH_TIMEOUT_MS = 120_000;
/** How long a scan of the voices directory is reused, so a model added while running is picked up. */
export const MODEL_CACHE_MS = 10_000;

export interface VoiceHandlerDeps {
  commands: CommandRunner;
  audioWindow(): OverlayWindowLike;
  /** Directory registered as the root of `TTS_PACK_ID` for the asset protocol. */
  ttsDir: string;
  logger: Pick<Console, 'warn' | 'debug'>;
  /** Override of `SPEAK_START_GRACE_MS` for tests. */
  startGraceMs?: number;
  /** Directory holding unpacked voice models (`<userData>/voices`). Without it, only steps 1, 3 and 4 run. */
  voicesDir?: string;
  /** Locates `sherpa-onnx-offline-tts` (env override, bundled resources, PATH). */
  findSherpa?: () => string | undefined;
  /** Drives Qwen models, which are their own binary. Absent leaves them installed but unusable. */
  qwen?: QwenRunner;
  /** The speaking character's pack, for its `voice` block. */
  packs?: { getLoaded(packId: string): LoadedPack };
  /** App-level voice settings (default model, thread count, kill switch). */
  voiceSettings?: () => Promise<VoiceSettings>;
  /** In-process synthesis. Preferred over the command line; absent leaves only the CLI path. */
  engine?: VoiceEngine;
  /** Injectable for tests. */
  spawn?: (file: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<CommandResult>;
}

export function speechSynthesisScript(text: string, rate: number | undefined, voice: string | undefined): string {
  const payload = JSON.stringify({ text, rate, voice });
  return `(function(){try{var p=${payload};if(!window.speechSynthesis)return false;var u=new SpeechSynthesisUtterance(p.text);if(p.rate)u.rate=p.rate;if(p.voice){var v=speechSynthesis.getVoices().find(function(x){return x.name===p.voice});if(v)u.voice=v;}speechSynthesis.cancel();speechSynthesis.speak(u);return true;}catch(e){return false;}})();`;
}

/** A voice model plus everything one utterance needs from the character and the settings. */
interface NeuralVoice {
  /** The command-line engine, when one was found. Absent when only the in-process addon is usable. */
  binary?: string;
  model: VoiceModel;
  reference?: string;
  referenceText?: string;
  speaker?: number;
  steps?: number;
  /** Sampling seed; omitted or -1 leaves every utterance different. */
  seed?: number;
  /** Sampling temperature; the model's own default is 0.7. */
  temperature?: number;
  numThreads: number;
  /** The character's own baseline speed, used when the call passes no `rate`. */
  rate?: number;
}

/**
 * Read every recognised voice model under `voicesDir`. A directory that matches no engine is
 * skipped silently: users unpack archives here by hand, so stray folders are expected.
 */
export async function readVoiceModels(voicesDir: string): Promise<VoiceModel[]> {
  let entries;
  try {
    entries = await fs.readdir(voicesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const models: VoiceModel[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(voicesDir, entry.name);
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = inner.filter((e) => e.isFile()).map((e) => e.name);
    const dirs = inner.filter((e) => e.isDirectory()).map((e) => e.name);
    const samples = await fs.readdir(path.join(dir, SAMPLE_DIRNAME)).catch(() => []);
    const pinned = await readEngineMarker(dir);
    const model = detectVoiceModel(dir, { files, dirs, samples }, pinned);
    if (model) models.push(model);
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** `engine` from an `rp-voice.json` marker, which disambiguates look-alike model layouts. */
async function readEngineMarker(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, VOICE_MODEL_MARKER), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const engine = (parsed as { engine?: unknown } | null)?.engine;
    return typeof engine === 'string' ? engine : undefined;
  } catch {
    return undefined;
  }
}

export class VoiceHandler implements CapabilityHandler {
  readonly moduleId = 'voice';
  private current: { abort: AbortController; itemId?: string } | undefined;
  private cache: { at: number; models: VoiceModel[] } | undefined;

  constructor(private readonly deps: VoiceHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'speak':
        await this.speak(args[0], asObject(args[1]), context);
        return;
      case 'stop':
        await this.stop();
        return;
      case 'listen':
        return (await this.listen(asObject(args[0]))) as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.voice.${method}`);
    }
  }

  private async speak(textArg: unknown, opts: Record<string, unknown>, context: ActionContext): Promise<void> {
    if (typeof textArg !== 'string' || textArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
    const text = textArg.trim().slice(0, VOICE_TEXT_MAX);
    const rate = typeof opts.rate === 'number' && opts.rate > 0 ? Math.min(4, opts.rate) : undefined;
    const voice = typeof opts.voice === 'string' ? opts.voice : undefined;
    const wait = opts.wait === true;
    await this.stop();
    const abort = new AbortController();
    this.current = { abort };

    // 1. The user's own command template is the escape hatch and outranks everything.
    const userTpl = this.deps.commands.userTemplate ? await this.deps.commands.userTemplate('tts') : undefined;
    if (userTpl && isConfigured(userTpl)) return this.speakWithTemplate(userTpl, { text, rate, voice }, wait, abort);

    // 2. A neural voice model, when one is installed.
    const neural = await this.resolveNeural(context, voice);
    if (neural) return this.speakWithSherpa(neural, text, rate, wait, abort);

    // 3. The platform default (espeak-ng, `say`, SAPI).
    const tpl = await this.deps.commands.resolve('tts');
    if (isConfigured(tpl)) return this.speakWithTemplate(tpl, { text, rate, voice }, wait, abort);

    // 4. The hidden audio window's speechSynthesis.
    const win = this.deps.audioWindow();
    await win.whenReady();
    const ok = await win.runScript?.(speechSynthesisScript(text, rate, voice));
    if (ok !== true) {
      throw new RpError('CAPABILITY_FAILED', `${notConfigured('tts').message}; the built-in speech synthesis is unavailable here too`, { template: 'tts' });
    }
    if (wait) await new Promise((r) => setTimeout(r, Math.min(60_000, 400 + text.length * 60)));
  }

  /** Steps 1 and 3: run a `tts` command template, playing `{file}` when it writes one. */
  private async speakWithTemplate(
    tpl: CommandTemplate,
    vars: { text: string; rate?: number; voice?: string },
    wait: boolean,
    abort: AbortController,
  ): Promise<void> {
    const writesFile = tpl.command.includes('{file}');
    const file = path.join(this.deps.ttsDir, `${randomUUID()}.wav`);
    if (writesFile) await fs.mkdir(this.deps.ttsDir, { recursive: true });
    const substitutions: Record<string, string> = {
      text: vars.text,
      file,
      rate: vars.rate !== undefined ? String(vars.rate) : '',
      voice: vars.voice ?? '',
    };
    const run = this.deps.commands.runTemplate(tpl, substitutions, 'tts', { signal: abort.signal }).then(async (result) => {
      if (result.code !== 0 && !abort.signal.aborted) throw commandFailed('tts', tpl, result);
      if (writesFile && !abort.signal.aborted) await this.play(file, wait, abort);
    });
    if (wait || writesFile) return run;
    // Fire-and-forget, but a command that cannot start (missing binary) or fails at once is still reported.
    const settled = run.then(() => 'ok' as const);
    settled.catch((err) => this.deps.logger.warn('[voice] tts failed', err));
    await Promise.race([settled, new Promise<'pending'>((r) => setTimeout(() => r('pending'), this.deps.startGraceMs ?? SPEAK_START_GRACE_MS).unref?.())]);
  }

  /** Step 2: synthesise to a wav with sherpa-onnx, then play it through the audio window. */
  private async speakWithSherpa(voice: NeuralVoice, text: string, rate: number | undefined, wait: boolean, abort: AbortController): Promise<void> {
    await fs.mkdir(this.deps.ttsDir, { recursive: true });
    const file = path.join(this.deps.ttsDir, `${randomUUID()}.wav`);

    if (!usesSherpa(voice.model.engine)) {
      await this.speakWithQwen(voice, text, file, wait, abort);
      return;
    }

    // In process when the addon is usable: the model stays loaded, and `seed`/`temperature` are
    // reachable at all — the CLI forwards neither, so a character cannot sound the same twice.
    const engine = this.deps.engine;
    if (engine?.available()) {
      const started = Date.now();
      // One long line is rendered as several short ones and joined. A whole paragraph in a single
      // call is minutes of audio from one request, and the joins land where a reader would breathe.
      const chunks = splitForSynthesis(text);
      const parts: SynthResult[] = [];
      for (const [index, chunk] of chunks.entries()) {
        // A locked voice must stay reproducible, so per-chunk seeds are derived from the base
        // rather than drawn fresh — but they differ, or every sentence would share one contour.
        const seed = voice.seed !== undefined && voice.seed >= 0 ? voice.seed + index : undefined;
        parts.push(
          await engine.synthesize(voice.model, {
            text: chunk,
            numThreads: voice.numThreads,
            ...(rate ?? voice.rate ? { rate: rate ?? voice.rate } : {}),
            ...(voice.speaker !== undefined ? { speaker: voice.speaker } : {}),
            ...(voice.steps !== undefined ? { steps: voice.steps } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(voice.temperature !== undefined ? { temperature: voice.temperature } : {}),
            ...(voice.reference ? { reference: voice.reference } : {}),
            ...(voice.referenceText ? { referenceText: voice.referenceText } : {}),
          }),
        );
        if (abort.signal.aborted) return;
      }
      const audio = joinAudio(parts);
      await writeWavFile(file, audio);
      this.deps.logger.debug?.(
        `[voice] ${voice.model.name} synthesised ${text.length} chars as ${chunks.length} chunk(s) in ${Date.now() - started} ms (in process)`,
      );
      await this.play(file, wait, abort);
      return;
    }

    if (!voice.binary) {
      throw new RpError('CAPABILITY_FAILED', `Voice model "${voice.model.name}" cannot be used: neither the in-process engine nor ${SHERPA_TTS_BINARY} is available`, {
        model: voice.model.name,
      });
    }
    const args = buildSherpaArgs(voice.model, {
      text,
      outFile: file,
      ...(rate ?? voice.rate ? { rate: rate ?? voice.rate } : {}),
      ...(voice.speaker !== undefined ? { speaker: voice.speaker } : {}),
      ...(voice.steps !== undefined ? { steps: voice.steps } : {}),
      ...(voice.reference ? { reference: voice.reference } : {}),
      ...(voice.referenceText ? { referenceText: voice.referenceText } : {}),
      numThreads: voice.numThreads,
    });
    const spawnFn = this.deps.spawn ?? ((f, a, o) => spawnCapture(f, a, o));
    const started = Date.now();
    const result = await spawnFn(voice.binary, args, { signal: abort.signal, timeoutMs: SYNTH_TIMEOUT_MS });
    if (abort.signal.aborted) return;
    if (result.code !== 0) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw new RpError(
        'CAPABILITY_FAILED',
        `Voice model "${voice.model.name}" (${voice.model.label}) failed to synthesise: ${(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 500)}`,
        { model: voice.model.name, engine: voice.model.engine, code: result.code },
      );
    }
    this.deps.logger.debug?.(`[voice] ${voice.model.name} synthesised ${text.length} chars in ${Date.now() - started} ms`);
    await this.play(file, wait, abort);
  }

  /**
   * Qwen3-TTS: one `qwen_tts` process per line.
   *
   * The binary exits 0 and writes a perfectly valid wav even when generation collapsed after a
   * syllable or two, so the result is measured rather than trusted and a collapse is re-rolled
   * once. `rate` is not forwarded: this engine has no speed control, and silently ignoring a
   * character's setting is better than failing the line over it.
   */
  private async speakWithQwen(voice: NeuralVoice, text: string, file: string, wait: boolean, abort: AbortController): Promise<void> {
    const runner = this.deps.qwen;
    if (!runner) {
      throw new RpError('CAPABILITY_FAILED', `Voice model "${voice.model.name}" cannot be used: ${QWEN_TTS_BINARY} is not available (${QWEN_TTS_ENV}, the app's resources/bin, or PATH)`, {
        model: voice.model.name,
      });
    }
    const started = Date.now();
    await runner.render(
      voice.model,
      {
        text,
        outFile: file,
        ...(voice.reference ? { profile: voice.reference } : {}),
        ...(voice.seed !== undefined ? { seed: voice.seed } : {}),
        ...(voice.temperature !== undefined ? { temperature: voice.temperature } : {}),
        numThreads: voice.numThreads,
      },
      abort.signal,
    );
    if (abort.signal.aborted) return;
    this.deps.logger.debug?.(`[voice] ${voice.model.name} spoke ${text.length} chars in ${Date.now() - started} ms`);
    await this.play(file, wait, abort);
  }

  /** Every recognised model under `voicesDir`, re-scanned at most every `MODEL_CACHE_MS`. */
  private async models(): Promise<VoiceModel[]> {
    const dir = this.deps.voicesDir;
    if (!dir) return [];
    const now = Date.now();
    if (this.cache && now - this.cache.at < MODEL_CACHE_MS) return this.cache.models;
    const models = await readVoiceModels(dir);
    this.cache = { at: now, models };
    return models;
  }

  /**
   * The voice model this call should use, or `undefined` to fall through to the command template.
   * `requested` (from `speak(text, { voice })`) beats the character's `voice.model`, which beats the
   * app default; with none of those and exactly one model installed, that one is used.
   */
  private async resolveNeural(context: ActionContext, requested?: string): Promise<NeuralVoice | undefined> {
    if (!this.deps.voicesDir || !(this.deps.findSherpa || this.deps.qwen)) return undefined;
    const settings = this.deps.voiceSettings ? await this.deps.voiceSettings() : undefined;
    if (settings?.disabled) return undefined;
    const models = await this.models();
    if (models.length === 0) return undefined;

    const character = this.characterVoice(context);
    const name = requested ?? character?.model ?? (settings?.defaultModel || undefined);
    const model = name ? models.find((m) => m.name === name) : models.length === 1 ? models[0] : undefined;
    if (name && !model) {
      throw new RpError(
        'CAPABILITY_FAILED',
        `Voice model "${name}" is not installed; unpack it under ${this.deps.voicesDir} (installed: ${models.map((m) => m.name).join(', ')})`,
        { model: name, installed: models.map((m) => m.name) },
      );
    }
    if (!model) return undefined;

    // Qwen is its own binary, so the sherpa addon and the sherpa CLI are both irrelevant to it.
    const qwen = !usesSherpa(model.engine);
    const binary = qwen ? (this.deps.qwen?.available() === true ? QWEN_TTS_BINARY : undefined) : this.deps.findSherpa?.();
    const inProcess = !qwen && this.deps.engine?.available() === true;
    if (!binary && !inProcess) {
      const [name, env] = qwen ? [QWEN_TTS_BINARY, QWEN_TTS_ENV] : [SHERPA_TTS_BINARY, SHERPA_TTS_ENV];
      throw new RpError(
        'CAPABILITY_FAILED',
        `Voice model "${model.name}" is installed but no speech engine is available: ${name} was not found (${env}, the app's resources/bin, or PATH)`,
        { model: model.name, binary: name },
      );
    }

    const reference = qwen
      ? qwenProfileFor(this.referencePath(context, character?.reference))
      : referenceFor(model, this.referencePath(context, character?.reference));
    // Qwen needs no reference: without a profile it speaks in one of its own voices, which is a
    // usable result rather than a failure. Every other cloning engine has nothing to say without
    // one, so the absence stays an error there.
    if (model.clones && !reference && !qwen) {
      throw new RpError(
        'CAPABILITY_FAILED',
        `Voice model "${model.name}" (${model.label}) clones a voice from reference audio, but neither the character's voice.reference nor a sample in the model's ${SAMPLE_DIRNAME}/ was found`,
        { model: model.name, engine: model.engine },
      );
    }
    const numThreads = settings?.numThreads ?? 4;
    const steps = character?.steps ?? settings?.steps;
    return {
      ...(binary ? { binary } : {}),
      model,
      numThreads,
      ...(reference ? { reference } : {}),
      ...(character?.referenceText ? { referenceText: character.referenceText } : {}),
      ...(character?.speaker !== undefined ? { speaker: character.speaker } : {}),
      ...(steps !== undefined ? { steps } : {}),
      ...(character?.rate !== undefined ? { rate: character.rate } : {}),
      ...(character?.seed !== undefined ? { seed: character.seed } : {}),
      ...(character?.temperature !== undefined ? { temperature: character.temperature } : {}),
    };
  }

  /** The speaking character's `voice` block, or `undefined` when the pack is not loaded. */
  private characterVoice(context: ActionContext): LoadedPack['character']['definition']['voice'] {
    if (!this.deps.packs) return undefined;
    try {
      return this.deps.packs.getLoaded(context.packId).character.definition.voice;
    } catch {
      return undefined;
    }
  }

  /** Absolute path of a character-relative reference wav, guarded against escaping the pack root. */
  private referencePath(context: ActionContext, relative?: string): string | undefined {
    if (!relative || !this.deps.packs) return undefined;
    try {
      const pack = this.deps.packs.getLoaded(context.packId);
      return resolveAssetPath(context.packRoot || pack.root, joinRelative(pack.character.dir, relative));
    } catch (err) {
      this.deps.logger.warn(`[voice] ignoring voice.reference "${relative}": ${(err as Error).message}`);
      return undefined;
    }
  }

  private async play(file: string, wait: boolean, abort: AbortController): Promise<void> {
    const win = this.deps.audioWindow();
    await win.whenReady();
    const id = `tts-${randomUUID()}`;
    if (this.current) this.current.itemId = id;
    const url = assetUrl(TTS_PACK_ID, path.basename(file));
    const done = new Promise<void>((resolve) => {
      const off = win.onReport((ev) => {
        if (ev.id !== id) return;
        if (ev.type === 'ended' || ev.type === 'closed' || ev.type === 'error') {
          off();
          resolve();
        }
      });
      abort.signal.addEventListener('abort', () => {
        off();
        resolve();
      }, { once: true });
      setTimeout(() => {
        off();
        resolve();
      }, 120_000).unref?.();
    });
    win.send({ type: 'play-audio', id, url, options: {} });
    const cleanup = (): void => {
      void fs.rm(file, { force: true }).catch(() => undefined);
    };
    if (wait) {
      await done;
      cleanup();
    } else void done.then(cleanup);
  }

  private async stop(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    current.abort.abort();
    const win = this.deps.audioWindow();
    if (current.itemId && !win.isDestroyed()) win.send({ type: 'close', id: current.itemId });
    await win.runScript?.('(function(){try{if(window.speechSynthesis)speechSynthesis.cancel();}catch(e){}})();').catch(() => undefined);
  }

  private async listen(opts: Record<string, unknown>): Promise<{ text: string }> {
    const seconds = typeof opts.maxSeconds === 'number' && opts.maxSeconds > 0 ? Math.min(LISTEN_MAX_SECONDS, Math.round(opts.maxSeconds)) : 10;
    const result = await this.deps.commands.runChecked('stt', { seconds: String(seconds) });
    return { text: result.stdout.trim() };
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export { VOICES_DIRNAME };
