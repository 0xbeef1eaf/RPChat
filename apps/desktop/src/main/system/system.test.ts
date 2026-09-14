import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSettings, DaemonEvent, DaemonRequest, DaemonResponse, GuardInfo, InstallInfo } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { RpError } from '@rp/shared';
import { APPLY_UPDATE_TIMEOUT_MS, DaemonClient, DaemonError, rpErrorCodeFor } from './daemon-client.js';
import { GuardAttemptLog, SystemIntegration, autostartDesktopEntry, guardStatusOf, isSystemInstallExec, policyTemplate, systemInstallStatus } from './integration.js';
import { KeepaliveLink, reconnectDelay } from './keepalive-link.js';
import { PolicyWatcher, appPolicy, applyPolicy, guardMode, loadPolicy, managedPaths, parsePolicy, stripManagedPatch } from './policy.js';

/** Fake rp-coded: answers the protocol from an in-memory lock state. */
function fakeDaemon(socketPath: string, opts: { hang?: boolean; policyPath?: string; install?: InstallInfo; applyDelayMs?: number; restartDaemon?: boolean; guard?: GuardInfo; noSubscribe?: boolean } = {}) {
  let locked: { until: string; reason?: string; devices: 'keyboard' | 'mouse' | 'both' } | null = null;
  const seen: DaemonRequest[] = [];
  const conns = new Set<net.Socket>();
  /** Like rp-coded: subscriptions live on their connection. */
  const subscriptions = new Map<net.Socket, string[]>();
  let guardApplies = 0;
  /** Like rp-coded: a registration lives on its connection; `unregister` clears it, a drop without it counts as a crash. */
  const registrations = new Map<net.Socket, Extract<DaemonRequest, { op: 'register' }>>();
  const crashed: Array<Extract<DaemonRequest, { op: 'register' }>> = [];
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => {
      conns.delete(conn);
      subscriptions.delete(conn);
      const reg = registrations.get(conn);
      if (reg) crashed.push(reg);
      registrations.delete(conn);
    });
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
            res = { ok: true, op: 'status', locked, ...(opts.install ? { install: opts.install } : {}), ...(opts.guard ? { guard: opts.guard } : {}) };
            break;
          case 'guard-apply':
            guardApplies += 1;
            res = opts.guard ? { ok: true, op: 'guard-apply', guard: { ...opts.guard, loaded: opts.guard.mode === 'off' ? [] : opts.guard.loaded } } : { ok: false, error: 'invalid request: unknown variant `guard-apply`', code: 'INVALID' };
            break;
          case 'guard-status':
            res = opts.guard ? { ok: true, op: 'guard-status', guard: opts.guard } : { ok: false, error: 'invalid request: unknown variant `guard-status`', code: 'INVALID' };
            break;
          case 'subscribe': {
            if (opts.noSubscribe) {
              res = { ok: false, error: 'invalid request: unknown variant `subscribe`', code: 'INVALID' };
              break;
            }
            const events = [...new Set(req.events.filter((e) => e === 'guard-attempt'))];
            if (events.length > 0) subscriptions.set(conn, events);
            else subscriptions.delete(conn);
            res = { ok: true, op: 'subscribe', events };
            break;
          }
          case 'apply-update': {
            // Like rp-coded: a bad checksum is INVALID, root/foreign files REFUSED; success may take a while.
            const answer = (): DaemonResponse =>
              req.sha512 === 'bad'
                ? { ok: false, error: 'sha512 mismatch for ' + req.file, code: 'INVALID' }
                : !req.file.startsWith('/home/')
                  ? { ok: false, error: 'file must be an absolute path under /home/alice', code: 'REFUSED' }
                  : { ok: true, op: 'apply-update', version: req.version, restartDaemon: opts.restartDaemon ?? false };
            if (opts.applyDelayMs) {
              setTimeout(() => conn.write(`${JSON.stringify(answer())}\n`), opts.applyDelayMs);
              continue;
            }
            res = answer();
            break;
          }
          case 'lock': {
            const durationMs = Math.min(req.durationMs, 60_000);
            locked = { until: new Date(Date.now() + durationMs).toISOString(), devices: req.devices ?? 'both', ...(req.reason ? { reason: req.reason } : {}) };
            res = { ok: true, op: 'lock', until: locked.until, durationMs, devices: locked.devices };
            break;
          }
          case 'unlock':
            locked = null;
            res = { ok: true, op: 'unlock' };
            break;
          case 'key':
            res = req.combo === 'bad' ? { ok: false, error: 'unknown key', code: 'INVALID' } : { ok: true, op: 'key' };
            break;
          case 'register':
            if (!req.exec.startsWith('/') || Object.keys(req.env).some((k) => k === 'LD_PRELOAD')) res = { ok: false, error: 'bad registration', code: 'INVALID' };
            else {
              registrations.set(conn, req);
              res = { ok: true, op: 'register' };
            }
            break;
          case 'unregister':
            registrations.delete(conn);
            res = { ok: true, op: 'unregister' };
            break;
          case 'set-policy': {
            // Like rp-coded: strict validation (unknown keys), write once, 0644 pretty JSON.
            const file = opts.policyPath ?? '/nonexistent/policy.json';
            const unknown = Object.keys((req.policy as { settings?: object }).settings ?? {}).find((k) => k === 'theme');
            if (unknown) res = { ok: false, error: `policy invalid: settings.${unknown} is not a managed setting`, code: 'INVALID' };
            else if (fs.existsSync(file)) res = { ok: false, error: `a policy already exists at ${file}; only root can change it`, code: 'EXISTS' };
            else {
              fs.writeFileSync(file, `${JSON.stringify(req.policy, null, 2)}\n`, { mode: 0o644 });
              res = { ok: true, op: 'set-policy', path: file };
            }
            break;
          }
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
    crashed,
    registered: () => [...registrations.values()],
    subscribed: () => [...subscriptions.values()],
    guardApplies: () => guardApplies,
    /** Push an event to every subscribed connection (what the daemon's audit tail does). */
    push: (event: DaemonEvent) => {
      for (const [conn, events] of subscriptions) if (events.includes(event.ev)) conn.write(`${JSON.stringify(event)}\n`);
    },
    /** Write raw bytes to every connection (framing tests). */
    raw: (text: string) => {
      for (const conn of conns) conn.write(text);
    },
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
    const [lock, status] = await Promise.all([client.request({ op: 'lock', durationMs: 120_000, reason: 'tea', devices: 'mouse' }), client.request({ op: 'status' })]);
    expect(lock).toMatchObject({ op: 'lock', durationMs: 60_000, devices: 'mouse' });
    expect(status).toMatchObject({ op: 'status', locked: { reason: 'tea', devices: 'mouse' } });
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

  it('applies updates with the long timeout, maps daemon refusals, reports install info and waits for a restarted daemon', async () => {
    const sock = path.join(tmp, 'apply.sock');
    const install: InstallInfo = { systemInstall: true, current: '0.1.9', previous: '0.1.8', daemonVersion: '0.2.0' };
    const daemon = fakeDaemon(sock, { install, applyDelayMs: 400, restartDaemon: true });
    await daemon.listen();
    expect(APPLY_UPDATE_TIMEOUT_MS).toBe(5 * 60_000);
    // A 150 ms request timeout would kill the 400 ms apply; the apply timeout is what counts.
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 150, applyTimeoutMs: 3000 });
    expect(await client.status()).toMatchObject({ connected: true, install });
    const update = { file: '/home/alice/.cache/rp-code-updater/pending/rp-code-0.2.0.AppImage', version: '0.2.0', sha512: 'ok' };
    expect(await client.applyUpdate(update)).toEqual({ version: '0.2.0', restartDaemon: true });
    expect(daemon.seen.at(-1)).toEqual({ op: 'apply-update', ...update });
    await expect(client.applyUpdate({ ...update, sha512: 'bad' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: /sha512 mismatch/, details: { daemonCode: 'INVALID' } });
    await expect(client.applyUpdate({ ...update, file: '/tmp/x.AppImage' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { daemonCode: 'REFUSED' } });
    // An apply that outlives even the long timeout fails like any other request.
    const impatient = new DaemonClient({ socketPath: sock, timeoutMs: 150, applyTimeoutMs: 100 });
    await expect(impatient.applyUpdate(update)).rejects.toThrow(/apply-update.*within 100 ms/);
    impatient.close();
    // The daemon restarts: waitForHello keeps trying until it is back.
    await daemon.close();
    expect(await client.waitForHello(300, 50)).toBe(false);
    const again = fakeDaemon(sock, { install });
    const back = client.waitForHello(5000, 50);
    setTimeout(() => void again.listen(), 200);
    expect(await back).toBe(true);
    expect(client.connected).toBe(true);
    expect((await client.status()).install).toEqual(install);
    client.close();
    await again.close();
  });
});

