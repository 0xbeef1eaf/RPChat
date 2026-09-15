/**
 * Fetching the speech engine so voices work without the user installing anything.
 *
 * `sherpa-onnx-offline-tts` is ~25 MB compressed per platform, which is too much to vendor into the
 * installer for a feature most users will never turn on. Instead the app fetches a pinned upstream
 * build on first start, into `<userData>/sherpa/<version>/`. An engine the user already has — via
 * `RP_SHERPA_TTS`, the app's `resources/bin`, or PATH — is always preferred and nothing is fetched.
 *
 * The upstream `-shared` archives set `RPATH=$ORIGIN/../lib`, so keeping the `bin/` + `lib/` layout
 * means the binary finds `libonnxruntime.so` on its own: no `LD_LIBRARY_PATH` at spawn time.
 *
 * Everything that decides *what* to fetch and *how* to unpack it is pure and table-driven, so the
 * per-platform choices are testable on any one platform.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SherpaInstallStatus } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CommandResult } from '../commands.js';
import { spawnCapture } from '../commands.js';
import { SHERPA_TTS_BINARY } from './voice-models.js';

/**
 * Pinned upstream release. Bumping it changes `assetFor`'s expected sizes too — they are the only
 * integrity check available, since the release publishes no checksums.
 */
export const SHERPA_VERSION = 'v1.13.8';

/** Directory under `userData` holding managed engine installs, one subdirectory per version. */
export const SHERPA_INSTALL_DIRNAME = 'sherpa';

/** Cap for the download; a 25 MB file on a slow line still fits comfortably. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Cap for unpacking, which is CPU-bound bzip2 over ~30 MB. */
export const EXTRACT_TIMEOUT_MS = 5 * 60_000;

const RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/**
 * Release asset per platform and architecture, with the size GitHub reports for it.
 *
 * All are `-shared` builds: the `-static` ones are ten times the size for no benefit here. Windows
 * uses the `MT-Release` build, which is the one that does not need a Visual C++ redistributable.
 */
const ASSETS: Record<string, { file: string; bytes: number }> = {
  'linux-x64': { file: `sherpa-onnx-${SHERPA_VERSION}-linux-x64-shared.tar.bz2`, bytes: 28_156_791 },
  'linux-arm64': { file: `sherpa-onnx-${SHERPA_VERSION}-linux-aarch64-shared-cpu.tar.bz2`, bytes: 28_091_778 },
  'darwin-arm64': { file: `sherpa-onnx-${SHERPA_VERSION}-osx-arm64-shared.tar.bz2`, bytes: 20_314_448 },
  'darwin-x64': { file: `sherpa-onnx-${SHERPA_VERSION}-osx-x64-shared.tar.bz2`, bytes: 22_846_038 },
  'win32-x64': { file: `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared-MT-Release.tar.bz2`, bytes: 24_805_859 },
  'win32-arm64': { file: `sherpa-onnx-${SHERPA_VERSION}-win-arm64-shared-MT-Release.tar.bz2`, bytes: 23_341_583 },
};

export interface SherpaAsset {
  file: string;
  bytes: number;
  url: string;
}

/** The release asset for a platform/architecture pair, or `undefined` when upstream publishes none. */
export function assetFor(platform: NodeJS.Platform, arch: string): SherpaAsset | undefined {
  const entry = ASSETS[`${platform}-${arch}`];
  if (!entry) return undefined;
  return { ...entry, url: `${RELEASE_BASE}/${SHERPA_VERSION}/${entry.file}` };
}

