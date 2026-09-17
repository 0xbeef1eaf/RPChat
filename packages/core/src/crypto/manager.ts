/**
 * `sdk.crypto`'s two verbs, `encrypt(path)` and `decrypt(path)`, plus key rotation and
 * `decrypt-all`. Ties together the key store ([[CryptoKeyStore]]), the file format
 * (`engine.ts`), the log (`log.ts`) and the safety filter (`filter.ts`). Runs as the user —
 * there is no elevation anywhere in this file — so the only files it can ever reach are ones the
 * OS already lets this process read and write; [[isWithinHome]] and [[looksLikeSystemFile]] are
 * an additional, narrower promise on top of that: this module only ever touches the user's own
 * documents under their home directory, never something a desktop session or a service depends
 * on staying exactly as it is.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RpError } from '@rp/shared';
import { decryptContainer, encryptBuffer, isEncryptedContainer, md5Hex, parseContainer } from './engine.js';
import { isWithinHome, looksLikeSystemFile } from './filter.js';
import type { CryptoKeyStore } from './key-store.js';
import type { CryptoLog, CryptoLogEntry } from './log.js';

/** Files larger than this are refused rather than read whole into memory. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface CryptoManagerOptions {
  keyStore: CryptoKeyStore;
  log: CryptoLog;
  /** The user's home directory; defaults to `os.homedir()`. Overridable for tests and for `decrypt-all --home`. */
  home?: string;
}

export interface EncryptResult {
  path: string;
  keyId: string;
  beforeMd5: string;
  afterMd5: string;
}

export interface DecryptResult {
  path: string;
  keyId: string;
}

