import * as fs from 'node:fs';
import type { AssetEntry, AssetKind, LoadedPack, TagSummary } from '@rp/shared';
import { RpError, parseAssetSource, parseRemoteAssetPath } from '@rp/shared';
import type { AssetSource } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, assetKindFor, mimeFor, normalizeRelativePath, resolveAssetPath, summariseTags as packSummariseTags } from '@rp/pack';

/** The shape of `AssetRef` in the SDK preamble (mirrors `AssetEntry`). */
export interface AssetRef {
  /**
   * Where `path` is relative to; omitted (i.e. 'pack') for everything the pack itself indexes.
   * `remote` is an item of a plugin's media source, its path `<sourceId>/<itemId>`.
   */
  source?: AssetSource;
  path: string;
  kind: AssetEntry['kind'];
  mime: string;
  bytes: number;
  tags: string[];
  description?: string;
}

/** Tags of an entry (older indexes may lack the field). */
export function tagsOf(entry: Pick<AssetEntry, 'tags'>): string[] {
  return Array.isArray(entry.tags) ? entry.tags : [];
}

/** The assets a character may list, search and browse: everything but its own avatar/expression frames. */
export function showableAssets<T extends Pick<AssetEntry, 'role'>>(assets: readonly T[]): T[] {
  return assets.filter((a) => a.role === undefined);
}

export function toAssetRef(entry: AssetEntry): AssetRef {
  const ref: AssetRef = { path: entry.path, kind: entry.kind, mime: entry.mime, bytes: entry.bytes, tags: tagsOf(entry) };
  if (entry.description !== undefined) ref.description = entry.description;
  return ref;
}

/**
 * Tag vocabulary across the assets (`@rp/pack`'s `summariseTags`: count per tag with the author's
 * meaning, sorted by count desc then tag; tags with no uses are omitted). Entries from an older
 * index without a `tags` field are tolerated.
 */
export function summariseTags(assets: AssetEntry[], tagDescriptions: Record<string, string> = {}): TagSummary[] {
  return packSummariseTags(assets.map((a) => (Array.isArray(a.tags) ? a : { ...a, tags: [] })), tagDescriptions);
}

export interface FindAssetsQuery {
  /** When nothing matches the tags/text, return every asset of `kind` instead of an empty list. Default true. */
  fallback?: boolean;
  /** Every tag must be present. */
  tags?: string[];
  /** At least one must be present. */
  anyTags?: string[];
  kind?: AssetKind;
  /** Case-insensitive substring of the path or description. */
  text?: string;
  limit?: number;
}

export const FIND_ASSETS_DEFAULT_LIMIT = 50;
export const FIND_ASSETS_MAX_LIMIT = 200;

function normTags(list: unknown, what: string): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) throw new RpError('INVALID_ARGUMENT', `${what} must be an array of strings`);
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
}

/** Fisher-Yates on a copy. `rng` is injectable so tests can pin the order. */
function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Filter + rank assets: all `tags` present AND any of `anyTags` AND `kind` AND `text` on path/description.
 * Ranked by number of matching tags (desc); assets that match equally well come back in a fresh random
 * order, so a caller taking the first result (or the first `limit`) gets a different pick each call
 * instead of always the same file. The fallback list is shuffled for the same reason.
 */
