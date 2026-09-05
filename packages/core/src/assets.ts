import * as fs from 'node:fs';
import type { AssetEntry, LoadedPack } from '@rp/shared';
import { RpError } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, assetKindFor, mimeFor, normalizeRelativePath, resolveAssetPath } from '@rp/pack';

/** The shape of `AssetRef` in the SDK preamble (mirrors `AssetEntry`). */
export interface AssetRef {
  path: string;
  kind: AssetEntry['kind'];
  mime: string;
  bytes: number;
}

export function toAssetRef(entry: AssetEntry): AssetRef {
  return { path: entry.path, kind: entry.kind, mime: entry.mime, bytes: entry.bytes };
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
    if (st) return { path: rel, kind: assetKindFor(rel), mime: mimeFor(rel), bytes: st.size };
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
