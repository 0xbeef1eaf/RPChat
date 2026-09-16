/**
 * System integration status + installer/autostart actions (docs/spec/system.md "App").
 * Filesystem and process access are injectable so the status assembly is testable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppSettings, DaemonEvent, DaemonStatus, DevRules, GuardAttempt, GuardAttemptRecord, GuardStatus, PolicyFile, RemoteInfo, RuntimeInfo, SealInfo, SealMode, SystemInstallStatus, SystemIntegrationStatus, TamperRecord } from '@rp/shared';
import { DEFAULT_APP_RESTRICTIONS, DEFAULT_DEV_RULES, DEFAULT_SEAL_INFO, RpError, SYSTEM_GROUP, SYSTEM_INSTALL_DIR } from '@rp/shared';
import type { DaemonClient } from './daemon-client.js';
import type { PolicyWatcher } from './policy.js';
import { guardMode, parsePolicy } from './policy.js';
import type { SealCache } from './seal-cache.js';
import type { RemoteConfigService } from './remote-config.js';
import { ChainAuthor } from './chain-author.js';

/** How many `guard-attempt` events the app keeps for Settings → System → Audit log. */
export const GUARD_ATTEMPT_LOG_SIZE = 50;

/**
 * Pure: `SystemIntegrationStatus.guard` from the policy (what should be engaged) and the
 * daemon's report (what is). Without a daemon that knows the guard, only the policy side is
 * known and `available` is false.
 */
export function guardStatusOf(input: { policy: PolicyFile | null; daemon: DaemonStatus }): GuardStatus {
  const mode = guardMode(input.policy);
  const info = input.daemon.connected ? input.daemon.guard : undefined;
  const users = input.policy?.app?.users ?? [];
  if (!info) {
    return {
      configured: mode !== 'off',
      daemonSupportsGuard: false,
      available: false,
      mode,
      loaded: [],
      users: [...users],
      residual: mode === 'off' ? [] : [input.daemon.connected ? 'the connected daemon predates the session guard; run the installer once to update it' : 'the daemon is not connected; nothing is engaged'],
    };
  }
  return { ...info, configured: mode !== 'off', daemonSupportsGuard: true };
}

/** A bounded, newest-first log of guard attempts (pure state; fed from the keepalive link's events). */
export class GuardAttemptLog {
  private readonly entries: GuardAttemptRecord[] = [];

  constructor(private readonly size: number = GUARD_ATTEMPT_LOG_SIZE) {}

  push(event: Extract<DaemonEvent, { ev: 'guard-attempt' }>): GuardAttemptRecord {
    const { ev: _ev, ...rest } = event;
    const record: GuardAttemptRecord = { ...(rest as GuardAttempt & { at: string }) };
    this.entries.unshift(record);
    if (this.entries.length > this.size) this.entries.length = this.size;
    return record;
  }

  list(): GuardAttemptRecord[] {
    return [...this.entries];
  }
}

export const UDEV_RULE_PATH = '/etc/udev/rules.d/70-rp-code.rules';
export const AUTOSTART_FILENAME = 'rp-code.desktop';
export const INSTALLER_FILENAME = 'install.sh';