export function findAssets(assets: AssetEntry[], query: FindAssetsQuery, rng: () => number = Math.random): AssetRef[] {
  const all = normTags(query.tags, 'tags');
  const any = normTags(query.anyTags, 'anyTags');
  const text = typeof query.text === 'string' ? query.text.trim().toLowerCase() : '';
  if (query.text !== undefined && query.text !== null && typeof query.text !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
  if (query.kind !== undefined && query.kind !== null && typeof query.kind !== 'string') throw new RpError('INVALID_ARGUMENT', 'kind must be a string');
  let limit = FIND_ASSETS_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== null) {
    if (typeof query.limit !== 'number' || !Number.isFinite(query.limit) || query.limit < 1) throw new RpError('INVALID_ARGUMENT', 'limit must be a positive number');
    limit = Math.min(FIND_ASSETS_MAX_LIMIT, Math.floor(query.limit));
  }
  const scored: Array<{ entry: AssetEntry; score: number }> = [];
  for (const entry of assets) {
    if (query.kind && entry.kind !== query.kind) continue;
    const tags = new Set(tagsOf(entry));
    if (!all.every((t) => tags.has(t))) continue;
    const anyHits = any.filter((t) => tags.has(t));
    if (any.length > 0 && anyHits.length === 0) continue;
    if (text && !entry.path.toLowerCase().includes(text) && !(entry.description ?? '').toLowerCase().includes(text)) continue;
    scored.push({ entry, score: all.length + anyHits.length });
  }
  // Shuffle first, then sort by score alone: Array#sort is stable, so a better match still wins while
  // equally good ones land in a different order every call.
  const ranked = shuffled(scored, rng).sort((a, b) => b.score - a.score);
  if (ranked.length === 0 && query.fallback !== false && (all.length > 0 || any.length > 0 || text.length > 0)) {
    // Nothing carries those tags/words (many packs are untagged): fall back to every asset of the
    // requested kind so the character can still pick something instead of concluding there is no media.
    return shuffled(assets.filter((entry) => !query.kind || entry.kind === query.kind), rng)
      .slice(0, limit)
      .map(toAssetRef);
  }
  return ranked.slice(0, limit).map((s) => toAssetRef(s.entry));
}

function statFile(abs: string): fs.Stats | undefined {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an asset the character named. Accepts a pack-root-relative path
 * first; when no such file exists, tries `<mediaRoot>/<path>`. Every candidate
 * is validated with `resolveAssetPath` (no `..`, no absolute, no symlink
 * escape). The returned `path` is always pack-root-relative.
 *
 * Throws `PATH_ESCAPE` for unsafe paths and `NOT_FOUND` when nothing exists.
 */
export function resolvePackAsset(pack: LoadedPack, input: string): AssetRef {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RpError('INVALID_ARGUMENT', 'Asset path must be a non-empty string');
  }
  const n = normalizeRelativePath(input);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe asset path "${input}": ${n.reason}`, { path: input });

  const mediaRoot = pack.manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT;
  const mediaPrefix = normalizeRelativePath(mediaRoot);
  const candidates = [n.path];
  if (mediaPrefix.ok && !n.path.startsWith(`${mediaPrefix.path}/`)) candidates.push(`${mediaPrefix.path}/${n.path}`);

  for (const rel of candidates) {
    const indexed = pack.assets.find((a) => a.path === rel);
    if (indexed) return toAssetRef(indexed);
    const abs = resolveAssetPath(pack.root, rel); // throws PATH_ESCAPE on symlink escape
    const st = statFile(abs);
    if (st) return { path: rel, kind: assetKindFor(rel), mime: mimeFor(rel), bytes: st.size, tags: [] };
  }
  throw new RpError('NOT_FOUND', `Asset "${input}" does not exist in pack ${pack.manifest.id}`, {
    path: input,
    tried: candidates,
  });
}

/**
 * A file in the character's own home directory named as an asset. Validated lexically only — the
 * home directory belongs to the host handler, so whether the file is there is its call — with the
 * kind and MIME read off the extension, as an unindexed pack file's are.
 */
export function homeAssetRef(input: string): AssetRef {
  if (typeof input !== 'string' || input.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a non-empty string');
  const n = normalizeRelativePath(input);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe asset path "${input}": ${n.reason}`, { path: input, source: 'home' });
  return { source: 'home', path: n.path, kind: assetKindFor(n.path), mime: mimeFor(n.path), bytes: 0, tags: [] };
}

