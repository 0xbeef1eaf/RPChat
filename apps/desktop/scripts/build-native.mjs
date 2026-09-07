#!/usr/bin/env node
/**
 * Builds the wlr-layer-shell overlay helper (native/overlay-wlr) and copies it to
 * resources/bin/rp-overlay-wlr so electron-builder ships it as an extra resource.
 * Skips with a notice when the toolchain or the GTK/WebKit libraries are missing
 * (exit 1 only with RP_REQUIRE_NATIVE=1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const manifest = resolve(appDir, '../../native/overlay-wlr/Cargo.toml');
const target = resolve(appDir, 'resources/bin/rp-overlay-wlr');
const require = process.env.RP_REQUIRE_NATIVE === '1';

function skip(reason) {
  console.log(`[build-native] skipping rp-overlay-wlr: ${reason}`);
  process.exit(require ? 1 : 0);
}

function has(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

if (process.platform !== 'linux') skip(`only built on Linux (this is ${process.platform})`);
if (!existsSync(manifest)) skip(`${manifest} not found`);
if (!has('cargo', ['--version'])) skip('cargo is not on PATH (install Rust to build the layer-shell helper)');
if (!has('pkg-config', ['--exists', 'gtk+-3.0', 'gtk-layer-shell-0', 'webkit2gtk-4.1'])) {
  skip('gtk+-3.0 / gtk-layer-shell-0 / webkit2gtk-4.1 development libraries not found (pkg-config)');
}

console.log('[build-native] cargo build --release (native/overlay-wlr)');
try {
  execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit' });
} catch (err) {
  console.error(`[build-native] cargo build failed: ${err.message}`);
  process.exit(1);
}
const built = resolve(dirname(manifest), 'target/release/rp-overlay-wlr');
if (!existsSync(built)) {
  console.error(`[build-native] expected binary at ${built}`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(built, target);
chmodSync(target, 0o755);
console.log(`[build-native] copied to ${target}`);
