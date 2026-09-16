import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { extractPack, inspectPack, loadPack, packDirectory, readCharacterLibrary, readManifestFromArchive, writeLibraryFunction } from '@rp/pack';
import type {
  CharacterLibraryEntry,
  CharacterSummary,
  InstalledPackRecord,
  InstalledPackView,
  LoadedCharacter,
  LoadedPack,
  PackInspection,
  PackManifest,
  Storage,
} from '@rp/shared';
import { LIB_NAME_PATTERN, PACK_FILE_EXTENSION, RpError, assetUrl, characterRef, parseCharacterRef } from '@rp/shared';
import { showableAssets, summariseTags } from '../assets.js';
import { characterScope } from '../handlers/state.js';
import { LIB_STATE_KEY } from './library.js';
import type { TimerService } from './timers.js';
import type { Clock, Logger } from '../types.js';

/** Runs the `onInstall` behaviour of a freshly installed pack's character. */
export type InstallHookRunner = (pack: LoadedPack) => Promise<void>;

/**
 * State scope older versions used to park an `onInstall` deferred until per-pack grants were
 * complete. Grants are gone (permissions are app-wide), so `start()` runs a hook still parked
 * there once and clears the scope; nothing writes to it any more.
 */
const INSTALL_STATE_SCOPE = (packId: string): string => `pack:${packId}`;
const LEGACY_INSTALL_PENDING_KEY = 'onInstallPending';

async function pathKind(p: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

function countByKind(pack: LoadedPack): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of pack.assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return counts;
}

