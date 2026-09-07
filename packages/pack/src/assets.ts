import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetEntry, AssetKind, MediaManifest, TagSummary } from '@rp/shared';
import { CHARACTER_MANIFEST_FILENAME, MEDIA_MANIFEST_FILENAME, PACK_MANIFEST_FILENAME } from '@rp/shared';
import { globToRegExp } from './glob.js';
import { validateMediaManifest } from './media-manifest.js';
import { normalizeTag } from './tags.js';
import { isSafeRelativePath, joinRelative, normalizeRelativePath, resolveAssetPath } from './paths.js';

export const DEFAULT_MEDIA_ROOT = 'media';

/** Extension → asset kind. Lower-case, without the dot. */
export const ASSET_KIND_BY_EXTENSION: Readonly<Record<string, AssetKind>> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio', opus: 'audio',
  txt: 'text', md: 'text', json: 'text', csv: 'text',
};

/** Extension → MIME type for every extension with a known kind. */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  aac: 'audio/aac', opus: 'audio/opus',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
};

export const DEFAULT_MIME = 'application/octet-stream';

/** Lower-case extension of a path (without dot), or `''` when it has none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function assetKindFor(filePath: string): AssetKind {
  return ASSET_KIND_BY_EXTENSION[extensionOf(filePath)] ?? 'other';
}

export function mimeFor(filePath: string): string {
  return MIME_BY_EXTENSION[extensionOf(filePath)] ?? DEFAULT_MIME;
}

async function statOrNull(abs: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

/**
 * Recursively lists regular files below `dirAbs`. Dotfiles, `node_modules` and
 * symlinks are skipped (a symlink could point outside the pack; the model is only
 * told about files that can be served safely).
 */
