import type { BehaviourHook } from './capability.js';
import type { CharacterId, PackId } from './ids.js';

export const PACK_FORMAT_VERSION = 1 as const;
export const PACK_MANIFEST_FILENAME = 'pack.json';
export const CHARACTER_MANIFEST_FILENAME = 'character.json';
export const PACK_FILE_EXTENSION = '.rppack';

export interface PackAuthor {
  name: string;
  url?: string;
  email?: string;
}

/** Contents of `pack.json`. Validated by `@rp/pack` (zod). */
export interface PackManifest {
  formatVersion: typeof PACK_FORMAT_VERSION;
  id: PackId;
  name: string;
  version: string;
  description?: string;
  author?: PackAuthor;
  license?: string;
  homepage?: string;
  tags?: string[];
  /** Directories (relative to pack root) containing a `character.json`. */
  characters: string[];
  /** Pack-level `pack`/`prompt` capability requests; `trusted` modules are implicit. */
  capabilities?: string[];
  /** Directory (relative to pack root) that holds media assets. Default `media`. */
  mediaRoot?: string;
  minAppVersion?: string;
}

export interface ExampleDialogueTurn {
  user: string;
  character: string;
}

export interface ModelHints {
  temperature?: number;
  maxTokens?: number;
  /** Preferred provider model id; the user's settings may override. */
  model?: string;
}

/** Contents of `character.json`. Paths are relative to the character directory. */
export interface CharacterDefinition {
  id: CharacterId;
  name: string;
  tagline?: string;
  avatar?: string;
  /** Markdown file containing the persona / system prompt body. */
  persona: string;
  greeting?: string;
  exampleDialogue?: ExampleDialogueTurn[];
  /** Hook → TypeScript file (relative to character dir) executed in the sandbox. */
  behaviours?: Partial<Record<BehaviourHook, string>>;
  /** Persistent on-screen avatar (used by `sdk.avatar`). Paths are relative to the character directory. */
  avatarSet?: {
    /** Expression name → image (png/gif/webp/apng) or short video (webm). Should include `neutral`. */
    expressions: Record<string, string>;
    defaultExpression?: string;
    /** Rendered width in CSS px. Default 240. */
    size?: number;
  };
  /** Baselines for the mood model (`sdk.mood`). */
  mood?: { baseline?: number; energyBaseline?: number };
  /** Extra capability requests specific to this character. */
  capabilities?: string[];
  modelHints?: ModelHints;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'text' | 'other';

export interface AssetEntry {
  /** Path relative to the pack root, forward slashes. */
  path: string;
  kind: AssetKind;
  bytes: number;
  mime: string;
  /**
   * Lower-case tags: the asset's folder names (implicit) plus whatever `media.json` assigns.
   * Sorted, deduplicated. Empty when neither applies.
   */
  tags: string[];
  /** Author-written one-liner from `media.json`, if any. */
  description?: string;
}

export const MEDIA_MANIFEST_FILENAME = 'media.json';

/** One rule in `media.json`: applies tags/description to every asset matching `match`. */
export interface MediaManifestEntry {
  /** Pack-relative path or glob (`*`, `**`, `?`; a bare directory matches everything under it). */
  match: string;
  tags?: string[];
  description?: string;
}

/**
 * Optional `media.json` at the pack root describing the media so a character can pick assets
 * by meaning. Tags from all matching entries and from the asset's folder names are merged.
 */
export interface MediaManifest {
  entries: MediaManifestEntry[];
  /** Tag vocabulary: tag → short meaning, shown to the model. */
  tags?: Record<string, string>;
  /** When false, folder names are not turned into tags. Default true. */
  folderTags?: boolean;
}

/** A tag as summarised for the prompt and `sdk.pack.tags()`. */
export interface TagSummary {
  tag: string;
  count: number;
  description?: string;
}

/** A fully loaded, validated pack (manifest + characters + resolved persona text + asset index). */
export interface LoadedPack {
  root: string;
  manifest: PackManifest;
  characters: LoadedCharacter[];
  assets: AssetEntry[];
  /** Tag vocabulary from `media.json`, if present. */
  tagDescriptions?: Record<string, string>;
  readme?: string;
}

export interface LoadedCharacter {
  /** Directory relative to pack root. */
  dir: string;
  definition: CharacterDefinition;
  personaText: string;
  /** Hook → script source text. */
  behaviourSources: Partial<Record<BehaviourHook, string>>;
  /** Avatar path relative to the pack root, if any. */
  avatarPath?: string;
}

/** Record kept by the app for an installed pack. */
export interface InstalledPackRecord {
  packId: PackId;
  version: string;
  name: string;
  root: string;
  installedAt: string;
  /** Capabilities requested by the pack (pack + character level, deduplicated). */
  requestedCapabilities: string[];
  characterIds: CharacterId[];
}

/** What the renderer needs to list characters. */
export interface CharacterSummary {
  ref: string;
  packId: PackId;
  packName: string;
  characterId: CharacterId;
  name: string;
  tagline?: string;
  /** `rp-asset://` URL, if the character has an avatar. */
  avatarUrl?: string;
}
