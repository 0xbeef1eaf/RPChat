/**
 * In-place application updates from the public GitHub releases of this repository, driven by
 * `electron-updater` (docs: README "Updating"). The updater is injected (`UpdaterLike`) so the
 * state machine is unit-testable without Electron. The release feed is public: no credentials
 * are stored or needed.
 *
 * - AppImage in a writable location → download and swap in place; system install
 *   (`/opt/rpchat/current`, docs/system-integration.md) → download, then the `rpchatd` daemon
 *   verifies and swaps the tree in (`apply-update`) and the app relaunches; `.deb` and other
 *   layouts → check only, the UI links to the release page. Development runs never touch the
 *   updater.
 * - `settings.updates` (automatic checks, interval) and the policy file (`updates.enabled`,
 *   `updates.automatic`) decide whether background checks run; a manual check is always
 *   allowed unless policy has disabled updates.
 */
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { AppSettings, PolicyFile, UpdatePackaging, UpdateState, UpdateStatus } from '@rp/shared';
import { RpError, UPDATE_REPO } from '@rp/shared';
import type { Logger } from '@rp/core';

export const FEED_FORBIDDEN_MESSAGE = 'GitHub refused the release feed (the repository is not public, or the request was rate-limited)';
/** First check ~30 s after launch so startup stays snappy. */
export const DEFAULT_INITIAL_DELAY_MS = 30_000;
/** A settings change re-evaluates the schedule shortly after. */
const RESCHEDULE_DELAY_MS = 2_000;
const MIN_INTERVAL_MS = 15 * 60_000;

export interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
  releaseDate?: string;
  releaseName?: string | null;
  /** `latest-linux.yml` `files`: the per-file checksum (base64 SHA-512) the daemon verifies against. */
  files?: Array<{ url: string; sha512: string; size?: number }>;
  /** Deprecated top-level checksum of the first file (older manifests). */
  sha512?: string;
}

/** `update-downloaded` payload: the update info plus where the file landed. */
export interface UpdateDownloadedLike extends UpdateInfoLike {
  downloadedFile?: string;
}

/** What the daemon needs to apply a downloaded update. */
export interface DownloadedUpdate {
  file: string;
  version: string;
  sha512: string;
}

export interface ProgressLike {
  percent: number;
  transferred?: number;
  total?: number;
}

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message: string): void;
}

/** The subset of electron-updater's `AppUpdater` the service uses (`autoUpdater` satisfies it). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: UpdaterLogger | null;
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; releaseType?: 'release' | 'prerelease' | 'draft' }): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateDownloadedLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: ProgressLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** What a system install's daemon reports when asked whether it can apply updates. */
export interface SystemInstallAvailability {
  daemonConnected: boolean;
  /** The daemon answers `status.install` (knows `apply-update`); false for an older daemon. */
  daemonSupportsUpdates: boolean;
  current?: string;
  previous?: string;
}

/**
 * The system install's side of updating (engine.ts wires it to the `DaemonClient` and Electron):
 * present only when the app runs from `/opt/rpchat/current`.
 */
export interface SystemInstallDeps {
  /** The unpacked app directory (`/opt/rpchat/current`). */
  dir: string;
  available(): Promise<SystemInstallAvailability>;
  applyUpdate(input: DownloadedUpdate): Promise<{ version: string; restartDaemon: boolean }>;
  /** Wait for the daemon to answer `hello` again after it restarted itself; resolves with whether it did in time. */
  waitForDaemon(timeoutMs: number): Promise<boolean>;
  /** `app.relaunch({ execPath: <dir>/rpchat })` + quit (through the authorised-quit path). */
  relaunch(): void;
}

/** How long to wait for the daemon after it restarted itself before relaunching anyway. */
export const DAEMON_RESTART_WAIT_MS = 30_000;

export interface UpdateServiceDeps {
  updater: UpdaterLike;
  /** Present when running from the system install: updates are applied by the daemon. */
  systemInstall?: SystemInstallDeps;
  appVersion: string;
  /** `app.isPackaged`; false → `unsupported`, the updater is never touched. */
  isPackaged: boolean;
  /** `process.env.APPIMAGE` when running as an AppImage. */
  appImagePath?: string;
  execPath: string;
  settings: { get(): Promise<AppSettings> };
  policy: { current(): Promise<{ policy: PolicyFile | null }> };
  logger: Logger;
  now?: () => Date;
  /** Override for tests (root can write anywhere, so a real `fs.access` proves nothing there). */
  isWritable?: (target: string) => Promise<boolean>;
  initialDelayMs?: number;
  /**
   * Runs right before `quitAndInstall`: the restart is an authorised quit even when the policy
   * forbids quitting, and the daemon's keepalive registration is dropped so it does not relaunch
   * the old binary while the updater starts the new one. A failure is logged, not fatal.
   */
  beforeRestart?: () => Promise<void>;
}

