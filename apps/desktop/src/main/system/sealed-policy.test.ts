/**
 * The app's half of the TOTP-locked policy, remote configuration and remote packs: where the
 * policy is read from, what the app remembers about a seal it has seen, and how the pinned packs
 * are brought into line. The daemon's half is tested in `native/rpchatd`.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse, InstalledPackView, PackSource, PolicyFile, SealInfo } from '@rp/shared';
import { DEFAULT_SEAL_INFO, RpError } from '@rp/shared';
import { DaemonClient } from './daemon-client.js';
import { SystemIntegration } from './integration.js';
import { PolicyWatcher, loadPolicy, parseLock, parsePacks, parsePolicy, parseRemote } from './policy.js';
import { SealCache, canonicalJson, policyHash } from './seal-cache.js';
import { RemoteConfigService, nextCheckDelayMs, packNeedsInstall, packsToRemove } from './remote-config.js';
import { keyLine, lockoutLine, packLine, remoteLine, runtimeLine, sealLine } from '../../renderer/lib/seal';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.useRealTimers();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-seal-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const POLICY: PolicyFile = { version: 1, managedBy: 'Acme IT', app: { allowQuit: false, users: ['alice'] } };

describe('policy blocks: remote, packs and lock', () => {
  it('accepts what the daemon accepts and names what it refuses', () => {
    const signature = 'A'.repeat(86);
    const policy = parsePolicy({
      version: 1,
      remote: { url: 'https://example.com/chain.json', intervalMinutes: 30 },
      packs: { sources: [{ id: 'luna', url: 'https://example.com/luna.rppack', signature, sha256: 'A'.repeat(64), version: '1.2.0' }], removeUnlisted: true, refreshMinutes: 60 },
      lock: { digits: 8, period: 60, selfHeal: false },
    });
    expect(policy.remote).toEqual({ url: 'https://example.com/chain.json', intervalMinutes: 30 });
    expect(policy.packs?.sources?.[0]).toEqual({ id: 'luna', url: 'https://example.com/luna.rppack', signature, sha256: 'a'.repeat(64), version: '1.2.0' });
    expect(policy.packs?.removeUnlisted).toBe(true);
    expect(policy.lock).toEqual({ digits: 8, period: 60, selfHeal: false });
  });

  it('refuses a remote source that is not https (or loopback http)', () => {
    const problems: string[] = [];
    expect(parseRemote({ url: 'http://example.com/p.json' }, problems)).toBeUndefined();
    expect(problems[0]).toMatch(/https:\/\//);
    expect(parseRemote({ url: 'http://127.0.0.1:8080/p.json' }, [])).toEqual({ url: 'http://127.0.0.1:8080/p.json' });
    expect(parseRemote({ url: 'file:///etc/passwd' }, [])).toBeUndefined();
    expect(parseRemote({ url: 'https://example.com/a b' }, [])).toBeUndefined();
  });

  it('refuses pack sources that are not pack ids, checksums or URLs', () => {
    const problems: string[] = [];
    const packs = parsePacks({ sources: [{ id: 'Luna!', url: 'https://x/y' }, { id: 'ok', url: 'https://x/y', sha256: 'abc' }, { id: 'ok', url: 'https://x/y' }] }, problems);
    // Every problem is named; `parsePolicy` refuses the whole document once there is one, so the
    // partially-built list this returns is never what ends up in force.
    expect(problems.join('\n')).toMatch(/must be a pack id/);
    expect(problems.join('\n')).toMatch(/64 hex/);
    expect(problems.join('\n')).toMatch(/twice/);
    expect(packs?.sources?.map((s) => s.id)).toEqual(['ok']);
    expect(() => parsePolicy({ version: 1, packs: { sources: [{ id: 'Luna!', url: 'https://x/y' }] } })).toThrow(/must be a pack id/);
  });

  it('refuses lock parameters outside the ranges the daemon enforces', () => {
    const problems: string[] = [];
    parseLock({ digits: 9, period: 1, window: 99, selfHeal: 'no' }, problems);
    expect(problems).toEqual([
      'lock.digits must be 6, 7 or 8',
      'lock.period must be between 15 and 300 seconds',
      'lock.window must be between 0 and 10',
      'lock.selfHeal must be a boolean',
    ]);
  });
});

describe('loadPolicy sources', () => {
  it('prefers the daemon runtime filesystem over the file on disk', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'policy.json');
    const runtime = path.join(dir, 'runtime.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, managedBy: 'edited by hand' }));
    await fs.writeFile(runtime, JSON.stringify(POLICY));
    const state = await loadPolicy(file, { runtime });
    expect(state.source).toBe('runtime');
    expect(state.managedBy).toBe('Acme IT');
    expect(state.policyHash).toBe(policyHash(POLICY));
    expect(state.app.allowQuit).toBe(false);
  });

  it('falls back to the file, then to the seal marker, then to the app cache', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'policy.json');
    const runtime = path.join(dir, 'runtime.json');
    const marker = path.join(dir, 'policy.sealed');
    const cache = new SealCache(path.join(dir, 'cache.json'));

    await fs.writeFile(file, JSON.stringify(POLICY));
    expect((await loadPolicy(file, { runtime, marker, cache })).source).toBe('file');
    // A marker beside the file means the machine is sealed, whichever copy was read.
    await fs.writeFile(marker, JSON.stringify({ version: 1, sealedAt: 't', policyHash: policyHash(POLICY), policy: POLICY }));
    const withMarker = await loadPolicy(file, { runtime, marker, cache });
    expect(withMarker.source).toBe('file');
    expect(withMarker.sealed).toBe(true);

    // Someone removes the policy file: the seal still says what this machine enforces.
    await fs.rm(file);
    const fromSeal = await loadPolicy(file, { runtime, marker, cache });
    expect(fromSeal.source).toBe('seal');
    expect(fromSeal.sealed).toBe(true);
    expect(fromSeal.managedBy).toBe('Acme IT');

    // And /etc/rpchat is wiped entirely: the app's own memory keeps it managed.
    await cache.remember(POLICY, { managedBy: 'Acme IT' });
    await fs.rm(marker);
    const fromCache = await loadPolicy(file, { runtime, marker, cache });
    expect(fromCache.source).toBe('cache');
    expect(fromCache.fromCache).toBe(true);
    expect(fromCache.sealed).toBe(true);
    expect(fromCache.app.allowQuit).toBe(false);

    // Without any of them the machine is simply unmanaged, which is not an error.
    await cache.clear();
    const none = await loadPolicy(file, { runtime, marker, cache });
    expect(none).toMatchObject({ present: false, source: 'none', sealed: false, policy: null });
    expect(none.error).toBeUndefined();
  });

  it('re-reads when the runtime copy changes although the file did not', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'policy.json');
    const runtime = path.join(dir, 'runtime.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, managedBy: 'local' }));
    const watcher = new PolicyWatcher(file, undefined, { runtime });
    expect((await watcher.current()).managedBy).toBe('local');
    await fs.writeFile(runtime, JSON.stringify({ version: 1, managedBy: 'published by the daemon' }));
    expect((await watcher.current()).managedBy).toBe('published by the daemon');
  });
});

describe('SealCache', () => {
  it('hashes a policy the way the daemon does and remembers it until it is cleared', async () => {
    const dir = await tempDir();
    const cache = new SealCache(path.join(dir, 'sealed-policy.json'));
    expect(await cache.read()).toBeNull();
    const entry = await cache.remember(POLICY, { sealedAt: '2026-09-16T09:00:00Z', managedBy: 'Acme IT' });
    expect(entry.policyHash).toBe(policyHash(POLICY));
    expect((await cache.read())?.policy).toEqual(POLICY);
    // Re-remembering the same policy keeps the first sighting.
    const again = await cache.remember(POLICY, { sealedAt: '2026-09-16T09:00:00Z', managedBy: 'Acme IT' });
    expect(again.seenAt).toBe(entry.seenAt);
    await cache.clear();
    expect(await cache.read()).toBeNull();
  });

  it('ignores a damaged cache instead of refusing to start', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'sealed-policy.json');
    await fs.writeFile(file, '{ not json');
    const warn = vi.fn();
    expect(await new SealCache(file, { info: vi.fn(), warn }).read()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('canonicalises JSON with sorted keys, which is what both sides hash', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(policyHash({ version: 1, managedBy: 'x' })).toBe(policyHash({ managedBy: 'x', version: 1 }));
  });
});

/**
 * The daemon writes its replies with serde, which leaves an empty `Vec` out of the object
 * altogether (`skip_serializing_if = "Vec::is_empty"`). The fake does the same so the app is
 * tested against the shape a real machine sends: on the ordinary machine that has never been
 * tampered with, `seal.tampers` is not a `[]` — it is simply not there.
 */
