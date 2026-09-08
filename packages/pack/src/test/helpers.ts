import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples/packs/', import.meta.url));
export const LUNA_DIR = path.join(EXAMPLES_DIR, 'luna');
export const MINIMAL_DIR = path.join(EXAMPLES_DIR, 'minimal');
export const MAKIMA_DIR = path.join(EXAMPLES_DIR, 'makima');

export async function makeTempDir(prefix = 'rp-pack-'): Promise<string> {
  // realpath so macOS /var → /private/var does not confuse path comparisons in tests
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

export function minimalPackFiles(): Record<string, string> {
  return {
    'pack.json': JSON.stringify({
      formatVersion: 1,
      id: 'com.test.tmp',
      name: 'Tmp',
      version: '1.0.0',
      characters: ['characters/a'],
    }),
    'characters/a/character.json': JSON.stringify({ id: 'a', name: 'A', persona: 'persona.md' }),
    'characters/a/persona.md': 'You are A.',
  };
}

/** Sorted list of regular files below `root` (forward slashes); `node_modules` always skipped. */
export async function listFiles(
  root: string,
  opts: { includeDotfiles?: boolean } = {},
  dir = root,
  out: string[] = [],
): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!opts.includeDotfiles && entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, opts, abs, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out.sort();
}