export interface ProcessRunner {
  (file: string, args: string[], onOutput?: (chunk: string) => void): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface SystemIntegrationDeps {
  platform: NodeJS.Platform;
  daemon: DaemonClient;
  policy: PolicyWatcher;
  /** Directories that may contain `system/install.sh` (packaged resources first). */
  resourcesDirs: string[];
  homeDir?: string;
  /** `process.env.APPIMAGE ?? process.execPath`. */
  appBin: string;
  /** Whether `appBin` is an AppImage (`process.env.APPIMAGE` set): the installer can unpack it into the system install. */
  appImage?: boolean;
  /** `realpath(process.execPath)`: decides whether this launch runs from the system install. */
  execPath?: string;
  /** The unpacked app directory of the system install. Default `/opt/rp-code/current`. */
  systemInstallDir?: string;
  /**
   * Where the installer and daemon are copied before running them as root. Defaults to
   * `~/.cache/rp-code/system-install`. Needed because an AppImage is a FUSE mount under
   * `/tmp/.mount_*` that only the mounting user can traverse: root (sudo/pkexec) cannot even
   * read `install.sh` from there.
   */
  stageDir?: string;
  userName?: string;
  run?: ProcessRunner;
  logger: Pick<Console, 'info' | 'warn' | 'debug'>;
  udevRulePath?: string;
  /** The guard-attempt log the keepalive link feeds (`guardAttempts()`); a fresh one when absent. */
  guardLog?: GuardAttemptLog;
  /**
   * The app's memory of a sealed policy (`seal-cache.ts`). `status()` keeps it in step: it is
   * written whenever a sealed machine is seen, and dropped only when a *connected* daemon says the
   * machine is not sealed — which is the one thing that cannot happen without a code.
   */
  sealCache?: SealCache;
  /** Remote configuration, when the app runs one (Linux with a daemon). */
  remote?: RemoteConfigService;
  /**
   * The authoring side: the administrator's signing key and the chain they publish. Present on
   * every platform — writing a policy for a fleet is not something you have to do on a managed
   * machine, and often should not be.
   */
  author?: ChainAuthor;
  /**
   * What the dev guard decided when this process started (dev-guard.ts). Reported as it was read
   * then, not from the policy file now: the lock is applied once, at startup. Defaults to
   * everything allowed, which is what a test or a non-Electron caller sees.
   */
  dev?: DevRules;
}

/** Pure: the XDG autostart entry for the app. */
export function autostartDesktopEntry(appBin: string): string {
  const exec = /\s/.test(appBin) ? `"${appBin.replace(/"/g, '\\"')}"` : appBin;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=rp-code',
    'Comment=Start rp-code minimized to the tray',
    `Exec=${exec} --hidden`,
    'Icon=rp-code',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    '',
  ].join('\n');
}

/**
 * Pure: a policy seeded from the user's current settings, so a new policy starts from what
 * they already have (pretty JSON, ready to edit). `managedBy` is left for them to fill in.
 */
