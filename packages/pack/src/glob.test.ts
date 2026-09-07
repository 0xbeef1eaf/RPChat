import { describe, expect, it } from 'vitest';
import { globToRegExp, isGlob, matchesGlob } from './index.js';

describe('matchesGlob', () => {
  it('treats a bare path as itself or a directory prefix', () => {
    expect(matchesGlob('media/images', 'media/images/a.png')).toBe(true);
    expect(matchesGlob('media/images', 'media/images/deep/a.png')).toBe(true);
    expect(matchesGlob('media/images/a.png', 'media/images/a.png')).toBe(true);
    expect(matchesGlob('media/images', 'media/imagesx/a.png')).toBe(false);
    expect(matchesGlob('media/images', 'media/a.png')).toBe(false);
    expect(matchesGlob('media/images/', 'media/images/a.png')).toBe(true);
    expect(matchesGlob('.\\media\\images', 'media/images/a.png')).toBe(true);
  });

  it('matches * within a single segment', () => {
    expect(matchesGlob('media/images/luna-*.png', 'media/images/luna-smile.png')).toBe(true);
    expect(matchesGlob('media/images/luna-*.png', 'media/images/luna-.png')).toBe(true);
    expect(matchesGlob('media/images/luna-*.png', 'media/images/luna-x/y.png')).toBe(false);
    expect(matchesGlob('media/*/a.png', 'media/images/a.png')).toBe(true);
    expect(matchesGlob('media/*/a.png', 'media/a.png')).toBe(false);
    expect(matchesGlob('*.png', 'a.png')).toBe(true);
    expect(matchesGlob('*.png', 'media/a.png')).toBe(false);
  });

  it('matches ? as exactly one non-slash character', () => {
    expect(matchesGlob('media/a?.png', 'media/a1.png')).toBe(true);
    expect(matchesGlob('media/a?.png', 'media/a.png')).toBe(false);
    expect(matchesGlob('media/a?.png', 'media/a/.png')).toBe(false);
  });

  it('matches ** across segments', () => {
    expect(matchesGlob('media/**', 'media/a.png')).toBe(true);
    expect(matchesGlob('media/**', 'media/x/y/z.png')).toBe(true);
    expect(matchesGlob('media/**', 'other/a.png')).toBe(false);
    expect(matchesGlob('**/chime.wav', 'chime.wav')).toBe(true);
    expect(matchesGlob('**/chime.wav', 'media/audio/chime.wav')).toBe(true);
    expect(matchesGlob('**/chime.wav', 'media/audio/chime.wav.bak')).toBe(false);
    expect(matchesGlob('media/**/*.png', 'media/a.png')).toBe(true);
    expect(matchesGlob('media/**/*.png', 'media/x/y/a.png')).toBe(true);
    expect(matchesGlob('media/**/*.png', 'media/x/y/a.jpg')).toBe(false);
    expect(matchesGlob('**', 'anything/at/all')).toBe(true);
  });

  it('escapes regex metacharacters and refuses unsafe patterns/paths', () => {
    expect(matchesGlob('media/a.png', 'media/aXpng')).toBe(false);
    expect(matchesGlob('media/(a)+[b].png', 'media/(a)+[b].png')).toBe(true);
    expect(matchesGlob('../**', '../x')).toBe(false);
    expect(matchesGlob('/etc/**', '/etc/passwd')).toBe(false);
    expect(matchesGlob('media/**', '../media/x')).toBe(false);
    expect(globToRegExp('..').test('')).toBe(false);
  });

  it('isGlob detects metacharacters', () => {
    expect(isGlob('media/images')).toBe(false);
    expect(isGlob('media/*.png')).toBe(true);
    expect(isGlob('a?b')).toBe(true);
  });
});
