import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSettings, DaemonRequest, DaemonResponse } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { DaemonClient, DaemonError } from './daemon-client.js';
import { SystemIntegration, autostartDesktopEntry } from './integration.js';
import { PolicyWatcher, applyPolicy, loadPolicy, managedPaths, parsePolicy, stripManagedPatch } from './policy.js';

/** Fake rp-coded: answers the protocol from an in-memory lock state. */
function fakeDaemon(socketPath: string, opts: { hang?: boolean } = {}) {
  let locked: { until: string; reason?: string } | null = null;
  const seen: DaemonRequest[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        const req = JSON.parse(line) as DaemonRequest;
        seen.push(req);
        if (opts.hang) continue;
        let res: DaemonResponse;
        switch (req.op) {
          case 'hello':
            res = { ok: true, op: 'hello', version: '0.1.0', protocol: 1, devices: { keyboards: 1, pointers: 2, uinput: true } };
            break;
          case 'status':
            res = { ok: true, op: 'status', locked };
            break;
          case 'lock': {
            const durationMs = Math.min(req.durationMs, 60_000);
            locked = { until: new Date(Date.now() + durationMs).toISOString(), ...(req.reason ? { reason: req.reason } : {}) };
            res = { ok: true, op: 'lock', until: locked.until, durationMs };
            break;
          }
          case 'unlock':
            locked = null;
            res = { ok: true, op: 'unlock' };
            break;
          case 'key':
            res = req.combo === 'bad' ? { ok: false, error: 'unknown key', code: 'INVALID' } : { ok: true, op: 'key' };
            break;
          default:
            res = { ok: true, op: req.op as 'type' };
        }
        conn.write(`${JSON.stringify(res)}\n`);
      }
    });
  });
  return {
    server,
    seen,
    listen: () => new Promise<void>((r) => server.listen(socketPath, r)),
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy();
        server.close(() => r());
      }),
  };
}

describe('DaemonClient', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('connects on demand, handshakes, serialises requests and reports status', async () => {
    const sock = path.join(tmp, 'd.sock');
    const daemon = fakeDaemon(sock);
    await daemon.listen();
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 2000 });
    expect(client.connected).toBe(false);
    expect(await client.isAvailable()).toBe(true);
    expect(client.connected).toBe(true);
    const [lock, status] = await Promise.all([client.request({ op: 'lock', durationMs: 120_000, reason: 'tea' }), client.request({ op: 'status' })]);
    expect(lock).toMatchObject({ op: 'lock', durationMs: 60_000 });
    expect(status).toMatchObject({ op: 'status', locked: { reason: 'tea' } });
    expect(daemon.seen.map((r) => r.op)).toEqual(['hello', 'lock', 'status']);
    await expect(client.request({ op: 'key', combo: 'bad' })).rejects.toBeInstanceOf(DaemonError);
    expect(await client.status()).toMatchObject({ connected: true, version: '0.1.0', devices: { keyboards: 1 }, locked: { reason: 'tea' } });
    await client.request({ op: 'unlock' });
    // Reconnect after the server goes away and comes back.
    await daemon.close();
    await expect(client.request({ op: 'status' })).rejects.toThrow();
    expect(client.connected).toBe(false);
    const again = fakeDaemon(sock);
    await again.listen();
    expect((await client.status()).connected).toBe(true);
    expect(again.seen.map((r) => r.op)).toEqual(['hello', 'status']);
    client.close();
    await again.close();
  });

  it('reports not connected without a daemon, remembers the failure, and times out on a silent daemon', async () => {
    const client = new DaemonClient({ socketPath: path.join(tmp, 'missing.sock'), timeoutMs: 500, retryDelayMs: 60_000 });
    const status = await client.status();
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/not reachable/);
    expect(await client.isAvailable()).toBe(false);
    const sock = path.join(tmp, 'hang.sock');
    const daemon = fakeDaemon(sock, { hang: true });
    await daemon.listen();
    const silent = new DaemonClient({ socketPath: sock, timeoutMs: 300 });
    await expect(silent.request({ op: 'status' })).rejects.toThrow(/within 300 ms/);
    await daemon.close();
  });
});

