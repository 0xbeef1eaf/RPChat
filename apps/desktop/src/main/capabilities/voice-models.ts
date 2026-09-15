/**
 * Neural TTS through sherpa-onnx: finding the `sherpa-onnx-offline-tts` binary, recognising the
 * voice models installed under `<userData>/voices/`, and building the argv for one utterance.
 *
 * Everything here is pure — the filesystem arrives as a `DirListing` and the process is spawned by
 * the caller — so the flag tables are unit-testable without a binary or a model on disk.
 *
 * The flag names mirror `sherpa-onnx/csrc/offline-tts-*-model-config.cc` upstream. A model is a
 * directory unpacked from one of the k2-fsa `tts-models` releases; nothing is renamed on install,
 * so detection works off the filenames those archives already contain.
 */

/** Executable that synthesises one utterance to a wav. */
export const SHERPA_TTS_BINARY = 'sherpa-onnx-offline-tts';

/** Environment override for the binary's location (mirrors `RP_OVERLAY_HELPER`). */
export const SHERPA_TTS_ENV = 'RP_SHERPA_TTS';

/** Directory under `userData` holding unpacked voice models, one subdirectory each. */
export const VOICES_DIRNAME = 'voices';

/** Optional file in a model directory that pins its engine when the shape is ambiguous. */
export const VOICE_MODEL_MARKER = 'rp-voice.json';

/** Sample wavs shipped inside the k2-fsa model archives, used when a character supplies no reference. */
export const SAMPLE_DIRNAME = 'test_wavs';

export type VoiceEngineId = 'pocket' | 'kokoro' | 'kitten' | 'vits';

interface FileRule {
  /** sherpa flag this file is passed as, without the leading `--`. */
  flag: string;
  /** Matched against each filename in the model directory (case-insensitive). */
  match: RegExp;
}

interface DirRule extends FileRule {
  /** Matched against subdirectory names instead of files. */
  dir: true;
}

interface EngineSpec {
  id: VoiceEngineId;
  label: string;
  /** Every one of these must resolve or the directory is not this engine. */
  required: FileRule[];
  /** Passed when present; absent ones are simply left off. */
  optional: Array<FileRule | DirRule>;
  /** True when the engine takes its voice from reference audio rather than a speaker bank. */
  clones: boolean;
  /** Matched against the directory name as a hint before file shape is considered. */
  nameHint: RegExp;
}

/**
 * Ordered most- to least-specific: `vits` accepts any single `.onnx` beside a `tokens.txt`, so it
 * must be tried last or it would swallow every other engine's directory.
 */
const ENGINES: EngineSpec[] = [
  {
    id: 'pocket',
    label: 'Pocket TTS',
    clones: true,
    nameHint: /pocket/i,
    required: [
      { flag: 'pocket-lm-flow', match: /^lm_flow\./i },
      { flag: 'pocket-lm-main', match: /^lm_main\./i },
      { flag: 'pocket-encoder', match: /^encoder\./i },
      { flag: 'pocket-decoder', match: /^decoder\./i },
      { flag: 'pocket-text-conditioner', match: /^text_conditioner\./i },
      { flag: 'pocket-vocab-json', match: /^vocab\.json$/i },
      { flag: 'pocket-token-scores-json', match: /^token_scores\.json$/i },
    ],
    optional: [],
  },
  {
    id: 'kokoro',
    label: 'Kokoro',
    clones: false,
    nameHint: /kokoro/i,
    required: [
      { flag: 'kokoro-model', match: /^model\b.*\.onnx$/i },
      { flag: 'kokoro-voices', match: /^voices\.bin$/i },
      { flag: 'kokoro-tokens', match: /^tokens\.txt$/i },
    ],
    optional: [
      { flag: 'kokoro-lexicon', match: /^lexicon.*\.txt$/i },
      { flag: 'kokoro-data-dir', match: /^espeak-ng-data$/i, dir: true },
      { flag: 'kokoro-dict-dir', match: /^dict$/i, dir: true },
    ],
  },
  {
    id: 'kitten',
    label: 'Kitten TTS',
    clones: false,
    nameHint: /kitten/i,
    required: [
      { flag: 'kitten-model', match: /^model\b.*\.onnx$/i },
      { flag: 'kitten-voices', match: /^voices\.bin$/i },
      { flag: 'kitten-tokens', match: /^tokens\.txt$/i },
    ],
    optional: [{ flag: 'kitten-data-dir', match: /^espeak-ng-data$/i, dir: true }],
  },
  {
    id: 'vits',
    label: 'VITS / Piper',
    clones: false,
    nameHint: /vits|piper/i,
    required: [
      { flag: 'vits-model', match: /\.onnx$/i },
      { flag: 'vits-tokens', match: /^tokens\.txt$/i },
    ],
    optional: [
      { flag: 'vits-lexicon', match: /^lexicon.*\.txt$/i },
      { flag: 'vits-data-dir', match: /^espeak-ng-data$/i, dir: true },
      { flag: 'vits-dict-dir', match: /^dict$/i, dir: true },
    ],
  },
];