type InternalState = Extract<UpdateState, 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'>;

type Snapshot = Pick<UpdateStatus, 'latestVersion' | 'releaseNotes' | 'releaseDate' | 'progressPercent' | 'error' | 'checkedAt'> & { state: InternalState };

async function defaultIsWritable(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pure: how the running binary was installed (`system` when the system-install deps are wired, i.e. the executable runs from `/opt/rpchat/current`). */
export function detectPackaging(deps: Pick<UpdateServiceDeps, 'isPackaged' | 'appImagePath' | 'execPath' | 'systemInstall'>): UpdatePackaging {
  if (!deps.isPackaged) return 'dev';
  if (deps.systemInstall) return 'system';
  if (deps.appImagePath) return 'appimage';
  const exec = deps.execPath.replace(/\\/g, '/');
  if (exec.startsWith('/opt/') || exec.startsWith('/usr/')) return 'deb';
  return 'other';
}

/**
 * Pure: the checksum of the AppImage in an update manifest — the `files` entry whose URL ends in
 * `.AppImage`, else the first file, else the deprecated top-level `sha512`. Empty when none.
 */
export function appImageSha512(info: Pick<UpdateInfoLike, 'files' | 'sha512'>): string {
  const files = info.files ?? [];
  const appImage = files.find((f) => /\.appimage$/i.test(f.url));
  return (appImage ?? files[0])?.sha512 ?? info.sha512 ?? '';
}

/** Pure: the record `install()` hands to the daemon, or null when the event lacks the file or checksum. */
export function downloadedUpdate(info: UpdateDownloadedLike): DownloadedUpdate | null {
  const sha512 = appImageSha512(info);
  if (!info.downloadedFile || !sha512 || !info.version) return null;
  return { file: info.downloadedFile, version: info.version, sha512 };
}

/** Pure: release notes as plain text (the GitHub provider hands over HTML or a per-version list). */
export function plainReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (!notes) return undefined;
  const text = typeof notes === 'string' ? notes : notes.map((n) => `${n.version}: ${n.note ?? ''}`).join('\n');
  const stripped = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped.length > 0 ? stripped.slice(0, 4000) : undefined;
}

/** Pure: user-facing text for an updater failure. */
export function describeUpdateError(err: unknown): string {
  const status = typeof err === 'object' && err !== null && 'statusCode' in err ? Number((err as { statusCode: unknown }).statusCode) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message)) return FEED_FORBIDDEN_MESSAGE;
  if (status === 404 || /\b404\b/.test(message)) return 'Release feed not found (404): the repository has no releases, or the latest release has no latest-linux.yml';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR/i.test(message)) return `Cannot reach GitHub: ${message}`;
  return message.length > 0 ? message.slice(0, 500) : 'Update check failed';
}

