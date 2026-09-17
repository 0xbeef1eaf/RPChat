/**
 * Key history held by the root `rpchatd` daemon: `<CryptoKeyStore>` over the same JSON-lines
 * unix socket protocol as the rest of system integration (`docs/system-integration.md`,
 * `native/rpchatd/src/crypto_keys.rs`). One short-lived connection per call — `hello`, the
 * request, the answer, close — because this runs from both the long-lived desktop app and the
 * one-shot `decrypt-all` script, and the latter has nothing to keep a connection open for.
 *
 * The daemon never takes a uid from the wire: it reads `SO_PEERCRED` off the socket itself, so
 * this class can only ever see or rotate the key history of the user running it. Key material
 * is base64 both on the wire and in the daemon's own `0600` file; it is decoded to a `Buffer`
 * here and nowhere else on this side.
 */
import * as net from 'node:net';
import type { CryptoKeyRecord, DaemonRequest, DaemonResponse } from '@rp/shared';
import { DAEMON_SOCKET_PATH, RpError } from '@rp/shared';
import type { CryptoKey, CryptoKeyStore } from './key-store.js';
import { KEY_BYTES } from './engine.js';

type CryptoOkResponse = Extract<DaemonResponse, { op: 'crypto-keys' | 'crypto-rotate-key' }>;

export interface DaemonKeyStoreOptions {
  socketPath?: string;
  /** Per-request timeout (connect + hello + the request). Default 5000. */
  timeoutMs?: number;
}

function decode(record: CryptoKeyRecord): CryptoKey {
  const key = Buffer.from(record.key, 'base64');
  if (key.length !== KEY_BYTES) throw new RpError('INTERNAL', `daemon returned a ${key.length}-byte key for "${record.id}", expected ${KEY_BYTES}`);
  return { id: record.id, createdAt: record.createdAt, key };
}

/** One request over a fresh connection: `hello` then `req`, first two response lines. */
function roundTrip(socketPath: string, req: DaemonRequest, timeoutMs: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    const lines: DaemonResponse[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new RpError('CAPABILITY_FAILED', 'rpchatd did not answer in time'))), timeoutMs);
    socket.on('error', (err) => finish(() => reject(new RpError('CAPABILITY_FAILED', `cannot reach rpchatd: ${err.message}`, undefined, { cause: err }))));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ op: 'hello', version: 1 })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed: DaemonResponse;
        try {
          parsed = JSON.parse(line) as DaemonResponse;
        } catch (err) {
          finish(() => reject(new RpError('CAPABILITY_FAILED', `rpchatd sent an unparsable line: ${(err as Error).message}`)));
          return;
        }
        lines.push(parsed);
        if (lines.length === 1) {
          if (!parsed.ok) {
            finish(() => reject(new RpError('CAPABILITY_FAILED', `rpchatd refused hello: ${parsed.error}`)));
            return;
          }
          socket.write(`${JSON.stringify(req)}\n`);
        } else {
          finish(() => resolve(parsed));
          return;
        }
      }
    });
  });
}

export class DaemonKeyStore implements CryptoKeyStore {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(opts: DaemonKeyStoreOptions = {}) {
    this.socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private async request(req: Extract<DaemonRequest, { op: 'crypto-keys' | 'crypto-rotate-key' }>): Promise<{ keys: CryptoKeyRecord[]; activeKeyId: string }> {
    const res = await roundTrip(this.socketPath, req, this.timeoutMs);
    if (!res.ok) throw new RpError('CAPABILITY_FAILED', `rpchatd refused ${req.op}: ${res.error}`, { daemonCode: res.code });
    const ok = res as CryptoOkResponse;
    return { keys: ok.keys, activeKeyId: ok.activeKeyId };
  }

  async activeKey(): Promise<CryptoKey> {
    const { keys, activeKeyId } = await this.request({ op: 'crypto-keys' });
    const active = keys.find((k) => k.id === activeKeyId);
    if (!active) throw new RpError('INTERNAL', 'rpchatd reported an active key id not in its own history');
    return decode(active);
  }

  async key(id: string): Promise<CryptoKey | undefined> {
    const { keys } = await this.request({ op: 'crypto-keys' });
    const found = keys.find((k) => k.id === id);
    return found ? decode(found) : undefined;
  }

  async rotate(): Promise<CryptoKey> {
    const { keys, activeKeyId } = await this.request({ op: 'crypto-rotate-key' });
    const active = keys.find((k) => k.id === activeKeyId);
    if (!active) throw new RpError('INTERNAL', 'rpchatd reported an active key id not in its own history');
    return decode(active);
  }

  async list(): Promise<CryptoKey[]> {
    const { keys } = await this.request({ op: 'crypto-keys' });
    return keys.map(decode);
  }
}
