import { describe, expect, it } from 'vitest';
import type { MediaManifest } from '@rp/shared';
import {
  draftReducer,
  fromEditModel,
  initialDraft,
  isGlobMatch,
  isSemver,
  isValidCharacterId,
  isValidPackId,
  slugify,
  suggestCharacterId,
  suggestPackId,
  toEditModel,
  undocumentedTags,
  unusedVocabulary,
  wordCount,
} from './editor';

describe('ids', () => {
  it('slugify', () => {
    expect(slugify('Luna Moon!')).toBe('luna-moon');
    expect(slugify('  Ärger & Éclair ')).toBe('arger-eclair');
    expect(slugify('___')).toBe('');
    expect(slugify('a--b')).toBe('a-b');
  });
  it('suggestPackId / suggestCharacterId', () => {
    expect(suggestPackId('Luna Pack', 'Alex Stevens')).toBe('com.alexstevens.lunapack');
    expect(suggestPackId('', undefined)).toBe('com.me.pack');
    expect(suggestPackId('Luna', 'You')).toBe('com.you.luna');
    expect(suggestCharacterId('Luna the Cat')).toBe('luna-the-cat');
    expect(suggestCharacterId('!!!')).toBe('character');
    expect(isValidPackId(suggestPackId('Luna Pack', 'Alex Stevens'))).toBe(true);
    expect(isValidCharacterId(suggestCharacterId('Luna the Cat'))).toBe(true);
  });
  it('validators', () => {
    expect(isValidPackId('com.example.luna')).toBe(true);
    expect(isValidPackId('luna')).toBe(false);
    expect(isValidPackId('Com.Example')).toBe(false);
    expect(isValidCharacterId('-x')).toBe(false);
    expect(isSemver('1.0.0')).toBe(true);
    expect(isSemver('1.0.0-beta.1')).toBe(true);
    expect(isSemver('1.0')).toBe(false);
  });
  it('isGlobMatch', () => {
    expect(isGlobMatch('media/images/*.png')).toBe(true);
    expect(isGlobMatch('media/video/**')).toBe(true);
    expect(isGlobMatch('media/audio/')).toBe(true);
    expect(isGlobMatch('media/audio/chime.wav')).toBe(false);
  });
});

describe('media.json ⇄ edit model', () => {
  const assets = ['media/images/luna-smile.png', 'media/images/luna-wave.png', 'media/audio/chime.wav'];
  const manifest: MediaManifest = {
    folderTags: true,
    tags: { portrait: 'A picture of Luna', smile: 'Smiling', chime: 'A bell', orphan: 'unused' },
    entries: [
      { match: 'media/images/luna-*.png', tags: ['portrait'] },
      { match: 'media/images/luna-smile.png', tags: ['Smile', 'happy'], description: 'Grinning.' },
      { match: 'media/images/luna-smile.png', tags: ['warm'] },
      { match: 'media/audio/chime.wav', tags: ['chime'] },
      { match: 'media/images/gone.png', tags: ['old'] },
      { match: 'media/video/**', tags: ['clip'] },
    ],
  };

  it('splits exact entries per asset and keeps globs/missing files as rules', () => {
    const model = toEditModel(manifest, assets);
    expect(model.perAsset['media/images/luna-smile.png']).toEqual({ tags: ['smile', 'happy', 'warm'], description: 'Grinning.' });
    expect(model.perAsset['media/images/luna-wave.png']).toEqual({ tags: [], description: '' });
    expect(model.perAsset['media/audio/chime.wav']).toEqual({ tags: ['chime'], description: '' });
    expect(model.rules.map((r) => r.match)).toEqual(['media/images/luna-*.png', 'media/images/gone.png', 'media/video/**']);
    expect(model.vocabulary.portrait).toBe('A picture of Luna');
    expect(model.folderTags).toBe(true);
  });

  it('round-trips to a canonical manifest (rules first, then sorted exact entries, empty ones dropped)', () => {
    const model = toEditModel(manifest, assets);
    const out = fromEditModel(model);
    expect(out.entries).toEqual([
      { match: 'media/images/luna-*.png', tags: ['portrait'] },
      { match: 'media/images/gone.png', tags: ['old'] },
      { match: 'media/video/**', tags: ['clip'] },
      { match: 'media/audio/chime.wav', tags: ['chime'] },
      { match: 'media/images/luna-smile.png', tags: ['smile', 'happy', 'warm'], description: 'Grinning.' },
    ]);
    expect(out.tags).toEqual(manifest.tags);
    expect(out.folderTags).toBeUndefined();
    // idempotent
    expect(fromEditModel(toEditModel(out, assets))).toEqual(out);
  });

  it('handles an absent manifest and folderTags=false', () => {
    const model = toEditModel(undefined, ['a.png']);
    expect(model).toEqual({ perAsset: { 'a.png': { tags: [], description: '' } }, rules: [], vocabulary: {}, folderTags: true });
    const out = fromEditModel({ ...model, folderTags: false });
    expect(out).toEqual({ entries: [], folderTags: false });
  });

  it('reports unused and undocumented tags, honouring folder tags', () => {
    const model = toEditModel(manifest, assets);
    const folder = { 'media/images/luna-smile.png': ['images'], 'media/audio/chime.wav': ['audio'] };
    expect(unusedVocabulary(model, folder)).toEqual(['orphan']);
    expect(undocumentedTags(model, folder)).toEqual(['audio', 'clip', 'happy', 'images', 'old', 'warm']);
    expect(unusedVocabulary({ ...model, folderTags: false }, folder)).toEqual(['orphan']);
    expect(undocumentedTags({ ...model, folderTags: false }, folder)).not.toContain('images');
  });
});

describe('draft reducer', () => {
  type T = { name: string; n: number };
  it('tracks dirty against the saved value and clears on saved/reset', () => {
    let s = initialDraft<T>({ name: 'a', n: 1 });
    expect(s.dirty).toBe(false);
    s = draftReducer(s, { type: 'edit', patch: { name: 'b' } });
    expect(s.dirty).toBe(true);
    s = draftReducer(s, { type: 'edit', patch: { name: 'a' } });
    expect(s.dirty).toBe(false);
    s = draftReducer(s, { type: 'edit', patch: (d) => ({ ...d, n: d.n + 1 }) });
    expect(s.draft).toEqual({ name: 'a', n: 2 });
    expect(s.dirty).toBe(true);
    s = draftReducer(s, { type: 'saved' });
    expect(s.saved).toEqual({ name: 'a', n: 2 });
    expect(s.dirty).toBe(false);
    expect(s.generation).toBe(1);
    s = draftReducer(s, { type: 'edit', patch: { n: 9 } });
    s = draftReducer(s, { type: 'reset', saved: { name: 'z', n: 0 } });
    expect(s).toEqual({ saved: { name: 'z', n: 0 }, draft: { name: 'z', n: 0 }, dirty: false, generation: 2 });
  });

  it('external updates keep local edits on top of the new saved value', () => {
    let s = initialDraft<T>({ name: 'a', n: 1 });
    s = draftReducer(s, { type: 'edit', patch: { name: 'edited' } });
    s = draftReducer(s, { type: 'external', saved: { name: 'a', n: 5 }, keep: (draft, saved) => ({ ...saved, name: draft.name }) });
    expect(s.saved).toEqual({ name: 'a', n: 5 });
    expect(s.draft).toEqual({ name: 'edited', n: 5 });
    expect(s.dirty).toBe(true);
  });

  it('wordCount', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one two\nthree ')).toBe(3);
  });
});
