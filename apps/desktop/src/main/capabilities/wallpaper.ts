/** `sdk.wallpaper`: runs the user's wallpaper command template with a pack image. */
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
}

export class WallpaperHandler implements CapabilityHandler {
  readonly moduleId = 'wallpaper';
  private current: string | null = null;

  constructor(private readonly deps: WallpaperHandlerDeps) {}

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
    const result = await this.deps.commands.run('wallpaper', { file, monitor }, 'wallpaper');
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `Wallpaper command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.current = assetArg;
    return { asset: assetArg };
  }

  private async restore(): Promise<boolean> {
    const file = (await this.deps.restoreFile()).trim();
    if (file.length === 0) return false;
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      throw new RpError('CAPABILITY_FAILED', `Wallpaper restore file does not exist: ${file}`);
    }
    const result = await this.deps.commands.run('wallpaper', { file, monitor: '' }, 'wallpaper');
    if (result.code !== 0) throw new RpError('CAPABILITY_FAILED', `Wallpaper command exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.current = null;
    return true;
  }
}
