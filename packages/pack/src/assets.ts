import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetEntry, AssetKind } from '@rp/shared';
import { CHARACTER_MANIFEST_FILENAME, PACK_MANIFEST_FILENAME } from '@rp/shared';
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
  return { path: rel, kind: assetKindFor(rel), bytes: st.size, mime: mimeFor(rel) };
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
 * Indexes every file under `mediaRoot` (recursively) plus each character's avatar.
 * A missing media directory yields no media entries (a pack may have no media).
 * Entries are sorted by path and deduplicated.
 */
export async function indexAssets(root: string, mediaRoot: string = DEFAULT_MEDIA_ROOT): Promise<AssetEntry[]> {
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

  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