const OMITTED_WHEN_EMPTY = new Set(['paths', 'tampers', 'residual', 'rotations', 'packs', 'degraded']);

function daemonJson(res: DaemonResponse): string {
  return JSON.stringify(res, (key, value: unknown) => (Array.isArray(value) && value.length === 0 && OMITTED_WHEN_EMPTY.has(key) ? undefined : value));
}

/** A fake rpchatd that speaks only the seal and remote ops this suite needs. */
function sealDaemon(socketPath: string, state: { seal: SealInfo; applied?: string[] }) {
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
        const req = JSON.parse(buf.slice(0, idx)) as DaemonRequest;
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        seen.push(req);
        let res: DaemonResponse;
        switch (req.op) {
          case 'hello':
            res = { ok: true, op: 'hello', version: '0.2.0', protocol: 1, devices: { keyboards: 1, pointers: 1, uinput: true } };
            break;
          case 'status':
            res = { ok: true, op: 'status', locked: null };
            break;
          case 'seal-status':
            res = {
              ok: true,
              op: 'seal-status',
              seal: state.seal,
              runtime: { dir: '/run/rpchat/policy', mounted: true, readOnly: true, present: true, degraded: [] },
              remote: { configured: true, url: 'https://example.com/chain.json', enabled: true, intervalMinutes: 60, seq: 4, rotations: [], packs: [], removeUnlisted: false, packRefreshMinutes: 360 },
            };
            break;
          case 'seal-policy':
            state.seal = { ...state.seal, sealed: true };
            res = { ok: true, op: 'seal-policy', path: '/etc/rpchat/policy.json', secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/rpchat:policy?secret=JBSWY3DPEHPK3PXP', seal: state.seal, runtime: { dir: '/run/rpchat/policy', mounted: true, readOnly: true, present: true, degraded: [] } };
            break;
          case 'unseal-policy':
            if (req.code !== '123456') res = { ok: false, error: 'that code is not valid', code: 'CODE' };
            else {
              state.seal = { ...DEFAULT_SEAL_INFO };
              res = { ok: true, op: 'unseal-policy', path: '/etc/rpchat/policy.json', removed: req.removePolicy === true };
            }
            break;
          case 'set-policy':
            if (state.seal.sealed && req.code !== '123456') res = { ok: false, error: 'that code is not valid', code: 'CODE' };
            else res = { ok: true, op: 'set-policy', path: '/etc/rpchat/policy.json', replaced: state.seal.sealed };
            break;
          case 'remote-apply':
            state.applied?.push(req.document);
            res = {
              ok: true,
              op: 'remote-apply',
              changed: true,
              applied: 1,
              seq: 5,
              unsealed: false,
              policyHash: 'deadbeef',
              runtime: { dir: '/run/rpchat/policy', mounted: true, readOnly: true, present: true, degraded: [] },
              remote: { configured: true, url: 'https://example.com/chain.json', enabled: true, intervalMinutes: 60, seq: 5, rotations: [], packs: [], removeUnlisted: false, packRefreshMinutes: 360 },
            };
            break;
          default:
            res = { ok: false, error: `unexpected ${req.op}`, code: 'INVALID' };
        }
        conn.write(`${daemonJson(res)}\n`);
      }
    });
  });
  const ready = new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        // Close the live connections first: `server.close` waits for them, and the client's own
        // cleanup runs after this one.
        for (const c of conns) c.destroy();
        server.close(() => resolve());
      }),
  );
  return { ready, seen };
}