export interface DecryptAllOutcome {
  path: string;
  ok: boolean;
  /** Present when `ok` is false, or when the entry was skipped rather than attempted. */
  reason?: string;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export class CryptoManager {
  private readonly keyStore: CryptoKeyStore;
  private readonly log: CryptoLog;
  private readonly home: string;

  constructor(opts: CryptoManagerOptions) {
    this.keyStore = opts.keyStore;
    this.log = opts.log;
    this.home = opts.home ?? os.homedir();
  }

  /** Absolute, home-scoped path for `p`, or throws `PATH_ESCAPE`/`INVALID_ARGUMENT`. Shared by `encrypt`, `decrypt` and `decryptAll`. */
  private resolvePath(p: unknown): string {
    if (typeof p !== 'string' || p.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'path must be a non-empty string');
    const expanded = path.normalize(expandHome(p.trim(), this.home));
    if (!path.isAbsolute(expanded)) throw new RpError('INVALID_ARGUMENT', `path must be absolute (or start with ~): ${p}`);
    if (!isWithinHome(expanded, this.home)) throw new RpError('PATH_ESCAPE', `${expanded} is outside the home directory; sdk.crypto only reaches the user's own files`);
    if (looksLikeSystemFile(expanded)) throw new RpError('PATH_ESCAPE', `${expanded} looks like a system/session file, not a personal document; refusing to touch it`);
    return expanded;
  }

  private async readRegularFile(file: string): Promise<Buffer> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(file);
    } catch (err) {
      throw new RpError('NOT_FOUND', `${file}: ${(err as Error).message}`, { path: file }, { cause: err });
    }
    if (!stat.isFile()) throw new RpError('INVALID_ARGUMENT', `${file} is not a regular file (symlinks are refused)`);
    if (stat.size > MAX_FILE_BYTES) throw new RpError('INVALID_ARGUMENT', `${file} is larger than the ${MAX_FILE_BYTES} byte limit`);
    return fs.readFile(file);
  }

  /** Encrypt the file at `p` in place under the active key, and log it. */
  async encrypt(p: unknown): Promise<EncryptResult> {
    const file = this.resolvePath(p);
    const plaintext = await this.readRegularFile(file);
    if (isEncryptedContainer(plaintext)) throw new RpError('INVALID_ARGUMENT', `${file} is already encrypted`);
    const beforeMd5 = md5Hex(plaintext);
    const key = await this.keyStore.activeKey();
    const container = encryptBuffer(plaintext, key.key, key.id);
    const afterMd5 = md5Hex(container);
    try {
      await fs.writeFile(file, container);
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot write ${file}: ${(err as Error).message}`, { path: file }, { cause: err });
    }
    await this.log.append({ path: file, keyId: key.id, beforeMd5, afterMd5, encryptedAt: new Date().toISOString() });
    return { path: file, keyId: key.id, beforeMd5, afterMd5 };
  }

  /** Decrypt the file at `p` in place, resolving its key from the container's own key id (not from the log — the log only tells `decryptAll` which paths to visit). */
  async decrypt(p: unknown): Promise<DecryptResult> {
    const file = this.resolvePath(p);
    const data = await this.readRegularFile(file);
    const container = parseContainer(data);
    const key = await this.keyStore.key(container.keyId);
    if (!key) throw new RpError('CAPABILITY_FAILED', `the key ("${container.keyId}") that encrypted ${file} is no longer in the key history`);
    const plaintext = decryptContainer(container, key.key);
    try {
      await fs.writeFile(file, plaintext);
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot write ${file}: ${(err as Error).message}`, { path: file }, { cause: err });
    }
    const pending = await this.log.latestPending(file);
    if (pending) await this.log.markDecrypted(pending.id);
    return { path: file, keyId: container.keyId };
  }

  /** Generate a new key and make it active; past files stay decryptable under their own key. */
  async rotateKey(): Promise<{ id: string; createdAt: string }> {
    const key = await this.keyStore.rotate();
    return { id: key.id, createdAt: key.createdAt };
  }

  /** The key history, oldest first, without key material. */
  async listKeys(): Promise<Array<{ id: string; createdAt: string }>> {
    return (await this.keyStore.list()).map((k) => ({ id: k.id, createdAt: k.createdAt }));
  }

  /** The id `encrypt` would use right now (creating the user's first key if none exists yet). */
  async activeKeyId(): Promise<string> {
    return (await this.keyStore.activeKey()).id;
  }

  /** Paths the log still has pending, without decrypting anything — what a status display counts. */
  async listPendingPaths(): Promise<string[]> {
    return (await this.log.pending()).map((e) => e.path);
  }

  /**
   * Decrypt every file the log still has pending for this user: applies the same home/system
   * filters `decrypt` does, skips a path that moved, was removed, or no longer looks encrypted
   * (someone already restored it by hand), and never throws for one bad entry — the outcome
   * list says what happened to each.
   */
  async decryptAll(): Promise<DecryptAllOutcome[]> {
    const entries = await this.log.pending();
    const out: DecryptAllOutcome[] = [];
    for (const entry of entries) {
      out.push(await this.decryptPendingEntry(entry));
    }
    return out;
  }

  private async decryptPendingEntry(entry: CryptoLogEntry): Promise<DecryptAllOutcome> {
    let file: string;
    try {
      file = this.resolvePath(entry.path);
    } catch (err) {
      return { path: entry.path, ok: false, reason: `refused: ${(err as Error).message}` };
    }
    let data: Buffer;
    try {
      data = await this.readRegularFile(file);
    } catch (err) {
      if (err instanceof RpError && err.code === 'NOT_FOUND') return { path: file, ok: false, reason: 'no longer exists' };
      return { path: file, ok: false, reason: (err as Error).message };
    }
    if (!isEncryptedContainer(data)) {
      // Already plaintext (restored by hand, or re-encrypted and decrypted since this entry) —
      // close the entry out rather than leaving it permanently pending.
      await this.log.markDecrypted(entry.id);
      return { path: file, ok: true, reason: 'already decrypted' };
    }
    try {
      await this.decrypt(file);
      return { path: file, ok: true };
    } catch (err) {
      return { path: file, ok: false, reason: (err as Error).message };
    }
  }
}
