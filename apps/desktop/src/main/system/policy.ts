/**
 * Root-owned policy file (docs/spec/system.md): forces selected settings keys. `applyPolicy`
 * is pure; `PolicyWatcher` re-reads the file whenever its mtime changes.
 */
import * as fs from 'node:fs/promises';
import type { AppPolicy, AppRestrictions, AppSettings, GuardPolicy, ManagedSettingsPaths, PackSource, PacksPolicy, PolicyFile, PolicyLock, RemotePolicy } from '@rp/shared';
import { APP_ALLOW_KEYS, APP_REQUIRE_KEYS, DEFAULT_APP_RESTRICTIONS, GUARD_COMPOSITOR_IPC, GUARD_MODES, GUARD_SHELLS, POLICY_FILE_PATH, RUNTIME_POLICY_FILE, RpError, SEAL_MARKER_PATH, parseFunctionKey } from '@rp/shared';
import type { GuardShell } from '@rp/shared';
import { activeRestrictions } from './restrictions.js';
import type { SealCache } from './seal-cache.js';
import { policyHash } from './seal-cache.js';

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
      // `moduleAllow` is what `functionAllow` was called while permissions were per module; its
      // keys are module-level entries now, so a policy file written back then still applies.
      const raw = s.permissions as { functionAllow?: unknown; moduleAllow?: unknown };
      const maps: Record<string, boolean> = {};
      let any = false;
      for (const key of ['moduleAllow', 'functionAllow'] as const) {
        const allow = raw[key];
        if (allow === undefined) continue;
        if (allow && typeof allow === 'object' && !Array.isArray(allow) && Object.values(allow as object).every((v) => typeof v === 'boolean')) {
          Object.assign(maps, allow as Record<string, boolean>);
          any = true;
        } else problems.push(`settings.permissions.${key} must map "module" or "module.function" keys to booleans`);
      }
      if (any) settings.permissions = { functionAllow: maps };
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
      // The app-enforced restrictions: plain booleans, each absent key keeping its default.
      for (const k of [...APP_ALLOW_KEYS, ...APP_REQUIRE_KEYS]) {
        const v = a[k];
        if (v === undefined) continue;
        if (typeof v === 'boolean') appBlock[k] = v;
        else problems.push(`app.${k} must be a boolean`);
      }
      out.app = appBlock;
    }
  }
  if (raw.dev !== undefined) {
    if (!raw.dev || typeof raw.dev !== 'object' || Array.isArray(raw.dev)) problems.push('dev must be an object');
    else {
      const d = raw.dev as Record<string, unknown>;
      const devBlock: NonNullable<PolicyFile['dev']> = {};
      for (const k of ['allow', 'devTools'] as const) {
        const v = d[k];
        if (v === undefined) continue;
        if (typeof v === 'boolean') devBlock[k] = v;
        else problems.push(`dev.${k} must be a boolean`);
      }
      out.dev = devBlock;
    }
  }
  if (raw.remote !== undefined) {
    const remote = parseRemote(raw.remote, problems);
    if (remote) out.remote = remote;
  }
  if (raw.packs !== undefined) {
    const packs = parsePacks(raw.packs, problems);
    if (packs) out.packs = packs;
  }
  if (raw.lock !== undefined) {
    const lock = parseLock(raw.lock, problems);
    if (lock) out.lock = lock;
  }
  if (raw.guard !== undefined) {
    const guard = parseGuard(raw.guard, problems);
    if (guard) out.guard = guard;
    const listed = (out.app?.users?.length ?? 0) > 0;
    if (guard && guard.mode !== undefined && guard.mode !== 'off' && !listed) problems.push('guard.mode needs app.users: the guard confines the listed users\' sessions');
  }
  if (problems.length > 0) throw new RpError('INVALID_ARGUMENT', `Invalid policy file:\n${problems.join('\n')}`, { problems });
  return out;
}

/**
 * A URL a policy may point the app at: `https://` anywhere, or `http://` on the loopback, which is
 * how an on-box management agent and the tests serve one. Mirrors `validate_url` in the daemon's
 * `remote.rs` — both sides must agree or a policy the app accepts would be refused on write.
 */
