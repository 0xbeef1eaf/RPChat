/**
 * Remote media sources (docs/spec/plugins.md "Remote media sources"): places outside the pack —
 * a photo library, an image site, a stock-media API — that plugins connect and characters search
 * through `sdk.mediaSources`. A search hands back `AssetRef`s with `source: 'remote'` whose path is
 * `<sourceId>/<itemId>`; `sdk.media` takes them like any other asset and the host asks `locate`
 * where the bytes are when one is shown.
 *
 * Everything a provider returns is checked here, since it is plugin code: items that are not
 * shaped right are dropped (and logged) rather than failing the whole search, a location that is
 * neither an http(s) URL nor an absolute file is refused, and both calls are bounded in time.
 */
import * as path from 'node:path';
import type { ActionContext, Json, MediaKind, MediaSourceInfo, MediaSourceProvider, MediaSourceQuery, RemoteMediaItem, RemoteMediaLocation } from '@rp/shared';
import { MEDIA_SOURCE_ID_PATTERN, RpError, parseRemoteAssetPath, remoteItemIdProblem } from '@rp/shared';
import type { AssetRef } from '../assets.js';
import type { Logger } from '../types.js';

export const MEDIA_SOURCE_SEARCH_DEFAULT_LIMIT = 20;
export const MEDIA_SOURCE_SEARCH_MAX_LIMIT = 50;
/** How long a provider may take to answer `search` or `fetch` before the call fails. */
export const MEDIA_SOURCE_TIMEOUT_MS = 30_000;
/** Search results remembered for typing `remote:` strings (oldest forgotten first). */
export const MEDIA_SOURCE_REMEMBERED = 2000;

const MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>(['image', 'video', 'audio']);
const PLUGIN_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const QUERY_TEXT_MAX = 500;
const QUERY_TAGS_MAX = 20;

/** What the dispatcher needs to accept a remote asset argument. */
export interface RemoteAssetLookup {
  /** Whether a source with this id is registered right now. */
  hasSource(sourceId: string): boolean;
  /** The ref a recent search returned for this path (`<sourceId>/<itemId>`), if any. */
  describe(assetPath: string): AssetRef | undefined;
}

export interface MediaSourceServiceOptions {
  logger: Logger;
  timeoutMs?: number;
  remembered?: number;
}

export class MediaSourceService implements RemoteAssetLookup {
  private readonly sources = new Map<string, { info: MediaSourceInfo; provider: MediaSourceProvider }>();
  /** Search results by path, oldest first (a Map keeps insertion order; a hit is moved to the end). */
  private readonly seen = new Map<string, AssetRef>();
  private readonly listeners = new Set<() => void>();
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly remembered: number;

  constructor(opts: MediaSourceServiceOptions) {
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? MEDIA_SOURCE_TIMEOUT_MS;
    this.remembered = opts.remembered ?? MEDIA_SOURCE_REMEMBERED;
  }

  /** Add a source. Its `id` must be `<pluginId>/<localId>` and not taken. Throws INVALID_ARGUMENT. */
  register(info: MediaSourceInfo, provider: MediaSourceProvider): void {
    const [pluginId, local, ...rest] = typeof info?.id === 'string' ? info.id.split('/') : [];
    if (pluginId === undefined || local === undefined || rest.length > 0 || !PLUGIN_ID.test(pluginId) || !MEDIA_SOURCE_ID_PATTERN.test(local) || pluginId !== info.pluginId) {
      throw new RpError('INVALID_ARGUMENT', `A media source id must be "<pluginId>/<id>" with id matching ${MEDIA_SOURCE_ID_PATTERN} (got ${JSON.stringify(info?.id)})`);
    }
    if (this.sources.has(info.id)) throw new RpError('INVALID_ARGUMENT', `Media source "${info.id}" is already registered`, { source: info.id });
    if (!Array.isArray(info.kinds) || info.kinds.length === 0 || !info.kinds.every((k) => MEDIA_KINDS.has(k))) {
      throw new RpError('INVALID_ARGUMENT', `Media source "${info.id}" must serve at least one of image, video, audio`, { source: info.id });
    }
    if (typeof provider?.search !== 'function' || typeof provider.fetch !== 'function') {
      throw new RpError('INVALID_ARGUMENT', `Media source "${info.id}" needs a provider with search(query, context) and fetch(itemId, context)`, { source: info.id });
    }
    this.sources.set(info.id, { info: { ...info, kinds: [...new Set(info.kinds)] }, provider });
    this.logger.info(`[media-sources] registered "${info.id}"`);
    this.changed();
  }

