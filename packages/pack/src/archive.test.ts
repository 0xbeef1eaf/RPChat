import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import { extractPack, packDirectory, readManifestFromArchive } from './index.js';
import { LUNA_DIR, MINIMAL_DIR, listFiles, makeTempDir, minimalPackFiles, writeTree } from './test/helpers.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => fs.rm(t, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const t = await makeTempDir();
  temps.push(t);
  return t;
}

async function expectRpError(p: Promise<unknown>, code: string, messagePattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RpError);
  expect((caught as RpError).code).toBe(code);
  if (messagePattern) expect((caught as RpError).message).toMatch(messagePattern);
}

describe('packDirectory → extractPack', () => {
  it('round-trips the luna pack byte-for-byte', async () => {
    const tmp = await temp();
    const archive = path.join(tmp, 'out', 'luna.rppack');
    await packDirectory(LUNA_DIR, archive);

    const dest = path.join(tmp, 'extracted');
    const pack = await extractPack(archive, dest);
    expect(pack.root).toBe(dest);
    expect(pack.manifest.id).toBe('com.example.luna');
    expect(pack.characters[0]!.behaviourSources.onTimer).toBeDefined();

    const originalFiles = await listFiles(LUNA_DIR);
    const extractedFiles = await listFiles(dest);
    expect(extractedFiles).toEqual(originalFiles);
    expect(originalFiles).toContain('media/audio/chime.wav');
    for (const rel of originalFiles) {
      const a = await fs.readFile(path.join(LUNA_DIR, rel));
      const b = await fs.readFile(path.join(dest, rel));
      expect(b.equals(a), rel).toBe(true);
    }
  });

  it('is deterministic and skips dotfiles, node_modules and the destination file', async () => {
    const src = await temp();
    await writeTree(src, {
      ...minimalPackFiles(),
      '.hidden': 'x',
      '.git/config': 'x',
      'node_modules/pkg/index.js': 'x',
      'media/images/a.png': 'png',
    });
    const first = path.join(src, 'first.rppack');
    await packDirectory(src, first);
    const second = path.join(src, 'second.rppack');
    await packDirectory(src, second);

    const dest = path.join(await temp(), 'out');
    await extractPack(second, dest);
    const files = await listFiles(dest, { includeDotfiles: true });
    expect(files).toEqual(['characters/a/character.json', 'characters/a/persona.md', 'first.rppack', 'media/images/a.png', 'pack.json']);
  });

  it('refuses to pack an invalid directory', async () => {
    const src = await temp();
    await writeTree(src, { 'pack.json': '{}' });
    await expectRpError(packDirectory(src, path.join(src, 'x.rppack')), 'PACK_INVALID');
    await expect(fs.stat(path.join(src, 'x.rppack'))).rejects.toThrow();
  });

  it('readManifestFromArchive peeks without extracting', async () => {
    const tmp = await temp();
    const archive = path.join(tmp, 'minimal.rppack');
    await packDirectory(MINIMAL_DIR, archive);
    const manifest = await readManifestFromArchive(archive);
    expect(manifest).toMatchObject({ id: 'com.example.minimal', version: '0.1.0' });
    expect(await fs.readdir(tmp)).toEqual(['minimal.rppack']);
  });
});

describe('extractPack safety', () => {
  async function handBuiltZip(entries: Record<string, string>): Promise<string> {
    const tmp = await temp();
    const file = path.join(tmp, 'evil.rppack');
    const zippable: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) zippable[name] = strToU8(content);
    await fs.writeFile(file, zipSync(zippable));
    return file;
  }

  const validEntries = minimalPackFiles();

  it('rejects an archive with a ../evil.txt entry before writing anything', async () => {
    const file = await handBuiltZip({ ...validEntries, '../evil.txt': 'pwned' });
    const dest = path.join(path.dirname(file), 'dest');
    await expectRpError(extractPack(file, dest), 'PACK_INVALID', /unsafe entry paths.*\.\.\/evil\.txt/);
    await expect(fs.stat(path.join(path.dirname(file), 'evil.txt'))).rejects.toThrow();
    await expect(fs.stat(dest)).rejects.toThrow();
    await expectRpError(readManifestFromArchive(file), 'PACK_INVALID');
  });

  it('rejects absolute, backslash-traversal, nested traversal and drive-letter entries', async () => {
    for (const bad of ['/etc/evil.txt', '..\\evil.txt', 'characters/../../evil.txt', 'C:\\evil.txt', 'a\0b']) {
      const file = await handBuiltZip({ ...validEntries, [bad]: 'pwned' });
      await expectRpError(extractPack(file, path.join(path.dirname(file), 'dest')), 'PACK_INVALID', /unsafe entry paths/);
    }
  });

  it('rejects an archive without pack.json at the root', async () => {
    const file = await handBuiltZip({ 'README.md': 'nothing here' });
    await expectRpError(extractPack(file, path.join(path.dirname(file), 'dest')), 'PACK_INVALID', /pack\.json/);
    await expectRpError(readManifestFromArchive(file), 'PACK_INVALID', /pack\.json/);
  });

  it('accepts an archive wrapped in a single top-level folder and ignores siblings', async () => {
    const wrapped: Record<string, string> = { '__MACOSX/._pack.json': 'junk' };
    for (const [k, v] of Object.entries(validEntries)) wrapped[`my-pack/${k}`] = v;
    const file = await handBuiltZip(wrapped);
    const dest = path.join(path.dirname(file), 'dest');
    const pack = await extractPack(file, dest);
    expect(pack.manifest.id).toBe('com.test.tmp');
    expect(await listFiles(dest, { includeDotfiles: true })).toEqual([
      'characters/a/character.json',
      'characters/a/persona.md',
      'pack.json',
    ]);
    expect((await readManifestFromArchive(file)).id).toBe('com.test.tmp');
  });

  it('rejects an archive whose manifest is invalid after extraction', async () => {
    const file = await handBuiltZip({ 'pack.json': JSON.stringify({ formatVersion: 1, id: 'nope' }) });
    await expectRpError(extractPack(file, path.join(path.dirname(file), 'dest')), 'PACK_INVALID');
    await expectRpError(readManifestFromArchive(file), 'PACK_INVALID');
  });

  it('refuses to write through a symlinked directory inside the destination', async () => {
    const file = await handBuiltZip({ ...validEntries, 'media/leak.txt': 'pwned' });
    const base = path.dirname(file);
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    const dest = path.join(base, 'dest');
    await fs.mkdir(dest);
    await fs.symlink(outside, path.join(dest, 'media'));
    await expectRpError(extractPack(file, dest), 'PATH_ESCAPE');
    await expect(fs.stat(path.join(outside, 'leak.txt'))).rejects.toThrow();
  });
});
