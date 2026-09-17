import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { makeTempDir } from '../test/helpers.js';
import { md5Hex } from './engine.js';
import { LocalKeyStore } from './key-store.js';
import { CryptoLog } from './log.js';
import { CryptoManager } from './manager.js';

let home: string;
let stateDir: string;

afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

async function setup(): Promise<{ manager: CryptoManager; log: CryptoLog; keyStore: LocalKeyStore }> {
  home = await makeTempDir('rp-crypto-home-');
  stateDir = await makeTempDir('rp-crypto-state-');
  const keyStore = new LocalKeyStore(stateDir);
  const log = new CryptoLog(stateDir);
  return { manager: new CryptoManager({ keyStore, log, home }), log, keyStore };
}

describe('CryptoManager', () => {
  it('encrypts a file in place, logs it, and decrypt restores the original bytes', async () => {
    const { manager, log } = await setup();
    const file = path.join(home, 'diary.md');
    const original = 'Dear diary, today I shipped a feature.';
    await fs.writeFile(file, original, 'utf8');

    const encrypted = await manager.encrypt(file);
    expect(encrypted.beforeMd5).toBe(md5Hex(Buffer.from(original, 'utf8')));
    const onDisk = await fs.readFile(file);
    expect(onDisk.toString('utf8')).not.toContain('diary');
    expect(encrypted.afterMd5).toBe(md5Hex(onDisk));

    const entries = await log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: file, keyId: encrypted.keyId, beforeMd5: encrypted.beforeMd5, afterMd5: encrypted.afterMd5 });
    expect(entries[0]?.decryptedAt).toBeUndefined();

    const decrypted = await manager.decrypt(file);
    expect(decrypted.keyId).toBe(encrypted.keyId);
    expect((await fs.readFile(file, 'utf8'))).toBe(original);
    expect((await log.list())[0]?.decryptedAt).toBeTruthy();
  });

  it('refuses to encrypt a file already encrypted', async () => {
    const { manager } = await setup();
    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'hi');
    await manager.encrypt(file);
    await expect(manager.encrypt(file)).rejects.toThrow(/already encrypted/);
  });

  it('refuses paths outside the home directory', async () => {
    const { manager } = await setup();
    await expect(manager.encrypt('/etc/passwd')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('refuses files that look like system files, even inside home', async () => {
    const { manager } = await setup();
    const file = path.join(home, 'app.desktop');
    await fs.writeFile(file, '[Desktop Entry]');
    await expect(manager.encrypt(file)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('refuses a relative or non-absolute path', async () => {
    const { manager } = await setup();
    await expect(manager.encrypt('diary.md')).rejects.toBeInstanceOf(RpError);
  });

  it('rotating the key keeps old files decryptable under their own key', async () => {
    const { manager, keyStore } = await setup();
    const fileA = path.join(home, 'a.txt');
    await fs.writeFile(fileA, 'first');
    const encA = await manager.encrypt(fileA);

    await manager.rotateKey();
    const fileB = path.join(home, 'b.txt');
    await fs.writeFile(fileB, 'second');
    const encB = await manager.encrypt(fileB);
    expect(encB.keyId).not.toBe(encA.keyId);

    // Both decrypt correctly, each under the key that encrypted it.
    await manager.decrypt(fileA);
    await manager.decrypt(fileB);
    expect(await fs.readFile(fileA, 'utf8')).toBe('first');
    expect(await fs.readFile(fileB, 'utf8')).toBe('second');
    expect((await keyStore.list())).toHaveLength(2);
    expect(await manager.activeKeyId()).toBe(encB.keyId);
  });

  it('decrypt fails clearly when the key is gone from history', async () => {
    const { manager, log } = await setup();
    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'x');
    await manager.encrypt(file);
    // Simulate the key history being wiped out from under it: a fresh store (no in-memory
    // cache) over an empty file has no memory of the key that encrypted `file`.
    await fs.rm(path.join(stateDir, 'keys.json'));
    const freshManager = new CryptoManager({ keyStore: new LocalKeyStore(stateDir), log, home });
    await expect(freshManager.decrypt(file)).rejects.toThrow(/no longer in the key history/);
  });

  it('decryptAll walks every pending entry: decrypts, skips missing files and already-plaintext ones', async () => {
    const { manager, log } = await setup();
    const fileA = path.join(home, 'a.txt');
    const fileB = path.join(home, 'b.txt');
    const fileC = path.join(home, 'c.txt');
    await fs.writeFile(fileA, 'a');
    await fs.writeFile(fileB, 'b');
    await fs.writeFile(fileC, 'c');
    await manager.encrypt(fileA);
    await manager.encrypt(fileB);
    await manager.encrypt(fileC);

    // c.txt was restored by hand (plaintext again) without going through decrypt().
    await fs.writeFile(fileC, 'c');
    // b.txt was deleted entirely.
    await fs.rm(fileB);

    const outcomes = await manager.decryptAll();
    expect(outcomes).toHaveLength(3);
    const byPath = Object.fromEntries(outcomes.map((o) => [o.path, o]));
    expect(byPath[fileA]?.ok).toBe(true);
    expect(await fs.readFile(fileA, 'utf8')).toBe('a');
    expect(byPath[fileB]?.ok).toBe(false);
    expect(byPath[fileB]?.reason).toMatch(/no longer exists/);
    expect(byPath[fileC]?.ok).toBe(true);
    expect(byPath[fileC]?.reason).toMatch(/already decrypted/);

    // A and C are closed out; B stays pending — it was not actually decrypted, so a later run
    // (the file may reappear, e.g. an unmounted drive) tries it again instead of losing track.
    expect((await log.pending()).map((e) => e.path)).toEqual([fileB]);
  });

  it('decryptAll never throws for a bad entry and reports nothing pending when the log is empty', async () => {
    const { manager } = await setup();
    expect(await manager.decryptAll()).toEqual([]);
  });

  it('listPendingPaths reports without decrypting', async () => {
    const { manager } = await setup();
    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'x');
    await manager.encrypt(file);
    expect(await manager.listPendingPaths()).toEqual([file]);
    // Read-only: the file is still encrypted.
    expect(await fs.readFile(file, 'utf8')).not.toBe('x');
  });
});
