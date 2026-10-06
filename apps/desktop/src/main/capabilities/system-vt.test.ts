import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonRequest, DaemonResponse, VtInfo } from '@rp/shared';
import { RpError } from '@rp/shared';
import { SystemHandler, VT_DAEMON_REQUIRED_MESSAGE } from './system.js';
import { DaemonClient } from '../system/daemon-client.js';

const ctx = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } as const };
const logger = { info: () => undefined, warn: () => undefined };

/**
 * A daemon that answers the `vt-*` ops the way rpchatd does: the session owns VT 2, `vt-lock`
 * clamps to 30 s (standing in for the policy's `vtLock.maxDurationMs`) and `vt-activate` takes
 * no target at all.
 */
function fakeDaemon(socketPath: string, opts: { session?: number; available?: boolean } = {}) {
  const session = opts.session ?? 2;
  let active = 3;
  let locked: { until: string; reason?: string } | undefined;
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
          case 'vt-status': {
            const vt: VtInfo = opts.available === false ? { available: false, unavailable: 'No such file or directory' } : { available: true, active, session, ...(locked ? { locked } : {}) };
            res = { ok: true, op: 'vt-status', vt };
            break;
          }
          case 'vt-activate': {
            const switched = active !== session;
            active = session;
            res = { ok: true, op: 'vt-activate', vt: session, switched };
            break;
          }
          case 'vt-lock': {
            const durationMs = Math.min(req.durationMs, 30_000);
            locked = { until: new Date(Date.UTC(2026, 9, 6, 12, 0, 30)).toISOString(), ...(req.reason ? { reason: req.reason } : {}) };
            res = { ok: true, op: 'vt-lock', until: locked.until, durationMs };
            break;
          }
          case 'vt-unlock':
            locked = undefined;
            res = { ok: true, op: 'vt-unlock' };
            break;
          default:
            res = { ok: false, error: `unexpected ${req.op}`, code: 'INVALID' };
        }
        conn.write(`${JSON.stringify(res)}\n`);
      }
    });
  });
  return {
    seen,
    isLocked: () => locked !== undefined,
    activeVt: () => active,
    switchAway: (vt: number) => (active = vt),
    listen: () => new Promise<void>((r) => server.listen(socketPath, r)),
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy();
        server.close(() => r());
      }),
  };
}

const sockets: Array<{ close: () => Promise<void> }> = [];
const clients: DaemonClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) await s.close();
});