describe('system install detection', () => {
  it('decides from the real executable path and what the daemon reports', () => {
    expect(isSystemInstallExec('/opt/rp-code/current/rp-code')).toBe(true);
    expect(isSystemInstallExec('/opt/rp-code/current/rp-code', '/opt/rp-code/current/')).toBe(true);
    expect(isSystemInstallExec('/opt/rp-code/rp-code')).toBe(false);
    expect(isSystemInstallExec('/opt/rp-code/previous/rp-code')).toBe(false);
    expect(isSystemInstallExec('/opt/rp-code/currently/rp-code')).toBe(false);
    expect(isSystemInstallExec('/tmp/.mount_rpXYZ/rp-code')).toBe(false);
    expect(isSystemInstallExec('/x', '')).toBe(false);
    const connected = { connected: true, install: { systemInstall: true, current: '0.1.9', previous: '0.1.8', daemonVersion: '0.2.0' } };
    expect(systemInstallStatus({ execPath: '/opt/rp-code/current/rp-code', dir: '/opt/rp-code/current', appImage: false, daemon: connected })).toEqual({
      systemInstall: true, dir: '/opt/rp-code/current', execInDir: true, daemonSupportsUpdates: true, canSystemInstall: false, current: '0.1.9', previous: '0.1.8', daemonVersion: '0.2.0',
    });
    // Running from the directory without the daemon: not a system install (nothing can apply updates).
    expect(systemInstallStatus({ execPath: '/opt/rp-code/current/rp-code', dir: '/opt/rp-code/current', appImage: false, daemon: { connected: false } })).toEqual({
      systemInstall: false, dir: '/opt/rp-code/current', execInDir: true, daemonSupportsUpdates: false, canSystemInstall: false,
    });
    // An old daemon (no `install` in status) is connected but cannot apply updates.
    expect(systemInstallStatus({ execPath: '/opt/rp-code/current/rp-code', dir: '/opt/rp-code/current', appImage: false, daemon: { connected: true } })).toMatchObject({ systemInstall: true, daemonSupportsUpdates: false });
    // An AppImage launch can become a system install through the installer.
    expect(systemInstallStatus({ execPath: '/tmp/.mount_rp/rp-code', dir: '/opt/rp-code/current', appImage: true, daemon: connected })).toMatchObject({ systemInstall: false, execInDir: false, canSystemInstall: true, current: '0.1.9' });
    expect(systemInstallStatus({ execPath: undefined, dir: '/opt/rp-code/current', appImage: false, daemon: { connected: false } }).execInDir).toBe(false);
  });
});

