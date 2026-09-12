/** Pack editor backend (docs/spec/editor.md "Desktop main — EditorService"). Every edit is written straight to the project folder. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AddMediaOptions,
  AssetEntry,
  BehaviourTemplate,
  CharacterDefinition,
  CreateProjectInput,
  EditorAsset,
  EditorCharacter,
  EditorProject,
  EditorProjectSummary,
  EditorValidation,
  InstalledPackView,
  LoadedPack,
  MediaManifest,
  MediaTagSuggestion,
  PackManifest,
  SaveCharacterInput,
  TagMediaOptions,
} from '@rp/shared';
import { CHARACTER_MANIFEST_FILENAME, MEDIA_MANIFEST_FILENAME, PACK_MANIFEST_FILENAME, RpError, assetUrl } from '@rp/shared';
import {
  ASSET_KIND_BY_EXTENSION,
  CHARACTER_ID_PATTERN,
  DEFAULT_MEDIA_ROOT,
  PACK_ID_PATTERN,
  PACK_README_FILENAME,
  assetKindFor,
  folderTagsFor,
  globToRegExp,
  indexAssets,
  inspectPack,
  joinRelative,
  normalizeRelativePath,
  packDirectory,
  resolveAssetPath,
  summariseTags,
  validateMediaManifest,
  validatePack,
} from '@rp/pack';
import { expandHome } from '../commands.js';
import { packWriters, fallbackSlugify } from './pack-writers.js';
import type { PackWriters } from './pack-writers.js';
import { ProjectRegistry, editorAssetHost } from './registry.js';
import type { ProjectEntry } from './registry.js';
import { absorbSuggestion } from './tagger.js';
import type { MediaTagger, TagAsset, TagPackContext } from './tagger.js';

export interface EditorDialogs {
  openDirectory(title: string): Promise<string | undefined>;
  openFiles(title: string, filters: Array<{ name: string; extensions: string[] }>, multi: boolean): Promise<string[]>;
  saveFile(title: string, defaultPath: string, filters: Array<{ name: string; extensions: string[] }>): Promise<string | undefined>;
}

export interface EditorServiceDeps {
  userData: string;
  registry: ProjectRegistry;
  packs: {
    install(dir: string): Promise<InstalledPackView>;
    tryGetLoaded(packId: string): LoadedPack | undefined;
    installedIds(): Promise<string[]>;
  };
  dialogs: EditorDialogs;
  reveal(absolute: string): void;
  logger: Pick<Console, 'warn' | 'debug'>;
  writers?: PackWriters;
  /** Vision-model tagging for the Media section; absent in builds/tests without an LLM. */
  tagger?: MediaTagger;
}

/** Assets asked for in one `suggestMediaTags` call, so a stray loop cannot hammer the model. */
export const MAX_TAG_BATCH = 25;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng'];
const EXPRESSION_EXT = [...IMAGE_EXT, 'webm', 'mp4'];
const MEDIA_KINDS = ['image', 'video', 'audio'] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

/** Extensions per kind from @rp/pack's table (image/video/audio). */
export function extensionsFor(kind: MediaKind): string[] {
  return Object.entries(ASSET_KIND_BY_EXTENSION)
    .filter(([, k]) => k === kind)
    .map(([ext]) => ext)
    .sort();
}

/** Picker filters for the requested kinds (default: every media kind plus text). */
export function mediaFilters(kinds: AddMediaOptions['kinds']): Array<{ name: string; extensions: string[] }> {
  const wanted = Array.isArray(kinds) ? MEDIA_KINDS.filter((k) => kinds.includes(k)) : [];
  if (wanted.length === 0) {
    return [
      { name: 'Media', extensions: [...MEDIA_KINDS.flatMap(extensionsFor), 'txt', 'md', 'json'] },
      ...MEDIA_KINDS.map((k) => ({ name: kindLabel(k), extensions: extensionsFor(k) })),
    ];
  }
  const filters = wanted.map((k) => ({ name: kindLabel(k), extensions: extensionsFor(k) }));
  return wanted.length > 1 ? [{ name: 'Media', extensions: wanted.flatMap(extensionsFor) }, ...filters] : filters;
}

