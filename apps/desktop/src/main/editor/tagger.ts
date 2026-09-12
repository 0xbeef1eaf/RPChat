/**
 * Auto-tagging for the pack editor: ask a vision model (qwen3-vl on a local OpenAI-compatible
 * server, Claude, …) what an asset shows, and turn the answer into `media.json` tags and a
 * description. Nothing is written here — the editor applies the suggestions to its draft.
 *
 * The prompt building and answer parsing are pure functions so they can be tested without a model;
 * decoding image files is injected (`readImage`) because it needs Electron's `nativeImage`.
 */
import * as fs from 'node:fs/promises';
import type {
  AssetKind,
  LlmChatRequest,
  LlmProvider,
  MediaTagBasis,
  MediaTagSuggestion,
  ProviderConfig,
  TagMediaOptions,
} from '@rp/shared';
import { RpError } from '@rp/shared';
import { MAX_DESCRIPTION_LENGTH, MAX_TAGS_PER_ASSET, normalizeTag } from '@rp/pack';
import { resolveSupportsVision } from '@rp/llm';

/** Longest edge an image is downscaled to before it is sent to the model. */
export const TAG_IMAGE_MAX_PX = 768;
/** Characters of a text asset shown to the model. */
export const TAG_TEXT_MAX_CHARS = 4_000;
/** How long one asset may take; local vision models are slow. */
export const TAG_TIMEOUT_MS = 180_000;
export const TAG_DEFAULT_MAX_TAGS = 6;
/**
 * A cap, not a target: the answer is a few dozen tokens, but local reasoning models spend hundreds
 * thinking first and return nothing at all when they are cut off mid-thought.
 */
export const TAG_MAX_TOKENS = 3_000;

export type TagImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface TagImage {
  mime: TagImageMime;
  /** Base64, no `data:` prefix. */
  data: string;
  width?: number;
  height?: number;
}

/** Decode an image file into a downscaled base64 payload; `undefined` when it cannot be read. */
export type ImageReader = (absolutePath: string, maxPx: number) => Promise<TagImage | undefined>;

/** The pack-wide context shown to the model so it reuses the vocabulary the author already has. */
export interface TagPackContext {
  id: string;
  name: string;
  description?: string;
  characters: string[];
  /** Tag → meaning from `media.json`. */
  vocabulary: Record<string, string>;
  /** Every tag in use across the pack, most common first. */
  knownTags: string[];
}

/** One asset to tag, as the editor knows it. */
export interface TagAsset {
  path: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  absolutePath: string;
  /** Tags the folder names already apply (never suggested again). */
  folderTags: string[];
  /** Tags the asset has in `media.json` today. */
  tags: string[];
  description?: string;
  /** Base64 PNG frame supplied by the renderer for a video. */
  frame?: string;
}

export interface TagContext {
  pack: TagPackContext;
  asset: TagAsset;
  basis: MediaTagBasis;
  maxTags: number;
  vocabularyOnly: boolean;
  guidance?: string;
  /** Size of the decoded image, when known. */
  size?: { width: number; height: number };
}

export interface TagPrompt {
  system: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const KIND_WORD: Record<AssetKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio clip',
  text: 'text file',
  other: 'file',
};

function basisLine(basis: MediaTagBasis, asset: TagAsset): string {
  switch (basis) {
    case 'image':
      return 'The image itself is attached.';
    case 'frame':
      return 'A single frame grabbed from the middle of the video is attached; describe the video, not the still.';
    case 'text':
      return 'The beginning of the file is quoted below.';
    default:
      return `You cannot see or hear this ${KIND_WORD[asset.kind]}: infer conservatively from its name and folder, and say so in the description if you are guessing.`;
  }
}

