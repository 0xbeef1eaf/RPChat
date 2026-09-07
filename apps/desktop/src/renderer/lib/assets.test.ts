import { describe, expect, it } from 'vitest';
import { describeAssetCounts } from './assets';

describe('describeAssetCounts', () => {
  it('orders by kind, pluralises and skips zero counts', () => {
    expect(describeAssetCounts({ audio: 1, image: 3, text: 0, video: 1 })).toBe('3 images · 1 video · 1 audio');
    expect(describeAssetCounts({ image: 1, other: 2, fonts: 1 })).toBe('1 image · 2 other files · 1 fonts');
    expect(describeAssetCounts({})).toBe('');
    expect(describeAssetCounts(undefined)).toBe('');
  });
});
