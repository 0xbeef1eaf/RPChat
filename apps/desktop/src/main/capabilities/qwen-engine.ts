/**
 * Qwen3-TTS: argv for one utterance of the `qwen_tts` binary.
 *
 * This engine is a separate process rather than the in-process sherpa addon, and that is a
 * deliberate trade. The binary holds ~3 GB resident while it runs, which is a great deal to keep
 * alive beside a local LLM for a voice that speaks a few seconds a minute; a one-shot process pays
 * roughly half a second of model load per line and then gives the memory straight back.
 *
 * Unlike sherpa's CLI, this one forwards every sampling knob, so nothing is lost by staying out of
 * process: `--seed` makes a character reproducible and `-T` is honoured in full. The binary's
 * *server* mode clamps temperature to 2.0 and the command line does not, which matters because the
 * tuned default below sits above that clamp — another reason this path spawns per line.
 *
 * A voice is a `.qvoice` profile: a 16-25 MB speaker graft built from reference audio by the Base
 * model. The playback model cannot clone from a wav directly, so a character's `voice.reference`
 * must point at a profile; without one the model speaks in one of its built-in voices.
 */
import * as fs from 'node:fs/promises';
import { RpError } from '@rp/shared';
import { readWavFile } from './voice-engine.js';
import type { VoiceModel } from './voice-models.js';
import { QWEN_TTS_BINARY, QWEN_TTS_ENV } from './voice-models.js';

/** Extension of a built speaker profile. */
export const QWEN_PROFILE_EXT = '.qvoice';

/**
 * Sampling defaults, chosen by ear over the full range rather than taken from upstream.
 *
 * Temperature is the one that matters and it is not a smooth curve: below ~1.2 nothing changes
 * audibly, and above ~6 the model degenerates outright. A tight nucleus is what keeps a high
 * temperature usable — with `topP` open at 1.0 the same settings produce collapsed takes.
 */
export const QWEN_DEFAULTS = {
  temperature: 2.5,
  topK: 10,
  topP: 0.4,
  repPenalty: 2,
} as const;

/** Characters of text per second of speech, measured across renders. Used to spot a collapse. */
export const QWEN_CHARS_PER_SEC = 15;

/**
 * A take shorter than this fraction of its expected length has collapsed rather than spoken — the
 * model stops early and returns a second of noise. Re-rolling the seed clears it.
 */
export const QWEN_COLLAPSE_RATIO = 0.45;

export interface QwenRequest {
  text: string;
  /** Absolute path of the wav to write. */
  outFile: string;
  /** Absolute path of the `.qvoice` profile, when the character has one. */
  profile?: string;
  /** Sampling seed; omitted or -1 leaves every utterance different. */
  seed?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  repPenalty?: number;
  /** Worker threads. Kept small by default so text generation keeps the machine. */
  numThreads?: number;
}

/**
 * The profile a character will speak with, or `undefined` for the model's built-in voices.
 *
 * Only a `.qvoice` counts. A character configured for a cloning sherpa model points `reference` at
 * a wav, and handing that to `--load-voice` would fail at speaking time with a parse error rather
 * than anything a user could act on, so it is filtered out here instead.
 */
export function qwenProfileFor(reference?: string): string | undefined {
  if (!reference) return undefined;
  return reference.toLowerCase().endsWith(QWEN_PROFILE_EXT) ? reference : undefined;
}

/**
 * argv for one utterance, binary excluded.
 *
 * `--int8` quantises the weights as they load; it is how the model was measured and the reason it
 * fits in memory at all. `--icl-only` selects the graft a `.qvoice` carries rather than the lighter
 * x-vector path, which is the difference the voice was judged on.
 */
export function buildQwenArgs(model: VoiceModel, req: QwenRequest): string[] {
  const args = ['-d', model.dir, '--int8'];
  if (req.profile) args.push('--load-voice', req.profile, '--icl-only');
  if (req.seed !== undefined && req.seed >= 0) args.push('--seed', String(Math.round(req.seed)));
  args.push('-T', String(req.temperature ?? QWEN_DEFAULTS.temperature));
  args.push('-k', String(Math.round(req.topK ?? QWEN_DEFAULTS.topK)));
  args.push('-p', String(req.topP ?? QWEN_DEFAULTS.topP));
  args.push('-r', String(req.repPenalty ?? QWEN_DEFAULTS.repPenalty));
  if (req.numThreads !== undefined) args.push('-j', String(Math.max(1, Math.round(req.numThreads))));
  args.push('-o', req.outFile);
  // Text last, as its own token: it is never re-parsed by a shell, so quotes and newlines in a
  // line of dialogue need no escaping.
  args.push('--text', req.text);
  return args;
}

