import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandTemplate, DaemonRequest, DaemonResponse, LockDevices } from '@rp/shared';
import { InputHandler, lockDevicesArg } from './input.js';
import type { CommandRunner } from './commands-runner.js';
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

/** Records template runs (inputLock/inputUnlock configured, nothing else). */
function fakeCommands() {
  const runs: Array<{ name: string; vars: Record<string, string> }> = [];
  const runner = {
    runs,
    isConfigured: async (name: string) => name === 'inputLock' || name === 'inputUnlock',
    resolve: async (name: string): Promise<CommandTemplate> => ({ command: name === 'inputLock' || name === 'inputUnlock' ? 'x' : '' }),
    run: async (name: string, vars: Record<string, string>) => {
      runs.push({ name, vars });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return runner as unknown as CommandRunner & { runs: typeof runs };
}

describe('lockDevicesArg', () => {
  it('defaults to both and rejects unknown values', () => {
    expect(lockDevicesArg(undefined)).toBe('both');
    expect(lockDevicesArg('mouse')).toBe('mouse');
    expect(() => lockDevicesArg('eyes')).toThrow(/devices/);
    expect(() => lockDevicesArg(1)).toThrow(/devices/);
  });
});

describe('InputHandler lock devices', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lock-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('template fallback substitutes {devices} in lock and unlock and reports it in status', async () => {
    const commands = fakeCommands();
    let now = 1_000_000;
    const handler = new InputHandler({ commands, maxLockMs: async () => 20_000, logger, now: () => now });
    const res = await handler.invoke('lock', [90_000, { devices: 'keyboard', reason: 'quiet' }], ctx);
    expect(res).toEqual({ until: new Date(now + 20_000).toISOString(), durationMs: 20_000, devices: 'keyboard' });
    expect(commands.runs[0]).toEqual({ name: 'inputLock', vars: { seconds: '20', durationMs: '20000', reason: 'quiet', devices: 'keyboard' } });
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: true, until: new Date(now + 20_000).toISOString(), devices: 'keyboard' });
    await handler.invoke('unlock', [], ctx);
    expect(commands.runs[1]).toEqual({ name: 'inputUnlock', vars: { devices: 'keyboard' } });
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: false });
    await expect(handler.invoke('lock', [5000, { devices: 'feet' }], ctx)).rejects.toThrow(/devices/);
    const both = await handler.invoke('lock', [5000, {}], ctx);
    expect(both).toMatchObject({ devices: 'both' });
    now += 6000;
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: false });
    await handler.dispose();
  });

  it('daemon route passes devices to lock and reads them back from status', async () => {
    const sock = path.join(tmp, 'd.sock');
    const daemon = fakeDaemon(sock);
    await daemon.listen();
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 2000 });
    const commands = fakeCommands();
    const handler = new InputHandler({ commands, maxLockMs: async () => 300_000, logger, daemon: client });
    const res = (await handler.invoke('lock', [120_000, { devices: 'mouse', reason: 'look' }], ctx)) as { until: string; durationMs: number; devices: string };
    expect(res).toMatchObject({ durationMs: 30_000, devices: 'mouse' });
    expect(daemon.seen.find((r) => r.op === 'lock')).toEqual({ op: 'lock', durationMs: 120_000, devices: 'mouse', reason: 'look' });
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: true, until: res.until, devices: 'mouse' });
    await handler.invoke('unlock', [], ctx);
    expect(daemon.seen.at(-1)?.op).toBe('unlock');
    expect(await handler.invoke('status', [], ctx)).toEqual({ locked: false });
    expect(commands.runs).toEqual([]); // templates untouched while the daemon is connected
    await handler.dispose();
    client.close();
    await daemon.close();
  });
});