function kindLabel(kind: MediaKind): string {
  return kind === 'image' ? 'Images' : kind === 'video' ? 'Videos' : 'Audio';
}

/** Validate `subfolder` (relative, no `..`, folder-name-safe segments) → normalised path or undefined. */
export function normalizeSubfolder(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return undefined;
  const n = normalizeRelativePath(v.trim());
  if (!n.ok) throw new RpError('INVALID_ARGUMENT', `Invalid subfolder "${v}": ${n.reason}`);
  if (!n.path.split('/').every((seg) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seg))) {
    throw new RpError('INVALID_ARGUMENT', `Invalid subfolder "${v}": use letters, digits, ".", "_" and "-"`);
  }
  return n.path;
}

export class EditorService {
  private readonly writers: PackWriters;

  constructor(private readonly deps: EditorServiceDeps) {
    this.writers = deps.writers ?? packWriters();
  }

  get workspaceDir(): string {
    return path.join(this.deps.userData, 'workspace');
  }

  // ---- projects ----------------------------------------------------------------

  private entry(key: string): ProjectEntry {
    const entry = this.deps.registry.get(key);
    if (!entry) throw new RpError('NOT_FOUND', `No open project with key ${key}`);
    return entry;
  }

  async listProjects(): Promise<EditorProjectSummary[]> {
    const installed = new Set(await this.deps.packs.installedIds());
    const out: EditorProjectSummary[] = [];
    for (const entry of this.deps.registry.list()) {
      try {
        out.push(await this.summary(entry, installed));
      } catch (err) {
        this.deps.logger.warn(`[editor] cannot summarise ${entry.dir}`, err);
      }
    }
    return out;
  }

  private async summary(entry: ProjectEntry, installed?: Set<string>): Promise<EditorProjectSummary> {
    const ids = installed ?? new Set(await this.deps.packs.installedIds());
    const manifest = await this.readManifestTolerant(entry.dir);
    let updatedAt = new Date(0).toISOString();
    try {
      updatedAt = (await fs.stat(entry.dir)).mtime.toISOString();
      const m = await fs.stat(path.join(entry.dir, PACK_MANIFEST_FILENAME)).catch(() => undefined);
      if (m && m.mtime.toISOString() > updatedAt) updatedAt = m.mtime.toISOString();
    } catch {
      /* missing dir: keep epoch */
    }
    return {
      key: entry.key,
      dir: entry.dir,
      packId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      characterCount: manifest.characters.length,
      updatedAt,
      installed: manifest.id.length > 0 && ids.has(manifest.id),
    };
  }

