import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { mediaManifestSchema, normalizeTag, normalizeTags, validateMediaManifest } from './index.js';
import { LUNA_DIR } from './test/helpers.js';

describe('mediaManifestSchema', () => {
  it('accepts the luna media.json', async () => {
    const json = JSON.parse(await fs.readFile(path.join(LUNA_DIR, 'media.json'), 'utf8'));
    const manifest = validateMediaManifest(json);
    expect(manifest.entries.length).toBeGreaterThan(3);
    expect(manifest.tags?.portrait).toBe('A picture of Luna herself');
  });

  it('normalises tags: trim, lower-case, dedupe, sort', () => {
    const m = validateMediaManifest({ entries: [{ match: 'media', tags: [' Happy ', 'happy', 'B-2', 'a_1'] }] });
    expect(m.entries[0]!.tags).toEqual(['a_1', 'b-2', 'happy']);
    expect(normalizeTag('  Hi-There ')).toBe('hi-there');
    expect(normalizeTag('-bad')).toBeUndefined();
    expect(normalizeTag('a'.repeat(33))).toBeUndefined();
    expect(normalizeTags(['Z', 'a', 'a', 'bad tag', ''])).toEqual(['a', 'z']);
  });

  it('rejects invalid tags, too many tags and long descriptions', () => {
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: ['has space'] }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: ['-lead'] }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: ['a'.repeat(33)] }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: [''] }] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: many }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', tags: many.slice(0, 20) }] }).success).toBe(true);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', description: 'd'.repeat(201) }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: 'x', description: 'd'.repeat(200) }] }).success).toBe(true);
  });

  it('rejects unsafe match patterns and requires entries', () => {
    expect(mediaManifestSchema.safeParse({ entries: [{ match: '../**' }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: '/abs/*' }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [{ match: '' }] }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({}).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [] }).success).toBe(true);
  });

  it('normalises vocabulary keys and rejects invalid ones', () => {
    const m = validateMediaManifest({ entries: [], tags: { ' Happy ': 'cheerful' } });
    expect(m.tags).toEqual({ happy: 'cheerful' });
    expect(mediaManifestSchema.safeParse({ entries: [], tags: { 'bad tag': 'x' } }).success).toBe(false);
    expect(mediaManifestSchema.safeParse({ entries: [], tags: { ok: 'd'.repeat(201) } }).success).toBe(false);
  });

  it('throws RpError(PACK_INVALID) with issues', () => {
    try {
      validateMediaManifest({ entries: [{ match: 'x', tags: ['BAD!'] }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RpError);
      expect((err as RpError).code).toBe('PACK_INVALID');
      expect((err as RpError).message).toContain('media.json');
      expect((err as RpError).details).toMatchObject({ issues: [{ path: 'entries.0.tags.0' }] });
    }
  });
});
