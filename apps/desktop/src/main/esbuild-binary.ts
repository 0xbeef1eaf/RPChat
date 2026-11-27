/**
 * Point esbuild at the unpacked platform binary inside a packaged app.
 *
 * esbuild spawns its platform binary from `node_modules/@esbuild/<platform>-<arch>/…`, which
 * cannot be executed from inside `app.asar` (`spawn ENOTDIR`). `electron-builder`'s `asarUnpack`
 * places a runnable copy under `app.asar.unpacked`, and esbuild snapshots
 * `process.env.ESBUILD_BINARY_PATH` once when its module is first required — so this runs at
 * startup before any lazy `esbuild` load (`@rp/pack`, `@rp/sandbox`, `editor/service.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ConfigureEsbuildOptions {
  isPackaged: boolean;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: (p: string) => boolean;
}

/** Expected path to the unpacked esbuild binary for a platform/arch under `resourcesPath`. */
export function unpackedEsbuildBinaryPath(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const platformKey = `${platform}-${arch}`;
  const subpath = platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  return path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', platformKey, subpath);
}

/**
 * Sets `env.ESBUILD_BINARY_PATH` to the unpacked binary when running packaged and no override is
 * already set. Returns the configured path when set, or `undefined` when left unchanged.
 */
export function configureEsbuildBinary(opts: ConfigureEsbuildOptions): string | undefined {
  const env = opts.env ?? process.env;
  if (env.ESBUILD_BINARY_PATH || !opts.isPackaged) return undefined;
  const candidate = unpackedEsbuildBinaryPath(opts.resourcesPath, opts.platform, opts.arch);
  const exists = opts.existsSync ?? fs.existsSync;
  if (!exists(candidate)) return undefined;
  env.ESBUILD_BINARY_PATH = candidate;
  return candidate;
}
