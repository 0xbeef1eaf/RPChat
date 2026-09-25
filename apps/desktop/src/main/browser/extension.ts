/**
 * The bundled browser extension as the app serves it: locates `resources/extension/`, owns the
 * per-user signing key (`<userData>/extension-key.pem`), packs the CRX (re-packed when the bundled
 * manifest version changes) and answers the loopback routes Chromium's force-install polls:
 * `GET /extension/update.xml`, `GET /extension/rpchat.crx`, `GET /extension/id` — plus
 * `GET /extension/start`, the page the app opens to wake a closed browser.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { extensionIdFromPrivateKeyPem, loadOrCreateKey, packCrx3, readExtensionDir, zipExtension } from './crx.js';
import { crxUrlFor, updateUrlFor, updateXml } from './policy.js';

/**
 * The page `GET /extension/start` serves: what the app opens to get a browser running when a
 * character reaches for one and none is (`sdk.browser` auto-launch), so the user is never left
 * wondering why their browser appeared.
 */
export const START_PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>rpchat</title><style>
 :root { color-scheme: light dark; }
 body { font: 15px/1.6 system-ui, sans-serif; margin: 12vh auto; max-width: 34rem; padding: 0 1.5rem; }
 h1 { font-size: 1.3rem; margin: 0 0 .6rem; }
 p { margin: 0 0 .8rem; opacity: .85; }
</style></head>
<body>
 <h1>rpchat opened your browser</h1>
 <p>A character asked to work in your browser while it was closed, so rpchat started it. The
 rpchat browser bridge extension is connecting; you can go on browsing in this tab.</p>
 <p>Settings &rarr; Browser in rpchat switches this off (&ldquo;Start the browser when a character needs it&rdquo;).</p>
</body>
</html>
`;

export const EXTENSION_KEY_FILENAME = 'extension-key.pem';
export const EXTENSION_ROUTE_PREFIX = '/extension';

export interface ExtensionServiceDeps {
  /** Directories that may contain `extension/manifest.json` (packaged resources first). */
  resourcesDirs: string[];
  /** Where the signing key lives (created on first use, `0600`). */
  keyFile: string;
  /** The loopback port the update URL must name. */
  port: () => number;
  logger: Pick<Console, 'info' | 'warn' | 'debug'>;
}

interface Packed {
  version: string;
  id: string;
  crx: Buffer;
  builtAt: number;
}

export class ExtensionService {
  private key: Promise<string> | undefined;
  private packed: Packed | undefined;
  private packing: Promise<Packed> | undefined;

  constructor(private readonly deps: ExtensionServiceDeps) {}

  /** Absolute path of the unpacked extension (for "Load unpacked"), or undefined when not bundled. */
  dir(): string | undefined {
    for (const base of this.deps.resourcesDirs) {
      const candidate = path.join(base, 'extension');
      if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
    }
    return undefined;
  }

  /** Version from the bundled manifest, or undefined when not bundled / unreadable. */
  async version(): Promise<string | undefined> {
    const dir = this.dir();
    if (!dir) return undefined;
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown };
      return typeof manifest.version === 'string' ? manifest.version : undefined;
    } catch {
      return undefined;
    }
  }

  private privateKey(): Promise<string> {
    if (!this.key) {
      this.key = loadOrCreateKey(this.deps.keyFile, this.deps.logger).catch((err) => {
        this.key = undefined;
        throw err;
      });
    }
    return this.key;
  }

  /** The extension id Chrome will assign to the CRX signed with this user's key. */
  async id(): Promise<string> {
    return extensionIdFromPrivateKeyPem(await this.privateKey());
  }

  updateUrl(): string {
    return updateUrlFor(this.deps.port());
  }

  /** The signed CRX for the bundled extension, packed once per manifest version. */
  async crx(): Promise<Packed> {
    const version = await this.version();
    if (!version) throw new Error('The browser extension is not bundled with this build (resources/extension)');
    if (this.packed && this.packed.version === version) return this.packed;
    if (!this.packing) {
      this.packing = this.pack(version).finally(() => {
        this.packing = undefined;
      });
    }
    return this.packing;
  }

  private async pack(version: string): Promise<Packed> {
    const dir = this.dir();
    if (!dir) throw new Error('The browser extension is not bundled with this build (resources/extension)');
    const files = await readExtensionDir(dir);
    const zip = zipExtension(files);
    const { crx, id } = packCrx3(zip, await this.privateKey());
    this.packed = { version, id, crx, builtAt: Date.now() };
    this.deps.logger.info(`[browser] packed extension ${version} as ${id} (${crx.length} bytes)`);
    return this.packed;
  }

  /** Loopback route handler for everything under `/extension/`. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    const rel = url.pathname.slice(EXTENSION_ROUTE_PREFIX.length).replace(/^\/+/, '');
    try {
      if (rel === 'id') {
        const id = await this.id();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : id);
        return;
      }
      if (rel === 'start') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(START_PAGE_HTML)) });
        res.end(req.method === 'HEAD' ? undefined : START_PAGE_HTML);
        return;
      }
      if (rel === 'update.xml') {
        const packed = await this.crx();
        const body = updateXml(packed.id, packed.version, crxUrlFor(this.deps.port()));
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (rel === 'rpchat.crx') {
        const packed = await this.crx();
        res.writeHead(200, { 'Content-Type': 'application/x-chrome-extension', 'Cache-Control': 'no-store', 'Content-Length': String(packed.crx.length) });
        res.end(req.method === 'HEAD' ? undefined : packed.crx);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      this.deps.logger.warn(`[browser] /extension/${rel} failed`, err);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((err as Error).message);
    }
  }
}
