#!/usr/bin/env node
/**
 * Copies the built browser extension (apps/browser-extension/dist, produced by
 * `pnpm --filter @rp/browser-extension build`) to resources/extension/, where the app serves it
 * as a CRX and points "Load unpacked" at it, and electron-builder ships it as an extra resource.
 * Builds the extension first when its dist/ is missing; skips with a notice when the package is
 * not in the checkout (exit 1 only with RP_REQUIRE_NATIVE=1, like build-native.mjs).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const extensionDir = resolve(appDir, '../browser-extension');
const dist = join(extensionDir, 'dist');
const target = join(appDir, 'resources', 'extension');
const required = process.env.RP_REQUIRE_NATIVE === '1';

if (!existsSync(join(extensionDir, 'package.json'))) {
  console.log(`[build-extension] skipping: ${extensionDir} not found`);
  process.exit(required ? 1 : 0);
}
if (!existsSync(join(dist, 'manifest.json'))) {
  console.log('[build-extension] dist missing, building @rp/browser-extension');
  execFileSync('node', [join(extensionDir, 'scripts', 'build.mjs')], { stdio: 'inherit' });
}
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(dist, target, { recursive: true });
const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
console.log(`[build-extension] copied ${manifest.name} ${manifest.version} to ${target}`);
