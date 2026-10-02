import { describe, expect, it } from 'vitest';
import { formatMediaMeta } from './media-meta';

describe('formatMediaMeta', () => {
  it('shows whichever parts the file carries', () => {
    expect(formatMediaMeta({ width: 1920, height: 1080 })).toBe('1920 × 1080');
    expect(formatMediaMeta({ durationMs: 185_000 })).toBe('3 min 5 s');
    expect(formatMediaMeta({ width: 640, height: 480, durationMs: 12_000 })).toBe('640 × 480 · 12.0 s');
    expect(formatMediaMeta({ durationMs: 600 })).toBe('600 ms');
  });
  it('says nothing when there is nothing to say', () => {
    expect(formatMediaMeta(undefined)).toBe('');
    expect(formatMediaMeta({})).toBe('');
    expect(formatMediaMeta({ width: 0, height: 0 })).toBe('');
    expect(formatMediaMeta({ durationMs: Number.POSITIVE_INFINITY })).toBe('');
  });
});
