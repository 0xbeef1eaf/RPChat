/**
 * The record of every file `sdk.crypto.encrypt` has touched: what the path was, an md5 of the
 * content before and after, which key did it, and — once `decrypt` or `decrypt-all` has been
 * through — when it came back. This is the only thing `decrypt-all` (`decrypt-all-cli.ts`) has
 * to go on to find "every file this app encrypted": there is no file-extension convention to
 * scan for, on purpose, so a renamed or moved encrypted file is still found by path history
 * rather than guessed at from its name.
 *
 * Holds no key material — only paths and checksums — so, unlike `key-store.ts`, one file format
 * serves both the daemon and no-daemon cases; it always lives in the app's own storage.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RpError } from '@rp/shared';

export interface CryptoLogEntry {
  id: string;
  /** Absolute path at the time of encryption (the file may since have moved or been deleted). */
  path: string;
  keyId: string;
  beforeMd5: string;
  afterMd5: string;
  encryptedAt: string;
  /** Set once `decrypt`/`decrypt-all` has restored this path from this entry's encryption. */
  decryptedAt?: string;
}

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

/** JSON-array log of every `encrypt` and its later `decrypt`, one file, rewritten atomically. */
export class CryptoLog {
  private readonly file: string;
  private cache: CryptoLogEntry[] | undefined;

  constructor(dir: string) {
    this.file = path.join(dir, 'log.json');
  }

  private async load(): Promise<CryptoLogEntry[]> {
    if (this.cache) return this.cache;
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = [];
        return this.cache;
      }
      throw new RpError('STORAGE', `Cannot read ${this.file}: ${(err as Error).message}`, undefined, { cause: err });
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      this.cache = Array.isArray(parsed) ? (parsed as CryptoLogEntry[]) : [];
    } catch (err) {
      throw new RpError('STORAGE', `Corrupt JSON in ${this.file}: ${(err as Error).message}`, undefined, { cause: err });
    }
    return this.cache;
  }

  private async save(entries: CryptoLogEntry[]): Promise<void> {
    this.cache = entries;
    await writeAtomic(this.file, JSON.stringify(entries, null, 2));
  }

  /** Record a fresh encryption. */
  async append(entry: Omit<CryptoLogEntry, 'id'>): Promise<CryptoLogEntry> {
    const full: CryptoLogEntry = { id: randomBytes(8).toString('hex'), ...entry };
    const entries = await this.load();
    await this.save([...entries, full]);
    return full;
  }

  /** The most recent entry for `absPath` that has not been marked decrypted yet, if any. */
  async latestPending(absPath: string): Promise<CryptoLogEntry | undefined> {
    const entries = await this.load();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && entry.path === absPath && !entry.decryptedAt) return entry;
    }
    return undefined;
  }

  /** Every entry still awaiting a decrypt, oldest first — what `decrypt-all` walks. */
  async pending(): Promise<CryptoLogEntry[]> {
    return (await this.load()).filter((e) => !e.decryptedAt);
  }

  /** All entries, for listing/diagnostics. */
  async list(): Promise<CryptoLogEntry[]> {
    return [...(await this.load())];
  }

  /** Mark `id` decrypted at `at` (default now). No-op if it is unknown or already marked. */
  async markDecrypted(id: string, at: string = new Date().toISOString()): Promise<void> {
    const entries = await this.load();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0 || entries[idx]?.decryptedAt) return;
    const next = [...entries];
    const target = next[idx];
    if (!target) return;
    next[idx] = { ...target, decryptedAt: at };
    await this.save(next);
  }
}
