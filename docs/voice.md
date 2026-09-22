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

## Qwen3-TTS

A second engine, opt-in per character, driven by its own `qwen_tts` binary rather than sherpa. It
sounds considerably better than Pocket TTS on cloned voices, which is the only reason it is here —
everything below is the price of that.

### It is a subprocess, and that is deliberate

The binary holds **~3 GB resident** while it runs. Keeping that alive beside a local LLM for a voice
that speaks a few seconds a minute is a bad trade, so `QwenRunner` spawns one process per line and
lets the memory go. Model load is ~0.5 s, which a chat turn absorbs.

Do not "optimise" this into the binary's `--serve` mode without re-reading the next section.

### Server mode clamps temperature; the command line does not

`qwen_tts_server.c` runs every request through `clampf(…, 0.0f, 2.0f)`. The CLI's `-T` has no such
clamp. This is silent: a fixed-seed sweep returns **one bit-identical output for every value from
2.25 to 8.00**, and only 1.00 and 0.50 differ.

The tuned default is T 2.5, *above* that clamp, so the CLI path is not a stylistic preference — it
is the only path on which the configured temperature is the one actually used.

### `/v1/health` lies

The server answers `503 {"status":"unavailable","scheduler":"down"}` on an engine that renders
perfectly. Treat any HTTP answer as "up"; a connection failure is the only real signal.

### Sampling

Chosen by ear across the full range, not taken from upstream:

| knob | value | why |
| --- | --- | --- |
| temperature | 2.5 | below ~1.2 nothing changes audibly; above ~6 it degenerates (8.0 returns ~1 s) |
| top-k | 10 | rank-based, so temperature never changes *which* tokens survive it |
| top-p | 0.4 | computed on temperature-softened probabilities, so this is the knob that counteracts a high temperature |
| rep penalty | 2.0 | the server's clamp ceiling; speech is legitimately repetitive, so higher would fight the signal |

A high temperature with both filters open is the least constrained setting available and is what
produced collapsed takes. Tighten the nucleus before lowering the temperature.

### Generation collapses silently

The binary exits **0** and writes a valid wav that simply stops after a syllable or two. Measured at
2 renders in 5 on long input before the nucleus was tightened. Nothing else catches this, so
`QwenRunner` measures every take against ~15 characters/second and re-rolls once below 45% of that.

### Coherence runs out around 20 s of audio

Not a buffer: the codec runs at 12.5 Hz and the talker's KV cache starts at 2048 slots, which is
~163 s of headroom. It is the model losing the thread. Character lines run 10–30 s, inside that, and
a whole take reads better than a stitched one — so unlike the sherpa path, nothing is chunked here.
If long-form narration is ever wanted, split on sentence boundaries and expect the joins to cost
some flow.

### Voices are `.qvoice` profiles, not wavs

The playback model cannot clone from audio directly. A character's `voice.reference` must point at a
`.qvoice` (16–25 MB); anything else is ignored and the model speaks in one of its own voices, which
is a usable result rather than an error. The editor's picker follows the selected engine — profiles
for Qwen, recordings for the sherpa engines — so an author cannot pick a file the engine will drop
on the floor. A profile starts with the ASCII magic `QVCE` and a little-endian version, which is the
only check available on an otherwise opaque file. Building a profile needs the **Base** model — a second
2.4 GB download — and is therefore fetched only when an author actually builds one.

### Distribution

Upstream (`gabriele-mastrapasqua/qwen3-tts`, MIT) publishes **no releases or tags** — source only,
so there is no prebuilt binary to fetch the way sherpa's is.

The binary is therefore built at package time. `scripts/build-native.mjs` clones the pinned commit
into `native/qwen3-tts/` (gitignored) and runs `make blas`, copying the result to
`resources/bin/qwen_tts`, where `findQwenTts` already looks. It is ~1.3 MB, so it costs the
installer almost nothing. Like the other native pieces it **skips with a notice** when its
toolchain is missing, so a machine without a compiler still gets a working app on Pocket TTS.

Two traps in that Makefile, both of which produce a build that looks fine:

- its Linux branch links OpenBLAS unconditionally, so without `libopenblas-dev` the build gets all
  the way to the final link before failing — the script checks `pkg-config openblas` up front and
  CI installs the package;
- its SIMD detection targets the **build** host. Left alone, a CI runner with AVX-512 emits an
  `avx512bf16` binary that is an illegal instruction on most consumer CPUs the first time a
  character speaks. `SIMD=portable` is mandatory for anything shipped, and upstream's own build
  banner says so in passing — it is easy to read straight past.

The **weights** are a separate matter: ~2.5 GB, fetched from Hugging Face file by file (there is no
archive) by `qwen-install.ts`, and deliberately **not** on first start the way the 98 MB Pocket
model is. The pack editor offers the download when the engine is present and the weights are not.
Files land in a `.incoming` directory renamed into place only once every one is the right size, so
a half download is never visible to the model scanner, and a retry skips whatever already arrived.
Sizes are pinned per file — the repository publishes no checksums — so changing the revision means
re-checking every one. `--int8` quantises at load, so there is no smaller on-disk form.

## Changing dependencies

CI installs with `--frozen-lockfile`, so adding a dependency to a `package.json` without
regenerating `pnpm-lock.yaml` fails the build before any test runs. `pnpm` may not be on PATH
locally; the repo pins a version in `packageManager`:

```bash
npx --yes pnpm@10.33.0 install --lockfile-only
```

A hand-spliced `node_modules` (see the worktree notes) sidesteps the lockfile entirely, so a green
local run says nothing about whether CI will install.
