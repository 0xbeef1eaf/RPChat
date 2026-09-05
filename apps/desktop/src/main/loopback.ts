/**
 * Loopback media server (docs/spec/overlay.md §1.0): lets native overlay
 * helpers load the app's media page and pack assets over http on 127.0.0.1.
 * Every path carries a random token; assets reuse the rp-asset:// guard and
 * Range logic from `asset-protocol.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { MediaCommand } from '@rp/shared';
import { ASSET_PROTOCOL } from '@rp/shared';
import { handleAssetRequest } from './asset-protocol.js';
import type { AssetProtocolDeps } from './asset-protocol.js';

export interface LoopbackServerLike {
  /** `http://127.0.0.1:<port>/t/<token>` */
  readonly baseUrl: string;
  /** `rp-asset://pack/a/b.png` → `<base>/asset/pack/a/b.png`; other URLs are returned unchanged. */
  rewriteAssetUrl(url: string): string;
  /** `<base>/media.html#cmd=<base64url JSON>` */
  mediaPageUrl(initial: MediaCommand): string;
}

export interface LoopbackServerOptions {
  /** Absolute directory with the built renderer (`out/renderer`). */
  rendererDir: string;
  /** Vite dev server origin (`ELECTRON_RENDERER_URL`); when set, page requests are proxied there. */
  devServerUrl?: string;
  assets: AssetProtocolDeps;
  logger?: Pick<Console, 'info' | 'warn' | 'debug'>;
  token?: string;
}

export function encodeCommandHash(command: MediaCommand): string {
  return Buffer.from(JSON.stringify(command), 'utf8').toString('base64url');
}

export function decodeCommandHash(hash: string): MediaCommand | undefined {
  const m = /(?:^#?|[#&])cmd=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m || !m[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as MediaCommand;
  } catch {
    return undefined;
  }
}

/** Pure URL rewrite used by `LoopbackServer.rewriteAssetUrl`. */
export function rewriteAssetUrl(url: string, baseUrl: string): string {
  const prefix = `${ASSET_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return url;
  const rest = url.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return url;
  const packId = rest.slice(0, slash);
  const relative = rest.slice(slash + 1);
  return `${baseUrl}/asset/${packId}/${relative}`;
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

export class LoopbackServer implements LoopbackServerLike {
  readonly token: string;
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly opts: LoopbackServerOptions) {
    this.token = opts.token ?? randomBytes(32).toString('hex');
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/t/${this.token}`;
  }

  rewriteAssetUrl(url: string): string {
    return rewriteAssetUrl(url, this.baseUrl);
  }

  mediaPageUrl(initial: MediaCommand): string {
    return `${this.baseUrl}/media.html#cmd=${encodeCommandHash(initial)}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.logger?.warn?.('[loopback] request failed', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      });
    });
    server.keepAliveTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.opts.logger?.info?.(`[loopback] media server listening on 127.0.0.1:${this.port}`);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Route: `/t/<token>/asset/<packId>/<path>` | `/t/<token>/<page or static>` | (dev only) anything → vite. */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const tokenPrefix = `/t/${this.token}/`;
    if (url.pathname.startsWith(tokenPrefix)) {
      const rest = url.pathname.slice(tokenPrefix.length);
      if (rest.startsWith('asset/')) {
        const assetUrl = `${ASSET_PROTOCOL}://${rest.slice('asset/'.length)}`;
        const response = await handleAssetRequest(
          { url: assetUrl, method: req.method ?? 'GET', headers: { get: (name) => firstHeader(req.headers[name.toLowerCase()]) } },
          this.opts.assets,
        );
        await pipeFetchResponse(response, res);
        return;
      }
      await this.servePage(rest.length === 0 ? 'media.html' : rest, url, req, res);
      return;
    }
    if (this.opts.devServerUrl && url.pathname !== '/' ) {
      // Vite emits absolute module URLs (/src/…, /@vite/client, /node_modules/…) in dev.
      await this.proxy(url.pathname + url.search, req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private async servePage(rel: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.opts.devServerUrl) {
      await this.proxy(`/${rel}${url.search}`, req, res);
      return;
    }
    const root = path.resolve(this.opts.rendererDir);
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(file);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      stream.pipe(res);
    });
  }

  private async proxy(pathWithQuery: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = new URL(pathWithQuery, this.opts.devServerUrl);
    const headers: Record<string, string> = {};
    for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since']) {
      const value = firstHeader(req.headers[name]);
      if (value) headers[name] = value;
    }
    const upstream = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers });
    await pipeFetchResponse(upstream, res);
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function pipeFetchResponse(response: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key === 'content-encoding' || key === 'transfer-encoding' || key === 'connection') return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}