  /** Remove a source and forget its search results. Returns false when it was not registered. */
  unregister(sourceId: string): boolean {
    if (!this.sources.delete(sourceId)) return false;
    for (const key of [...this.seen.keys()]) if (key.startsWith(`${sourceId}/`)) this.seen.delete(key);
    this.logger.info(`[media-sources] unregistered "${sourceId}"`);
    this.changed();
    return true;
  }

  list(): MediaSourceInfo[] {
    return [...this.sources.values()].map((s) => ({ ...s.info, kinds: [...s.info.kinds] }));
  }

  hasSource(sourceId: string): boolean {
    return this.sources.has(sourceId);
  }

  /** Called after every register/unregister. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  describe(assetPath: string): AssetRef | undefined {
    const ref = this.seen.get(assetPath);
    if (ref === undefined) return undefined;
    this.seen.delete(assetPath);
    this.seen.set(assetPath, ref);
    return ref;
  }

  /** `sdk.mediaSources.search`: ask one source, check what it says, remember the results. */
  async search(sourceArg: unknown, queryArg: unknown, context: ActionContext): Promise<AssetRef[]> {
    const source = this.require(sourceArg);
    const query = normaliseQuery(queryArg, source.info);
    const limit = query.limit ?? MEDIA_SOURCE_SEARCH_DEFAULT_LIMIT;
    const raw = await this.bounded(`search ${source.info.id}`, () => source.provider.search(query, context));
    if (!Array.isArray(raw)) {
      throw new RpError('CAPABILITY_FAILED', `Media source "${source.info.id}" returned no list of results`, { source: source.info.id });
    }
    const out: AssetRef[] = [];
    let dropped = 0;
    for (const item of raw) {
      if (out.length >= limit) break;
      const ref = toRemoteRef(source.info, item, query.kind);
      if (ref === undefined) {
        dropped++;
        continue;
      }
      out.push(ref);
      this.remember(ref);
    }
    if (dropped > 0) this.logger.warn(`[media-sources] ${source.info.id}: dropped ${dropped} result(s) that were not { id, kind } of a kind the source serves`);
    return out;
  }

  /**
   * Where the bytes of the remote asset at `assetPath` are, as its source says now — together with
   * the ref a search returned for it, when one is remembered (its MIME type names the download).
   * Throws NOT_FOUND for a malformed path or a source that is gone.
   */
  async locate(assetPath: string, context: ActionContext): Promise<{ location: RemoteMediaLocation; ref?: AssetRef }> {
    const parsed = parseRemoteAssetPath(assetPath);
    if (!parsed) throw new RpError('NOT_FOUND', `"${assetPath}" does not name an item of a remote media source`, { path: assetPath, source: 'remote' });
    const source = this.require(parsed.sourceId);
    const location = await this.bounded(`fetch ${assetPath}`, () => source.provider.fetch(parsed.itemId, context));
    const checked = checkLocation(location);
    if (typeof checked === 'string') {
      throw new RpError('CAPABILITY_FAILED', `Media source "${source.info.id}" gave no usable location for "${parsed.itemId}": ${checked}`, { source: source.info.id, path: assetPath });
    }
    const ref = this.seen.get(assetPath);
    return ref ? { location: checked, ref } : { location: checked };
  }

  private require(sourceArg: unknown): { info: MediaSourceInfo; provider: MediaSourceProvider } {
    if (typeof sourceArg !== 'string' || sourceArg.length === 0) throw new RpError('INVALID_ARGUMENT', 'source must be a media source id from sdk.mediaSources.list()');
    const source = this.sources.get(sourceArg);
    if (!source) {
      const known = [...this.sources.keys()];
      throw new RpError('NOT_FOUND', `There is no media source "${sourceArg}"${known.length > 0 ? `; there are: ${known.join(', ')}` : ' (none are installed right now)'}`, { source: sourceArg, sources: known });
    }
    return source;
  }

