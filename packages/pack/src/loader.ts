import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  BehaviourHook,
  CharacterDefinition,
  LoadedCharacter,
  LoadedPack,
  MediaManifest,
  PackManifest,
} from '@rp/shared';
import { CHARACTER_MANIFEST_FILENAME, MEDIA_MANIFEST_FILENAME, PACK_MANIFEST_FILENAME, RpError } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, assetKindFor, indexAssets } from './assets.js';
import { globToRegExp } from './glob.js';
import { validateMediaManifest } from './media-manifest.js';
import { joinRelative, normalizeRelativePath, resolveAssetPath } from './paths.js';
import { readCharacterLibrary } from './library.js';
import { BEHAVIOUR_HOOKS, IGNORED_CAPABILITIES_KEY, validateCharacter, validateManifest } from './schema.js';
import { MAX_TAGS_PER_ASSET } from './tags.js';

/** Directory that holds the pack's character directory (`characters/<id>/`). */
export const CHARACTERS_DIR_NAME = 'characters';

export const PACK_README_FILENAME = 'README.md';

/**
 * Result of inspecting a pack directory: the pack (when loadable), every
 * problem that makes it unloadable, and non-fatal warnings (`warning: …` /
 * `info: …` texts, e.g. a `media.json` rule that matches nothing).
 */
export interface PackInspection {
  pack?: LoadedPack;
  problems: string[];
  warnings: string[];
}

type FileKind = 'file' | 'dir' | 'missing' | 'other';

async function kindOf(abs: string): Promise<FileKind> {
  try {
    const st = await fs.stat(abs);
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'dir';
    return 'other';
  } catch {
    return 'missing';
  }
}

type JsonRead = { ok: true; value: unknown } | { ok: false; error: string };

/** The legacy `capabilities` key is accepted but does nothing: permissions are app-wide. */
export function ignoredCapabilitiesWarning(file: string): string {
  return `warning: ${file}: "${IGNORED_CAPABILITIES_KEY}" is ignored; permissions are set in the app under Settings → Permissions`;
}

function hasIgnoredCapabilities(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && IGNORED_CAPABILITIES_KEY in raw;
}