describe('SystemIntegration: sealing', () => {
  /** `remote` is only opted into by the test that needs `status().remote`; the rest run without it. */
  async function fixture(opts: { remote?: boolean } = {}) {
    const dir = await tempDir();
    const socket = path.join(dir, 'daemon.sock');
    const state = { seal: { ...DEFAULT_SEAL_INFO }, applied: [] as string[] };
    const daemonFake = sealDaemon(socket, state);
    await daemonFake.ready;
    const file = path.join(dir, 'policy.json');
    await fs.writeFile(file, JSON.stringify(POLICY));
    const cache = new SealCache(path.join(dir, 'sealed-policy.json'));
    const policy = new PolicyWatcher(file, undefined, { runtime: path.join(dir, 'runtime.json'), marker: path.join(dir, 'policy.sealed'), cache });
    const daemon = new DaemonClient({ socketPath: socket, timeoutMs: 2000 });
    cleanups.push(() => daemon.close());
    const system = new SystemIntegration({
      platform: 'linux',
      daemon,
      policy,
      sealCache: cache,
      resourcesDirs: [dir],
      appBin: '/tmp/rpchat',
      homeDir: dir,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      ...(opts.remote ? { remote: { status: async () => ({ active: true, intervalMinutes: 60, seq: 4, packs: [], busy: false }) } as never } : {}),
    });
    return { system, cache, state, seen: daemonFake.seen, file, dir };
  }

  it('hands back the secret once and reports the machine as sealed afterwards', async () => {
    const { system, cache, state } = await fixture();
    expect((await system.status()).policy.seal.sealed).toBe(false);
    state.seal = { ...DEFAULT_SEAL_INFO, sealed: true, mode: 'totp', sealedAt: '2026-09-16T09:00:00Z', policyHash: policyHash(POLICY), residual: ['a root shell the guard does not confine can read the seal'] };
    const sealed = await system.sealPolicy(JSON.stringify(POLICY));
    expect(sealed.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(sealed.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect(sealed.status.policy.seal.sealed).toBe(true);
    expect(sealed.status.policy.seal.residual.length).toBeGreaterThan(0);
    // A sealed machine no longer offers "create the policy": replacing one is a different button.
    expect(sealed.status.policy.canCreate).toBe(false);
    // And the app now remembers the seal, so a wiped /etc does not unmanage it.
    expect((await cache.read())?.policyHash).toBe(policyHash(POLICY));
  });

  it('refuses a wrong code and takes the right one', async () => {
    const { system, state } = await fixture();
    state.seal = { ...DEFAULT_SEAL_INFO, sealed: true };
    await expect(system.replacePolicy(JSON.stringify(POLICY), '000000')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', details: { daemonCode: 'CODE' } });
    await expect(system.replacePolicy(JSON.stringify(POLICY), '123456')).resolves.toBeTruthy();
    await expect(system.unsealPolicy('000000')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(system.unsealPolicy('123456', true)).resolves.toBeTruthy();
  });

  it('drops its cached seal only when a connected daemon says the machine is unsealed', async () => {
    const { system, cache, state, file } = await fixture();
    state.seal = { ...DEFAULT_SEAL_INFO, sealed: true };
    await system.status();
    expect(await cache.read()).not.toBeNull();
    // The policy file disappearing does not clear it — that is the case the cache exists for.
    await fs.rm(file);
    await system.status();
    expect(await cache.read()).not.toBeNull();
    // Only the daemon reporting an unsealed machine does.
    state.seal = { ...DEFAULT_SEAL_INFO };
    await fs.writeFile(file, JSON.stringify(POLICY));
    await system.status();
    expect(await cache.read()).toBeNull();
  });

  it('puts back the empty lists the daemon leaves out of its JSON', async () => {
    const { system, state } = await fixture({ remote: true });
    // An ordinary sealed machine: nothing has ever been tampered with, so serde sends no
    // `tampers` at all. Settings renders these straight, and a missing array there throws during
    // render and blanks the window — the tamper log button in particular used to count one
    // record that was not there, and opening it took the app down.
    state.seal = { ...DEFAULT_SEAL_INFO, sealed: true, residual: ['a root shell the guard does not confine can read the seal'] };
    const status = await system.status();
    expect(status.policy.seal.tampers).toEqual([]);
    expect(status.policy.seal.paths).toEqual([]);
    expect(status.policy.runtime?.degraded).toEqual([]);
    expect(status.remote?.daemon.rotations).toEqual([]);
    expect(status.remote?.daemon.packs).toEqual([]);
    // `residual` was sent, so it survives intact.
    expect(status.policy.seal.residual).toHaveLength(1);
    // And the lines Settings builds from all this can be built.
    expect(keyLine(status.remote!.daemon)).toBeNull();
  });

  it('shows the tampers pushed this session and the seal’s own log once each, oldest first', async () => {
    const { system, state } = await fixture();
    const edited = { at: '2026-09-16T09:00:00Z', kind: 'policy-edited', path: '/etc/rpchat/policy.json', healed: true };
    const removed = { at: '2026-09-16T09:05:00Z', kind: 'policy-removed', path: '/etc/rpchat/policy.json', healed: true };
    // The daemon both records a tamper in the seal and pushes it to the app, so the two sources
    // overlap; the one it could not write to the seal is the reason the app keeps its own list.
    const unrecorded = { at: '2026-09-16T09:10:00Z', kind: 'seal-removed', path: '/var/lib/rpchat/seal.json', healed: false };
    state.seal = { ...DEFAULT_SEAL_INFO, sealed: true, tampers: [edited, removed] };
    system.noteTamper(removed);
    system.noteTamper(unrecorded);
    expect((await system.status()).policy.seal.tampers).toEqual([edited, removed, unrecorded]);
  });

});

describe('remote packs', () => {
  it('decides what to install from what the policy pins', () => {
    const pinned: PackSource = { id: 'luna', url: 'https://x/luna.rppack', version: '1.2.0' };
    expect(packNeedsInstall(pinned, undefined)).toBe(true);
    expect(packNeedsInstall(pinned, { id: 'luna', version: '1.1.0' })).toBe(true);
    expect(packNeedsInstall(pinned, { id: 'luna', version: '1.2.0' })).toBe(false);
    // Without a pinned version an installed pack is left alone rather than re-downloaded.
    const loose: PackSource = { id: 'luna', url: 'https://x/luna.rppack' };
    expect(packNeedsInstall(loose, { id: 'luna', version: '9.9.9' })).toBe(false);
    expect(packNeedsInstall(loose, undefined)).toBe(true);
    expect(packsToRemove([pinned], [{ id: 'luna', version: '1.2.0' }, { id: 'other', version: '1' }])).toEqual(['other']);
  });

  it('spaces the checks out from the policy interval', () => {
    const now = new Date('2026-09-16T10:00:00Z');
    expect(nextCheckDelayMs(60, undefined, now)).toBe(20_000);
    expect(nextCheckDelayMs(60, '2026-09-16T09:30:00Z', now)).toBe(30 * 60_000);
    // A check a minute ago means 59 minutes to wait, not a fresh hour.
    expect(nextCheckDelayMs(60, '2026-09-16T09:59:00Z', now)).toBe(59 * 60_000);
    // An interval that has already passed comes back as the floor, not as zero or a negative.
    expect(nextCheckDelayMs(5, '2026-09-16T09:00:00Z', now)).toBe(20_000);
    expect(nextCheckDelayMs(60, 'not a date', now)).toBe(60 * 60_000);
  });

  async function packFixture(policy: PolicyFile, body: Buffer | string = 'PACK', verify?: (id: string, sha256: string) => boolean) {
    const dir = await tempDir();
    const installed: { id: string; version: string }[] = [];
    const installs: string[] = [];
    const removals: string[] = [];
    const verified: Array<{ id: string; sha256: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.rppack')) return new Response(typeof body === 'string' ? Buffer.from(body) : body, { status: 200 });
      return new Response(JSON.stringify({ version: 1, serial: 1, policy }), { status: 200 });
    }) as unknown as typeof fetch;
    const service = new RemoteConfigService({
      daemon: {
        remoteApply: async () => ({
          changed: false,
          applied: 0,
          seq: 1,
          unsealed: false,
          policyHash: 'x',
          runtime: { dir: '', mounted: false, readOnly: false, present: true, degraded: [] },
          remote: { configured: true, enabled: true, intervalMinutes: 60, seq: 1, rotations: [], packs: [], removeUnlisted: false, packRefreshMinutes: 360 },
        }),
        // Stands in for the daemon: it is the side that holds the key, so the app asks it rather
        // than checking anything itself.
        verifyPack: async (id: string, sha256: string) => {
          verified.push({ id, sha256 });
          if (verify && !verify(id, sha256)) throw new RpError('PERMISSION_DENIED', 'rpchatd refused verify-pack: the pack is not signed by this machine\'s key');
          return true;
        },
      } as never,
      policy: { current: async () => ({ policy }) } as never,
      packs: {
        install: async (source: string) => {
          installs.push(source);
          const id = path.basename(source).split('.')[0]!;
          const view = { packId: id, version: '1.2.0' } as InstalledPackView;
          installed.push({ id, version: view.version });
          return view;
        },
        uninstall: async (id: string) => {
          removals.push(id);
        },
        installed: async () => installed,
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      fetchImpl,
      downloadDir: path.join(dir, 'downloads'),
    });
    cleanups.push(() => service.stop());
    return { service, installs, removals, installed, verified, fetchImpl, dir };
  }

  it('downloads, has the daemon vouch for it, and installs', async () => {
    const body = Buffer.from('a pack file');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
    const { service, installs, verified } = await packFixture({ version: 1, packs: { sources: [{ id: 'luna', url: 'https://example.com/luna.rppack' }] } }, body);
    const statuses = await service.syncPacks();
    // The app hashes and asks; it never decides for itself, because the key is the daemon's.
    expect(verified).toEqual([{ id: 'luna', sha256 }]);
    expect(installs).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 'luna', state: 'installed', installed: '1.2.0' });
  });

  it('does not install a pack the daemon will not vouch for', async () => {
    const { service, installs } = await packFixture(
      { version: 1, packs: { sources: [{ id: 'luna', url: 'https://example.com/luna.rppack' }] } },
      'PACK',
      () => false,
    );
    const statuses = await service.syncPacks();
    expect(installs).toHaveLength(0);
    expect(statuses[0]).toMatchObject({ id: 'luna', state: 'failed' });
    expect(statuses[0]?.error).toMatch(/not signed/);
  });

  it('removes packs the policy does not list when it says so', async () => {
    const { service, removals, installed } = await packFixture({ version: 1, packs: { sources: [{ id: 'luna', url: 'https://example.com/luna.rppack' }], removeUnlisted: true } });
    installed.push({ id: 'stray', version: '1' });
    await service.syncPacks();
    expect(removals).toEqual(['stray']);
  });

  it('leaves everything alone when the policy pins nothing', async () => {
    const { service, installs, removals } = await packFixture({ version: 1 });
    expect(await service.syncPacks()).toEqual([]);
    expect(installs).toHaveLength(0);
    expect(removals).toHaveLength(0);
  });
});

describe('what Settings → System says about the lock', () => {
  const sealed: SealInfo = {
    ...DEFAULT_SEAL_INFO,
    sealed: true,
    sealedAt: '2026-09-16T09:00:00Z',
    totp: { algorithm: 'SHA1', digits: 6, period: 30, window: 1 },
    selfHeal: true,
    immutable: true,
    denyEscapes: true,
    refuseManualStop: true,
  };

  it('describes the lock and the layers that are actually in place', () => {
    expect(sealLine({ ...DEFAULT_SEAL_INFO })).toMatch(/Not locked/);
    const line = sealLine(sealed);
    expect(line).toMatch(/6-digit codes every 30 s/);
    expect(line).toMatch(/restored when edited/);
    expect(line).toMatch(/immutable/);
    // A layer that is not in place is not claimed.
    expect(sealLine({ ...sealed, immutable: false, denyEscapes: false })).not.toMatch(/immutable/);
    // And a machine running on the cached copy says so rather than looking healthy.
    expect(sealLine(sealed, true)).toMatch(/nothing on this machine holds the policy/);
  });

  it('counts the lockout down and says nothing once it has passed', () => {
    const now = new Date('2026-09-16T10:00:00Z');
    expect(lockoutLine(sealed, now)).toBeNull();
    expect(lockoutLine({ ...sealed, lockedUntil: '2026-09-16T10:00:30Z' }, now)).toMatch(/another 30 seconds/);
    expect(lockoutLine({ ...sealed, lockedUntil: '2026-09-16T09:59:00Z' }, now)).toBeNull();
  });

  it('says how the runtime policy filesystem is protected, or that it is not', () => {
    expect(runtimeLine(undefined)).toBeNull();
    expect(runtimeLine({ dir: '/run/rpchat/policy', mounted: true, readOnly: true, present: true, degraded: [] })).toMatch(/read-only filesystem the daemon mounts/);
    expect(runtimeLine({ dir: '/run/rpchat/policy', mounted: false, readOnly: false, present: true, degraded: [] })).toMatch(/a plain directory/);
    expect(runtimeLine({ dir: '/run/rpchat/policy', mounted: true, readOnly: true, present: false, degraded: [] })).toMatch(/No policy is published/);
  });

  it('describes where the policy comes from', () => {
    expect(remoteLine(undefined, undefined)).toMatch(/No Remote Link/);
    const remote = { configured: true, url: 'https://example.com/chain.json', enabled: true, intervalMinutes: 30, seq: 7, key: 'AAAABBBBCCCCDDDD', keyId: 'acme-2026', rotations: [], packs: [], removeUnlisted: false, packRefreshMinutes: 360 };
    expect(remoteLine(remote, { active: true, intervalMinutes: 30, seq: 7, packs: [], busy: false })).toMatch(/every 30 minutes — at link 7 — not fetched yet/);
    expect(remoteLine({ ...remote, seq: 0 }, undefined)).toMatch(/no links applied yet/);
    expect(remoteLine({ ...remote, enabled: false }, undefined)).toMatch(/switched off/);
    // The pinned key is named, shortened, along with any rotation the chain performed.
    expect(keyLine(remote)).toBe('Links must be signed by AAAABBBBCCCC… (acme-2026).');
    expect(keyLine({ ...remote, rotations: ['x'] })).toMatch(/rotated 1 time by the chain itself/);
    expect(keyLine(undefined)).toBeNull();
  });

  it('describes each pinned pack, including the ones that failed', () => {
    expect(packLine({ id: 'luna', url: 'u', state: 'installed', installed: '1.2.0' })).toBe('luna 1.2.0');
    expect(packLine({ id: 'luna', url: 'u', state: 'installed', installed: '1.1.0', wanted: '1.2.0' })).toBe('luna 1.1.0 (the policy pins 1.2.0)');
    expect(packLine({ id: 'luna', url: 'u', state: 'failed', error: 'HTTP 404' })).toBe('luna — failed: HTTP 404');
    expect(packLine({ id: 'luna', url: 'u', state: 'removed' })).toMatch(/no longer lists it/);
  });
});

describe('the rp-policy-chain command-line tool', () => {
  /**
   * The tool an administrator can run on a build server instead of using the app. It has its own
   * copy of the canonicalisation — it is meant to be readable as the specification — so it is held
   * to the same pinned vector as the app and the daemon. All three or none.
   */
  it('produces the same bytes as the app and the daemon', async () => {
    const tool = (await import('../../../../../scripts/rp-policy-chain.mjs')) as {
      canonicalJson(value: unknown): string;
      linkMessage(value: unknown): Buffer;
      linkHash(value: unknown): string;
      packMessage(id: string, version: string | undefined, sha256: string): string;
    };
    const link = { seq: 1, prev: '', policy: { version: 1, managedBy: 'Acme IT' } };
    expect(tool.canonicalJson(link)).toBe(canonicalJson(link));
    expect(tool.linkMessage(link).toString('utf8')).toBe('rpchat-chain/v1\n{"policy":{"managedBy":"Acme IT","version":1},"prev":"","seq":1}');
    expect(tool.linkHash(link)).toBe('c0b2270f827b16d302b19afec2713a349c4d4ec02814e6fbbc6fcb3cbd7795e6');
    expect(tool.packMessage('luna', '1.2.0', 'AABB')).toBe('rpchat-pack/v1\nluna\n1.2.0\naabb');
    // The `signature` member is excluded on this side too.
    expect(tool.linkMessage({ ...link, signature: { alg: 'ed25519', value: 'x' } })).toEqual(tool.linkMessage(link));
  });
});