export function parsePolicyUrl(value: unknown, what: string, problems: string[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    problems.push(`${what} must be a URL`);
    return undefined;
  }
  if (/[\s"\\]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    problems.push(`${what} must not contain spaces, quotes or control characters`);
    return undefined;
  }
  if (/^https:\/\/./i.test(value)) return value;
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(value);
  if (loopback) return value;
  problems.push(`${what} must be an https:// URL (plain http is only allowed on 127.0.0.1)`);
  return undefined;
}

/** The `remote` block, mirroring `validate_remote` in the daemon. */
export function parseRemote(raw: unknown, problems: string[]): RemotePolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('remote must be an object');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const url = parsePolicyUrl(r.url, 'remote.url', problems);
  if (url === undefined) return undefined;
  const out: RemotePolicy = { url };
  if (r.enabled !== undefined) {
    if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
    else problems.push('remote.enabled must be a boolean');
  }
  if (r.intervalMinutes !== undefined) {
    if (isNumber(r.intervalMinutes) && r.intervalMinutes >= 5 && r.intervalMinutes <= 1440) out.intervalMinutes = Math.round(r.intervalMinutes);
    else problems.push('remote.intervalMinutes must be a number between 5 and 1440');
  }
  return out;
}

/** The `packs` block, mirroring `validate_packs` in the daemon. */
export function parsePacks(raw: unknown, problems: string[]): PacksPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('packs must be an object');
    return undefined;
  }
  const p = raw as Record<string, unknown>;
  const out: PacksPolicy = {};
  if (p.sources !== undefined) {
    if (!Array.isArray(p.sources) || p.sources.length > 64) {
      problems.push('packs.sources must be an array of at most 64 entries');
    } else {
      const sources: PackSource[] = [];
      const seen = new Set<string>();
      for (const entry of p.sources) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          problems.push('packs.sources entries must be objects');
          continue;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!/^[a-z0-9._-]{1,64}$/.test(id)) {
          problems.push(`packs.sources[].id must be a pack id (lower-case letters, digits, -, . and _); got ${JSON.stringify(e.id)}`);
          continue;
        }
        if (seen.has(id)) {
          problems.push(`packs.sources lists "${id}" twice`);
          continue;
        }
        seen.add(id);
        const url = parsePolicyUrl(e.url, `packs.sources[${id}].url`, problems);
        if (url === undefined) continue;
        const source: PackSource = { id, url };
        if (e.sha256 !== undefined) {
          if (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(e.sha256)) source.sha256 = e.sha256.toLowerCase();
          else problems.push(`packs.sources[${id}].sha256 must be 64 hex characters`);
        }
        if (e.signature !== undefined) {
          // 64 raw bytes of Ed25519, base64: 88 characters with the padding.
          if (typeof e.signature === 'string' && /^[A-Za-z0-9+/_-]{86,88}={0,2}$/.test(e.signature)) source.signature = e.signature;
          else problems.push(`packs.sources[${id}].signature must be a base64 Ed25519 signature`);
        }
        if (e.version !== undefined) {
          if (typeof e.version === 'string' && e.version.length > 0 && e.version.length <= 64) source.version = e.version;
          else problems.push(`packs.sources[${id}].version must be 1..64 characters`);
        }
        sources.push(source);
      }
      out.sources = sources;
    }
  }
  if (p.removeUnlisted !== undefined) {
    if (typeof p.removeUnlisted === 'boolean') out.removeUnlisted = p.removeUnlisted;
    else problems.push('packs.removeUnlisted must be a boolean');
  }
  if (p.refreshMinutes !== undefined) {
    if (isNumber(p.refreshMinutes) && p.refreshMinutes >= 5 && p.refreshMinutes <= 1440) out.refreshMinutes = Math.round(p.refreshMinutes);
    else problems.push('packs.refreshMinutes must be a number between 5 and 1440');
  }
  return out;
}

/** The `lock` block, mirroring `validate_lock` in the daemon. The secret never appears here. */
export function parseLock(raw: unknown, problems: string[]): PolicyLock | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('lock must be an object');
    return undefined;
  }
  const l = raw as Record<string, unknown>;
  const out: PolicyLock = {};
  if (l.algorithm !== undefined) {
    if (l.algorithm === 'SHA1' || l.algorithm === 'SHA256' || l.algorithm === 'SHA512') out.algorithm = l.algorithm;
    else problems.push('lock.algorithm must be SHA1, SHA256 or SHA512');
  }
  if (l.digits !== undefined) {
    if (isNumber(l.digits) && l.digits >= 6 && l.digits <= 8) out.digits = Math.round(l.digits);
    else problems.push('lock.digits must be 6, 7 or 8');
  }
  if (l.period !== undefined) {
    if (isNumber(l.period) && l.period >= 15 && l.period <= 300) out.period = Math.round(l.period);
    else problems.push('lock.period must be between 15 and 300 seconds');
  }
  if (l.window !== undefined) {
    if (isNumber(l.window) && l.window >= 0 && l.window <= 10) out.window = Math.round(l.window);
    else problems.push('lock.window must be between 0 and 10');
  }
  for (const k of ['selfHeal', 'immutable', 'refuseManualStop', 'denyEscapes'] as const) {
    if (l[k] === undefined) continue;
    if (typeof l[k] === 'boolean') out[k] = l[k] as boolean;
    else problems.push(`lock.${k} must be a boolean`);
  }
  return out;
}