/** Seconds of speech `text` should produce, for the collapse check. */
export function expectedSeconds(text: string): number {
  return text.trim().split(/\s+/).join(' ').length / QWEN_CHARS_PER_SEC;
}

/**
 * Whether a rendered take is too short to be a real read of `text`.
 *
 * Worth checking because the failure is silent: the binary exits 0 and writes a valid wav that
 * simply stops after a syllable or two. Measured at 2 renders in 5 on long input before the
 * nucleus was tightened, and still possible on any given seed.
 */
export function collapsed(text: string, seconds: number): boolean {
  const want = expectedSeconds(text);
  return want > 0 && seconds < QWEN_COLLAPSE_RATIO * want;
}

/** A seed that is not the one that just collapsed, kept inside the binary's 32-bit range. */
export function retrySeed(seed: number): number {
  return (Math.round(seed) + 1000) % 2147483647;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface QwenRunnerDeps {
  /** Resolves the binary each call, so installing one mid-session is picked up. */
  findBinary(): string | undefined;
  spawn(file: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<SpawnResult>;
  /** Cap for one utterance. */
  timeoutMs: number;
  logger: Pick<Console, 'warn' | 'debug'>;
}

/**
 * Runs `qwen_tts` for one line, wherever that is needed — speaking in a chat and auditioning in the
 * pack editor both come through here, so the collapse guard cannot apply to one and not the other.
 */
export class QwenRunner {
  constructor(private readonly deps: QwenRunnerDeps) {}

  /** Whether a binary can be found at all. */
  available(): boolean {
    return this.deps.findBinary() !== undefined;
  }

  /**
   * Render `req.text` to `req.outFile` and return the seconds of audio written.
   *
   * A collapsed take is re-rolled once. Without a pinned seed the binary seeds itself from the
   * clock, so simply running it again is a different draw; with one, the retry seed is derived so
   * the result stays reproducible.
   */
  async render(model: VoiceModel, req: QwenRequest, signal?: AbortSignal): Promise<number> {
    const binary = this.deps.findBinary();
    if (!binary) {
      throw new RpError(
        'CAPABILITY_FAILED',
        `Voice model "${model.name}" needs ${QWEN_TTS_BINARY}, which was not found (${QWEN_TTS_ENV}, the app's resources/bin, or PATH)`,
        { model: model.name, binary: QWEN_TTS_BINARY },
      );
    }

    const once = async (seed?: number): Promise<number> => {
      const args = buildQwenArgs(model, seed === undefined ? { ...req, seed: -1 } : { ...req, seed });
      const result = await this.deps.spawn(binary, args, { ...(signal ? { signal } : {}), timeoutMs: this.deps.timeoutMs });
      if (result.code !== 0) {
        await fs.rm(req.outFile, { force: true }).catch(() => undefined);
        throw new RpError(
          'CAPABILITY_FAILED',
          `Voice model "${model.name}" (${model.label}) failed to synthesise: ${(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 500)}`,
          { model: model.name, engine: model.engine, code: result.code },
        );
      }
      const audio = await readWavFile(req.outFile);
      return audio.samples.length / audio.sampleRate;
    };

    const seed = req.seed !== undefined && req.seed >= 0 ? Math.round(req.seed) : undefined;
    let seconds = await once(seed);
    if (signal?.aborted) return seconds;
    if (collapsed(req.text, seconds)) {
      this.deps.logger.warn(
        `[qwen] ${model.name} produced ${seconds.toFixed(1)}s for ~${expectedSeconds(req.text).toFixed(0)}s of text; re-rolling the seed`,
      );
      seconds = await once(seed === undefined ? undefined : retrySeed(seed));
    }
    this.deps.logger.debug?.(`[qwen] ${model.name} rendered ${req.text.length} chars as ${seconds.toFixed(1)}s of audio`);
    return seconds;
  }
}