  async create(input: CreateProjectInput): Promise<EditorProject> {
    const packId = String(input.packId ?? '').trim();
    const name = String(input.name ?? '').trim();
    const characterName = String(input.characterName ?? '').trim() || name;
    const characterId = String(input.characterId ?? '').trim() || this.slug(characterName);
    if (!PACK_ID_PATTERN.test(packId)) throw new RpError('INVALID_ARGUMENT', `Pack id "${packId}" must be reverse-DNS, e.g. com.me.luna`);
    if (name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name is required');
    if (!CHARACTER_ID_PATTERN.test(characterId)) throw new RpError('INVALID_ARGUMENT', `Character id "${characterId}" is not valid`);
    const parent = input.parentDir && input.parentDir.trim().length > 0 ? path.resolve(expandHome(input.parentDir.trim())) : this.workspaceDir;
    const dir = path.join(parent, packId);
    if (await exists(dir)) {
      const entries = await fs.readdir(dir).catch(() => ['x']);
      if (entries.length > 0) throw new RpError('PACK_CONFLICT', `${dir} already exists and is not empty`);
    }
    await fs.mkdir(dir, { recursive: true });
    await this.writers.scaffoldPack(dir, { packId, name, characterId, characterName });
    const entry = this.deps.registry.add(dir);
    return this.read(entry.key);
  }

  async open(dirArg?: string): Promise<EditorProject | null> {
    let dir = dirArg && dirArg.trim().length > 0 ? path.resolve(expandHome(dirArg.trim())) : undefined;
    if (!dir) {
      dir = await this.deps.dialogs.openDirectory('Open a pack folder');
      if (!dir) return null;
    }
    if (!(await exists(path.join(dir, PACK_MANIFEST_FILENAME)))) throw new RpError('PACK_INVALID', `${dir} has no ${PACK_MANIFEST_FILENAME}`);
    const entry = this.deps.registry.add(dir);
    return this.read(entry.key);
  }

  async importInstalled(packId: string): Promise<EditorProject> {
    const loaded = this.deps.packs.tryGetLoaded(packId);
    if (!loaded) throw new RpError('NOT_FOUND', `Pack "${packId}" is not installed`);
    const dest = path.join(this.workspaceDir, packId);
    if (this.deps.registry.byDir(dest)) throw new RpError('PACK_CONFLICT', `A project for ${packId} is already open (${dest})`);
    if (await exists(dest)) throw new RpError('PACK_CONFLICT', `${dest} already exists; open it instead`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(loaded.root, dest, { recursive: true, dereference: false, filter: (src) => !path.basename(src).startsWith('.') && path.basename(src) !== 'node_modules' });
    const entry = this.deps.registry.add(dest);
    return this.read(entry.key);
  }

  async forget(key: string): Promise<void> {
    this.deps.registry.remove(key);
  }

  // ---- read (tolerant) -------------------------------------------------------------

  private async readManifestTolerant(dir: string): Promise<PackManifest> {
    const fallback: PackManifest = { formatVersion: 1, id: '', name: path.basename(dir), version: '0.0.0', characters: [] };
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, PACK_MANIFEST_FILENAME), 'utf8')) as Partial<PackManifest>;
      if (!raw || typeof raw !== 'object') return fallback;
      return {
        ...(raw as PackManifest),
        formatVersion: 1,
        id: typeof raw.id === 'string' ? raw.id : '',
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : fallback.name,
        version: typeof raw.version === 'string' ? raw.version : '0.0.0',
        characters: Array.isArray(raw.characters) ? raw.characters.filter((c): c is string => typeof c === 'string') : [],
      };
    } catch {
      return fallback;
    }
  }

  private async readMediaManifestTolerant(dir: string): Promise<MediaManifest> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, MEDIA_MANIFEST_FILENAME), 'utf8')) as unknown;
      try {
        return validateMediaManifest(raw);
      } catch {
        const r = raw as Partial<MediaManifest>;
        return { entries: Array.isArray(r?.entries) ? (r.entries as MediaManifest['entries']) : [], ...(r?.tags && typeof r.tags === 'object' ? { tags: r.tags } : {}) };
      }
    } catch {
      return { entries: [] };
    }
  }

  /** A character directory read leniently (what parses is returned; problems are in `validation`). */
  private async readCharacterTolerant(dir: string, charDir: string, key: string): Promise<EditorCharacter | undefined> {
    const n = normalizeRelativePath(charDir);
    if (!n.ok) return undefined;
    let definition: CharacterDefinition;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, ...n.path.split('/'), CHARACTER_MANIFEST_FILENAME), 'utf8')) as Partial<CharacterDefinition>;
      if (!raw || typeof raw !== 'object') return undefined;
      definition = { ...(raw as CharacterDefinition), id: typeof raw.id === 'string' ? raw.id : path.basename(n.path), name: typeof raw.name === 'string' ? raw.name : path.basename(n.path), persona: typeof raw.persona === 'string' ? raw.persona : 'persona.md' };
    } catch {
      return undefined;
    }
    const personaText = await fs.readFile(path.join(dir, ...n.path.split('/'), ...definition.persona.split('/')), 'utf8').catch(() => '');
    const behaviours: EditorCharacter['behaviours'] = {};
    for (const [hook, file] of Object.entries(definition.behaviours ?? {})) {
      if (typeof file !== 'string') continue;
      const src = await fs.readFile(path.join(dir, ...n.path.split('/'), ...file.split('/')), 'utf8').catch(() => undefined);
      if (src !== undefined) behaviours[hook as keyof EditorCharacter['behaviours']] = src;
    }
    const out: EditorCharacter = { dir: n.path, definition, personaText, behaviours };
    const host = editorAssetHost(key);
    if (typeof definition.avatar === 'string') {
      const rel = safeJoin(n.path, definition.avatar);
      if (rel) out.avatarUrl = assetUrl(host, rel);
    }
    if (definition.avatarSet?.expressions) {
      const urls: Record<string, string> = {};
      for (const [name, file] of Object.entries(definition.avatarSet.expressions)) {
        const rel = typeof file === 'string' ? safeJoin(n.path, file) : undefined;
        if (rel) urls[name] = assetUrl(host, rel);
      }
      out.expressionUrls = urls;
    }
    return out;
  }

  async read(key: string): Promise<EditorProject> {
    const entry = this.entry(key);
    const dir = entry.dir;
    const host = editorAssetHost(key);
    const inspection = await inspectPack(dir).catch((err) => ({ pack: undefined, problems: [RpError.from(err).message], warnings: [] as string[] }));
    const pack = inspection.pack;
    const manifest = pack?.manifest ?? (await this.readManifestTolerant(dir));
    const mediaRoot = manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT;
    const mediaManifest = await this.readMediaManifestTolerant(dir);

    const characters: EditorCharacter[] = [];
    if (pack) {
      for (const c of pack.characters) {
        const ch: EditorCharacter = { dir: c.dir, definition: c.definition, personaText: c.personaText, behaviours: { ...c.behaviourSources } };
        if (c.avatarPath) ch.avatarUrl = assetUrl(host, c.avatarPath);
        if (c.definition.avatarSet?.expressions) {
          const urls: Record<string, string> = {};
          for (const [name, file] of Object.entries(c.definition.avatarSet.expressions)) {
            const rel = safeJoin(c.dir, file);
            if (rel) urls[name] = assetUrl(host, rel);
          }
          ch.expressionUrls = urls;
        }
        characters.push(ch);
      }
    } else {
      for (const charDir of manifest.characters) {
        const ch = await this.readCharacterTolerant(dir, charDir, key);
        if (ch) characters.push(ch);
      }
    }

    let assets: AssetEntry[] = pack?.assets ?? [];
    if (!pack) assets = await indexAssets(dir, mediaRoot).catch(() => []);
    const rules = mediaManifest.entries.map((e) => ({ e, re: safeGlob(e.match) })).filter((r): r is { e: MediaManifest['entries'][number]; re: RegExp } => r.re !== undefined);
    const editorAssets: EditorAsset[] = assets.map((a) => {
      const manifestTags = new Set<string>();
      for (const { e, re } of rules) if (re.test(a.path)) for (const t of e.tags ?? []) manifestTags.add(t);
      return { ...a, url: assetUrl(host, a.path), folderTags: mediaManifest.folderTags === false ? [] : folderTagsFor(a.path, mediaRoot), manifestTags: [...manifestTags].sort() };
    });

    const validation = await this.validate(key);
    const summary = await this.summary(entry);
    const readme = pack?.readme ?? (await fs.readFile(path.join(dir, PACK_README_FILENAME), 'utf8').catch(() => ''));
    return {
      summary,
      manifest,
      characters,
      mediaManifest,
      assets: editorAssets,
      tags: summariseTags(assets, mediaManifest.tags ?? pack?.tagDescriptions),
      readme,
      validation,
    };
  }

  async validate(key: string): Promise<EditorValidation> {
    const { dir } = this.entry(key);
    const result = await validatePack(dir);
    const warnings = result.warnings;
    const problems = result.problems.filter((p) => !warnings.includes(p));
    return { ok: result.ok, problems, warnings };
  }

  // ---- writes ----------------------------------------------------------------------

  async saveManifest(key: string, manifest: PackManifest): Promise<EditorProject> {
    const { dir } = this.entry(key);
    if (!manifest || typeof manifest !== 'object') throw new RpError('INVALID_ARGUMENT', 'manifest must be an object');
    await this.writers.writeManifest(dir, { ...manifest, formatVersion: 1 });
    return this.read(key);
  }

  async addCharacter(key: string, characterIdArg: string, nameArg: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const name = String(nameArg ?? '').trim();
    const characterId = String(characterIdArg ?? '').trim() || this.slug(name);
    if (name.length === 0) throw new RpError('INVALID_ARGUMENT', 'name is required');
    if (!CHARACTER_ID_PATTERN.test(characterId)) throw new RpError('INVALID_ARGUMENT', `Character id "${characterId}" is not valid`);
    const manifest = await this.readManifestTolerant(dir);
    const charDir = `characters/${characterId}`;
    if (manifest.characters.includes(charDir) || (await exists(path.join(dir, 'characters', characterId)))) {
      throw new RpError('PACK_CONFLICT', `Character "${characterId}" already exists`);
    }
    const definition: CharacterDefinition = { id: characterId, name, persona: 'persona.md', greeting: `Hi, I'm ${name}.` };
    await this.writers.writeCharacter(dir, charDir, definition, this.persona(name), {});
    await this.writers.writeManifest(dir, { ...manifest, characters: [...manifest.characters, charDir] });
    return this.read(key);
  }

  async saveCharacter(key: string, input: SaveCharacterInput): Promise<EditorProject> {
    const { dir } = this.entry(key);
    if (!input || typeof input !== 'object' || typeof input.dir !== 'string') throw new RpError('INVALID_ARGUMENT', 'input.dir is required');
    const n = normalizeRelativePath(input.dir);
    if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character dir "${input.dir}"`);
    if (!input.definition || typeof input.definition !== 'object') throw new RpError('INVALID_ARGUMENT', 'definition is required');
    await this.writers.writeCharacter(dir, n.path, input.definition, typeof input.personaText === 'string' ? input.personaText : '', input.behaviours ?? {});
    return this.read(key);
  }

  async removeCharacter(key: string, charDir: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const n = normalizeRelativePath(charDir);
    if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character dir "${charDir}"`);
    const abs = resolveAssetPath(dir, n.path);
    await fs.rm(abs, { recursive: true, force: true });
    const manifest = await this.readManifestTolerant(dir);
    await this.writers.writeManifest(dir, { ...manifest, characters: manifest.characters.filter((c) => normalizeRelativePath(c).ok && (normalizeRelativePath(c) as { path: string }).path !== n.path) });
    return this.read(key);
  }

  private async characterOf(dir: string, charDir: string, key: string): Promise<EditorCharacter> {
    const n = normalizeRelativePath(charDir);
    if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character dir "${charDir}"`);
    const ch = await this.readCharacterTolerant(dir, n.path, key);
    if (!ch) throw new RpError('NOT_FOUND', `No character at ${charDir}`);
    return ch;
  }

  /** Copy `source` into the character directory (unique name) and return its path relative to the character dir. */
  private async copyIntoCharacter(dir: string, charDir: string, source: string): Promise<string> {
    const base = path.basename(source);
    const target = await uniqueName(path.join(dir, ...charDir.split('/')), base);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return path.basename(target);
  }

  async pickAvatar(key: string, charDir: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const ch = await this.characterOf(dir, charDir, key);
    const [file] = await this.deps.dialogs.openFiles('Choose an avatar image', [{ name: 'Images', extensions: IMAGE_EXT }], false);
    if (!file) return this.read(key);
    if (assetKindFor(file) !== 'image') throw new RpError('INVALID_ARGUMENT', 'The avatar must be an image');
    const rel = await this.copyIntoCharacter(dir, ch.dir, file);
    await this.writers.writeCharacter(dir, ch.dir, { ...ch.definition, avatar: rel }, ch.personaText, ch.behaviours);
    return this.read(key);
  }

  async pickExpression(key: string, charDir: string, expressionArg: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const expression = String(expressionArg ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(expression)) throw new RpError('INVALID_ARGUMENT', 'expression must be a short lower-case name');
    const ch = await this.characterOf(dir, charDir, key);
    const [file] = await this.deps.dialogs.openFiles(`Choose the "${expression}" expression`, [{ name: 'Images and short videos', extensions: EXPRESSION_EXT }], false);
    if (!file) return this.read(key);
    const kind = assetKindFor(file);
    if (kind !== 'image' && kind !== 'video') throw new RpError('INVALID_ARGUMENT', 'An expression must be an image or a short video');
    const rel = await this.copyIntoCharacter(dir, ch.dir, file);
    const set = { ...(ch.definition.avatarSet ?? { expressions: {} }), expressions: { ...(ch.definition.avatarSet?.expressions ?? {}), [expression]: rel } };
    await this.writers.writeCharacter(dir, ch.dir, { ...ch.definition, avatarSet: set }, ch.personaText, ch.behaviours);
    return this.read(key);
  }

  async addMedia(key: string, options: AddMediaOptions = {}): Promise<EditorProject> {
    const o = options && typeof options === 'object' ? options : {};
    const title = typeof o.title === 'string' && o.title.trim().length > 0 ? o.title.trim() : 'Add media files';
    const files = await this.deps.dialogs.openFiles(title, mediaFilters(o.kinds), true);
    return this.addMediaFiles(key, files, o);
  }

  async addMediaFiles(key: string, files: string[], options: AddMediaOptions = {}): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const o = options && typeof options === 'object' ? options : {};
    if (!Array.isArray(files)) throw new RpError('INVALID_ARGUMENT', 'files must be an array of absolute paths');
    const subfolder = normalizeSubfolder(o.subfolder);
    const allowedKinds = Array.isArray(o.kinds) ? new Set(o.kinds) : undefined;
    const manifest = await this.readManifestTolerant(dir);
    const mediaRoot = normalizeRelativePath(manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT);
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new RpError('INVALID_ARGUMENT', `Not an absolute path: ${String(file)}`);
      const st = await fs.stat(file).catch(() => undefined);
      if (!st?.isFile()) throw new RpError('NOT_FOUND', `${file} is not a file`);
      const kind = assetKindFor(file);
      if (allowedKinds && !allowedKinds.has(kind as MediaKind)) throw new RpError('INVALID_ARGUMENT', `${path.basename(file)} is not one of: ${[...allowedKinds].join(', ')}`);
      const entry = await this.writers.addAssetFile(dir, file, subfolder ? { subdir: subfolder } : {});
      // Older @rp/pack builds ignore `subdir`: move the file into the sub-folder ourselves.
      if (subfolder && mediaRoot.ok) await this.moveIntoSubfolder(dir, entry, mediaRoot.path, subfolder);
    }
    return this.read(key);
  }

  private async moveIntoSubfolder(dir: string, entry: AssetEntry, mediaRoot: string, subfolder: string): Promise<void> {
    const parts = entry.path.split('/');
    const name = parts.pop() ?? '';
    const currentDir = parts.join('/');
    const kindDir = currentDir.startsWith(`${mediaRoot}/`) ? currentDir.slice(mediaRoot.length + 1).split('/')[0] : undefined;
    if (!kindDir) return;
    const wantedDir = `${mediaRoot}/${kindDir}/${subfolder}`;
    if (currentDir === wantedDir || currentDir.startsWith(`${wantedDir}/`)) return;
    const from = resolveAssetPath(dir, entry.path);
    const targetDir = resolveAssetPath(dir, wantedDir);
    await fs.mkdir(targetDir, { recursive: true });
    const to = await uniqueName(targetDir, name);
    await fs.rename(from, to);
  }

  async removeMedia(key: string, assetPath: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    const n = normalizeRelativePath(String(assetPath ?? ''));
    if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe asset path "${assetPath}"`);
    resolveAssetPath(dir, n.path); // symlink guard
    await this.writers.removeAsset(dir, n.path);
    return this.read(key);
  }

  async saveMediaManifest(key: string, manifest: MediaManifest): Promise<EditorProject> {
    const { dir } = this.entry(key);
    await this.writers.writeMediaManifest(dir, validateMediaManifest(manifest));
    return this.read(key);
  }

  /**
   * Ask a vision model for tags and a description per asset (docs/spec/editor.md "Auto-tagging").
   * Read-only: the suggestions go back to the editor, which applies them to its media.json draft.
   */
  async suggestMediaTags(key: string, paths: string[], options: TagMediaOptions = {}): Promise<MediaTagSuggestion[]> {
    const { dir } = this.entry(key);
    const tagger = this.deps.tagger;
    if (!tagger) throw new RpError('INTERNAL', 'Auto-tagging is not available in this build');
    if (!Array.isArray(paths) || paths.length === 0) throw new RpError('INVALID_ARGUMENT', 'paths must be a non-empty array of asset paths');
    if (paths.length > MAX_TAG_BATCH) throw new RpError('INVALID_ARGUMENT', `At most ${MAX_TAG_BATCH} assets per call (got ${paths.length})`);
    const o = options && typeof options === 'object' ? options : {};
    const project = await this.read(key);
    let pack: TagPackContext = {
      id: project.manifest.id,
      name: project.manifest.name,
      ...(project.manifest.description ? { description: project.manifest.description } : {}),
      characters: project.characters.map((c) => c.definition.name),
      vocabulary: project.mediaManifest.tags ?? {},
      knownTags: project.tags.map((t) => t.tag),
    };
    // What earlier assets of this run coined is not in media.json yet (the editor saves at the end).
    if (o.learned && typeof o.learned === 'object') {
      const tags = Array.isArray(o.learned.tags) ? o.learned.tags.filter((t): t is string => typeof t === 'string') : [];
      const meanings = o.learned.vocabulary && typeof o.learned.vocabulary === 'object' ? o.learned.vocabulary : {};
      const vocabulary = Object.fromEntries(Object.entries(meanings).filter(([, v]) => typeof v === 'string' && v.length > 0));
      pack = absorbSuggestion(pack, { tags, vocabulary });
    }
    const frames = o.frames && typeof o.frames === 'object' ? o.frames : {};
    const assets: TagAsset[] = paths.map((p) => {
      const n = normalizeRelativePath(String(p ?? ''));
      if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe asset path "${String(p)}"`);
      const asset = project.assets.find((a) => a.path === n.path);
      if (!asset) throw new RpError('NOT_FOUND', `${n.path} is not an asset of this pack`);
      const description = project.mediaManifest.entries.filter((e) => e.match.replace(/^\.?\//, '') === asset.path).map((e) => e.description).filter((d): d is string => typeof d === 'string' && d.length > 0).at(-1);
      const frame = frames[asset.path];
      return {
        path: asset.path,
        kind: asset.kind,
        mime: asset.mime,
        bytes: asset.bytes,
        absolutePath: resolveAssetPath(dir, asset.path),
        folderTags: asset.folderTags,
        tags: asset.manifestTags,
        ...(description ? { description } : {}),
        ...(typeof frame === 'string' && frame.length > 0 ? { frame } : {}),
      };
    });
    return tagger.suggest(pack, assets, o);
  }

  async saveReadme(key: string, text: string): Promise<EditorProject> {
    const { dir } = this.entry(key);
    await this.writers.writeReadme(dir, typeof text === 'string' ? text : '');
    return this.read(key);
  }

  // ---- publish -----------------------------------------------------------------------

  async exportPack(key: string): Promise<string | null> {
    const { dir } = this.entry(key);
    const manifest = await this.readManifestTolerant(dir);
    const validation = await this.validate(key);
    if (!validation.ok) throw new RpError('PACK_INVALID', `Fix the pack first:\n${validation.problems.join('\n')}`);
    const suggested = `${manifest.id || path.basename(dir)}-${manifest.version}.rppack`;
    const target = await this.deps.dialogs.saveFile('Export pack', suggested, [{ name: 'rp-code pack', extensions: ['rppack'] }]);
    if (!target) return null;
    await packDirectory(dir, target);
    return target;
  }

  async installToApp(key: string): Promise<InstalledPackView> {
    const { dir } = this.entry(key);
    return this.deps.packs.install(dir);
  }

  async revealInFolder(key: string): Promise<void> {
    const { dir } = this.entry(key);
    this.deps.reveal(path.join(dir, PACK_MANIFEST_FILENAME));
  }

  behaviourTemplates(): BehaviourTemplate[] {
    try {
      return this.writers.behaviourTemplates();
    } catch {
      return [];
    }
  }

  private slug(name: string): string {
    try {
      return this.writers.slugify(name);
    } catch {
      return fallbackSlugify(name);
    }
  }

  private persona(name: string): string {
    try {
      return this.writers.personaTemplate(name);
    } catch {
      return `# ${name}\n\nDescribe who ${name} is, how they talk, and what they care about.\n`;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(base: string, child: string): string | undefined {
  try {
    return joinRelative(base, child);
  } catch {
    return undefined;
  }
}

function safeGlob(pattern: string): RegExp | undefined {
  try {
    return globToRegExp(pattern);
  } catch {
    return undefined;
  }
}

/** `name.png` → `name-2.png` … until unused. */
async function uniqueName(dir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  for (let i = 2; await exists(candidate); i += 1) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}