export function policyTemplate(settings: AppSettings, userName?: string): string {
  const policy: PolicyFile = {
    version: 1,
    managedBy: '',
    settings: {
      maxInputLockMs: settings.maxInputLockMs,
      autonomy: { ...settings.autonomy },
      permissions: { moduleAllow: { ...settings.permissions.moduleAllow } },
      web: { allowlist: [...settings.web.allowlist] },
      desktop: { launchAllowlist: [...settings.desktop.launchAllowlist] },
      memory: { ...settings.memory },
      senses: { includeInPrompt: settings.senses.includeInPrompt, watchDirs: [...settings.senses.watchDirs], calendarSources: [...settings.senses.calendarSources] },
      displayBackend: settings.displayBackend,
      updates: { enabled: true, automatic: settings.updates.automatic },
      browser: { allowBlocking: settings.browser.allowBlocking, allowEval: settings.browser.allowEval, allowHistory: settings.browser.allowHistory, homePage: settings.browser.homePage },
    },
    inputLock: { enabled: true, maxDurationMs: settings.maxInputLockMs, emergencyKey: 'esc', emergencyHoldMs: 5000 },
    // Off by default so a freshly created policy changes nothing; every key is present to edit.
    app: { allowQuit: true, ...(userName ? { users: [userName] } : {}), ...DEFAULT_APP_RESTRICTIONS },
    guard: { mode: 'off', protectApp: true, wallpaper: true, compositorIpc: 'shell-only', shell: 'auto', extraDenyPaths: [], extraDenySockets: [], allowBinaries: [] },
  };
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** Pure: whether `execPath` (already realpath'd) lives inside the system install directory. */
export function isSystemInstallExec(execPath: string, dir: string = SYSTEM_INSTALL_DIR): boolean {
  const root = dir.replace(/\/+$/, '');
  return root.length > 0 && execPath.startsWith(`${root}/`);
}

/**
 * Pure: `SystemIntegrationStatus.install` from where the executable runs and what the daemon
 * reports. "System install" means both: running from `dir` and a connected daemon (the one that
 * applies updates); `daemonSupportsUpdates` is false for a daemon that predates `apply-update`,
 * in which case the pkexec installer is needed once more.
 */
export function systemInstallStatus(input: { execPath: string | undefined; dir: string; appImage: boolean; daemon: DaemonStatus }): SystemInstallStatus {
  const execInDir = input.execPath !== undefined && isSystemInstallExec(input.execPath, input.dir);
  const info = input.daemon.connected ? input.daemon.install : undefined;
  const out: SystemInstallStatus = {
    systemInstall: execInDir && input.daemon.connected,
    dir: input.dir,
    execInDir,
    daemonSupportsUpdates: info !== undefined,
    canSystemInstall: input.appImage,
  };
  if (info?.current !== undefined) out.current = info.current;
  if (info?.previous !== undefined) out.previous = info.previous;
  if (info?.daemonVersion !== undefined) out.daemonVersion = info.daemonVersion;
  return out;
}

/** Managed-policy directories a Chromium fork keeps outside the built-in list (`settings.browser.extraPolicyDirs`). */
export function parseExtraPolicyDirs(dirs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of dirs ?? []) {
    const dir = raw.trim().replace(/\/+$/, '');
    if (dir.length === 0) continue;
    if (!/^\/[^\s|"'\\]+\/policies\/managed$/.test(dir)) throw new RpError('INVALID_ARGUMENT', `"${dir}" is not a managed-policy directory (an absolute path ending in /policies/managed, no spaces)`);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function extraPolicyDirArgs(dirs: string[] | undefined): string[] {
  return parseExtraPolicyDirs(dirs).flatMap((d) => ['--browser-policy-dir', d]);
}

export function defaultRunner(): ProcessRunner {
  return (file, args, onOutput) =>
    new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', (c: Buffer) => {
        const text = c.toString('utf8');
        stdout += text;
        onOutput?.(text);
      });
      child.stderr.on('data', (c: Buffer) => {
        const text = c.toString('utf8');
        stderr += text;
        onOutput?.(text);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class SystemIntegration {
  private readonly run: ProcessRunner;
  private readonly homeDir: string;
  private readonly udevRulePath: string;
  readonly guardLog: GuardAttemptLog;
  /** The administrator's own key and chain (`chain-author.ts`). */
  readonly author: ChainAuthor;
  /** Tamper records pushed by the daemon this session, newest first (the seal keeps its own). */
  private readonly tampers: TamperRecord[] = [];

  constructor(private readonly deps: SystemIntegrationDeps) {
    this.run = deps.run ?? defaultRunner();
    this.homeDir = deps.homeDir ?? os.homedir();
    this.udevRulePath = deps.udevRulePath ?? UDEV_RULE_PATH;
    this.guardLog = deps.guardLog ?? new GuardAttemptLog();
    this.author =
      deps.author ??
      new ChainAuthor({
        dir: path.join(this.homeDir, '.config', 'rp-code', 'policy-chain'),
        safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
        logger: deps.logger,
      });
  }

  get autostartPath(): string {
    return path.join(this.homeDir, '.config', 'autostart', AUTOSTART_FILENAME);
  }

  /** Absolute path of the bundled `install.sh`, or null when not shipped. */
  async installerPath(): Promise<string | null> {
    for (const dir of this.deps.resourcesDirs) {
      const candidate = path.join(dir, 'system', INSTALLER_FILENAME);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  get stageDir(): string {
    return this.deps.stageDir ?? path.join(this.homeDir, '.cache', 'rp-code', 'system-install');
  }

  /**
   * Copy the bundled installer, its support files and the daemon binary into `stageDir` (a
   * plain directory root can read) and return the staged `install.sh`. The stage is rebuilt on
   * every call so it always matches this build. `install.sh` finds `rp-coded` next to itself.
   */
  async stageInstaller(): Promise<string> {
    const installer = await this.installerPath();
    if (!installer) throw new RpError('NOT_FOUND', 'The installer script is not bundled with this build (resources/system/install.sh)');
    const systemDir = path.dirname(installer);
    const stage = this.stageDir;
    await fs.rm(stage, { recursive: true, force: true });
    await fs.mkdir(stage, { recursive: true, mode: 0o755 });
    const sources: string[] = [];
    for (const name of await fs.readdir(systemDir)) sources.push(path.join(systemDir, name));
    const daemon = path.join(path.dirname(systemDir), 'bin', 'rp-coded');
    if (await exists(daemon)) sources.push(daemon);
    for (const src of sources) {
      const dst = path.join(stage, path.basename(src));
      await fs.copyFile(src, dst);
      await fs.chmod(dst, dst.endsWith('.sh') || path.basename(dst) === 'rp-coded' ? 0o755 : 0o644);
    }
    this.deps.logger.debug(`[system] staged ${sources.length} installer file(s) in ${stage}`);
    return path.join(stage, INSTALLER_FILENAME);
  }

  private userName(): string {
    if (this.deps.userName) return this.deps.userName;
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER ?? process.env.LOGNAME ?? 'unknown';
    }
  }

  private async inGroup(): Promise<boolean> {
    if (this.deps.platform !== 'linux') return false;
    try {
      const r = await this.run('id', ['-Gn']);
      return r.code === 0 && r.stdout.split(/\s+/).includes(SYSTEM_GROUP);
    } catch {
      return false;
    }
  }

  async autostartStatus(): Promise<SystemIntegrationStatus['autostart']> {
    const xdg = this.autostartPath;
    if (await exists(xdg)) return { enabled: true, method: 'xdg', path: xdg };
    const unit = path.join(this.homeDir, '.config', 'systemd', 'user', 'rp-code.service');
    if (await exists(unit)) {
      const wants = path.join(this.homeDir, '.config', 'systemd', 'user', 'graphical-session.target.wants', 'rp-code.service');
      return { enabled: await exists(wants), method: 'systemd-user', path: unit };
    }
    return { enabled: false, method: 'none' };
  }

  /**
   * The seal as the daemon reports it, and what the app knows on its own when there is no daemon
   * to ask. Without one, a policy that came from the seal marker or from the app's cache still
   * means "this machine is sealed" — the app must not present itself as unmanaged just because
   * the thing enforcing the lock has been stopped.
   */
  private async sealStatus(daemon: DaemonStatus, sealed: boolean): Promise<{ seal: SealInfo; runtime?: RuntimeInfo; remote?: RemoteInfo }> {
    if (daemon.connected) {
      try {
        const status = await this.deps.daemon.sealStatus();
        // A daemon that predates the seal answers `INVALID`, but a stub or a future daemon could
        // answer something else again: only a well-shaped answer replaces what the app knows.
        if (status && typeof status.seal?.sealed === 'boolean') {
          const out: { seal: SealInfo; runtime?: RuntimeInfo; remote?: RemoteInfo } = { seal: status.seal };
          if (status.runtime) out.runtime = status.runtime;
          if (status.remote) out.remote = status.remote;
          return out;
        }
      } catch (err) {
        // An older daemon does not know `seal-status`; that is not an error worth showing.
        this.deps.logger.debug(`[system] seal-status unavailable: ${(err as Error).message}`);
      }
    }
    if (!sealed) return { seal: { ...DEFAULT_SEAL_INFO } };
    return {
      seal: {
        ...DEFAULT_SEAL_INFO,
        sealed: true,
        residual: ['the daemon is not running, so nothing is putting the policy back if it is changed; the app is enforcing the copy it has'],
      },
    };
  }

  async status(): Promise<SystemIntegrationStatus> {
    const [daemon, policyState, inGroup, autostart, installer] = await Promise.all([
      this.deps.daemon.status(),
      this.deps.policy.current(),
      this.inGroup(),
      this.autostartStatus(),
      this.installerPath(),
    ]);
    const { seal, runtime, remote } = await this.sealStatus(daemon, policyState.sealed);
    const sealed = seal.sealed || policyState.sealed;
    // Keep the app's memory of the seal in step. It is dropped only for a connected daemon that
    // says the machine is not sealed — i.e. after a code was accepted somewhere.
    if (this.deps.sealCache) {
      if (sealed && policyState.policy) {
        const meta: { sealedAt?: string; managedBy?: string } = {};
        if (seal.sealedAt !== undefined) meta.sealedAt = seal.sealedAt;
        if (policyState.managedBy !== undefined) meta.managedBy = policyState.managedBy;
        await this.deps.sealCache.remember(policyState.policy, meta).catch((err) => this.deps.logger.warn(`[system] cannot cache the sealed policy: ${(err as Error).message}`));
      } else if (daemon.connected && !seal.sealed) {
        if (await this.deps.sealCache.read()) await this.deps.sealCache.clear();
      }
    }
    const policy: SystemIntegrationStatus['policy'] = {
      present: policyState.present,
      // A sealed machine is not "waiting for its first policy": replacing one needs a code, which
      // is a different button.
      canCreate: daemon.connected && !policyState.present && !sealed,
      path: policyState.path,
      managed: policyState.managed,
      allowQuit: policyState.app.allowQuit,
      users: policyState.app.users,
      restrictions: policyState.restrictions,
      dev: this.deps.dev ?? DEFAULT_DEV_RULES,
      seal: { ...seal, sealed, tampers: [...this.tampers].reverse().concat(seal.tampers).slice(-20) },
    };
    if (runtime) policy.runtime = runtime;
    if (policyState.fromCache) policy.fromCache = true;
    if (policyState.managedBy) policy.managedBy = policyState.managedBy;
    if (policyState.error) policy.error = policyState.error;
    const out: SystemIntegrationStatus = {
      platform: this.deps.platform,
      daemon,
      policy,
      udev: { rulePresent: this.deps.platform === 'linux' && (await exists(this.udevRulePath)), inGroup, groupName: SYSTEM_GROUP },
      autostart,
      installerAvailable: installer !== null,
      install: systemInstallStatus({ execPath: this.deps.execPath, dir: this.systemInstallDir, appImage: this.deps.appImage === true, daemon }),
      guard: guardStatusOf({ policy: policyState.policy, daemon }),
    };
    if (remote && this.deps.remote) out.remote = { daemon: remote, app: await this.deps.remote.status() };
    return out;
  }

  /** Record a `policy-tamper` the daemon pushed, for Settings → System. */
  noteTamper(record: TamperRecord): void {
    this.tampers.unshift(record);
    if (this.tampers.length > GUARD_ATTEMPT_LOG_SIZE) this.tampers.length = GUARD_ATTEMPT_LOG_SIZE;
  }

  /**
   * Seal this machine: the daemon pins `text` (or the policy already on disk) to a fresh TOTP
   * secret and answers with the secret, the enrolment URI and the remote-configuration signing
   * key. **They are readable exactly once** — this is the only moment they exist outside the
   * root-only seal file, so the caller must show them to the administrator before doing anything
   * else with the result.
   */
  async sealPolicy(text?: string): Promise<{ secret: string; otpauth: string; status: SystemIntegrationStatus }> {
    let policy: PolicyFile | undefined;
    if (text !== undefined && text.trim().length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        const problem = `not valid JSON: ${(err as Error).message}`;
        throw new RpError('INVALID_ARGUMENT', `Invalid policy file:\n${problem}`, { problems: [problem] });
      }
      parsePolicy(json);
      policy = json as PolicyFile;
    }
    const sealed = await this.deps.daemon.sealPolicy(policy ? { policy } : {});
    this.deps.logger.info(`[system] policy sealed at ${sealed.path}: changing it now needs a code from the enrolled authenticator app`);
    this.deps.policy.invalidate();
    return { secret: sealed.secret, otpauth: sealed.otpauth, status: await this.status() };
  }

  /**
   * Replace a sealed policy. `code` is the current code from the enrolled app; a missing, wrong,
   * replayed or locked-out code comes back as `PERMISSION_DENIED` with `details.daemonCode: 'CODE'`.
   */
  async replacePolicy(text: string, code: string): Promise<SystemIntegrationStatus> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      const problem = `not valid JSON: ${(err as Error).message}`;
      throw new RpError('INVALID_ARGUMENT', `Invalid policy file:\n${problem}`, { problems: [problem] });
    }
    parsePolicy(json);
    const { path: written } = await this.deps.daemon.setPolicy(json as PolicyFile, code);
    this.deps.logger.info(`[system] policy replaced at ${written} (code accepted)`);
    this.deps.policy.invalidate();
    return this.status();
  }

  /** Remove the seal with a code; `removePolicy` takes the policy file with it. */
  async unsealPolicy(code: string, removePolicy = false): Promise<SystemIntegrationStatus> {
    const res = await this.deps.daemon.unsealPolicy(code, removePolicy);
    this.deps.logger.info(`[system] policy unsealed${res.removed ? ' and the policy file removed' : ''} (code accepted)`);
    this.deps.policy.invalidate();
    await this.deps.sealCache?.clear();
    return this.status();
  }

  /**
   * Paste a Remote Link: point this machine at a policy chain and seal it in the mode the blob
   * names. `secret`/`otpauth` come back only when the blob asked for `totp` and this was the paste
   * that sealed the machine — the one time either is readable.
   */
  async setRemoteLink(blob: string, code?: string): Promise<{ mode: SealMode; url: string; secret?: string; otpauth?: string; status: SystemIntegrationStatus }> {
    const linked = await this.deps.daemon.setRemoteLink(blob, code);
    this.deps.logger.info(`[system] Remote Link set: ${linked.url} in ${linked.mode} mode`);
    this.deps.policy.invalidate();
    const out: { mode: SealMode; url: string; secret?: string; otpauth?: string; status: SystemIntegrationStatus } = {
      mode: linked.mode,
      url: linked.url,
      status: await this.status(),
    };
    if (linked.secret !== undefined) out.secret = linked.secret;
    if (linked.otpauth !== undefined) out.otpauth = linked.otpauth;
    // The chain may already have something for this machine; do not make them wait an interval.
    void this.deps.remote?.check().catch(() => undefined);
    return out;
  }

  /** Fetch the policy chain now instead of waiting for the interval. */
  async remoteRefresh(): Promise<SystemIntegrationStatus> {
    if (!this.deps.remote) throw new RpError('CAPABILITY_FAILED', 'Remote configuration is not available on this platform');
    await this.deps.remote.check();
    this.deps.policy.invalidate();
    return this.status();
  }

  /** Session guard: ask the daemon to (re)generate and load the profiles now; resolves with the new status. */
  async guardApply(): Promise<SystemIntegrationStatus> {
    const info = await this.deps.daemon.guardApply();
    this.deps.logger.info(`[system] session guard ${info.mode}: ${info.loaded.length > 0 ? `${info.loaded.join(', ')} loaded` : 'nothing loaded'}${info.lastError ? ` (${info.lastError})` : ''}`);
    return this.status();
  }

  /** The last `GUARD_ATTEMPT_LOG_SIZE` guard attempts the daemon pushed, newest first. */
  async guardAttempts(): Promise<GuardAttemptRecord[]> {
    return this.guardLog.list();
  }

  get systemInstallDir(): string {
    return this.deps.systemInstallDir ?? SYSTEM_INSTALL_DIR;
  }

  /**
   * Run the bundled installer through pkexec (Linux only), streaming its output to the log. An
   * AppImage launch is unpacked into the system install unless `systemInstall: false`.
   */
  async install(options: { autostart?: boolean; systemInstall?: boolean } = {}, onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    if (this.deps.platform !== 'linux') throw new RpError('CAPABILITY_FAILED', 'System integration is only available on Linux');
    const installer = await this.stageInstaller();
    const args = [installer, '--app-bin', this.deps.appBin, '--user', this.userName(), '--autostart', options.autostart === false ? 'none' : 'xdg'];
    if (options.systemInstall === false) args.push('--no-system-install');
    // The session guard needs the pam_apparmor line the installer adds: ask for it whenever the
    // policy has the guard switched on (the installer also reads the policy itself).
    if (guardMode((await this.deps.policy.current()).policy) !== 'off') args.push('--guard');
    this.deps.logger.info(`[system] pkexec ${args.join(' ')}`);
    let output = '';
    const collect = (chunk: string): void => {
      output += chunk;
      for (const line of chunk.split('\n')) if (line.trim()) this.deps.logger.info(`[system:install] ${line.trimEnd()}`);
      onOutput?.(chunk);
    };
    try {
      const result = await this.run('pkexec', args, collect);
      if (result.code !== 0 && output.trim().length === 0) output = result.stderr || `pkexec exited with ${result.code}`;
      return { ok: result.code === 0, output };
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot run pkexec: ${(err as Error).message} (install polkit, or run "sudo ${installer} --app-bin ${this.deps.appBin} --user ${this.userName()}" yourself)`);
    }
  }

  /**
   * Write the Chromium managed policy that force-installs the bundled extension from the app's
   * loopback update URL (`install.sh --browser-only --browser-extension … --browser-update-url …
   * --browser-port …`, through pkexec; Linux only). The id is per user, so this never runs from
   * the package's post-install.
   */
  async installBrowserPolicy(input: { extensionId: string; updateUrl: string; port: number; homePage?: string; extraPolicyDirs?: string[] }, onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    if (!/^[a-p]{32}$/.test(input.extensionId)) throw new RpError('INVALID_ARGUMENT', 'extensionId must be 32 letters a–p');
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/extension\/update\.xml$/.test(input.updateUrl)) throw new RpError('INVALID_ARGUMENT', 'updateUrl must be the app\'s loopback update URL');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new RpError('INVALID_ARGUMENT', 'port must be 1..65535');
    if (input.homePage !== undefined && !/^https?:\/\/[^\s"\\]+$/i.test(input.homePage)) throw new RpError('INVALID_ARGUMENT', 'homePage must be an http(s) URL');
    return this.runInstaller(
      [
        '--browser-only', '--browser-extension', input.extensionId, '--browser-update-url', input.updateUrl, '--browser-port', String(input.port),
        ...(input.homePage ? ['--browser-home', input.homePage] : []),
        ...extraPolicyDirArgs(input.extraPolicyDirs),
      ],
      'browser policy',
      onOutput,
    );
  }

  /** Remove the policy files `installBrowserPolicy` wrote (pkexec; Linux only), including those in `extraPolicyDirs`. */
  async removeBrowserPolicy(extraPolicyDirs?: string[], onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    return this.runInstaller(['--remove-browser-policy', ...extraPolicyDirArgs(extraPolicyDirs)], 'browser policy removal', onOutput);
  }

  private async runInstaller(extraArgs: string[], what: string, onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    if (this.deps.platform !== 'linux') throw new RpError('CAPABILITY_FAILED', `${what[0]!.toUpperCase()}${what.slice(1)} is only available on Linux`);
    const installer = await this.stageInstaller();
    const args = [installer, ...extraArgs, '--user', this.userName()];
    this.deps.logger.info(`[system] pkexec ${args.join(' ')}`);
    let output = '';
    const collect = (chunk: string): void => {
      output += chunk;
      for (const line of chunk.split('\n')) if (line.trim()) this.deps.logger.info(`[system:install] ${line.trimEnd()}`);
      onOutput?.(chunk);
    };
    try {
      const result = await this.run('pkexec', args, collect);
      if (result.code !== 0 && output.trim().length === 0) output = result.stderr || `pkexec exited with ${result.code}`;
      return { ok: result.code === 0, output };
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Cannot run pkexec: ${(err as Error).message} (install polkit, or run "sudo ${installer} ${extraArgs.join(' ')}" yourself)`);
    }
  }

  /**
   * What the policy form starts from. On a machine that already has a policy that is the policy
   * itself — replacing one is an edit, and seeding from the settings would quietly drop every
   * block the settings do not carry (`app`, `guard`, `lock`, `remote`, `packs`). Otherwise it is
   * `policyTemplate()` over the user's current settings, as before.
   */
  async policyTemplate(settings: AppSettings): Promise<string> {
    const state = await this.deps.policy.current();
    if (state.policy) return `${JSON.stringify(state.policy, null, 2)}\n`;
    return policyTemplate(settings, this.userName());
  }

  /**
   * Create the policy file once through the daemon (write-once, no root needed). `text` is
   * parsed and validated here first (`INVALID_ARGUMENT` with `details.problems`), then sent as
   * the object the user wrote so the daemon's stricter validation (unknown keys) still applies;
   * a policy that already exists comes back as `INVALID_ARGUMENT` with `details.daemonCode: 'EXISTS'`.
   */
  async createPolicy(text: string): Promise<SystemIntegrationStatus> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      const problem = `not valid JSON: ${(err as Error).message}`;
      throw new RpError('INVALID_ARGUMENT', `Invalid policy file:\n${problem}`, { problems: [problem] });
    }
    const parsed = parsePolicy(json);
    const { path } = await this.deps.daemon.setPolicy(json as PolicyFile);
    this.deps.logger.info(`[system] policy created at ${path}${parsed.managedBy ? ` (managed by ${parsed.managedBy})` : ''}`);
    this.deps.policy.invalidate();
    return this.status();
  }

  /** Write or remove `~/.config/autostart/rp-code.desktop` (no privileges needed). */
  async setAutostart(enabled: boolean): Promise<SystemIntegrationStatus> {
    const file = this.autostartPath;
    if (enabled) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, autostartDesktopEntry(this.deps.appBin), 'utf8');
      this.deps.logger.info(`[system] autostart enabled (${file})`);
    } else {
      await fs.rm(file, { force: true });
      this.deps.logger.info(`[system] autostart disabled (${file} removed)`);
    }
    return this.status();
  }
}
