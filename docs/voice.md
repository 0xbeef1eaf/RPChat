# Voice: measured behaviour and traps

`docs/spec/living.md` §4a describes how the voice subsystem is built. This file records what was
learned by measuring it — the constraints that are not visible in the code, the places where the
obvious assumption is wrong, and the false leads that cost real time.

Everything below was measured on a CPU (4 threads) with `sherpa-onnx-pocket-tts-int8-2026-01-26`,
unless it says otherwise. Where something is assumed rather than tested, it says so.

## Debug voice problems in Electron, never in plain node

The single most expensive mistake available here. A script that requires `sherpa-onnx-node` and
synthesises successfully proves **nothing** about the app: the addon behaves differently under
Electron's V8. Every reproduction attempt for the "TTS settlement failed" bug passed in node
(12/12, both code paths) while the app failed every time.

To test the way the app runs:

```bash
apps/desktop/node_modules/electron/dist/electron --no-sandbox --headless --disable-gpu your-test.js
```

`app.whenReady()` then `require('sherpa-onnx-node')`. No window is needed.

### Error strings from the addon are not in `app.asar`

When an error message cannot be found in the bundle, it is probably the addon's. The native
libraries are unpacked beside the archive:

```
resources/app.asar.unpacked/node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node
```

`grep -a` those (`grep` without `-a` reports nothing useful on a binary and is easy to misread as
"not found"). `"TTS settlement failed"` lives in `sherpa-onnx.node`, not in any TypeScript.

## `enableExternalBuffer: false` is mandatory

The addon defaults to returning an `ArrayBuffer` backed by native memory outside V8's cage. Electron
builds V8 with pointer compression and the sandbox, which reject that, and the addon reports the
refusal through a catch-all as a bare `TTS settlement failed` with the real cause discarded.

| environment | `enableExternalBuffer` | result |
| --- | --- | --- |
| Electron | `true` (the default) | 0/4 — `TTS settlement failed` |
| Electron | `false` | 4/4 |
| node | either | 12/12 |

Deterministic, not a race. `voice-engine.ts` passes `false` on every call and a test asserts it.

This is **not** a memory-safety problem, despite how the addon's settle path reads. The `ArrayBuffer`
is held in a live handle across the pointer reads that look suspicious, and a GC-pressure test found
no failures. V8 refusing the buffer is the sandbox working, not being bypassed. Worth an upstream
bug report; not worth a security report.

## What the command line cannot do

`sherpa-onnx-offline-tts` forwards only `emotion_id` and `lang` into the model's `extra` config.
`seed`, `temperature` and the chunking parameters are unreachable from it. That is the entire reason
the app uses the in-process addon and keeps the CLI only as a fallback. Do not "simplify" back to
spawning the binary without also giving up reproducible voices.

## Pocket TTS constraints

### Only the first 10 seconds of the reference are used

`max_reference_audio_len` defaults to 10 and the rest is truncated
(`offline-tts-pocket-impl.h`). Passing a larger value through the addon's `extra` **does not work** —
identical output at 10/15/20/25/30/35 s, and still identical with the voice-embedding cache disabled,
so it is not a caching artefact.

A longer clip is therefore not a better clip. The opening ten seconds are the whole voice, and
silence or throat-clearing at the head is spent budget. Strip internal silence *before* trimming to
10 s if the recording is gappy.

### Output is non-deterministic without a seed

`temperature` defaults to 0.7, so the same line varies run to run. Five renders of one sentence
spanned 7.5–8.9 s with different phrasing. A take that sounds good cannot be recovered unless its
seed was pinned, which is why the editor reports the seed it used.

Long text is chunked, and per-chunk seeds are `seed + index`: reproducible, but not identical across
sentences, which would give a paragraph one flat contour.

### Speed

RTF ≈ 0.32 (long text) to 0.38 (short) at 32 steps. Steps are cheap — 2 → 32 steps costs about 40%
more wall time, because the LM and conditioning dominate, not the flow steps. Do not trade quality
for speed here by default.

Model load is ~450 ms and happens once per model in `VoiceEngine`; the CLI paid it on every
utterance.

## Reference recordings

What actually matters, in order:

1. **Cleanliness.** The model clones room tone, mic colour and reverb as faithfully as timbre.
   kyutai ship `*_enhanced.wav` variants of whole collections for this reason.
2. **Continuous speech.** Aim for ~10 s with no gaps. Silence inside the first 10 s is budget spent
   on a room rather than a voice.
3. **Natural dynamics.** A heavily compressed source (RMS around −5 dBFS, crest ~5 dB) flattens
   delivery. Natural speech sits nearer a 20 dB crest.
4. **Format.** Mono 24 kHz 16-bit PCM — what every clip kyutai ship is, and what `readWavFile`
   accepts. It rejects anything else with a reason; 32-bit float is the common surprise.

Converting a source, with no denoise or normalisation when the audio is already clean:

```bash
ffmpeg -i input.mp4 -vn -ac 1 -ar 24000 -c:a pcm_s16le ref.wav
```

`silenceremove` with `stop_periods=-1` strips *every* silent run; the `areverse` sandwich form only
trims the ends. That distinction matters given the 10-second budget.

## Model evaluation

**ZipVoice was measured and rejected** — do not re-evaluate it on the strength of its paper without
re-measuring. Its headline "32.6× faster" is against a DiT baseline, not against Pocket TTS.

| | Pocket TTS | ZipVoice-Distill |
| --- | --- | --- |
| RTF, short line | 0.380 | 0.679 |
| RTF, long paragraph | 0.316 | 0.438 |
| download | 98 MB | 109 MB + 54 MB vocoder |
| reference transcript | not needed | **required** |

Quality was not compared — only speed and duration — so the verdict is "not faster and more
burdensome", not "sounds worse".

The genuinely stronger long-form models (F5-TTS, CosyVoice 2, VibeVoice, Kyutai TTS 1.6B) are
GPU-oriented, which conflicts with the reason this runs on the CPU at all: the GPU belongs to text
generation.

Neither model failed on long input. A 676-character paragraph renders in one call; chunking exists
for latency and for joins that land where a reader breathes, not because long text breaks.

## Changing dependencies

CI installs with `--frozen-lockfile`, so adding a dependency to a `package.json` without
regenerating `pnpm-lock.yaml` fails the build before any test runs. `pnpm` may not be on PATH
locally; the repo pins a version in `packageManager`:

```bash
npx --yes pnpm@10.33.0 install --lockfile-only
```

A hand-spliced `node_modules` (see the worktree notes) sidesteps the lockfile entirely, so a green
local run says nothing about whether CI will install.
