import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CapabilityRegistry } from '@rp/sdk';
import { extractPack, loadPack, packDirectory, readManifestFromArchive, requestedCapabilities } from '@rp/pack';
import type {
  CharacterSummary,
  InstalledPackRecord,
  InstalledPackView,
  LoadedCharacter,
  LoadedPack,
  PackManifest,
  Storage,
} from '@rp/shared';
import { PACK_FILE_EXTENSION, RpError, assetUrl, characterRef, parseCharacterRef } from '@rp/shared';
import type { PermissionService } from './permissions.js';
import type { TimerService } from './timers.js';
import type { Clock, Logger } from '../types.js';

/** Runs the `onInstall` behaviours of every character of a freshly installed pack. */
export type InstallHookRunner = (pack: LoadedPack) => Promise<void>;

const INSTALL_STATE_SCOPE = (packId: string): string => `pack:${packId}`;
const INSTALL_PENDING_KEY = 'onInstallPending';

async function pathKind(p: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
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
  private readonly installChecks = new Map<string, Promise<boolean>>();
  private installHooks: InstallHookRunner | undefined;

  constructor(
    private readonly storage: Pick<Storage, 'packs' | 'state'>,
    private readonly packsDir: string,
    private readonly registry: CapabilityRegistry,
    private readonly permissions: PermissionService,
    private readonly timers: TimerService,
    private readonly now: Clock,
    private readonly logger: Logger,
  ) {
    this.permissions.onGrantsChanged((packId) => {
      void this.maybeRunInstallHooks(packId).catch((err) => this.logger.error('[packs] deferred onInstall failed', err));
    });
  }

  /** Wired by the Engine: how to run `onInstall` behaviours. */
  setInstallHookRunner(runner: InstallHookRunner): void {
    this.installHooks = runner;
  }

  /** Load every installed pack from disk. Broken installs are logged and skipped. */
  async start(): Promise<void> {
    for (const record of await this.storage.packs.list()) {
      try {
        this.loaded.set(record.packId, await loadPack(record.root));
      } catch (err) {
        this.logger.error(`[packs] cannot load installed pack ${record.packId} at ${record.root}`, err);
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
      grants: await this.permissions.grantsFor(record.packId),
      characters: this.characters().filter((c) => c.packId === record.packId),
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
      pack = await loadPack(dest);
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        if (kind === 'dir') {
          await copyPackDir(source, staging);
          pack = await loadPack(staging);
        } else {
          pack = await extractPack(source, staging);
        }
        this.checkCapabilities(pack);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.rename(staging, dest);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      pack = await loadPack(dest);
    }
    this.checkCapabilities(pack);

    // 3. Replace a previous install of the same id (grants are kept).
    const previous = await this.storage.packs.get(manifest.id);
    if (previous && path.resolve(previous.root) !== path.resolve(dest) && this.isInsidePacksDir(previous.root)) {
      await fs.rm(previous.root, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(`[packs] could not remove previous version at ${previous.root}`, err);
      });
    }

    const requested = this.nonTrustedCapabilities(pack);
    const record: InstalledPackRecord = {
      packId: manifest.id,
      version: manifest.version,
      name: manifest.name,
      root: pack.root,
      installedAt: this.now().toISOString(),
      requestedCapabilities: requested,
      characterIds: pack.characters.map((c) => c.definition.id),
    };
    await this.storage.packs.upsert(record);
    this.loaded.set(manifest.id, pack);

    // 4. onInstall hooks run now (everything granted) or once grants change; mark them pending first
    //    so a grant listener can never run them before the record exists.
    const hasInstallHooks = pack.characters.some((c) => c.behaviourSources.onInstall !== undefined);
    if (hasInstallHooks) await this.storage.state.set(INSTALL_STATE_SCOPE(manifest.id), INSTALL_PENDING_KEY, true);
    else await this.storage.state.delete(INSTALL_STATE_SCOPE(manifest.id), INSTALL_PENDING_KEY);

    // 5. Make sure every requested capability has a grant record (default: not granted).
    const grants = await this.permissions.grantsFor(manifest.id);
    for (const module of requested) {
      if (!grants.some((g) => g.module === module)) await this.permissions.setGrant(manifest.id, module, false);
    }
    if (hasInstallHooks) await this.maybeRunInstallHooks(manifest.id);

    return this.view(manifest.id);
  }

  async uninstall(packId: string): Promise<void> {
    const record = await this.storage.packs.get(packId);
    if (!record) throw new RpError('NOT_FOUND', `Pack "${packId}" is not installed`, { packId });
    this.loaded.delete(packId);
    await this.storage.packs.remove(packId);
    await this.permissions.removeForPack(packId);
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
  }

  async exportPack(packId: string, destinationFile: string): Promise<void> {
    const pack = this.getLoaded(packId);
    await packDirectory(pack.root, destinationFile);
  }

  /** Whether every requested `pack`/`prompt` capability is currently granted. */
  async allGranted(packId: string): Promise<boolean> {
    const record = await this.storage.packs.get(packId);
    if (!record) return false;
    const grants = await this.permissions.grantsFor(packId);
    return record.requestedCapabilities.every((m) => grants.some((g) => g.module === m && g.granted));
  }

  /** Run the pending `onInstall` hooks once all requested capabilities are granted (serialised per pack). */
  maybeRunInstallHooks(packId: string): Promise<boolean> {
    const prev = this.installChecks.get(packId) ?? Promise.resolve(false);
    const run = (): Promise<boolean> => this.runInstallHooksIfReady(packId);
    const next = prev.then(run, run);
    this.installChecks.set(packId, next);
    next
      .finally(() => {
        if (this.installChecks.get(packId) === next) this.installChecks.delete(packId);
      })
      .catch(() => undefined);
    return next;
  }

  private async runInstallHooksIfReady(packId: string): Promise<boolean> {
    const pack = this.loaded.get(packId);
    if (!pack || !this.installHooks) return false;
    const pending = await this.storage.state.get(INSTALL_STATE_SCOPE(packId), INSTALL_PENDING_KEY);
    if (pending !== true) return false;
    if (!(await this.allGranted(packId))) return false;
    await this.storage.state.delete(INSTALL_STATE_SCOPE(packId), INSTALL_PENDING_KEY);
    await this.installHooks(pack);
    return true;
  }

  // ---- helpers ------------------------------------------------------------

  private isInsidePacksDir(p: string): boolean {
    const root = path.resolve(this.packsDir);
    const abs = path.resolve(p);
    return abs !== root && abs.startsWith(root + path.sep);
  }

  private nonTrustedCapabilities(pack: LoadedPack): string[] {
    return requestedCapabilities(pack).filter((id) => this.registry.get(id)?.permission !== 'trusted');
  }

  private checkCapabilities(pack: LoadedPack): void {
    const unknown = requestedCapabilities(pack).filter((id) => !this.registry.has(id));
    if (unknown.length > 0) {
      throw new RpError('PACK_INVALID', `Pack requests unknown capabilities: ${unknown.join(', ')}`, {
        packId: pack.manifest.id,
        unknown,
      });
    }
  }
}
