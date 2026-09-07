import { normalizeRelativePath } from './paths.js';

const GLOB_CHARS = /[*?]/;

/** `true` when the pattern contains glob metacharacters (`*`, `**`, `?`). */
export function isGlob(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a pack-relative glob into a RegExp over forward-slash paths.
 *
 * - `*` matches any run of characters within one path segment
 * - `?` matches exactly one character within a segment
 * - `**` matches across segments (`a/**` = `a` and everything below, `**​/x.png` = `x.png` at any depth)
 * - a pattern without metacharacters matches that exact path **and** everything below it
 *   (a bare directory prefix)
 *
 * The pattern is normalised first (backslashes → `/`, `./` and duplicate slashes dropped);
 * an unsafe pattern (absolute, `..`) matches nothing.
 */
export function globToRegExp(pattern: string): RegExp {
  const n = normalizeRelativePath(pattern);
  if (!n.ok) return /(?!)/; // never matches
  const p = n.path;
  if (!isGlob(p)) return new RegExp(`^${escapeRegExp(p)}(?:/.*)?$`);

  let out = '^';
  const segments = p.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (seg === '**') {
      // whole-segment globstar: zero or more segments (with their slashes)
      out += last ? '.*' : '(?:.*/)?';
      continue;
    }
    let segRe = '';
    for (let j = 0; j < seg.length; j++) {
      const ch = seg[j]!;
      if (ch === '*') {
        // `**` inside a segment behaves like `*` (no slash crossing), as in most globbers
        while (seg[j + 1] === '*') j++;
        segRe += '[^/]*';
      } else if (ch === '?') {
        segRe += '[^/]';
      } else {
        segRe += escapeRegExp(ch);
      }
    }
    out += segRe + (last ? '' : '/');
  }
  return new RegExp(out + '$');
}

/** `true` when the (normalised) pack-relative `path` matches `pattern` (see {@link globToRegExp}). */
export function matchesGlob(pattern: string, path: string): boolean {
  const n = normalizeRelativePath(path);
  if (!n.ok) return false;
  return globToRegExp(pattern).test(n.path);
}
