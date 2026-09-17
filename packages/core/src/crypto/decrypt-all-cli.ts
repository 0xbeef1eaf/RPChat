#!/usr/bin/env node
/**
 * `rpchat-decrypt-all` — walk every file `sdk.crypto.encrypt` has touched for the user running
 * this script and decrypt whichever ones are still encrypted. Runs as a plain user process (no
 * daemon, no root): it reaches the daemon's key store the same way the app does, over the
 * group-gated socket, and otherwise only ever opens files this user already owns — the same
 * `resolvePath` in `manager.ts` that `sdk.crypto` itself uses refuses anything outside the
 * home directory or that looks like a system/session file, so this script cannot do more damage
 * than the SDK functions that created the log in the first place.
 *
 * Usage: `rpchat-decrypt-all [--home <dir>] [--data-dir <dir>] [--socket <path>] [--dry-run]`
 * `--data-dir` is the app's `userData` folder (default: the platform's usual RPChat config
 * folder — override this if the app was launched with a custom profile).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { DAEMON_SOCKET_PATH } from '@rp/shared';
import { DaemonKeyStore } from './daemon-key-store.js';
import { LocalKeyStore } from './key-store.js';
import { CryptoLog } from './log.js';
import { CryptoManager } from './manager.js';

function defaultUserDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') return process.env.APPDATA ? path.join(process.env.APPDATA, 'RPChat') : path.join(home, 'AppData', 'Roaming', 'RPChat');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'RPChat');
  return process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'RPChat') : path.join(home, '.config', 'RPChat');
}

interface Args {
  home: string;
  dataDir: string;
  socketPath: string;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { home: os.homedir(), dataDir: defaultUserDataDir(), socketPath: DAEMON_SOCKET_PATH, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--home') args.home = argv[++i] ?? args.home;
    else if (arg === '--data-dir') args.dataDir = argv[++i] ?? args.dataDir;
    else if (arg === '--socket') args.socketPath = argv[++i] ?? args.socketPath;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

const HELP = `rpchat-decrypt-all — decrypt every file sdk.crypto.encrypt has touched for this user

Usage: rpchat-decrypt-all [--home <dir>] [--data-dir <dir>] [--socket <path>] [--dry-run]

  --home <dir>       User home directory (default: $HOME). Files outside it are never touched.
  --data-dir <dir>   The app's userData folder, where the encryption log (and, without the
                      system daemon, the key history) live (default: the platform's usual
                      RPChat config folder).
  --socket <path>    The rpchatd socket (default: ${DAEMON_SOCKET_PATH}).
  --dry-run          List what would be decrypted without changing anything.
`;

/** Whether the system daemon answers right now, without throwing if it does not. */
async function daemonAvailable(socketPath: string): Promise<boolean> {
  try {
    await new DaemonKeyStore({ socketPath, timeoutMs: 1500 }).list();
    return true;
  } catch {
    return false;
  }
}

export async function run(argv: string[], out: Pick<Console, 'log' | 'error'> = console): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    out.log(HELP);
    return 0;
  }
  const cryptoDir = path.join(args.dataDir, 'crypto');
  const keyStore = (await daemonAvailable(args.socketPath)) ? new DaemonKeyStore({ socketPath: args.socketPath }) : new LocalKeyStore(cryptoDir);
  const log = new CryptoLog(cryptoDir);
  const manager = new CryptoManager({ keyStore, log, home: args.home });

  const pending = await log.pending();
  if (pending.length === 0) {
    out.log('Nothing to decrypt: the log has no pending encrypted files for this user.');
    return 0;
  }
  if (args.dryRun) {
    out.log(`${pending.length} file(s) would be decrypted:`);
    for (const entry of pending) out.log(`  ${entry.path} (key ${entry.keyId}, encrypted ${entry.encryptedAt})`);
    return 0;
  }

  const outcomes = await manager.decryptAll();
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      out.log(`ok    ${outcome.path}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    } else {
      failed++;
      out.error(`FAILED ${outcome.path}: ${outcome.reason ?? 'unknown error'}`);
    }
  }
  out.log(`${outcomes.length - failed}/${outcomes.length} decrypted.`);
  return failed > 0 ? 1 : 0;
}

/* c8 ignore start -- exercised via parseArgs/run in tests; this is only the process entry point */
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`rpchat-decrypt-all: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
/* c8 ignore stop */
