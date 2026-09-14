/**
 * System integration status + installer/autostart actions (docs/spec/system.md "App").
 * Filesystem and process access are injectable so the status assembly is testable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppSettings, PolicyFile, SystemIntegrationStatus } from '@rp/shared';
import { RpError, SYSTEM_GROUP } from '@rp/shared';
import type { DaemonClient } from './daemon-client.js';
import type { PolicyWatcher } from './policy.js';
import { parsePolicy } from './policy.js';

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
export function policyTemplate(settings: AppSettings): string {
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
  };
  return `${JSON.stringify(policy, null, 2)}\n`;
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

  constructor(private readonly deps: SystemIntegrationDeps) {
    this.run = deps.run ?? defaultRunner();
    this.homeDir = deps.homeDir ?? os.homedir();
    this.udevRulePath = deps.udevRulePath ?? UDEV_RULE_PATH;
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

  async status(): Promise<SystemIntegrationStatus> {
    const [daemon, policyState, inGroup, autostart, installer] = await Promise.all([
      this.deps.daemon.status(),
      this.deps.policy.current(),
      this.inGroup(),
      this.autostartStatus(),
      this.installerPath(),
    ]);
    const policy: SystemIntegrationStatus['policy'] = {
      present: policyState.present,
      canCreate: daemon.connected && !policyState.present,
      path: policyState.path,
      managed: policyState.managed,
      allowQuit: policyState.app.allowQuit,
      users: policyState.app.users,
    };
    if (policyState.managedBy) policy.managedBy = policyState.managedBy;
    if (policyState.error) policy.error = policyState.error;
    return {
      platform: this.deps.platform,
      daemon,
      policy,
      udev: { rulePresent: this.deps.platform === 'linux' && (await exists(this.udevRulePath)), inGroup, groupName: SYSTEM_GROUP },
      autostart,
      installerAvailable: installer !== null,
    };
  }

  /** Run the bundled installer through pkexec (Linux only), streaming its output to the log. */
  async install(options: { autostart?: boolean } = {}, onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    if (this.deps.platform !== 'linux') throw new RpError('CAPABILITY_FAILED', 'System integration is only available on Linux');
    const installer = await this.stageInstaller();
    const args = [installer, '--app-bin', this.deps.appBin, '--user', this.userName(), '--autostart', options.autostart === false ? 'none' : 'xdg'];
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

  /** `policyTemplate()` for the given settings (see the pure function). */
  policyTemplate(settings: AppSettings): string {
    return policyTemplate(settings);
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
