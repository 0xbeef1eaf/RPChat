/**
 * In-place application updates from the private GitHub releases of this repository, driven by
 * `electron-updater` (docs: README "Updating"). Everything Electron-specific is injected
 * (`UpdaterLike`, `safeStorage`) so the state machine is unit-testable without Electron:
 *
 * - The per-user GitHub token lives in `<userData>/update-token.bin`, encrypted through the
 *   OS keyring (`safeStorage`) when available and otherwise as a 0600 plaintext file. It is
 *   never logged and never part of the settings JSON.
 * - AppImage in a writable location → download and swap in place; `.deb` and other layouts →
 *   check only, the UI links to the release page. Development runs never touch the updater.
 * - `settings.updates` (automatic checks, interval) and the policy file (`updates.enabled`,
 *   `updates.automatic`) decide whether background checks run; a manual check is always
 *   allowed when a token exists and policy has not disabled updates.
 */
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { AppSettings, PolicyFile, UpdatePackaging, UpdateState, UpdateStatus } from '@rp/shared';
import { RpError, UPDATE_REPO } from '@rp/shared';
import type { Logger } from '@rp/core';

export const TOKEN_FILENAME = 'update-token.bin';
export const MAX_TOKEN_LENGTH = 400;
export const TOKEN_REJECTED_MESSAGE = 'GitHub rejected the update token (expired or missing access to the repository)';
/** First check ~30 s after launch so startup stays snappy. */
export const DEFAULT_INITIAL_DELAY_MS = 30_000;
/** A saved token triggers a check shortly after, when automatic checks are on. */
const AFTER_TOKEN_DELAY_MS = 2_000;
const MIN_INTERVAL_MS = 15 * 60_000;

/** File header bytes: how the token that follows is stored. */
const HEADER_KEYRING = 'RPTK1\n';
const HEADER_PLAIN = 'RPTK0\n';

export interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
  releaseDate?: string;
  releaseName?: string | null;
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
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; private: boolean; token: string; releaseType?: 'release' | 'prerelease' | 'draft' }): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: ProgressLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface UpdateServiceDeps {
  updater: UpdaterLike;
  appVersion: string;
  /** `app.isPackaged`; false → `unsupported`, the updater is never touched. */
  isPackaged: boolean;
  /** `process.env.APPIMAGE` when running as an AppImage. */
  appImagePath?: string;
  execPath: string;
  userDataDir: string;
  settings: { get(): Promise<AppSettings> };
  policy: { current(): Promise<{ policy: PolicyFile | null }> };
  safeStorage: SafeStorageLike;
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

type InternalState = Extract<UpdateState, 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'>;

interface TokenRecord {
  token: string;
  storage: 'keyring' | 'file';
}

type Snapshot = Pick<UpdateStatus, 'latestVersion' | 'releaseNotes' | 'releaseDate' | 'progressPercent' | 'error' | 'checkedAt'> & { state: InternalState };

async function defaultIsWritable(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pure: how the running binary was installed. */
export function detectPackaging(deps: Pick<UpdateServiceDeps, 'isPackaged' | 'appImagePath' | 'execPath'>): UpdatePackaging {
  if (!deps.isPackaged) return 'dev';
  if (deps.appImagePath) return 'appimage';
  const exec = deps.execPath.replace(/\\/g, '/');
  if (exec.startsWith('/opt/') || exec.startsWith('/usr/')) return 'deb';
  return 'other';
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

/** Pure: user-facing text for an updater failure; 401/403 → token rejected. */
export function describeUpdateError(err: unknown): string {
  const status = typeof err === 'object' && err !== null && 'statusCode' in err ? Number((err as { statusCode: unknown }).statusCode) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message)) return TOKEN_REJECTED_MESSAGE;
  if (status === 404 || /\b404\b/.test(message)) return 'Release feed not found (404): the token has no access to the repository, or the latest release has no latest-linux.yml';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR/i.test(message)) return `Cannot reach GitHub: ${message}`;
  return message.length > 0 ? message.slice(0, 500) : 'Update check failed';
}