/** What one model directory contains, as read by the caller. */
export interface DirListing {
  /** Filenames directly inside the model directory. */
  files: string[];
  /** Subdirectory names directly inside it. */
  dirs: string[];
  /** Filenames inside its `test_wavs/`, when it has one. */
  samples?: string[];
}

/** A voice model directory recognised as one of the supported engines. */
export interface VoiceModel {
  /** Directory name, which is what `character.json` and settings refer to. */
  name: string;
  /** Absolute path of the model directory. */
  dir: string;
  engine: VoiceEngineId;
  label: string;
  /** True when the engine speaks in the voice of a reference clip (Pocket TTS). */
  clones: boolean;
  /** sherpa flag (without `--`) → absolute path, for every required and present optional file. */
  files: Record<string, string>;
  /** A wav shipped inside the model archive, used when a cloning model has no character reference. */
  sampleReference?: string;
}

const joinPath = (dir: string, name: string): string => `${dir.replace(/[/\\]+$/, '')}/${name}`;

/**
 * Pick the filename matching `rule`. When several match, an `int8` build wins: these models are
 * being run on the CPU precisely to leave the GPU to text generation, so the quantised weights are
 * the intended default rather than a compromise.
 */
function pickFile(names: string[], match: RegExp): string | undefined {
  const hits = names.filter((n) => match.test(n));
  if (hits.length <= 1) return hits[0];
  return hits.find((n) => /\bint8\b|\.int8\./i.test(n)) ?? hits.slice().sort()[0];
}

/** Resolve one engine's rules against a listing, or `undefined` when a required file is missing. */
function resolveEngine(spec: EngineSpec, dir: string, listing: DirListing): VoiceModel | undefined {
  const files: Record<string, string> = {};
  for (const rule of spec.required) {
    const hit = pickFile(listing.files, rule.match);
    if (!hit) return undefined;
    files[rule.flag] = joinPath(dir, hit);
  }
  for (const rule of spec.optional) {
    const pool = 'dir' in rule ? listing.dirs : listing.files;
    const hit = pickFile(pool, rule.match);
    if (hit) files[rule.flag] = joinPath(dir, hit);
  }
  const name = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? dir;
  // The archives keep their demo clips in `test_wavs/`; a loose wav beside the weights counts too.
  const sample = pickFile(listing.samples ?? [], /\.wav$/i);
  const looseSample = pickFile(listing.files, /\.wav$/i);
  const model: VoiceModel = { name, dir, engine: spec.id, label: spec.label, clones: spec.clones, files };
  if (sample) model.sampleReference = joinPath(joinPath(dir, SAMPLE_DIRNAME), sample);
  else if (looseSample) model.sampleReference = joinPath(dir, looseSample);
  return model;
}

/**
 * Recognise a model directory. `pinned` is the `engine` field of a `rp-voice.json` marker, which
 * settles the Kokoro/Kitten ambiguity (both are a `model.onnx` beside `voices.bin` and
 * `tokens.txt`); without one the directory name decides, and only then the file shape.
 */
