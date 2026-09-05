import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AppSettings,
  AuditEntry,
  CapabilityGrant,
  ChatMessage,
  InstalledPackRecord,
  Json,
  MemoryEntry,
  ScheduledTimer,
  Session,
  Storage,
} from '@rp/shared';
import { RpError } from '@rp/shared';
import { defaultSettings, mergeSettings } from '../defaults.js';

export interface FileStorageOptions {
  /** Maximum number of audit entries kept in `audit.jsonl`. Default 5000. */
  auditCap?: number;
}

/**
 * Serialises asynchronous work per key so two writers never race on the same
 * file (the second write waits for the first rename to complete).
 */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.tails.set(key, next);
    next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RpError('STORAGE', `Cannot read ${file}: ${(err as Error).message}`, undefined, { cause: err });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new RpError('STORAGE', `Corrupt JSON in ${file}: ${(err as Error).message}`, undefined, { cause: err });
  }
}

/** Write `data` to `file` atomically: temp file in the same directory, fsync, rename. */
async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new RpError('STORAGE', `Cannot write ${file}: ${(err as Error).message}`, undefined, { cause: err });
  }
}

/** Filesystem-safe encoding of an arbitrary key for use as a file name. */
function fileNameFor(key: string): string {
  return encodeURIComponent(key).replace(/\*/g, '%2A').replace(/\./g, '%2E');
}

/**
 * JSON-file `Storage` under `dataDir`. One file per aggregate (settings, packs,
 * grants, sessions, timers), one file per session's messages, one file per
 * state scope, and an append-only JSONL audit log capped at `auditCap` entries.
 * Every write is atomic (temp file + rename) and per-file writes are serialised.
 */
export class FileStorage implements Storage {
  readonly dataDir: string;
  private readonly auditCap: number;
  private readonly queue = new KeyedQueue();
  private readonly cache = new Map<string, unknown>();
  private readonly loading = new Map<string, Promise<unknown>>();
  private auditCache: AuditEntry[] | undefined;

  constructor(dataDir: string, options: FileStorageOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.auditCap = Math.max(1, options.auditCap ?? 5000);
  }

  // ---- generic helpers -------------------------------------------------

