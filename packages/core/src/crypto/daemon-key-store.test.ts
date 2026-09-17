import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CryptoKeyRecord, DaemonRequest, DaemonResponse } from '@rp/shared';
import { DaemonKeyStore } from './daemon-key-store.js';

let socketPath: string;
let server: net.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (socketPath) fs.rmSync(socketPath, { force: true });
});

function record(id: string): CryptoKeyRecord {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', key: Buffer.alloc(32, id.charCodeAt(0)).toString('base64') };
}

/** A fake rpchatd that only understands `hello`, `crypto-keys` and `crypto-rotate-key`, scoped by an in-memory single-user history. */
function fakeDaemon(opts: { refuseHello?: boolean; refuseCrypto?: boolean } = {}): { keys: CryptoKeyRecord[]; activeKeyId: string } {
  socketPath = path.join(os.tmpdir(), `rp-crypto-daemon-test-${Math.random().toString(36).slice(2)}.sock`);
  const state = { keys: [record('k1')], activeKeyId: 'k1' };
  server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        const req = JSON.parse(line) as DaemonRequest;
        let res: DaemonResponse;
        if (req.op === 'hello') {
          res = opts.refuseHello
            ? { ok: false, error: 'nope', code: 'REFUSED' }
            : { ok: true, op: 'hello', version: '0.2.0', protocol: 1, devices: { keyboards: 0, pointers: 0, uinput: false } };
        } else if (req.op === 'crypto-keys') {
          res = opts.refuseCrypto ? { ok: false, error: 'nope', code: 'INTERNAL' } : { ok: true, op: 'crypto-keys', keys: state.keys, activeKeyId: state.activeKeyId };
        } else if (req.op === 'crypto-rotate-key') {
          const next = record(`k${state.keys.length + 1}`);
          state.keys = [...state.keys, next];
          state.activeKeyId = next.id;
          res = { ok: true, op: 'crypto-rotate-key', keys: state.keys, activeKeyId: state.activeKeyId };
        } else {
          res = { ok: false, error: 'unexpected op in test', code: 'INVALID' };
        }
        conn.write(`${JSON.stringify(res)}\n`);
      }
    });
  });
  server.listen(socketPath);
  return state;
}

describe('DaemonKeyStore', () => {
  it('activeKey/key/list fetch the history over the socket and decode base64 key material', async () => {
    fakeDaemon();
    const store = new DaemonKeyStore({ socketPath });
    const active = await store.activeKey();
    expect(active.id).toBe('k1');
    expect(active.key.length).toBe(32);
    expect(await store.key('k1')).toEqual(active);
    expect(await store.key('nope')).toBeUndefined();
    expect((await store.list()).map((k) => k.id)).toEqual(['k1']);
  });

  it('rotate asks the daemon to generate a new key and returns it as active', async () => {
    fakeDaemon();
    const store = new DaemonKeyStore({ socketPath });
    const rotated = await store.rotate();
    expect(rotated.id).toBe('k2');
    expect((await store.list()).map((k) => k.id)).toEqual(['k1', 'k2']);
  });

  it('rejects when the daemon refuses hello', async () => {
    fakeDaemon({ refuseHello: true });
    const store = new DaemonKeyStore({ socketPath, timeoutMs: 1000 });
    await expect(store.activeKey()).rejects.toThrow(/refused hello/);
  });

  it('rejects when the daemon refuses the crypto-keys request', async () => {
    fakeDaemon({ refuseCrypto: true });
    const store = new DaemonKeyStore({ socketPath, timeoutMs: 1000 });
    await expect(store.activeKey()).rejects.toThrow(/refused crypto-keys/);
  });

  it('rejects when nothing is listening on the socket', async () => {
    socketPath = path.join(os.tmpdir(), 'rp-crypto-daemon-test-nowhere.sock');
    const store = new DaemonKeyStore({ socketPath, timeoutMs: 1000 });
    await expect(store.activeKey()).rejects.toThrow(/cannot reach rpchatd/);
  });
});
