/**
 * Root-owned policy file (docs/spec/system.md): forces selected settings keys. `applyPolicy`
 * is pure; `PolicyWatcher` re-reads the file whenever its mtime changes.
 */
import * as fs from 'node:fs/promises';
import type { AppPolicy, AppSettings, ManagedSettingsPaths, PolicyFile } from '@rp/shared';
import { POLICY_FILE_PATH, RpError } from '@rp/shared';

const AUTONOMY_KEYS = ['maxSelfWakesPerHour', 'maxConsecutiveSelfWakes', 'maxTimersPerSession', 'minRepeatIntervalMs', 'minDelayMs'] as const;
const MEMORY_KEYS = ['enabled', 'consolidateEveryTurns', 'maxEntriesPerCharacter', 'promptBudgetTokens'] as const;
const SENSES_KEYS = ['includeInPrompt', 'watchDirs', 'calendarSources'] as const;
const UPDATES_KEYS = ['automatic', 'enabled', 'allowDowngrade'] as const;
/** `updates.enabled` and `updates.allowDowngrade` are updater/daemon rules, not settings the UI pins. */
const UPDATES_MANAGED_KEYS = ['automatic', 'enabled'] as const;
const BROWSER_KEYS = ['allowBlocking', 'allowEval', 'allowHistory', 'homePage'] as const;
const BACKENDS = new Set(['auto', 'electron', 'hyprland']);

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function stringList(v: unknown, what: string, problems: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    problems.push(`${what} must be an array of strings`);
    return undefined;
  }
  return v as string[];
}