describe('KeepaliveLink', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const registration = { exec: '/usr/bin/rp-code', args: ['--hidden'], cwd: '/home/alice', env: { HOME: '/home/alice', DISPLAY: ':0' } };
  const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('backoff doubles from the initial delay up to the cap', () => {
    const b = { initial: 1000, max: 30_000 };
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => reconnectDelay(n, b))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(reconnectDelay(0, b)).toBe(1000);
    expect(reconnectDelay(200, b)).toBe(30_000);
  });

  it('registers after hello, re-registers after the daemon restarts, and unregisters on an intended exit', async () => {
    const sock = path.join(tmp, 'k.sock');
    const daemon = fakeDaemon(sock);
    await daemon.listen();
    const link = new KeepaliveLink({ socketPath: sock, registration, backoffMs: { initial: 20, max: 100 }, timeoutMs: 1000 });
    expect(link.state).toBe('idle');
    link.start();
    await until(() => link.subscribed);
    expect(daemon.seen.map((r) => r.op)).toEqual(['hello', 'register', 'subscribe']);
    expect(daemon.registered()).toEqual([{ op: 'register', ...registration }]);
    expect(link.registrationCount).toBe(1);
    expect(link.attempts).toBe(0);
    // The daemon goes away: the link drops (the daemon sees a "crash") and reconnects with backoff.
    await daemon.close();
    await until(() => !link.registered);
    expect(daemon.crashed).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(link.state).toBe('waiting');
    expect(link.attempts).toBeGreaterThanOrEqual(2);
    const again = fakeDaemon(sock);
    await again.listen();
    await until(() => link.subscribed);
    expect(again.seen.map((r) => r.op)).toEqual(['hello', 'register', 'subscribe']);
    expect(link.registrationCount).toBe(2);
    expect(link.attempts).toBe(0);
    // An intended exit unregisters first; the daemon then has nothing to relaunch.
    await link.unregister();
    expect(link.state).toBe('stopped');
    expect(again.seen.map((r) => r.op)).toEqual(['hello', 'register', 'subscribe', 'unregister']);
    await until(() => again.registered().length === 0);
    expect(again.crashed).toHaveLength(0);
    await again.close();
    // Once stopped it stays stopped.
    link.start();
    expect(link.state).toBe('stopped');
  });

  it('subscribes after registering, dispatches pushed events between responses, and copes with a daemon without event push', async () => {
    const sock = path.join(tmp, 'ev.sock');
    const daemon = fakeDaemon(sock);
    await daemon.listen();
    const events: DaemonEvent[] = [];
    const link = new KeepaliveLink({ socketPath: sock, registration, backoffMs: { initial: 20, max: 100 }, timeoutMs: 1000 });
    const off = link.onEvent((e) => events.push(e));
    link.start();
    await until(() => link.subscribed);
    expect(daemon.seen.map((r) => r.op)).toEqual(['hello', 'register', 'subscribe']);
    expect(daemon.subscribed()).toEqual([['guard-attempt']]);
    const attempt: DaemonEvent = { ev: 'guard-attempt', at: '2026-09-14T12:00:00.000Z', kind: 'ipc', target: '/run/user/1000/hypr/x/.socket.sock', command: 'hyprctl', pid: 42, blocked: false, profile: 'rp-code-session', operation: 'connect', requested: 'wr' };
    daemon.push(attempt);
    await until(() => events.length === 1);
    expect(events[0]).toEqual(attempt);
    // An event arriving while a request is pending goes to the listeners; the response still answers the request.
    daemon.raw(`${JSON.stringify({ ...attempt, target: '/other' })}\n`);
    await until(() => events.length === 2);
    expect(events[1]!.target).toBe('/other');
    // Unknown `ev` names and junk lines are ignored without breaking the link.
    daemon.raw('{"ev":"weather","temp":3}\nnot json\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(2);
    expect(link.registered).toBe(true);
    off();
    daemon.push(attempt);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(2);
    // After a reconnect the subscription is renewed.
    await daemon.close();
    await until(() => !link.registered);
    const again = fakeDaemon(sock);
    await again.listen();
    await until(() => link.subscribed);
    expect(again.seen.map((r) => r.op)).toEqual(['hello', 'register', 'subscribe']);
    await link.unregister();
    await again.close();
    // A daemon that predates `subscribe` refuses it: the link stays registered, just without events.
    const sock2 = path.join(tmp, 'old.sock');
    const old = fakeDaemon(sock2, { noSubscribe: true });
    await old.listen();
    const link2 = new KeepaliveLink({ socketPath: sock2, registration, backoffMs: { initial: 20, max: 100 }, timeoutMs: 1000 });
    link2.start();
    await until(() => old.seen.filter((r) => r.op === 'subscribe').length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(link2.registered).toBe(true);
    expect(link2.subscribed).toBe(false);
    // `events: []` skips the subscribe request entirely.
    const link3 = new KeepaliveLink({ socketPath: sock2, registration, backoffMs: { initial: 20, max: 100 }, timeoutMs: 1000, events: [] });
    link3.start();
    await until(() => old.registered().length === 2);
    expect(old.seen.filter((r) => r.op === 'subscribe')).toHaveLength(1);
    await link2.unregister();
    await link3.unregister();
    await old.close();
  });

  it('keeps retrying while no daemon is listening and resolves unregister immediately', async () => {
    const sock = path.join(tmp, 'none.sock');
    const link = new KeepaliveLink({ socketPath: sock, registration, backoffMs: { initial: 10, max: 40 }, timeoutMs: 500 });
    link.start();
    await until(() => link.attempts >= 3, 2000);
    expect(link.registered).toBe(false);
    await link.unregister();
    expect(link.state).toBe('stopped');
    // A refused registration is retried too (bad exec → INVALID), and close() drops without unregistering.
    const sock2 = path.join(tmp, 'refuse.sock');
    const daemon = fakeDaemon(sock2);
    await daemon.listen();
    const refused = new KeepaliveLink({ socketPath: sock2, registration: { ...registration, exec: 'relative' }, backoffMs: { initial: 10, max: 20 }, timeoutMs: 500 });
    refused.start();
    await until(() => daemon.seen.filter((r) => r.op === 'register').length >= 2, 2000);
    expect(refused.registered).toBe(false);
    refused.close();
    expect(daemon.registered()).toEqual([]);
    await daemon.close();
  });
});

