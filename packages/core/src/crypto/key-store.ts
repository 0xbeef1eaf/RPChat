/**
 * Where the `sdk.crypto` key history lives. Two implementations of the same interface, chosen
 * once at startup and never mixed for the same user: [[LocalKeyStore]] when the system daemon
 * (`rpchatd`) is not installed, [[DaemonKeyStore]] (`daemon-key-store.ts`) when it is — see
 * `docs/system-integration.md`. Both keep the *history*, never just the active key, because a
 * file encrypted under an old key still needs that key to come back.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CryptoKeyRecord } from '@rp/shared';
import { RpError } from '@rp/shared';
import { KEY_BYTES } from './engine.js';

/** A key with its material decoded, ready for `engine.ts`. */
export interface CryptoKey {
  id: string;
  createdAt: string;
  key: Buffer;
}

export interface CryptoKeyStore {
  /** The key `encrypt` should use now; creates the user's first key the first time this is called. */
  activeKey(): Promise<CryptoKey>;
  /** A specific key from history, for `decrypt`. `undefined` when it is not (or no longer) known. */
  key(id: string): Promise<CryptoKey | undefined>;
  /** Generate a new key, append it to history and make it active. Returns the new key. */
  rotate(): Promise<CryptoKey>;
  /** Full history, oldest first. */
  list(): Promise<CryptoKey[]>;
}

function decode(record: CryptoKeyRecord): CryptoKey {
  const key = Buffer.from(record.key, 'base64');
  if (key.length !== KEY_BYTES) throw new RpError('INTERNAL', `stored key "${record.id}" is ${key.length} bytes, expected ${KEY_BYTES}`);
  return { id: record.id, createdAt: record.createdAt, key };
}

interface KeyFile {
  activeKeyId: string;
  keys: CryptoKeyRecord[];
}

function newRecord(): CryptoKeyRecord {
  return { id: randomBytes(8).toString('hex'), createdAt: new Date().toISOString(), key: randomBytes(KEY_BYTES).toString('base64') };
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    // `open` mode is subject to the umask; make 0600 explicit (best effort on non-POSIX).
    await fs.chmod(file, 0o600).catch(() => undefined);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new RpError('STORAGE', `Cannot write ${file}: ${(err as Error).message}`, undefined, { cause: err });
  }
}

/**
 * Key history in the app's own config, for a user without the system daemon installed. Weaker
 * than [[DaemonKeyStore]] — anything that can read this user's files can read this one too — but
 * it is what "no daemon" leaves available, and it is still a file most things never look at,
 * `0600`, outside the character sandbox's reach (`sdk.files` cannot see it; only the host
 * capability handler and this store ever open it).
 */
export class LocalKeyStore implements CryptoKeyStore {
  private readonly file: string;
  private cache: KeyFile | undefined;

  constructor(dir: string) {
    this.file = path.join(dir, 'keys.json');
  }

  private async load(): Promise<KeyFile> {
    if (this.cache) return this.cache;
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { activeKeyId: '', keys: [] };
        return this.cache;
      }
      throw new RpError('STORAGE', `Cannot read ${this.file}: ${(err as Error).message}`, undefined, { cause: err });
    }
    try {
      this.cache = JSON.parse(text) as KeyFile;
    } catch (err) {
      throw new RpError('STORAGE', `Corrupt JSON in ${this.file}: ${(err as Error).message}`, undefined, { cause: err });
    }
    return this.cache;
  }

  private async save(file: KeyFile): Promise<void> {
    this.cache = file;
    await writeAtomic(this.file, JSON.stringify(file, null, 2));
  }

  async activeKey(): Promise<CryptoKey> {
    const file = await this.load();
    const active = file.keys.find((k) => k.id === file.activeKeyId);
    if (active) return decode(active);
    return this.rotate();
  }

  async key(id: string): Promise<CryptoKey | undefined> {
    const file = await this.load();
    const found = file.keys.find((k) => k.id === id);
    return found ? decode(found) : undefined;
  }

  async rotate(): Promise<CryptoKey> {
    const file = await this.load();
    const record = newRecord();
    const next: KeyFile = { activeKeyId: record.id, keys: [...file.keys, record] };
    await this.save(next);
    return decode(record);
  }

  async list(): Promise<CryptoKey[]> {
    const file = await this.load();
    // Consistent with `activeKey()` (and with `DaemonKeyStore`, whose `crypto-keys` request
    // always creates on first use server-side): a concurrent `activeKey()`/`list()` pair on a
    // brand-new store must never observe an active key id that is missing from the list.
    if (file.keys.length === 0) {
      await this.rotate();
      return this.list();
    }
    return file.keys.map(decode);
  }
}
