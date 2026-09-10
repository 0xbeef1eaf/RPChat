import * as fs from 'node:fs';
import type { AssetEntry, AssetKind, LoadedPack, TagSummary } from '@rp/shared';
import { RpError } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, assetKindFor, mimeFor, normalizeRelativePath, resolveAssetPath, summariseTags as packSummariseTags } from '@rp/pack';

/** The shape of `AssetRef` in the SDK preamble (mirrors `AssetEntry`). */
export interface AssetRef {
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

/**
 * Filter + rank assets: all `tags` present AND any of `anyTags` AND `kind` AND `text` on path/description.
 * Ranked by number of matching tags (desc), then shorter path, then path.
 */
export function findAssets(assets: AssetEntry[], query: FindAssetsQuery): AssetRef[] {
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
  const ranked = scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || (a.entry.path < b.entry.path ? -1 : 1));
  if (ranked.length === 0 && query.fallback !== false && (all.length > 0 || any.length > 0 || text.length > 0)) {
    // Nothing carries those tags/words (many packs are untagged): fall back to every asset of the
    // requested kind so the character can still pick something instead of concluding there is no media.
    return assets
      .filter((entry) => !query.kind || entry.kind === query.kind)
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

/** Accepts a path string or an `AssetRef`-like object and returns the validated `AssetRef`. */
export function coerceAssetArg(pack: LoadedPack, arg: unknown): AssetRef {
  if (typeof arg === 'string') return resolvePackAsset(pack, arg);
  if (arg && typeof arg === 'object' && typeof (arg as { path?: unknown }).path === 'string') {
    return resolvePackAsset(pack, (arg as { path: string }).path);
  }
  throw new RpError('INVALID_ARGUMENT', 'Expected an asset path string or an AssetRef object');
}