export async function walkFiles(rootAbs: string, dirAbs: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootAbs, abs, out);
    } else if (entry.isFile()) {
      out.push(path.relative(rootAbs, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

async function entryFor(rootAbs: string, rel: string): Promise<AssetEntry | null> {
  const st = await statOrNull(path.join(rootAbs, ...rel.split('/')));
  if (!st || !st.isFile()) return null;
  return { path: rel, kind: assetKindFor(rel), bytes: st.size, mime: mimeFor(rel), tags: [] };
}

/**
 * Folder names that only say what *kind* of thing lives inside and therefore
 * never become implicit tags. The media root's own segments are skipped too.
 */
export const KIND_FOLDER_NAMES: ReadonlySet<string> = new Set([
  'media', 'images', 'image', 'video', 'videos', 'audio', 'sounds', 'characters',
]);

/**
 * Implicit tags for an asset: every directory segment of its path, except the
 * kind folders above and the media root's segments. `media/images/outfits/summer/x.png`
 * → `['outfits', 'summer']`. Segments that are not valid tags are dropped.
 */
export function folderTagsFor(assetPath: string, mediaRoot: string = DEFAULT_MEDIA_ROOT): string[] {
  const n = normalizeRelativePath(assetPath);
  if (!n.ok) return [];
  const skip = new Set(KIND_FOLDER_NAMES);
  const m = normalizeRelativePath(mediaRoot);
  if (m.ok) for (const seg of m.path.split('/')) skip.add(seg.toLowerCase());
  const segments = n.path.split('/');
  segments.pop(); // file name
  const tags = new Set<string>();
  for (const seg of segments) {
    if (skip.has(seg.toLowerCase())) continue;
    const tag = normalizeTag(seg);
    if (tag !== undefined) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * Fills `tags` (and `description`) on each asset from folder names and the
 * matching `media.json` entries. Tags are merged, deduplicated and sorted; when
 * several entries set a description, the last one wins. Returns new entries.
 */
export function applyMediaTags(
  assets: readonly AssetEntry[],
  manifest: MediaManifest | null | undefined,
  mediaRoot: string = DEFAULT_MEDIA_ROOT,
): AssetEntry[] {
  const useFolderTags = manifest?.folderTags !== false;
  const rules = (manifest?.entries ?? []).map((entry) => ({ entry, re: globToRegExp(entry.match) }));
  return assets.map((asset) => {
    const tags = new Set<string>(useFolderTags ? folderTagsFor(asset.path, mediaRoot) : []);
    let description = asset.description;
    for (const { entry, re } of rules) {
      if (!re.test(asset.path)) continue;
      for (const t of entry.tags ?? []) tags.add(t);
      if (entry.description !== undefined) description = entry.description;
    }
    const out: AssetEntry = { ...asset, tags: [...tags].sort() };
    if (description !== undefined) out.description = description;
    else delete out.description;
    return out;
  });
}

/** Reads and validates `media.json` under `rootAbs`; `null` when absent or invalid (loader reports that). */
async function discoverMediaManifest(rootAbs: string): Promise<MediaManifest | null> {
  try {
    return validateMediaManifest(JSON.parse(await fs.readFile(path.join(rootAbs, MEDIA_MANIFEST_FILENAME), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Tags used across `assets`, most frequent first (ties by name), with the
 * vocabulary description when one exists. Only tags carried by at least one asset appear.
 */
export function summariseTags(assets: readonly AssetEntry[], tagDescriptions?: Record<string, string>): TagSummary[] {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    for (const tag of asset.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const out: TagSummary[] = [];
  for (const [tag, count] of counts) {
    const summary: TagSummary = { tag, count };
    const description = tagDescriptions?.[tag];
    if (description !== undefined) summary.description = description;
    out.push(summary);
  }
  return out.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/**
 * Best-effort discovery of character avatar paths (relative to the pack root)
 * by reading `pack.json` and each `character.json`. Any unreadable or malformed
 * file is ignored here; the loader reports such problems separately.
 */
async function discoverAvatarPaths(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(rootAbs, PACK_MANIFEST_FILENAME), 'utf8'));
  } catch {
    return out;
  }
  const dirs = (manifest as { characters?: unknown })?.characters;
  if (!Array.isArray(dirs)) return out;
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !isSafeRelativePath(dir)) continue;
    try {
      const defPath = resolveAssetPath(rootAbs, joinRelative(dir, CHARACTER_MANIFEST_FILENAME));
      const def = JSON.parse(await fs.readFile(defPath, 'utf8')) as { avatar?: unknown };
      if (typeof def.avatar === 'string' && isSafeRelativePath(def.avatar)) out.push(joinRelative(dir, def.avatar));
    } catch {
      // ignored: reported by validatePack/loadPack
    }
  }
  return out;
}

/**
 * Indexes every file under `mediaRoot` (recursively) plus each character's avatar,
 * then assigns tags from folder names and `media.json`. A missing media directory
 * yields no media entries (a pack may have no media). Entries are sorted by path.
 *
 * `manifest`: the validated `media.json`; `undefined` reads it from the pack root
 * when present (best effort), `null` applies no manifest.
 */
export async function indexAssets(
  root: string,
  mediaRoot: string = DEFAULT_MEDIA_ROOT,
  manifest?: MediaManifest | null,
): Promise<AssetEntry[]> {
  const rootAbs = path.resolve(root);
  const byPath = new Map<string, AssetEntry>();

  const mediaAbs = resolveAssetPath(rootAbs, mediaRoot);
  const mediaStat = await statOrNull(mediaAbs);
  if (mediaStat?.isDirectory()) {
    for (const rel of await walkFiles(rootAbs, mediaAbs)) {
      const entry = await entryFor(rootAbs, rel);
      if (entry) byPath.set(entry.path, entry);
    }
  }

  for (const avatar of await discoverAvatarPaths(rootAbs)) {
    const n = normalizeRelativePath(avatar);
    if (!n.ok || byPath.has(n.path)) continue;
    try {
      resolveAssetPath(rootAbs, n.path);
    } catch {
      continue;
    }
    const entry = await entryFor(rootAbs, n.path);
    if (entry) byPath.set(entry.path, entry);
  }

  const resolvedManifest = manifest === undefined ? await discoverMediaManifest(rootAbs) : manifest;
  const sorted = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return applyMediaTags(sorted, resolvedManifest, mediaRoot);
}
