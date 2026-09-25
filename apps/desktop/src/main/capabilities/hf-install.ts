/**
 * Fetching a pinned Hugging Face model, so choosing one is a click rather than an afternoon.
 *
 * Hugging Face serves a repository's files individually rather than as an archive, so there is
 * nothing to unpack; each file goes straight into a staging directory that is renamed into place
 * only once every file is present and the right size. A part-downloaded tree is therefore never
 * visible to whatever scans for installed models, and an interrupted download resumes by skipping
 * the files already there.
 *
 * Sizes are what Hugging Face reports for each file and are the only integrity check available —
 * these repositories publish no checksums — so changing the revision means re-checking every one.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AssetInstallStatus } from '@rp/shared';
import { RpError } from '@rp/shared';
import { downloadArchive } from './archive-install.js';

const HF_BASE = 'https://huggingface.co';

/** One model: where it comes from, what it is called on disk, and every file it needs. */
export interface HfModelSpec {
  /** Directory name under the install root, and the version string in `AssetInstallStatus`. */
  name: string;
  repo: string;
  revision: string;
  label: string;
  files: ReadonlyArray<{ path: string; bytes: number }>;
}

export interface HfInstallerDeps {
  /** Directory the model directory is created in. */
  rootDir: string;
  logger: Pick<Console, 'warn' | 'info' | 'debug'>;
  /** Prefix for this model's log lines (`qwen-model`, `embed-model`). */
  tag: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Total bytes of a model, for a progress report. */
export function modelBytes(spec: HfModelSpec): number {
  return spec.files.reduce((n, f) => n + f.bytes, 0);
}

/** Where one file of a model is served from. */
export function hfFileUrl(spec: HfModelSpec, file: string): string {
  return `${HF_BASE}/${spec.repo}/resolve/${spec.revision}/${file}`;
}

export class HfModelInstaller {
  private state: AssetInstallStatus;
  private job: Promise<string | undefined> | undefined;

  constructor(
    protected readonly spec: HfModelSpec,
    private readonly deps: HfInstallerDeps,
  ) {
    this.state = { state: 'absent', version: spec.name };
  }

  /** Where the model lands, whether or not it is there yet. */
  modelDir(): string {
    return path.join(this.deps.rootDir, this.spec.name);
  }

  status(): AssetInstallStatus {
    return { ...this.state };
  }

  /**
   * Status reconciled with the disk.
   *
   * `status()` only knows what *this process* has done, so a model left by an earlier run — or
   * unpacked by hand — reads as `absent` and the panel offers to download something that is
   * already there. A download in flight, or one that failed, is this process's own business and
   * wins over whatever a half-written staging tree looks like.
   */
  async currentStatus(): Promise<AssetInstallStatus> {
    if (this.state.state === 'downloading' || this.state.state === 'failed') return { ...this.state };
    const dir = await this.installed();
    if (dir) this.state = { state: 'ready', version: this.spec.name, path: dir };
    return { ...this.state };
  }

  /**
   * Mark a download as under way, before any I/O.
   *
   * `ensure()` cannot report anything until it has stat'd every file, and the caller returns to
   * the UI long before that — so without this the click is answered with the state from *before*
   * it, the panel shows no change, and the poll that would have caught up never starts because it
   * only runs while something is downloading.
   */
  begin(): void {
    if (this.state.state === 'ready' || this.state.state === 'downloading') return;
    this.state = { state: 'downloading', version: this.spec.name, received: 0, total: modelBytes(this.spec) };
  }

  /** The model directory, if every file is present at the size it should be. */
  async installed(): Promise<string | undefined> {
    const dir = this.modelDir();
    for (const file of this.spec.files) {
      const stat = await fs.stat(path.join(dir, file.path)).catch(() => undefined);
      if (!stat?.isFile() || stat.size !== file.bytes) return undefined;
    }
    return dir;
  }

  /**
   * Fetch the model unless it is already there. Idempotent and single-flight; resolves to the model
   * directory, or `undefined` on failure. Never throws — this is started from a click and reported
   * through `status()`, so a failed download must not take anything else down.
   */
  async ensure(): Promise<string | undefined> {
    const already = await this.installed();
    if (already) {
      this.state = { state: 'ready', version: this.spec.name, path: already };
      return already;
    }
    this.job ??= this.run().finally(() => {
      this.job = undefined;
    });
    return this.job;
  }

  private async run(): Promise<string | undefined> {
    const target = this.modelDir();
    const staging = `${target}.incoming`;
    const total = modelBytes(this.spec);
    try {
      this.deps.logger.info(`[${this.deps.tag}] fetching ${this.spec.repo} (${Math.round(total / 1e6)} MB)`);
      await fs.mkdir(staging, { recursive: true });

      let done = 0;
      for (const file of this.spec.files) {
        const dest = path.join(staging, file.path);
        // A file already at the right size is one an interrupted run finished; there is no point
        // fetching gigabytes again for the sake of uniformity.
        const have = await fs.stat(dest).catch(() => undefined);
        if (have?.isFile() && have.size === file.bytes) {
          done += file.bytes;
          this.state = { state: 'downloading', version: this.spec.name, received: done, total };
          continue;
        }
        await downloadArchive({ file: file.path, bytes: file.bytes, url: hfFileUrl(this.spec, file.path) }, dest, {
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          onProgress: (received) => {
            this.state = { state: 'downloading', version: this.spec.name, received: done + received, total };
          },
        });
        done += file.bytes;
      }

      // Nothing is visible to the scanner until every file is down, so a half install can never be
      // detected as a model and driven.
      for (const file of this.spec.files) {
        const stat = await fs.stat(path.join(staging, file.path)).catch(() => undefined);
        if (!stat?.isFile() || stat.size !== file.bytes) {
          throw new RpError('CAPABILITY_FAILED', `${file.path} is missing or the wrong size after download`);
        }
      }
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(staging, target);

      this.state = { state: 'ready', version: this.spec.name, path: target };
      this.deps.logger.info(`[${this.deps.tag}] ${this.spec.name} ready at ${target}`);
      return target;
    } catch (err) {
      const message = (err as Error).message;
      // The staging tree is deliberately left in place: it is most of a download, and the next
      // attempt skips whatever finished.
      this.state = { state: 'failed', version: this.spec.name, error: message };
      this.deps.logger.warn(`[${this.deps.tag}] could not install ${this.spec.name}: ${message}`);
      return undefined;
    }
  }
}