/** Copy a pack directory, skipping dotfiles, `node_modules` and symlinks. */
async function copyPackDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    filter: async (source) => {
      const base = path.basename(source);
      if (source !== src && (base.startsWith('.') || base === 'node_modules')) return false;
      try {
        return !(await fs.lstat(source)).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

/**
 * Installed packs: copies/extracts sources into `<packsDir>/<id>/<version>/`,
 * keeps the `InstalledPackRecord`s, and caches every `LoadedPack`.
 */
export class PackService {
  private readonly loaded = new Map<string, LoadedPack>();
  private readonly changeListeners = new Set<(packId: string) => void | Promise<void>>();
  private installHooks: InstallHookRunner | undefined;

  constructor(
    private readonly storage: Pick<Storage, 'packs' | 'state'>,
    private readonly packsDir: string,
    private readonly timers: TimerService,
    private readonly now: Clock,
    private readonly logger: Logger,
  ) {}

  /** Wired by the Engine: how to run the `onInstall` behaviour (right after install, once). */
  setInstallHookRunner(runner: InstallHookRunner): void {
    this.installHooks = runner;
  }

  /** Called after a pack was installed, replaced or uninstalled. */
  onPacksChanged(listener: (packId: string) => void | Promise<void>): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private async notifyChanged(packId: string): Promise<void> {
    for (const listener of this.changeListeners) {
      try {
        await listener(packId);
      } catch (err) {
        this.logger.warn('[packs] change listener failed', err);
      }
    }
  }

  /** Load every installed pack from disk. Broken installs are logged and skipped. */
  async start(): Promise<void> {
    for (const record of await this.storage.packs.list()) {
      try {
        const pack = await this.loadInstalled(record.root);
        this.loaded.set(record.packId, pack);
        await this.migrateLibraryState(pack);
        await this.runLegacyPendingInstallHook(pack);
      } catch (err) {
        this.logger.error(`[packs] cannot load installed pack ${record.packId} at ${record.root}`, err);
      }
    }
  }

  /** An `onInstall` a previous version parked behind per-pack grants runs now, once. */
  private async runLegacyPendingInstallHook(pack: LoadedPack): Promise<void> {
    const scope = INSTALL_STATE_SCOPE(pack.manifest.id);
    const pending = await this.storage.state.get(scope, LEGACY_INSTALL_PENDING_KEY);
    if (pending === undefined) return;
    await this.storage.state.clear(scope);
    if (pending === true && this.installHooks && pack.characters.some((c) => c.behaviourSources.onInstall !== undefined)) {
      this.logger.info(`[packs] ${pack.manifest.id}: running the onInstall hook an earlier version left pending`);
      await this.installHooks(pack);
    }
  }

  /**
   * Rescan `characters/<id>/lib/*.ts` of an installed pack and swap the result
   * into the loaded character (`LibraryService` calls this after writing or
   * deleting a function file). Files the scan skips are logged; cap violations
   * throw `PACK_INVALID` and leave the previous library in place.
   */
  async reloadCharacterLibrary(packId: string): Promise<Record<string, CharacterLibraryEntry>> {
    const pack = this.getLoaded(packId);
    const character = pack.character;
    const scan = await readCharacterLibrary(pack.root, character.dir, { previous: character.library });
    for (const skipped of scan.skipped) this.logger.warn(`[packs] ${packId}: ${skipped.file}: ${skipped.message}`);
    if (scan.problems.length > 0) {
      throw new RpError('PACK_INVALID', `The function library of ${packId} is over its limits:\n${scan.problems.join('\n')}`, { packId, problems: scan.problems });
    }
    character.library = scan.library;
    return scan.library;
  }

  /**
   * Older versions kept `lib` functions in the character state under
   * `lib.functions`; they now live in the pack as `characters/<id>/lib/<name>.ts`.
   * Write every stored function to a file (a name that already has a file is
   * left alone: the file wins), drop the state key, and rescan.
   */
  private async migrateLibraryState(pack: LoadedPack): Promise<void> {
    for (const character of pack.characters) {
      const scope = characterScope({ packId: pack.manifest.id, characterId: character.definition.id });
      const raw = await this.storage.state.get(scope, LIB_STATE_KEY);
      if (raw === undefined) continue;
      const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
      let written = 0;
      let kept = 0;
      for (const [name, value] of entries) {
        const fn = value as { source?: unknown; description?: unknown } | null;
        if (!fn || typeof fn !== 'object' || typeof fn.source !== 'string' || !LIB_NAME_PATTERN.test(name)) continue;
        const target = path.join(pack.root, ...character.dir.split('/'), 'lib', `${name}.ts`);
        if (await pathKind(target) !== 'missing') {
          kept += 1;
          continue;
        }
        try {
          await writeLibraryFunction(pack.root, character.dir, name, fn.source, typeof fn.description === 'string' ? fn.description : undefined);
          written += 1;
        } catch (err) {
          this.logger.warn(`[packs] ${pack.manifest.id}: could not migrate lib.${name} to a file`, err);
        }
      }
      await this.storage.state.delete(scope, LIB_STATE_KEY);
      this.logger.info(`[packs] ${pack.manifest.id}/${character.definition.id}: moved ${written} library function(s) from state into ${character.dir}/lib/${kept > 0 ? ` (${kept} already had a file)` : ''}`);
      if (written > 0) {
        try {
          await this.reloadCharacterLibrary(pack.manifest.id);
        } catch (err) {
          this.logger.warn(`[packs] ${pack.manifest.id}: library rescan after migration failed`, err);
        }
      }
    }
  }

  // ---- queries ------------------------------------------------------------

  getLoaded(packId: string): LoadedPack {
    const pack = this.loaded.get(packId);
    if (!pack) throw new RpError('NOT_FOUND', `Pack "${packId}" is not installed`, { packId });
    return pack;
  }

  tryGetLoaded(packId: string): LoadedPack | undefined {
    return this.loaded.get(packId);
  }

  /** Resolve `packId/characterId`. Throws `NOT_FOUND` when either is missing. */
  getCharacter(ref: string): { pack: LoadedPack; character: LoadedCharacter } {
    let parsed: { packId: string; characterId: string };
    try {
      parsed = parseCharacterRef(ref);
    } catch (err) {
      throw new RpError('INVALID_ARGUMENT', (err as Error).message, { ref });
    }
    const pack = this.getLoaded(parsed.packId);
    const character = pack.characters.find((c) => c.definition.id === parsed.characterId);
    if (!character) {
      throw new RpError('NOT_FOUND', `Character "${parsed.characterId}" does not exist in pack ${parsed.packId}`, { ref });
    }
    return { pack, character };
  }

  characters(): CharacterSummary[] {
    const out: CharacterSummary[] = [];
    for (const pack of this.loaded.values()) {
      for (const c of pack.characters) {
        const summary: CharacterSummary = {
          ref: characterRef(pack.manifest.id, c.definition.id),
          packId: pack.manifest.id,
          packName: pack.manifest.name,
          characterId: c.definition.id,
          name: c.definition.name,
        };
        if (c.definition.tagline !== undefined) summary.tagline = c.definition.tagline;
        if (c.avatarPath !== undefined) summary.avatarUrl = assetUrl(pack.manifest.id, c.avatarPath);
        out.push(summary);
      }
    }
    return out;
  }

  async list(): Promise<InstalledPackView[]> {
    const views: InstalledPackView[] = [];
    for (const record of await this.storage.packs.list()) {
      const view = await this.viewFor(record);
      if (view) views.push(view);
    }
    return views;
  }

  async view(packId: string): Promise<InstalledPackView> {
    const record = await this.storage.packs.get(packId);
    const view = record ? await this.viewFor(record) : undefined;
    if (!view) throw new RpError('NOT_FOUND', `Pack "${packId}" is not installed`, { packId });
    return view;
  }

  private async viewFor(record: InstalledPackRecord): Promise<InstalledPackView | undefined> {
    const pack = this.loaded.get(record.packId);
    if (!pack) return undefined;
    const view: InstalledPackView = {
      ...record,
      manifest: pack.manifest,
      characters: this.characters().filter((c) => c.packId === record.packId),
      assetTags: summariseTags(showableAssets(pack.assets), pack.tagDescriptions ?? {}),
      assetCounts: countByKind(pack),
    };
    if (pack.readme !== undefined) view.readme = pack.readme;
    return view;
  }

  // ---- install / uninstall -------------------------------------------------

  async install(sourcePath: string): Promise<InstalledPackView> {
    const source = path.resolve(sourcePath);
    const kind = await pathKind(source);
    if (kind === 'missing') throw new RpError('NOT_FOUND', `Install source "${source}" does not exist`, { source });

    // 1. Read + validate the manifest before touching the packs directory.
    let manifest: PackManifest;
    if (kind === 'dir') manifest = (await loadPack(source)).manifest;
    else {
      if (!source.toLowerCase().endsWith(PACK_FILE_EXTENSION) && !source.toLowerCase().endsWith('.zip')) {
        throw new RpError('PACK_INVALID', `Install source must be a directory or a ${PACK_FILE_EXTENSION} file`, { source });
      }
      manifest = await readManifestFromArchive(source);
    }

    // 2. Materialise into <packsDir>/<id>/<version>/ (staging dir + rename).
    const dest = path.join(this.packsDir, manifest.id, manifest.version);
    const staging = `${dest}.${randomBytes(4).toString('hex')}.installing`;
    let pack: LoadedPack;
    if (kind === 'dir' && source === dest) {
      pack = await this.loadInstalled(dest);
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        if (kind === 'dir') {
          await copyPackDir(source, staging);
          pack = await loadPack(staging);
        } else {
          pack = await extractPack(source, staging);
        }
        await fs.rm(dest, { recursive: true, force: true });
        await fs.rename(staging, dest);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      pack = await this.loadInstalled(dest);
    }

    // 3. Replace a previous install of the same id.
    const previous = await this.storage.packs.get(manifest.id);
    if (previous && path.resolve(previous.root) !== path.resolve(dest) && this.isInsidePacksDir(previous.root)) {
      await fs.rm(previous.root, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(`[packs] could not remove previous version at ${previous.root}`, err);
      });
    }

    const record: InstalledPackRecord = {
      packId: manifest.id,
      version: manifest.version,
      name: manifest.name,
      root: pack.root,
      installedAt: this.now().toISOString(),
      characterIds: pack.characters.map((c) => c.definition.id),
    };
    await this.storage.packs.upsert(record);
    this.loaded.set(manifest.id, pack);
    await this.migrateLibraryState(pack);
    await this.storage.state.clear(INSTALL_STATE_SCOPE(manifest.id));
    await this.notifyChanged(manifest.id);

    // 4. The onInstall hook runs right now, once: permissions are app-wide, so nothing is ever pending.
    if (this.installHooks && pack.characters.some((c) => c.behaviourSources.onInstall !== undefined)) {
      await this.installHooks(pack);
    }

    return this.view(manifest.id);
  }

  async uninstall(packId: string): Promise<void> {
    const record = await this.storage.packs.get(packId);
    if (!record) throw new RpError('NOT_FOUND', `Pack "${packId}" is not installed`, { packId });
    this.loaded.delete(packId);
    await this.storage.packs.remove(packId);
    await this.timers.removeForPack(packId);
    await this.storage.state.clear(INSTALL_STATE_SCOPE(packId));
    if (this.isInsidePacksDir(record.root)) {
      await fs.rm(record.root, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(`[packs] could not remove ${record.root}`, err);
      });
      const idDir = path.join(this.packsDir, packId);
      const remaining = await fs.readdir(idDir).catch(() => null);
      if (remaining && remaining.length === 0) await fs.rm(idDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.notifyChanged(packId);
  }

  /** Read a pack directory or `.rppack` without installing it and report what it contains. */
  async inspect(sourcePath: string): Promise<PackInspection> {
    const source = path.resolve(sourcePath);
    const kind = await pathKind(source);
    if (kind === 'missing') throw new RpError('NOT_FOUND', `Pack source "${source}" does not exist`, { source });
    let pack: LoadedPack;
    let tempDir: string | undefined;
    try {
      if (kind === 'dir') pack = await loadPack(source);
      else {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-inspect-'));
        pack = await extractPack(source, tempDir);
      }
      const assetCounts = countByKind(pack);
      const inspection: PackInspection = {
        manifest: pack.manifest,
        characters: pack.characters.map((c) => {
          const entry: PackInspection['characters'][number] = { id: c.definition.id, name: c.definition.name };
          if (c.definition.tagline !== undefined) entry.tagline = c.definition.tagline;
          return entry;
        }),
        assetCounts,
        assetTags: summariseTags(showableAssets(pack.assets), pack.tagDescriptions ?? {}),
      };
      if (pack.readme !== undefined) inspection.readme = pack.readme;
      return inspection;
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async exportPack(packId: string, destinationFile: string): Promise<void> {
    const pack = this.getLoaded(packId);
    await packDirectory(pack.root, destinationFile);
  }

  // ---- helpers ------------------------------------------------------------

  private isInsidePacksDir(p: string): boolean {
    const root = path.resolve(this.packsDir);
    const abs = path.resolve(p);
    return abs !== root && abs.startsWith(root + path.sep);
  }

  /**
   * `loadPack` plus its non-fatal warnings in the log, so authors notice e.g. a legacy
   * `capabilities` key (ignored: permissions are app-wide, Settings → Permissions).
   */
  private async loadInstalled(root: string): Promise<LoadedPack> {
    const { pack, problems, warnings } = await inspectPack(root);
    if (!pack) throw new RpError('PACK_INVALID', `Invalid pack at ${path.resolve(root)}:\n${problems.join('\n')}`, { problems });
    for (const w of warnings) this.logger.warn(`[packs] ${pack.manifest.id}: ${w}`);
    return pack;
  }
}
