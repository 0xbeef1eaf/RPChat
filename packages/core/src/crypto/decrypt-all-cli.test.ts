import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../test/helpers.js';
import { parseArgs, run } from './decrypt-all-cli.js';
import { LocalKeyStore } from './key-store.js';
import { CryptoLog } from './log.js';
import { CryptoManager } from './manager.js';

let home: string;
let dataDir: string;

afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

/** A path nothing listens on, so daemonAvailable() fails fast without touching a real daemon socket. */
function noDaemonSocket(): string {
  return path.join(dataDir, 'no-such-daemon.sock');
}

function fakeConsole() {
  const log: string[] = [];
  const error: string[] = [];
  return { log: (s: string) => log.push(s), error: (s: string) => error.push(s), lines: log, errors: error };
}

describe('parseArgs', () => {
  it('reads --home, --data-dir, --socket, --dry-run and --help', () => {
    const args = parseArgs(['--home', '/h', '--data-dir', '/d', '--socket', '/s.sock', '--dry-run']);
    expect(args).toMatchObject({ home: '/h', dataDir: '/d', socketPath: '/s.sock', dryRun: true, help: false });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('defaults to the home directory, a platform data directory and the standard socket when unset', () => {
    const args = parseArgs([]);
    expect(args.home).toBeTruthy();
    expect(args.dataDir).toContain('RPChat');
    expect(args.socketPath).toBe('/run/rpchat/daemon.sock');
    expect(args.dryRun).toBe(false);
  });
});

describe('run', () => {
  it('reports nothing to do when the log is empty', async () => {
    home = await makeTempDir('rp-cli-home-');
    dataDir = await makeTempDir('rp-cli-data-');
    const out = fakeConsole();
    const code = await run(['--home', home, '--data-dir', dataDir, '--socket', noDaemonSocket()], out);
    expect(code).toBe(0);
    expect(out.lines.join('\n')).toMatch(/Nothing to decrypt/);
  });

  it('dry-run lists pending files without changing them', async () => {
    home = await makeTempDir('rp-cli-home-');
    dataDir = await makeTempDir('rp-cli-data-');
    const cryptoDir = path.join(dataDir, 'crypto');
    const manager = new CryptoManager({ keyStore: new LocalKeyStore(cryptoDir), log: new CryptoLog(cryptoDir), home });
    const file = path.join(home, 'diary.md');
    await fs.writeFile(file, 'secret plans');
    await manager.encrypt(file);

    const out = fakeConsole();
    const code = await run(['--home', home, '--data-dir', dataDir, '--socket', noDaemonSocket(), '--dry-run'], out);
    expect(code).toBe(0);
    expect(out.lines.join('\n')).toContain(file);
    // Still encrypted: dry-run touched nothing.
    expect((await fs.readFile(file, 'utf8'))).not.toBe('secret plans');
  });

  it('decrypts everything pending and returns a non-zero exit code when something failed', async () => {
    home = await makeTempDir('rp-cli-home-');
    dataDir = await makeTempDir('rp-cli-data-');
    const cryptoDir = path.join(dataDir, 'crypto');
    const manager = new CryptoManager({ keyStore: new LocalKeyStore(cryptoDir), log: new CryptoLog(cryptoDir), home });
    const ok = path.join(home, 'ok.txt');
    const missing = path.join(home, 'missing.txt');
    await fs.writeFile(ok, 'hi');
    await fs.writeFile(missing, 'bye');
    await manager.encrypt(ok);
    await manager.encrypt(missing);
    await fs.rm(missing);

    const out = fakeConsole();
    const code = await run(['--home', home, '--data-dir', dataDir, '--socket', noDaemonSocket()], out);
    expect(code).toBe(1);
    expect(await fs.readFile(ok, 'utf8')).toBe('hi');
    expect(out.lines.some((l) => l.startsWith('ok') && l.includes(ok))).toBe(true);
    expect(out.errors.some((l) => l.includes(missing))).toBe(true);
  });

  it('--help prints usage and exits 0 without touching anything', async () => {
    const out = fakeConsole();
    const code = await run(['--help'], out);
    expect(code).toBe(0);
    expect(out.lines.join('\n')).toContain('Usage');
  });
});
