/**
 * Recognising voice model directories and turning one into a sherpa-onnx command line. The flag
 * names here mirror `offline-tts-*-model-config.cc` upstream, so a rename there should break these
 * tests rather than produce a command that silently exits non-zero at speaking time.
 */
import { describe, expect, it } from 'vitest';
import type { DirListing } from './voice-models.js';
import { buildSherpaArgs, detectVoiceModel, findQwenTts, findSherpaTts, referenceFor, supportedEngines, usesSherpa } from './voice-models.js';

const POCKET: DirListing = {
  files: ['lm_flow.int8.onnx', 'lm_main.int8.onnx', 'encoder.onnx', 'decoder.int8.onnx', 'text_conditioner.onnx', 'vocab.json', 'token_scores.json', 'README.md'],
  dirs: ['test_wavs'],
  samples: ['bria.wav'],
};
const KOKORO: DirListing = { files: ['model.onnx', 'voices.bin', 'tokens.txt'], dirs: ['espeak-ng-data', 'dict'] };
const VITS: DirListing = { files: ['en_GB-alba-medium.onnx', 'tokens.txt'], dirs: ['espeak-ng-data'] };
const QWEN: DirListing = {
  files: ['config.json', 'model.safetensors', 'generation_config.json', 'vocab.json', 'merges.txt'],
  dirs: ['speech_tokenizer'],
};

const flags = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m?.[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
};

describe('detectVoiceModel', () => {
  it('recognises a Pocket TTS directory and all seven of its model files', () => {
    const model = detectVoiceModel('/v/sherpa-onnx-pocket-tts-int8-2026-01-26', POCKET);
    expect(model?.engine).toBe('pocket');
    expect(model?.clones).toBe(true);
    expect(model?.name).toBe('sherpa-onnx-pocket-tts-int8-2026-01-26');
    const f = model!.files;
    expect(Object.keys(f).sort()).toEqual(
      ['pocket-decoder', 'pocket-encoder', 'pocket-lm-flow', 'pocket-lm-main', 'pocket-text-conditioner', 'pocket-token-scores-json', 'pocket-vocab-json'].sort(),
    );
    expect(f['pocket-lm-flow']).toBe('/v/sherpa-onnx-pocket-tts-int8-2026-01-26/lm_flow.int8.onnx');
  });

  it('takes the demo clip in test_wavs/ as the fallback reference', () => {
    const model = detectVoiceModel('/v/pocket', POCKET);
    expect(model?.sampleReference).toBe('/v/pocket/test_wavs/bria.wav');
    // A character clip wins over it; a non-cloning engine gets neither.
    expect(referenceFor(model!, '/packs/luna/voice.wav')).toBe('/packs/luna/voice.wav');
    expect(referenceFor(model!, undefined)).toBe('/v/pocket/test_wavs/bria.wav');
    expect(referenceFor(detectVoiceModel('/v/kokoro-x', KOKORO)!, '/packs/luna/voice.wav')).toBeUndefined();
  });

  it('prefers an int8 build when a role has several candidates', () => {
    const model = detectVoiceModel('/v/pocket', { ...POCKET, files: [...POCKET.files, 'decoder.onnx'] });
    expect(model?.files['pocket-decoder']).toBe('/v/pocket/decoder.int8.onnx');
  });

  it('separates Kokoro from Kitten by directory name, since their file shapes are identical', () => {
    expect(detectVoiceModel('/v/kokoro-multi-lang-v1_0', KOKORO)?.engine).toBe('kokoro');
    expect(detectVoiceModel('/v/kitten-nano-en-v0_1', KOKORO)?.engine).toBe('kitten');
    // An `rp-voice.json` marker settles a directory whose name says nothing.
    expect(detectVoiceModel('/v/my-voice', KOKORO)?.engine).toBe('kokoro');
    expect(detectVoiceModel('/v/my-voice', KOKORO, 'kitten')?.engine).toBe('kitten');
  });

  it('picks up Kokoro’s optional espeak data and dict directories', () => {
    const f = detectVoiceModel('/v/kokoro', KOKORO)!.files;
    expect(f['kokoro-data-dir']).toBe('/v/kokoro/espeak-ng-data');
    expect(f['kokoro-dict-dir']).toBe('/v/kokoro/dict');
  });

  it('falls back to VITS for a bare onnx beside a tokens.txt', () => {
    const model = detectVoiceModel('/v/en_GB-alba-medium', VITS);
    expect(model?.engine).toBe('vits');
    expect(model?.files['vits-model']).toBe('/v/en_GB-alba-medium/en_GB-alba-medium.onnx');
  });

  it('returns nothing for a directory that is no engine, so stray folders are skipped', () => {
    expect(detectVoiceModel('/v/notes', { files: ['readme.txt'], dirs: [] })).toBeUndefined();
    // A Pocket directory missing one required file is not half-recognised.
    expect(detectVoiceModel('/v/pocket', { ...POCKET, files: POCKET.files.filter((f) => f !== 'vocab.json') })).toBeUndefined();
  });
});