/** Path lists in the guard block: absolute (or `~/`, `@{HOME}/` where allowed), no whitespace or quotes — they become AppArmor rules verbatim. */
function guardPathList(v: unknown, what: string, allowHome: boolean, problems: string[]): string[] | undefined {
  const list = stringList(v, what, problems);
  if (!list) return undefined;
  for (const p of list) {
    const okPrefix = p.startsWith('/') || (allowHome && (p.startsWith('~/') || p.startsWith('@{HOME}/')));
    if (p.length === 0 || !okPrefix || /[\s"\\]/.test(p) || p.length > 1024) {
      problems.push(`${what} entries must be absolute paths${allowHome ? ' (or start with ~/ or @{HOME}/)' : ''} without spaces or quotes (got "${p}")`);
      return undefined;
    }
  }
  return list;
}

/** The `guard` block, mirroring the daemon's `GuardPolicy` validation (`native/rpchatd/src/policy.rs`). */
export function parseGuard(raw: unknown, problems: string[]): GuardPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('guard must be an object');
    return undefined;
  }
  const g = raw as Record<string, unknown>;
  const out: GuardPolicy = {};
  if (g.mode !== undefined) {
    if (typeof g.mode === 'string' && (GUARD_MODES as readonly string[]).includes(g.mode)) out.mode = g.mode as GuardPolicy['mode'];
    else problems.push('guard.mode must be off, audit or enforce');
  }
  for (const k of ['protectApp', 'wallpaper'] as const) {
    if (g[k] === undefined) continue;
    if (typeof g[k] === 'boolean') out[k] = g[k] as boolean;
    else problems.push(`guard.${k} must be a boolean`);
  }
  if (g.compositorIpc !== undefined) {
    if (typeof g.compositorIpc === 'string' && (GUARD_COMPOSITOR_IPC as readonly string[]).includes(g.compositorIpc)) out.compositorIpc = g.compositorIpc as GuardPolicy['compositorIpc'];
    else problems.push('guard.compositorIpc must be allow, shell-only or deny');
  }
  if (g.shell !== undefined) {
    // One name or a list of them; the daemon guards every row it is given.
    const named = (v: unknown): v is GuardShell => typeof v === 'string' && (GUARD_SHELLS as readonly string[]).includes(v);
    if (named(g.shell)) out.shell = g.shell;
    else if (Array.isArray(g.shell) && g.shell.length > 0 && g.shell.every(named)) out.shell = [...g.shell];
    else problems.push('guard.shell must be auto, noctalia, quickshell, hyprpaper, swww or none (or a non-empty list of them)');
  }
  const helpers = guardPathList(g.loginHelpers, 'guard.loginHelpers', false, problems);
  if (helpers) {
    if (helpers.length === 0) problems.push('guard.loginHelpers must not be empty (omit it to auto-detect)');
    else out.loginHelpers = helpers;
  }
  const denyPaths = guardPathList(g.extraDenyPaths, 'guard.extraDenyPaths', true, problems);
  if (denyPaths) out.extraDenyPaths = denyPaths;
  const denySockets = guardPathList(g.extraDenySockets, 'guard.extraDenySockets', true, problems);
  if (denySockets) out.extraDenySockets = denySockets;
  const allow = guardPathList(g.allowBinaries, 'guard.allowBinaries', false, problems);
  if (allow) out.allowBinaries = allow;
  return out;
}

/** Pure: the effective guard mode of a policy (`off` without a file or a `guard` block). */
export function guardMode(policy: PolicyFile | null | undefined): NonNullable<GuardPolicy['mode']> {
  return policy?.guard?.mode ?? 'off';
}

/** Pure: the effective restrictions — every key the policy does not mention keeps its permissive default. */
export function appRestrictions(policy: PolicyFile | null | undefined): AppRestrictions {
  const a = policy?.app;
  const out: AppRestrictions = { ...DEFAULT_APP_RESTRICTIONS };
  if (!a) return out;
  for (const k of [...APP_ALLOW_KEYS, ...APP_REQUIRE_KEYS]) {
    const v = a[k];
    if (typeof v === 'boolean') out[k] = v;
  }
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
  for (const m of Object.keys(s.permissions?.functionAllow ?? {})) out.add(`permissions.functionAllow.${m}`);
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
  if (s.permissions?.functionAllow) {
    // A function entry beats its module's, so a module the policy pins would otherwise be undone by
    // a stored `<module>.<function>` key. Pinning a module takes its functions with it.
    const pinned = s.permissions.functionAllow;
    const kept: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(settings.permissions.functionAllow)) {
      const { module, method } = parseFunctionKey(key);
      if (method !== undefined && pinned[module] !== undefined) continue;
      kept[key] = value;
    }
    next.permissions = { ...settings.permissions, functionAllow: { ...kept, ...pinned } };
  }
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

