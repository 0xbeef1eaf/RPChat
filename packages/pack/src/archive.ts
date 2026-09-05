import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import type { UnzipFileInfo, Zippable } from 'fflate';
import type { LoadedPack, PackManifest } from '@rp/shared';
import { PACK_MANIFEST_FILENAME, RpError } from '@rp/shared';
import { walkFiles } from './assets.js';
import { isInside, normalizeRelativePath, resolveAssetPath } from './paths.js';
import { loadPack } from './loader.js';
import { validateManifest } from './schema.js';

/** Fixed timestamp for archive entries so packing the same directory twice yields identical bytes. */
const ARCHIVE_MTIME = new Date('2000-01-01T00:00:00Z');

/** Hard caps against decompression bombs and pathological archives. */
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024; // 1 GiB uncompressed

/**
 * Zips a validated pack directory into an `.rppack`. Paths are relative to the
 * pack root; dotfiles, `node_modules`, symlinks and the destination file itself
 * are skipped. Throws `RpError('PACK_INVALID')` when the pack does not validate.
 */
export async function packDirectory(root: string, destinationFile: string): Promise<void> {
  const pack = await loadPack(root);
  const rootAbs = pack.root;
  const destAbs = path.resolve(destinationFile);

  const zippable: Zippable = {};
  for (const rel of await walkFiles(rootAbs, rootAbs)) {
    const abs = path.join(rootAbs, ...rel.split('/'));
    if (abs === destAbs) continue;
    zippable[rel] = [new Uint8Array(await fs.readFile(abs)), { mtime: ARCHIVE_MTIME }];
  }

  const data = zipSync(zippable, { level: 6, mtime: ARCHIVE_MTIME });
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.writeFile(destAbs, data);
}

interface ArchiveListing {
  /** Directory prefix (with trailing slash) that wraps the pack, or `''` when `pack.json` sits at the root. */
  prefix: string;
  /** Archive entry name → validated pack-relative path (forward slashes). */
  entries: Map<string, string>;
}

/**
 * Reads the central directory of an archive (without inflating anything) and
 * validates every entry name. Rejects absolute names, `..` segments in any slash
 * flavour, NUL bytes, oversized archives and archives without a `pack.json`.
 * A single wrapping directory (as produced by zipping a folder) is tolerated;
 * entries outside it are ignored.
 */
function listArchive(data: Uint8Array): ArchiveListing {
  const infos: UnzipFileInfo[] = [];
  let totalBytes = 0;
  unzipSync(data, {
    filter: (info) => {
      infos.push(info);
      totalBytes += info.originalSize;
      return false;
    },
  });

  if (infos.length > MAX_ARCHIVE_ENTRIES) {
    throw new RpError('PACK_INVALID', `Archive has too many entries (${infos.length} > ${MAX_ARCHIVE_ENTRIES})`);
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    throw new RpError('PACK_INVALID', `Archive is too large when extracted (${totalBytes} bytes > ${MAX_ARCHIVE_BYTES})`);
  }

  const fileNames = infos.map((i) => i.name).filter((name) => !name.endsWith('/'));

  const bad: string[] = [];
  for (const name of fileNames) {
    if (!normalizeRelativePath(name).ok) bad.push(name);
  }
  if (bad.length > 0) {
    throw new RpError('PACK_INVALID', `Archive contains unsafe entry paths: ${bad.map((b) => JSON.stringify(b)).join(', ')}`, {
      entries: bad,
    });
  }

  let prefix = '';
  if (!fileNames.includes(PACK_MANIFEST_FILENAME)) {
    const wrapped = fileNames.filter((name) => {
      const n = normalizeRelativePath(name);
      return n.ok && /^[^/]+\/pack\.json$/.test(n.path);
    });
    if (wrapped.length !== 1) {
      throw new RpError('PACK_INVALID', `Archive does not contain ${PACK_MANIFEST_FILENAME} at its root`);
    }
    const [only] = wrapped;
    prefix = only!.slice(0, only!.length - PACK_MANIFEST_FILENAME.length);
  }

  const entries = new Map<string, string>();
  const seen = new Set<string>();
  for (const name of fileNames) {
    if (prefix !== '' && !name.startsWith(prefix)) continue;
    const n = normalizeRelativePath(name.slice(prefix.length));
    if (!n.ok) continue; // e.g. the prefix directory entry itself
    if (seen.has(n.path)) {
      throw new RpError('PACK_INVALID', `Archive contains duplicate entry "${n.path}"`);
    }
    seen.add(n.path);
    entries.set(name, n.path);
  }
  return { prefix, entries };
}

/**
 * Extracts an `.rppack` into `destinationDir` and loads it. Zip-slip safe: every
 * entry is validated before anything is written, and each target path is
 * re-checked (including symlinked ancestors) against the destination directory.
 */
export async function extractPack(file: string, destinationDir: string): Promise<LoadedPack> {
  const data = new Uint8Array(await fs.readFile(file));
  const { entries } = listArchive(data);
  const destAbs = path.resolve(destinationDir);
  await fs.mkdir(destAbs, { recursive: true });

  const wanted = new Set(entries.keys());
  const unzipped = unzipSync(data, { filter: (info) => wanted.has(info.name) });

  for (const [name, rel] of entries) {
    const bytes = unzipped[name];
    if (!bytes) throw new RpError('PACK_INVALID', `Archive entry "${name}" could not be read`);
    const target = resolveAssetPath(destAbs, rel);
    if (!isInside(destAbs, target)) {
      throw new RpError('PATH_ESCAPE', `Archive entry "${name}" escapes the destination directory`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  return loadPack(destAbs);
}

/** Reads and validates `pack.json` from an `.rppack` without extracting it. */
export async function readManifestFromArchive(file: string): Promise<PackManifest> {
  const data = new Uint8Array(await fs.readFile(file));
  const { prefix } = listArchive(data);
  const entryName = `${prefix}${PACK_MANIFEST_FILENAME}`;
  const unzipped = unzipSync(data, { filter: (info) => info.name === entryName });
  const bytes = unzipped[entryName];
  if (!bytes) throw new RpError('PACK_INVALID', `Archive does not contain ${PACK_MANIFEST_FILENAME}`);
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch (err) {
    throw new RpError('PACK_INVALID', `${PACK_MANIFEST_FILENAME} in archive is not valid JSON: ${(err as Error).message}`);
  }
  return validateManifest(json);
}