export class UpdateService {
  readonly packaging: UpdatePackaging;
  readonly tokenPath: string;
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
  private token: TokenRecord | null | undefined;
  private feedToken: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;
  private inflightCheck: Promise<UpdateStatus> | undefined;
  /** Serialises listener notifications so they arrive in transition order. */
  private emitChain: Promise<void> = Promise.resolve();
  private warnedPlaintext = false;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.packaging = detectPackaging(deps);
    this.tokenPath = path.join(deps.userDataDir, TOKEN_FILENAME);
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
    const [policyState, token, canInstallInPlace] = await Promise.all([this.deps.policy.current(), this.loadToken(), this.canInstallInPlace()]);
    const policy = policyState.policy?.settings?.updates;
    const managed = Boolean(policy && (policy.enabled !== undefined || policy.automatic !== undefined));
    const status: UpdateStatus = {
      state: snap.state,
      currentVersion: this.deps.appVersion,
      packaging: this.packaging,
      canInstallInPlace,
      tokenPresent: token !== null,
      tokenStorage: token?.storage ?? 'none',
      managed,
    };
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
    } else if (token === null) {
      status.state = 'no-token';
      status.reason = 'Add a GitHub token to read the private release feed.';
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
    this.arm(AFTER_TOKEN_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Manual check. Throws when updates are unsupported, disabled by policy, or no token exists. */
  async check(): Promise<UpdateStatus> {
    await this.assertAllowed();
    if (this.inflightCheck) return this.inflightCheck;
    this.inflightCheck = this.runCheck().finally(() => {
      this.inflightCheck = undefined;
    });
    return this.inflightCheck;
  }

  /** Explicit download of an available update (AppImage in a writable location only). */
  async download(): Promise<UpdateStatus> {
    await this.assertAllowed();
    if (!(await this.canInstallInPlace())) {
      throw new RpError('CAPABILITY_FAILED', this.packaging === 'deb' ? 'Package installs are notified only: download the .deb from the release page.' : 'This build cannot replace itself; download the AppImage from the release page.');
    }
    if (this.state === 'downloading' || this.state === 'ready') return this.status();
    if (this.state !== 'available') throw new RpError('INVALID_ARGUMENT', 'No update is available to download; check for updates first.');
    this.setState('downloading', { progressPercent: 0 });
    // Progress and completion arrive as updater events; a rejection lands in `fail`.
    void this.deps.updater.downloadUpdate().catch((err: unknown) => this.fail(err));
    return this.status();
  }

  /** Quit and relaunch into the downloaded update. */
  async install(): Promise<void> {
    await this.assertAllowed();
    if (this.state !== 'ready') throw new RpError('INVALID_ARGUMENT', 'No downloaded update to install.');
    this.deps.logger.info(`[updates] installing ${this.latestVersion ?? 'update'} and restarting`);
    if (this.deps.beforeRestart) await this.deps.beforeRestart().catch((err: unknown) => this.deps.logger.warn('[updates] pre-restart hook failed', err));
    this.deps.updater.quitAndInstall(false, true);
  }

  /** Store (`string`) or remove (`null`) the GitHub token. Never logged. */
  async setToken(token: string | null): Promise<UpdateStatus> {
    if (this.packaging === 'dev') throw new RpError('CAPABILITY_FAILED', 'Updates are only available in packaged builds.');
    if (token === null) {
      await fs.rm(this.tokenPath, { force: true });
      this.token = null;
      this.feedToken = undefined;
      this.resetProgress('idle');
      this.deps.logger.info('[updates] token removed');
      await this.emit();
      return this.status();
    }
    if (typeof token !== 'string') throw new RpError('INVALID_ARGUMENT', 'token must be a string');
    const trimmed = token.trim();
    if (trimmed.length === 0) throw new RpError('INVALID_ARGUMENT', 'The token is empty');
    if (trimmed.length > MAX_TOKEN_LENGTH) throw new RpError('INVALID_ARGUMENT', `The token is longer than ${MAX_TOKEN_LENGTH} characters; paste only the token itself`);
    if (/[\s]/.test(trimmed)) throw new RpError('INVALID_ARGUMENT', 'The token must not contain whitespace');
    const record = await this.writeToken(trimmed);
    this.token = record;
    this.applyFeed(record.token);
    this.resetProgress('idle');
    this.deps.logger.info(`[updates] token saved (${record.storage})`);
    if (this.started && !this.stopped) this.arm(AFTER_TOKEN_DELAY_MS);
    await this.emit();
    return this.status();
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
      this.setState('ready', { latestVersion: info.version ?? this.latestVersion, progressPercent: 100, error: undefined });
      this.deps.logger.info(`[updates] ${info.version} downloaded; restart to install`);
    });
    u.on('error', (err) => this.fail(err));
  }

  private async assertAllowed(): Promise<void> {
    if (this.packaging === 'dev') throw new RpError('CAPABILITY_FAILED', 'Updates are only available in packaged builds.');
    if (await this.disabledByPolicy()) throw new RpError('PERMISSION_DENIED', 'Update checks are switched off by the system policy on this machine.');
    const token = await this.loadToken();
    if (!token) throw new RpError('PERMISSION_DENIED', 'Add a GitHub token first (Settings → Updates).');
    this.applyFeed(token.token);
  }

  private async disabledByPolicy(): Promise<boolean> {
    return (await this.deps.policy.current()).policy?.settings?.updates?.enabled === false;
  }

  private applyFeed(token: string): void {
    if (this.feedToken === token) return;
    this.deps.updater.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo, private: true, token, releaseType: 'release' });
    this.feedToken = token;
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
      const [settings, policyState, token] = await Promise.all([this.deps.settings.get(), this.deps.policy.current(), this.loadToken()]);
      const hours = Number(settings.updates.checkIntervalHours);
      intervalMs = Math.max(MIN_INTERVAL_MS, (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000);
      const policy = policyState.policy?.settings?.updates;
      const automatic = policy?.enabled !== false && (policy?.automatic ?? settings.updates.automatic);
      if (automatic && token && this.state !== 'downloading' && this.state !== 'ready') {
        this.deps.logger.debug('[updates] scheduled check');
        await this.check();
      }
    } catch (err) {
      this.deps.logger.warn('[updates] scheduled check failed', err);
    }
    this.arm(intervalMs);
  }

  private async canInstallInPlace(): Promise<boolean> {
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

  private resetProgress(state: InternalState): void {
    this.state = state;
    this.latestVersion = undefined;
    this.releaseNotes = undefined;
    this.releaseDate = undefined;
    this.progressPercent = undefined;
    this.error = undefined;
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

  // ---- token file ---------------------------------------------------------

  private async loadToken(): Promise<TokenRecord | null> {
    if (this.token !== undefined) return this.token;
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.tokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.logger.warn(`[updates] cannot read ${this.tokenPath}: ${(err as Error).message}`);
      this.token = null;
      return null;
    }
    const header = raw.subarray(0, HEADER_KEYRING.length).toString('utf8');
    const body = raw.subarray(HEADER_KEYRING.length);
    let record: TokenRecord | null = null;
    if (header === HEADER_KEYRING) {
      if (this.deps.safeStorage.isEncryptionAvailable()) {
        try {
          record = { token: this.deps.safeStorage.decryptString(body).trim(), storage: 'keyring' };
        } catch (err) {
          this.deps.logger.warn(`[updates] cannot decrypt the stored token (${(err as Error).message}); enter it again`);
        }
      } else {
        this.deps.logger.warn('[updates] the stored token is encrypted but the OS keyring is unavailable; enter it again');
      }
    } else if (header === HEADER_PLAIN) {
      record = { token: body.toString('utf8').trim(), storage: 'file' };
    } else {
      this.deps.logger.warn(`[updates] ${this.tokenPath} has an unknown format; ignoring it`);
    }
    if (record && record.token.length === 0) record = null;
    this.token = record;
    if (record) this.applyFeed(record.token);
    return record;
  }

  private async writeToken(token: string): Promise<TokenRecord> {
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    let payload: Buffer;
    let storage: TokenRecord['storage'];
    if (this.deps.safeStorage.isEncryptionAvailable()) {
      payload = Buffer.concat([Buffer.from(HEADER_KEYRING, 'utf8'), this.deps.safeStorage.encryptString(token)]);
      storage = 'keyring';
    } else {
      payload = Buffer.concat([Buffer.from(HEADER_PLAIN, 'utf8'), Buffer.from(token, 'utf8')]);
      storage = 'file';
      if (!this.warnedPlaintext) {
        this.warnedPlaintext = true;
        this.deps.logger.warn(`[updates] no OS keyring available (safeStorage); the token is stored as a 0600 file at ${this.tokenPath}`);
      }
    }
    const tmp = `${this.tokenPath}.tmp`;
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => undefined);
    await fs.rename(tmp, this.tokenPath);
    return { token, storage };
  }
}
