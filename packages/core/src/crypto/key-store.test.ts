import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../test/helpers.js';
import { KEY_BYTES } from './engine.js';
import { LocalKeyStore } from './key-store.js';

let dir: string;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('LocalKeyStore', () => {
  it('creates a key on first use and keeps returning the same active key', async () => {
    dir = await makeTempDir();
    const store = new LocalKeyStore(dir);
    const first = await store.activeKey();
    expect(first.key.length).toBe(KEY_BYTES);
    const again = await store.activeKey();
    expect(again.id).toBe(first.id);
    expect(again.key).toEqual(first.key);
  });

  it('rotate appends a new key, keeps the old one reachable, and persists to disk', async () => {
    dir = await makeTempDir();
    const store = new LocalKeyStore(dir);
    const first = await store.activeKey();
    const second = await store.rotate();
    expect(second.id).not.toBe(first.id);
    expect(await store.activeKey()).toEqual(second);
    expect(await store.key(first.id)).toEqual(first);
    expect((await store.list()).map((k) => k.id)).toEqual([first.id, second.id]);

    // A fresh store over the same directory sees the same history (persisted, not in-process only).
    const reopened = new LocalKeyStore(dir);
    expect(await reopened.activeKey()).toEqual(second);
    expect(await reopened.key(first.id)).toEqual(first);
  });

  it('list() also creates the first key on a brand-new store, consistent with activeKey()', async () => {
    dir = await makeTempDir();
    const store = new LocalKeyStore(dir);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(await store.activeKey()).toEqual(listed[0]);
  });

  it('key() returns undefined for an unknown id', async () => {
    dir = await makeTempDir();
    const store = new LocalKeyStore(dir);
    await store.activeKey();
    expect(await store.key('nope')).toBeUndefined();
  });

  it('writes the key file 0600', async () => {
    dir = await makeTempDir();
    const store = new LocalKeyStore(dir);
    await store.activeKey();
    const mode = (await fs.stat(`${dir}/keys.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
