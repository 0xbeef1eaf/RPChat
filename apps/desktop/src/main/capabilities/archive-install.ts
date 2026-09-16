/**
 * Fetching and unpacking one pinned upstream archive, shared by the speech engine installer and the
 * voice model installer. Both pull a `.tar.bz2` from a GitHub release, want only part of it, and
 * must never leave a half install behind for the next start to trust.
 *
 * Neither release publishes checksums, so the size GitHub reports for the asset is recorded
 * alongside the URL and verified after the download — the only integrity signal available.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RpError } from '@rp/shared';
import type { CommandResult } from '../commands.js';
import { spawnCapture } from '../commands.js';

/** Cap for one download. A 100 MB model on a slow line still fits comfortably. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Cap for unpacking, which is CPU-bound bzip2 over up to a few hundred MB. */
export const EXTRACT_TIMEOUT_MS = 10 * 60_000;

export type SpawnFn = (file: string, args: string[], opts: { timeoutMs?: number }) => Promise<CommandResult>;

/** One release asset: where it lives and how big upstream says it is. */
export interface ArchiveSpec {
  file: string;
  bytes: number;
  url: string;
}

/**
 * `tar` arguments for unpacking `archive` into `dest`.
 *
 * `-xf` rather than `-xjf`: both GNU tar and bsdtar detect bzip2 from the file's magic, and bsdtar
 * (macOS, and Windows since 1803) has no `-j`. GNU tar needs `--wildcards` before the patterns to
 * treat them as globs; bsdtar globs extraction patterns by default and rejects the flag. With no
 * patterns the whole archive comes out and `--wildcards` is pointless, so it is left off.
 */
export function tarArgsFor(platform: NodeJS.Platform, archive: string, dest: string, strip: number, patterns: string[] = []): string[] {
  const wildcards = platform === 'linux' && patterns.length > 0 ? ['--wildcards'] : [];
  return ['-xf', archive, '-C', dest, `--strip-components=${strip}`, ...wildcards, ...patterns];
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  /** Called as bytes arrive, so a caller can surface progress. */
  onProgress?(received: number, total: number): void;
  timeoutMs?: number;
}

/** Fetch `spec` to `target`, checking it is the size upstream published. */
export async function downloadArchive(spec: ArchiveSpec, target: string, opts: DownloadOptions = {}): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  opts.onProgress?.(0, spec.bytes);
  const res = await doFetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new RpError('CAPABILITY_FAILED', `HTTP ${res.status} fetching ${spec.file}`);

  const chunks: Buffer[] = [];
  let received = 0;
  if (res.body) {
    // Read incrementally so progress can be shown on a slow connection.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      received += buf.byteLength;
      if (received > spec.bytes * 2) throw new RpError('CAPABILITY_FAILED', `${spec.file} is far larger than the ${spec.bytes} bytes upstream published`);
      chunks.push(buf);
      opts.onProgress?.(received, spec.bytes);
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  const body = Buffer.concat(chunks);
  if (body.byteLength !== spec.bytes) {
    throw new RpError('CAPABILITY_FAILED', `${spec.file} is ${body.byteLength} bytes, expected ${spec.bytes}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

export interface UnpackOptions extends DownloadOptions {
  spec: ArchiveSpec;
  /** Directory the unpacked tree ends up as, renamed into place once it is complete. */
  target: string;
  /** Where the `.part` archive and the staging directory live. */
  workDir: string;
  platform: NodeJS.Platform;
  /** Leading path components to drop; the release archives wrap everything in one directory. */
  strip: number;
  /** Extraction globs; empty unpacks the whole archive. */
  patterns?: string[];
  /** Called once the bytes are down and `tar` is running. */
  onExtract?(): void;
  /** Throw from here to reject an archive that unpacked without what the caller needs. */
  verify?(stagingDir: string): Promise<void>;
  spawn?: SpawnFn;
}

/**
 * Download, unpack and move into place as one step. The unpacked tree is built in a sibling
 * `.incoming` directory and renamed over `target` only once `verify` is happy, so a crash or a
 * broken archive can never leave something a later `installed()` check would trust.
 */
export async function downloadAndUnpack(opts: UnpackOptions): Promise<void> {
  const staging = `${opts.target}.incoming`;
  const archive = path.join(opts.workDir, `${opts.spec.file}.part`);
  try {
    await fs.mkdir(opts.workDir, { recursive: true });
    await downloadArchive(opts.spec, archive, opts);

    opts.onExtract?.();
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const spawnFn = opts.spawn ?? ((f, a, o) => spawnCapture(f, a, o));
    const result = await spawnFn('tar', tarArgsFor(opts.platform, archive, staging, opts.strip, opts.patterns), { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new RpError('CAPABILITY_FAILED', `tar exited with ${result.code}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 300)}`);
    }
    await opts.verify?.(staging);

    await fs.rm(opts.target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(opts.target), { recursive: true });
    await fs.rename(staging, opts.target);
    await fs.rm(archive, { force: true });
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(archive, { force: true }).catch(() => undefined);
    throw err;
  }
}
