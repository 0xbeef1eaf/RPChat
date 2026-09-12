/** Pure helpers for the editor's "auto-tag with a vision model" run (no DOM, no API). */
import type { EditorAsset, MediaTagSuggestion, ProviderConfig } from '@rp/shared';
import type { AssetEdit, MediaEditModel } from './editor';

/** What the auto-tag dialog collects; kept between runs in the Media section. */
export interface TagRunSettings {
  providerId: string;
  /** Empty = the provider's own model. */
  model: string;
  maxTags: number;
  /** Only suggest tags the pack already uses or documents. */
  vocabularyOnly: boolean;
  /** Replace the asset's tags instead of adding to them. */
  replaceTags: boolean;
  /** Overwrite a description the asset already has. */
  overwriteDescriptions: boolean;
  /** Add invented tags to the tag vocabulary with the model's meaning. */
  addToVocabulary: boolean;
  guidance: string;
  scope: TagScope;
}

export type TagScope = 'untagged' | 'all';

export const DEFAULT_TAG_SETTINGS: TagRunSettings = {
  providerId: '',
  model: '',
  maxTags: 6,
  vocabularyOnly: false,
  replaceTags: false,
  overwriteDescriptions: false,
  addToVocabulary: true,
  guidance: '',
  scope: 'untagged',
};

/**
 * Formats the main process can decode on its own. Electron's `nativeImage` reads PNG and JPEG and
 * nothing else, so every other image (WebP, AVIF, GIF, BMP, SVG) is decoded here with a canvas and
 * sent along as a frame — otherwise tagging fails with "could not be decoded".
 */
const MAIN_DECODES = new Set(['image/png', 'image/jpeg']);

/** Which assets this side has to decode before asking for tags: video (always) and exotic images. */
export function needsRendererFrame(asset: Pick<EditorAsset, 'kind' | 'mime'>): boolean {
  if (asset.kind === 'video') return true;
  return asset.kind === 'image' && !MAIN_DECODES.has(asset.mime);
}

/** Same rule as `@rp/llm`'s `resolveSupportsVision`, without pulling the provider SDKs into the renderer. */
export function supportsVision(config: Pick<ProviderConfig, 'kind' | 'supportsVision'>): boolean {
  return config.supportsVision ?? config.kind === 'anthropic';
}

/** Providers that can look at an image (the mock provider answers anything, so it is offered too). */
export function visionProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((p) => p.kind === 'mock' || supportsVision(p));
}

/** The provider a run should start with: the last one used, else the default, else the first vision one. */
export function initialProviderId(providers: ProviderConfig[], lastUsed: string, defaultProviderId?: string): string {
  const vision = visionProviders(providers);
  if (vision.some((p) => p.id === lastUsed)) return lastUsed;
  if (defaultProviderId && vision.some((p) => p.id === defaultProviderId)) return defaultProviderId;
  return vision[0]?.id ?? '';
}

/** An asset counts as untagged when the draft gives it neither a manifest tag nor a description. */
export function isUntagged(asset: EditorAsset, model: MediaEditModel): boolean {
  const edit = model.perAsset[asset.path];
  return (edit?.tags.length ?? 0) === 0 && (edit?.description.trim().length ?? 0) === 0;
}

/** The assets a run covers: everything the user can see, narrowed to the untagged ones for `untagged`. */
export function taggableAssets(assets: EditorAsset[], model: MediaEditModel, scope: TagScope): EditorAsset[] {
  return scope === 'all' ? [...assets] : assets.filter((a) => isUntagged(a, model));
}

function mergeTags(existing: string[], suggested: string[], replace: boolean): string[] {
  const out = replace ? [] : [...existing];
  for (const tag of suggested) if (!out.includes(tag)) out.push(tag);
  return out;
}

/** Apply one suggestion to an asset's edit: tags merged (or replaced), description only filled when empty. */
export function applyToAsset(edit: AssetEdit | undefined, suggestion: MediaTagSuggestion, settings: Pick<TagRunSettings, 'replaceTags' | 'overwriteDescriptions'>): AssetEdit {
  const current = edit ?? { tags: [], description: '' };
  const description =
    suggestion.description.length > 0 && (settings.overwriteDescriptions || current.description.trim().length === 0) ? suggestion.description : current.description;
  return { tags: mergeTags(current.tags, suggestion.tags, settings.replaceTags), description };
}

/**
 * Fold accepted suggestions into the media.json draft: per-asset tags and descriptions, plus the
 * meanings of invented tags into the vocabulary (never overwriting a meaning the author wrote).
 */
export function applySuggestions(
  model: MediaEditModel,
  suggestions: MediaTagSuggestion[],
  settings: Pick<TagRunSettings, 'replaceTags' | 'overwriteDescriptions' | 'addToVocabulary'>,
): MediaEditModel {
  const perAsset = { ...model.perAsset };
  const vocabulary = { ...model.vocabulary };
  for (const s of suggestions) {
    if (s.error || (s.tags.length === 0 && s.description.length === 0)) continue;
    perAsset[s.path] = applyToAsset(perAsset[s.path], s, settings);
    if (!settings.addToVocabulary) continue;
    for (const tag of s.newTags) {
      const meaning = s.vocabulary[tag];
      if (!(tag in vocabulary)) vocabulary[tag] = meaning ?? '';
      else if (!vocabulary[tag] && meaning) vocabulary[tag] = meaning;
    }
  }
  return { ...model, perAsset, vocabulary };
}

/** One line per suggestion for the run summary: "4 tagged, 1 failed, 2 skipped". */
export function summarise(suggestions: MediaTagSuggestion[]): string {
  const failed = suggestions.filter((s) => s.error).length;
  const empty = suggestions.filter((s) => !s.error && s.tags.length === 0 && s.description.length === 0).length;
  const ok = suggestions.length - failed - empty;
  const parts = [`${ok} tagged`];
  if (empty > 0) parts.push(`${empty} with nothing to say`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(', ');
}
