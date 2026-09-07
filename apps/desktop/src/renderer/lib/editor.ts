/** Pure helpers for the pack editor (no DOM, no API). */
import type { MediaManifest, MediaManifestEntry } from '@rp/shared';

/** Lower-case id from a display name: `Luna Moon!` → `luna-moon`. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Character ids must match /^[a-z0-9][a-z0-9-_]*$/; fall back to `character` when the name yields nothing. */
export function suggestCharacterId(name: string): string {
  const s = slugify(name);
  return s || 'character';
}

/** `com.<user>.<slug>` — user from the display name (or `me`), slug from the pack name. */
export function suggestPackId(packName: string, userDisplayName: string | undefined): string {
  const user = slugify(userDisplayName ?? '').replace(/-/g, '') || 'me';
  const slug = slugify(packName).replace(/-/g, '') || 'pack';
  return `com.${user}.${slug}`;
}

export const PACK_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const CHARACTER_ID_RE = /^[a-z0-9][a-z0-9-_]*$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidPackId(id: string): boolean {
  return PACK_ID_RE.test(id);
}
export function isValidCharacterId(id: string): boolean {
  return CHARACTER_ID_RE.test(id);
}
export function isSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** A media.json `match` is a rule when it contains glob characters or ends like a directory. */
export function isGlobMatch(match: string): boolean {
  return /[*?[\]{}]/.test(match) || match.endsWith('/');
}

export interface AssetEdit {
  tags: string[];
  description: string;
}

/** Edit model for `media.json`: one exact entry per asset path, glob rules, vocabulary. */
export interface MediaEditModel {
  perAsset: Record<string, AssetEdit>;
  rules: MediaManifestEntry[];
  vocabulary: Record<string, string>;
  folderTags: boolean;
}

function normTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Split a manifest into the edit model. Exact-path entries (non-glob) that name a known asset
 * become per-asset edits (several entries for the same path are merged); everything else — globs,
 * directories, and exact paths of files that no longer exist — stays a rule.
 */
export function toEditModel(manifest: MediaManifest | undefined, assetPaths: string[]): MediaEditModel {
  const known = new Set(assetPaths);
  const perAsset: Record<string, AssetEdit> = {};
  const rules: MediaManifestEntry[] = [];
  for (const entry of manifest?.entries ?? []) {
    const match = entry.match.replace(/^\.?\//, '');
    if (!isGlobMatch(match) && known.has(match)) {
      const cur = perAsset[match] ?? { tags: [], description: '' };
      perAsset[match] = {
        tags: normTags([...cur.tags, ...(entry.tags ?? [])]),
        description: entry.description?.trim() || cur.description,
      };
    } else {
      rules.push({ match: entry.match, tags: normTags(entry.tags), ...(entry.description ? { description: entry.description } : {}) });
    }
  }
  for (const p of assetPaths) if (!perAsset[p]) perAsset[p] = { tags: [], description: '' };
  return { perAsset, rules, vocabulary: { ...(manifest?.tags ?? {}) }, folderTags: manifest?.folderTags ?? true };
}

/** Build the canonical manifest: rules first (in order), then one exact entry per asset that has tags or a description. */
export function fromEditModel(model: MediaEditModel): MediaManifest {
  const entries: MediaManifestEntry[] = model.rules
    .filter((r) => r.match.trim().length > 0)
    .map((r) => {
      const e: MediaManifestEntry = { match: r.match.trim() };
      const tags = normTags(r.tags);
      if (tags.length) e.tags = tags;
      if (r.description?.trim()) e.description = r.description.trim();
      return e;
    });
  for (const path of Object.keys(model.perAsset).sort()) {
    const edit = model.perAsset[path]!;
    const tags = normTags(edit.tags);
    const description = edit.description.trim();
    if (tags.length === 0 && !description) continue;
    const e: MediaManifestEntry = { match: path };
    if (tags.length) e.tags = tags;
    if (description) e.description = description;
    entries.push(e);
  }
  const out: MediaManifest = { entries };
  const vocab: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.vocabulary)) {
    const key = k.trim().toLowerCase();
    if (key) vocab[key] = v.trim();
  }
  if (Object.keys(vocab).length) out.tags = vocab;
  if (!model.folderTags) out.folderTags = false;
  return out;
}

/** Tags referenced anywhere (per-asset, rules, folder tags of assets). */
export function usedTags(model: MediaEditModel, folderTagsByAsset: Record<string, string[]>): Set<string> {
  const used = new Set<string>();
  for (const e of Object.values(model.perAsset)) for (const t of e.tags) used.add(t);
  for (const r of model.rules) for (const t of r.tags ?? []) used.add(t);
  if (model.folderTags) for (const tags of Object.values(folderTagsByAsset)) for (const t of tags) used.add(t);
  return used;
}

/** Vocabulary entries no asset or rule uses. */
export function unusedVocabulary(model: MediaEditModel, folderTagsByAsset: Record<string, string[]>): string[] {
  const used = usedTags(model, folderTagsByAsset);
  return Object.keys(model.vocabulary).filter((t) => !used.has(t));
}

/** Tags used somewhere but missing from the vocabulary (suggested additions). */
export function undocumentedTags(model: MediaEditModel, folderTagsByAsset: Record<string, string[]>): string[] {
  return Array.from(usedTags(model, folderTagsByAsset)).filter((t) => !(t in model.vocabulary)).sort();
}

/* ---------- dirty tracking ---------- */

export interface DraftState<T> {
  saved: T;
  draft: T;
  dirty: boolean;
  /** Bumped on every `reset`/`saved` so editors can re-key inputs. */
  generation: number;
}

export type DraftAction<T> =
  | { type: 'edit'; patch: Partial<T> | ((draft: T) => T) }
  /** New saved value from disk; drops the draft. */
  | { type: 'reset'; saved: T }
  /** A save succeeded: the given value (or the draft) is now the saved state. */
  | { type: 'saved'; saved?: T }
  /** Something external (a picker) changed the saved value; keep local edits on top. */
  | { type: 'external'; saved: T; keep: (draft: T, saved: T) => T };

export function initialDraft<T>(saved: T): DraftState<T> {
  return { saved, draft: saved, dirty: false, generation: 0 };
}

export function draftReducer<T>(state: DraftState<T>, action: DraftAction<T>, isEqual: (a: T, b: T) => boolean = jsonEqual): DraftState<T> {
  switch (action.type) {
    case 'edit': {
      const draft = typeof action.patch === 'function' ? (action.patch as (d: T) => T)(state.draft) : { ...state.draft, ...action.patch };
      return { ...state, draft, dirty: !isEqual(draft, state.saved) };
    }
    case 'reset':
      return { saved: action.saved, draft: action.saved, dirty: false, generation: state.generation + 1 };
    case 'saved': {
      const saved = action.saved ?? state.draft;
      return { saved, draft: saved, dirty: false, generation: state.generation + 1 };
    }
    case 'external': {
      const draft = action.keep(state.draft, action.saved);
      return { saved: action.saved, draft, dirty: !isEqual(draft, action.saved), generation: state.generation + 1 };
    }
    default:
      return state;
  }
}

export function jsonEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