export function detectVoiceModel(dir: string, listing: DirListing, pinned?: string): VoiceModel | undefined {
  if (pinned) {
    const spec = ENGINES.find((e) => e.id === pinned);
    return spec ? resolveEngine(spec, dir, listing) : undefined;
  }
  const name = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  const byName = ENGINES.filter((e) => e.nameHint.test(name));
  for (const spec of [...byName, ...ENGINES.filter((e) => !byName.includes(e))]) {
    const model = resolveEngine(spec, dir, listing);
    if (model) return model;
  }
  return undefined;
}

export interface SpeakRequest {
  text: string;
  /** Absolute path of the wav to write. */
  outFile: string;
  /** Speed multiplier; 1 is the model's natural pace. */
  rate?: number;
  /** Speaker id for multi-speaker banks (Kokoro, VITS). Ignored by cloning engines. */
  speaker?: number;
  /** Flow-matching steps (Pocket TTS): fewer is faster, more is smoother. */
  steps?: number;
  /** Absolute path of the wav a cloning engine should copy the voice from. */
  reference?: string;
  /** Transcript of `reference` (ZipVoice needs it; Pocket TTS ignores it). */
  referenceText?: string;
  /** onnxruntime threads. Kept small by default so text generation keeps the machine. */
  numThreads?: number;
}

/**
 * argv for one utterance, binary excluded. The text is the single positional argument and goes
 * last; every value is passed as its own `--flag=value` token, so nothing is re-parsed by a shell
 * and speech containing quotes or newlines needs no escaping.
 */
export function buildSherpaArgs(model: VoiceModel, req: SpeakRequest): string[] {
  const args: string[] = [];
  for (const [flag, file] of Object.entries(model.files)) args.push(`--${flag}=${file}`);
  args.push(`--output-filename=${req.outFile}`);
  if (req.numThreads !== undefined) args.push(`--num-threads=${Math.max(1, Math.round(req.numThreads))}`);
  if (req.rate !== undefined) args.push(`--speed=${req.rate}`);
  if (req.steps !== undefined) args.push(`--num-steps=${Math.round(req.steps)}`);
  if (!model.clones && req.speaker !== undefined) args.push(`--sid=${Math.round(req.speaker)}`);
  if (model.clones) {
    const reference = req.reference ?? model.sampleReference;
    // Guarded by `referenceFor` before we get here; the CLI would exit non-zero anyway.
    if (reference) args.push(`--reference-audio=${reference}`);
    if (req.referenceText) args.push(`--reference-text=${req.referenceText}`);
  }
  args.push(req.text);
  return args;
}

/**
 * The reference clip a cloning engine will use, or `undefined` when it has none. A character's own
 * clip wins; otherwise the sample from the model archive stands in, so a freshly installed Pocket
 * TTS still speaks instead of failing.
 */
export function referenceFor(model: VoiceModel, characterReference?: string): string | undefined {
  if (!model.clones) return undefined;
  return characterReference ?? model.sampleReference;
}

/** Where the sherpa-onnx TTS binary may live: env override, bundled resources, PATH. */
export function findSherpaTts(opts: {
  env: NodeJS.ProcessEnv;
  resourcesDirs: string[];
  exists(file: string): boolean;
  onPath(name: string): boolean;
}): string | undefined {
  const override = opts.env[SHERPA_TTS_ENV];
  if (override && opts.exists(override)) return override;
  for (const dir of opts.resourcesDirs) {
    for (const suffix of ['', '.exe']) {
      const candidate = `${dir}/bin/${SHERPA_TTS_BINARY}${suffix}`;
      if (opts.exists(candidate)) return candidate;
    }
  }
  return opts.onPath(SHERPA_TTS_BINARY) ? SHERPA_TTS_BINARY : undefined;
}

/** Engines the app knows how to drive, for settings help and error messages. */
export function supportedEngines(): Array<{ id: VoiceEngineId; label: string; clones: boolean }> {
  return ENGINES.map(({ id, label, clones }) => ({ id, label, clones }));
}
