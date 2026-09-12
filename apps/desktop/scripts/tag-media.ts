#!/usr/bin/env -S node --experimental-transform-types --no-warnings
/**
 * Auto-tag a pack's media from the command line and save `media.json`.
 *
 *   node --experimental-transform-types apps/desktop/scripts/tag-media.ts <pack-dir> [asset …] [options]
 *
 * Same prompt, same model call and the same media.json semantics as the editor's "Auto-tag…"
 * dialog, without Electron: the prompt building, answer parsing, merge rules and the manifest
 * writer are imported from the app (`MediaTagger`, `applySuggestions`, `writeMediaManifest`) so
 * the two cannot drift. Only the two things that needed a browser are reimplemented here —
 * images are decoded with ImageMagick instead of Electron's `nativeImage`, and video frames are
 * grabbed with ffmpeg instead of a `<video>` element.
 *
 * Unlike the editor, this writes: suggestions are folded into media.json and saved (`--dry-run`
 * shows what would change instead).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import type {
  AssetEntry,
  ContentPart,
  LlmChatRequest,
  LlmProvider,
  LlmReasoningEffort,
  LlmStreamHandlers,
  MediaManifest,
  MediaTagSuggestion,
  ProviderConfig,
  ProviderKind,
} from '@rp/shared';
import { MEDIA_MANIFEST_FILENAME } from '@rp/shared';
import {
  DEFAULT_MEDIA_ROOT,
  folderTagsFor,
  globToRegExp,
  indexAssets,
  inspectPack,
  matchesGlob,
  validateMediaManifest,
  writeMediaManifest,
} from '@rp/pack';
import { createProvider } from '@rp/llm';
import { MediaTagger, TAG_IMAGE_MAX_PX, absorbSuggestion } from '../src/main/editor/tagger.ts';
import type { ImageReader, TagAsset, TagPackContext } from '../src/main/editor/tagger.ts';
import { fromEditModel, toEditModel } from '../src/renderer/lib/editor.ts';
import type { MediaEditModel } from '../src/renderer/lib/editor.ts';
import { applySuggestions, summarise } from '../src/renderer/lib/tagging.ts';

const DEFAULTS = {
  baseUrl: process.env.RP_TAG_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey: process.env.RP_TAG_API_KEY ?? 'ollama',
  model: process.env.RP_TAG_MODEL ?? 'hf.co/yaruti/nsfwvision-v4_qwen3.5-9b-gguf:Q4_K_M',
  kind: (process.env.RP_TAG_KIND ?? 'openai-compatible') as ProviderKind,
};

const USAGE = `Usage: tag-media.ts <pack-dir> [asset …] [options]

Assets may be pack-relative paths, absolute paths inside the pack, directories or globs
("media/images/**"). With none given, every untagged asset is tagged (--scope all for all).

Model
  --model <id>           default: ${DEFAULTS.model}
  --base-url <url>       default: ${DEFAULTS.baseUrl}
  --api-key <key>        default: ${DEFAULTS.apiKey} (placeholder for local servers)
  --kind <kind>          openai-compatible | anthropic | mock (default: ${DEFAULTS.kind})
  --no-vision            the model cannot see images (tag from file names only)

Tagging
  --scope <untagged|all> which assets when none are named (default: untagged)
  --max-tags <n>         most tags per asset, 1-20 (default: 6)
  --guidance <text>      extra instruction for the model
  --vocabulary-only      never invent a tag; use only tags the pack knows
  --no-json-schema       describe the answer shape in the prompt only, instead of constraining
                         it with response_format (needed by servers that reject a schema)
  --reasoning-effort <e> none | low | medium | high | max (default: none). "none" stops a
                         thinking model deliberating for thousands of tokens before it answers;
                         a model whose template has no thinking switch ignores it

Saving
  --replace-tags         replace an asset's tags instead of adding to them
  --overwrite-descriptions  overwrite descriptions that are already written
  --no-vocabulary        do not add invented tags to the media.json vocabulary
  --dry-run              print what would change, write nothing
  --json                 print the raw suggestions as JSON
  --debug                print every request (prompt, parameters, image sizes) and stream the
                         answer token by token, including the thinking a model emits
  -h, --help             this text

Environment: RP_TAG_MODEL, RP_TAG_BASE_URL, RP_TAG_API_KEY, RP_TAG_KIND.`;

// ---------------------------------------------------------------------------
// Media decoding (ImageMagick / ffmpeg stand in for nativeImage and <video>)
// ---------------------------------------------------------------------------

/** Run a command and capture stdout as bytes; rejects with stderr when it fails. */
function exec(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 300)}`));
    });
  });
}

async function has(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Longest edge down to `maxPx`, aspect kept (never upscales) — mirrors the app's `fitWithin`. */
function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxPx || longest === 0) return { width, height };
  const scale = maxPx / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * ImageMagick `ImageReader`: decode any image the app can show (WebP, AVIF, GIF, BMP, SVG …),
 * downscale to `maxPx` and keep alpha as PNG — opaque art goes as JPEG, which is a fraction of
 * the bytes over the wire to a local server. `[0]` takes the first frame of an animation.
 */
function magickImageReader(): ImageReader {
  return async (absolutePath, maxPx) => {
    const frame = `${absolutePath}[0]`;
    let width = 0;
    let height = 0;
    let opaque = true;
    try {
      const info = (await exec('magick', ['identify', '-format', '%w %h %[opaque]', frame])).toString().trim().split(/\s+/);
      width = Number(info[0]);
      height = Number(info[1]);
      opaque = info[2] !== 'false';
    } catch {
      return undefined;
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0) return undefined;
    const target = fitWithin(width, height, maxPx);
    const resize = ['-resize', `${maxPx}x${maxPx}>`];
    try {
      const data = opaque
        ? await exec('magick', [frame, ...resize, '-background', 'white', '-alpha', 'remove', '-quality', '82', 'jpeg:-'])
        : await exec('magick', [frame, ...resize, 'png:-']);
      return { mime: opaque ? 'image/jpeg' : 'image/png', data: data.toString('base64'), ...target };
    } catch {
      return undefined;
    }
  };
}

/** A PNG frame from the middle of a video, base64, the way the renderer's `<video>` grab does it. */
async function videoFrame(absolutePath: string, maxPx: number): Promise<string | undefined> {
  let seconds = 1;
  try {
    const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absolutePath]);
    const duration = Number(probe.toString().trim());
    if (Number.isFinite(duration) && duration > 0) seconds = duration / 2;
  } catch {
    // No ffprobe, or a stream with no duration: one second in is better than nothing.
  }
  try {
    const png = await exec('ffmpeg', [
      '-v', 'error', '-ss', seconds.toFixed(3), '-i', absolutePath,
      '-frames:v', '1', '-vf', `scale='min(${maxPx},iw)':-2`, '-f', 'image2', '-c:v', 'png', 'pipe:1',
    ]);
    return png.length > 0 ? png.toString('base64') : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// --debug: show the conversation
// ---------------------------------------------------------------------------

const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const dim = (text: string): string => (useColour ? `\u001b[2m${text}\u001b[0m` : text);
const bold = (text: string): string => (useColour ? `\u001b[1m${text}\u001b[0m` : text);

function describePart(part: ContentPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'image') return `[${part.mime}, ${(Buffer.from(part.data, 'base64').length / 1024).toFixed(1)} KB of base64 image]`;
  return `[${part.type}]`;
}

function printRequest(request: LlmChatRequest): void {
  const params = [
    `model=${request.model}`,
    `temperature=${request.temperature}`,
    `max_tokens=${request.maxTokens}`,
    `response_format=${request.responseFormat ? `${request.responseFormat.type}` : 'none'}`,
    `reasoning_effort=${request.reasoningEffort ?? 'unset'}`,
  ];
  console.log(`\n${bold('── request ─────────────────────────────────────────')}`);
  console.log(dim(params.join('  ')));
  console.log(`${bold('system:')}\n${dim(request.system)}`);
  for (const message of request.messages) {
    console.log(`${bold(`${message.role}:`)}\n${dim(message.content.map(describePart).join('\n'))}`);
  }
  console.log(bold('── answer ──────────────────────────────────────────'));
}

/**
 * Wraps a provider so `--debug` can show what actually goes over the wire and what comes back as
 * it arrives. Ollama reports a thinking model's deliberation separately, so a long silence here
 * followed by nothing is the model thinking its budget away.
 */
function debugging(inner: LlmProvider): LlmProvider {
  const wrapped: LlmProvider = {
    kind: inner.kind,
    id: inner.id,
    config: inner.config,
    async chat(request: LlmChatRequest, handlers: LlmStreamHandlers = {}) {
      printRequest(request);
      const started = Date.now();
      let streamed = false;
      const response = await inner.chat(request, {
        ...handlers,
        onTextDelta: (delta) => {
          streamed = true;
          process.stdout.write(dim(delta));
          handlers.onTextDelta?.(delta);
        },
      });
      if (!streamed) console.log(dim('(nothing streamed — the model returned no text content)'));
      const { inputTokens, outputTokens } = response.usage;
      console.log(
        `\n${dim(`stop=${response.stopReason}  in=${inputTokens} out=${outputTokens} tokens  ${((Date.now() - started) / 1000).toFixed(1)}s`)}\n`,
      );
      return response;
    },
  };
  if (inner.listModels) wrapped.listModels = () => inner.listModels!();
  if (inner.test) wrapped.test = () => inner.test!();
  return wrapped;
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

interface PackState {
  dir: string;
  mediaRoot: string;
  manifest: MediaManifest;
  assets: AssetEntry[];
  /** Per asset: folder tags, the tags media.json gives it, and its current description. */
  meta: Map<string, { folderTags: string[]; manifestTags: string[]; description?: string }>;
  context: TagPackContext;
}

async function readPack(dir: string): Promise<PackState> {
  const { pack, problems } = await inspectPack(dir);
  if (!pack) throw new Error(`Not a readable pack at ${dir}:\n  ${problems.join('\n  ')}`);
  const mediaRoot = pack.manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT;

  // Read media.json ourselves: a broken one must stop the run, not be silently replaced.
  const manifestPath = path.join(dir, MEDIA_MANIFEST_FILENAME);
  let manifest: MediaManifest = { entries: [] };
  try {
    manifest = validateMediaManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`${MEDIA_MANIFEST_FILENAME} cannot be read, fix it first:\n  ${(err as Error).message}`);
    }
  }

  const assets = await indexAssets(dir, mediaRoot, manifest);
  const rules = manifest.entries.map((e) => ({ e, re: globToRegExp(e.match) }));
  const meta: PackState['meta'] = new Map();
  for (const asset of assets) {
    const manifestTags = new Set<string>();
    for (const { e, re } of rules) if (re.test(asset.path)) for (const t of e.tags ?? []) manifestTags.add(t);
    const description = manifest.entries
      .filter((e) => e.match.replace(/^\.?\//, '') === asset.path)
      .map((e) => e.description)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .at(-1);
    meta.set(asset.path, {
      folderTags: manifest.folderTags === false ? [] : folderTagsFor(asset.path, mediaRoot),
      manifestTags: [...manifestTags].sort(),
      ...(description ? { description } : {}),
    });
  }

  const counts = new Map<string, number>();
  for (const asset of assets) for (const tag of asset.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const context: TagPackContext = {
    id: pack.manifest.id,
    name: pack.manifest.name,
    ...(pack.manifest.description ? { description: pack.manifest.description } : {}),
    characters: pack.characters.map((c) => c.definition.name),
    vocabulary: manifest.tags ?? {},
    knownTags: [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tag]) => tag),
  };
  return { dir, mediaRoot, manifest, assets, meta, context };
}

/**
 * The assets to tag: the ones named on the command line (paths, directories or globs), or — with
 * none named — the untagged ones. "Untagged" is the editor's own notion: no tags or description of
 * its own in the draft, so a file that only a glob rule covers still counts as untagged.
 */
function selectAssets(state: PackState, model: MediaEditModel, wanted: string[], scope: string): AssetEntry[] {
  if (wanted.length === 0) {
    if (scope === 'all') return [...state.assets];
    return state.assets.filter((a) => {
      const edit = model.perAsset[a.path];
      return (edit?.tags.length ?? 0) === 0 && (edit?.description.trim().length ?? 0) === 0;
    });
  }
  const out = new Map<string, AssetEntry>();
  for (const raw of wanted) {
    const rel = (path.isAbsolute(raw) ? path.relative(state.dir, raw) : raw).split(path.sep).join('/').replace(/^\.\//, '');
    if (rel.startsWith('..')) throw new Error(`"${raw}" is outside the pack`);
    const dir = `${rel.replace(/\/$/, '')}/`;
    const hits = state.assets.filter((a) => a.path === rel || a.path.startsWith(dir) || matchesGlob(rel, a.path));
    if (hits.length === 0) throw new Error(`"${raw}" matches no asset of this pack`);
    for (const hit of hits) out.set(hit.path, hit);
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const BASIS_NOTE: Record<string, string> = {
  image: '',
  frame: ' (from a video frame)',
  text: ' (from the text)',
  filename: ' (from the file name only)',
};

function report(before: MediaEditModel, after: MediaEditModel, suggestions: MediaTagSuggestion[]): number {
  let changed = 0;
  for (const s of suggestions) {
    if (s.error) {
      console.error(`  ✗ ${s.path}: ${s.error}`);
      continue;
    }
    const was = before.perAsset[s.path] ?? { tags: [], description: '' };
    const now = after.perAsset[s.path] ?? was;
    const addedTags = now.tags.filter((t) => !was.tags.includes(t));
    const droppedTags = was.tags.filter((t) => !now.tags.includes(t));
    const newDescription = now.description !== was.description ? now.description : '';
    if (addedTags.length === 0 && droppedTags.length === 0 && !newDescription) {
      console.log(`  · ${s.path}: nothing to add`);
      continue;
    }
    changed += 1;
    const parts: string[] = [];
    if (addedTags.length > 0) parts.push(`+${addedTags.join(' +')}`);
    if (droppedTags.length > 0) parts.push(`-${droppedTags.join(' -')}`);
    console.log(`  ✓ ${s.path}${BASIS_NOTE[s.basis] ?? ''}: ${parts.join(' ')}`);
    if (newDescription) console.log(`      "${newDescription}"`);
  }
  // Only rows with a meaning are saved (media.json has no room for a blank one), so only those are
  // reported as vocabulary; the rest are simply tags in use that nobody has explained yet.
  const added = Object.keys(after.vocabulary).filter((t) => !(t in before.vocabulary));
  const documented = added.filter((t) => after.vocabulary[t]?.trim());
  if (documented.length > 0) {
    console.log(`\n  vocabulary + ${documented.length}:`);
    for (const tag of documented) console.log(`      ${tag}: ${after.vocabulary[tag]}`);
  }
  const undocumented = added.filter((t) => !after.vocabulary[t]?.trim());
  if (undocumented.length > 0) {
    console.log(`\n  ${undocumented.length} new tag${undocumented.length === 1 ? '' : 's'} with no meaning yet: ${undocumented.join(', ')}`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      kind: { type: 'string' },
      'no-vision': { type: 'boolean' },
      scope: { type: 'string', default: 'untagged' },
      'max-tags': { type: 'string' },
      guidance: { type: 'string' },
      'vocabulary-only': { type: 'boolean' },
      'no-json-schema': { type: 'boolean' },
      'reasoning-effort': { type: 'string', default: 'none' },
      'replace-tags': { type: 'boolean' },
      'overwrite-descriptions': { type: 'boolean' },
      'no-vocabulary': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      debug: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (values.scope !== 'untagged' && values.scope !== 'all') throw new Error('--scope must be "untagged" or "all"');
  const efforts = ['none', 'low', 'medium', 'high', 'max'];
  if (!efforts.includes(values['reasoning-effort'] ?? 'none')) throw new Error(`--reasoning-effort must be one of ${efforts.join(', ')}`);

  const state = await readPack(path.resolve(positionals[0]!));
  const before = toEditModel(state.manifest, state.assets.map((a) => a.path));
  const assets = selectAssets(state, before, positionals.slice(1), values.scope);
  if (assets.length === 0) {
    console.log(values.scope === 'all' ? 'This pack has no media to tag.' : 'Every asset is already tagged (--scope all to redo them).');
    return 0;
  }

  const config: ProviderConfig = {
    id: 'cli',
    kind: (values.kind ?? DEFAULTS.kind) as ProviderKind,
    label: 'tag-media.ts',
    model: values.model ?? DEFAULTS.model,
    baseUrl: values['base-url'] ?? DEFAULTS.baseUrl,
    apiKey: values['api-key'] ?? DEFAULTS.apiKey,
    supportsVision: values['no-vision'] !== true,
    supportsTools: false,
  };
  const needsImages = assets.some((a) => a.kind === 'image' || a.kind === 'video');
  if (needsImages && !(await has('magick'))) {
    throw new Error('ImageMagick ("magick") is needed to decode images here. Install it, or pass only non-image assets.');
  }

  const tagger = new MediaTagger({
    resolveProvider: async () => config,
    providerFactory: (cfg) => (values.debug ? debugging(createProvider(cfg)) : createProvider(cfg)),
    readImage: magickImageReader(),
    logger: console,
  });
  const options = {
    ...(values['max-tags'] ? { maxTags: Number(values['max-tags']) } : {}),
    ...(values.guidance ? { guidance: values.guidance } : {}),
    vocabularyOnly: values['vocabulary-only'] === true,
    // On by default here (the editor leaves it off): a local reasoning model otherwise spends its
    // whole token budget thinking and answers nothing.
    jsonSchema: values['no-json-schema'] !== true,
    // "none" by default: a thinking model otherwise spends its whole budget deliberating and
    // answers nothing. Servers and models that do not know the switch simply ignore it.
    ...(values['reasoning-effort'] ? { reasoningEffort: values['reasoning-effort'] as LlmReasoningEffort } : {}),
  };
  const run = await tagger.start(options);
  console.log(`${state.context.name}: tagging ${assets.length} asset${assets.length === 1 ? '' : 's'} with ${run.model} at ${config.baseUrl}\n`);

  const suggestions: MediaTagSuggestion[] = [];
  // Grows as the run goes: what one asset coins, the next one is offered (see `absorbSuggestion`).
  let context = state.context;
  for (const [i, asset] of assets.entries()) {
    process.stdout.write(`[${i + 1}/${assets.length}] ${asset.path} … `);
    const meta = state.meta.get(asset.path) ?? { folderTags: [], manifestTags: [] };
    const frame = asset.kind === 'video' ? await videoFrame(path.join(state.dir, asset.path), TAG_IMAGE_MAX_PX) : undefined;
    const target: TagAsset = {
      path: asset.path,
      kind: asset.kind,
      mime: asset.mime,
      bytes: asset.bytes,
      absolutePath: path.join(state.dir, ...asset.path.split('/')),
      folderTags: meta.folderTags,
      tags: meta.manifestTags,
      ...(meta.description ? { description: meta.description } : {}),
      ...(frame ? { frame } : {}),
    };
    const started = Date.now();
    const suggestion = await tagger.suggestOne(run, context, target, options);
    suggestions.push(suggestion);
    context = absorbSuggestion(context, suggestion);
    console.log(suggestion.error ? 'failed' : `${suggestion.tags.length} tags, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  if (values.json) console.log(`\n${JSON.stringify(suggestions, null, 2)}`);

  const after = applySuggestions(before, suggestions, {
    replaceTags: values['replace-tags'] === true,
    overwriteDescriptions: values['overwrite-descriptions'] === true,
    addToVocabulary: values['no-vocabulary'] !== true,
  });
  console.log(`\n${summarise(suggestions)}\n`);
  const changed = report(before, after, suggestions);

  const next = fromEditModel(after);
  // `applySuggestions` records an invented tag even when the model gave no meaning, but media.json
  // has no room for an empty one — keep the tag, drop the blank vocabulary row.
  if (next.tags) {
    const kept = Object.entries(next.tags).filter(([, meaning]) => meaning.trim().length > 0);
    if (kept.length > 0) next.tags = Object.fromEntries(kept);
    else delete next.tags;
  }

  if (changed === 0) {
    console.log('\nNothing to save.');
    return suggestions.some((s) => s.error) ? 1 : 0;
  }
  if (values['dry-run']) {
    console.log(`\n--dry-run: ${MEDIA_MANIFEST_FILENAME} left alone. It would become:\n`);
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }
  await writeMediaManifest(state.dir, next);
  console.log(`\nSaved ${path.join(state.dir, MEDIA_MANIFEST_FILENAME)} (${changed} asset${changed === 1 ? '' : 's'} changed).`);
  return suggestions.some((s) => s.error) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