describe('policy', () => {
  const base: AppSettings = defaultSettings();

  it('parses and validates the policy file', () => {
    const policy = parsePolicy({ version: 1, managedBy: 'IT', settings: { autonomy: { maxSelfWakesPerHour: 5 }, maxInputLockMs: 20_000, permissions: { moduleAllow: { system: false } }, web: { allowlist: ['a.example'] } }, inputLock: { maxDurationMs: 10_000, enabled: true } });
    expect(managedPaths(policy)).toEqual(['autonomy.maxSelfWakesPerHour', 'maxInputLockMs', 'permissions.moduleAllow.system', 'web.allowlist']);
    expect(() => parsePolicy({ version: 2 })).toThrow(/version must be 1/);
    expect(() => parsePolicy({ version: 1, settings: { maxInputLockMs: 'x' } })).toThrow(/maxInputLockMs/);
    expect(() => parsePolicy({ version: 1, settings: { displayBackend: 'kde' } })).toThrow(/displayBackend/);
    expect(managedPaths(null)).toEqual([]);
  });

  it('applyPolicy forces keys and caps the lock; stripManagedPatch drops managed paths', () => {
    const policy = parsePolicy({ version: 1, settings: { autonomy: { maxSelfWakesPerHour: 5 }, maxInputLockMs: 20_000, permissions: { moduleAllow: { system: false } }, memory: { enabled: false } }, inputLock: { maxDurationMs: 10_000 } });
    const { settings, managed } = applyPolicy({ ...base, permissions: { moduleAllow: { web: true } } }, policy);
    expect(settings.autonomy).toEqual({ ...base.autonomy, maxSelfWakesPerHour: 5 });
    expect(settings.maxInputLockMs).toBe(10_000); // policy 20 000 capped by the daemon hard max
    expect(settings.permissions.moduleAllow).toEqual({ web: true, system: false });
    expect(settings.memory.enabled).toBe(false);
    expect(managed).toEqual(['autonomy.maxSelfWakesPerHour', 'maxInputLockMs', 'memory.enabled', 'permissions.moduleAllow.system']);
    expect(applyPolicy(base, null)).toEqual({ settings: base, managed: [] });
    const patch = stripManagedPatch({ maxInputLockMs: 1, theme: 'dark', autonomy: { maxSelfWakesPerHour: 99, maxTimersPerSession: 3 } as AppSettings['autonomy'], permissions: { moduleAllow: { system: true, web: false } } }, managed);
    expect(patch).toEqual({ theme: 'dark', autonomy: { maxTimersPerSession: 3 }, permissions: { moduleAllow: { web: false } } });
  });

  it('loads from disk and re-reads when the mtime changes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-policy-'));
    const file = path.join(tmp, 'policy.json');
    const watcher = new PolicyWatcher(file);
    expect(await watcher.current()).toMatchObject({ present: false, policy: null, managed: [] });
    expect((await loadPolicy(file)).present).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, managedBy: 'IT', settings: { maxInputLockMs: 5000 } }));
    fs.utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    expect(await watcher.current()).toMatchObject({ present: true, managedBy: 'IT', managed: ['maxInputLockMs'] });
    fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { displayBackend: 'electron' } }));
    expect((await watcher.current()).managed).toEqual(['displayBackend']);
    fs.writeFileSync(file, '{bad');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const broken = await watcher.current();
    expect(broken.present).toBe(true);
    expect(broken.error).toMatch(/JSON|policy/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('SystemIntegration', () => {
  it('assembles the status and toggles the XDG autostart entry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-sys-'));
    const resources = path.join(tmp, 'resources');
    fs.mkdirSync(path.join(resources, 'system'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'system', 'install.sh'), '#!/bin/sh\necho ok\n');
    const commands: string[][] = [];
    const integration = new SystemIntegration({
      platform: 'linux',
      daemon: new DaemonClient({ socketPath: path.join(tmp, 'none.sock'), timeoutMs: 300 }),
      policy: new PolicyWatcher(path.join(tmp, 'policy.json')),
      resourcesDirs: [path.join(tmp, 'nope'), resources],
      homeDir: path.join(tmp, 'home'),
      appBin: '/opt/rp code/rp-code',
      userName: 'alice',
      udevRulePath: path.join(tmp, '70-rp-code.rules'),
      run: async (file, args, onOutput) => {
        commands.push([file, ...args]);
        if (file === 'id') return { code: 0, stdout: 'alice wheel rp-code\n', stderr: '' };
        onOutput?.('[ok] group\n');
        return { code: 0, stdout: '[ok] group\n', stderr: '' };
      },
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
    const status = await integration.status();
    expect(status).toMatchObject({ platform: 'linux', daemon: { connected: false }, policy: { present: false, managed: [] }, udev: { rulePresent: false, inGroup: true, groupName: 'rp-code' }, autostart: { enabled: false, method: 'none' }, installerAvailable: true });
    expect(await integration.installerPath()).toBe(path.join(resources, 'system', 'install.sh'));
    const enabled = await integration.setAutostart(true);
    expect(enabled.autostart).toEqual({ enabled: true, method: 'xdg', path: path.join(tmp, 'home', '.config', 'autostart', 'rp-code.desktop') });
    const entry = fs.readFileSync(enabled.autostart.path!, 'utf8');
    expect(entry).toContain('Exec="/opt/rp code/rp-code" --hidden');
    expect(autostartDesktopEntry('/usr/bin/rp-code')).toContain('Exec=/usr/bin/rp-code --hidden');
    expect((await integration.setAutostart(false)).autostart.enabled).toBe(false);
    const result = await integration.install({ autostart: false });
    expect(result).toEqual({ ok: true, output: '[ok] group\n' });
    expect(commands.at(-1)).toEqual(['pkexec', path.join(resources, 'system', 'install.sh'), '--app-bin', '/opt/rp code/rp-code', '--user', 'alice', '--autostart', 'none']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