export function buildTagPrompt(ctx: TagContext): TagPrompt {
  const { asset, pack } = ctx;
  const system = [
    'You tag media for a role-play character pack. The tags and descriptions you write are shown to a character so it can pick the right asset by meaning.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"tags": ["tag-one", "tag-two"], "description": "one sentence", "meanings": {"tag-one": "what this tag means"}}',
    '',
    'Rules:',
    `- tags: at most ${ctx.maxTags}, lower-case, letters, digits, "-" and "_" only, most useful first.`,
    '- Reuse the pack tags listed below whenever one fits; only invent a tag when nothing fits.',
    ctx.vocabularyOnly ? '- Do NOT invent tags: use only the pack tags listed below.' : '- Tag what the asset shows, its mood, and when the character would use it.',
    `- description: one sentence, at most ${MAX_DESCRIPTION_LENGTH} characters, saying what the asset shows and when to use it. No file names, no "an image of".`,
    ctx.vocabularyOnly ? '- meanings: leave it empty.' : '- meanings: a short meaning for every tag you invented (not for tags already listed).',
    '- Never invent details you cannot see.',
  ]
    .filter((l) => l.length > 0)
    .join('\n');

  const lines: string[] = [];
  lines.push(`Pack: ${pack.name}${pack.id ? ` (${pack.id})` : ''}`);
  if (pack.description) lines.push(`About the pack: ${pack.description}`);
  if (pack.characters.length > 0) lines.push(`Characters: ${pack.characters.join(', ')}`);
  lines.push('');
  lines.push(`File: ${asset.path}`);
  lines.push(`Kind: ${KIND_WORD[asset.kind]} (${asset.mime})${ctx.size ? `, ${ctx.size.width} × ${ctx.size.height}` : ''}`);
  if (asset.folderTags.length > 0) lines.push(`Folder tags already applied (do not repeat): ${asset.folderTags.join(', ')}`);
  if (asset.tags.length > 0) lines.push(`Tags it has today (keep the ones that still fit): ${asset.tags.join(', ')}`);
  if (asset.description) lines.push(`Current description: ${asset.description}`);
  lines.push(basisLine(ctx.basis, asset));

  const vocabulary = Object.entries(pack.vocabulary).filter(([, meaning]) => meaning.trim().length > 0);
  if (vocabulary.length > 0) {
    lines.push('');
    lines.push('Pack tag vocabulary:');
    for (const [tag, meaning] of vocabulary) lines.push(`- ${tag}: ${meaning}`);
  }
  const undocumented = pack.knownTags.filter((t) => !(t in pack.vocabulary));
  if (undocumented.length > 0) {
    lines.push(`Other tags already in use: ${undocumented.join(', ')}`);
  }
  if (ctx.guidance && ctx.guidance.trim().length > 0) {
    lines.push('');
    lines.push(`Guidance from the pack author: ${ctx.guidance.trim()}`);
  }
  lines.push('');
  lines.push(`Tag this ${KIND_WORD[asset.kind]}.`);
  return { system, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawAnswer {
  tags?: unknown;
  description?: unknown;
  meanings?: unknown;
}

/**
 * First balanced JSON object in the text. Code fences, chatter and the `<think>…</think>` block
 * local models like to put in front of their answer are ignored.
 */
export function extractJsonObject(raw: string): string | undefined {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/[,\n]/);
  return [];
}

/** Collapse whitespace, drop wrapping quotes and clamp to `media.json`'s description limit. */
export function cleanDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    const cut = text.slice(0, MAX_DESCRIPTION_LENGTH);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
    text = (stop > MAX_DESCRIPTION_LENGTH * 0.6 ? cut.slice(0, stop) : cut).trim().replace(/[,;:]$/, '');
  }
  return text;
}

/**
 * Model answer → a suggestion for one asset: tags normalised the way `media.json` needs them,
 * folder tags dropped (they apply anyway), capped at `maxTags`, and — with `vocabularyOnly` —
 * restricted to the tags the pack already knows.
 */
