/**
 * Neural TTS through the in-process sherpa-onnx addon.
 *
 * The CLI spawns a process and reloads the model for every single utterance — around 450 ms of
 * startup before a word is spoken, and no way to reach the model's `extra` settings, because
 * `sherpa-onnx-offline-tts` forwards only `emotion_id` and `lang`. Holding the model in process
 * fixes both: `seed` becomes reachable, so a character can sound the same from one run to the next
 * instead of resampling its delivery every time, and the load cost is paid once.
 *
 * Generation runs through `generateAsync`, which does the work on a worker thread. That matters in
 * Electron's main process: `generate()` would block the event loop for well over a second per line
 * and freeze the window.
 *
 * The addon is required lazily and every failure is caught. A prebuilt native module that will not
 * load on some machine must degrade to the command-line path, not take the app down.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VoiceModel } from './voice-models.js';

/** Models kept loaded at once. Each holds its weights in memory, so this stays small. */
export const MAX_RESIDENT_MODELS = 2;

export interface SynthRequest {
  text: string;
  /** Absolute path of the reference wav for a cloning model. */
  reference?: string;
  referenceText?: string;
  /** Speed multiplier. */
  rate?: number;
  /** Speaker id for bank models. */
  speaker?: number;
  /** Flow-matching steps. */
  steps?: number;
  /** Sampling seed; -1 (or undefined) leaves every utterance different. */
  seed?: number;
  /** Sampling temperature; the model's own default is 0.7. */
  temperature?: number;
  numThreads: number;
}

/** Audio as the addon returns it. */
export interface SynthResult {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * `pocket-text-conditioner` → `{ pocket: { textConditioner } }`.
 *
 * The CLI flag names and the addon's config keys are the same words in different dress, so one rule
 * covers every engine: the first segment selects the sub-object, the rest becomes camelCase.
 */
export function flagToConfigPath(flag: string): { engine: string; key: string } | undefined {
  const [engine, ...rest] = flag.split('-');
  if (!engine || rest.length === 0) return undefined;
  const key = rest.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return { engine, key };
}

/** The addon's `OfflineTtsConfig` for a detected model directory. */
export function buildModelConfig(model: VoiceModel, numThreads: number): Record<string, unknown> {
  const engineConfig: Record<string, string> = {};
  let engineName = model.engine as string;
  for (const [flag, file] of Object.entries(model.files)) {
    const mapped = flagToConfigPath(flag);
    if (!mapped) continue;
    engineName = mapped.engine;
    engineConfig[mapped.key] = file;
  }
  return { model: { [engineName]: engineConfig, numThreads: Math.max(1, Math.round(numThreads)), debug: 0 } };
}

/**
 * The per-utterance `generationConfig`. `seed` and `temperature` ride in `extra`, which the addon
 * serialises to JSON for the C API; the rest are first-class fields.
 */
export function buildGenerationConfig(model: VoiceModel, req: SynthRequest, reference?: SynthResult): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (req.rate !== undefined) cfg.speed = req.rate;
  if (req.steps !== undefined) cfg.numSteps = Math.round(req.steps);
  if (!model.clones && req.speaker !== undefined) cfg.sid = Math.round(req.speaker);
  if (model.clones && reference) {
    cfg.referenceAudio = reference.samples;
    cfg.referenceSampleRate = reference.sampleRate;
    if (req.referenceText) cfg.referenceText = req.referenceText;
  }
  const extra: Record<string, number> = {};
  // -1 is the model's own "random each time"; passing it is the same as passing nothing.
  if (req.seed !== undefined && req.seed >= 0) extra.seed = Math.round(req.seed);
  if (req.temperature !== undefined) extra.temperature = req.temperature;
  if (Object.keys(extra).length > 0) cfg.extra = extra;
  return cfg;
}

/**
 * Longest chunk handed to the model at once. Pocket TTS splits on its own at
 * `max_char_in_sentence` (200), but doing it here means one long line becomes several short
 * renders instead of one very long one — and the joins land where a reader would breathe.
 */
