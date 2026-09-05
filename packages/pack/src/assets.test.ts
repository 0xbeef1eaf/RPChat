import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetKindFor, extensionOf, indexAssets, mimeFor } from './index.js';
import { LUNA_DIR, MINIMAL_DIR, makeTempDir, minimalPackFiles, writeTree } from './test/helpers.js';

describe('assetKindFor / mimeFor', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(assetKindFor('a/b.PNG')).toBe('image');
    expect(assetKindFor('x.svg')).toBe('image');
    expect(assetKindFor('clip.MKV')).toBe('video');
    expect(assetKindFor('audio/chime.wav')).toBe('audio');
    expect(assetKindFor('notes.md')).toBe('text');
    expect(assetKindFor('data.json')).toBe('text');
    expect(assetKindFor('model.bin')).toBe('other');
    expect(assetKindFor('README')).toBe('other');
    expect(assetKindFor('.hidden')).toBe('other');
    expect(assetKindFor('dir.png/file')).toBe('other');
  });

  it('provides mime types for every known extension', () => {
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.mp4')).toBe('video/mp4');
    expect(mimeFor('a.wav')).toBe('audio/wav');
    expect(mimeFor('a.mp3')).toBe('audio/mpeg');
    expect(mimeFor('a.md')).toBe('text/markdown');
    expect(mimeFor('a.json')).toBe('application/json');
    expect(mimeFor('a.xyz')).toBe('application/octet-stream');
    expect(extensionOf('a\\b.Jpeg')).toBe('jpeg');
  });
});

describe('indexAssets', () => {
  it('indexes the luna pack media plus the avatar', async () => {
    const assets = await indexAssets(LUNA_DIR);
    const paths = assets.map((a) => a.path);
    expect(paths).toEqual([
      'characters/luna/avatar.png',
      'media/audio/chime.wav',
      'media/images/luna-smile.png',
      'media/images/luna-wave.png',
    ]);
    for (const a of assets) expect(a.bytes).toBeGreaterThan(0);
    expect(assets.find((a) => a.path === 'media/audio/chime.wav')).toMatchObject({ kind: 'audio', mime: 'audio/wav' });
    expect(assets.find((a) => a.path === 'characters/luna/avatar.png')).toMatchObject({ kind: 'image', mime: 'image/png' });
  });

  it('returns an empty index when there is no media directory and no avatar', async () => {
    expect(await indexAssets(MINIMAL_DIR)).toEqual([]);
  });

  describe('with a temp pack', () => {
    let tmp: string;
    beforeAll(async () => {
      tmp = await makeTempDir();
      await writeTree(tmp, {
        ...minimalPackFiles(),
        'assets/a.png': 'x',
        'assets/deep/er/clip.webm': 'xx',
        'assets/notes.txt': 'xxx',
        'assets/.DS_Store': 'junk',
        'assets/node_modules/pkg/index.js': 'junk',
        'assets/blob.bin': 'bbbb',
      });
      await writeTree(path.join(tmp, '..', path.basename(tmp) + '-outside'), { 'leak.png': 'leak' });
      await fs.symlink(path.join(tmp, '..', path.basename(tmp) + '-outside', 'leak.png'), path.join(tmp, 'assets', 'leak.png'));
    });
    afterAll(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(path.join(tmp, '..', path.basename(tmp) + '-outside'), { recursive: true, force: true });
    });

    it('honours a custom mediaRoot, recurses, and skips dotfiles/node_modules/symlinks', async () => {
      const assets = await indexAssets(tmp, 'assets');
      expect(assets).toEqual([
        { path: 'assets/a.png', kind: 'image', bytes: 1, mime: 'image/png' },
        { path: 'assets/blob.bin', kind: 'other', bytes: 4, mime: 'application/octet-stream' },
        { path: 'assets/deep/er/clip.webm', kind: 'video', bytes: 2, mime: 'video/webm' },
        { path: 'assets/notes.txt', kind: 'text', bytes: 3, mime: 'text/plain' },
      ]);
    });

    it('rejects an escaping mediaRoot', async () => {
      await expect(indexAssets(tmp, '../x')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    });
  });
});
