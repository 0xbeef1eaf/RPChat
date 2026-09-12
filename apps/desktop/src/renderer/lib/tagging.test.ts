import { describe, expect, it } from 'vitest';
import type { EditorAsset, MediaTagSuggestion, ProviderConfig } from '@rp/shared';
import type { MediaEditModel } from './editor';
import { applySuggestions, applyToAsset, initialProviderId, isUntagged, needsRendererFrame, summarise, supportsVision, taggableAssets, visionProviders } from './tagging';

const providers: ProviderConfig[] = [
  { id: 'claude', kind: 'anthropic', label: 'Claude', model: 'claude-sonnet-5' },
  { id: 'ollama-text', kind: 'openai-compatible', label: 'Ollama (text)', model: 'qwen3:8b' },
  { id: 'ollama-vl', kind: 'openai-compatible', label: 'Ollama (vision)', model: 'qwen3-vl:8b', supportsVision: true },
  { id: 'mock', kind: 'mock', label: 'Mock', model: 'mock' },
];

function assetOf(path: string, kind: EditorAsset['kind'] = 'image', mime = 'image/png'): EditorAsset {
  return { path, kind, bytes: 10, mime, tags: [], url: `rp-asset://editor-x/${path}`, folderTags: [], manifestTags: [] };
}

function model(over: Partial<MediaEditModel> = {}): MediaEditModel {
  return { perAsset: {}, rules: [], vocabulary: {}, folderTags: true, ...over };
}

describe('provider choice', () => {
  it('treats Anthropic as vision-capable by default and respects the flag', () => {
    expect(supportsVision({ kind: 'anthropic' })).toBe(true);
    expect(supportsVision({ kind: 'openai-compatible' })).toBe(false);
    expect(supportsVision({ kind: 'openai-compatible', supportsVision: true })).toBe(true);
    expect(supportsVision({ kind: 'anthropic', supportsVision: false })).toBe(false);
    expect(visionProviders(providers).map((p) => p.id)).toEqual(['claude', 'ollama-vl', 'mock']);
  });

  it('prefers the last used provider, then the default, then the first vision one', () => {
    expect(initialProviderId(providers, 'ollama-vl', 'claude')).toBe('ollama-vl');
    expect(initialProviderId(providers, 'ollama-text', 'claude')).toBe('claude');
    expect(initialProviderId(providers, '', 'ollama-text')).toBe('claude');
    expect(initialProviderId([providers[1] as ProviderConfig], '', undefined)).toBe('');
  });
});

describe('needsRendererFrame', () => {
  it('leaves the formats Electron can decode to the main process', () => {
    expect(needsRendererFrame(assetOf('a.png', 'image', 'image/png'))).toBe(false);
    expect(needsRendererFrame(assetOf('a.jpg', 'image', 'image/jpeg'))).toBe(false);
  });

  it('decodes everything nativeImage returns empty for', () => {
    // Verified against Electron: WebP, AVIF, GIF, BMP and SVG all decode to an empty nativeImage.
    for (const mime of ['image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/svg+xml']) {
      expect(needsRendererFrame(assetOf(`a.x`, 'image', mime)), mime).toBe(true);
    }
  });

  it('always grabs a frame for video and never for audio or text', () => {
    expect(needsRendererFrame(assetOf('a.webm', 'video', 'video/webm'))).toBe(true);
    expect(needsRendererFrame(assetOf('a.wav', 'audio', 'audio/wav'))).toBe(false);
    expect(needsRendererFrame(assetOf('a.md', 'text', 'text/markdown'))).toBe(false);
  });
});

describe('scope', () => {
  const assets = [assetOf('a.png'), assetOf('b.png'), assetOf('c.png')];
  const draft = model({ perAsset: { 'a.png': { tags: ['smile'], description: '' }, 'b.png': { tags: [], description: 'A card' }, 'c.png': { tags: [], description: '  ' } } });

  it('counts an asset as untagged only without tags and description', () => {
    expect(isUntagged(assets[0] as EditorAsset, draft)).toBe(false);
    expect(isUntagged(assets[1] as EditorAsset, draft)).toBe(false);
    expect(isUntagged(assets[2] as EditorAsset, draft)).toBe(true);
    expect(isUntagged(assetOf('unknown.png'), draft)).toBe(true);
  });

  it('narrows the visible assets to the requested scope', () => {
    expect(taggableAssets(assets, draft, 'all')).toHaveLength(3);
    expect(taggableAssets(assets, draft, 'untagged').map((a) => a.path)).toEqual(['c.png']);
  });
});

function suggestion(over: Partial<MediaTagSuggestion> = {}): MediaTagSuggestion {
  return { path: 'a.png', tags: ['smile', 'cosy'], newTags: ['cosy'], description: 'Luna smiling.', vocabulary: { cosy: 'Warm and relaxed' }, basis: 'image', ...over };
}

describe('applying suggestions', () => {
  it('merges tags and keeps a written description by default', () => {
    const edit = { tags: ['smile', 'wave'], description: 'Hand-written' };
    expect(applyToAsset(edit, suggestion(), { replaceTags: false, overwriteDescriptions: false })).toEqual({ tags: ['smile', 'wave', 'cosy'], description: 'Hand-written' });
  });

  it('replaces tags and overwrites descriptions when asked', () => {
    const edit = { tags: ['smile', 'wave'], description: 'Hand-written' };
    expect(applyToAsset(edit, suggestion(), { replaceTags: true, overwriteDescriptions: true })).toEqual({ tags: ['smile', 'cosy'], description: 'Luna smiling.' });
  });

  it('fills an empty description and creates the asset entry', () => {
    expect(applyToAsset(undefined, suggestion(), { replaceTags: false, overwriteDescriptions: false })).toEqual({ tags: ['smile', 'cosy'], description: 'Luna smiling.' });
  });

  it('adds invented tags to the vocabulary without touching meanings the author wrote', () => {
    const draft = model({ vocabulary: { smile: 'Luna smiling', cosy: '' } });
    const next = applySuggestions(draft, [suggestion(), suggestion({ path: 'b.png', tags: ['night'], newTags: ['night'], vocabulary: {} })], {
      replaceTags: false,
      overwriteDescriptions: false,
      addToVocabulary: true,
    });
    expect(next.vocabulary).toEqual({ smile: 'Luna smiling', cosy: 'Warm and relaxed', night: '' });
    expect(next.perAsset['a.png']).toEqual({ tags: ['smile', 'cosy'], description: 'Luna smiling.' });
    expect(next.perAsset['b.png']).toEqual({ tags: ['night'], description: 'Luna smiling.' });
  });

  it('keeps the vocabulary untouched when the option is off, and skips failed or empty suggestions', () => {
    const draft = model({ perAsset: { 'a.png': { tags: ['old'], description: '' } } });
    const next = applySuggestions(
      draft,
      [suggestion({ path: 'a.png', error: 'connection refused', tags: [], newTags: [], description: '' }), suggestion({ path: 'b.png', tags: [], newTags: [], description: '', vocabulary: {} })],
      { replaceTags: false, overwriteDescriptions: false, addToVocabulary: false },
    );
    expect(next).toEqual(draft);
  });
});

describe('summarise', () => {
  it('counts tagged, empty and failed suggestions', () => {
    const list = [suggestion(), suggestion({ path: 'b.png', tags: [], newTags: [], description: '' }), suggestion({ path: 'c.png', error: 'boom' })];
    expect(summarise(list)).toBe('1 tagged, 1 with nothing to say, 1 failed');
    expect(summarise([suggestion()])).toBe('1 tagged');
  });
});