async function connected(opts: Parameters<typeof fakeDaemon>[1] = {}) {
  const socketPath = path.join(os.tmpdir(), `rp-vt-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const daemon = fakeDaemon(socketPath, opts);
  await daemon.listen();
  sockets.push(daemon);
  const client = new DaemonClient({ socketPath, timeoutMs: 2000, retryDelayMs: 0 });
  clients.push(client);
  return { daemon, handler: new SystemHandler({ home: os.homedir(), daemon: client, logger }) };
}

describe('sdk.system virtual terminals, with the daemon', () => {
  it('reports which VT is in front and whether it is ours', async () => {
    const { daemon, handler } = await connected();
    expect(await handler.invoke('vtStatus', [], ctx)).toEqual({ available: true, vt: 3, ourVt: 2, ours: false, locked: false });
    await handler.invoke('vtSwitchBack', [], ctx);
    expect(await handler.invoke('vtStatus', [], ctx)).toEqual({ available: true, vt: 2, ourVt: 2, ours: true, locked: false });
    expect(daemon.activeVt()).toBe(2);
  });

  it('switches back to our own VT and says whether it had to', async () => {
    const { daemon, handler } = await connected();
    expect(await handler.invoke('vtSwitchBack', [], ctx)).toEqual({ vt: 2, switched: true });
    expect(await handler.invoke('vtSwitchBack', [], ctx)).toEqual({ vt: 2, switched: false });
    // The request carries no VT number: a character cannot send the user to another console.
    expect(daemon.seen.filter((r) => r.op === 'vt-activate')).toEqual([{ op: 'vt-activate' }, { op: 'vt-activate' }]);
  });

  it('locks switching for a bounded time and lets the daemon clamp it', async () => {
    const { daemon, handler } = await connected();
    const res = await handler.invoke('vtPreventSwitching', [10_000, { reason: 'finishing the story' }], ctx);
    expect(res).toEqual({ until: '2026-10-06T12:00:30.000Z', durationMs: 10_000 });
    expect(daemon.isLocked()).toBe(true);
    expect(await handler.invoke('vtStatus', [], ctx)).toMatchObject({ locked: true, until: '2026-10-06T12:00:30.000Z' });
    expect(daemon.seen.at(-2)).toEqual({ op: 'vt-lock', durationMs: 10_000, reason: 'finishing the story' });

    // An hour is asked for; the daemon's limit (30 s here) is what is granted and reported.
    const long = await handler.invoke('vtPreventSwitching', [3_600_000], ctx);
    expect(long).toMatchObject({ durationMs: 30_000 });

    await handler.invoke('vtAllowSwitching', [], ctx);
    expect(daemon.isLocked()).toBe(false);
  });

  it('gives the console back when the app shuts down, and only then', async () => {
    const quiet = await connected();
    await quiet.handler.dispose();
    expect(quiet.daemon.seen.some((r) => r.op === 'vt-unlock'), 'nothing was locked, nothing to release').toBe(false);

    const { daemon, handler } = await connected();
    await handler.invoke('vtPreventSwitching', [30_000], ctx);
    await handler.dispose();
    expect(daemon.isLocked()).toBe(false);
    // Idempotent: a second dispose does not ask again.
    await handler.dispose();
    expect(daemon.seen.filter((r) => r.op === 'vt-unlock')).toHaveLength(1);
  });

  it('raises the minimum and refuses a duration that is not a number', async () => {
    const { daemon, handler } = await connected();
    await handler.invoke('vtPreventSwitching', [5], ctx);
    expect(daemon.seen.at(-1)).toEqual({ op: 'vt-lock', durationMs: 1000 });
    for (const bad of ['soon', undefined, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(handler.invoke('vtPreventSwitching', [bad], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    // Nothing reached the daemon for the bad ones.
    expect(daemon.seen.filter((r) => r.op === 'vt-lock')).toHaveLength(1);
  });
});

describe('an rpchatd older than this app', () => {
  it('is reported as a missing capability, not as a bad argument', async () => {
    // What a daemon that predates these ops answers: serde's unknown-variant rejection.
    const socketPath = path.join(os.tmpdir(), `rp-vt-old-${process.pid}.sock`);
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
          const res: DaemonResponse =
            req.op === 'hello'
              ? { ok: true, op: 'hello', version: '0.2.0', protocol: 1, devices: { keyboards: 1, pointers: 1, uinput: true } }
              : { ok: false, error: 'invalid request: unknown variant `vt-lock`, expected one of `hello`, `status`, …', code: 'INVALID' };
          conn.write(`${JSON.stringify(res)}\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    sockets.push({
      close: () =>
        new Promise<void>((r) => {
          for (const c of conns) c.destroy();
          server.close(() => r());
        }),
    });
    const client = new DaemonClient({ socketPath, timeoutMs: 2000, retryDelayMs: 0 });
    clients.push(client);
    const handler = new SystemHandler({ home: os.homedir(), daemon: client, logger });
    await expect(handler.invoke('vtPreventSwitching', [5000], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('older than this app'),
    });
    // And the read falls back to "no virtual terminals here" rather than throwing.
    expect(await handler.invoke('vtStatus', [], ctx)).toEqual({ available: false, ours: false, locked: false });
  });
});

describe('sdk.system virtual terminals without the daemon', () => {
  const failure = { code: 'CAPABILITY_FAILED', message: VT_DAEMON_REQUIRED_MESSAGE };

  it('fails the three acting methods with CAPABILITY_FAILED when no daemon is wired (non-Linux)', async () => {
    const handler = new SystemHandler({ home: os.homedir(), logger });
    for (const call of [
      ['vtSwitchBack', []],
      ['vtPreventSwitching', [5000]],
      ['vtAllowSwitching', []],
    ] as const) {
      const err = await handler.invoke(call[0], [...call[1]], ctx).then(() => undefined, (e: unknown) => e);
      expect(err, call[0]).toBeInstanceOf(RpError);
      expect(err, call[0]).toMatchObject(failure);
    }
  });

  it('answers vtStatus instead of failing, so a character can simply check', async () => {
    const handler = new SystemHandler({ home: os.homedir(), logger });
    expect(await handler.invoke('vtStatus', [], ctx)).toEqual({ available: false, ours: false, locked: false });

    // Same answer while the socket is there but the kernel has no VTs to report.
    const withDaemon = await connected({ available: false });
    expect(await withDaemon.handler.invoke('vtStatus', [], ctx)).toEqual({ available: false, ours: false, locked: false });
  });

  it('fails with the same error while the daemon socket is unreachable', async () => {
    const client = new DaemonClient({ socketPath: path.join(os.tmpdir(), `rp-vt-missing-${process.pid}.sock`), timeoutMs: 500, retryDelayMs: 0 });
    clients.push(client);
    const handler = new SystemHandler({ home: os.homedir(), daemon: client, logger });
    await expect(handler.invoke('vtSwitchBack', [], ctx)).rejects.toMatchObject(failure);
    // And a bad argument is still reported before the daemon is consulted.
    await expect(handler.invoke('vtPreventSwitching', ['soon'], ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await handler.invoke('vtStatus', [], ctx)).toEqual({ available: false, ours: false, locked: false });
  });
});
