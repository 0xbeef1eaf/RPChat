import { describe, expect, it } from 'vitest';
import type { MediaEditModel } from './editor';
import {
  ensureWallpaperVocabulary,
  isWallpaper,
  setWallpaperTag,
  usesWallpaperTag,
  wallpaperSource,
  wallpaperWarnings,
  WALLPAPER_MEANING,
} from './wallpaper';

describe('wallpaper helpers', () => {
  it('isWallpaper / wallpaperSource: images only, folder wins over manifest', () => {
    expect(wallpaperSource({ kind: 'image', folderTags: ['images', 'wallpapers'], manifestTags: [] })).toBeNull();
    expect(wallpaperSource({ kind: 'image', folderTags: ['wallpaper'], manifestTags: ['wallpaper'] })).toBe('folder');
    expect(wallpaperSource({ kind: 'image', folderTags: [], manifestTags: ['wallpaper'] })).toBe('manifest');
    expect(isWallpaper({ kind: 'video', folderTags: ['wallpaper'], manifestTags: [] })).toBe(false);
    expect(isWallpaper({ kind: 'image', folderTags: [], manifestTags: ['scene'] })).toBe(false);
  });

  it('wallpaperWarnings flags narrow and portrait images', () => {
    expect(wallpaperWarnings(1920, 1080)).toEqual([]);
    expect(wallpaperWarnings(1280, 720)).toEqual([]);
    expect(wallpaperWarnings(1024, 768)).toEqual(['only 1024 px wide (below 1280)']);
    expect(wallpaperWarnings(1440, 2560)).toEqual(['portrait orientation']);
    expect(wallpaperWarnings(800, 1200)).toHaveLength(2);
    expect(wallpaperWarnings(0, 0)).toEqual([]);
  });


  it('adds the default vocabulary meaning only when the tag is used and undocumented', () => {
    const base: MediaEditModel = { perAsset: { 'a.png': { tags: [], description: '' } }, rules: [], vocabulary: {}, folderTags: true };
    expect(usesWallpaperTag(base, {})).toBe(false);
    expect(ensureWallpaperVocabulary(base, {})).toBe(base);
    const tagged = { ...base, perAsset: { 'a.png': { tags: ['wallpaper'], description: '' } } };
    expect(ensureWallpaperVocabulary(tagged, {}).vocabulary.wallpaper).toBe(WALLPAPER_MEANING);
    const documented = { ...tagged, vocabulary: { wallpaper: 'custom' } };
    expect(ensureWallpaperVocabulary(documented, {}).vocabulary.wallpaper).toBe('custom');
    expect(usesWallpaperTag(base, { 'a.png': ['wallpaper'] })).toBe(true);
    expect(usesWallpaperTag({ ...base, folderTags: false }, { 'a.png': ['wallpaper'] })).toBe(false);
    expect(usesWallpaperTag({ ...base, rules: [{ match: 'media/images/wallpapers/', tags: ['wallpaper'] }] }, {})).toBe(true);
  });

  it('setWallpaperTag toggles idempotently', () => {
    expect(setWallpaperTag([], true)).toEqual(['wallpaper']);
    expect(setWallpaperTag(['wallpaper'], true)).toEqual(['wallpaper']);
    expect(setWallpaperTag(['a', 'wallpaper'], false)).toEqual(['a']);
  });
});
