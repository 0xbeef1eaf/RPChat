/**
 * System integration status + installer/autostart actions (docs/spec/system.md "App").
 * Filesystem and process access are injectable so the status assembly is testable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SystemIntegrationStatus } from '@rp/shared';
import { RpError, SYSTEM_GROUP } from '@rp/shared';
import type { DaemonClient } from './daemon-client.js';
import type { PolicyWatcher } from './policy.js';

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
    const policy: SystemIntegrationStatus['policy'] = { present: policyState.present, path: policyState.path, managed: policyState.managed };
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
    const installer = await this.installerPath();
    if (!installer) throw new RpError('NOT_FOUND', 'The installer script is not bundled with this build (resources/system/install.sh)');
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