export const MAX_CHUNK_CHARS = 200;

/** Silence inserted between chunks, so joined sentences do not run into each other. */
export const CHUNK_GAP_MS = 120;

/**
 * Break text into chunks the model can render comfortably, preferring sentence boundaries, then
 * clause punctuation, and only splitting between words as a last resort. Never splits mid-word, and
 * never returns an empty chunk.
 */
export function splitForSynthesis(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxChars) return [clean];

  // Keep the terminator with the sentence it ends, so the model still hears a full stop.
  const sentences = clean.split(/(?<=[.!?\u2026])\s+/).filter((x) => x.length > 0);
  const out: string[] = [];
  let current = '';

  const flush = (): void => {
    const t = current.trim();
    if (t.length > 0) out.push(t);
    current = '';
  };

  for (const sentence of sentences) {
    for (const piece of sentence.length <= maxChars ? [sentence] : breakLong(sentence, maxChars)) {
      if (current.length === 0) current = piece;
      else if (current.length + 1 + piece.length <= maxChars) current = `${current} ${piece}`;
      else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return out;
}

/** Split one over-long sentence: on clause punctuation first, then between words. */
function breakLong(sentence: string, maxChars: number): string[] {
  const clauses = sentence.split(/(?<=[,;:\u2014])\s+/).filter((x) => x.length > 0);
  const out: string[] = [];
  for (const clause of clauses) {
    if (clause.length <= maxChars) {
      out.push(clause);
      continue;
    }
    let line = '';
    for (const word of clause.split(' ')) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Concatenate rendered chunks into one clip, with a little silence at each join. Every chunk comes
 * from the same model, so the sample rates agree; a mismatch would be a bug, not something to
 * resample around, so it is reported rather than papered over.
 */
export function joinAudio(parts: SynthResult[], gapMs: number = CHUNK_GAP_MS): SynthResult {
  if (parts.length === 0) throw new Error('nothing to join');
  const first = parts[0] as SynthResult;
  if (parts.length === 1) return first;
  const sampleRate = first.sampleRate;
  const mismatch = parts.find((p) => p.sampleRate !== sampleRate);
  if (mismatch) throw new Error(`chunks disagree on sample rate (${sampleRate} vs ${mismatch.sampleRate})`);

  const gap = Math.max(0, Math.round((gapMs / 1000) * sampleRate));
  const total = parts.reduce((n, p) => n + p.samples.length, 0) + gap * (parts.length - 1);
  const samples = new Float32Array(total);
  let at = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as SynthResult;
    samples.set(part.samples, at);
    at += part.samples.length;
    if (i < parts.length - 1) at += gap; // the gap is already zeroed
  }
  return { samples, sampleRate };
}

/** Read a mono 16-bit PCM wav into the float samples the addon expects. */
export async function readWavFile(file: string): Promise<SynthResult> {
  const b = await fs.readFile(file);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF') throw new Error(`${path.basename(file)} is not a wav file`);
  let i = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let data: Buffer | undefined;
  // `i + 8 <= length`, not `i < length - 8`: a chunk header ending exactly at EOF is still a header.
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(i + 10);
      sampleRate = b.readUInt32LE(i + 12);
      bits = b.readUInt16LE(i + 22);
    } else if (id === 'data') {
      data = b.subarray(i + 8, Math.min(b.length, i + 8 + size));
      break;
    }
    i += 8 + size + (size & 1);
  }
  // Order matters: an unusable sample format should say so rather than read as a missing chunk.
  if (!sampleRate) throw new Error(`${path.basename(file)} has no format chunk`);
  if (bits !== 16) throw new Error(`${path.basename(file)} is ${bits}-bit; reference audio must be 16-bit PCM`);
  if (!data || data.length === 0) throw new Error(`${path.basename(file)} has no readable audio`);
  const frames = Math.floor(data.length / 2 / channels);
  const out = new Float32Array(frames);
  // Downmix to mono: the models are mono, and averaging beats silently taking one channel.
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((f * channels + c) * 2);
    out[f] = sum / channels / 32768;
  }
  return { samples: out, sampleRate };
}

