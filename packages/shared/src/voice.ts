/**
 * Voice types shared by the host and the pack editor.
 *
 * A character's voice comes from a recording the author supplies, which lives inside the pack, so a
 * published pack carries the voice it speaks with. There is no shared library to browse: the author
 * brings their own clip.
 */

/** The line a voice says when the editor previews it, unless the author types something else. */
export const VOICE_PREVIEW_SENTENCE = "Hey, it's good to see you again. What are we working on today?";

/** Longest preview line the editor will synthesise, so one stray paste cannot tie up the engine. */
export const VOICE_PREVIEW_MAX = 300;

/** A voice model the app found installed, as the editor lists it. */
export interface InstalledVoiceModel {
  name: string;
  /** Engine label, e.g. `Pocket TTS`. */
  label: string;
  engine: string;
  /** True when it takes its voice from reference audio rather than a speaker bank. */
  clones: boolean;
}

/**
 * State of something the app fetches for itself on first start — the speech engine, or the default
 * voice model. Anything the user already has is used instead of downloading.
 */
export interface AssetInstallStatus {
  /**
   * `present` — found on this machine already, nothing to do.
   * `absent` — not installed and not yet fetched.
   * `downloading` / `extracting` — in progress.
   * `ready` — the managed copy is installed and usable.
   * `failed` — the last attempt failed; `error` says why.
   * `unsupported` — no published build for this platform and architecture.
   * `disabled` — the user turned the automatic download off.
   */
  state: 'present' | 'absent' | 'downloading' | 'extracting' | 'ready' | 'failed' | 'unsupported' | 'disabled';
  /** Pinned upstream release, or the name of whatever is installed. */
  version: string;
  /** Bytes fetched so far and the expected total, while downloading. */
  received?: number;
  total?: number;
  /** Absolute path of the binary or directory once it is usable. */
  path?: string;
  error?: string;
}

/** State of the speech engine the app fetches for itself. */
export type SherpaInstallStatus = AssetInstallStatus;

/** What the editor's voice panel needs to render itself. */
export interface VoiceStudioState {
  /** Voice models installed under `<userData>/voices/`. */
  models: InstalledVoiceModel[];
  /** State of the speech engine, so a first run shows a download rather than dead buttons. */
  engine?: AssetInstallStatus;
  /** State of the default voice model, fetched the same way. */
  model?: AssetInstallStatus;
  /** Why previews cannot be generated right now; absent when they can. */
  unavailable?: string;
}

/** One rendered preview, as the editor plays it. */
export interface VoicePreview {
  /** `rp-asset://` URL of the generated wav. */
  url: string;
  /** Seconds of audio. */
  duration: number;
  /**
   * The seed actually used. The model samples, so an unseeded take is gone once it plays; reporting
   * the seed lets an author keep one they liked by pinning it on the character.
   */
  seed: number;
}
