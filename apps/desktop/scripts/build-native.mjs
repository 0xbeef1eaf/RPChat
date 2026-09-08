#!/usr/bin/env node
/**
 * Builds the native Linux pieces and copies them where electron-builder picks them up:
 *  - native/overlay-wlr → resources/bin/rp-overlay-wlr (wlr-layer-shell overlay helper; needs
 *    the GTK/WebKit development libraries),
 *  - native/rp-coded   → resources/bin/rp-coded (input lock / injection daemon; no system
 *    libraries) plus native/rp-coded/dist/* and install.sh → resources/system/.
 * Each part skips with a notice when its toolchain is missing (exit 1 only with
 * RP_REQUIRE_NATIVE=1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const nativeDir = resolve(appDir, '../../native');
const require = process.env.RP_REQUIRE_NATIVE === '1';
let failed = false;

function skip(what, reason) {
  console.log(`[build-native] skipping ${what}: ${reason}`);
  if (require) failed = true;
}

function has(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function cargoBuild(name, manifest, target) {
  console.log(`[build-native] cargo build --release (${name})`);
  try {
    execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit' });
  } catch (err) {
    console.error(`[build-native] cargo build failed for ${name}: ${err.message}`);
    process.exit(1);
  }
  const built = resolve(dirname(manifest), `target/release/${name}`);
  if (!existsSync(built)) {
    console.error(`[build-native] expected binary at ${built}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(built, target);
  chmodSync(target, 0o755);
  console.log(`[build-native] copied to ${target}`);
}

function buildOverlayHelper() {
  const manifest = resolve(nativeDir, 'overlay-wlr/Cargo.toml');
  if (!existsSync(manifest)) return skip('rp-overlay-wlr', `${manifest} not found`);
  if (!has('pkg-config', ['--exists', 'gtk+-3.0', 'gtk-layer-shell-0', 'webkit2gtk-4.1'])) {
    return skip('rp-overlay-wlr', 'gtk+-3.0 / gtk-layer-shell-0 / webkit2gtk-4.1 development libraries not found (pkg-config)');
  }
  cargoBuild('rp-overlay-wlr', manifest, resolve(appDir, 'resources/bin/rp-overlay-wlr'));
}

function buildDaemon() {
  const daemonDir = resolve(nativeDir, 'rp-coded');
  const manifest = resolve(daemonDir, 'Cargo.toml');
  if (!existsSync(manifest)) return skip('rp-coded', `${manifest} not found`);
  cargoBuild('rp-coded', manifest, resolve(appDir, 'resources/bin/rp-coded'));

  // Installer and its support files, shipped flat under resources/system/.
  const systemDir = resolve(appDir, 'resources/system');
  mkdirSync(systemDir, { recursive: true });
  const distDir = resolve(daemonDir, 'dist');
  const files = readdirSync(distDir).map((f) => join(distDir, f));
  files.push(resolve(daemonDir, 'install.sh'), resolve(daemonDir, 'README.md'));
  for (const src of files) {
    const dst = join(systemDir, src.split('/').pop());
    copyFileSync(src, dst);
    if (dst.endsWith('.sh')) chmodSync(dst, 0o755);
  }
  console.log(`[build-native] copied ${files.length} installer file(s) to ${systemDir}`);
}

if (process.platform !== 'linux') {
  skip('rp-overlay-wlr and rp-coded', `only built on Linux (this is ${process.platform})`);
} else if (!has('cargo', ['--version'])) {
  skip('rp-overlay-wlr and rp-coded', 'cargo is not on PATH (install Rust to build the native helpers)');
} else {
  buildOverlayHelper();
  buildDaemon();
}
process.exit(failed ? 1 : 0);
