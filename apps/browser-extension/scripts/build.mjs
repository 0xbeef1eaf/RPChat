#!/usr/bin/env node
/**
 * Bundles the extension into dist/: background.js (service worker), popup.js, newtab.js and
 * blocked.js, plus the static manifest, managed-storage schema and the three pages. The desktop build copies dist/ to
 * apps/desktop/resources/extension/ (scripts/build-extension.mjs).
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
await build({
  entryPoints: [join(root, 'src/background.ts'), join(root, 'src/popup.ts'), join(root, 'src/newtab.ts'), join(root, 'src/blocked.ts')],
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  define: { __EXTENSION_VERSION__: JSON.stringify(manifest.version) },
});
for (const file of ['manifest.json', 'schema.json']) copyFileSync(join(root, file), join(dist, file));
for (const page of ['popup.html', 'newtab.html', 'blocked.html']) copyFileSync(join(root, `src/${page}`), join(dist, page));
console.log(`[browser-extension] built ${manifest.name} ${manifest.version} → ${dist}`);
