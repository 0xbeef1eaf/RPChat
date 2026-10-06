/**
 * Items of remote media sources (docs/spec/plugins.md "Remote media sources"), on disk.
 *
 * A plugin's source says where an item's bytes are — an http(s) URL, perhaps with headers such as
 * an API key, or a file the plugin fetched itself — and `sdk.media` needs a file: the media pages
 * load everything over `rp-asset://`, a video may need converting (`video-compat.ts`), and the
 * native overlay helper reads through the loopback server, which serves roots, not URLs. So the
 * item is downloaded once into `<userData>/remote-media`, served under `REMOTE_MEDIA_PACK_ID` like
 * the other app-generated roots, and every later show of it starts from the cache.
 *
 * A cached file is named after the asset path's digest plus the extension its type calls for, which
 * is how the asset protocol picks its `Content-Type` and how the media manager tells its kind. The
 * type comes from what the search said, else the response's `Content-Type`, else the URL; a download
 * whose type is not a picture, video or sound the app knows is refused rather than cached.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ActionContext, MediaKind, RemoteMediaLocation } from '@rp/shared';
import { RpError, assetUrl } from '@rp/shared';
import { ASSET_KIND_BY_EXTENSION, MIME_BY_EXTENSION, extensionOf } from '@rp/pack';
import { pruneList } from './video-compat.js';
import type { CacheEntry } from './video-compat.js';

/** Synthetic pack id under which downloaded remote items are served to the media pages. */
export const REMOTE_MEDIA_PACK_ID = 'app.rpchat.remote';
/** Directory under `<userData>` holding them. */
export const REMOTE_MEDIA_DIRNAME = 'remote-media';
/** Largest single item the app downloads. */
export const REMOTE_MEDIA_MAX_ITEM_BYTES = 1024 * 1024 * 1024;
/** How much downloaded media is kept; the least recently shown go first once a download pushes the total over. */
export const REMOTE_MEDIA_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/** A download that has not finished by then is abandoned. */
export const REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** `extension → kind`, restricted to what can go on screen or play. */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(Object.entries(ASSET_KIND_BY_EXTENSION).filter(([, kind]) => kind === 'image' || kind === 'video' || kind === 'audio').map(([ext]) => ext));

/** MIME types the pack tables do not spell the way servers often do. */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'audio/mp3': 'mp3',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-flac': 'flac',
  'audio/x-m4a': 'm4a',
  'video/x-m4v': 'm4v',
};

/** The extension the asset tables give a MIME type (`image/jpeg` → `jpg`), or undefined for one they lack. */
export function extensionForMime(mime: string | undefined | null): string | undefined {
  if (!mime) return undefined;
  const bare = mime.split(';')[0]!.trim().toLowerCase();
  if (MIME_ALIASES[bare]) return MIME_ALIASES[bare];
  // `jpg` comes before `jpeg` in the table, so the first match is the usual spelling.
  for (const [ext, m] of Object.entries(MIME_BY_EXTENSION)) if (m === bare && MEDIA_EXTENSIONS.has(ext)) return ext;
  return undefined;
}

/** Cache file name for a remote asset path, without the extension. */
export function remoteCacheKey(assetPath: string): string {
  return createHash('sha256').update(assetPath).digest('hex').slice(0, 32);
}

/** What the media manager needs: where a remote item is on disk, and the URL its page loads it from. */
export interface RemoteMediaFiles {
  file(assetPath: string, context: ActionContext): Promise<{ file: string; url: string }>;
}

export interface RemoteMediaCacheDeps {
  /** `<userData>/remote-media`, registered as the root of `REMOTE_MEDIA_PACK_ID`. */
  dir: string;
  /** `engine.mediaSources.locate`: where the source says the bytes are, and what a search said about the item. */
  locate(assetPath: string, context: ActionContext): Promise<{ location: RemoteMediaLocation; ref?: { kind: string; mime: string } }>;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Injectable for tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  maxItemBytes?: number;
  cacheBytes?: number;
  timeoutMs?: number;
}

export class RemoteMediaCache implements RemoteMediaFiles {
  /** Downloads in progress by key, so two shows of one item share a single download. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly deps: RemoteMediaCacheDeps) {}

  async file(assetPath: string, context: ActionContext): Promise<{ file: string; url: string }> {
    const key = remoteCacheKey(assetPath);
    let name = await this.cached(key);
    if (name === undefined) {
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.download(assetPath, key, context).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      name = await pending;
    }
    return { file: path.join(this.deps.dir, name), url: assetUrl(REMOTE_MEDIA_PACK_ID, name) };
  }

  /** The cached file for `key`, marked as just used, or undefined when there is none. */
  private async cached(key: string): Promise<string | undefined> {
    const names = await fs.readdir(this.deps.dir).catch(() => [] as string[]);
    const name = names.find((n) => n.startsWith(`${key}.`) && !n.includes('.part'));
    if (name === undefined) return undefined;
    const now = new Date();
    await fs.utimes(path.join(this.deps.dir, name), now, now).catch(() => undefined);
    return name;
  }

