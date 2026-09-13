import type { BehaviourHook } from './capability.js';
import type { LlmReasoningEffort } from './llm.js';
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

/** One `lib/<name>.ts` function file of the character, as the editor shows it. */
export interface EditorScript {
  /** Function name = file stem (`lib.<name>(...)`). */
  name: string;
  /** From the file's first-line `// …` comment. */
  description?: string;
  /** The function expression (without the description comment). */
  source: string;
  bytes: number;
  /** Path relative to the pack root, e.g. `characters/luna/lib/cheer.ts`. */
  file: string;
  /** Why the loader skips this file (not a single function expression, bad name); absent when it loads. */
  problem?: string;
}

export interface EditorCharacter {
  /** Directory relative to the pack root, e.g. `characters/luna`. */
  dir: string;
  definition: CharacterDefinition;
  personaText: string;
  /** Hook → script source. */
  behaviours: Partial<Record<BehaviourHook, string>>;
  /** The function library (`lib/*.ts`), sorted by name; files the loader skips are included with `problem`. */
  library: EditorScript[];
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

/** Write (or rename) one library function file: `<dir>/lib/<name>.ts`. */
export interface SaveScriptInput {
  /** Character directory relative to the pack root. */
  dir: string;
  name: string;
  /** The function expression (arrow or `async function`); saved as is, so a broken one is reported rather than refused. */
  source: string;
  description?: string;
  /** When renaming: the file `<previousName>.ts` is removed after the new one is written. */
  previousName?: string;
}

/** Which compiler check `editor.checkScript` runs: a hook script (an async function body) or a library function (one function expression). */
export type ScriptKind = 'behaviour' | 'function';

/**
 * One problem in a behaviour script, from compiling it exactly as the sandbox will. `line`/`column`
 * are 1-based and relative to the script the author is looking at.
 */
export interface ScriptProblem {
  message: string;
  line?: number;
  column?: number;
  /** The offending line, as the compiler saw it. */
  lineText?: string;
}

/** Hook script templates offered by the editor. */
export interface BehaviourTemplate {
  hook: BehaviourHook;
  title: string;
  source: string;
}

/**
 * How a tag suggestion was made: the model saw the image itself, a frame grabbed from a video,
 * the file's text, or only its name and folder (audio and undecodable files).
 */
export type MediaTagBasis = 'image' | 'frame' | 'text' | 'filename';

/** Options for one auto-tagging run (pack editor → vision model, e.g. qwen3-vl on Ollama). */
export interface TagMediaOptions {
  /** Provider to call; default: the app's default provider. Must be vision-capable for images. */
  providerId?: string;
  /** Model override, e.g. `qwen3-vl:8b`. Default: the provider's model. */
  model?: string;
  /** Most tags to suggest per asset (1..20). Default 6. */
  maxTags?: number;
  /** Only suggest tags the pack already uses or documents. Default false. */
  vocabularyOnly?: boolean;
  /** Extra guidance from the author ("a noir detective pack; tag by mood"). */
  guidance?: string;
  /**
   * Ask the provider to constrain the answer to the tag schema (`response_format`) instead of
   * only describing it in the prompt. Off by default: OpenAI-compatible servers support it, but
   * not all of them. Worth turning on for a reasoning model, which otherwise thinks past its
   * token budget without ever answering.
   */
  jsonSchema?: boolean;
  /**
   * How much the model may think first. `none` turns a local reasoning model from unusable
   * (thousands of tokens of deliberation, no answer) into a fast one — when its template
   * supports the switch; Qwen3.5 does, Qwen3-VL does not.
   */
  reasoningEffort?: LlmReasoningEffort;
  /**
   * Tags and meanings coined earlier in the same run. The editor tags one asset per call, so
   * without this every asset is tagged against `media.json` as it stood when the run started and
   * the model coins `cosy`, `cozy` and `snug` for one idea. (A multi-asset call carries its own
   * answers forward by itself.)
   */
  learned?: { tags?: string[]; vocabulary?: Record<string, string> };
  /**
   * Base64 PNG frames (no `data:` prefix) for assets main cannot decode itself, by asset path.
   * The renderer grabs these from `<video>` elements.
   */
  frames?: Record<string, string>;
}

/** What the model suggested for one asset. Nothing is written: the editor applies these to its draft. */
export interface MediaTagSuggestion {
  path: string;
  /** Normalised, deduplicated, capped at `maxTags`; folder tags are left out (they apply anyway). */
  tags: string[];
  /** Subset of `tags` the pack does not use or document yet. */
  newTags: string[];
  /** One line for `media.json`, at most 200 characters. Empty when the model gave none. */
  description: string;
  /** Meanings for `newTags`, for the tag vocabulary table. */
  vocabulary: Record<string, string>;
  basis: MediaTagBasis;
  /** Model that answered, as reported by the provider. */
  model?: string;
  /** Set when this asset could not be tagged; `tags` and `description` are then empty. */
  error?: string;
}
