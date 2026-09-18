/**
 * `rp-asset://<packId>/<relative path>` protocol: serves files only from the roots
 * `packRootFor` knows (installed packs, editor projects, app-generated roots and
 * character home directories), with `Range` support for media. The URL parsing, path
 * guard and range parsing are pure and unit-tested; `handleAssetRequest`
 * builds a Fetch `Response` (available in Node ≥ 18 and Electron main).
 */
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { mimeFor, normalizeRelativePath, resolveAssetPath } from '@rp/pack';
import { ASSET_PROTOCOL, RpError } from '@rp/shared';

/** Installed pack ids (reverse-DNS), editor project roots (`editor-<12 hex>`) and character homes (`home-<12 hex>`). */
const PACK_ID = /^([a-z0-9]+(\.[a-z0-9-]+)+|(editor|home)-[a-f0-9]{12})$/;

export interface ParsedAssetUrl {
  packId: string;
  relativePath: string;
}

/** Parse and validate an asset URL. Returns undefined for anything that is not a well-formed pack asset URL. */
export function parseAssetUrl(url: string): ParsedAssetUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${ASSET_PROTOCOL}:`) return undefined;
  const packId = parsed.hostname.toLowerCase();
  if (!PACK_ID.test(packId)) return undefined;
  const rawPath = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  if (rawPath.length === 0) return undefined;
  let decoded: string;
  try {
    const segments = rawPath.split('/').map((seg) => decodeURIComponent(seg));
    if (segments.some((seg) => seg.length === 0)) return undefined; // `//` or trailing slash
    decoded = segments.join('/');
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const normalized = normalizeRelativePath(decoded);
  if (!normalized.ok || normalized.path !== decoded) return undefined;
  return { packId, relativePath: normalized.path };
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | undefined;

/**
 * Parse a single `bytes=` range against `size`. Undefined → serve the whole
 * file (no/invalid/multi-range header); `'unsatisfiable'` → 416.
 */
export function parseRange(header: string | null | undefined, size: number): ParsedRange {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return undefined;
  if (size <= 0) return 'unsatisfiable';
  if (a === '') {
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

export interface AssetRequestLike {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
}

export interface AssetProtocolDeps {
  /** Absolute root of an installed pack, or undefined when the pack is not installed. */
  packRootFor(packId: string): string | undefined;
  logger?: Pick<Console, 'warn' | 'debug'>;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Resolve an asset URL to an absolute file inside the pack root (throws `PATH_ESCAPE` for symlink escapes). */
export function resolveAssetUrl(url: string, deps: Pick<AssetProtocolDeps, 'packRootFor'>): { file: string; relativePath: string } | undefined {
  const parsed = parseAssetUrl(url);
  if (!parsed) return undefined;
  const root = deps.packRootFor(parsed.packId);
  if (!root) return undefined;
  return { file: resolveAssetPath(root, parsed.relativePath), relativePath: parsed.relativePath };
}

export async function handleAssetRequest(request: AssetRequestLike, deps: AssetProtocolDeps): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method not allowed');
  let target: { file: string; relativePath: string } | undefined;
  try {
    target = resolveAssetUrl(request.url, deps);
  } catch (err) {
    if (err instanceof RpError && err.code === 'PATH_ESCAPE') return plain(403, 'Forbidden');
    deps.logger?.warn?.('[rp-asset] resolve failed', err);
    return plain(500, 'Internal error');
  }
  if (!target) return plain(404, 'Not found');

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(target.file);
  } catch {
    return plain(404, 'Not found');
  }
  if (!stat.isFile()) return plain(404, 'Not found');

  const headers: Record<string, string> = {
    'Content-Type': mimeFor(target.relativePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  const range = parseRange(request.headers.get('range'), stat.size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  let status = 200;
  if (range) {
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  if (method === 'HEAD' || length === 0) return new Response(null, { status, headers });
  const stream = fs.createReadStream(target.file, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}
