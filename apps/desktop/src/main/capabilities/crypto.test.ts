import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext } from '@rp/shared';
import { RpError } from '@rp/shared';
import { CryptoLog, CryptoManager, LocalKeyStore } from '@rp/core';
import { CryptoHandler, CryptoService } from './crypto.js';

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '/nowhere', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };

let home: string;
let stateDir: string;

afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

function setup(): CryptoManager {
  home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'rp-crypto-handler-home-'));
  stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'rp-crypto-handler-state-'));
  return new CryptoManager({ keyStore: new LocalKeyStore(stateDir), log: new CryptoLog(stateDir), home });
}

describe('CryptoHandler', () => {
  it('encrypt/decrypt round-trip a file and return void', async () => {
    const manager = setup();
    const handler = new CryptoHandler(manager);
    const file = path.join(home, 'note.txt');
    await fs.writeFile(file, 'hush');

    expect(await handler.invoke('encrypt', [file], ctx)).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).not.toBe('hush');
    expect(await handler.invoke('decrypt', [file], ctx)).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe('hush');
  });

  it('rejects an unknown method', async () => {
    const manager = setup();
    const handler = new CryptoHandler(manager);
    await expect(handler.invoke('rotateKey', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });

  it('surfaces the manager\'s errors (e.g. a path outside home) as-is', async () => {
    const manager = setup();
    const handler = new CryptoHandler(manager);
    await expect(handler.invoke('encrypt', ['/etc/passwd'], ctx)).rejects.toBeInstanceOf(RpError);
  });
});

describe('CryptoService', () => {
  it('status reports the backend, the key history and pending decrypts', async () => {
    const manager = setup();
    const service = new CryptoService(manager, 'local');
    const first = await service.status();
    expect(first.backend).toBe('local');
    expect(first.keys).toHaveLength(1);
    expect(first.activeKeyId).toBe(first.keys[0]?.id);
    expect(first.pendingDecrypts).toBe(0);

    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'x');
    await manager.encrypt(file);
    expect((await service.status()).pendingDecrypts).toBe(1);
  });

  it('rotateKey adds a key, makes it active, and old files stay decryptable', async () => {
    const manager = setup();
    const service = new CryptoService(manager, 'local');
    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'x');
    await manager.encrypt(file);
    const before = await service.status();

    const after = await service.rotateKey();
    expect(after.keys).toHaveLength(2);
    expect(after.activeKeyId).not.toBe(before.activeKeyId);
    await manager.decrypt(file);
    expect(await fs.readFile(file, 'utf8')).toBe('x');
  });

  it('counts pending decrypts without decrypting them (bulk decryption is the CLI\'s job)', async () => {
    const manager = setup();
    const service = new CryptoService(manager, 'daemon');
    const file = path.join(home, 'a.txt');
    await fs.writeFile(file, 'x');
    await manager.encrypt(file);
    expect((await service.status()).pendingDecrypts).toBe(1);
    // Still encrypted: nothing the renderer can reach decrypts in bulk.
    expect(await fs.readFile(file, 'utf8')).not.toBe('x');
  });
});
