import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureEsbuildBinary, unpackedEsbuildBinaryPath } from './esbuild-binary.js';

describe('esbuild-binary', () => {
  it('computes the unpacked platform binary path for unix and windows', () => {
    expect(unpackedEsbuildBinaryPath('/opt/rpchat/resources', 'linux', 'x64')).toBe(
      path.join('/opt/rpchat/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'),
    );
    expect(unpackedEsbuildBinaryPath('/Applications/RPChat.app/Contents/Resources', 'darwin', 'arm64')).toBe(
      path.join('/Applications/RPChat.app/Contents/Resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
    );
    expect(unpackedEsbuildBinaryPath('C:/RPChat/resources', 'win32', 'x64')).toBe(
      path.join('C:/RPChat/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    );
  });

  it('sets ESBUILD_BINARY_PATH when packaged and the unpacked binary exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const expected = unpackedEsbuildBinaryPath('/opt/rpchat/resources', 'linux', 'x64');
    const configured = configureEsbuildBinary({
      isPackaged: true,
      resourcesPath: '/opt/rpchat/resources',
      env,
      platform: 'linux',
      arch: 'x64',
      existsSync: (p) => p === expected,
    });
    expect(configured).toBe(expected);
    expect(env.ESBUILD_BINARY_PATH).toBe(expected);
  });

  it('is a no-op in development, when already configured, or when the binary is absent', () => {
    const devEnv: NodeJS.ProcessEnv = {};
    expect(
      configureEsbuildBinary({
        isPackaged: false,
        resourcesPath: '/opt/rpchat/resources',
        env: devEnv,
        existsSync: () => true,
      }),
    ).toBeUndefined();
    expect(devEnv.ESBUILD_BINARY_PATH).toBeUndefined();

    const presetEnv: NodeJS.ProcessEnv = { ESBUILD_BINARY_PATH: '/custom/esbuild' };
    expect(
      configureEsbuildBinary({
        isPackaged: true,
        resourcesPath: '/opt/rpchat/resources',
        env: presetEnv,
        existsSync: () => true,
      }),
    ).toBeUndefined();
    expect(presetEnv.ESBUILD_BINARY_PATH).toBe('/custom/esbuild');

    const missingEnv: NodeJS.ProcessEnv = {};
    expect(
      configureEsbuildBinary({
        isPackaged: true,
        resourcesPath: '/opt/rpchat/resources',
        env: missingEnv,
        existsSync: () => false,
      }),
    ).toBeUndefined();
    expect(missingEnv.ESBUILD_BINARY_PATH).toBeUndefined();
  });

  it('loads esbuild lazily so ESBUILD_BINARY_PATH set after importing @rp/pack and @rp/sandbox takes effect', () => {
    const packEntry = import.meta.resolve('@rp/pack');
    const sandboxEntry = import.meta.resolve('@rp/sandbox');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-esbuild-lazy-'));
    // esbuild ignores ESBUILD_BINARY_PATH when the file does not exist; a real non-binary file
    // forces esbuild to accept the override and fail trying to spawn it.
    const sentinel = path.join(tmpDir, 'fake-esbuild');
    fs.writeFileSync(sentinel, 'not a binary\n', { mode: 0o644 });
    try {
      const script = `
        import { createRequire } from 'node:module';
        const { buildCharacterLibrary } = await import(${JSON.stringify(packEntry)});
        const { transpile } = await import(${JSON.stringify(sandboxEntry)});
        const req = createRequire(import.meta.url);
        const loadedBeforeCall = Object.keys(req.cache).some((k) => /[/\\\\]esbuild[/\\\\]/.test(k));
        process.env.ESBUILD_BINARY_PATH = ${JSON.stringify(sentinel)};
        const libResult = await buildCharacterLibrary({ 'hello.ts': 'export function hi() { return 1; }' }, 'characters/test/lib');
        let transpileError = '';
        try {
          transpile('return 1;', 'ts');
        } catch (err) {
          transpileError = err instanceof Error ? err.message : String(err);
        }
        console.log(JSON.stringify({ loadedBeforeCall, libCode: libResult.library.code, libProblems: libResult.library.problems, transpileError }));
      `;
      const env = { ...process.env };
      delete env.ESBUILD_BINARY_PATH;
      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
      const result = JSON.parse(raw.trim()) as {
        loadedBeforeCall: boolean;
        libCode: string;
        libProblems: Array<{ message: string }>;
        transpileError: string;
      };
      expect(result.loadedBeforeCall).toBe(false);
      expect(result.libCode).toBe('');
      expect(result.libProblems.some((p) => p.message.includes('fake-esbuild') || /EACCES|ENOEXEC|spawn/i.test(p.message))).toBe(true);
      expect(result.transpileError).toMatch(/fake-esbuild|EACCES|ENOEXEC|spawn/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
