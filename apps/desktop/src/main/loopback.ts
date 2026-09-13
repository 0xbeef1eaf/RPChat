/**
 * Loopback server on 127.0.0.1 (docs/spec/overlay.md §1.0, docs/browser-extension.md): lets native
 * overlay helpers load the app's media page and pack assets over http (every such path carries a
 * random token; assets reuse the rp-asset:// guard and Range logic from `asset-protocol.ts`), and
 * hosts the browser-extension bridge: plain routes registered with `route()` (the extension's
 * update manifest and CRX) and WebSocket upgrades handed to `onUpgrade` handlers (`/bridge`).
 * It binds the stable `port` from settings when it can, else an ephemeral one with a warning.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
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
  /** Preferred port (`settings.browser.bridgePort`); 0 or a taken port falls back to an ephemeral one. */
  port?: number;
}

/** A plain-HTTP route (any origin, no token): registered for a path prefix with `route()`. */
export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;
/** An upgrade handler returns true when it took the socket over. */
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) => boolean;

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
  private wanted: number;
  private readonly routes: Array<{ prefix: string; handler: RouteHandler }> = [];
  private readonly upgrades: UpgradeHandler[] = [];

  constructor(private readonly opts: LoopbackServerOptions) {
    this.token = opts.token ?? randomBytes(32).toString('hex');
    this.wanted = normalisePort(opts.port);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/t/${this.token}`;
  }

  /** The port actually bound (0 before `start()`). */
  get listeningPort(): number {
    return this.port;
  }

  /** The port asked for; `portFallback` tells whether it could not be bound. */
  get requestedPort(): number {
    return this.wanted;
  }

  get portFallback(): boolean {
    return this.wanted !== 0 && this.port !== this.wanted;
  }

  /** Serve `prefix` (and everything under it) without a token, e.g. `/extension/`. Returns the unregister function. */
  route(prefix: string, handler: RouteHandler): () => void {
    const entry = { prefix, handler };
    this.routes.push(entry);
    return () => {
      const i = this.routes.indexOf(entry);
      if (i >= 0) this.routes.splice(i, 1);
    };
  }

  /** Take over WebSocket upgrades (first handler returning true wins; others get a 404). */
  onUpgrade(handler: UpgradeHandler): () => void {
    this.upgrades.push(handler);
    return () => {
      const i = this.upgrades.indexOf(handler);
      if (i >= 0) this.upgrades.splice(i, 1);
    };
  }

  /** Bind another port (settings change): closes the listener, keeps routes and upgrade handlers. */
  async rebind(port: number): Promise<void> {
    this.wanted = normalisePort(port);
    if (!this.server) return;
    await this.close();
    await this.start();
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
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      for (const handler of this.upgrades) {
        try {
          if (handler(req, socket, head, url)) return;
        } catch (err) {
          this.opts.logger?.warn?.('[loopback] upgrade handler failed', err);
        }
      }
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    const listen = (port: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(this.wanted);
    } catch (err) {
      if (this.wanted === 0) throw err;
      this.opts.logger?.warn?.(`[loopback] port ${this.wanted} is taken (${(err as Error).message}); falling back to an ephemeral port — the browser extension will not find the app until Settings → Browser is updated`);
      await listen(0);
    }
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.opts.logger?.info?.(`[loopback] server listening on 127.0.0.1:${this.port}${this.portFallback ? ` (wanted ${this.wanted})` : ''}`);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive and upgraded sockets would otherwise hold the listener open.
      server.closeAllConnections();
    });
  }

  /** Route: registered prefixes | `/t/<token>/asset/<packId>/<path>` | `/t/<token>/<page or static>` | (dev only) anything → vite. */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = this.routes.find((r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix.endsWith('/') ? r.prefix : `${r.prefix}/`));
    if (route) {
      await route.handler(req, res, url);
      return;
    }
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

function normalisePort(port: number | undefined): number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
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
