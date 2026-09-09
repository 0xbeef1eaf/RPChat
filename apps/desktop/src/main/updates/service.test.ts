import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PolicyFile, UpdateStatus } from '@rp/shared';
import { RpError } from '@rp/shared';
import { defaultSettings, mergeSettings } from '@rp/core';
import { DEFAULT_INITIAL_DELAY_MS, TOKEN_FILENAME, TOKEN_REJECTED_MESSAGE, UpdateService, describeUpdateError, detectPackaging, plainReleaseNotes } from './service.js';
import type { SafeStorageLike, UpdateInfoLike, UpdateServiceDeps, UpdaterLike } from './service.js';

const INFO: UpdateInfoLike = { version: '0.1.42', releaseNotes: '<p>Fixes &amp; <b>features</b></p><ul><li>one</li></ul>', releaseDate: '2026-09-01T00:00:00.000Z' };

/** electron-updater stand-in: same methods/events, scripted outcome. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  logger = null;
  feeds: unknown[] = [];
  checks = 0;
  downloads = 0;
  installs: unknown[] = [];
  outcome: { available: boolean } | { error: Error } = { available: false };

  setFeedURL(options: unknown): void {
    this.feeds.push(options);
  }

  async checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike }> {
    this.checks += 1;
    this.emit('checking-for-update');
    await Promise.resolve();
    if ('error' in this.outcome) {
      this.emit('error', this.outcome.error);
      throw this.outcome.error;
    }
    if (!this.outcome.available) {
      this.emit('update-not-available', { ...INFO, version: '0.1.0' });
      return { isUpdateAvailable: false, updateInfo: { ...INFO, version: '0.1.0' } };
    }
    this.emit('update-available', INFO);
    if (this.autoDownload) setTimeout(() => void this.downloadUpdate(), 0);
    return { isUpdateAvailable: true, updateInfo: INFO };
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloads += 1;
    await new Promise((r) => setTimeout(r, 1));
    this.emit('download-progress', { percent: 40, transferred: 40, total: 100 });
    await Promise.resolve();
    this.emit('update-downloaded', { ...INFO, downloadedFile: '/tmp/rp-code.AppImage' });
    return ['/tmp/rp-code.AppImage'];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function fakeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC(${Buffer.from(s, 'utf8').toString('base64')})`, 'utf8'),
    decryptString: (b) => {
      const m = /^ENC\((.*)\)$/.exec(b.toString('utf8'));
      if (!m) throw new Error('not encrypted by this fake');
      return Buffer.from(m[1]!, 'base64').toString('utf8');
    },
  };
}

interface Harness {
  service: UpdateService;
  updater: FakeUpdater;
  settings: AppSettings;
  policy: { policy: PolicyFile | null };
  logs: string[];
  dir: string;
  statuses: UpdateStatus[];
}

function harness(overrides: Partial<UpdateServiceDeps> & { policy?: { policy: PolicyFile | null }; settings?: Partial<AppSettings['updates']>; encryption?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-upd-'));
  const updater = new FakeUpdater();
  const settings = defaultSettings();
  settings.updates = { ...settings.updates, ...(overrides.settings ?? {}) };
  const policy = overrides.policy ?? { policy: null };
  const logs: string[] = [];
  const log = (level: string) => (...args: unknown[]) => logs.push(`${level}: ${args.map(String).join(' ')}`);
  const { policy: _p, settings: _s, encryption, ...rest } = overrides;
  const deps: UpdateServiceDeps = {
    updater,
    appVersion: '0.1.7',
    isPackaged: true,
    appImagePath: '/home/alice/Apps/rp-code.AppImage',
    execPath: '/tmp/.mount_rp-codeXYZ/rp-code',
    userDataDir: dir,
    settings: { get: async () => settings },
    policy: { current: async () => policy },
    safeStorage: fakeSafeStorage(encryption ?? true),
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    isWritable: async () => true,
    initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
    ...rest,
  };
  const service = new UpdateService(deps);
  const statuses: UpdateStatus[] = [];
  service.subscribe((s) => statuses.push(s));
  return { service, updater, settings, policy, logs, dir, statuses };
}

const dirs: string[] = [];
function tmp(h: Harness): Harness {
  dirs.push(h.dir);
  return h;
}

/** Let pending microtasks and the fake's zero-delay timers run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

describe('UpdateService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports unsupported in development and never touches the updater', async () => {
    const h = tmp(harness({ isPackaged: false, appImagePath: undefined }));
    const status = await h.service.status();
    expect(status).toMatchObject({ state: 'unsupported', packaging: 'dev', canInstallInPlace: false, tokenPresent: false, tokenStorage: 'none', currentVersion: '0.1.7' });
    expect(status.reason).toMatch(/packaged builds/);
    expect(h.updater.listenerCount('error')).toBe(0);
    await expect(h.service.check()).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
    await expect(h.service.setToken('ghp_x')).rejects.toBeInstanceOf(RpError);
    h.service.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_DELAY_MS * 2);
    expect(h.updater.checks).toBe(0);
    expect(h.updater.feeds).toEqual([]);
  });

  it('without a token reports no-token, refuses manual checks and never schedules one', async () => {
    const h = tmp(harness());
    expect(await h.service.status()).toMatchObject({ state: 'no-token', packaging: 'appimage', canInstallInPlace: true, tokenPresent: false });
    await expect(h.service.check()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    h.service.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_DELAY_MS + 7 * 3_600_000);
    expect(h.updater.checks).toBe(0);
    expect(h.updater.feeds).toEqual([]);
    h.service.stop();
  });

  it('stores the token encrypted through the keyring, configures the feed and reloads it in a new instance', async () => {
    const h = tmp(harness());
    const status = await h.service.setToken('  github_pat_ABC123  ');
    expect(status).toMatchObject({ state: 'idle', tokenPresent: true, tokenStorage: 'keyring' });
    const file = path.join(h.dir, TOKEN_FILENAME);
    const raw = fs.readFileSync(file);
    expect(raw.subarray(0, 6).toString()).toBe('RPTK1\n');
    expect(raw.toString('utf8')).not.toContain('github_pat_ABC123');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(h.updater.feeds).toEqual([{ provider: 'github', owner: '0xbeef1eaf', repo: 'llm-rp-code', private: true, token: 'github_pat_ABC123', releaseType: 'release' }]);
    expect(h.logs.join('\n')).not.toContain('github_pat_ABC123');
    // A fresh service (next launch) reads the file back and configures the feed before checking.
    const again = tmp(harness({ userDataDir: h.dir }));
    dirs.pop();
    expect(await again.service.status()).toMatchObject({ state: 'idle', tokenPresent: true, tokenStorage: 'keyring' });
    await again.service.check();
    expect(again.updater.feeds).toHaveLength(1);
    expect((again.updater.feeds[0] as { token: string }).token).toBe('github_pat_ABC123');
    expect(again.updater.checks).toBe(1);
  });

  it('falls back to a 0600 plaintext file without a keyring and warns once', async () => {
    const h = tmp(harness({ encryption: false }));
    await h.service.setToken('tok-one');
    await h.service.setToken('tok-two');
    const file = path.join(h.dir, TOKEN_FILENAME);
    expect(fs.readFileSync(file, 'utf8')).toBe('RPTK0\ntok-two');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(h.logs.filter((l) => /no OS keyring/.test(l))).toHaveLength(1);
    expect(await h.service.status()).toMatchObject({ tokenPresent: true, tokenStorage: 'file' });
    // Encrypted file but no keyring on this launch → treated as absent, with a hint.
    fs.writeFileSync(file, Buffer.concat([Buffer.from('RPTK1\n'), Buffer.from('ENC(xyz)')]));
    const later = tmp(harness({ userDataDir: h.dir, encryption: false }));
    dirs.pop();
    expect(await later.service.status()).toMatchObject({ state: 'no-token', tokenPresent: false });
    expect(later.logs.join('\n')).toMatch(/keyring is unavailable/);
  });

  it('rejects empty, whitespace-only and oversized tokens', async () => {
    const h = tmp(harness());
    await expect(h.service.setToken('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.service.setToken('   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.service.setToken('a'.repeat(401))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(h.service.setToken('with space')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fs.existsSync(path.join(h.dir, TOKEN_FILENAME))).toBe(false);
  });

  it('checks ~30 s after start and then every checkIntervalHours while automatic is on', async () => {
    const h = tmp(harness({ settings: { automatic: true, checkIntervalHours: 2 } }));
    await h.service.setToken('tok');
    h.service.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_DELAY_MS - 1000);
    expect(h.updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 5000);
    expect(h.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.updater.checks).toBe(2);
    expect(await h.service.status()).toMatchObject({ state: 'up-to-date', latestVersion: '0.1.0' });
    expect((await h.service.status()).checkedAt).toBeDefined();
    h.settings.updates.automatic = false;
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(h.updater.checks).toBe(2);
    // Manual checks are always allowed with a token.
    await h.service.check();
    expect(h.updater.checks).toBe(3);
    h.service.stop();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(h.updater.checks).toBe(3);
  });

  it('does not schedule when automatic is off, and honours refreshSchedule after the toggle', async () => {
    const h = tmp(harness({ settings: { automatic: false } }));
    await h.service.setToken('tok');
    h.service.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_DELAY_MS + 60_000);
    expect(h.updater.checks).toBe(0);
    h.settings.updates.automatic = true;
    h.service.refreshSchedule();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.updater.checks).toBe(1);
    h.service.stop();
  });

  it('walks available → downloading → ready with progress and installs with quitAndInstall(false, true)', async () => {
    const h = tmp(harness({ settings: { automatic: false } }));
    await h.service.setToken('tok');
    h.updater.outcome = { available: true };
    h.statuses.length = 0;
    const afterCheck = await h.service.check();
    expect(h.updater.autoDownload).toBe(false);
    expect(afterCheck).toMatchObject({ state: 'available', latestVersion: '0.1.42', releaseDate: '2026-09-01T00:00:00.000Z' });
    expect(afterCheck.releaseNotes).toBe('Fixes & features\none');
    await expect(h.service.install()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const downloading = await h.service.download();
    expect(downloading).toMatchObject({ state: 'downloading', progressPercent: 0 });
    await settle();
    const ready = await h.service.status();
    expect(ready).toMatchObject({ state: 'ready', progressPercent: 100, latestVersion: '0.1.42' });
    expect(h.updater.downloads).toBe(1);
    // A second download while ready is a no-op.
    expect((await h.service.download()).state).toBe('ready');
    expect(h.updater.downloads).toBe(1);
    await h.service.install();
    expect(h.updater.installs).toEqual([[false, true]]);
    await settle();
    const seen = h.statuses.map((s) => `${s.state}${s.progressPercent !== undefined ? `:${s.progressPercent}` : ''}`);
    expect(seen).toEqual(['checking', 'available', 'downloading:0', 'downloading:40', 'ready:100']);
  });

  it('downloads automatically when automatic checks are on and the AppImage is writable', async () => {
    const h = tmp(harness({ settings: { automatic: true } }));
    await h.service.setToken('tok');
    h.updater.outcome = { available: true };
    const result = await h.service.check();
    expect(h.updater.autoDownload).toBe(true);
    expect(result.state).toBe('downloading');
    await settle();
    expect(await h.service.status()).toMatchObject({ state: 'ready', progressPercent: 100 });
    expect(h.updater.downloads).toBe(1);
  });

  it('never downloads on a package install or a read-only AppImage; explains and points at the release page', async () => {
    const deb = tmp(harness({ appImagePath: undefined, execPath: '/opt/rp-code/rp-code', settings: { automatic: true } }));
    await deb.service.setToken('tok');
    deb.updater.outcome = { available: true };
    const status = await deb.service.check();
    expect(deb.updater.autoDownload).toBe(false);
    expect(status).toMatchObject({ state: 'available', packaging: 'deb', canInstallInPlace: false, latestVersion: '0.1.42' });
    expect(status.reason).toMatch(/release page/);
    await expect(deb.service.download()).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
    await settle();
    expect(deb.updater.downloads).toBe(0);

    const readOnly = tmp(harness({ isWritable: async (p) => !p.endsWith('.AppImage'), settings: { automatic: true } }));
    await readOnly.service.setToken('tok');
    readOnly.updater.outcome = { available: true };
    const ro = await readOnly.service.check();
    expect(readOnly.updater.autoDownload).toBe(false);
    expect(ro).toMatchObject({ state: 'available', packaging: 'appimage', canInstallInPlace: false });
    expect(ro.reason).toMatch(/not writable/);
    await expect(readOnly.service.download()).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
  });

  it('is disabled by policy: state disabled, managed, and check() refused', async () => {
    const policy: PolicyFile = { version: 1, settings: { updates: { enabled: false } } };
    const h = tmp(harness({ policy: { policy }, settings: { automatic: true } }));
    await h.service.setToken('tok');
    expect(await h.service.status()).toMatchObject({ state: 'disabled', managed: true, tokenPresent: true });
    await expect(h.service.check()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    h.service.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_DELAY_MS + 3_600_000);
    expect(h.updater.checks).toBe(0);
    // `automatic: false` from policy only pins the toggle; manual checks still work.
    h.policy.policy = { version: 1, settings: { updates: { automatic: false } } };
    expect(await h.service.status()).toMatchObject({ state: 'idle', managed: true });
    await vi.advanceTimersByTimeAsync(7 * 3_600_000);
    expect(h.updater.checks).toBe(0);
    await h.service.check();
    expect(h.updater.checks).toBe(1);
    h.service.stop();
  });

  it('maps 401/403 to the token-rejected message and other failures to error', async () => {
    const h = tmp(harness({ settings: { automatic: false } }));
    await h.service.setToken('tok');
    const unauthorized = Object.assign(new Error('401 Unauthorized'), { statusCode: 401 });
    h.updater.outcome = { error: unauthorized };
    const status = await h.service.check();
    expect(status).toMatchObject({ state: 'error', error: TOKEN_REJECTED_MESSAGE });
    expect(status.checkedAt).toBeDefined();
    h.updater.outcome = { error: new Error('getaddrinfo ENOTFOUND github.com') };
    expect((await h.service.check()).error).toMatch(/Cannot reach GitHub/);
    expect(describeUpdateError(Object.assign(new Error('HttpError'), { statusCode: 403 }))).toBe(TOKEN_REJECTED_MESSAGE);
    expect(describeUpdateError(new Error('HttpError: 404 Not Found'))).toMatch(/404/);
    // Recovering: a good check clears the error.
    h.updater.outcome = { available: false };
    const recovered = await h.service.check();
    expect(recovered.state).toBe('up-to-date');
    expect(recovered.error).toBeUndefined();
  });

  it('runs one check at a time', async () => {
    const h = tmp(harness({ settings: { automatic: false } }));
    await h.service.setToken('tok');
    const [a, b] = await Promise.all([h.service.check(), h.service.check()]);
    expect(h.updater.checks).toBe(1);
    expect(a.state).toBe('up-to-date');
    expect(b.state).toBe('up-to-date');
  });

  it('setToken(null) removes the file and returns to no-token', async () => {
    const h = tmp(harness());
    await h.service.setToken('tok');
    const file = path.join(h.dir, TOKEN_FILENAME);
    expect(fs.existsSync(file)).toBe(true);
    expect(await h.service.setToken(null)).toMatchObject({ state: 'no-token', tokenPresent: false, tokenStorage: 'none' });
    expect(fs.existsSync(file)).toBe(false);
    await expect(h.service.check()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await h.service.setToken(null)).toMatchObject({ state: 'no-token' });
  });

  it('detects packaging and normalises release notes', () => {
    expect(detectPackaging({ isPackaged: false, execPath: '/x' })).toBe('dev');
    expect(detectPackaging({ isPackaged: true, appImagePath: '/a/b.AppImage', execPath: '/tmp/.mount_x/rp-code' })).toBe('appimage');
    expect(detectPackaging({ isPackaged: true, execPath: '/opt/rp-code/rp-code' })).toBe('deb');
    expect(detectPackaging({ isPackaged: true, execPath: '/usr/lib/rp-code/rp-code' })).toBe('deb');
    expect(detectPackaging({ isPackaged: true, execPath: '/home/alice/linux-unpacked/rp-code' })).toBe('other');
    expect(plainReleaseNotes(null)).toBeUndefined();
    expect(plainReleaseNotes('')).toBeUndefined();
    expect(plainReleaseNotes([{ version: '1.2.0', note: 'a<br>b' }, { version: '1.1.0', note: null }])).toBe('1.2.0: a\nb\n1.1.0:');
    expect(mergeSettings({ providers: [] }).updates).toEqual({ automatic: true, checkIntervalHours: 6 });
    expect(mergeSettings({ updates: { automatic: false } } as Partial<AppSettings>).updates).toEqual({ automatic: false, checkIntervalHours: 6 });
  });
});