describe('policy', () => {
  const base: AppSettings = defaultSettings();

  it('parses app.allowQuit and app.users, ignores unknown app keys, rejects wrong types', () => {
    expect(parsePolicy({ version: 1 }).app).toBeUndefined();
    expect(appPolicy(parsePolicy({ version: 1 }))).toEqual({ allowQuit: true, users: [] });
    expect(appPolicy(null)).toEqual({ allowQuit: true, users: [] });
    const p = parsePolicy({ version: 1, app: { allowQuit: false, users: ['alice', ' bob '], theme: 'x' } });
    expect(p.app).toEqual({ allowQuit: false, users: ['alice', 'bob'] });
    expect(appPolicy(p)).toEqual({ allowQuit: false, users: ['alice', 'bob'] });
    expect(parsePolicy({ version: 1, app: {} }).app).toEqual({});
    expect(appPolicy(parsePolicy({ version: 1, app: { allowQuit: true } }))).toEqual({ allowQuit: true, users: [] });
    // app.allowQuit is not a settings key: it never shows up as a managed path.
    expect(managedPaths(p)).toEqual([]);
    expect(applyPolicy(base, p).settings).toEqual(base);
    expect(() => parsePolicy({ version: 1, app: { allowQuit: 'no' } })).toThrow(/app.allowQuit must be a boolean/);
    expect(() => parsePolicy({ version: 1, app: { allowQuit: 0 } })).toThrow(/app.allowQuit must be a boolean/);
    expect(() => parsePolicy({ version: 1, app: { users: [] } })).toThrow(/app.users must be a non-empty array/);
    expect(() => parsePolicy({ version: 1, app: { users: 'alice' } })).toThrow(/app.users/);
    expect(() => parsePolicy({ version: 1, app: { users: ['alice', 3] } })).toThrow(/app.users/);
    expect(() => parsePolicy({ version: 1, app: { users: [''] } })).toThrow(/app.users/);
    expect(() => parsePolicy({ version: 1, app: 'no' })).toThrow(/app must be an object/);
    expect(() => parsePolicy({ version: 1, app: [] })).toThrow(/app must be an object/);
  });

  it('parses the guard block like the daemon and rejects what it rejects', () => {
    const full = parsePolicy({
      version: 1,
      app: { users: ['work'] },
      guard: { mode: 'enforce', protectApp: false, wallpaper: true, compositorIpc: 'deny', shell: 'noctalia', loginHelpers: ['/usr/lib/sddm/sddm-helper'], extraDenyPaths: ['~/.config/hypr/hyprpaper.conf', '@{HOME}/x'], extraDenySockets: ['/run/user/1000/foo.sock'], allowBinaries: ['/usr/bin/hyprctl'] },
    });
    expect(full.guard).toEqual({ mode: 'enforce', protectApp: false, wallpaper: true, compositorIpc: 'deny', shell: 'noctalia', loginHelpers: ['/usr/lib/sddm/sddm-helper'], extraDenyPaths: ['~/.config/hypr/hyprpaper.conf', '@{HOME}/x'], extraDenySockets: ['/run/user/1000/foo.sock'], allowBinaries: ['/usr/bin/hyprctl'] });
    expect(guardMode(full)).toBe('enforce');
    expect(guardMode(parsePolicy({ version: 1 }))).toBe('off');
    expect(guardMode(parsePolicy({ version: 1, guard: {} }))).toBe('off');
    expect(guardMode(null)).toBe('off');
    expect(parsePolicy({ version: 1, guard: { mode: 'off' } }).guard).toEqual({ mode: 'off' });
    const bad: unknown[] = [
      { version: 1, guard: 'on' },
      { version: 1, guard: { mode: 'on' } },
      { version: 1, guard: { mode: 'audit' } },
      { version: 1, app: { users: ['a'] }, guard: { compositorIpc: 'maybe' } },
      { version: 1, app: { users: ['a'] }, guard: { shell: 'waybar' } },
      { version: 1, app: { users: ['a'] }, guard: { protectApp: 'yes' } },
      { version: 1, app: { users: ['a'] }, guard: { loginHelpers: [] } },
      { version: 1, app: { users: ['a'] }, guard: { loginHelpers: ['sddm-helper'] } },
      { version: 1, app: { users: ['a'] }, guard: { extraDenyPaths: ['/a b'] } },
      { version: 1, app: { users: ['a'] }, guard: { allowBinaries: ['~/bin/x'] } },
      { version: 1, app: { users: ['a'] }, guard: { extraDenySockets: [''] } },
    ];
    for (const v of bad) expect(() => parsePolicy(v), JSON.stringify(v)).toThrow(/Invalid policy file/);
    expect(() => parsePolicy({ version: 1, guard: { mode: 'audit' } })).toThrow(/guard.mode needs app.users/);
    // Unknown guard keys are ignored here (the daemon rejects them on write).
    expect(parsePolicy({ version: 1, app: { users: ['a'] }, guard: { mode: 'audit', reassert: true } }).guard).toEqual({ mode: 'audit' });
  });

  it('parses and validates the policy file', () => {
    const policy = parsePolicy({ version: 1, managedBy: 'IT', settings: { autonomy: { maxSelfWakesPerHour: 5 }, maxInputLockMs: 20_000, permissions: { moduleAllow: { system: false } }, web: { allowlist: ['a.example'] } }, inputLock: { maxDurationMs: 10_000, enabled: true } });
    expect(managedPaths(policy)).toEqual(['autonomy.maxSelfWakesPerHour', 'maxInputLockMs', 'permissions.moduleAllow.system', 'web.allowlist']);
    expect(() => parsePolicy({ version: 2 })).toThrow(/version must be 1/);
    expect(() => parsePolicy({ version: 1, settings: { maxInputLockMs: 'x' } })).toThrow(/maxInputLockMs/);
    expect(() => parsePolicy({ version: 1, settings: { displayBackend: 'kde' } })).toThrow(/displayBackend/);
    expect(managedPaths(null)).toEqual([]);
    const updates = parsePolicy({ version: 1, settings: { updates: { enabled: false, automatic: true } } });
    expect(updates.settings?.updates).toEqual({ enabled: false, automatic: true });
    expect(managedPaths(updates)).toEqual(['updates.automatic', 'updates.enabled']);
    // allowDowngrade is a daemon rule: accepted, kept, never a managed path.
    const downgrade = parsePolicy({ version: 1, settings: { updates: { allowDowngrade: true } } });
    expect(downgrade.settings?.updates).toEqual({ allowDowngrade: true });
    expect(managedPaths(downgrade)).toEqual([]);
    expect(() => parsePolicy({ version: 1, settings: { updates: { allowDowngrade: 'yes' } } })).toThrow(/allowDowngrade must be a boolean/);
    expect(managedPaths(parsePolicy({ version: 1, settings: { updates: {} } }))).toEqual([]);
    expect(() => parsePolicy({ version: 1, settings: { updates: { enabled: 'no' } } })).toThrow(/updates.enabled must be a boolean/);
  });

  it('parses and applies the browser block', () => {
    const policy = parsePolicy({ version: 1, settings: { browser: { allowBlocking: false, allowEval: false, allowHistory: true, homePage: 'https://home.test/' } } });
    expect(policy.settings?.browser).toEqual({ allowBlocking: false, allowEval: false, allowHistory: true, homePage: 'https://home.test/' });
    expect(managedPaths(policy)).toEqual(['browser.allowBlocking', 'browser.allowEval', 'browser.allowHistory', 'browser.homePage']);
    expect(managedPaths(parsePolicy({ version: 1, settings: { browser: {} } }))).toEqual([]);
    expect(() => parsePolicy({ version: 1, settings: { browser: { allowEval: 'no' } } })).toThrow(/browser.allowEval must be a boolean/);
    expect(() => parsePolicy({ version: 1, settings: { browser: { allowEval: 'yes' } } })).toThrow(/browser.allowEval/);
    expect(() => parsePolicy({ version: 1, settings: { browser: { homePage: 'ftp://x' } } })).toThrow(/browser.homePage/);
    // Unknown keys inside the block are ignored (the daemon rejects them; the app applies what it knows).
    expect(parsePolicy({ version: 1, settings: { browser: { bridgePort: 1 } } }).settings?.browser).toEqual({});
    const applied = applyPolicy(base, parsePolicy({ version: 1, settings: { browser: { allowEval: false } } }));
    expect(applied.settings.browser).toEqual({ ...base.browser, allowEval: false });
    expect(applied.managed).toEqual(['browser.allowEval']);
    const { allowEval: _managed, ...rest } = base.browser;
    void _managed;
    expect(stripManagedPatch({ browser: { ...base.browser, allowEval: true, homePage: 'https://x.test/' } }, ['browser.allowEval'])).toEqual({ browser: { ...rest, homePage: 'https://x.test/' } });
  });

  it('applyPolicy pins updates.automatic and switches it off when updates are disabled', () => {
    const pinned = applyPolicy({ ...base, updates: { automatic: true, checkIntervalHours: 6 } }, parsePolicy({ version: 1, settings: { updates: { automatic: false } } }));
    expect(pinned.settings.updates).toEqual({ automatic: false, checkIntervalHours: 6 });
    expect(pinned.managed).toEqual(['updates.automatic']);
    const disabled = applyPolicy({ ...base, updates: { automatic: true, checkIntervalHours: 6 } }, parsePolicy({ version: 1, settings: { updates: { enabled: false } } }));
    expect(disabled.settings.updates.automatic).toBe(false);
    expect(disabled.managed).toEqual(['updates.enabled']);
    expect(stripManagedPatch({ updates: { automatic: true, checkIntervalHours: 1 } }, ['updates.automatic'])).toEqual({ updates: { checkIntervalHours: 1 } });
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
    expect(await watcher.current()).toMatchObject({ present: false, policy: null, managed: [], app: { allowQuit: true, users: [] } });
    expect((await loadPolicy(file)).present).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, managedBy: 'IT', settings: { maxInputLockMs: 5000 } }));
    fs.utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    expect(await watcher.current()).toMatchObject({ present: true, managedBy: 'IT', managed: ['maxInputLockMs'] });
    fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { displayBackend: 'electron' } }));
    expect((await watcher.current()).managed).toEqual(['displayBackend']);
    fs.writeFileSync(file, JSON.stringify({ version: 1, app: { allowQuit: false, users: ['alice'] } }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
    expect((await watcher.current()).app).toEqual({ allowQuit: false, users: ['alice'] });
    fs.writeFileSync(file, '{bad');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const broken = await watcher.current();
    expect(broken.present).toBe(true);
    expect(broken.error).toMatch(/JSON|policy/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('guard status and attempt log', () => {
  const engaged: GuardInfo = { available: true, mode: 'audit', loaded: ['rp-code-session', 'rp-code-app'], users: ['work'], residual: ['audit mode: nothing is blocked'], pamConfigured: true, shell: 'noctalia', compositor: 'hyprland', appliedAt: '2026-09-14T12:00:00.000Z' };
  const policy = parsePolicy({ version: 1, app: { users: ['work'] }, guard: { mode: 'audit' } });

  it('guardStatusOf combines the policy with what the daemon reports', () => {
    expect(guardStatusOf({ policy, daemon: { connected: true, guard: engaged } })).toEqual({ ...engaged, configured: true, daemonSupportsGuard: true });
    // Off in the policy but still loaded: reported as-is (the daemon unloads on its next apply).
    expect(guardStatusOf({ policy: parsePolicy({ version: 1 }), daemon: { connected: true, guard: engaged } })).toMatchObject({ configured: false, mode: 'audit', loaded: engaged.loaded });
    // No daemon: only the policy side is known.
    expect(guardStatusOf({ policy, daemon: { connected: false } })).toEqual({ configured: true, daemonSupportsGuard: false, available: false, mode: 'audit', loaded: [], users: ['work'], residual: ['the daemon is not connected; nothing is engaged'] });
    expect(guardStatusOf({ policy: null, daemon: { connected: false } })).toEqual({ configured: false, daemonSupportsGuard: false, available: false, mode: 'off', loaded: [], users: [], residual: [] });
    // An old daemon answers status without `guard`.
    expect(guardStatusOf({ policy, daemon: { connected: true } }).residual[0]).toContain('predates the session guard');
  });

  it('GuardAttemptLog keeps the newest 50 without the ev tag', () => {
    const log = new GuardAttemptLog(3);
    const ev = (n: number): DaemonEvent => ({ ev: 'guard-attempt', at: `t${n}`, kind: 'config', target: `/f${n}`, command: 'vim', pid: n, blocked: false, profile: 'rp-code-session', operation: 'open' });
    expect(log.push(ev(1))).toEqual({ at: 't1', kind: 'config', target: '/f1', command: 'vim', pid: 1, blocked: false, profile: 'rp-code-session', operation: 'open' });
    for (const n of [2, 3, 4]) log.push(ev(n));
    expect(log.list().map((r) => r.pid)).toEqual([4, 3, 2]);
    expect(new GuardAttemptLog().list()).toEqual([]);
  });

  it('DaemonClient reports guard in status and maps guard-apply/guard-status', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guard-'));
    const sock = path.join(tmp, 'g.sock');
    const daemon = fakeDaemon(sock, { guard: engaged });
    await daemon.listen();
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 1000 });
    expect((await client.status()).guard).toEqual(engaged);
    expect(await client.guardStatus()).toEqual(engaged);
    expect(await client.guardApply()).toEqual(engaged);
    expect(daemon.guardApplies()).toBe(1);
    client.close();
    await daemon.close();
    // An old daemon: INVALID → INVALID_ARGUMENT, and no guard in status.
    const old = fakeDaemon(sock);
    await old.listen();
    const client2 = new DaemonClient({ socketPath: sock, timeoutMs: 1000 });
    expect((await client2.status()).guard).toBeUndefined();
    await expect(client2.guardApply()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { daemonCode: 'INVALID' } });
    client2.close();
    await old.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('SystemIntegration exposes guard status, guardApply, the attempt log and passes --guard to the installer', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guard-int-'));
    const sock = path.join(tmp, 'g.sock');
    const daemon = fakeDaemon(sock, { guard: engaged });
    await daemon.listen();
    const resources = path.join(tmp, 'resources');
    fs.mkdirSync(path.join(resources, 'system'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'system', 'install.sh'), '#!/bin/sh\necho ok\n');
    const policyPath = path.join(tmp, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, app: { users: ['work'] }, guard: { mode: 'audit' } }));
    const commands: string[][] = [];
    const log = new GuardAttemptLog();
    const integration = new SystemIntegration({
      platform: 'linux',
      daemon: new DaemonClient({ socketPath: sock, timeoutMs: 1000 }),
      policy: new PolicyWatcher(policyPath),
      resourcesDirs: [resources],
      homeDir: path.join(tmp, 'home'),
      appBin: '/opt/rp-code/current/rp-code',
      userName: 'work',
      guardLog: log,
      run: async (file, args) => {
        commands.push([file, ...args]);
        return { code: 0, stdout: file === 'id' ? 'work rp-code\n' : '[ok]\n', stderr: '' };
      },
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
    const status = await integration.status();
    expect(status.guard).toEqual({ ...engaged, configured: true, daemonSupportsGuard: true });
    expect((await integration.guardApply()).guard.loaded).toEqual(engaged.loaded);
    expect(daemon.guardApplies()).toBe(1);
    log.push({ ev: 'guard-attempt', at: 't', kind: 'signal', target: 'rp-code-app', command: 'kill', pid: 9, blocked: false, profile: 'rp-code-session', operation: 'signal' });
    expect(await integration.guardAttempts()).toEqual([{ at: 't', kind: 'signal', target: 'rp-code-app', command: 'kill', pid: 9, blocked: false, profile: 'rp-code-session', operation: 'signal' }]);
    await integration.install({ autostart: false });
    expect(commands.at(-1)!.slice(-1)).toEqual(['--guard']);
    // Without the guard in the policy the flag stays off.
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, app: { users: ['work'] } }));
    await new Promise((r) => setTimeout(r, 20));
    await integration.install({ autostart: false });
    expect(commands.at(-1)).not.toContain('--guard');
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('SystemIntegration.createPolicy', () => {
  const base: AppSettings = defaultSettings();

  it('policyTemplate seeds a valid policy from the current settings', () => {
    const settings: AppSettings = { ...base, maxInputLockMs: 42_000, displayBackend: 'electron', web: { ...base.web, allowlist: ['a.example'] }, permissions: { moduleAllow: { desktop: false } }, updates: { automatic: false, checkIntervalHours: 6 } };
    const text = policyTemplate(settings, 'alice');
    expect(text.endsWith('}\n')).toBe(true);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json).toMatchObject({ version: 1, managedBy: '', inputLock: { enabled: true, maxDurationMs: 42_000, emergencyKey: 'esc', emergencyHoldMs: 5000 } });
    // The quit/relaunch and session-guard sections are present but off, with the user pre-filled.
    expect(json.app).toEqual({ allowQuit: true, users: ['alice'] });
    expect(json.guard).toMatchObject({ mode: 'off', protectApp: true, wallpaper: true, compositorIpc: 'shell-only', shell: 'auto' });
    expect(JSON.parse(policyTemplate(settings)).app).toEqual({ allowQuit: true });
    expect(json.settings).toMatchObject({ maxInputLockMs: 42_000, autonomy: base.autonomy, permissions: { moduleAllow: { desktop: false } }, web: { allowlist: ['a.example'] }, desktop: { launchAllowlist: [] }, memory: base.memory, displayBackend: 'electron', updates: { enabled: true, automatic: false } });
    expect((json.settings as { senses: object }).senses).toEqual({ includeInPrompt: base.senses.includeInPrompt, watchDirs: base.senses.watchDirs, calendarSources: base.senses.calendarSources });
    // Round-trips through the app's parser without problems, with every key managed.
    const parsed = parsePolicy(json);
    expect(managedPaths(parsed)).toEqual(expect.arrayContaining(['maxInputLockMs', 'autonomy.maxSelfWakesPerHour', 'permissions.moduleAllow.desktop', 'web.allowlist', 'desktop.launchAllowlist', 'memory.enabled', 'senses.watchDirs', 'displayBackend', 'updates.automatic', 'updates.enabled']));
  });

  it('parses, calls the daemon, refreshes the watcher and maps daemon errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pol-'));
    const sock = path.join(tmp, 'd.sock');
    const policyPath = path.join(tmp, 'policy.json');
    const daemon = fakeDaemon(sock, { policyPath });
    await daemon.listen();
    const client = new DaemonClient({ socketPath: sock, timeoutMs: 2000 });
    const integration = new SystemIntegration({
      platform: 'linux',
      daemon: client,
      policy: new PolicyWatcher(policyPath),
      resourcesDirs: [],
      homeDir: path.join(tmp, 'home'),
      appBin: '/opt/rp-code',
      userName: 'alice',
      udevRulePath: path.join(tmp, 'rules'),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
    const before = await integration.status();
    expect(before.daemon.connected).toBe(true);
    expect(before.policy).toMatchObject({ present: false, canCreate: true });

    // Invalid JSON and invalid policies are rejected before the daemon is involved.
    await expect(integration.createPolicy('{oops')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { problems: [expect.stringMatching(/not valid JSON/)] } });
    await expect(integration.createPolicy(JSON.stringify({ version: 2, settings: { maxInputLockMs: 'x' } }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { problems: ['version must be 1', 'settings.maxInputLockMs must be a number ≥ 1000'] } });
    expect(daemon.seen.filter((r) => r.op === 'set-policy')).toHaveLength(0);
    // The daemon's stricter validation (unknown keys) is surfaced as INVALID_ARGUMENT too.
    await expect(integration.createPolicy(JSON.stringify({ version: 1, settings: { theme: 'dark' } }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: /settings.theme/, details: { daemonCode: 'INVALID' } });
    expect(fs.existsSync(policyPath)).toBe(false);

    const text = integration.policyTemplate({ ...base, maxInputLockMs: 15_000 }).replace('"managedBy": ""', '"managedBy": "alice"');
    const after = await integration.createPolicy(text);
    expect(daemon.seen.filter((r) => r.op === 'set-policy')).toHaveLength(2);
    expect(after.policy).toMatchObject({ present: true, canCreate: false, path: policyPath, managedBy: 'alice' });
    expect(after.policy.managed).toContain('maxInputLockMs');
    expect(JSON.parse(fs.readFileSync(policyPath, 'utf8'))).toMatchObject({ version: 1, managedBy: 'alice', inputLock: { maxDurationMs: 15_000 } });

    // Second creation: the daemon's EXISTS → INVALID_ARGUMENT with the daemon message.
    const err = await integration.createPolicy(text).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpError);
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', message: /already exists .* only root can change it/, details: { daemonCode: 'EXISTS' } });
    expect(rpErrorCodeFor('EXISTS')).toBe('INVALID_ARGUMENT');
    expect(rpErrorCodeFor('POLICY')).toBe('PERMISSION_DENIED');
    expect(rpErrorCodeFor('BUSY')).toBe('CAPABILITY_FAILED');
    // Without a daemon nothing can be created.
    client.close();
    await daemon.close();
    const offline = await integration.status();
    expect(offline.daemon.connected).toBe(false);
    expect(offline.policy.canCreate).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('SystemIntegration', () => {
  it('assembles the status and toggles the XDG autostart entry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-sys-'));
    const resources = path.join(tmp, 'resources');
    fs.mkdirSync(path.join(resources, 'system'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'system', 'install.sh'), '#!/bin/sh\necho ok\n');
    fs.writeFileSync(path.join(resources, 'system', 'rp-coded.service'), '[Unit]\n');
    fs.mkdirSync(path.join(resources, 'bin'));
    fs.writeFileSync(path.join(resources, 'bin', 'rp-coded'), 'ELF');
    const commands: string[][] = [];
    const integration = new SystemIntegration({
      platform: 'linux',
      daemon: new DaemonClient({ socketPath: path.join(tmp, 'none.sock'), timeoutMs: 300 }),
      policy: new PolicyWatcher(path.join(tmp, 'policy.json')),
      resourcesDirs: [path.join(tmp, 'nope'), resources],
      homeDir: path.join(tmp, 'home'),
      appBin: '/opt/rp code/rp-code',
      appImage: true,
      execPath: '/tmp/.mount_rp/rp-code',
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
    expect(status).toMatchObject({ platform: 'linux', daemon: { connected: false }, policy: { present: false, canCreate: false, managed: [], allowQuit: true, users: [] }, udev: { rulePresent: false, inGroup: true, groupName: 'rp-code' }, autostart: { enabled: false, method: 'none' }, installerAvailable: true });
    expect(status.install).toEqual({ systemInstall: false, dir: '/opt/rp-code/current', execInDir: false, daemonSupportsUpdates: false, canSystemInstall: true });
    expect(status.guard).toEqual({ configured: false, daemonSupportsGuard: false, available: false, mode: 'off', loaded: [], users: [], residual: [] });
    expect(await integration.installerPath()).toBe(path.join(resources, 'system', 'install.sh'));
    const enabled = await integration.setAutostart(true);
    expect(enabled.autostart).toEqual({ enabled: true, method: 'xdg', path: path.join(tmp, 'home', '.config', 'autostart', 'rp-code.desktop') });
    const entry = fs.readFileSync(enabled.autostart.path!, 'utf8');
    expect(entry).toContain('Exec="/opt/rp code/rp-code" --hidden');
    expect(autostartDesktopEntry('/usr/bin/rp-code')).toContain('Exec=/usr/bin/rp-code --hidden');
    expect((await integration.setAutostart(false)).autostart.enabled).toBe(false);
    const result = await integration.install({ autostart: false });
    expect(result).toEqual({ ok: true, output: '[ok] group\n' });
    // The installer runs from a staged copy (an AppImage's FUSE mount is unreadable to root).
    const stage = path.join(tmp, 'home', '.cache', 'rp-code', 'system-install');
    expect(commands.at(-1)).toEqual(['pkexec', path.join(stage, 'install.sh'), '--app-bin', '/opt/rp code/rp-code', '--user', 'alice', '--autostart', 'none']);
    await integration.install({ autostart: true, systemInstall: false });
    expect(commands.at(-1)).toEqual(['pkexec', path.join(stage, 'install.sh'), '--app-bin', '/opt/rp code/rp-code', '--user', 'alice', '--autostart', 'xdg', '--no-system-install']);
    expect(fs.readdirSync(stage).sort()).toEqual(['install.sh', 'rp-coded', 'rp-coded.service']);
    expect(fs.statSync(path.join(stage, 'install.sh')).mode & 0o111).toBe(0o111);
    expect(fs.statSync(path.join(stage, 'rp-coded')).mode & 0o111).toBe(0o111);
    expect(fs.readFileSync(path.join(stage, 'rp-coded.service'), 'utf8')).toBe('[Unit]\n');
    // Browser policy: the staged installer with the browser-only flags, then the removal flag.
    const policy = await integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821 });
    expect(policy).toEqual({ ok: true, output: '[ok] group\n' });
    expect(commands.at(-1)).toEqual([
      'pkexec', path.join(stage, 'install.sh'), '--browser-only', '--browser-extension', 'abcdefghijklmnopabcdefghijklmnop',
      '--browser-update-url', 'http://127.0.0.1:47821/extension/update.xml', '--browser-port', '47821', '--user', 'alice',
    ]);
    await integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821, homePage: 'https://home.test/start' });
    expect(commands.at(-1)!.slice(-4)).toEqual(['--browser-home', 'https://home.test/start', '--user', 'alice']);
    await expect(integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821, homePage: 'javascript:1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821, extraPolicyDirs: ['/etc/helium/policies/managed/', ' ', '/etc/helium/policies/managed'] });
    expect(commands.at(-1)!.slice(-4)).toEqual(['--browser-policy-dir', '/etc/helium/policies/managed', '--user', 'alice']);
    await expect(integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821, extraPolicyDirs: ['/etc/helium'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await integration.removeBrowserPolicy();
    expect(commands.at(-1)).toEqual(['pkexec', path.join(stage, 'install.sh'), '--remove-browser-policy', '--user', 'alice']);
    await integration.removeBrowserPolicy(['/etc/helium/policies/managed']);
    expect(commands.at(-1)).toEqual(['pkexec', path.join(stage, 'install.sh'), '--remove-browser-policy', '--browser-policy-dir', '/etc/helium/policies/managed', '--user', 'alice']);
    await expect(integration.installBrowserPolicy({ extensionId: 'nope', updateUrl: 'http://127.0.0.1:47821/extension/update.xml', port: 47821 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(integration.installBrowserPolicy({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', updateUrl: 'http://evil.test/update.xml', port: 47821 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
