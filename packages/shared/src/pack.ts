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
  /**
   * The directory (relative to the pack root) containing the pack's `character.json`.
   * A pack has exactly one character, so this array always holds exactly one entry; it stays an
   * array for format compatibility (`packId/characterId` refs, `characters/<id>/…` layout).
   */
  characters: string[];
  /** Directory (relative to pack root) that holds media assets. Default `media`. */
  mediaRoot?: string;
  minAppVersion?: string;
}

export interface ExampleDialogueTurn {
  user: string;
  character: string;
}

/**
 * How a character sounds in `sdk.voice.speak()`. Every field is optional: a character with no
 * `voice` block speaks with the app's default voice model (Settings → Voice), and a character
 * with one still falls back to it for anything it leaves out.
 */
export interface CharacterVoice {
  /**
   * Directory name of an installed voice model (under the app's `voices` folder), e.g.
   * `sherpa-onnx-pocket-tts-int8-2026-01-26`. Overridden per call by `speak(text, { voice })`.
   */
  model?: string;
  /**
   * Reference audio for zero-shot cloning models (PocketTTS, ZipVoice): a few seconds of wav,
   * relative to the character directory. This is what makes the character sound like itself;
   * without it a cloning model falls back to the sample shipped with the model.
   */
  reference?: string;
  /** Transcript of `reference`. ZipVoice requires it; PocketTTS ignores it. */
  referenceText?: string;
  /**
   * Where `reference` came from, when it was copied in from the voice bank, e.g.
   * `kyutai/tts-voices:vctk/p329_022.wav`. Kept so the editor can show what a character's voice is
   * and so an attributed licence (CC BY) can be traced back to its source.
   */
  referenceSource?: string;
  /** Credit line for `reference`, filled in for collections whose licence requires attribution. */
  attribution?: string;
  /** Speaker id for multi-speaker models (Kokoro, VITS/VCTK). Ignored by cloning models. */
  speaker?: number;
  /** Baseline speed multiplier; `speak(text, { rate })` overrides it. */
  rate?: number;
  /** Flow-matching steps for PocketTTS/Supertonic: fewer is faster, more is smoother. */
  steps?: number;
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
  /** How the character sounds in `sdk.voice.speak()`. Paths are relative to the character directory. */
  voice?: CharacterVoice;
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
  /**
   * `avatar` for a character's card avatar and `avatarSet` expression frames. They stay resolvable by
   * path (the avatar overlay and the editor need them) but `sdk.pack` listings, searches and tag
   * summaries leave them out: they are the character's face, not media to show.
   */
  role?: 'avatar';
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

/** A fully loaded, validated pack (manifest + its character + resolved persona text + asset index). */
export interface LoadedPack {
  root: string;
  manifest: PackManifest;
  /** The pack's one character (the same object as `characters[0]`). */
  character: LoadedCharacter;
  /** Kept for compatibility: always exactly one entry, `character`. */
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
  /**
   * The character's function library (`sdk.lib`), read from `characters/<id>/lib/<name>.ts`:
   * name → entry, sorted by name. Files the loader had to skip are reported as warnings.
   */
  library: Record<string, CharacterLibraryEntry>;
  /** Avatar path relative to the pack root, if any. */
  avatarPath?: string;
}

/**
 * One `sdk.lib` function as shipped in (or saved into) the pack. The file is
 * `characters/<id>/lib/<name>.ts`: an optional first-line `// <description>`
 * comment followed by exactly one function expression.
 */
export interface CharacterLibraryEntry {
  /** The function expression (everything after the description comment). */
  source: string;
  /** From the file's leading `// …` comment, when present. */
  description?: string;
  /** UTF-8 size of `source`. */
  bytes: number;
  /** Path relative to the pack root, e.g. `characters/luna/lib/cheer.ts`. */
  file: string;
  /** ISO-8601 modification time of the file (what `sdk.lib.list()` reports as `updatedAt`). */
  updatedAt: string;
}

/** Record kept by the app for an installed pack. */
export interface InstalledPackRecord {
  packId: PackId;
  version: string;
  name: string;
  root: string;
  installedAt: string;
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
