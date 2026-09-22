#!/usr/bin/env node
/**
 * Builds the native Linux pieces and copies them where electron-builder picks them up:
 *  - native/overlay-wlr → resources/bin/rp-overlay-wlr (wlr-layer-shell overlay helper; needs
 *    the GTK/WebKit development libraries),
 *  - native/rpchatd   → resources/bin/rpchatd (input lock / injection daemon; no system
 *    libraries) plus native/rpchatd/dist/* and install.sh → resources/system/.
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

/**
 * Note what `RP_REQUIRE_NATIVE=1` means before adding a part here: the release workflow sets it, so
 * a skip that is merely a notice on a developer's machine **fails the release build**. Anything
 * added below therefore needs its toolchain in *both* ci.yml and release.yml, not just the one that
 * runs on pull requests.
 */
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
  const daemonDir = resolve(nativeDir, 'rpchatd');
  const manifest = resolve(daemonDir, 'Cargo.toml');
  if (!existsSync(manifest)) return skip('rpchatd', `${manifest} not found`);
  cargoBuild('rpchatd', manifest, resolve(appDir, 'resources/bin/rpchatd'));

  // Installer and its support files, shipped flat under resources/system/.
  const systemDir = resolve(appDir, 'resources/system');
  mkdirSync(systemDir, { recursive: true });
  const distDir = resolve(daemonDir, 'dist');
  const files = readdirSync(distDir).map((f) => join(distDir, f));
  files.push(resolve(daemonDir, 'install.sh'), resolve(daemonDir, 'README.md'));
  // install.sh installs one icon per hicolor size directory, so ship every size it looks for; the
  // names it expects are rpchat.png (512) and rpchat-<size>.png.
  const icon = resolve(appDir, 'build/icon.png');
  if (existsSync(icon)) copyFileSync(icon, join(systemDir, 'rpchat.png'));
  for (const size of [128, 64, 48, 32]) {
    const sized = resolve(appDir, `build/icon-${size}.png`);
    if (existsSync(sized)) copyFileSync(sized, join(systemDir, `rpchat-${size}.png`));
  }
  for (const src of files) {
    const dst = join(systemDir, src.split('/').pop());
    copyFileSync(src, dst);
    if (dst.endsWith('.sh')) chmodSync(dst, 0o755);
  }
  console.log(`[build-native] copied ${files.length} installer file(s) to ${systemDir}`);
}

/**
 * Qwen3-TTS, the second voice engine. Upstream publishes no releases or tags — only source — so
 * there is nothing to download at runtime and the binary is built here and shipped in
 * resources/bin, where `findQwenTts` already looks. It is ~1.3 MB, so it costs the installer
 * almost nothing whether or not the user ever turns the engine on.
 *
 * Pinned to a commit rather than a branch: the flag names in `qwen-engine.ts` are this build's,
 * and a silent upstream rename would surface as a non-zero exit when a character tries to speak.
 */
const QWEN_REPO = 'https://github.com/gabriele-mastrapasqua/qwen3-tts.git';
const QWEN_COMMIT = 'e56ec7e6eabbed608b13bfbd3fba431708b2077f';

function buildQwenTts() {
  const buildDir = resolve(nativeDir, 'qwen3-tts');
  if (!has('git', ['--version'])) return skip('qwen_tts', 'git is not on PATH');
  if (!has('make', ['--version'])) return skip('qwen_tts', 'make is not on PATH');
  if (!has('cc', ['--version'])) return skip('qwen_tts', 'no C compiler on PATH');
  // The upstream Makefile's Linux branch links OpenBLAS unconditionally, so without it the build
  // gets all the way to the final link and fails there. Checked up front so the reason is legible.
  if (!has('pkg-config', ['--exists', 'openblas'])) return skip('qwen_tts', 'openblas development files not found (pkg-config)');

  try {
    if (!existsSync(join(buildDir, 'Makefile'))) {
      console.log(`[build-native] cloning qwen3-tts at ${QWEN_COMMIT}`);
      mkdirSync(buildDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: buildDir, stdio: 'inherit' });
      execFileSync('git', ['remote', 'add', 'origin', QWEN_REPO], { cwd: buildDir, stdio: 'inherit' });
      execFileSync('git', ['fetch', '-q', '--depth', '1', 'origin', QWEN_COMMIT], { cwd: buildDir, stdio: 'inherit' });
      execFileSync('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: buildDir, stdio: 'inherit' });
    }
    // Two overrides, both mandatory for a binary that leaves this machine.
    //
    // `SIMD=portable`: the Makefile otherwise detects the *build* host and compiles for it — a CI
    // runner with AVX-512 produced an `avx512bf16` binary, which is an illegal instruction on most
    // consumer CPUs the moment a character speaks.
    //
    // Static OpenBLAS: the Makefile links `-lopenblas`, which resolves on a machine with the dev
    // package and nowhere else. A dynamically linked build ships fine and then dies at startup
    // with `libopenblas.so.0: cannot open shared object file`. Dropping BLAS instead is not an
    // option — measured RTF 31 without it against ~2.5 with it, i.e. three minutes for a
    // six-second line.
    console.log('[build-native] make blas SIMD=portable (qwen_tts, static OpenBLAS)');
    execFileSync('make', ['blas', 'SIMD=portable', 'LDLIBS=-lm -lpthread -l:libopenblas.a -lgfortran'], {
      cwd: buildDir,
      stdio: 'inherit',
    });
  } catch (err) {
    // Never fatal by default: this engine is opt-in, and a machine without the toolchain (or
    // without the network, on a clone) should still get a working app with Pocket TTS.
    return skip('qwen_tts', err.message);
  }

  const built = join(buildDir, 'qwen_tts');
  if (!existsSync(built)) return skip('qwen_tts', `expected a binary at ${built}`);
  // Refuse to ship one that needs a library the user will not have. This is the check that was
  // missing when a dynamically linked build reached a machine without OpenBLAS and died at startup.
  // Under RP_REQUIRE_NATIVE=1 — which CI and the release both set — this fails the build rather
  // than quietly shipping something that cannot start.
  const linked = spawnSync('ldd', [built], { encoding: 'utf8' });
  const unshippable = /libopenblas|libgfortran|libquadmath|liblapack/.exec(linked.stdout ?? '');
  if (linked.status === 0 && unshippable) {
    return skip('qwen_tts', `it links ${unshippable[0]} dynamically, which most machines do not have`);
  }
  const target = resolve(appDir, 'resources/bin/qwen_tts');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(built, target);
  chmodSync(target, 0o755);
  console.log(`[build-native] copied to ${target}`);
}

if (process.platform !== 'linux') {
  skip('rp-overlay-wlr, rpchatd and qwen_tts', `only built on Linux (this is ${process.platform})`);
} else {
  if (!has('cargo', ['--version'])) {
    skip('rp-overlay-wlr and rpchatd', 'cargo is not on PATH (install Rust to build the native helpers)');
  } else {
    buildOverlayHelper();
    buildDaemon();
  }
  buildQwenTts();
}
process.exit(failed ? 1 : 0);
