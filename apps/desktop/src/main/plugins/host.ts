/** `PluginHost` implementation: prefixed logging, JSON-file storage, exec, fetch, notifications, custom events. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HostEvent, Json, PluginHost } from '@rp/shared';
import { RpError } from '@rp/shared';

export const PLUGIN_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const PLUGIN_EXEC_OUTPUT_CAP = 1024 * 1024;
export const PLUGIN_FETCH_DEFAULT_TIMEOUT_MS = 20_000;

/** Per-plugin key/value store persisted as one JSON file (writes are serialised and atomic). */
type PluginStorage = PluginHost['storage'];

export class JsonFileStorage implements PluginStorage {
  private data: Record<string, Json> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, Json>> {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown;
      this.data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Json>) : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  private write<T>(task: (data: Record<string, Json>) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const data = await this.load();
      const result = task(data);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get(key: string): Promise<Json | undefined> {
    return (await this.load())[String(key)];
  }

  set(key: string, value: Json): Promise<void> {
    const clean = JSON.parse(JSON.stringify(value ?? null)) as Json;
    return this.write((data) => {
      data[String(key)] = clean;
    });
  }

  delete(key: string): Promise<void> {
    return this.write((data) => {
      delete data[String(key)];
    });
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.load());
  }
}

export interface PluginHostDeps {
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  appVersion: string;
  logger: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  notify(title: string, body: string): void;
  emitHostEvent(event: HostEvent): void;
  fetchImpl?: typeof fetch;
}

export function runPluginExec(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (typeof command !== 'string' || command.length === 0) return Promise.reject(new RpError('INVALID_ARGUMENT', 'command must be a non-empty string'));
  const timeoutMs = Math.max(100, opts.timeoutMs ?? PLUGIN_EXEC_DEFAULT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const append = (cur: string, chunk: Buffer): string => (cur.length >= PLUGIN_EXEC_OUTPUT_CAP ? cur : (cur + chunk.toString('utf8')).slice(0, PLUGIN_EXEC_OUTPUT_CAP));
    child.stdout?.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = append(stderr, c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new RpError('CAPABILITY_FAILED', `Cannot run "${command}": ${err.message}`, undefined, { cause: err }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) stderr += `${stderr.length === 0 || stderr.endsWith('\n') ? '' : '\n'}[rp] process killed after ${timeoutMs} ms`;
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const prefix = `[plugin:${deps.pluginId}]`;
  const storage = new JsonFileStorage(path.join(deps.dataDir, 'storage.json'));
  return {
    pluginId: deps.pluginId,
    pluginDir: deps.pluginDir,
    dataDir: deps.dataDir,
    appVersion: deps.appVersion,
    log: {
      debug: (...args) => deps.logger.debug(prefix, ...args),
      info: (...args) => deps.logger.info(prefix, ...args),
      warn: (...args) => deps.logger.warn(prefix, ...args),
      error: (...args) => deps.logger.error(prefix, ...args),
    },
    storage,
    exec: (command, args = [], opts) => runPluginExec(command, Array.isArray(args) ? args.map(String) : [], opts ?? {}),
    async fetch(url, init = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(100, init.timeoutMs ?? PLUGIN_FETCH_DEFAULT_TIMEOUT_MS));
      try {
        const req: RequestInit = { method: init.method ?? 'GET', headers: init.headers ?? {}, signal: controller.signal };
        if (init.body !== undefined) req.body = init.body;
        const res = await (deps.fetchImpl ?? fetch)(url, req);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, text: await res.text() };
      } catch (err) {
        throw new RpError('CAPABILITY_FAILED', `fetch ${url} failed: ${(err as Error).message}`, undefined, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    },
    notify: (title, body = '') => deps.notify(String(title), String(body)),
    emitEvent: (name, data, opts) => {
      const clean = String(name).trim().replace(/^custom:/, '');
      if (clean.length === 0) throw new RpError('INVALID_ARGUMENT', 'event name must be a non-empty string');
      const base = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Json>) : data === undefined ? {} : { value: data };
      const payload: Record<string, Json> = { ...base, plugin: deps.pluginId };
      if (opts?.characterRef) payload.characterRef = opts.characterRef;
      deps.emitHostEvent({ name: `custom:${clean}` as HostEvent['name'], data: payload, at: new Date().toISOString() });
    },
  };
}