  /** Run a provider call with the timeout, turning a plain error into CAPABILITY_FAILED with the source named. */
  private async bounded<T>(what: string, call: () => Promise<T> | T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RpError('CAPABILITY_FAILED', `Media source ${what} took longer than ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(call), timeout]);
    } catch (err) {
      if (err instanceof RpError) throw err;
      throw new RpError('CAPABILITY_FAILED', `Media source ${what} failed: ${(err as Error)?.message ?? String(err)}`, undefined, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(ref: AssetRef): void {
    this.seen.delete(ref.path);
    this.seen.set(ref.path, ref);
    while (this.seen.size > this.remembered) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        this.logger.warn('[media-sources] change listener threw', err);
      }
    }
  }
}

/** The character's query as the provider gets it: known fields only, each checked and bounded. */
export function normaliseQuery(raw: unknown, info: Pick<MediaSourceInfo, 'id' | 'kinds'>): MediaSourceQuery {
  if (raw === undefined || raw === null) return { limit: MEDIA_SOURCE_SEARCH_DEFAULT_LIMIT };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RpError('INVALID_ARGUMENT', 'query must be an object');
  const q = raw as Record<string, unknown>;
  const out: MediaSourceQuery = {};
  if (q.text !== undefined && q.text !== null) {
    if (typeof q.text !== 'string') throw new RpError('INVALID_ARGUMENT', 'query.text must be a string');
    const text = q.text.trim().slice(0, QUERY_TEXT_MAX);
    if (text.length > 0) out.text = text;
  }
  if (q.tags !== undefined && q.tags !== null) {
    if (!Array.isArray(q.tags) || !q.tags.every((t) => typeof t === 'string')) throw new RpError('INVALID_ARGUMENT', 'query.tags must be an array of strings');
    const tags = [...new Set((q.tags as string[]).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))].slice(0, QUERY_TAGS_MAX);
    if (tags.length > 0) out.tags = tags;
  }
  if (q.kind !== undefined && q.kind !== null) {
    if (typeof q.kind !== 'string' || !MEDIA_KINDS.has(q.kind)) throw new RpError('INVALID_ARGUMENT', 'query.kind must be one of image, video, audio');
    if (!info.kinds.includes(q.kind as MediaKind)) {
      throw new RpError('INVALID_ARGUMENT', `Media source "${info.id}" has no ${q.kind}; it serves ${info.kinds.join(', ')}`, { source: info.id, kind: q.kind });
    }
    out.kind = q.kind as MediaKind;
  }
  out.limit = MEDIA_SOURCE_SEARCH_DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== null) {
    if (typeof q.limit !== 'number' || !Number.isFinite(q.limit) || q.limit < 1) throw new RpError('INVALID_ARGUMENT', 'query.limit must be a positive number');
    out.limit = Math.min(MEDIA_SOURCE_SEARCH_MAX_LIMIT, Math.floor(q.limit));
  }
  if (q.page !== undefined && q.page !== null) {
    if (typeof q.page !== 'number' || !Number.isInteger(q.page) || q.page < 1) throw new RpError('INVALID_ARGUMENT', 'query.page must be a whole number from 1');
    out.page = q.page;
  }
  return out;
}

/** A provider's result as the character sees it, or undefined when it is not one the source may return. */
function toRemoteRef(info: MediaSourceInfo, raw: unknown, kind: MediaKind | undefined): AssetRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const item = raw as Partial<RemoteMediaItem>;
  if (remoteItemIdProblem(item.id) !== undefined || typeof item.kind !== 'string' || !info.kinds.includes(item.kind)) return undefined;
  if (kind !== undefined && item.kind !== kind) return undefined;
  const ref: AssetRef = {
    source: 'remote',
    path: `${info.id}/${item.id as string}`,
    kind: item.kind,
    mime: typeof item.mime === 'string' && /^[a-z]+\/[\w.+-]+$/i.test(item.mime) ? item.mime.toLowerCase() : `${item.kind}/*`,
    bytes: typeof item.bytes === 'number' && Number.isFinite(item.bytes) && item.bytes >= 0 ? Math.floor(item.bytes) : 0,
    tags: Array.isArray(item.tags) ? [...new Set(item.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))].sort() : [],
  };
  if (typeof item.description === 'string' && item.description.trim().length > 0) ref.description = item.description.trim().slice(0, 300);
  return ref;
}

/** The location if it is one the host can use, else why not. */
function checkLocation(raw: unknown): RemoteMediaLocation | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'fetch() must return { url, headers? } or { file }';
  const loc = raw as { url?: unknown; headers?: unknown; file?: unknown };
  if (typeof loc.url === 'string') {
    let url: URL;
    try {
      url = new URL(loc.url);
    } catch {
      return `"${loc.url}" is not a URL`;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return `only http(s) URLs can be downloaded (got ${url.protocol})`;
    if (loc.headers === undefined || loc.headers === null) return { url: url.href };
    if (typeof loc.headers !== 'object' || Array.isArray(loc.headers) || !Object.values(loc.headers as Record<string, Json>).every((v) => typeof v === 'string')) {
      return 'headers must be an object of strings';
    }
    return { url: url.href, headers: { ...(loc.headers as Record<string, string>) } };
  }
  if (typeof loc.file === 'string') {
    if (!path.isAbsolute(loc.file)) return `file must be an absolute path (got "${loc.file}")`;
    return { file: loc.file };
  }
  return 'fetch() must return { url, headers? } or { file }';
}
