import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonRequest, DaemonResponse, LockDevices } from '@rp/shared';
import { RpError } from '@rp/shared';
import { INPUT_DAEMON_REQUIRED_MESSAGE, InputHandler, buttonArg, lockDevicesArg } from './input.js';
import { DaemonClient } from '../system/daemon-client.js';

const ctx = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } as const };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function fakeDaemon(socketPath: string) {
  let locked: { until: string; reason?: string; devices: LockDevices } | null = null;
  const seen: DaemonRequest[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    conns.add(conn);
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const req = JSON.parse(buf.slice(0, idx)) as DaemonRequest;
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        seen.push(req);
        let res: DaemonResponse;
        switch (req.op) {
          case 'hello':
            res = { ok: true, op: 'hello', version: '0.1.0', protocol: 1, devices: { keyboards: 1, pointers: 1, uinput: true } };
            break;
          case 'status':
            res = { ok: true, op: 'status', locked };
            break;
          case 'lock': {
            const durationMs = Math.min(req.durationMs, 30_000);
            locked = { until: new Date(Date.now() + durationMs).toISOString(), devices: req.devices ?? 'both', ...(req.reason ? { reason: req.reason } : {}) };
            res = { ok: true, op: 'lock', until: locked.until, durationMs, devices: locked.devices };
            break;
          }
          case 'unlock':
            locked = null;
            res = { ok: true, op: 'unlock' };
            break;
          default:
            res = { ok: true, op: req.op as 'type' };
        }
        conn.write(`${JSON.stringify(res)}\n`);
      }
    });
  });
  return {
    seen,
    listen: () => new Promise<void>((r) => server.listen(socketPath, r)),
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy();
        server.close(() => r());
      }),
  };
}

describe('lockDevicesArg', () => {
  it('defaults to both and rejects unknown values', () => {
    expect(lockDevicesArg(undefined)).toBe('both');
    expect(lockDevicesArg('mouse')).toBe('mouse');
    expect(() => lockDevicesArg('eyes')).toThrow(/devices/);
    expect(() => lockDevicesArg(1)).toThrow(/devices/);
  });
});

describe('buttonArg', () => {
  it('defaults to left, lowercases and rejects unknown buttons', () => {
    expect(buttonArg(undefined)).toBe('left');
    expect(buttonArg('Right')).toBe('right');
    expect(() => buttonArg('x1')).toThrow(/button/);
  });
});

describe('InputHandler without the daemon', () => {
  const failure = { code: 'CAPABILITY_FAILED', message: INPUT_DAEMON_REQUIRED_MESSAGE };

  it('rejects every method with CAPABILITY_FAILED when no daemon client is wired (non-Linux)', async () => {
    const handler = new InputHandler({ maxLockMs: async () => 20_000, logger });
    for (const call of [
      ['lock', [5000, { devices: 'keyboard' }]],
      ['unlock', []],
      ['status', []],
      ['type', ['hi']],
      ['key', ['ctrl+s']],
      ['click', [1, 2, 'left']],
      ['moveMouse', [1, 2]],
    ] as const) {
      const err = await handler.invoke(call[0], [...call[1]], ctx).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(RpError);
      expect(err).toMatchObject(failure);
    }
    await handler.dispose(); // never locked: no daemon round trip, no throw
  });

  it('rejects with the same error while the daemon socket is unreachable, after argument validation', async () => {
    const client = new DaemonClient({ socketPath: path.join(os.tmpdir(), 'rp-input-missing-' + process.pid + '.sock'), timeoutMs: 500, retryDelayMs: 0 });
    const handler = new InputHandler({ maxLockMs: async () => 20_000, logger, daemon: client });
    await expect(handler.invoke('lock', [5000, {}], ctx)).rejects.toMatchObject(failure);
    await expect(handler.invoke('type', ['hello'], ctx)).rejects.toMatchObject(failure);
    // Bad arguments are reported before the daemon is consulted.
    await expect(handler.invoke('lock', ['soon', {}], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('lock', [5000, { devices: 'feet' }], ctx)).rejects.toThrow(/devices/);
    await expect(handler.invoke('type', [''], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('key', ['ctrl + s'], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('click', ['1', 2], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handler.invoke('nope', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
    client.close();
  });
});

describe('InputHandler lock devices', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lock-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('daemon route passes devices to lock and reads them back from status', async () => {
    const sock = path.join(tmp, 'd.sock');
    const daemon = fakeDaemon(sock);
    await daemon.listen();
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 2000 });
    const handler = new InputHandler({ maxLockMs: async () => 200_000, logger, daemon: client });
    const res = (await handler.invoke('lock', [1_200_000, { devices: 'mouse', reason: 'look' }], ctx)) as { until: string; durationMs: number; devices: string };
    expect(res).toMatchObject({ durationMs: 30_000, devices: 'mouse' });
    // Clamped to maxInputLockMs before the request; the fake daemon clamps again to 30 s.
    expect(daemon.seen.find((r) => r.op === 'lock')).toEqual({ op: 'lock', durationMs: 200_000, devices: 'mouse', reason: 'look' });
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: true, until: res.until, devices: 'mouse' });
    await handler.invoke('unlock', [], ctx);
    expect(daemon.seen.at(-1)?.op).toBe('unlock');
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: false });
    // -1 is no app-side cap: the request reaches the daemon as asked, and the daemon clamps it.
    const unlimited = new InputHandler({ maxLockMs: async () => -1, logger, daemon: client });
    await unlimited.invoke('lock', [1_200_000, {}], ctx);
    expect(daemon.seen.filter((r) => r.op === 'lock').at(-1)).toMatchObject({ durationMs: 1_200_000 });
    const both = await handler.invoke('lock', [500, {}], ctx);
    expect(both).toMatchObject({ durationMs: 1000, devices: 'both' });
    await handler.invoke('type', ['hello'], ctx);
    await handler.invoke('key', ['ctrl+s'], ctx);
    await handler.invoke('click', [10.4, 20.6, 'Middle'], ctx);
    await handler.invoke('moveMouse', [3, 4], ctx);
    expect(daemon.seen.slice(-4)).toEqual([
      { op: 'type', text: 'hello' },
      { op: 'key', combo: 'ctrl+s' },
      { op: 'click', x: 10, y: 21, button: 'middle' },
      { op: 'move', x: 3, y: 4 },
    ]);
    await handler.dispose(); // still locked from the app's point of view: unlocks through the daemon
    expect(daemon.seen.at(-1)?.op).toBe('unlock');
    client.close();
    await daemon.close();
  });
});
