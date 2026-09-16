/**
 * `dev.allow: false` in the root-owned policy (docs/spec/system.md "Policy `dev` block"): the app
 * ignores every development switch it has. Those switches are conveniences in a checkout and holes
 * in a managed install — `RP_MOCK_LLM` swaps the provider for a scripted one, `RP_SMOKE` drives
 * turns by itself, `RP_EXAMPLE_PLUGIN` installs a plugin from any directory, `RP_OVERLAY_HELPER`
 * executes any binary as the overlay helper, `RP_DAEMON_SOCKET` points the app at something
 * pretending to be rp-coded, `ELECTRON_RENDERER_URL` loads the UI itself from anywhere, and
 * `--inspect`/`--remote-debugging-port` hand out the main process and the renderer wholesale.
 *
 * Two decisions make this a lock rather than a suggestion:
 *
 * - The policy is read **synchronously at startup, from `POLICY_FILE_PATH` only** — never through
 *   `RP_POLICY_FILE`, which is one of the switches being taken away. Reading the lock through a
 *   file the locked user chose would be no lock at all.
 * - It **fails closed**: a policy file that exists but cannot be read or parsed locks dev mode.
 *   The cost of being wrong that way is a development convenience; the other way it is the lock.
 *
 * Enforcement is by subtraction: the switches are deleted from `process.env` before anything has
 * read them, so `dev-mode.ts`, `engine.ts`, `logger.ts` and `helper-process.ts` need no checks of
 * their own and a switch added later is covered by the `RP_` prefix without touching this file.
 * A launch that asks for an inspector flag cannot be fixed by subtraction — those are read before
 * any of our code runs — so it is refused instead.
 *
 * Everything here is pure or takes injectable hooks, so the decisions are unit-tested without
 * Electron and without a real `/etc`.
 */
import * as fs from 'node:fs';
import { DEFAULT_DEV_RULES, DEV_ARGV_FLAGS, DEV_ENV_KEYS, DEV_ENV_PREFIX, POLICY_FILE_PATH } from '@rp/shared';
import type { DevRules, PolicyFile } from '@rp/shared';

/** Where the `dev` block was read from, for the log line and the "why" in the UI. */
export type DevRulesSource =
  /** No policy file on this machine: every switch stays available. */
  | 'no-policy'
  /** A policy file was read; `rules` is what it says. */
  | 'policy'
  /** A policy file exists but could not be read or parsed — locked, because the lock cannot be confirmed. */
  | 'unreadable';

export interface DevRulesRead {
  rules: DevRules;
  source: DevRulesSource;
  /** Present for `unreadable`: what went wrong, for the log. */
  problem?: string;
}

/** Pure: the effective `dev` block. `devTools` follows `allow` unless the policy names it. */
export function devRules(policy: Pick<PolicyFile, 'dev'> | null | undefined): DevRules {
  const allow = policy?.dev?.allow !== false;
  const devTools = typeof policy?.dev?.devTools === 'boolean' ? policy.dev.devTools : allow;
  return { allow, devTools };
}

/**
 * Read the `dev` block from the policy file, synchronously and without throwing. Only this block
 * is looked at: a problem in some other part of the file is the policy watcher's to report, and
 * must not decide whether dev mode is locked. JSON that does not parse at all is a different
 * matter — then nothing about the file is known, so it locks.
 */
export function readDevRules(opts: { path?: string; readFile?: (path: string) => string } = {}): DevRulesRead {
  const path = opts.path ?? POLICY_FILE_PATH;
  const readFile = opts.readFile ?? ((p: string): string => fs.readFileSync(p, 'utf8'));
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rules: { ...DEFAULT_DEV_RULES }, source: 'no-policy' };
    return { rules: { allow: false, devTools: false }, source: 'unreadable', problem: `cannot read ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { rules: { allow: false, devTools: false }, source: 'unreadable', problem: `cannot parse ${path}: ${(err as Error).message}` };
  }
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { dev?: unknown }) : undefined;
  if (!raw) return { rules: { allow: false, devTools: false }, source: 'unreadable', problem: `${path} is not a JSON object` };
  const dev = raw.dev && typeof raw.dev === 'object' && !Array.isArray(raw.dev) ? (raw.dev as PolicyFile['dev']) : undefined;
  return { rules: devRules(dev ? { dev } : null), source: 'policy' };
}

/** Pure: the development switches present in `env`, sorted — the whole `RP_` prefix plus the named ones. */
export function devEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const named = new Set<string>(DEV_ENV_KEYS);
  return Object.keys(env)
    .filter((key) => key.startsWith(DEV_ENV_PREFIX) || named.has(key))
    .sort();
}

/** Delete every development switch from `env` (in place, so later readers of `process.env` see none). Returns what went. */
export function scrubDevEnv(env: NodeJS.ProcessEnv): string[] {
  const keys = devEnvKeys(env);
  for (const key of keys) delete env[key];
  return keys;
}

/** Pure: the inspector/debugging flags in `argv`, which a locked app cannot take back by deleting anything. */
export function refusedDevFlags(argv: readonly string[]): string[] {
  const flags = new Set<string>(DEV_ARGV_FLAGS);
  return argv.filter((arg) => arg.startsWith('--') && flags.has(arg.split('=')[0] ?? arg));
}

export interface DevGuardDecision {
  /** What applies for the life of this process. */
  rules: DevRules;
  source: DevRulesSource;
  /** True when the launch must not continue: it asked for an inspector flag while locked. */
  refuse: boolean;
  /** The flags that make `refuse` true. */
  refusedFlags: string[];
  /** Environment switches that were dropped (empty when dev mode is allowed). */
  removedEnv: string[];
}

export interface DevGuardOptions {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** The policy path. Never `RP_POLICY_FILE`: that is one of the switches this guard removes. */
  path?: string;
  readFile?: (path: string) => string;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Apply the lock to this process: read the policy, and while dev mode is forbidden strip the
 * switches out of the environment and report whether the launch must be refused. Called first
 * thing in `index.ts`, before the environment is read for anything else.
 */
export function applyDevGuard(opts: DevGuardOptions = {}): DevGuardDecision {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const read = readDevRules({ ...(opts.path !== undefined ? { path: opts.path } : {}), ...(opts.readFile ? { readFile: opts.readFile } : {}) });
  if (read.problem) opts.logger?.warn?.(`[dev-guard] ${read.problem}; development switches are locked off`);
  if (read.rules.allow) {
    if (read.source === 'policy') opts.logger?.info?.('[dev-guard] the policy allows development switches');
    return { rules: read.rules, source: read.source, refuse: false, refusedFlags: [], removedEnv: [] };
  }
  const removedEnv = scrubDevEnv(env);
  const refusedFlags = refusedDevFlags(argv);
  opts.logger?.info?.(
    `[dev-guard] development switches are locked off by policy${read.rules.devTools ? ' (DevTools left open)' : ''}${removedEnv.length > 0 ? `; ignoring ${removedEnv.join(', ')}` : ''}`,
  );
  return { rules: read.rules, source: read.source, refuse: refusedFlags.length > 0, refusedFlags, removedEnv };
}

/** The sentence logged (and shown on stderr) when a locked app is asked to start with a debugging flag. */
export function refusalMessage(flags: readonly string[]): string {
  return `[dev-guard] refusing to start: ${flags.join(', ')} would open a debugging channel, and the system policy locks development switches off`;
}