  private file(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  /** Load (once) and cache an aggregate; concurrent first loads share one in-flight read. */
  private async load<T>(rel: string, fallback: () => T): Promise<T> {
    if (this.cache.has(rel)) return this.cache.get(rel) as T;
    let inFlight = this.loading.get(rel) as Promise<T> | undefined;
    if (!inFlight) {
      inFlight = readJsonFile<T>(this.file(rel))
        .then((value) => {
          const loaded = value ?? fallback();
          if (!this.cache.has(rel)) this.cache.set(rel, loaded);
          return this.cache.get(rel) as T;
        })
        .finally(() => this.loading.delete(rel));
      this.loading.set(rel, inFlight);
    }
    return inFlight;
  }

  private async save<T>(rel: string, value: T): Promise<void> {
    this.cache.set(rel, value);
    const data = JSON.stringify(value, null, 2);
    await this.queue.run(rel, () => writeAtomic(this.file(rel), data));
  }

  private async unlink(rel: string): Promise<void> {
    this.cache.delete(rel);
    await this.queue.run(rel, () => fs.rm(this.file(rel), { force: true }));
  }

  private async loadList<T>(rel: string): Promise<T[]> {
    const list = await this.load<T[]>(rel, () => []);
    return Array.isArray(list) ? list : [];
  }

  // ---- settings ---------------------------------------------------------

  readonly settings: Storage['settings'] = {
    get: async () =>
      mergeSettings(await this.load<Partial<AppSettings> | undefined>('settings.json', () => undefined), defaultSettings()),
    set: async (settings) => this.save('settings.json', settings),
  };

  // ---- packs ------------------------------------------------------------

  readonly packs: Storage['packs'] = {
    list: async () => [...(await this.loadList<InstalledPackRecord>('packs.json'))],
    get: async (packId) => (await this.loadList<InstalledPackRecord>('packs.json')).find((r) => r.packId === packId),
    upsert: async (record) => {
      const list = (await this.loadList<InstalledPackRecord>('packs.json')).filter((r) => r.packId !== record.packId);
      list.push(record);
      await this.save('packs.json', list);
    },
    remove: async (packId) => {
      const list = (await this.loadList<InstalledPackRecord>('packs.json')).filter((r) => r.packId !== packId);
      await this.save('packs.json', list);
    },
  };

  // ---- grants -----------------------------------------------------------

  readonly grants: Storage['grants'] = {
    list: async (packId) =>
      (await this.loadList<CapabilityGrant>('grants.json')).filter((g) => packId === undefined || g.packId === packId),
    set: async (grant) => {
      const list = (await this.loadList<CapabilityGrant>('grants.json')).filter(
        (g) => !(g.packId === grant.packId && g.module === grant.module),
      );
      list.push(grant);
      await this.save('grants.json', list);
    },
    removeForPack: async (packId) => {
      const list = (await this.loadList<CapabilityGrant>('grants.json')).filter((g) => g.packId !== packId);
      await this.save('grants.json', list);
    },
  };

  // ---- sessions ---------------------------------------------------------

  readonly sessions: Storage['sessions'] = {
    list: async () => [...(await this.loadList<Session>('sessions.json'))],
    get: async (id) => (await this.loadList<Session>('sessions.json')).find((s) => s.id === id),
    upsert: async (session) => {
      const list = await this.loadList<Session>('sessions.json');
      const idx = list.findIndex((s) => s.id === session.id);
      if (idx >= 0) list[idx] = session;
      else list.push(session);
      await this.save('sessions.json', list);
    },
    remove: async (id) => {
      const list = (await this.loadList<Session>('sessions.json')).filter((s) => s.id !== id);
      await this.save('sessions.json', list);
    },
  };

  // ---- messages ---------------------------------------------------------

  private messagesFile(sessionId: string): string {
    return path.join('messages', `${fileNameFor(sessionId)}.json`);
  }

  readonly messages: Storage['messages'] = {
    list: async (sessionId) => [...(await this.loadList<ChatMessage>(this.messagesFile(sessionId)))],
    append: async (message) => {
      const rel = this.messagesFile(message.sessionId);
      const list = await this.loadList<ChatMessage>(rel);
      list.push(message);
      await this.save(rel, list);
    },
    update: async (message) => {
      const rel = this.messagesFile(message.sessionId);
      const list = await this.loadList<ChatMessage>(rel);
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx >= 0) list[idx] = message;
      else list.push(message);
      await this.save(rel, list);
    },
    removeForSession: async (sessionId) => this.unlink(this.messagesFile(sessionId)),
  };

  // ---- state ------------------------------------------------------------

  private stateFile(scope: string): string {
    return path.join('state', `${fileNameFor(scope)}.json`);
  }