/** Where the policy the app is enforcing came from. */
export type PolicySource =
  /** `/run/rpchat/policy/policy.json`: the daemon's own filesystem, republished on every tick. */
  | 'runtime'
  /** `/etc/rpchat/policy.json`. */
  | 'file'
  /** `/etc/rpchat/policy.sealed`: the seal's world-readable copy, when the policy file is gone. */
  | 'seal'
  /** The app's own memory of a sealed policy, because nothing on the machine had one. */
  | 'cache'
  | 'none';

export interface PolicyState {
  present: boolean;
  path: string;
  policy: PolicyFile | null;
  managed: ManagedSettingsPaths;
  /** `appPolicy(policy)`: defaults (quit allowed, nobody listed) without a file or with a broken one. */
  app: AppPolicy;
  /** `appRestrictions(policy)`: what the app refuses on the IPC boundary; permissive defaults without a file. */
  restrictions: AppRestrictions;
  managedBy?: string;
  /** Which of the four places this came from. */
  source: PolicySource;
  /** SHA-256 of the policy, as the daemon and the seal compute it. */
  policyHash?: string;
  /** The machine is sealed as far as the app can tell (a marker, or its own memory of one). */
  sealed: boolean;
  /** The policy came from the app's own cache: nothing on the machine had one. */
  fromCache: boolean;
  error?: string;
}

/** The places `loadPolicy` looks, in order. Overridable so the tests need no root-owned paths. */
export interface PolicySources {
  /** `/etc/rpchat/policy.json`. */
  file?: string;
  /** `/run/rpchat/policy/policy.json`, the daemon's runtime filesystem. */
  runtime?: string;
  /** `/etc/rpchat/policy.sealed`, the seal's world-readable copy. */
  marker?: string;
  /** The app's own memory of a sealed policy (`seal-cache.ts`). */
  cache?: SealCache;
}

function emptyState(path: string, extra: Partial<PolicyState> = {}): PolicyState {
  return {
    present: false,
    path,
    policy: null,
    managed: [],
    app: appPolicy(null),
    restrictions: appRestrictions(null),
    source: 'none',
    sealed: false,
    fromCache: false,
    ...extra,
  };
}

function stateFrom(policy: PolicyFile, path: string, source: PolicySource, sealed: boolean): PolicyState {
  const state: PolicyState = {
    present: true,
    path,
    policy,
    managed: managedPaths(policy),
    app: appPolicy(policy),
    restrictions: appRestrictions(policy),
    source,
    policyHash: policyHash(policy),
    sealed,
    fromCache: source === 'cache',
  };
  if (policy.managedBy) state.managedBy = policy.managedBy;
  return state;
}

async function readJson(path: string): Promise<{ value: unknown } | { missing: true } | { error: string }> {
  try {
    return { value: JSON.parse(await fs.readFile(path, 'utf8')) as unknown };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { error: `cannot read ${path}: ${(err as Error).message}` };
  }
}

/**
 * Read and validate the policy the app is to enforce.
 *
 * The order matters and is the whole point of the runtime filesystem (docs/spec/system.md
 * "Sealing the policy"):
 *
 * 1. **The daemon's runtime filesystem.** On a sealed machine this is the only copy that counts —
 *    the daemon publishes it from the seal and republishes it whenever it drifts, so an edit to
 *    the file on disk changes nothing here.
 * 2. **The policy file**, exactly as before, for the machines that have no daemon or no seal.
 * 3. **The seal's world-readable marker**, when the policy file has been removed but the seal has
 *    not: the machine is still managed, and the sealed policy says how.
 * 4. **The app's own cache**, when none of the above is there but the app has seen a seal before.
 *    A wiped `/etc/rpchat` is treated as tampering, not as freedom.
 *
 * Missing everywhere → `policy: null`, no error, which is the unmanaged machine most people have.
 */
