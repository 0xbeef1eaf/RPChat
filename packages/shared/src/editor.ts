import type { BehaviourHook } from './capability.js';
import type { AssetEntry, CharacterDefinition, MediaManifest, PackManifest, TagSummary } from './pack.js';

/** A pack folder open for editing (lives in the workspace dir or anywhere the user chose). */
export interface EditorProjectSummary {
  /** Stable key for IPC and asset URLs (hash of the directory). */
  key: string;
  dir: string;
  packId: string;
  name: string;
  version: string;
  characterCount: number;
  updatedAt: string;
  /** True when a pack with the same id is installed in the app. */
  installed: boolean;
}

export interface EditorCharacter {
  /** Directory relative to the pack root, e.g. `characters/luna`. */
  dir: string;
  definition: CharacterDefinition;
  personaText: string;
  /** Hook → script source. */
  behaviours: Partial<Record<BehaviourHook, string>>;
  /** `rp-asset://` URL of the avatar, when present. */
  avatarUrl?: string;
  /** Expression name → `rp-asset://` URL (from `avatarSet`). */
  expressionUrls?: Record<string, string>;
}

export interface EditorAsset extends AssetEntry {
  /** `rp-asset://` URL for previews. */
  url: string;
  /** Tags coming from folder names (not editable per file). */
  folderTags: string[];
  /** Tags assigned through media.json entries that match this file. */
  manifestTags: string[];
}

export interface EditorValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** Everything the editor UI needs for one project. */
export interface EditorProject {
  summary: EditorProjectSummary;
  manifest: PackManifest;
  characters: EditorCharacter[];
  mediaManifest: MediaManifest;
  assets: EditorAsset[];
  tags: TagSummary[];
  readme: string;
  validation: EditorValidation;
}

export interface CreateProjectInput {
  /** Reverse-DNS id, e.g. `com.me.luna`. */
  packId: string;
  name: string;
  characterId: string;
  characterName: string;
  /** Parent directory; default: the app workspace. */
  parentDir?: string;
}

export interface SaveCharacterInput {
  dir: string;
  definition: CharacterDefinition;
  personaText: string;
  behaviours: Partial<Record<BehaviourHook, string>>;
}

/** Hook script templates offered by the editor. */
export interface BehaviourTemplate {
  hook: BehaviourHook;
  title: string;
  source: string;
}
