import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { AssetEntry, AssetKind, BehaviourHook, CharacterDefinition, MediaManifest, PackAuthor, PackManifest } from '@rp/shared';
import { CHARACTER_MANIFEST_FILENAME, MEDIA_MANIFEST_FILENAME, PACK_MANIFEST_FILENAME, RpError } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, applyMediaTags, assetKindFor, mimeFor } from './assets.js';
import { PACK_README_FILENAME } from './loader.js';
import { validateMediaManifest } from './media-manifest.js';
import { joinRelative, normalizeRelativePath, resolveAssetPath } from './paths.js';
import { BEHAVIOUR_HOOKS, CHARACTER_ID_PATTERN, validateCharacter, validateManifest } from './schema.js';
import { behaviourScriptPath, personaTemplate } from './templates.js';

/* ---------------------------------------------------------------- helpers */

/** Writes `data` to `abs` atomically (temp file in the same directory, then rename). */
export async function writeFileAtomic(abs: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Reorders keys: `order` first (in that order), then the rest sorted. Nested values are left as-is. */
function orderKeys<T extends object>(obj: T, order: readonly (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  const rec = obj as Record<string, unknown>;
  for (const key of order) if (rec[key] !== undefined) out[key] = rec[key];
  for (const key of Object.keys(rec).sort()) if (!(key in out) && rec[key] !== undefined) out[key] = rec[key];
  return out as T;
}

const MANIFEST_KEY_ORDER = [
  'formatVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'homepage', 'tags',
  'characters', 'capabilities', 'mediaRoot', 'minAppVersion',
] as const satisfies readonly (keyof PackManifest)[];

const CHARACTER_KEY_ORDER = [
  'id', 'name', 'tagline', 'avatar', 'persona', 'greeting', 'exampleDialogue', 'behaviours', 'avatarSet', 'mood',
  'capabilities', 'modelHints',
] as const satisfies readonly (keyof CharacterDefinition)[];

const MEDIA_MANIFEST_KEY_ORDER = ['folderTags', 'tags', 'entries'] as const satisfies readonly (keyof MediaManifest)[];

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function readManifestOf(dir: string): Promise<PackManifest> {
  const abs = path.join(path.resolve(dir), PACK_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (err) {
    throw new RpError('NOT_FOUND', `${PACK_MANIFEST_FILENAME} not found in ${dir}`, { dir }, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new RpError('PACK_INVALID', `${PACK_MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}`, { dir });
  }
  return validateManifest(json);
}

/** Reads and validates `media.json` when present; `null` when absent. Throws on an invalid one. */
async function readMediaManifestOf(dir: string): Promise<MediaManifest | null> {
  const abs = path.join(path.resolve(dir), MEDIA_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new RpError('PACK_INVALID', `${MEDIA_MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}`, { dir });
  }
  return validateMediaManifest(json);
}

/** Character id from a free-form name: `"Luna Nightingale!"` → `luna-nightingale`. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z0-9]+/, '');
  return CHARACTER_ID_PATTERN.test(slug) ? slug : 'character';
}

/* ---------------------------------------------------------------- writers */

export async function writeManifest(dir: string, manifest: PackManifest): Promise<void> {
  const valid = validateManifest(manifest);
  await writeFileAtomic(path.join(path.resolve(dir), PACK_MANIFEST_FILENAME), pretty(orderKeys(valid, MANIFEST_KEY_ORDER)));
}

export async function writeMediaManifest(dir: string, manifest: MediaManifest): Promise<void> {
  const valid = validateMediaManifest(manifest);
  await writeFileAtomic(
    path.join(path.resolve(dir), MEDIA_MANIFEST_FILENAME),
    pretty(orderKeys(valid, MEDIA_MANIFEST_KEY_ORDER)),
  );
}

export async function writeReadme(dir: string, text: string): Promise<void> {
  await writeFileAtomic(path.join(path.resolve(dir), PACK_README_FILENAME), text);
}

/**
 * Writes `character.json`, the persona file and one `scripts/on-<hook>.ts` per
 * entry of `behaviours`. Hook scripts for hooks absent from `behaviours` are
 * removed; every other file in the character directory (avatar, expressions,
 * other scripts) is left alone. Validates before touching disk.
 */
export async function writeCharacter(
  dir: string,
  charDir: string,
  definition: CharacterDefinition,
  personaText: string,
  behaviours: Partial<Record<BehaviourHook, string>>,
): Promise<void> {
  const rootAbs = path.resolve(dir);
  const n = normalizeRelativePath(charDir);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe character directory "${charDir}": ${n.reason}`, { path: charDir });
  const charAbs = resolveAssetPath(rootAbs, n.path);

  const def: CharacterDefinition = { ...definition };
  const bound: Partial<Record<BehaviourHook, string>> = {};
  for (const hook of BEHAVIOUR_HOOKS) {
    if (behaviours[hook] !== undefined) bound[hook] = behaviourScriptPath(hook);
  }
  if (Object.keys(bound).length > 0) def.behaviours = bound;
  else delete def.behaviours;
  const valid = validateCharacter(def);

  const personaAbs = resolveAssetPath(rootAbs, joinRelative(n.path, valid.persona));

  await fs.mkdir(charAbs, { recursive: true });
  await writeFileAtomic(personaAbs, personaText);
  for (const hook of BEHAVIOUR_HOOKS) {
    const scriptAbs = resolveAssetPath(rootAbs, joinRelative(n.path, behaviourScriptPath(hook)));
    const source = behaviours[hook];
    if (source !== undefined) await writeFileAtomic(scriptAbs, source);
    else await fs.rm(scriptAbs, { force: true });
  }
  await writeFileAtomic(path.join(charAbs, CHARACTER_MANIFEST_FILENAME), pretty(orderKeys(valid, CHARACTER_KEY_ORDER)));
}

export interface ScaffoldOptions {
  packId: string;
  name: string;
  characterId: string;
  characterName: string;
  description?: string;
  author?: PackAuthor;
  /** Pack-level capability requests. Default `['media']`. */
  capabilities?: string[];
}

/**
 * Creates a new, valid pack skeleton in `dir`: `pack.json`, `README.md`,
 * `media.json`, `media/{images,video,audio}/`, and one character with a
 * persona template and an empty `scripts/` directory. Refuses to overwrite an
 * existing pack (`PACK_CONFLICT`).
 */
export async function scaffoldPack(dir: string, options: ScaffoldOptions): Promise<void> {
  const rootAbs = path.resolve(dir);
  if (await exists(path.join(rootAbs, PACK_MANIFEST_FILENAME))) {
    throw new RpError('PACK_CONFLICT', `A pack already exists in ${rootAbs}`, { dir: rootAbs });
  }
  const characterId = options.characterId;
  const charDir = `characters/${characterId}`;
  const manifest: PackManifest = {
    formatVersion: 1,
    id: options.packId,
    name: options.name,
    version: '0.1.0',
    description: options.description ?? `${options.name}: a character pack for rp-code.`,
    characters: [charDir],
    capabilities: options.capabilities ?? ['media'],
    mediaRoot: DEFAULT_MEDIA_ROOT,
  };
  if (options.author) manifest.author = options.author;
  const definition: CharacterDefinition = {
    id: characterId,
    name: options.characterName,
    persona: 'persona.md',
    greeting: `Hi, I'm ${options.characterName}. What should I call you?`,
  };
  // Validate everything before creating anything.
  validateManifest(manifest);
  validateCharacter(definition);

  await fs.mkdir(rootAbs, { recursive: true });
  for (const sub of ['images', 'video', 'audio']) {
    await fs.mkdir(path.join(rootAbs, DEFAULT_MEDIA_ROOT, sub), { recursive: true });
  }
  await writeManifest(rootAbs, manifest);
  await writeMediaManifest(rootAbs, { entries: [], tags: {} });
  await writeReadme(
    rootAbs,
    `# ${options.name}\n\n${manifest.description}\n\nCharacters: ${options.characterName} (\`${characterId}\`).\n`,
  );
  await writeCharacter(rootAbs, charDir, definition, personaTemplate(options.characterName), {});
  await fs.mkdir(path.join(rootAbs, ...charDir.split('/'), 'scripts'), { recursive: true });
}

/* ----------------------------------------------------------------- assets */

const ASSET_KINDS: readonly AssetKind[] = ['image', 'video', 'audio', 'text', 'other'];

const FOLDER_BY_KIND: Record<AssetKind, string> = {
  image: 'images',
  video: 'video',
  audio: 'audio',
  text: 'text',
  other: 'other',
};

export interface AddAssetOptions {
  /** Override the kind inferred from the extension. Required for files of unknown type (`other`). */
  kind?: AssetKind;
  /**
   * Sub-folder below the kind folder, e.g. `wallpapers` or `outfits/summer`. Each segment must be
   * lower-case letters, digits, `-` or `_`; the folder names become tags via the folder-tag rules.
   */
  subdir?: string;
}

const SUBDIR_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

/** Validates `subdir` (see {@link AddAssetOptions.subdir}) and returns it in canonical `a/b` form. */
function normalizeSubdir(subdir: string): string {
  if (/[^a-z0-9_/-]/.test(subdir)) {
    throw new RpError('INVALID_ARGUMENT', `Invalid subdir "${subdir}": only lower-case letters, digits, "-", "_" and "/" are allowed`, { subdir });
  }
  const n = normalizeRelativePath(subdir);
  if (!n.ok) throw new RpError('INVALID_ARGUMENT', `Invalid subdir "${subdir}": ${n.reason}`, { subdir });
  for (const seg of n.path.split('/')) {
    if (!SUBDIR_SEGMENT.test(seg)) {
      throw new RpError(
        'INVALID_ARGUMENT',
        `Invalid subdir "${subdir}": segment "${seg}" must be lower-case letters, digits, "-" or "_"`,
        { subdir },
      );
    }
  }
  return n.path;
}

/** Splits off the extension, then keeps letters, digits, `.`, `_` and `-` in the stem; runs of anything else become one `-`. */
function safeFileName(base: string): { stem: string; ext: string } {
  const dot = base.lastIndexOf('.');
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const rawExt = dot > 0 ? base.slice(dot) : '';
  const stem = rawStem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'asset';
  const ext = rawExt.replace(/[^A-Za-z0-9.]+/g, '');
  return { stem, ext: ext.length > 1 ? ext : '' };
}

/**
 * Copies `sourceFile` into `<mediaRoot>/<images|video|audio|text|other>/[<subdir>/]`,
 * choosing a free name (`name.png`, `name-2.png`, …). Returns the resulting
 * asset entry with tags computed as the loader would (folder tags + `media.json`).
 */
export async function addAssetFile(dir: string, sourceFile: string, options: AddAssetOptions = {}): Promise<AssetEntry> {
  const rootAbs = path.resolve(dir);
  const manifest = await readManifestOf(rootAbs);
  const mediaRoot = manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT;

  const sourceAbs = path.resolve(sourceFile);
  let st: import('node:fs').Stats;
  try {
    st = await fs.stat(sourceAbs);
  } catch (err) {
    throw new RpError('NOT_FOUND', `Source file not found: ${sourceFile}`, { sourceFile }, { cause: err });
  }
  if (!st.isFile()) throw new RpError('INVALID_ARGUMENT', `Source is not a regular file: ${sourceFile}`, { sourceFile });

  const inferred = assetKindFor(sourceAbs);
  if (options.kind !== undefined && !ASSET_KINDS.includes(options.kind)) {
    throw new RpError('INVALID_ARGUMENT', `Unknown asset kind "${String(options.kind)}"`, { kind: options.kind });
  }
  const kind = options.kind ?? inferred;
  if (kind === 'other' && options.kind === undefined) {
    throw new RpError(
      'INVALID_ARGUMENT',
      `Unsupported file type "${path.basename(sourceAbs)}"; pass { kind: 'other' } to add it anyway`,
      { sourceFile },
    );
  }

  const subdir = options.subdir !== undefined ? normalizeSubdir(options.subdir) : undefined;
  const kindFolderRel = joinRelative(mediaRoot, FOLDER_BY_KIND[kind]);
  const folderRel = subdir === undefined ? kindFolderRel : joinRelative(kindFolderRel, subdir);
  const folderAbs = resolveAssetPath(rootAbs, folderRel);
  await fs.mkdir(folderAbs, { recursive: true });

  const { stem, ext } = safeFileName(path.basename(sourceAbs));
  let name = `${stem}${ext}`;
  for (let i = 2; await exists(path.join(folderAbs, name)); i++) name = `${stem}-${i}${ext}`;
  const targetRel = `${folderRel}/${name}`;
  const targetAbs = resolveAssetPath(rootAbs, targetRel);
  await fs.copyFile(sourceAbs, targetAbs, fsConstants.COPYFILE_EXCL);

  const entry: AssetEntry = { path: targetRel, kind, bytes: st.size, mime: mimeFor(targetRel), tags: [] };
  let mediaManifest: MediaManifest | null = null;
  try {
    mediaManifest = await readMediaManifestOf(rootAbs);
  } catch {
    // an invalid media.json is reported by validatePack; the new asset still gets its folder tags
  }
  return applyMediaTags([entry], mediaManifest, mediaRoot)[0]!;
}

/**
 * Deletes a media file (must live under the media root) and drops `media.json`
 * entries whose `match` is exactly that path. Glob entries are kept.
 */
export async function removeAsset(dir: string, assetPath: string): Promise<void> {
  const rootAbs = path.resolve(dir);
  const manifest = await readManifestOf(rootAbs);
  const mediaRoot = normalizeRelativePath(manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT);
  const n = normalizeRelativePath(assetPath);
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe asset path "${assetPath}": ${n.reason}`, { path: assetPath });
  if (!mediaRoot.ok || !n.path.startsWith(`${mediaRoot.path}/`)) {
    throw new RpError('INVALID_ARGUMENT', `"${n.path}" is not under the media root; only media files can be removed`, {
      path: n.path,
    });
  }
  const abs = resolveAssetPath(rootAbs, n.path);
  let st: import('node:fs').Stats;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    throw new RpError('NOT_FOUND', `Asset not found: ${n.path}`, { path: n.path }, { cause: err });
  }
  if (!st.isFile()) throw new RpError('INVALID_ARGUMENT', `"${n.path}" is not a file`, { path: n.path });
  await fs.rm(abs);

  const mediaManifest = await readMediaManifestOf(rootAbs);
  if (!mediaManifest) return;
  const kept = mediaManifest.entries.filter((entry) => {
    const m = normalizeRelativePath(entry.match);
    return !(m.ok && m.path === n.path);
  });
  if (kept.length !== mediaManifest.entries.length) {
    await writeMediaManifest(rootAbs, { ...mediaManifest, entries: kept });
  }
}