async function readJson(abs: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read file (${(err as Error).message})` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
}

/**
 * Resolves `rel` (already validated as a safe relative path) under `rootAbs`,
 * turning a symlink escape into a problem string instead of an exception.
 */
function safeResolve(rootAbs: string, rel: string, problems: string[], label: string): string | undefined {
  try {
    return resolveAssetPath(rootAbs, rel);
  } catch (err) {
    problems.push(`${label}: ${RpError.from(err).message}`);
    return undefined;
  }
}

async function loadCharacter(
  rootAbs: string,
  dirInput: string,
  problems: string[],
  warnings: string[],
): Promise<LoadedCharacter | undefined> {
  const n = normalizeRelativePath(dirInput);
  if (!n.ok) {
    problems.push(`${PACK_MANIFEST_FILENAME}: character directory "${dirInput}" is unsafe: ${n.reason}`);
    return undefined;
  }
  const dir = n.path;
  const dirAbs = safeResolve(rootAbs, dir, problems, PACK_MANIFEST_FILENAME);
  if (!dirAbs) return undefined;
  if ((await kindOf(dirAbs)) !== 'dir') {
    problems.push(`${PACK_MANIFEST_FILENAME}: character directory "${dir}" does not exist`);
    return undefined;
  }

  const defRel = `${dir}/${CHARACTER_MANIFEST_FILENAME}`;
  const defAbs = path.join(dirAbs, CHARACTER_MANIFEST_FILENAME);
  if ((await kindOf(defAbs)) !== 'file') {
    problems.push(`${defRel}: missing`);
    return undefined;
  }
  const raw = await readJson(defAbs);
  if (!raw.ok) {
    problems.push(`${defRel}: ${raw.error}`);
    return undefined;
  }
  let definition: CharacterDefinition;
  try {
    definition = validateCharacter(raw.value);
  } catch (err) {
    problems.push(`${defRel}: ${RpError.from(err).message}`);
    return undefined;
  }
  if (hasIgnoredCapabilities(raw.value)) warnings.push(ignoredCapabilitiesWarning(defRel));

  const before = problems.length;

  // persona.md (required)
  let personaText = '';
  const personaAbs = safeResolve(rootAbs, joinRelative(dir, definition.persona), problems, defRel);
  if (personaAbs) {
    if ((await kindOf(personaAbs)) !== 'file') {
      problems.push(`${defRel}: persona file "${definition.persona}" not found`);
    } else {
      personaText = await fs.readFile(personaAbs, 'utf8');
    }
  }

  // avatar (optional; must exist and be an image)
  let avatarPath: string | undefined;
  if (definition.avatar !== undefined) {
    const rel = joinRelative(dir, definition.avatar);
    const avatarAbs = safeResolve(rootAbs, rel, problems, defRel);
    if (avatarAbs) {
      if ((await kindOf(avatarAbs)) !== 'file') {
        problems.push(`${defRel}: avatar "${definition.avatar}" not found`);
      } else if (assetKindFor(rel) !== 'image') {
        problems.push(`${defRel}: avatar "${definition.avatar}" is not an image`);
      } else {
        avatarPath = rel;
      }
    }
  }

  // avatarSet expressions (optional; each must exist)
  for (const [name, rel] of Object.entries(definition.avatarSet?.expressions ?? {})) {
    const abs = safeResolve(rootAbs, joinRelative(dir, rel), problems, defRel);
    if (abs && (await kindOf(abs)) !== 'file') {
      problems.push(`${defRel}: avatarSet expression "${name}" file "${rel}" not found`);
    }
  }

  // behaviour scripts (optional; each must exist)
  const behaviourSources: Partial<Record<BehaviourHook, string>> = {};
  for (const hook of BEHAVIOUR_HOOKS) {
    const scriptRel = definition.behaviours?.[hook];
    if (scriptRel === undefined) continue;
    const scriptAbs = safeResolve(rootAbs, joinRelative(dir, scriptRel), problems, defRel);
    if (!scriptAbs) continue;
    if ((await kindOf(scriptAbs)) !== 'file') {
      problems.push(`${defRel}: behaviour ${hook} script "${scriptRel}" not found`);
      continue;
    }
    behaviourSources[hook] = await fs.readFile(scriptAbs, 'utf8');
  }

  // function library: lib/<name>.ts (optional). A broken file is skipped with a warning; the caps are problems.
  const scan = await readCharacterLibrary(rootAbs, dir);
  problems.push(...scan.problems);
  for (const skipped of scan.skipped) warnings.push(`warning: ${skipped.file}: ${skipped.message}`);

  if (problems.length > before) return undefined;
  const loaded: LoadedCharacter = { dir, definition, personaText, behaviourSources, library: scan.library };
  if (avatarPath !== undefined) loaded.avatarPath = avatarPath;
  return loaded;
}

/**
 * A pack has exactly one character. The manifest schema already allows one
 * entry only; this also catches a second `characters/<x>/character.json` on
 * disk that the manifest does not list (a leftover, or a pack that was meant to
 * be split), so the folder and the manifest cannot disagree silently.
 */
async function checkSingleCharacterDir(rootAbs: string, listedDir: string | undefined, problems: string[]): Promise<void> {
  const charactersAbs = path.join(rootAbs, CHARACTERS_DIR_NAME);
  if ((await kindOf(charactersAbs)) !== 'dir') return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(charactersAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = `${CHARACTERS_DIR_NAME}/${entry.name}`;
    if (rel === listedDir) continue;
    if ((await kindOf(path.join(charactersAbs, entry.name, CHARACTER_MANIFEST_FILENAME))) !== 'file') continue;
    problems.push(
      `${rel}/${CHARACTER_MANIFEST_FILENAME}: a pack has exactly one character${listedDir ? ` ("${listedDir}")` : ''}; move "${rel}" into a pack of its own or delete it`,
    );
  }
}

/**
 * Reads and checks a pack directory, collecting every problem instead of
 * stopping at the first one. `pack` is present only when there were no problems.
 */
export async function inspectPack(root: string): Promise<PackInspection> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const rootAbs = path.resolve(root);

  if ((await kindOf(rootAbs)) !== 'dir') {
    return { problems: [`pack root "${rootAbs}" is not a directory`], warnings };
  }

  const manifestAbs = path.join(rootAbs, PACK_MANIFEST_FILENAME);
  if ((await kindOf(manifestAbs)) !== 'file') {
    return { problems: [`${PACK_MANIFEST_FILENAME}: missing`], warnings };
  }
  const raw = await readJson(manifestAbs);
  if (!raw.ok) return { problems: [`${PACK_MANIFEST_FILENAME}: ${raw.error}`], warnings };

  let manifest: PackManifest;
  try {
    manifest = validateManifest(raw.value);
  } catch (err) {
    return { problems: [`${PACK_MANIFEST_FILENAME}: ${RpError.from(err).message}`], warnings };
  }
  if (hasIgnoredCapabilities(raw.value)) warnings.push(ignoredCapabilitiesWarning(PACK_MANIFEST_FILENAME));

  const characters: LoadedCharacter[] = [];
  for (const dirInput of manifest.characters) {
    const character = await loadCharacter(rootAbs, dirInput, problems, warnings);
    if (character) characters.push(character);
  }
  const listedDir = manifest.characters[0] !== undefined ? normalizeRelativePath(manifest.characters[0]) : undefined;
  await checkSingleCharacterDir(rootAbs, listedDir?.ok ? listedDir.path : undefined, problems);

  const mediaRoot = manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT;
  const mediaAbs = safeResolve(rootAbs, mediaRoot, problems, PACK_MANIFEST_FILENAME);
  if (mediaAbs) {
    const mediaKind = await kindOf(mediaAbs);
    if (mediaKind === 'file' || mediaKind === 'other') {
      problems.push(`${PACK_MANIFEST_FILENAME}: mediaRoot "${mediaRoot}" is not a directory`);
    }
  }

  // media.json (optional)
  let mediaManifest: MediaManifest | null = null;
  const mediaManifestAbs = path.join(rootAbs, MEDIA_MANIFEST_FILENAME);
  if ((await kindOf(mediaManifestAbs)) === 'file') {
    const rawMedia = await readJson(mediaManifestAbs);
    if (!rawMedia.ok) {
      problems.push(`${MEDIA_MANIFEST_FILENAME}: ${rawMedia.error}`);
    } else {
      try {
        mediaManifest = validateMediaManifest(rawMedia.value);
      } catch (err) {
        problems.push(`${MEDIA_MANIFEST_FILENAME}: ${RpError.from(err).message}`);
      }
    }
  }

  let readme: string | undefined;
  const readmeAbs = path.join(rootAbs, PACK_README_FILENAME);
  if ((await kindOf(readmeAbs)) === 'file') readme = await fs.readFile(readmeAbs, 'utf8');

  if (problems.length > 0) return { problems, warnings };

  const assets = await indexAssets(rootAbs, mediaRoot, mediaManifest);

  for (const asset of assets) {
    if (asset.tags.length > MAX_TAGS_PER_ASSET) {
      problems.push(`asset "${asset.path}" has ${asset.tags.length} tags (max ${MAX_TAGS_PER_ASSET})`);
    }
  }
  if (mediaManifest) {
    mediaManifest.entries.forEach((entry, i) => {
      const re = globToRegExp(entry.match);
      if (!assets.some((a) => re.test(a.path))) {
        warnings.push(`warning: ${MEDIA_MANIFEST_FILENAME} entry ${i} ("${entry.match}") matches no asset`);
      }
    });
    const used = new Set(assets.flatMap((a) => a.tags));
    for (const tag of Object.keys(mediaManifest.tags ?? {})) {
      if (!used.has(tag)) warnings.push(`info: ${MEDIA_MANIFEST_FILENAME} vocabulary tag "${tag}" is not used by any asset`);
    }
  }
  if (problems.length > 0) return { problems, warnings };

  const character = characters[0];
  if (!character) return { problems: [`${PACK_MANIFEST_FILENAME}: the pack's character could not be loaded`], warnings };
  const pack: LoadedPack = { root: rootAbs, manifest, character, characters, assets };
  if (mediaManifest?.tags !== undefined) pack.tagDescriptions = mediaManifest.tags;
  if (readme !== undefined) pack.readme = readme;
  return { pack, problems, warnings };
}

/**
 * Loads a pack directory: `pack.json`, its one character (definition, persona
 * text, behaviour script sources, function library), the optional `README.md`,
 * and the asset index. Throws `RpError('PACK_INVALID', msg, { problems })` when
 * anything is wrong.
 */
export async function loadPack(root: string): Promise<LoadedPack> {
  const { pack, problems } = await inspectPack(root);
  if (!pack) {
    throw new RpError('PACK_INVALID', `Invalid pack at ${path.resolve(root)}:\n${problems.join('\n')}`, { problems });
  }
  return pack;
}

/**
 * Like {@link loadPack} but reports problems instead of throwing. Never throws
 * for content errors. `problems` lists errors followed by non-fatal
 * `warning:` / `info:` lines (also returned separately as `warnings`);
 * `ok` is `true` when there are no errors, even if there are warnings.
 */
export async function validatePack(root: string): Promise<{ ok: boolean; problems: string[]; warnings: string[] }> {
  try {
    const { problems, warnings } = await inspectPack(root);
    return { ok: problems.length === 0, problems: [...problems, ...warnings], warnings };
  } catch (err) {
    return { ok: false, problems: [RpError.from(err).message], warnings: [] };
  }
}
