import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { isSafeRelativePath, joinRelative, normalizeRelativePath, resolveAssetPath } from './index.js';
import { makeTempDir, writeTree } from './test/helpers.js';

function expectEscape(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RpError);
  expect((caught as RpError).code).toBe('PATH_ESCAPE');
}

describe('normalizeRelativePath', () => {
  it('normalises safe paths to forward-slash form', () => {
    expect(normalizeRelativePath('media/images/a.png')).toEqual({ ok: true, path: 'media/images/a.png' });
    expect(normalizeRelativePath('./media//images/./a.png')).toEqual({ ok: true, path: 'media/images/a.png' });
    expect(normalizeRelativePath('media\\images\\a.png')).toEqual({ ok: true, path: 'media/images/a.png' });
    expect(normalizeRelativePath('media/')).toEqual({ ok: true, path: 'media' });
  });

  it('rejects traversal, absolute and degenerate paths', () => {
    for (const bad of ['', '.', './', '..', '../x', 'a/../b', 'a/..', '/etc/passwd', 'C:\\x', 'c:/x', '\\\\srv\\x', 'a\\..\\b', 'a\0b']) {
      expect(normalizeRelativePath(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(isSafeRelativePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('joinRelative never collapses segments', () => {
    expect(joinRelative('characters/luna', 'scripts/x.ts')).toBe('characters/luna/scripts/x.ts');
    expectEscape(() => joinRelative('characters/luna', '../x.ts'));
    expectEscape(() => joinRelative('../luna', 'x.ts'));
  });
});

describe('resolveAssetPath', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    tmp = await makeTempDir();
    root = path.join(tmp, 'root');
    outside = path.join(tmp, 'outside');
    await writeTree(root, { 'media/images/a.png': 'png', 'pack.json': '{}' });
    await writeTree(outside, { 'secret.txt': 'secret' });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'media', 'link.txt'));
    await fs.symlink(outside, path.join(root, 'media', 'linkdir'));
    await fs.symlink(path.join(root, 'media', 'images'), path.join(root, 'media', 'inside-link'));
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resolves safe paths to absolute paths under root', () => {
    expect(resolveAssetPath(root, 'media/images/a.png')).toBe(path.join(root, 'media', 'images', 'a.png'));
    expect(resolveAssetPath(root, 'media\\images\\a.png')).toBe(path.join(root, 'media', 'images', 'a.png'));
    // non-existent files are fine as long as they would live under root
    expect(resolveAssetPath(root, 'media/new/file.png')).toBe(path.join(root, 'media', 'new', 'file.png'));
    // a symlink that stays inside root is allowed
    expect(resolveAssetPath(root, 'media/inside-link/a.png')).toBe(path.join(root, 'media', 'inside-link', 'a.png'));
  });

  it('rejects ../x', () => expectEscape(() => resolveAssetPath(root, '../x')));
  it('rejects /etc/passwd', () => expectEscape(() => resolveAssetPath(root, '/etc/passwd')));
  it('rejects media\\..\\x', () => expectEscape(() => resolveAssetPath(root, 'media\\..\\x')));
  it('rejects media/../../x', () => expectEscape(() => resolveAssetPath(root, 'media/../../x')));
  it('rejects drive-letter paths', () => expectEscape(() => resolveAssetPath(root, 'C:\\Windows\\x')));
  it('rejects empty paths', () => expectEscape(() => resolveAssetPath(root, '')));

  it('rejects a symlinked file pointing outside root', () => {
    expectEscape(() => resolveAssetPath(root, 'media/link.txt'));
  });

  it('rejects files below a symlinked directory pointing outside root', () => {
    expectEscape(() => resolveAssetPath(root, 'media/linkdir/secret.txt'));
    // even when the target file does not exist, the escaping ancestor is caught
    expectEscape(() => resolveAssetPath(root, 'media/linkdir/nope/missing.txt'));
  });

  it('works when the root itself is reached through a symlink', async () => {
    const alias = path.join(tmp, 'alias');
    await fs.symlink(root, alias);
    expect(resolveAssetPath(alias, 'media/images/a.png')).toBe(path.join(alias, 'media', 'images', 'a.png'));
    expectEscape(() => resolveAssetPath(alias, 'media/link.txt'));
  });
});