export interface CoerceAssetOptions {
  /** Whether the call takes a file from the character home as well as a pack asset. Default false. */
  home?: boolean;
  /**
   * The remote media sources, when the call takes their items as well (`MediaSourceService`). The
   * kind of a `remote:<path>` string comes from the search that returned it; a ref object that has
   * outlived that memory is taken at its word.
   */
  remote?: { hasSource(sourceId: string): boolean; describe(assetPath: string): AssetRef | undefined };
  /** The call being made (`sdk.wallpaper.set`), to name it in the message when it takes pack assets only. */
  call?: string;
}

/**
 * Accepts a path string or an `AssetRef`-like object and returns the validated `AssetRef`.
 * A file in the character's home directory — an `sdk.webcam` capture, anything `sdk.files` wrote —
 * comes in either as a `source: 'home'` ref or as a `home:<path>` string, and is taken only by the
 * calls that can serve one (`options.home`); the rest name it for what it is rather than report it
 * as a pack file that does not exist. An item of a remote media source (`source: 'remote'` or
 * `remote:<path>`) is taken the same way, by the calls given `options.remote`.
 */
export function coerceAssetArg(pack: LoadedPack, arg: unknown, options: CoerceAssetOptions = {}): AssetRef {
  const home = (relative: string): AssetRef => {
    if (options.home) return homeAssetRef(relative);
    throw new RpError(
      'INVALID_ARGUMENT',
      `${options.call ?? 'This call'} needs a pack asset; "${relative}" is a file in the character home. sdk.media can show one of those, and sdk.files.open/read can open or read it.`,
      { path: relative, source: 'home' },
    );
  };
  if (typeof arg === 'string') {
    const parsed = parseAssetSource(arg);
    if (parsed.source === 'remote') return remoteAssetRef(parsed.path, undefined, options);
    return parsed.source === 'home' ? home(parsed.path) : resolvePackAsset(pack, arg);
  }
  if (arg && typeof arg === 'object' && typeof (arg as { path?: unknown }).path === 'string') {
    const ref = arg as { path: string; source?: unknown; kind?: unknown };
    if (ref.source === 'home') return home(ref.path);
    if (ref.source === 'remote') return remoteAssetRef(ref.path, ref, options);
    return resolvePackAsset(pack, ref.path);
  }
  throw new RpError('INVALID_ARGUMENT', 'Expected an asset path string or an AssetRef object');
}

const REMOTE_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio']);

/**
 * A remote asset argument: its path must name an item of a source that is registered now. The ref
 * a search returned is what describes it; failing that (the search was long ago, or in an earlier
 * run), a ref object passed back whole still says its kind, while a bare string no longer can.
 */
function remoteAssetRef(assetPath: string, given: { kind?: unknown } | undefined, options: CoerceAssetOptions): AssetRef {
  const remote = options.remote;
  if (!remote) {
    throw new RpError('INVALID_ARGUMENT', `${options.call ?? 'This call'} needs a pack asset; "${assetPath}" is an item of a remote media source. sdk.media can show one of those.`, { path: assetPath, source: 'remote' });
  }
  const parsed = parseRemoteAssetPath(assetPath);
  if (!parsed) throw new RpError('INVALID_ARGUMENT', `"${assetPath}" is not a remote asset path ("<plugin id>/<source>/<item id>", as sdk.mediaSources.search returns it)`, { path: assetPath, source: 'remote' });
  if (!remote.hasSource(parsed.sourceId)) {
    throw new RpError('NOT_FOUND', `The media source "${parsed.sourceId}" is not available any more (sdk.mediaSources.list() shows what is)`, { path: assetPath, source: 'remote' });
  }
  const known = remote.describe(assetPath);
  if (known) return known;
  if (given && typeof given.kind === 'string' && REMOTE_KINDS.has(given.kind)) {
    const kind = given.kind as AssetKind;
    return { source: 'remote', path: assetPath, kind, mime: `${kind}/*`, bytes: 0, tags: [] };
  }
  throw new RpError('NOT_FOUND', `"${assetPath}" is not a result of a recent sdk.mediaSources.search; search the source again and pass the AssetRef it returns`, { path: assetPath, source: 'remote' });
}
