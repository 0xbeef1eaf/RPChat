/** Pure helpers for wallpaper assets in the pack editor. */
import type { MediaEditModel } from './editor';

export const WALLPAPER_TAG = 'wallpaper';
export const WALLPAPER_MEANING = 'Full-screen scene meant to be set as the desktop background';
export const WALLPAPER_MIN_WIDTH = 1280;

export interface WallpaperCandidate {
  kind: string;
  /** Tags implied by the folder path (not editable per file). */
  folderTags: string[];
  /** Tags assigned in media.json — the draft's per-asset tags when editing. */
  manifestTags: string[];
}

export type WallpaperSource = 'folder' | 'manifest' | null;

/** Where the `wallpaper` tag comes from, if anywhere. Folder wins (it cannot be removed per file). */
export function wallpaperSource(asset: WallpaperCandidate): WallpaperSource {
  if (asset.kind !== 'image') return null;
  if (asset.folderTags.includes(WALLPAPER_TAG)) return 'folder';
  if (asset.manifestTags.includes(WALLPAPER_TAG)) return 'manifest';
  return null;
}

export function isWallpaper(asset: WallpaperCandidate): boolean {
  return wallpaperSource(asset) !== null;
}

/** Warnings for a wallpaper's natural resolution. */
export function wallpaperWarnings(width: number, height: number): string[] {
  const out: string[] = [];
  if (!(width > 0 && height > 0)) return out;
  if (width < WALLPAPER_MIN_WIDTH) out.push(`only ${width} px wide (below ${WALLPAPER_MIN_WIDTH})`);
  if (height > width) out.push('portrait orientation');
  return out;
}

/** True when wallpaper assets exist but the manifest does not request the `wallpaper` capability. */
export function needsWallpaperCapability(hasWallpapers: boolean, capabilities: string[] | undefined): boolean {
  return hasWallpapers && !(capabilities ?? []).includes(WALLPAPER_TAG);
}

export function withWallpaperCapability(capabilities: string[] | undefined): string[] {
  const list = capabilities ?? [];
  return list.includes(WALLPAPER_TAG) ? list : [...list, WALLPAPER_TAG];
}

/** Whether any per-asset edit or rule uses the wallpaper tag (folder tags are passed separately). */
export function usesWallpaperTag(model: MediaEditModel, folderTagsByAsset: Record<string, string[]>): boolean {
  if (Object.values(model.perAsset).some((e) => e.tags.includes(WALLPAPER_TAG))) return true;
  if (model.rules.some((r) => (r.tags ?? []).includes(WALLPAPER_TAG))) return true;
  return model.folderTags && Object.values(folderTagsByAsset).some((t) => t.includes(WALLPAPER_TAG));
}

/** Add the default vocabulary meaning for `wallpaper` when the tag is used but undocumented. */
export function ensureWallpaperVocabulary(model: MediaEditModel, folderTagsByAsset: Record<string, string[]>): MediaEditModel {
  if (!usesWallpaperTag(model, folderTagsByAsset)) return model;
  if (model.vocabulary[WALLPAPER_TAG]?.trim()) return model;
  return { ...model, vocabulary: { ...model.vocabulary, [WALLPAPER_TAG]: WALLPAPER_MEANING } };
}

/** Toggle the manifest `wallpaper` tag on a tag list. */
export function setWallpaperTag(tags: string[], on: boolean): string[] {
  if (on) return tags.includes(WALLPAPER_TAG) ? tags : [...tags, WALLPAPER_TAG];
  return tags.filter((t) => t !== WALLPAPER_TAG);
}
