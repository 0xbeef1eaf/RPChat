/**
 * The voice bank: reference recordings from the `kyutai/tts-voices` repository, which is what
 * Pocket TTS clones a character's voice from.
 *
 * The bank lives in the app's state directory, not in any pack. Auditioning a voice downloads its
 * wav and synthesises one cached sample sentence with it; *choosing* a voice copies the wav into
 * the character's own directory and sets `voice.reference`, so a published pack carries the voice
 * it speaks with instead of depending on the listener having downloaded the same bank.
 */

/** Hugging Face repository the bank mirrors. */
export const VOICE_BANK_REPO = 'kyutai/tts-voices';

/** The line every voice says when previewed. Fixed so one cached wav per voice serves every visit. */
export const VOICE_PREVIEW_SENTENCE = "Hey, it's good to see you again. What are we working on today?";

/**
 * Licence of one collection in the repo, transcribed from its README section. Shown in the picker
 * because copying a recording into a pack is the point at which the licence starts to matter.
 */
export interface VoiceBankCollection {
  /** First path segment in the repo, e.g. `expresso`. */
  id: string;
  label: string;
  /** SPDX-ish identifier, e.g. `CC0-1.0`, `CC-BY-4.0`, `CC-BY-NC-4.0`, or `mixed`. */
  license: string;
  /** True when the licence forbids commercial use, so the picker can warn before a voice is copied. */
  nonCommercial: boolean;
  /** One line on what the collection is. */
  note: string;
  /** How many voices the catalogue holds for it. */
  count: number;
}

/** One reference recording. `path` is the id, and what the editor copies into a character. */
export interface VoiceBankEntry {
  /** Repo-relative path, e.g. `expresso/ex03-ex02_narration_001_channel1_674s.wav`. */
  path: string;
  /** Owning collection id (the first path segment). */
  collection: string;
  /** Readable name derived from the filename. */
  label: string;
  bytes: number;
  /** An ai-coustics cleaned variant of another recording in the same collection (`*_enhanced.wav`). */
  enhanced: boolean;
  /** The wav has been downloaded to the bank. */
  ready: boolean;
  /** `rp-asset://` URL of the cached sample sentence, when one has been generated. */
  previewUrl?: string;
}

export interface VoiceBankCatalogue {
  repo: string;
  /** ISO-8601 time the file listing was last fetched. */
  fetchedAt: string;
  collections: VoiceBankCollection[];
  voices: VoiceBankEntry[];
  /** Voice models installed under `<userData>/voices/`, for the editor's model picker. */
  models: InstalledVoiceModel[];
  /** Why previews cannot be generated right now (no cloning model, no binary); absent when they can. */
  previewsUnavailable?: string;
}

/** A voice model the app found installed, as the editor lists it. */
export interface InstalledVoiceModel {
  name: string;
  /** Engine label, e.g. `Pocket TTS`. */
  label: string;
  engine: string;
  /** True when it takes its voice from reference audio rather than a speaker bank. */
  clones: boolean;
}

/** Progress of the background download of bank recordings. */
export interface VoiceBankProgress {
  /** Recordings already on disk. */
  ready: number;
  /** Recordings queued or in flight. */
  pending: number;
  /** Paths that failed, with the reason, capped to the most recent few. */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Licences and blurbs per collection, transcribed from the repository README. Collections the
 * catalogue turns up that are not listed here are shown with an `unknown` licence rather than
 * hidden, so a new upstream folder never silently disappears from the picker.
 */
export const VOICE_BANK_COLLECTIONS: Record<string, Omit<VoiceBankCollection, 'id' | 'count'>> = {
  'voice-donations': {
    label: 'Voice donations',
    license: 'CC0-1.0',
    nonCommercial: false,
    note: 'Volunteers from the Unmute Voice Donation Project (228 verified voices).',
  },
  vctk: {
    label: 'VCTK',
    license: 'CC-BY-4.0',
    nonCommercial: false,
    note: 'Voice Cloning Toolkit corpus; sentence 23 from each speaker.',
  },
  expresso: {
    label: 'Expresso',
    license: 'CC-BY-NC-4.0',
    nonCommercial: true,
    note: 'Expressive conversational speech. Non-commercial use only.',
  },
  ears: {
    label: 'EARS',
    license: 'CC-BY-NC-4.0',
    nonCommercial: true,
    note: '107 speakers plus per-emotion clips for two of them. Non-commercial use only.',
  },
  'cml-tts': {
    label: 'CML-TTS (French)',
    license: 'CC-BY-4.0',
    nonCommercial: false,
    note: 'French voices from the CML-TTS dataset.',
  },
  'alba-mackenna': {
    label: 'Alba MacKenna',
    license: 'CC-BY-4.0',
    nonCommercial: false,
    note: 'Voice-acted characters: casual, merchant, announcer, narration.',
  },
  'voice-zero': {
    label: 'Voice-Zero',
    license: 'CC0-1.0',
    nonCommercial: false,
    note: 'Curated LibriVox readers used in the Pocket TTS defaults.',
  },
  'unmute-prod-website': {
    label: 'Unmute.sh',
    license: 'mixed',
    nonCommercial: true,
    note: 'Voices used on Unmute.sh; mostly CC0, but one clip is CC-BY-NC and one CC-BY-4.0.',
  },
};

/** A filename turned into something readable: `p329_022.wav` → `p329 022`. */
export function voiceLabel(repoPath: string): string {
  const base = repoPath.split('/').pop() ?? repoPath;
  return base
    .replace(/\.wav$/i, '')
    .replace(/_enhanced$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}