/** Name of the executable inside the archive (Windows ships it with an extension). */
export function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${SHERPA_TTS_BINARY}.exe` : SHERPA_TTS_BINARY;
}

/**
 * `tar` arguments that unpack only the TTS binary and the shared libraries it links against —
 * roughly 34 MB, against ~150 MB for the whole archive of forty-odd demo executables.
 *
 * `-xf` rather than `-xjf`: both GNU tar and bsdtar detect bzip2 from the file's magic, and bsdtar
 * (macOS, and Windows since 1803) has no `-j`. GNU tar needs `--wildcards` before the patterns to
 * treat them as globs; bsdtar globs extraction patterns by default and rejects the flag.
 */
export function tarArgs(platform: NodeJS.Platform, archive: string, dest: string): string[] {
  const patterns = [`*/bin/${binaryName(platform)}`, '*/lib/*'];
  const wildcards = platform === 'linux' ? ['--wildcards'] : [];
  return ['-xf', archive, '-C', dest, '--strip-components=1', ...wildcards, ...patterns];
}

export interface SherpaInstallerDeps {
  /** `<userData>/sherpa`. */
  dir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  spawn?: (file: string, args: string[], opts: { timeoutMs?: number }) => Promise<CommandResult>;
}

export class SherpaInstaller {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private state: SherpaInstallStatus;
  private job: Promise<string | undefined> | undefined;

  constructor(private readonly deps: SherpaInstallerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.state = { state: assetFor(this.platform, this.arch) ? 'absent' : 'unsupported', version: SHERPA_VERSION };
  }

  /** Where the managed binary lives, whether or not it has been installed yet. */
  binaryPath(): string {
    return path.join(this.deps.dir, SHERPA_VERSION, 'bin', binaryName(this.platform));
  }

  status(): SherpaInstallStatus {
    return { ...this.state };
  }

  /** Report an engine found elsewhere, so the status says `present` instead of `absent`. */
  markPresent(at: string): void {
    this.state = { state: 'present', version: SHERPA_VERSION, path: at };
  }

  markDisabled(): void {
    if (this.state.state !== 'ready' && this.state.state !== 'present') this.state = { state: 'disabled', version: SHERPA_VERSION };
  }

  /** The managed binary if it is already unpacked and executable, else `undefined`. */
  async installed(): Promise<string | undefined> {
    const file = this.binaryPath();
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0) return undefined;
      if (this.platform !== 'win32') await fs.access(file, (await import('node:fs')).constants.X_OK);
      return file;
    } catch {
      return undefined;
    }
  }

  /**
   * Install the engine if it is not already there. Idempotent and single-flight: concurrent callers
   * share one download. Resolves to the binary path, or `undefined` when it could not be installed
   * — never throws, because this runs in the background at startup and a failure to fetch an
   * optional engine must not take the app down with it.
   */
  async ensure(): Promise<string | undefined> {
    const already = await this.installed();
    if (already) {
      this.state = { state: 'ready', version: SHERPA_VERSION, path: already };
      return already;
    }
    this.job ??= this.run().finally(() => {
      this.job = undefined;
    });
    return this.job;
  }

  private async run(): Promise<string | undefined> {
    const asset = assetFor(this.platform, this.arch);
    if (!asset) {
      this.state = { state: 'unsupported', version: SHERPA_VERSION };
      this.deps.logger.warn(`[sherpa] no ${SHERPA_VERSION} build is published for ${this.platform}-${this.arch}; install ${SHERPA_TTS_BINARY} yourself to use neural voices`);
      return undefined;
    }
    const versionDir = path.join(this.deps.dir, SHERPA_VERSION);
    const stagingDir = `${versionDir}.incoming`;
    const archive = path.join(this.deps.dir, `${asset.file}.part`);
    try {
      this.deps.logger.info(`[sherpa] fetching ${asset.file} (${Math.round(asset.bytes / 1e6)} MB)`);
      await fs.mkdir(this.deps.dir, { recursive: true });
      await this.download(asset, archive);

      this.state = { state: 'extracting', version: SHERPA_VERSION };
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      const spawnFn = this.deps.spawn ?? ((f, a, o) => spawnCapture(f, a, o));
      const result = await spawnFn('tar', tarArgs(this.platform, archive, stagingDir), { timeoutMs: EXTRACT_TIMEOUT_MS });
      if (result.code !== 0) {
        throw new RpError('CAPABILITY_FAILED', `tar exited with ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 300)}`);
      }

      const staged = path.join(stagingDir, 'bin', binaryName(this.platform));
      const stat = await fs.stat(staged).catch(() => undefined);
      if (!stat?.isFile()) throw new RpError('CAPABILITY_FAILED', `the archive did not contain bin/${binaryName(this.platform)}`);
      if (this.platform !== 'win32') await fs.chmod(staged, 0o755);

      // Swap in whole, so a crash mid-unpack never leaves a half install that `installed()` trusts.
      await fs.rm(versionDir, { recursive: true, force: true });
      await fs.rename(stagingDir, versionDir);
      await fs.rm(archive, { force: true });

      const file = this.binaryPath();
      this.state = { state: 'ready', version: SHERPA_VERSION, path: file };
      this.deps.logger.info(`[sherpa] ${SHERPA_VERSION} ready at ${file}`);
      return file;
    } catch (err) {
      const message = (err as Error).message;
      this.state = { state: 'failed', version: SHERPA_VERSION, error: message };
      this.deps.logger.warn(`[sherpa] could not install ${SHERPA_VERSION}: ${message}`);
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(archive, { force: true }).catch(() => undefined);
      return undefined;
    }
  }

  /** Stream the archive to `target`, reporting progress and checking the size upstream published. */
  private async download(asset: SherpaAsset, target: string): Promise<void> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    this.state = { state: 'downloading', version: SHERPA_VERSION, received: 0, total: asset.bytes };
    const res = await doFetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new RpError('CAPABILITY_FAILED', `HTTP ${res.status} fetching ${asset.file}`);

    const chunks: Buffer[] = [];
    let received = 0;
    if (res.body) {
      // Read incrementally so the status can show progress on a slow connection.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        received += buf.byteLength;
        if (received > asset.bytes * 2) throw new RpError('CAPABILITY_FAILED', `${asset.file} is far larger than the ${asset.bytes} bytes upstream published`);
        chunks.push(buf);
        this.state = { state: 'downloading', version: SHERPA_VERSION, received, total: asset.bytes };
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      received = buf.byteLength;
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    // The release publishes no checksums, so the size is the only integrity signal available.
    if (body.byteLength !== asset.bytes) {
      throw new RpError('CAPABILITY_FAILED', `${asset.file} is ${body.byteLength} bytes, expected ${asset.bytes}`);
    }
    await fs.writeFile(target, body);
  }
}