describe('buildSherpaArgs', () => {
  const pocket = detectVoiceModel('/v/pocket', POCKET)!;
  const kokoro = detectVoiceModel('/v/kokoro', KOKORO)!;

  it('puts the text last as the single positional argument', () => {
    const args = buildSherpaArgs(pocket, { text: 'Hello "there", friend', outFile: '/tmp/a.wav', reference: '/r.wav' });
    expect(args[args.length - 1]).toBe('Hello "there", friend');
    // Quotes and commas survive untouched: argv is passed as an array, never through a shell.
    expect(args.filter((a) => !a.startsWith('--'))).toEqual(['Hello "there", friend']);
  });

  it('passes the reference audio for a cloning engine and the speaker id for a bank engine', () => {
    const cloned = flags(buildSherpaArgs(pocket, { text: 'hi', outFile: '/tmp/a.wav', reference: '/r.wav', speaker: 3 }));
    expect(cloned['reference-audio']).toBe('/r.wav');
    expect(cloned['sid']).toBeUndefined(); // a clone has no speaker bank to index into

    const banked = flags(buildSherpaArgs(kokoro, { text: 'hi', outFile: '/tmp/a.wav', speaker: 3, reference: '/r.wav' }));
    expect(banked['sid']).toBe('3');
    expect(banked['reference-audio']).toBeUndefined();
  });

  it('falls back to the model’s own sample when no reference is given', () => {
    expect(flags(buildSherpaArgs(pocket, { text: 'hi', outFile: '/tmp/a.wav' }))['reference-audio']).toBe('/v/pocket/test_wavs/bria.wav');
  });

  it('carries speed, steps, threads and the output path', () => {
    const f = flags(buildSherpaArgs(pocket, { text: 'hi', outFile: '/tmp/out.wav', rate: 1.2, steps: 8, numThreads: 4, reference: '/r.wav' }));
    expect(f['output-filename']).toBe('/tmp/out.wav');
    expect(f['speed']).toBe('1.2');
    expect(f['num-steps']).toBe('8');
    expect(f['num-threads']).toBe('4');
  });

  it('leaves optional settings off entirely rather than sending empty flags', () => {
    const args = buildSherpaArgs(kokoro, { text: 'hi', outFile: '/tmp/a.wav' });
    expect(args.some((a) => a.startsWith('--speed'))).toBe(false);
    expect(args.some((a) => a.startsWith('--num-steps'))).toBe(false);
    expect(args.some((a) => a.endsWith('='))).toBe(false);
  });
});

