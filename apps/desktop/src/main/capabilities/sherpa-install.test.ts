/**
 * Fetching the speech engine. The per-platform asset and `tar` choices are the fragile part — they
 * cannot be exercised on one machine — so they are pure functions tested directly, and the install
 * flow is driven with an injected fetch and tar.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHERPA_VERSION, SherpaInstaller, assetFor, binaryName, tarArgs } from './sherpa-install.js';

const logger = { warn: () => undefined, info: () => undefined, debug: () => undefined };
const tmpRoot = fs.mkdtemp(path.join(os.tmpdir(), 'rp-sherpa-'));
let tmp = '';

const ARCHIVE = Buffer.alloc(28_156_791, 7); // the published size of the linux-x64 asset

const okResponse = (body: Buffer): Response =>
  ({ ok: true, status: 200, body: null, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }) as unknown as Response;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(await tmpRoot, 'case-'));
});

afterAll(async () => {
  await fs.rm(await tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** A tar stand-in that materialises the files a real extraction would produce. */
function fakeTar(opts: { produceBinary?: boolean; code?: number } = {}) {
  return vi.fn(async (_file: string, args: string[]) => {
    if (opts.code) return { code: opts.code, stdout: '', stderr: 'tar: broken archive' };
    const dest = args[args.indexOf('-C') + 1]!;
    if (opts.produceBinary !== false) {
      await fs.mkdir(path.join(dest, 'bin'), { recursive: true });
      await fs.mkdir(path.join(dest, 'lib'), { recursive: true });
      await fs.writeFile(path.join(dest, 'bin', 'sherpa-onnx-offline-tts'), 'ELF');
      await fs.writeFile(path.join(dest, 'lib', 'libonnxruntime.so'), 'lib');
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

function installer(over: Partial<ConstructorParameters<typeof SherpaInstaller>[0]> = {}) {
  return new SherpaInstaller({ dir: tmp, logger, platform: 'linux', arch: 'x64', fetchImpl: vi.fn().mockResolvedValue(okResponse(ARCHIVE)) as unknown as typeof fetch, spawn: fakeTar(), ...over });
}

describe('assetFor', () => {
  it('has a shared build for every desktop platform the app ships on', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'], ['linux', 'arm64'],
      ['darwin', 'x64'], ['darwin', 'arm64'],
      ['win32', 'x64'], ['win32', 'arm64'],
    ] as Array<[NodeJS.Platform, string]>) {
      const asset = assetFor(platform, arch);
      expect(asset, `${platform}-${arch}`).toBeDefined();
      expect(asset!.file).toContain(SHERPA_VERSION);
      // `-static` archives are ten times the size for no benefit; never pick one by accident.
      expect(asset!.file).not.toContain('static');
      expect(asset!.url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/')).toBe(true);
      expect(asset!.bytes).toBeGreaterThan(1_000_000);
    }
  });

  it('picks the Windows build that needs no Visual C++ redistributable', () => {
    expect(assetFor('win32', 'x64')!.file).toContain('MT-Release');
  });

  it('returns nothing for a platform upstream does not publish', () => {
    expect(assetFor('linux', 'mips')).toBeUndefined();
    expect(assetFor('freebsd' as NodeJS.Platform, 'x64')).toBeUndefined();
  });
});

describe('tarArgs', () => {
  it('extracts only the TTS binary and the libraries it links against', () => {
    const args = tarArgs('linux', '/a.tar.bz2', '/dest');
    expect(args).toContain('*/bin/sherpa-onnx-offline-tts');
    expect(args).toContain('*/lib/*');
    expect(args).toContain('--strip-components=1');
    // The other forty demo executables in the archive are not worth ~150 MB on disk.
    expect(args.some((a) => a === '*/bin/*')).toBe(false);
  });

  it('passes --wildcards only to GNU tar', () => {
    // GNU tar (Linux) needs it to treat the patterns as globs.
    expect(tarArgs('linux', '/a', '/d')).toContain('--wildcards');
    // bsdtar (macOS, Windows) globs by default and rejects the flag outright.
    expect(tarArgs('darwin', '/a', '/d')).not.toContain('--wildcards');
    expect(tarArgs('win32', '/a', '/d')).not.toContain('--wildcards');
  });

  it('lets tar sniff the compression rather than naming it', () => {
    // bsdtar has no -j; both implementations detect bzip2 from the file's magic.
    expect(tarArgs('darwin', '/a', '/d')).toContain('-xf');
    expect(tarArgs('darwin', '/a', '/d').some((a) => a.includes('j'))).toBe(false);
  });

  it('asks for the .exe on Windows', () => {
    expect(binaryName('win32')).toBe('sherpa-onnx-offline-tts.exe');
    expect(binaryName('linux')).toBe('sherpa-onnx-offline-tts');
    expect(tarArgs('win32', '/a', '/d')).toContain('*/bin/sherpa-onnx-offline-tts.exe');
  });
});

describe('ensure', () => {
  it('downloads, unpacks and reports the binary path', async () => {
    const inst = installer();
    const file = await inst.ensure();
    expect(file).toBe(path.join(tmp, SHERPA_VERSION, 'bin', 'sherpa-onnx-offline-tts'));
    expect(inst.status()).toMatchObject({ state: 'ready', version: SHERPA_VERSION });
    // The libraries land beside it, because the binary's RPATH is $ORIGIN/../lib.
    await expect(fs.stat(path.join(tmp, SHERPA_VERSION, 'lib', 'libonnxruntime.so'))).resolves.toBeTruthy();
    // The archive is not kept around afterwards.
    await expect(fs.stat(path.join(tmp, `${assetFor('linux', 'x64')!.file}.part`))).rejects.toThrow();
  });

  it('is idempotent: a second call does not download again', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(ARCHIVE));
    const inst = installer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await inst.ensure();
    await inst.ensure();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one download between concurrent callers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(ARCHIVE));
    const inst = installer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([inst.ensure(), inst.ensure(), inst.ensure()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an archive whose size does not match what upstream published', async () => {
    const inst = installer({ fetchImpl: vi.fn().mockResolvedValue(okResponse(Buffer.alloc(1234))) as unknown as typeof fetch });
    expect(await inst.ensure()).toBeUndefined();
    expect(inst.status()).toMatchObject({ state: 'failed' });
    expect(inst.status().error).toContain('expected');
  });

  it('never throws when the download fails, because it runs at startup', async () => {
    const inst = installer({ fetchImpl: vi.fn().mockRejectedValue(new Error('no network')) as unknown as typeof fetch });
    await expect(inst.ensure()).resolves.toBeUndefined();
    expect(inst.status()).toMatchObject({ state: 'failed', error: 'no network' });
  });

  it('leaves no half install behind when tar fails', async () => {
    const inst = installer({ spawn: fakeTar({ code: 2 }) });
    expect(await inst.ensure()).toBeUndefined();
    await expect(fs.stat(path.join(tmp, SHERPA_VERSION))).rejects.toThrow();
    await expect(fs.stat(`${path.join(tmp, SHERPA_VERSION)}.incoming`)).rejects.toThrow();
  });

  it('fails when the archive did not contain the binary, rather than reporting success', async () => {
    const inst = installer({ spawn: fakeTar({ produceBinary: false }) });
    expect(await inst.ensure()).toBeUndefined();
    expect(inst.status().error).toContain('did not contain');
  });

  it('reports an unsupported platform instead of trying', async () => {
    const fetchImpl = vi.fn();
    const inst = installer({ arch: 'mips', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await inst.ensure()).toBeUndefined();
    expect(inst.status()).toMatchObject({ state: 'unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('starts as absent, or unsupported where there is no build', () => {
    expect(installer().status()).toMatchObject({ state: 'absent', version: SHERPA_VERSION });
    expect(installer({ arch: 'mips' }).status().state).toBe('unsupported');
  });

  it('records an engine found elsewhere as present, and does not overwrite that with disabled', () => {
    const inst = installer();
    inst.markPresent('/usr/bin/sherpa-onnx-offline-tts');
    expect(inst.status()).toMatchObject({ state: 'present', path: '/usr/bin/sherpa-onnx-offline-tts' });
    inst.markDisabled();
    expect(inst.status().state).toBe('present');
  });

  it('records the download being switched off', () => {
    const inst = installer();
    inst.markDisabled();
    expect(inst.status().state).toBe('disabled');
  });
});