export function parseTagResponse(raw: string, ctx: TagContext): Omit<MediaTagSuggestion, 'model'> {
  const json = extractJsonObject(raw);
  const empty = { path: ctx.asset.path, tags: [], newTags: [], description: '', vocabulary: {}, basis: ctx.basis };
  if (!json) return { ...empty, error: `The model did not answer with JSON: ${raw.trim().slice(0, 200) || '(empty answer)'}` };
  let answer: RawAnswer;
  try {
    answer = JSON.parse(json) as RawAnswer;
  } catch (err) {
    return { ...empty, error: `The model's JSON could not be parsed: ${(err as Error).message}` };
  }

  const known = new Set([...Object.keys(ctx.pack.vocabulary), ...ctx.pack.knownTags]);
  const folder = new Set(ctx.asset.folderTags);
  const tags: string[] = [];
  for (const candidate of toStringList(answer.tags)) {
    const tag = normalizeTag(candidate.replace(/^#/, ''));
    if (tag === undefined || folder.has(tag) || tags.includes(tag)) continue;
    if (ctx.vocabularyOnly && !known.has(tag)) continue;
    tags.push(tag);
    if (tags.length >= Math.min(ctx.maxTags, MAX_TAGS_PER_ASSET)) break;
  }
  const newTags = tags.filter((t) => !known.has(t));

  const vocabulary: Record<string, string> = {};
  const meanings = answer.meanings;
  if (meanings && typeof meanings === 'object' && !Array.isArray(meanings)) {
    for (const [rawTag, meaning] of Object.entries(meanings as Record<string, unknown>)) {
      const tag = normalizeTag(rawTag);
      const text = cleanDescription(meaning);
      if (tag !== undefined && text.length > 0 && newTags.includes(tag)) vocabulary[tag] = text;
    }
  }

  return { path: ctx.asset.path, tags, newTags, description: cleanDescription(answer.description), vocabulary, basis: ctx.basis };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MediaTaggerDeps {
  /** `engine.settings.resolveProvider`: session override → default → the only provider. */
  resolveProvider(providerId?: string): Promise<ProviderConfig>;
  providerFactory(config: ProviderConfig): LlmProvider;
  readImage: ImageReader;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

/** Resolved once per run so every asset is billed to the same provider/model. */
export interface TagRun {
  config: ProviderConfig;
  model: string;
  provider: LlmProvider;
  vision: boolean;
}

export class MediaTagger {
  constructor(private readonly deps: MediaTaggerDeps) {}

  /** Resolve the provider for a run and fail early with an actionable message. */
  async start(options: TagMediaOptions = {}): Promise<TagRun> {
    let config: ProviderConfig;
    try {
      config = await this.deps.resolveProvider(options.providerId);
    } catch (err) {
      throw new RpError('LLM_PROVIDER', `${RpError.from(err, 'LLM_PROVIDER').message} (Settings → Providers)`, undefined, { cause: err });
    }
    const model = typeof options.model === 'string' && options.model.trim().length > 0 ? options.model.trim() : config.model;
    if (!model) throw new RpError('LLM_PROVIDER', `Provider "${config.label || config.id}" has no model set (Settings → Providers)`);
    return { config, model, provider: this.deps.providerFactory(config), vision: config.kind === 'mock' || resolveSupportsVision(config) };
  }

  /** Tag every asset in order, one call each. A failing asset yields an `error` suggestion, not a throw. */
  async suggest(pack: TagPackContext, assets: TagAsset[], options: TagMediaOptions = {}): Promise<MediaTagSuggestion[]> {
    const run = await this.start(options);
    const out: MediaTagSuggestion[] = [];
    for (const asset of assets) out.push(await this.suggestOne(run, pack, asset, options));
    return out;
  }

  async suggestOne(run: TagRun, pack: TagPackContext, asset: TagAsset, options: TagMediaOptions = {}): Promise<MediaTagSuggestion> {
    const maxTags = clampTags(options.maxTags);
    const fail = (error: string, basis: MediaTagBasis = 'filename'): MediaTagSuggestion => ({
      path: asset.path,
      tags: [],
      newTags: [],
      description: '',
      vocabulary: {},
      basis,
      model: run.model,
      error,
    });

    let image: TagImage | undefined;
    let basis: MediaTagBasis = 'filename';
    let excerpt = '';
    try {
      if (asset.frame && asset.frame.length > 0) {
        image = { mime: 'image/png', data: asset.frame };
        basis = 'frame';
      } else if (asset.kind === 'image') {
        image = await this.deps.readImage(asset.absolutePath, TAG_IMAGE_MAX_PX);
        if (!image) return fail(`${asset.path} could not be decoded as an image`);
        basis = 'image';
      } else if (asset.kind === 'text') {
        excerpt = (await fs.readFile(asset.absolutePath, 'utf8')).slice(0, TAG_TEXT_MAX_CHARS);
        basis = 'text';
      }
    } catch (err) {
      return fail(`Could not read ${asset.path}: ${(err as Error).message}`);
    }
    if (image && !run.vision) {
      return fail(
        `Provider "${run.config.label || run.config.id}" (${run.model}) is not marked as vision-capable, so ${asset.path} cannot be looked at. Tick "supports vision" for it, or pick a vision model such as qwen3-vl, under Settings → Providers.`,
        basis,
      );
    }

    const ctx: TagContext = {
      pack,
      asset,
      basis,
      maxTags,
      vocabularyOnly: options.vocabularyOnly === true,
      ...(options.guidance ? { guidance: options.guidance } : {}),
      ...(image?.width && image.height ? { size: { width: image.width, height: image.height } } : {}),
    };
    const prompt = buildTagPrompt(ctx);
    const text = basis === 'text' && excerpt.length > 0 ? `${prompt.text}\n\n--- file contents ---\n${excerpt}` : prompt.text;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TAG_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const request: LlmChatRequest = {
        model: run.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [...(image ? [{ type: 'image' as const, mime: image.mime, data: image.data }] : []), { type: 'text' as const, text }] }],
        temperature: 0.2,
        maxTokens: TAG_MAX_TOKENS,
        signal: controller.signal,
      };
      const response = await run.provider.chat(request);
      const answer = response.message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (answer.trim().length === 0) {
        return fail(
          response.stopReason === 'max_tokens'
            ? `${run.model} ran out of tokens before answering. Reasoning models spend the whole budget thinking: pick a non-thinking vision model (qwen3-vl, llava, …).`
            : `${run.model} returned nothing to tag with.`,
          basis,
        );
      }
      return { ...parseTagResponse(answer, ctx), model: response.model || run.model };
    } catch (err) {
      const rp = RpError.from(err, 'LLM_PROVIDER');
      this.deps.logger?.warn(`[editor] tagging ${asset.path} failed: ${rp.message}`);
      return fail(rp.code === 'LLM_ABORTED' ? `Timed out after ${Math.round(TAG_TIMEOUT_MS / 1000)}s` : rp.message, basis);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function clampTags(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TAG_DEFAULT_MAX_TAGS;
  return Math.min(MAX_TAGS_PER_ASSET, Math.max(1, Math.floor(value)));
}
