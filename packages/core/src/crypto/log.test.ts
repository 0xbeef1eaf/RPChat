import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../test/helpers.js';
import { CryptoLog } from './log.js';

let dir: string;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function entry(path: string) {
  return { path, keyId: 'k1', beforeMd5: 'b', afterMd5: 'a', encryptedAt: '2026-01-01T00:00:00.000Z' };
}

describe('CryptoLog', () => {
  it('append records an entry with a generated id, listed and pending', async () => {
    dir = await makeTempDir();
    const log = new CryptoLog(dir);
    const recorded = await log.append(entry('/home/ada/a.txt'));
    expect(recorded.id).toBeTruthy();
    expect(await log.list()).toEqual([recorded]);
    expect(await log.pending()).toEqual([recorded]);
  });

  it('markDecrypted removes an entry from pending and is idempotent', async () => {
    dir = await makeTempDir();
    const log = new CryptoLog(dir);
    const recorded = await log.append(entry('/home/ada/a.txt'));
    await log.markDecrypted(recorded.id);
    expect(await log.pending()).toEqual([]);
    const [stored] = await log.list();
    expect(stored?.decryptedAt).toBeTruthy();

    // Marking again, or marking an unknown id, does not throw or change anything.
    await log.markDecrypted(recorded.id);
    await log.markDecrypted('unknown');
    expect(await log.list()).toEqual([stored]);
  });

  it('latestPending finds the newest unmarked entry for a path, ignoring earlier ones and already-decrypted ones', async () => {
    dir = await makeTempDir();
    const log = new CryptoLog(dir);
    const first = await log.append(entry('/home/ada/a.txt'));
    await log.markDecrypted(first.id);
    const second = await log.append(entry('/home/ada/a.txt'));
    expect((await log.latestPending('/home/ada/a.txt'))?.id).toBe(second.id);
    expect(await log.latestPending('/home/ada/nope.txt')).toBeUndefined();
  });

  it('persists across a fresh instance over the same directory', async () => {
    dir = await makeTempDir();
    const a = new CryptoLog(dir);
    await a.append(entry('/home/ada/a.txt'));
    const b = new CryptoLog(dir);
    expect(await b.list()).toHaveLength(1);
  });
});