  private async download(assetPath: string, key: string, context: ActionContext): Promise<string> {
    const { location, ref } = await this.deps.locate(assetPath, context);
    await fs.mkdir(this.deps.dir, { recursive: true });
    const part = path.join(this.deps.dir, `${key}.part-${randomUUID().slice(0, 8)}`);
    try {
      const ext = 'file' in location ? await this.copy(location.file, part, ref?.mime) : await this.fetchTo(location, part, ref?.mime, assetPath);
      const kind = ASSET_KIND_BY_EXTENSION[ext] as MediaKind | undefined;
      if (ref && (ref.kind === 'image' || ref.kind === 'video' || ref.kind === 'audio') && kind !== ref.kind) {
        throw new RpError('CAPABILITY_FAILED', `"${assetPath}" was found as ${ref.kind} but downloaded as ${kind ?? 'something else'} (.${ext})`, { path: assetPath });
      }
      const name = `${key}.${ext}`;
      await fs.rename(part, path.join(this.deps.dir, name));
      this.deps.logger.info(`[media] downloaded remote item ${assetPath} as ${name}`);
      await this.prune(name);
      return name;
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw err instanceof RpError ? err : new RpError('CAPABILITY_FAILED', `Could not download "${assetPath}": ${(err as Error)?.message ?? String(err)}`, { path: assetPath }, { cause: err });
    }
  }

  /** A plugin-fetched file: copied in (the plugin may delete or replace its own copy at any time). */
  private async copy(file: string, part: string, mime: string | undefined): Promise<string> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) throw new RpError('CAPABILITY_FAILED', `The media source pointed at "${file}", which is not a file`);
    if (stat.size > this.maxItemBytes) throw new RpError('CAPABILITY_FAILED', `The item is ${megabytes(stat.size)}, more than the ${megabytes(this.maxItemBytes)} the app downloads`);
    const own = extensionOf(file);
    const ext = MEDIA_EXTENSIONS.has(own) ? own : extensionForMime(mime);
    if (ext === undefined) throw new RpError('CAPABILITY_FAILED', `"${path.basename(file)}" is not a picture, video or sound the app knows`);
    await fs.copyFile(file, part);
    return ext;
  }

  private async fetchTo(location: { url: string; headers?: Record<string, string> }, part: string, mime: string | undefined, assetPath: string): Promise<string> {
    const doFetch = this.deps.fetch ?? fetch;
    const response = await doFetch(location.url, { headers: location.headers ?? {}, redirect: 'follow', signal: AbortSignal.timeout(this.deps.timeoutMs ?? REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
      throw new RpError('CAPABILITY_FAILED', `Downloading "${assetPath}" failed: HTTP ${response.status}`, { path: assetPath, status: response.status });
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxItemBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new RpError('CAPABILITY_FAILED', `"${assetPath}" is ${megabytes(declared)}, more than the ${megabytes(this.maxItemBytes)} the app downloads`, { path: assetPath });
    }
    const urlExt = extensionOf(new URL(response.url || location.url).pathname);
    const ext = specific(mime) ?? extensionForMime(response.headers.get('content-type')) ?? (MEDIA_EXTENSIONS.has(urlExt) ? urlExt : undefined);
    if (ext === undefined) {
      await response.body.cancel().catch(() => undefined);
      throw new RpError('CAPABILITY_FAILED', `"${assetPath}" is not a picture, video or sound the app knows (${response.headers.get('content-type') ?? 'no Content-Type'})`, { path: assetPath });
    }
    let received = 0;
    const max = this.maxItemBytes;
    const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    counted.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) counted.destroy(new RpError('CAPABILITY_FAILED', `"${assetPath}" is more than the ${megabytes(max)} the app downloads`, { path: assetPath }));
    });
    await pipeline(counted, createWriteStream(part));
    return ext;
  }

  private get maxItemBytes(): number {
    return this.deps.maxItemBytes ?? REMOTE_MEDIA_MAX_ITEM_BYTES;
  }

  private async prune(keep: string): Promise<void> {
    try {
      const entries: CacheEntry[] = [];
      for (const name of await fs.readdir(this.deps.dir)) {
        if (name === keep || name.includes('.part')) continue;
        const stat = await fs.stat(path.join(this.deps.dir, name)).catch(() => undefined);
        if (stat?.isFile()) entries.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
      const keepBytes = (await fs.stat(path.join(this.deps.dir, keep)).catch(() => undefined))?.size ?? 0;
      const cap = Math.max(0, (this.deps.cacheBytes ?? REMOTE_MEDIA_CACHE_BYTES) - keepBytes);
      for (const name of pruneList(entries, cap)) await fs.rm(path.join(this.deps.dir, name), { force: true });
    } catch (err) {
      this.deps.logger.debug(`[media] pruning the remote media cache failed: ${String(err)}`);
    }
  }
}

/** The extension of a MIME type that names one exact format (`image/*`, a search's placeholder, does not). */
function specific(mime: string | undefined): string | undefined {
  return mime && !mime.endsWith('/*') ? extensionForMime(mime) : undefined;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