describe('findSherpaTts', () => {
  const opts = { resourcesDirs: ['/app/resources'], exists: (f: string) => f === '/app/resources/bin/sherpa-onnx-offline-tts' || f === '/custom/tts', onPath: () => false };

  it('prefers the env override, then bundled resources, then PATH', () => {
    expect(findSherpaTts({ ...opts, env: { RP_SHERPA_TTS: '/custom/tts' } })).toBe('/custom/tts');
    expect(findSherpaTts({ ...opts, env: {} })).toBe('/app/resources/bin/sherpa-onnx-offline-tts');
    expect(findSherpaTts({ ...opts, env: {}, exists: () => false, onPath: () => true })).toBe('sherpa-onnx-offline-tts');
    expect(findSherpaTts({ ...opts, env: {}, exists: () => false })).toBeUndefined();
  });

  it('ignores an env override pointing at nothing', () => {
    expect(findSherpaTts({ ...opts, env: { RP_SHERPA_TTS: '/gone' } })).toBe('/app/resources/bin/sherpa-onnx-offline-tts');
  });

  it('prefers the version the app fetched over whatever is on PATH', () => {
    // A distro's older build may predate Pocket TTS and would reject --pocket-* at speaking time;
    // the fetched one is pinned to a version whose flags are known to match.
    const managed = '/data/sherpa/v1.13.8/bin/sherpa-onnx-offline-tts';
    expect(findSherpaTts({ env: {}, resourcesDirs: [], exists: (f) => f === managed, onPath: () => true, managed })).toBe(managed);
    // Not yet fetched: PATH still serves.
    expect(findSherpaTts({ env: {}, resourcesDirs: [], exists: () => false, onPath: () => true, managed })).toBe('sherpa-onnx-offline-tts');
    // A bundled build and an explicit override both still outrank it.
    expect(findSherpaTts({ ...opts, env: {}, managed })).toBe('/app/resources/bin/sherpa-onnx-offline-tts');
  });
});

describe('supportedEngines', () => {
  it('reports the cloning engines', () => {
    expect(supportedEngines().find((e) => e.id === 'pocket')).toMatchObject({ label: 'Pocket TTS', clones: true });
    expect(supportedEngines().find((e) => e.id === 'qwen')).toMatchObject({ label: 'Qwen3-TTS', clones: true });
    // The speaker-bank engines are the rest; a new cloning engine should have to say so here.
    expect(supportedEngines().filter((e) => e.clones).map((e) => e.id).sort()).toEqual(['pocket', 'qwen']);
  });
});

describe('Qwen3-TTS', () => {
  it('recognises a model directory by its weights and speech tokenizer', () => {
    const model = detectVoiceModel('/v/qwen3-tts-0.6b', QWEN);
    expect(model?.engine).toBe('qwen');
    expect(model?.clones).toBe(true);
    expect(model?.dir).toBe('/v/qwen3-tts-0.6b');
  });

  it('is not matched by a bare safetensors directory with no speech tokenizer', () => {
    // Required rules cover directories as well as files, so a plain transformer checkout dropped
    // into voices/ is rejected rather than driven as a TTS model.
    expect(detectVoiceModel('/v/some-llm', { files: ['config.json', 'model.safetensors'], dirs: [] })).toBeUndefined();
  });

  it('does not swallow the sherpa engines, nor they it', () => {
    expect(detectVoiceModel('/v/pocket', POCKET)?.engine).toBe('pocket');
    expect(detectVoiceModel('/v/kokoro', KOKORO)?.engine).toBe('kokoro');
    expect(detectVoiceModel('/v/alba', VITS)?.engine).toBe('vits');
  });

  it('is the one engine that is not driven through sherpa', () => {
    expect(usesSherpa('qwen')).toBe(false);
    for (const e of supportedEngines().filter((s) => s.id !== 'qwen')) expect(usesSherpa(e.id)).toBe(true);
  });

  it('finds its binary by env override first, then PATH', () => {
    const opts = { resourcesDirs: [], exists: (f: string) => f === '/opt/qwen_tts', onPath: (n: string) => n === 'qwen_tts' };
    expect(findQwenTts({ ...opts, env: { RP_QWEN_TTS: '/opt/qwen_tts' } })).toBe('/opt/qwen_tts');
    expect(findQwenTts({ ...opts, env: {} })).toBe('qwen_tts');
    // An override pointing at nothing falls through rather than failing the lookup outright.
    expect(findQwenTts({ ...opts, env: { RP_QWEN_TTS: '/nope' } })).toBe('qwen_tts');
  });

  it('does not answer with the sherpa binary, or the other way round', () => {
    const opts = { env: { RP_QWEN_TTS: '/opt/qwen_tts' }, resourcesDirs: [], exists: (f: string) => f === '/opt/qwen_tts', onPath: () => false };
    expect(findQwenTts(opts)).toBe('/opt/qwen_tts');
    expect(findSherpaTts(opts)).toBeUndefined();
  });
});