/** Write float samples as a mono 16-bit PCM wav, which is what the audio window plays. */
export async function writeWavFile(file: string, audio: SynthResult): Promise<void> {
  const n = audio.samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(audio.sampleRate, 24);
  b.writeUInt32LE(audio.sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const s = Math.max(-1, Math.min(1, audio.samples[i] ?? 0));
    b.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  await fs.writeFile(file, b);
}

interface Addon {
  OfflineTts: {
    createAsync(config: unknown): Promise<{ generateAsync(req: unknown): Promise<{ samples: Float32Array; sampleRate: number }> }>;
  };
}

export interface VoiceEngineDeps {
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests; defaults to requiring `sherpa-onnx-node`. */
  loadAddon?: () => Addon | undefined;
}

type Resident = { name: string; tts: Awaited<ReturnType<Addon['OfflineTts']['createAsync']>> };

export class VoiceEngine {
  private addon: Addon | undefined | null = null;
  private readonly resident: Resident[] = [];
  private readonly loading = new Map<string, Promise<Resident>>();

  constructor(private readonly deps: VoiceEngineDeps) {}

  /** The addon, or `undefined` when it cannot be loaded here. Resolved once and remembered. */
  private load(): Addon | undefined {
    if (this.addon !== null) return this.addon ?? undefined;
    try {
      const loader = this.deps.loadAddon ?? (() => require('sherpa-onnx-node') as Addon);
      const mod = loader();
      this.addon = mod && typeof mod.OfflineTts?.createAsync === 'function' ? mod : undefined;
      if (!this.addon) this.deps.logger.warn('[voice-engine] sherpa-onnx-node loaded but has no OfflineTts; falling back to the command line');
    } catch (err) {
      this.addon = undefined;
      this.deps.logger.warn(`[voice-engine] sherpa-onnx-node is unavailable (${(err as Error).message}); falling back to the command line`);
    }
    return this.addon ?? undefined;
  }

  /** Whether in-process synthesis can be used at all. */
  available(): boolean {
    return this.load() !== undefined;
  }

  /** The loaded model, loading it if needed. Concurrent callers share one load. */
  private async instance(model: VoiceModel, numThreads: number): Promise<Resident> {
    const hit = this.resident.find((r) => r.name === model.name);
    if (hit) return hit;
    const pending = this.loading.get(model.name);
    if (pending) return pending;

    const addon = this.load();
    if (!addon) throw new Error('sherpa-onnx-node is not available');
    const job = (async () => {
      const started = Date.now();
      const tts = await addon.OfflineTts.createAsync(buildModelConfig(model, numThreads));
      this.deps.logger.info(`[voice-engine] loaded ${model.name} in ${Date.now() - started} ms`);
      const entry: Resident = { name: model.name, tts };
      this.resident.push(entry);
      // Weights stay in memory, so keep only the models actually in use.
      while (this.resident.length > MAX_RESIDENT_MODELS) this.resident.shift();
      return entry;
    })().finally(() => this.loading.delete(model.name));
    this.loading.set(model.name, job);
    return job;
  }

  /** Synthesise one utterance. Throws when the addon or the model cannot be used. */
  async synthesize(model: VoiceModel, req: SynthRequest): Promise<SynthResult> {
    const reference = model.clones && req.reference ? await readWavFile(req.reference) : undefined;
    const entry = await this.instance(model, req.numThreads);
    const audio = await entry.tts.generateAsync({
      text: req.text,
      generationConfig: buildGenerationConfig(model, req, reference),
    });
    if (!audio?.samples?.length) throw new Error(`${model.name} produced no audio`);
    return { samples: audio.samples, sampleRate: audio.sampleRate };
  }

  dispose(): void {
    this.resident.length = 0;
    this.loading.clear();
  }
}
