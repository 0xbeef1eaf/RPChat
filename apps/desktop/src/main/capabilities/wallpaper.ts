/**
 * `sdk.wallpaper`: runs the user's wallpaper command template with a pack image. Before the
 * first `set`, the current wallpaper is read through the `wallpaperGet` template (Noctalia
 * `wallpaper-get`, GNOME `gsettings get …`) when the restore file is not configured, so
 * `restore()` can put it back; the captured path is handed to `remember` (persisted as
 * `wallpaperRestoreFile` by the engine) and kept in memory as a fallback.
 */
import * as fs from 'node:fs/promises';
import type { LoadedPack } from '@rp/shared';
import type { ActionContext, CapabilityHandler, Json, MonitorSelector } from '@rp/shared';
import { RpError } from '@rp/shared';
import { resolveAssetPath } from '@rp/pack';
import type { CommandRunner } from './commands-runner.js';
import type { DisplayBackend } from '../display/backend.js';
import { selectMonitor } from '../display/placement.js';

export interface WallpaperHandlerDeps {
  commands: CommandRunner;
  packs: { getLoaded(packId: string): LoadedPack };
  backend(): DisplayBackend;
  restoreFile(): Promise<string>;
  /** Persist a wallpaper path read before the first `set` (only called while `restoreFile()` is empty). */
  remember?(file: string): Promise<void>;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Pure: the wallpaper path from a "read current wallpaper" command's output — first non-empty
 * line, quotes and a `file://` prefix stripped; `null` when it does not look like a path
 * (Noctalia `color:#…`, an error line, nothing).
 */
export function parseWallpaperPath(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  let value = line.replace(/^['"]+|['"]+$/g, '');
  if (value.startsWith('file://')) value = decodeURIComponent(value.slice('file://'.length));
  if (!value.startsWith('/')) return null;
  return value;
}

export class WallpaperHandler implements CapabilityHandler {
  readonly moduleId = 'wallpaper';
  private current: string | null = null;
  /** The wallpaper read before the first `set` (in-memory copy of what `remember` persisted). */
  private captured: string | null = null;

  constructor(private readonly deps: WallpaperHandlerDeps) {}

  /** The wallpaper `restore()` would put back (for tests and status). */
  get restoreCandidate(): string | null {
    return this.captured;
  }

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'set':
        return this.set(context, args[0], args[1]);
      case 'restore':
        return this.restore();
      case 'current':
        return { asset: this.current };
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.wallpaper.${method}`);
    }
  }

  private async set(context: ActionContext, assetArg: unknown, optionsArg: unknown): Promise<{ asset: string }> {
    if (typeof assetArg !== 'string' || assetArg.length === 0) throw new RpError('INVALID_ARGUMENT', 'asset must be a pack-relative path');
    const pack = this.deps.packs.getLoaded(context.packId);
    const file = resolveAssetPath(pack.root, assetArg);
    const options = optionsArg && typeof optionsArg === 'object' ? (optionsArg as { monitor?: MonitorSelector }) : {};
    let monitor = '';
    if (options.monitor !== undefined && options.monitor !== null) {
      try {
        monitor = selectMonitor(options.monitor, await this.deps.backend().monitors()).name;
      } catch {
        monitor = '';
      }
    }
    await this.captureCurrent(monitor);
    await this.deps.commands.runChecked('wallpaper', { file, monitor });
    this.current = assetArg;
    return { asset: assetArg };
  }

  /**
   * Read the wallpaper the user had before the character's first change, when nothing is
   * configured to restore and a `wallpaperGet` template exists. Never throws: a failed probe
   * just leaves `restore()` to the configured file.
   */
  private async captureCurrent(monitor: string): Promise<void> {
    if (this.current !== null || this.captured !== null) return;
    if ((await this.deps.restoreFile()).trim().length > 0) return;
    if (!(await this.deps.commands.isConfigured('wallpaperGet'))) return;
    try {
      const result = await this.deps.commands.runQuiet('wallpaperGet', { monitor });
      const file = result.code === 0 ? parseWallpaperPath(result.stdout) : null;
      if (!file) return;
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) return;
      this.captured = file;
      this.deps.logger?.info?.(`[wallpaper] remembered the current wallpaper for restore: ${file}`);
      await this.deps.remember?.(file);
    } catch (err) {
      this.deps.logger?.warn?.(`[wallpaper] could not read the current wallpaper: ${(err as Error).message}`);
    }
  }

  private async restore(): Promise<boolean> {
    let file = (await this.deps.restoreFile()).trim();
    if (file.length === 0 && this.captured) file = this.captured;
    if (file.length === 0) return false;
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      throw new RpError('CAPABILITY_FAILED', `The wallpaper restore file does not exist: ${file}; fix it in Settings → Commands → Wallpaper to restore`, { file });
    }
    await this.deps.commands.runChecked('wallpaper', { file, monitor: '' });
    this.current = null;
    return true;
  }
}