/** Validate the shape of a policy JSON document; unknown keys are ignored, wrong types rejected. */
export function parsePolicy(json: unknown): PolicyFile {
  const problems: string[] = [];
  const raw = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  if (!raw) throw new RpError('INVALID_ARGUMENT', 'policy must be a JSON object');
  if (raw.version !== 1) problems.push('version must be 1');
  const out: PolicyFile = { version: 1 };
  if (typeof raw.managedBy === 'string') out.managedBy = raw.managedBy.slice(0, 200);
  const s = raw.settings && typeof raw.settings === 'object' ? (raw.settings as Record<string, unknown>) : undefined;
  if (s) {
    const settings: NonNullable<PolicyFile['settings']> = {};
    if (s.autonomy && typeof s.autonomy === 'object') {
      const a: Partial<AppSettings['autonomy']> = {};
      for (const k of AUTONOMY_KEYS) {
        const v = (s.autonomy as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (isNumber(v) && v >= 0) a[k] = Math.round(v);
        else problems.push(`settings.autonomy.${k} must be a non-negative number`);
      }
      settings.autonomy = a;
    }
    if (s.maxInputLockMs !== undefined) {
      if (isNumber(s.maxInputLockMs) && s.maxInputLockMs >= 1000) settings.maxInputLockMs = Math.round(s.maxInputLockMs);
      else problems.push('settings.maxInputLockMs must be a number ≥ 1000');
    }
    if (s.permissions && typeof s.permissions === 'object') {
      const allow = (s.permissions as { moduleAllow?: unknown }).moduleAllow;
      if (allow !== undefined) {
        if (allow && typeof allow === 'object' && Object.values(allow as object).every((v) => typeof v === 'boolean')) settings.permissions = { moduleAllow: allow as Record<string, boolean> };
        else problems.push('settings.permissions.moduleAllow must map module ids to booleans');
      }
    }
    if (s.web && typeof s.web === 'object') {
      const list = stringList((s.web as { allowlist?: unknown }).allowlist, 'settings.web.allowlist', problems);
      if (list) settings.web = { allowlist: list };
    }
    if (s.desktop && typeof s.desktop === 'object') {
      const list = stringList((s.desktop as { launchAllowlist?: unknown }).launchAllowlist, 'settings.desktop.launchAllowlist', problems);
      if (list) settings.desktop = { launchAllowlist: list };
    }
    if (s.memory && typeof s.memory === 'object') {
      const m: Partial<AppSettings['memory']> = {};
      for (const k of MEMORY_KEYS) {
        const v = (s.memory as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (k === 'enabled') {
          if (typeof v === 'boolean') m.enabled = v;
          else problems.push('settings.memory.enabled must be a boolean');
        } else if (isNumber(v) && v >= 0) m[k] = Math.round(v);
        else problems.push(`settings.memory.${k} must be a non-negative number`);
      }
      settings.memory = m;
    }
    if (s.senses && typeof s.senses === 'object') {
      const se: NonNullable<NonNullable<PolicyFile['settings']>['senses']> = {};
      const raw2 = s.senses as Record<string, unknown>;
      if (raw2.includeInPrompt !== undefined) {
        if (typeof raw2.includeInPrompt === 'boolean') se.includeInPrompt = raw2.includeInPrompt;
        else problems.push('settings.senses.includeInPrompt must be a boolean');
      }
      const wd = stringList(raw2.watchDirs, 'settings.senses.watchDirs', problems);
      if (wd) se.watchDirs = wd;
      const cs = stringList(raw2.calendarSources, 'settings.senses.calendarSources', problems);
      if (cs) se.calendarSources = cs;
      settings.senses = se;
    }
    if (s.displayBackend !== undefined) {
      if (typeof s.displayBackend === 'string' && BACKENDS.has(s.displayBackend)) settings.displayBackend = s.displayBackend as AppSettings['displayBackend'];
      else problems.push('settings.displayBackend must be auto, electron or hyprland');
    }
    if (s.updates && typeof s.updates === 'object') {
      const u: NonNullable<NonNullable<PolicyFile['settings']>['updates']> = {};
      for (const k of UPDATES_KEYS) {
        const v = (s.updates as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (typeof v === 'boolean') u[k] = v;
        else problems.push(`settings.updates.${k} must be a boolean`);
      }
      settings.updates = u;
    }
    if (s.browser && typeof s.browser === 'object') {
      const b: NonNullable<NonNullable<PolicyFile['settings']>['browser']> = {};
      const raw3 = s.browser as Record<string, unknown>;
      for (const k of BROWSER_KEYS) {
        const v = raw3[k];
        if (v === undefined) continue;
        if (k === 'homePage') {
          if (typeof v === 'string' && (v === '' || /^https?:\/\//i.test(v))) b.homePage = v;
          else problems.push('settings.browser.homePage must be an http(s) URL or ""');
        } else if (typeof v === 'boolean') b[k] = v;
        else problems.push(`settings.browser.${k} must be a boolean`);
      }
      settings.browser = b;
    }
    out.settings = settings;
  }
  if (raw.inputLock && typeof raw.inputLock === 'object') {
    const il = raw.inputLock as Record<string, unknown>;
    const lock: NonNullable<PolicyFile['inputLock']> = {};
    if (il.maxDurationMs !== undefined) {
      if (isNumber(il.maxDurationMs) && il.maxDurationMs >= 1000) lock.maxDurationMs = Math.round(il.maxDurationMs);
      else problems.push('inputLock.maxDurationMs must be a number ≥ 1000');
    }
    if (il.emergencyKey !== undefined) {
      if (typeof il.emergencyKey === 'string' && ['esc', 'f1', 'f12', 'pause'].includes(il.emergencyKey)) lock.emergencyKey = il.emergencyKey as 'esc';
      else problems.push('inputLock.emergencyKey must be esc, f1, f12 or pause');
    }
    if (il.emergencyHoldMs !== undefined) {
      if (isNumber(il.emergencyHoldMs) && il.emergencyHoldMs >= 500) lock.emergencyHoldMs = Math.round(il.emergencyHoldMs);
      else problems.push('inputLock.emergencyHoldMs must be a number ≥ 500');
    }
    if (il.enabled !== undefined) {
      if (typeof il.enabled === 'boolean') lock.enabled = il.enabled;
      else problems.push('inputLock.enabled must be a boolean');
    }
    out.inputLock = lock;
  }
  if (raw.app !== undefined) {
    if (!raw.app || typeof raw.app !== 'object' || Array.isArray(raw.app)) problems.push('app must be an object');
    else {
      const a = raw.app as Record<string, unknown>;
      const appBlock: NonNullable<PolicyFile['app']> = {};
      if (a.allowQuit !== undefined) {
        if (typeof a.allowQuit === 'boolean') appBlock.allowQuit = a.allowQuit;
        else problems.push('app.allowQuit must be a boolean');
      }
      if (a.users !== undefined) {
        if (Array.isArray(a.users) && a.users.length > 0 && a.users.every((u) => typeof u === 'string' && u.trim().length > 0)) appBlock.users = (a.users as string[]).map((u) => u.trim());
        else problems.push('app.users must be a non-empty array of user names');
      }
      out.app = appBlock;
    }
  }
  if (problems.length > 0) throw new RpError('INVALID_ARGUMENT', `Invalid policy file:\n${problems.join('\n')}`, { problems });
  return out;
}

/** Pure: the effective `app` block — `allowQuit` is true unless a policy says `false`; `users` empty unless listed. */
export function appPolicy(policy: PolicyFile | null | undefined): AppPolicy {
  return { allowQuit: policy?.app?.allowQuit !== false, users: [...(policy?.app?.users ?? [])] };
}

/** Dotted settings paths forced by `policy` (sorted, deduplicated). */
export function managedPaths(policy: PolicyFile | null | undefined): ManagedSettingsPaths {
  const out = new Set<string>();
  const s = policy?.settings;
  if (!s) return [];
  for (const k of AUTONOMY_KEYS) if (s.autonomy?.[k] !== undefined) out.add(`autonomy.${k}`);
  if (s.maxInputLockMs !== undefined) out.add('maxInputLockMs');
  for (const m of Object.keys(s.permissions?.moduleAllow ?? {})) out.add(`permissions.moduleAllow.${m}`);
  if (s.web?.allowlist !== undefined) out.add('web.allowlist');
  if (s.desktop?.launchAllowlist !== undefined) out.add('desktop.launchAllowlist');
  for (const k of MEMORY_KEYS) if (s.memory?.[k] !== undefined) out.add(`memory.${k}`);
  for (const k of SENSES_KEYS) if (s.senses?.[k] !== undefined) out.add(`senses.${k}`);
  if (s.displayBackend !== undefined) out.add('displayBackend');
  for (const k of UPDATES_MANAGED_KEYS) if (s.updates?.[k] !== undefined) out.add(`updates.${k}`);
  for (const k of BROWSER_KEYS) if (s.browser?.[k] !== undefined) out.add(`browser.${k}`);
  return [...out].sort();
}

/** Pure: settings with every policy-forced key overwritten. Also caps `maxInputLockMs` by `inputLock.maxDurationMs`. */
export function applyPolicy(settings: AppSettings, policy: PolicyFile | null | undefined): { settings: AppSettings; managed: ManagedSettingsPaths } {
  if (!policy) return { settings, managed: [] };
  const s = policy.settings ?? {};
  const next: AppSettings = { ...settings };
  if (s.autonomy) next.autonomy = { ...settings.autonomy, ...definedOnly(s.autonomy) };
  if (s.maxInputLockMs !== undefined) next.maxInputLockMs = s.maxInputLockMs;
  if (s.permissions?.moduleAllow) next.permissions = { ...settings.permissions, moduleAllow: { ...settings.permissions.moduleAllow, ...s.permissions.moduleAllow } };
  if (s.web?.allowlist !== undefined) next.web = { ...settings.web, allowlist: [...s.web.allowlist] };
  if (s.desktop?.launchAllowlist !== undefined) next.desktop = { ...settings.desktop, launchAllowlist: [...s.desktop.launchAllowlist] };
  if (s.memory) next.memory = { ...settings.memory, ...definedOnly(s.memory) };
  if (s.senses) next.senses = { ...settings.senses, ...definedOnly(s.senses) };
  if (s.displayBackend !== undefined) next.displayBackend = s.displayBackend;
  // `updates.enabled` has no settings counterpart (the update service reads it from the policy);
  // `enabled: false` also switches the background toggle off so the UI reflects the effective state.
  if (s.updates?.automatic !== undefined) next.updates = { ...settings.updates, automatic: s.updates.automatic };
  if (s.updates?.enabled === false) next.updates = { ...next.updates, automatic: false };
  if (s.browser) next.browser = { ...settings.browser, ...definedOnly(s.browser) };
  const hardMax = policy.inputLock?.maxDurationMs;
  if (hardMax !== undefined && next.maxInputLockMs > hardMax) next.maxInputLockMs = hardMax;
  if (policy.inputLock?.enabled === false) next.maxInputLockMs = Math.min(next.maxInputLockMs, 1000);
  return { settings: next, managed: managedPaths(policy) };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Pure: a settings patch with every managed path removed (so `settings.update` cannot touch them). */
export function stripManagedPatch(patch: Partial<AppSettings>, managed: ManagedSettingsPaths): Partial<AppSettings> {
  if (managed.length === 0 || !patch || typeof patch !== 'object') return patch;
  const out: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  const managedSet = new Set(managed);
  for (const key of Object.keys(out)) {
    if (managedSet.has(key)) {
      delete out[key];
      continue;
    }
    const nested = out[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const copy: Record<string, unknown> = { ...(nested as Record<string, unknown>) };
    for (const sub of Object.keys(copy)) {
      const p = `${key}.${sub}`;
      if (managedSet.has(p)) {
        delete copy[sub];
        continue;
      }
      const inner = copy[sub];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const innerCopy: Record<string, unknown> = { ...(inner as Record<string, unknown>) };
        for (const leaf of Object.keys(innerCopy)) if (managedSet.has(`${p}.${leaf}`)) delete innerCopy[leaf];
        copy[sub] = innerCopy;
      }
    }
    out[key] = copy;
  }
  return out as Partial<AppSettings>;
}

export interface PolicyState {
  present: boolean;
  path: string;
  policy: PolicyFile | null;
  managed: ManagedSettingsPaths;
  /** `appPolicy(policy)`: defaults (quit allowed, nobody listed) without a file or with a broken one. */
  app: AppPolicy;
  managedBy?: string;
  error?: string;
}

/** Read and validate the policy file once. Missing file → `policy: null`, no error. */
export async function loadPolicy(path: string = POLICY_FILE_PATH): Promise<PolicyState> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, path, policy: null, managed: [], app: appPolicy(null) };
    return { present: true, path, policy: null, managed: [], app: appPolicy(null), error: `cannot read ${path}: ${(err as Error).message}` };
  }
  try {
    const policy = parsePolicy(JSON.parse(text));
    const state: PolicyState = { present: true, path, policy, managed: managedPaths(policy), app: appPolicy(policy) };
    if (policy.managedBy) state.managedBy = policy.managedBy;
    return state;
  } catch (err) {
    return { present: true, path, policy: null, managed: [], app: appPolicy(null), error: (err as Error).message };
  }
}

/** Caches the parsed policy and re-reads it when the file's mtime (or existence) changes. */
export class PolicyWatcher {
  private state: PolicyState | undefined;
  private stamp: string | undefined;
  private inflight: Promise<PolicyState> | undefined;

  constructor(
    readonly path: string = POLICY_FILE_PATH,
    private readonly logger?: Pick<Console, 'info' | 'warn'>,
  ) {}

  /** Drop the cache so the next `current()` re-reads the file whatever its mtime (e.g. right after creating it). */
  invalidate(): void {
    this.state = undefined;
    this.stamp = undefined;
  }

  async current(): Promise<PolicyState> {
    let stamp: string;
    try {
      const st = await fs.stat(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = 'missing';
    }
    if (this.state && stamp === this.stamp) return this.state;
    if (this.inflight) return this.inflight;
    this.inflight = loadPolicy(this.path)
      .then((state) => {
        const changed = this.stamp !== undefined && this.stamp !== stamp;
        this.state = state;
        this.stamp = stamp;
        if (state.error) this.logger?.warn?.(`[policy] ${state.error}`);
        else if (state.present) this.logger?.info?.(`[policy] ${changed ? 'reloaded' : 'loaded'} ${this.path}: ${state.managed.length} managed setting(s)${state.app.allowQuit ? '' : `, quitting disabled for ${state.app.users.length > 0 ? state.app.users.join(', ') : 'nobody (app.users is empty)'}`}${state.managedBy ? ` (managed by ${state.managedBy})` : ''}`);
        return state;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