export async function loadPolicy(path: string = POLICY_FILE_PATH, sources: PolicySources = {}): Promise<PolicyState> {
  const runtimePath = sources.runtime ?? RUNTIME_POLICY_FILE;
  const markerPath = sources.marker ?? SEAL_MARKER_PATH;

  const runtime = await readJson(runtimePath);
  if ('value' in runtime) {
    try {
      const policy = parsePolicy(runtime.value);
      const marker = await readJson(markerPath);
      return stateFrom(policy, runtimePath, 'runtime', 'value' in marker);
    } catch (err) {
      // A runtime copy that does not parse is the daemon's problem, not a reason to fall back to
      // a file the daemon may be refusing to honour: report it and keep looking.
      return emptyState(runtimePath, { present: true, error: `${runtimePath}: ${(err as Error).message}` });
    }
  }

  const file = await readJson(path);
  if ('error' in file) return emptyState(path, { present: true, error: file.error });
  if ('value' in file) {
    try {
      const policy = parsePolicy(file.value);
      const marker = await readJson(markerPath);
      return stateFrom(policy, path, 'file', 'value' in marker);
    } catch (err) {
      return emptyState(path, { present: true, error: (err as Error).message });
    }
  }

  // The policy file is gone. The seal's marker still says what this machine enforces.
  const marker = await readJson(markerPath);
  if ('value' in marker) {
    const sealed = marker.value as { policy?: unknown };
    try {
      const policy = parsePolicy(sealed.policy);
      return stateFrom(policy, markerPath, 'seal', true);
    } catch (err) {
      return emptyState(markerPath, { present: true, sealed: true, error: `${markerPath}: ${(err as Error).message}` });
    }
  }

  const cached = await sources.cache?.read();
  if (cached) {
    try {
      return stateFrom(parsePolicy(cached.policy), sources.cache!.path, 'cache', true);
    } catch (err) {
      return emptyState(path, { sealed: true, error: `the cached sealed policy is invalid: ${(err as Error).message}` });
    }
  }
  return emptyState(path);
}

/** Caches the parsed policy and re-reads it when the file's mtime (or existence) changes. */
export class PolicyWatcher {
  private state: PolicyState | undefined;
  private stamp: string | undefined;
  private inflight: Promise<PolicyState> | undefined;
  private readonly sources: PolicySources;

  constructor(
    readonly path: string = POLICY_FILE_PATH,
    private readonly logger?: Pick<Console, 'info' | 'warn'>,
    sources: PolicySources = {},
  ) {
    this.sources = sources;
  }

  /** Every file `current()` may read, in the order `loadPolicy` tries them. */
  private watchedPaths(): string[] {
    return [this.sources.runtime ?? RUNTIME_POLICY_FILE, this.path, this.sources.marker ?? SEAL_MARKER_PATH];
  }

  /** Drop the cache so the next `current()` re-reads the file whatever its mtime (e.g. right after creating it). */
  invalidate(): void {
    this.state = undefined;
    this.stamp = undefined;
  }

  async current(): Promise<PolicyState> {
    // The stamp covers every source: the runtime copy changes without the file changing, and a
    // removed file is itself a change worth re-reading for.
    const stamps = await Promise.all(
      this.watchedPaths().map(async (p) => {
        try {
          const st = await fs.stat(p);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return 'missing';
        }
      }),
    );
    const stamp = stamps.join('|');
    if (this.state && stamp === this.stamp) return this.state;
    if (this.inflight) return this.inflight;
    this.inflight = loadPolicy(this.path, this.sources)
      .then((state) => {
        const changed = this.stamp !== undefined && this.stamp !== stamp;
        this.state = state;
        this.stamp = stamp;
        if (state.error) this.logger?.warn?.(`[policy] ${state.error}`);
        else if (state.present && state.source !== 'file') {
          const from = state.source === 'runtime' ? `the daemon's runtime filesystem (${state.path})` : state.source === 'seal' ? `the policy seal (${state.path})` : `the app's cached copy of the sealed policy (${state.path})`;
          this.logger?.info?.(`[policy] ${changed ? 'reloaded' : 'loaded'} from ${from}: ${state.managed.length} managed setting(s)${state.managedBy ? ` (managed by ${state.managedBy})` : ''}`);
        } else if (state.present) {
          const restricted = activeRestrictions(state.restrictions);
          this.logger?.info?.(`[policy] ${changed ? 'reloaded' : 'loaded'} ${this.path}: ${state.managed.length} managed setting(s)${state.app.allowQuit ? '' : `, quitting disabled for ${state.app.users.length > 0 ? state.app.users.join(', ') : 'nobody (app.users is empty)'}`}${restricted.length > 0 ? `, restrictions: ${restricted.join(', ')}` : ''}${state.managedBy ? ` (managed by ${state.managedBy})` : ''}`);
        }
        return state;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
