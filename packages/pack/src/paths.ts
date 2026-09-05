import * as fs from 'node:fs';
import * as path from 'node:path';
import { RpError } from '@rp/shared';

/** `C:` / `d:` style drive prefixes, which `path.posix` does not treat as absolute. */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

export type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Normalises a pack-relative path to canonical forward-slash form and rejects
 * anything that could leave the pack root: absolute paths (POSIX, drive letter
 * or UNC), `..` segments, NUL bytes and empty paths. Backslashes are treated as
 * separators so `media\..\x` cannot smuggle a traversal past the check.
 *
 * Purely lexical; see {@link resolveAssetPath} for the filesystem (symlink) check.
 */
export function normalizeRelativePath(input: string): NormalizedPath {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'path is empty' };
  if (input.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('/')) return { ok: false, reason: 'path is absolute' };
  if (WINDOWS_DRIVE.test(unified)) return { ok: false, reason: 'path is absolute (drive letter)' };
  const segments: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, reason: 'path contains a ".." segment' };
    segments.push(seg);
  }
  if (segments.length === 0) return { ok: false, reason: 'path is empty' };
  return { ok: true, path: segments.join('/') };
}

/** `true` when `input` is a safe pack-relative path (see {@link normalizeRelativePath}). */
export function isSafeRelativePath(input: string): boolean {
  return normalizeRelativePath(input).ok;
}

/**
 * Joins two pack-relative paths without ever collapsing `..` segments: both
 * parts are validated independently first, so the result is safe by construction.
 */
export function joinRelative(base: string, child: string): string {
  const b = normalizeRelativePath(base);
  if (!b.ok) throw new RpError('PATH_ESCAPE', `Unsafe path "${base}": ${b.reason}`, { path: base });
  const c = normalizeRelativePath(child);
  if (!c.ok) throw new RpError('PATH_ESCAPE', `Unsafe path "${child}": ${c.reason}`, { path: child });
  return `${b.path}/${c.path}`;
}

/** `true` when `child` equals `parent` or lies below it (lexically, on absolute paths). */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/**
 * Real path of `p`, or, when `p` does not exist, the real path of its nearest
 * existing ancestor with the missing tail appended. Lets a not-yet-created file
 * be checked against symlinked ancestors.
 */
function realpathOfNearest(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return p; // reached filesystem root without finding anything
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `relative` against `root` and returns the absolute path. Throws
 * `RpError('PATH_ESCAPE')` when the path is absolute, contains `..` (in any
 * slash flavour), or when following symlinks would land outside `root`.
 * The returned path is the lexical one (symlinks are not rewritten).
 */
export function resolveAssetPath(root: string, relative: string): string {
  const rootAbs = path.resolve(root);
  const n = normalizeRelativePath(relative);
  if (!n.ok) {
    throw new RpError('PATH_ESCAPE', `Unsafe asset path "${relative}": ${n.reason}`, { root: rootAbs, path: relative });
  }
  const target = path.resolve(rootAbs, ...n.path.split('/'));
  if (!isInside(rootAbs, target)) {
    throw new RpError('PATH_ESCAPE', `Asset path "${relative}" escapes the pack root`, { root: rootAbs, path: relative });
  }
  const realRoot = realpathOfNearest(rootAbs);
  const realTarget = realpathOfNearest(target);
  if (!isInside(realRoot, realTarget)) {
    throw new RpError('PATH_ESCAPE', `Asset path "${relative}" resolves outside the pack root (symlink)`, {
      root: rootAbs,
      path: relative,
      resolved: realTarget,
    });
  }
  return target;
}
