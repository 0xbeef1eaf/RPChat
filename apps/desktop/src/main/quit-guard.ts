/**
 * `app.allowQuit: false` in the root-owned policy (docs/system-integration.md "Keeping the app
 * running"): the app offers no way to quit and ignores termination signals; the daemon relaunches
 * it when the process dies anyway. Everything here is pure or takes injectable hooks so the
 * decisions are unit-tested without Electron:
 *
 * - `quitDecision` — whether a `before-quit` must be cancelled.
 * - `trayMenuTemplate` — the tray items, without Quit while the policy forbids quitting.
 * - `keepaliveEnv` / `launchSpec` — what the app registers with the daemon so a relaunch
 *   reproduces this very launch (AppImage or bare executable) in the user's session.
 * - `QuitGuard` — the state: policy value, one-shot authorisation for the update restart, and
 *   the SIGINT/SIGTERM/SIGHUP handlers that are installed only while quitting is forbidden.
 */
import type { AppPolicy, PolicyFile } from '@rp/shared';
import { KEEPALIVE_ENV_KEYS } from '@rp/shared';

/** Signals ignored while the policy forbids quitting (SIGKILL cannot be caught; the daemon relaunches then). */
export const GUARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type GuardedSignal = (typeof GUARDED_SIGNALS)[number];

/** Pure: whether a quit must be blocked. An authorised quit (update restart, dev harness) always goes through. */
export function quitDecision(input: { allowQuit: boolean; authorised: boolean }): 'proceed' | 'block' {
  return input.allowQuit || input.authorised ? 'proceed' : 'block';
}

export interface TrayMenuItem {
  id: 'show' | 'hide' | 'check-updates' | 'quit';
  label: string;
}

/** Pure: the tray menu, in order; a separator precedes Quit. Without `allowQuit` there is no Quit item at all. */
export function trayMenuTemplate(allowQuit: boolean): Array<TrayMenuItem | { type: 'separator' }> {
  const items: Array<TrayMenuItem | { type: 'separator' }> = [
    { id: 'show', label: 'Show rpchat' },
    { id: 'hide', label: 'Hide window' },
    { id: 'check-updates', label: 'Check for updates…' },
  ];
  if (allowQuit) items.push({ type: 'separator' }, { id: 'quit', label: 'Quit' });
  return items;
}

/** Pure: the whitelisted subset of `env` a keepalive registration carries (unset and empty values dropped). */
export function keepaliveEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEEPALIVE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

export interface LaunchSpec {
  exec: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Pure: how to start this app again. An AppImage is relaunched through the `.AppImage` itself
 * (its inner `execPath` lives in a FUSE mount that disappears with the process), with no extra
 * arguments; anything else repeats `execPath argv[1..]` (which for `electron out/main/index.js`
 * keeps the script and for a packaged binary keeps flags such as `--hidden`). Chromium's own
 * `--no-sandbox`/`--type` style flags are kept as they were given on this launch.
 */
export function launchSpec(input: { execPath: string; argv: string[]; appImage?: string | undefined; cwd: string; env: NodeJS.ProcessEnv }): LaunchSpec {
  const env = keepaliveEnv(input.env);
  if (input.appImage) return { exec: input.appImage, args: [], cwd: input.cwd, env };
  return { exec: input.execPath, args: input.argv.slice(1), cwd: input.cwd, env };
}

export interface QuitGuardOptions {
  logger?: Pick<Console, 'info' | 'warn'>;
  /** Injectable for tests (defaults to `process.on`/`process.off`). */
  signals?: { on(sig: GuardedSignal, handler: () => void): void; off(sig: GuardedSignal, handler: () => void): void };
  /** What an *allowed* signal does (defaults to nothing: Node's default handling is gone once a handler is installed, so the guard removes its handlers instead). */
  onAllowedSignal?: (sig: GuardedSignal) => void;
}

/**
 * Tracks the policy's `app.allowQuit` and the one-shot authorisation for internal restarts.
 * `apply(policy)` installs the signal handlers while quitting is forbidden and removes them
 * again when the policy changes back, so without a policy the process behaves exactly as before.
 */
export class QuitGuard {
  private policy: AppPolicy = { allowQuit: true, users: [] };
  private authorisedOnce = false;
  private readonly handlers = new Map<GuardedSignal, () => void>();
  private readonly signals: NonNullable<QuitGuardOptions['signals']>;
  private readonly listeners = new Set<(policy: AppPolicy) => void>();

  constructor(private readonly opts: QuitGuardOptions = {}) {
    this.signals = opts.signals ?? { on: (sig, h) => void process.on(sig, h), off: (sig, h) => void process.off(sig, h) };
  }

  /** The effective `app` block last applied. */
  get current(): AppPolicy {
    return this.policy;
  }

  get allowQuit(): boolean {
    return this.policy.allowQuit;
  }

  /** Whether the next quit goes through (policy allows it, or it was authorised). Does not consume the authorisation. */
  get mayQuit(): boolean {
    return quitDecision({ allowQuit: this.policy.allowQuit, authorised: this.authorisedOnce }) === 'proceed';
  }

  /** Let the next quit through whatever the policy says (update restart; the dev harness ending a run). */
  allowQuitOnce(): void {
    this.authorisedOnce = true;
  }

  /** Called when a policy change flips `allowQuit` (to rebuild the tray menu, for instance). */
  onChange(listener: (policy: AppPolicy) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply the current policy (`null` = no file). Returns true when `allowQuit` changed. */
  apply(policy: PolicyFile | null | undefined): boolean {
    const next: AppPolicy = { allowQuit: policy?.app?.allowQuit !== false, users: [...(policy?.app?.users ?? [])] };
    const changed = next.allowQuit !== this.policy.allowQuit || next.users.join('\0') !== this.policy.users.join('\0');
    this.policy = next;
    if (!changed) return false;
    if (next.allowQuit) this.uninstallSignals();
    else this.installSignals();
    for (const l of this.listeners) l(next);
    return true;
  }

  /**
   * `before-quit` decision: `'block'` means the caller must `event.preventDefault()`. A
   * `'proceed'` consumes the one-shot authorisation so a later, unauthorised quit is blocked again.
   */
  beforeQuit(): 'proceed' | 'block' {
    const decision = quitDecision({ allowQuit: this.policy.allowQuit, authorised: this.authorisedOnce });
    if (decision === 'proceed') this.authorisedOnce = false;
    else this.opts.logger?.warn?.('[quit-guard] quit blocked: app.allowQuit is false in the policy');
    return decision;
  }

  /** Remove the signal handlers (e.g. before the process ends for an authorised reason). */
  dispose(): void {
    this.uninstallSignals();
  }

  private installSignals(): void {
    for (const sig of GUARDED_SIGNALS) {
      if (this.handlers.has(sig)) continue;
      const handler = (): void => {
        if (this.mayQuit) {
          this.opts.onAllowedSignal?.(sig);
          return;
        }
        this.opts.logger?.info?.(`[quit-guard] ignoring ${sig}: quitting is disabled by policy`);
      };
      this.handlers.set(sig, handler);
      this.signals.on(sig, handler);
    }
    this.opts.logger?.info?.(`[quit-guard] quitting disabled by policy; ${GUARDED_SIGNALS.join('/')} are ignored`);
  }

  private uninstallSignals(): void {
    for (const [sig, handler] of this.handlers) this.signals.off(sig, handler);
    if (this.handlers.size > 0) this.opts.logger?.info?.('[quit-guard] quitting allowed again; signal handlers removed');
    this.handlers.clear();
  }
}