  private async loadScope(scope: string): Promise<Record<string, Json>> {
    const value = await this.load<Record<string, Json>>(this.stateFile(scope), () => ({}));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  readonly state: Storage['state'] = {
    get: async (scope, key) => {
      const map = await this.loadScope(scope);
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    },
    set: async (scope, key, value) => {
      const map = await this.loadScope(scope);
      map[key] = value;
      await this.save(this.stateFile(scope), map);
    },
    delete: async (scope, key) => {
      const map = await this.loadScope(scope);
      if (!Object.prototype.hasOwnProperty.call(map, key)) return;
      delete map[key];
      await this.save(this.stateFile(scope), map);
    },
    keys: async (scope) => Object.keys(await this.loadScope(scope)).sort(),
    all: async (scope) => {
      const map = await this.loadScope(scope);
      const out: Record<string, Json> = {};
      for (const key of Object.keys(map).sort()) out[key] = map[key] as Json;
      return out;
    },
    clear: async (scope) => this.unlink(this.stateFile(scope)),
  };

  // ---- timers -----------------------------------------------------------

  readonly timers: Storage['timers'] = {
    list: async () => [...(await this.loadList<ScheduledTimer>('timers.json'))],
    upsert: async (timer) => {
      const list = (await this.loadList<ScheduledTimer>('timers.json')).filter((t) => t.id !== timer.id);
      list.push(timer);
      await this.save('timers.json', list);
    },
    remove: async (id) => {
      const list = (await this.loadList<ScheduledTimer>('timers.json')).filter((t) => t.id !== id);
      await this.save('timers.json', list);
    },
  };

  // ---- memories (one file per character) ---------------------------------

  private memoriesFile(characterRef: string): string {
    return path.join('memories', `${fileNameFor(characterRef)}.json`);
  }

  /** Every character ref that has a memories file (cached or on disk). */
  private async memoryScopes(): Promise<string[]> {
    const refs = new Set<string>();
    for (const key of this.cache.keys()) {
      if (key.startsWith(`memories${path.sep}`)) refs.add(decodeURIComponent(path.basename(key, '.json')));
    }
    const names = await fs.readdir(this.file('memories')).catch(() => [] as string[]);
    for (const name of names) if (name.endsWith('.json')) refs.add(decodeURIComponent(name.slice(0, -5)));
    return [...refs];
  }

  readonly memories: Storage['memories'] = {
    list: async (characterRef) => [...(await this.loadList<MemoryEntry>(this.memoriesFile(characterRef)))],
    get: async (id) => {
      for (const ref of await this.memoryScopes()) {
        const found = (await this.loadList<MemoryEntry>(this.memoriesFile(ref))).find((m) => m.id === id);
        if (found) return found;
      }
      return undefined;
    },
    upsert: async (entry) => {
      const rel = this.memoriesFile(entry.characterRef);
      const list = await this.loadList<MemoryEntry>(rel);
      const idx = list.findIndex((m) => m.id === entry.id);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      await this.save(rel, list);
    },
    remove: async (id) => {
      for (const ref of await this.memoryScopes()) {
        const rel = this.memoriesFile(ref);
        const list = await this.loadList<MemoryEntry>(rel);
        const idx = list.findIndex((m) => m.id === id);
        if (idx < 0) continue;
        list.splice(idx, 1);
        await this.save(rel, list);
        return;
      }
    },
    removeForCharacter: async (characterRef) => this.unlink(this.memoriesFile(characterRef)),
  };

  // ---- audit (JSONL) ----------------------------------------------------

  private async loadAudit(): Promise<AuditEntry[]> {
    if (this.auditCache) return this.auditCache;
    let text = '';
    try {
      text = await fs.readFile(this.file('audit.jsonl'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RpError('STORAGE', `Cannot read audit log: ${(err as Error).message}`, undefined, { cause: err });
      }
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // skip a torn/corrupt line rather than losing the whole log
      }
    }
    this.auditCache = entries.slice(-this.auditCap);
    return this.auditCache;
  }

  readonly audit: Storage['audit'] = {
    append: async (entry) => {
      const entries = await this.loadAudit();
      entries.push(entry);
      const file = this.file('audit.jsonl');
      if (entries.length > this.auditCap) {
        entries.splice(0, entries.length - this.auditCap);
        const data = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await this.queue.run('audit.jsonl', () => writeAtomic(file, data));
      } else {
        const line = JSON.stringify(entry) + '\n';
        await this.queue.run('audit.jsonl', async () => {
          await fs.mkdir(this.dataDir, { recursive: true });
          await fs.appendFile(file, line, 'utf8');
        });
      }
    },
    list: async (options) => {
      let entries = await this.loadAudit();
      if (options?.sessionId !== undefined) entries = entries.filter((e) => e.sessionId === options.sessionId);
      if (options?.limit !== undefined) entries = entries.slice(-Math.max(0, options.limit));
      return [...entries];
    },
  };

  async close(): Promise<void> {
    // Wait for queued writes to settle by chaining a no-op onto every known key.
    const keys = [...this.cache.keys(), 'audit.jsonl'];
    await Promise.all(keys.map((k) => this.queue.run(k, async () => undefined)));
  }
}