export class UpdateService {
  readonly packaging: UpdatePackaging;
  private readonly isWritable: (target: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private state: InternalState = 'idle';
  private latestVersion: string | undefined;
  private releaseNotes: string | undefined;
  private releaseDate: string | undefined;
  private progressPercent: number | undefined;
  private error: string | undefined;
  private checkedAt: string | undefined;
  private canInstall: boolean | undefined;
  /** System install: what `update-downloaded` reported, for `install()`. */
  private downloaded: DownloadedUpdate | null = null;
  private feedSet = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;
  private inflightCheck: Promise<UpdateStatus> | undefined;
  /** Serialises listener notifications so they arrive in transition order. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UpdateServiceDeps) {
    this.packaging = detectPackaging(deps);
    this.isWritable = deps.isWritable ?? defaultIsWritable;
    this.now = deps.now ?? (() => new Date());
    if (this.packaging !== 'dev') this.attach();
  }

  // ---- public API ---------------------------------------------------------

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async status(): Promise<UpdateStatus> {
    return this.resolveStatus(this.snapshot());
  }

  /** The updater-driven part of the status, captured synchronously so quick transitions are not lost. */
  private snapshot(): Snapshot {
    return { state: this.state, latestVersion: this.latestVersion, releaseNotes: this.releaseNotes, releaseDate: this.releaseDate, progressPercent: this.progressPercent, error: this.error, checkedAt: this.checkedAt };
  }

  private async resolveStatus(snap: Snapshot): Promise<UpdateStatus> {
    const [policyState, system] = await Promise.all([this.deps.policy.current(), this.systemAvailability()]);
    const canInstallInPlace = system ? system.daemonConnected && system.daemonSupportsUpdates : await this.canInstallInPlace();
    const policy = policyState.policy?.settings?.updates;
    const managed = Boolean(policy && (policy.enabled !== undefined || policy.automatic !== undefined));
    const status: UpdateStatus = {
      state: snap.state,
      currentVersion: this.deps.appVersion,
      packaging: this.packaging,
      canInstallInPlace,
      managed,
    };
    if (system && this.deps.systemInstall) {
      status.systemInstall = { dir: this.deps.systemInstall.dir, daemonConnected: system.daemonConnected, daemonSupportsUpdates: system.daemonSupportsUpdates };
      if (system.current !== undefined) status.systemInstall.current = system.current;
      if (system.previous !== undefined) status.systemInstall.previous = system.previous;
    }
    if (snap.latestVersion !== undefined) status.latestVersion = snap.latestVersion;
    if (snap.releaseNotes !== undefined) status.releaseNotes = snap.releaseNotes;
    if (snap.releaseDate !== undefined) status.releaseDate = snap.releaseDate;
    if (snap.progressPercent !== undefined) status.progressPercent = snap.progressPercent;
    if (snap.error !== undefined) status.error = snap.error;
    if (snap.checkedAt !== undefined) status.checkedAt = snap.checkedAt;
    if (this.packaging === 'dev') {
      status.state = 'unsupported';
      status.reason = 'Updates are only available in packaged builds.';
    } else if (policy?.enabled === false) {
      status.state = 'disabled';
      status.reason = 'Update checks are switched off by the system policy on this machine.';
    } else if (this.packaging === 'system') {
      if (!system?.daemonConnected) status.reason = 'Updates are applied by the rpchat system service (rpchatd), which is not connected right now.';
      else if (!system.daemonSupportsUpdates) status.reason = 'The installed rpchat system service is too old to apply updates; run the installer once more (Settings → System → Install system integration…).';
      else status.reason = 'Updates are applied by the rpchat system service: no password prompt, and the previous version is kept for rollback.';
    } else if (this.packaging === 'deb') {
      status.reason = 'Installed from a package: new releases are announced here; install the .deb from the release page.';
    } else if (this.packaging === 'other') {
      status.reason = 'This build is not an AppImage; releases can be checked but not installed in place.';
    } else if (!canInstallInPlace) {
      status.reason = `The AppImage (${this.deps.appImagePath ?? ''}) is not writable, so it cannot replace itself. Move it to a folder you own to update in place.`;
    }
    return status;
  }

  /** Arm the background schedule (packaged builds only). Idempotent. */
  start(): void {
    if (this.packaging === 'dev' || this.started || this.stopped) return;
    this.started = true;
    this.arm(this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  }

  /** Settings changed (interval / automatic toggle): re-evaluate the schedule soon. */
  refreshSchedule(): void {
    if (!this.started || this.stopped) return;
    this.arm(RESCHEDULE_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Manual check. Throws when updates are unsupported or disabled by policy. */
  async check(): Promise<UpdateStatus> {
    await this.assertAllowed();
    if (this.inflightCheck) return this.inflightCheck;
    this.inflightCheck = this.runCheck().finally(() => {
      this.inflightCheck = undefined;
    });
    return this.inflightCheck;
  }

  /** Explicit download of an available update (AppImage in a writable location, or a system install with its daemon connected). */
  async download(): Promise<UpdateStatus> {
    await this.assertAllowed();
    if (!(await this.canInstallInPlace())) {
      if (this.packaging === 'system') throw new RpError('CAPABILITY_FAILED', 'The rpchat system service (rpchatd) is not connected or cannot apply updates; it installs updates for a system install.');
      throw new RpError('CAPABILITY_FAILED', this.packaging === 'deb' ? 'Package installs are notified only: download the .deb from the release page.' : 'This build cannot replace itself; download the AppImage from the release page.');
    }
    if (this.state === 'downloading' || this.state === 'ready' || this.state === 'installing') return this.status();
    if (this.state !== 'available') throw new RpError('INVALID_ARGUMENT', 'No update is available to download; check for updates first.');
    this.setState('downloading', { progressPercent: 0 });
    // Progress and completion arrive as updater events; a rejection lands in `fail`.
    void this.deps.updater.downloadUpdate().catch((err: unknown) => this.fail(err));
    return this.status();
  }

  /**
   * Quit and relaunch into the downloaded update. AppImage: `quitAndInstall`. System install:
   * the daemon verifies and swaps the downloaded file in (`apply-update`), the app waits for the
   * daemon when it restarted itself, then relaunches from `/opt/rpchat/current`. A failure
   * leaves the update `ready` with the error shown, so it can be retried.
   */
  async install(): Promise<void> {
    await this.assertAllowed();
    if (this.state === 'installing') return;
    if (this.state !== 'ready') throw new RpError('INVALID_ARGUMENT', 'No downloaded update to install.');
    if (this.packaging === 'system' && this.deps.systemInstall) return this.installThroughDaemon(this.deps.systemInstall);
    this.deps.logger.info(`[updates] installing ${this.latestVersion ?? 'update'} and restarting`);
    if (this.deps.beforeRestart) await this.deps.beforeRestart().catch((err: unknown) => this.deps.logger.warn('[updates] pre-restart hook failed', err));
    this.deps.updater.quitAndInstall(false, true);
  }

  private async installThroughDaemon(system: SystemInstallDeps): Promise<void> {
    const update = this.downloaded;
    if (!update) throw new RpError('CAPABILITY_FAILED', 'The downloaded update has no file path or checksum to hand to the system service; check for updates again.');
    this.setState('installing', { error: undefined });
    this.deps.logger.info(`[updates] asking rpchatd to install ${update.version} from ${update.file}`);
    let result: { version: string; restartDaemon: boolean };
    try {
      result = await system.applyUpdate(update);
    } catch (err) {
      const text = `Applying the update failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
      this.deps.logger.warn(`[updates] ${text}`);
      this.setState('ready', { error: text });
      throw err instanceof RpError ? err : new RpError('CAPABILITY_FAILED', text);
    }
    this.deps.logger.info(`[updates] rpchatd installed ${result.version}${result.restartDaemon ? '; the daemon restarts itself' : ''}`);
    if (result.restartDaemon) {
      const back = await system.waitForDaemon(DAEMON_RESTART_WAIT_MS);
      if (back) this.deps.logger.info('[updates] rpchatd is back after its restart');
      else this.deps.logger.warn(`[updates] rpchatd did not come back within ${DAEMON_RESTART_WAIT_MS / 1000} s; relaunching anyway`);
    }
    if (this.deps.beforeRestart) await this.deps.beforeRestart().catch((err: unknown) => this.deps.logger.warn('[updates] pre-restart hook failed', err));
    this.deps.logger.info(`[updates] relaunching from ${system.dir}`);
    system.relaunch();
  }

  // ---- internals ----------------------------------------------------------

  private attach(): void {
    const u = this.deps.updater;
    u.allowPrerelease = false;
    u.autoDownload = false;
    u.on('checking-for-update', () => this.setState('checking', { error: undefined }));
    u.on('update-available', (info) => {
      this.checkedAt = this.now().toISOString();
      this.setState('available', {
        latestVersion: info.version,
        releaseNotes: plainReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
        progressPercent: undefined,
        error: undefined,
      });
      this.deps.logger.info(`[updates] ${info.version} is available (current ${this.deps.appVersion})`);
    });
    u.on('update-not-available', (info) => {
      this.checkedAt = this.now().toISOString();
      this.setState('up-to-date', { latestVersion: info?.version ?? this.deps.appVersion, error: undefined, progressPercent: undefined });
    });
    u.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.setState('downloading', { progressPercent: percent });
    });
    u.on('update-downloaded', (info) => {
      this.downloaded = downloadedUpdate(info);
      if (this.packaging === 'system' && !this.downloaded) this.deps.logger.warn(`[updates] ${info.version} downloaded but the event carries no file path or checksum; the system service cannot apply it`);
      this.setState('ready', { latestVersion: info.version ?? this.latestVersion, progressPercent: 100, error: undefined });
      this.deps.logger.info(`[updates] ${info.version} downloaded; restart to install`);
    });
    u.on('error', (err) => this.fail(err));
  }

  private async assertAllowed(): Promise<void> {
    if (this.packaging === 'dev') throw new RpError('CAPABILITY_FAILED', 'Updates are only available in packaged builds.');
    if (await this.disabledByPolicy()) throw new RpError('PERMISSION_DENIED', 'Update checks are switched off by the system policy on this machine.');
    this.applyFeed();
  }

  private async disabledByPolicy(): Promise<boolean> {
    return (await this.deps.policy.current()).policy?.settings?.updates?.enabled === false;
  }

  private applyFeed(): void {
    if (this.feedSet) return;
    this.deps.updater.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo, releaseType: 'release' });
    this.feedSet = true;
  }

  private async runCheck(): Promise<UpdateStatus> {
    const [settings, canInstall] = await Promise.all([this.deps.settings.get(), this.canInstallInPlace()]);
    this.deps.updater.autoDownload = Boolean(settings.updates.automatic) && canInstall;
    this.setState('checking', { error: undefined });
    try {
      const result = await this.deps.updater.checkForUpdates();
      if (result === null) {
        // electron-updater returns null when it considers the updater inactive (unpackaged).
        this.checkedAt = this.now().toISOString();
        this.setState('up-to-date', { latestVersion: this.deps.appVersion });
      } else if (result.isUpdateAvailable && this.deps.updater.autoDownload && this.state === 'available') {
        // autoDownload starts the transfer right after `update-available`; reflect it before progress arrives.
        this.setState('downloading', { progressPercent: 0 });
      }
    } catch (err) {
      this.fail(err);
    }
    return this.status();
  }

  private fail(err: unknown): void {
    const text = describeUpdateError(err);
    this.checkedAt = this.now().toISOString();
    this.deps.logger.warn(`[updates] ${text}`);
    this.setState('error', { error: text, progressPercent: undefined });
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    // Never keep the process alive just for the schedule.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let intervalMs = 6 * 3_600_000;
    try {
      const [settings, policyState] = await Promise.all([this.deps.settings.get(), this.deps.policy.current()]);
      const hours = Number(settings.updates.checkIntervalHours);
      intervalMs = Math.max(MIN_INTERVAL_MS, (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000);
      const policy = policyState.policy?.settings?.updates;
      const automatic = policy?.enabled !== false && (policy?.automatic ?? settings.updates.automatic);
      if (automatic && this.state !== 'downloading' && this.state !== 'ready' && this.state !== 'installing') {
        this.deps.logger.debug('[updates] scheduled check');
        await this.check();
      }
    } catch (err) {
      this.deps.logger.warn('[updates] scheduled check failed', err);
    }
    this.arm(intervalMs);
  }

  /** System install only: whether the daemon can apply updates right now (never cached: the daemon comes and goes). */
  private async systemAvailability(): Promise<SystemInstallAvailability | null> {
    if (this.packaging !== 'system' || !this.deps.systemInstall) return null;
    try {
      return await this.deps.systemInstall.available();
    } catch (err) {
      this.deps.logger.warn('[updates] cannot query the system service', err);
      return { daemonConnected: false, daemonSupportsUpdates: false };
    }
  }

  private async canInstallInPlace(): Promise<boolean> {
    if (this.packaging === 'system') {
      const system = await this.systemAvailability();
      return Boolean(system && system.daemonConnected && system.daemonSupportsUpdates);
    }
    if (this.canInstall !== undefined) return this.canInstall;
    if (this.packaging !== 'appimage' || !this.deps.appImagePath) {
      this.canInstall = false;
      return false;
    }
    const file = this.deps.appImagePath;
    this.canInstall = (await this.isWritable(path.dirname(file))) && (await this.isWritable(file));
    if (!this.canInstall) this.deps.logger.info(`[updates] ${file} is not writable; updates will only be announced`);
    return this.canInstall;
  }

  /** Apply a transition and notify listeners when anything visible changed. */
  private setState(state: InternalState, patch: Partial<{ latestVersion: string | undefined; releaseNotes: string | undefined; releaseDate: string | undefined; progressPercent: number | undefined; error: string | undefined }> = {}): void {
    const before = JSON.stringify(this.snapshot());
    this.state = state;
    if ('latestVersion' in patch) this.latestVersion = patch.latestVersion;
    if ('releaseNotes' in patch) this.releaseNotes = patch.releaseNotes;
    if ('releaseDate' in patch) this.releaseDate = patch.releaseDate;
    if ('progressPercent' in patch) this.progressPercent = patch.progressPercent;
    if ('error' in patch) this.error = patch.error;
    if (JSON.stringify(this.snapshot()) !== before) void this.emit();
  }

  private emit(): Promise<void> {
    if (this.listeners.size === 0) return Promise.resolve();
    const snap = this.snapshot();
    this.emitChain = this.emitChain.then(async () => {
      try {
        const status = await this.resolveStatus(snap);
        for (const listener of this.listeners) {
          try {
            listener(status);
          } catch (err) {
            this.deps.logger.warn('[updates] status listener failed', err);
          }
        }
      } catch (err) {
        this.deps.logger.warn('[updates] status failed', err);
      }
    });
    return this.emitChain;
  }
}
