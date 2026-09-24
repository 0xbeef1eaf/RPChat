/**
 * The Settings → System "Create policy" form: a draft of the root-owned policy file, the table of
 * settings keys it can force, and the checks `parsePolicy` would otherwise only report after the
 * file was written (it is write-once, so the form has to catch them first).
 *
 * A settings key that is absent from the file is left to each user, so every forcible key carries
 * its own switch (`forced`) next to the value that would be written (`values`). The `app`,
 * `inputLock` and `guard` blocks have meaningful defaults of their own and are always written.
 */
import type { AppRestrictions, DevRules, GuardCompositorIpc, GuardMode, GuardShell, PackSource, PolicyFile } from '@rp/shared';
import { DEFAULT_APP_RESTRICTIONS, DEFAULT_DEV_RULES, UNLIMITED } from '@rp/shared';

export type PolicyValue = number | boolean | string | string[] | Record<string, boolean>;
export type PolicyEmergencyKey = NonNullable<NonNullable<PolicyFile['inputLock']>['emergencyKey']>;

/** Which control the Forced settings tab renders for a key. */
export type PolicySettingKind = 'number' | 'duration' | 'boolean' | 'list' | 'functions' | 'choice';

export interface PolicySettingSpec {
  /** Dotted path under `settings` in the policy file, e.g. `autonomy.minDelayMs`. */
  path: string;
  group: PolicyGroupId;
  label: string;
  hint: string;
  kind: PolicySettingKind;
  /** Written when the key is switched on but the seed policy had no value for it. */
  fallback: PolicyValue;
  /** `number`/`duration`: the smallest value `parsePolicy` accepts. */
  min?: number;
  /** `number`/`duration`: `-1` (`UNLIMITED`) is accepted as well, for no cap (or no floor). */
  unlimited?: boolean;
  /** `choice`: the accepted values. */
  choices?: readonly string[];
  /** `list`: placeholder for the add field. */
  placeholder?: string;
}

export type PolicyGroupId = 'autonomy' | 'access' | 'memory' | 'senses' | 'browser' | 'updates' | 'display' | 'media';

export const POLICY_GROUPS: ReadonlyArray<{ id: PolicyGroupId; title: string; hint: string }> = [
  { id: 'access', title: 'What characters may reach', hint: 'The allowlists and capability switches every character on this machine is held to.' },
  { id: 'autonomy', title: 'Autonomy limits', hint: 'How much a character may act on its own, so one cannot run away with the session.' },
  { id: 'memory', title: 'Memory', hint: 'What characters remember between conversations and how much of it reaches the prompt.' },
  { id: 'senses', title: 'Senses', hint: 'What the app may watch and read from the desktop around it.' },
  { id: 'browser', title: 'Browser', hint: 'What a character with the browser capability may do in the user’s browser.' },
  { id: 'updates', title: 'Updates', hint: 'Whether this machine updates itself, and who decides.' },
  { id: 'display', title: 'Display', hint: 'How characters are drawn on screen.' },
  { id: 'media', title: 'Media on screen', hint: 'How many images, videos and sounds a character may have running at once, and how many more may wait their turn. 0 or -1 items at once means no limit; 0 waiting means a call over the limit is refused instead of queued.' },
];

/**
 * Every settings key a policy file may force, in the order the form shows them. The paths mirror
 * `parsePolicy`'s accepted keys exactly: anything missing here cannot be forced at all.
 */
export const POLICY_SETTINGS: readonly PolicySettingSpec[] = [
  { path: 'permissions.functionAllow', group: 'access', kind: 'functions', label: 'SDK functions', hint: 'Pin which SDK functions every character may call, whole modules or one function at a time. Anything left off the list stays the user’s choice.', fallback: {} },
  { path: 'web.allowlist', group: 'access', kind: 'list', label: 'Web allowlist', hint: 'Hosts sdk.web may fetch. An empty list allows nothing.', fallback: [], placeholder: 'example.com' },
  { path: 'desktop.launchAllowlist', group: 'access', kind: 'list', label: 'Launchable apps', hint: 'Programs sdk.desktop.launch may start. An empty list allows nothing.', fallback: [], placeholder: 'firefox' },
  { path: 'maxInputLockMs', group: 'access', kind: 'duration', label: 'Longest input lock', hint: 'The cap the app offers for sdk.input.lock. The daemon’s own limit applies on top. -1 = no app-side cap.', fallback: 300_000, min: 1000, unlimited: true },

  { path: 'autonomy.maxSelfWakesPerHour', group: 'autonomy', kind: 'number', label: 'Self-wakes per hour', hint: 'Self-triggered turns a session may take in an hour. -1 = unlimited.', fallback: 30, min: 0, unlimited: true },
  { path: 'autonomy.maxConsecutiveSelfWakes', group: 'autonomy', kind: 'number', label: 'Consecutive self-wakes', hint: 'Self-triggered turns in a row without a word from the user. -1 = unlimited.', fallback: 10, min: 0, unlimited: true },
  { path: 'autonomy.maxTimersPerSession', group: 'autonomy', kind: 'number', label: 'Timers per session', hint: 'Pending timers one session may hold at once. -1 = unlimited.', fallback: 20, min: 0, unlimited: true },
  { path: 'autonomy.minRepeatIntervalMs', group: 'autonomy', kind: 'duration', label: 'Shortest repeat interval', hint: 'Floor for repeating timers. -1 = no floor.', fallback: 60_000, min: 0, unlimited: true },
  { path: 'autonomy.minDelayMs', group: 'autonomy', kind: 'duration', label: 'Shortest timer delay', hint: 'Floor for a scheduled turn; shorter delays are raised to it rather than refused. -1 = no floor.', fallback: 30_000, min: 0, unlimited: true },

  { path: 'memory.enabled', group: 'memory', kind: 'boolean', label: 'Remember across conversations', hint: 'Off stops characters forming long-term memories at all.', fallback: true },
  { path: 'memory.consolidateEveryTurns', group: 'memory', kind: 'number', label: 'Consolidate every', hint: 'Turns between memory extraction passes.', fallback: 8, min: 0 },
  { path: 'memory.maxEntriesPerCharacter', group: 'memory', kind: 'number', label: 'Memories per character', hint: 'How many entries one character keeps. -1 = unlimited.', fallback: 300, min: 0, unlimited: true },
  { path: 'memory.promptBudgetTokens', group: 'memory', kind: 'number', label: 'Memory prompt budget', hint: 'Tokens of remembered material allowed into a prompt. -1 = unlimited.', fallback: 600, min: 0, unlimited: true },

  { path: 'senses.includeInPrompt', group: 'senses', kind: 'boolean', label: 'Presence line in prompts', hint: 'Off keeps idle time, the active window and now-playing out of every prompt.', fallback: true },
  { path: 'senses.watchDirs', group: 'senses', kind: 'list', label: 'Watched directories', hint: 'Folders that raise file-added events. An empty list watches nothing.', fallback: [], placeholder: '~/Downloads' },
  { path: 'senses.calendarSources', group: 'senses', kind: 'list', label: 'Calendar sources', hint: 'ICS files or URLs sdk.calendar may read.', fallback: [], placeholder: 'https://example.com/cal.ics' },

  { path: 'browser.allowBlocking', group: 'browser', kind: 'boolean', label: 'Block pages', hint: 'sdk.browser.block may keep a page shut for a while.', fallback: true },
  { path: 'browser.allowEval', group: 'browser', kind: 'boolean', label: 'Run JavaScript in pages', hint: 'sdk.browser.eval runs code in the open tab.', fallback: true },
  { path: 'browser.allowHistory', group: 'browser', kind: 'boolean', label: 'Read browsing history', hint: 'sdk.browser.history reads what the user visited.', fallback: true },

  { path: 'updates.enabled', group: 'updates', kind: 'boolean', label: 'Update checks', hint: 'Off switches updating off entirely — no check, no download, no install.', fallback: true },
  { path: 'updates.automatic', group: 'updates', kind: 'boolean', label: 'Check in the background', hint: 'Pins the background-check switch users see in Settings → Updates.', fallback: true },
  { path: 'updates.allowDowngrade', group: 'updates', kind: 'boolean', label: 'Allow downgrades', hint: 'Lets the daemon install a version older than the one on the system. Refused unless this is on.', fallback: false },

  { path: 'displayBackend', group: 'display', kind: 'choice', label: 'Display backend', hint: 'How character windows are drawn.', fallback: 'auto', choices: ['auto', 'electron', 'hyprland'] },

  { path: 'media.maxConcurrent.image', group: 'media', kind: 'number', label: 'Images at once', hint: 'Images sdk.media may have on screen together. 0 or -1 = no limit.', fallback: 3, min: 0, unlimited: true },
  { path: 'media.maxConcurrent.video', group: 'media', kind: 'number', label: 'Videos at once', hint: 'Videos playing together, whether in a window or washed over the screen. 0 or -1 = no limit.', fallback: 1, min: 0, unlimited: true },
  { path: 'media.maxConcurrent.audio', group: 'media', kind: 'number', label: 'Sounds at once', hint: 'Audio tracks playing together. 0 or -1 = no limit.', fallback: 2, min: 0, unlimited: true },
  { path: 'media.maxQueued.image', group: 'media', kind: 'number', label: 'Images waiting', hint: 'Images that may queue behind the limit above. 0 refuses the call instead of queueing it; -1 = unlimited.', fallback: 8, min: 0, unlimited: true },
  { path: 'media.maxQueued.video', group: 'media', kind: 'number', label: 'Videos waiting', hint: 'Videos that may queue behind the limit above. 0 refuses the call instead of queueing it; -1 = unlimited.', fallback: 8, min: 0, unlimited: true },
  { path: 'media.maxQueued.audio', group: 'media', kind: 'number', label: 'Sounds waiting', hint: 'Audio tracks that may queue behind the limit above. 0 refuses the call instead of queueing it; -1 = unlimited.', fallback: 8, min: 0, unlimited: true },
];

/** The `app` restrictions, phrased as the switches the form shows (on = the app may do it). */
export const POLICY_RESTRICTIONS: ReadonlyArray<{ key: keyof AppRestrictions; label: string; hint: string }> = [
  { key: 'allowPackEditor', label: 'Pack editor', hint: 'Open the editor and author packs. Off hides the tab and refuses the whole editor:* namespace.' },
  { key: 'allowPackInstall', label: 'Install packs', hint: 'Add, replace or rewrite packs in the store. Off freezes what is installed.' },
  { key: 'allowPackRemove', label: 'Remove packs', hint: 'Uninstall a pack.' },
  { key: 'allowSandbox', label: 'Sandbox', hint: 'Run code by hand in the Sandbox tab. Off hides the tab.' },
  { key: 'allowStopGeneration', label: 'Stop a reply', hint: 'Cut a reply short while it is being written. Off also blocks retrying, resetting or editing the history while one is running, since those stop it too.' },
  { key: 'allowDeleteSession', label: 'Delete conversations', hint: 'Remove a whole conversation.' },
  { key: 'allowDeleteHistory', label: 'Delete chat history', hint: 'Clear a conversation or remove single messages from it.' },
  { key: 'allowDeleteMemories', label: 'Delete memories', hint: 'Remove what a character remembers.' },
  { key: 'allowRemoveEvents', label: 'Remove event handlers', hint: 'Unsubscribe a character’s handlers by hand.' },
  { key: 'allowCloseMedia', label: 'Close media', hint: 'Sweep a character’s open overlays off the screen by hand. Off hides the button; the character’s own scripts still close their media.' },
  { key: 'requireCharacterSession', label: 'Always keep a conversation open', hint: 'The app opens a session with a character and offers no way to sit on an empty chat. This one adds a rule rather than removing one, so it reads the other way round.' },
];

/** The `dev` block, phrased the same way round as the restrictions: on = the app may do it. */
export const POLICY_DEV: ReadonlyArray<{ key: keyof DevRules; label: string; hint: string }> = [
  {
    key: 'allow',
    label: 'Development switches',
    hint: 'The RP_* environment overrides — the mock model, the smoke runs, the example pack and plugin, and the user-data, policy-file, daemon-socket and overlay-helper paths — plus loading the interface from a dev server. Off also refuses a launch that asks for a debugger.',
  },
  { key: 'devTools', label: 'DevTools', hint: 'Open the inspector in the app’s windows. Follows the switch above unless you set it here.' },
];

export const POLICY_EMERGENCY_KEYS: readonly PolicyEmergencyKey[] = ['esc', 'f1', 'f12', 'pause'];

/** Guard shells that stand alone: picking one clears the rest, and picking any other clears it. */
export const EXCLUSIVE_GUARD_SHELLS: readonly GuardShell[] = ['auto', 'none'];

/** The `remote`, `packs` and `lock` blocks as the form holds them. */
export interface PolicyRemoteDraft {
  /** Off leaves the whole `remote` block out of the file. */
  enabled: boolean;
  url: string;
  intervalMinutes: number;
}

export interface PolicyPacksDraft {
  sources: PackSource[];
  removeUnlisted: boolean;
  refreshMinutes: number;
}

export interface PolicyLockDraft {
  /** Off leaves the `lock` block out; sealing the machine adds one with these defaults anyway. */
  enabled: boolean;
  digits: number;
  period: number;
  selfHeal: boolean;
  immutable: boolean;
  refuseManualStop: boolean;
  denyEscapes: boolean;
}

export interface PolicyDraft {
  managedBy: string;
  /** Dotted path under `settings` → whether the policy forces it. */
  forced: Record<string, boolean>;
  /** Dotted path under `settings` → the value written when it is forced. */
  values: Record<string, PolicyValue>;
  inputLock: { enabled: boolean; maxDurationMs: number; emergencyKey: PolicyEmergencyKey; emergencyHoldMs: number };
  app: { allowQuit: boolean; users: string[]; restrictions: AppRestrictions };
  dev: DevRules;
  guard: {
    mode: GuardMode;
    protectApp: boolean;
    wallpaper: boolean;
    compositorIpc: GuardCompositorIpc;
    shell: GuardShell[];
    loginHelpers: string[];
    extraDenyPaths: string[];
    extraDenySockets: string[];
    allowBinaries: string[];
  };
  remote: PolicyRemoteDraft;
  packs: PolicyPacksDraft;
  lock: PolicyLockDraft;
}

/** What the form starts from when the policy has no `remote`/`packs`/`lock` block. */
export const DEFAULT_REMOTE_DRAFT: PolicyRemoteDraft = { enabled: false, url: '', intervalMinutes: 60 };
export const DEFAULT_PACKS_DRAFT: PolicyPacksDraft = { sources: [], removeUnlisted: false, refreshMinutes: 360 };
export const DEFAULT_LOCK_DRAFT: PolicyLockDraft = { enabled: false, digits: 6, period: 30, selfHeal: true, immutable: true, refuseManualStop: true, denyEscapes: true };

function valueAt(settings: PolicyFile['settings'], path: string): PolicyValue | undefined {
  let node: unknown = settings;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node === undefined ? undefined : (node as PolicyValue);
}

function assignAt(target: Record<string, unknown>, path: string, value: PolicyValue): void {
  const keys = path.split('.');
  const leaf = keys.pop() as string;
  let node = target;
  for (const key of keys) {
    const next = node[key];
    node = (next && typeof next === 'object' ? next : (node[key] = {})) as Record<string, unknown>;
  }
  node[leaf] = value;
}

/** Copied so the draft never shares a list or map with the policy it was seeded from. */
function copyValue(value: PolicyValue): PolicyValue {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

/** A draft seeded from a policy file — the template from the daemon, or one the user pasted in. */
export function policyDraftFrom(policy: PolicyFile): PolicyDraft {
  const forced: Record<string, boolean> = {};
  const values: Record<string, PolicyValue> = {};
  for (const spec of POLICY_SETTINGS) {
    const seeded = valueAt(policy.settings, spec.path);
    forced[spec.path] = seeded !== undefined;
    values[spec.path] = copyValue(seeded ?? spec.fallback);
  }
  const restrictions = { ...DEFAULT_APP_RESTRICTIONS };
  for (const { key } of POLICY_RESTRICTIONS) {
    const v = policy.app?.[key];
    if (typeof v === 'boolean') restrictions[key] = v;
  }
  const dev: DevRules = { ...DEFAULT_DEV_RULES };
  if (typeof policy.dev?.allow === 'boolean') dev.allow = policy.dev.allow;
  // The file's `devTools` follows `allow` when it is absent, exactly as the guard reads it.
  dev.devTools = typeof policy.dev?.devTools === 'boolean' ? policy.dev.devTools : dev.allow;
  const shell = policy.guard?.shell;
  return {
    managedBy: policy.managedBy ?? '',
    forced,
    values,
    inputLock: {
      enabled: policy.inputLock?.enabled !== false,
      maxDurationMs: policy.inputLock?.maxDurationMs ?? 300_000,
      emergencyKey: policy.inputLock?.emergencyKey ?? 'esc',
      emergencyHoldMs: policy.inputLock?.emergencyHoldMs ?? 5000,
    },
    app: { allowQuit: policy.app?.allowQuit !== false, users: [...(policy.app?.users ?? [])], restrictions },
    dev,
    guard: {
      mode: policy.guard?.mode ?? 'off',
      protectApp: policy.guard?.protectApp !== false,
      wallpaper: policy.guard?.wallpaper !== false,
      compositorIpc: policy.guard?.compositorIpc ?? 'shell-only',
      shell: shell === undefined ? ['auto'] : Array.isArray(shell) ? [...shell] : [shell],
      loginHelpers: [...(policy.guard?.loginHelpers ?? [])],
      extraDenyPaths: [...(policy.guard?.extraDenyPaths ?? [])],
      extraDenySockets: [...(policy.guard?.extraDenySockets ?? [])],
      allowBinaries: [...(policy.guard?.allowBinaries ?? [])],
    },
    remote: {
      enabled: policy.remote !== undefined && policy.remote.enabled !== false,
      url: policy.remote?.url ?? '',
      intervalMinutes: policy.remote?.intervalMinutes ?? DEFAULT_REMOTE_DRAFT.intervalMinutes,
    },
    packs: {
      sources: (policy.packs?.sources ?? []).map((s) => ({ ...s })),
      removeUnlisted: policy.packs?.removeUnlisted === true,
      refreshMinutes: policy.packs?.refreshMinutes ?? DEFAULT_PACKS_DRAFT.refreshMinutes,
    },
    lock: {
      enabled: policy.lock !== undefined,
      digits: policy.lock?.digits ?? DEFAULT_LOCK_DRAFT.digits,
      period: policy.lock?.period ?? DEFAULT_LOCK_DRAFT.period,
      selfHeal: policy.lock?.selfHeal !== false,
      immutable: policy.lock?.immutable !== false,
      refuseManualStop: policy.lock?.refuseManualStop !== false,
      denyEscapes: policy.lock?.denyEscapes !== false,
    },
  };
}

/**
 * The file the form would write. Keys left switched off are omitted entirely — that is what leaves
 * them to the user — as are the lists `parsePolicy` refuses when empty: `app.users`, which must
 * name at least one user, and `guard.loginHelpers`, whose absence means "detect them".
 */
export function policyDraftToFile(draft: PolicyDraft): PolicyFile {
  const out: PolicyFile = { version: 1 };
  const managedBy = draft.managedBy.trim();
  if (managedBy) out.managedBy = managedBy;

  const settings: Record<string, unknown> = {};
  for (const spec of POLICY_SETTINGS) {
    if (!draft.forced[spec.path]) continue;
    assignAt(settings, spec.path, copyValue(draft.values[spec.path] ?? spec.fallback));
  }
  if (Object.keys(settings).length > 0) out.settings = settings as PolicyFile['settings'];

  out.inputLock = { ...draft.inputLock };
  out.app = { allowQuit: draft.app.allowQuit, ...draft.app.restrictions };
  if (draft.app.users.length > 0) out.app.users = [...draft.app.users];
  out.dev = { allow: draft.dev.allow, devTools: draft.dev.devTools };

  const guard: NonNullable<PolicyFile['guard']> = {
    mode: draft.guard.mode,
    protectApp: draft.guard.protectApp,
    wallpaper: draft.guard.wallpaper,
    compositorIpc: draft.guard.compositorIpc,
    extraDenyPaths: [...draft.guard.extraDenyPaths],
    extraDenySockets: [...draft.guard.extraDenySockets],
    allowBinaries: [...draft.guard.allowBinaries],
  };
  if (draft.guard.shell.length === 1) guard.shell = draft.guard.shell[0] as GuardShell;
  else if (draft.guard.shell.length > 1) guard.shell = [...draft.guard.shell];
  if (draft.guard.loginHelpers.length > 0) guard.loginHelpers = [...draft.guard.loginHelpers];
  out.guard = guard;

  // `remote` is written only when it is switched on and has an address: a block without one would
  // be refused, and an absent block is exactly "this machine keeps its own policy".
  if (draft.remote.enabled && draft.remote.url.trim().length > 0) {
    out.remote = { url: draft.remote.url.trim(), intervalMinutes: draft.remote.intervalMinutes };
  }
  if (draft.packs.sources.length > 0 || draft.packs.removeUnlisted) {
    out.packs = {
      sources: draft.packs.sources.map((s) => ({
        id: s.id.trim(),
        url: s.url.trim(),
        ...(s.signature ? { signature: s.signature.trim() } : {}),
        ...(s.sha256 ? { sha256: s.sha256.trim().toLowerCase() } : {}),
        ...(s.version ? { version: s.version.trim() } : {}),
      })),
      removeUnlisted: draft.packs.removeUnlisted,
      refreshMinutes: draft.packs.refreshMinutes,
    };
  }
  if (draft.lock.enabled) {
    out.lock = {
      digits: draft.lock.digits,
      period: draft.lock.period,
      selfHeal: draft.lock.selfHeal,
      immutable: draft.lock.immutable,
      refuseManualStop: draft.lock.refuseManualStop,
      denyEscapes: draft.lock.denyEscapes,
    };
  }
  return out;
}

/** Why a URL is not one a policy may point the app at (mirrors `parsePolicyUrl` in the main process). */
export function policyUrlProblem(url: string): string | null {
  const value = url.trim();
  if (value.length === 0) return 'The address is empty.';
  if (value.length > 2048) return 'The address is longer than 2048 characters.';
  if (/[\s"\\]/.test(value)) return 'An address may not contain spaces, quotes or backslashes.';
  if (/^https:\/\/./i.test(value)) return null;
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(value)) return null;
  return 'The address must be https:// (plain http is only allowed on 127.0.0.1).';
}

/** Why an entry is not a pack the daemon would accept. */
export function packSourceProblem(source: PackSource): string | null {
  if (!/^[a-z0-9._-]{1,64}$/.test(source.id.trim())) return `"${source.id}" is not a pack id (lower-case letters, digits, -, . and _).`;
  const url = policyUrlProblem(source.url);
  if (url) return `${source.id}: ${url}`;
  if (source.sha256 && !/^[0-9a-f]{64}$/i.test(source.sha256.trim())) return `${source.id}: the checksum must be 64 hex characters.`;
  if (source.signature && !/^[A-Za-z0-9+/_-]{86,88}={0,2}$/.test(source.signature.trim())) return `${source.id}: the signature must be a base64 Ed25519 signature.`;
  return null;
}

/**
 * Why a path is not one the guard can carry. The daemon writes these straight into AppArmor rules,
 * so they must be absolute (or rooted at the home directory, where that is allowed) and free of
 * whitespace and quoting.
 */
export function guardPathProblem(path: string, allowHome: boolean): string | null {
  if (path.length === 0) return 'The path is empty.';
  if (path.length > 1024) return 'The path is longer than 1024 characters.';
  if (/[\s"\\]/.test(path)) return 'A path may not contain spaces, quotes or backslashes.';
  if (path.startsWith('/')) return null;
  if (allowHome && (path.startsWith('~/') || path.startsWith('@{HOME}/'))) return null;
  return allowHome ? 'The path must be absolute or start with ~/ or @{HOME}/.' : 'The path must be absolute.';
}

/** Why a string is not a unix user name the daemon will accept in `app.users`. */
export function userNameProblem(name: string): string | null {
  if (name.trim().length === 0) return 'A user name cannot be blank.';
  if (/\s/.test(name)) return 'A user name cannot contain spaces.';
  return null;
}

/**
 * Everything that would make the daemon refuse the file, or make it do nothing. The policy is
 * write-once, so these are reported in the form rather than after the fact.
 */
export function policyDraftProblems(draft: PolicyDraft): string[] {
  const problems: string[] = [];
  for (const spec of POLICY_SETTINGS) {
    if (!draft.forced[spec.path]) continue;
    const value = draft.values[spec.path];
    if (spec.kind === 'number' || spec.kind === 'duration') {
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${spec.label} needs a number.`);
      else if (spec.min !== undefined && value < spec.min && !(spec.unlimited && value === UNLIMITED)) {
        problems.push(`${spec.label} must be at least ${spec.min >= 1000 ? `${spec.min / 1000} s` : spec.min}${spec.unlimited ? ', or -1 for unlimited' : ''}.`);
      }
    }
    if (spec.kind === 'choice' && !(spec.choices ?? []).includes(String(value))) problems.push(`${spec.label} must be one of ${(spec.choices ?? []).join(', ')}.`);
  }
  if (draft.inputLock.maxDurationMs < 1000 && draft.inputLock.maxDurationMs !== UNLIMITED) problems.push('The daemon’s input-lock limit must be at least 1 s, or -1 for unlimited.');
  if (draft.inputLock.emergencyHoldMs < 500) problems.push('The emergency-unlock hold must be at least 0.5 s.');
  for (const user of draft.app.users) {
    const problem = userNameProblem(user);
    if (problem) problems.push(problem);
  }
  if (draft.guard.mode !== 'off' && draft.app.users.length === 0) {
    problems.push('The session guard confines the sessions of the users listed under App, so it needs at least one user there.');
  }
  const lists: Array<[string, string[], boolean]> = [
    ['Login helpers', draft.guard.loginHelpers, false],
    ['Extra denied paths', draft.guard.extraDenyPaths, true],
    ['Extra denied sockets', draft.guard.extraDenySockets, true],
    ['Unconfined binaries', draft.guard.allowBinaries, false],
  ];
  for (const [what, list, allowHome] of lists) {
    for (const path of list) {
      const problem = guardPathProblem(path, allowHome);
      if (problem) problems.push(`${what}: ${problem} (${path})`);
    }
  }
  if (draft.remote.enabled) {
    const problem = policyUrlProblem(draft.remote.url);
    if (problem) problems.push(`Remote configuration: ${problem}`);
    if (draft.remote.intervalMinutes < 5 || draft.remote.intervalMinutes > 1440) problems.push('The remote check interval must be between 5 minutes and 24 hours.');
  }
  const seen = new Set<string>();
  for (const source of draft.packs.sources) {
    const problem = packSourceProblem(source);
    if (problem) problems.push(`Packs: ${problem}`);
    const id = source.id.trim();
    if (seen.has(id)) problems.push(`Packs: "${id}" is listed twice.`);
    seen.add(id);
  }
  if (draft.packs.refreshMinutes < 5 || draft.packs.refreshMinutes > 1440) problems.push('The pack refresh interval must be between 5 minutes and 24 hours.');
  if (draft.lock.enabled && (draft.lock.digits < 6 || draft.lock.digits > 8)) problems.push('A code is 6, 7 or 8 digits.');
  if (draft.lock.enabled && (draft.lock.period < 15 || draft.lock.period > 300)) problems.push('A code lasts between 15 and 300 seconds.');
  return problems;
}

/**
 * Picking a shell in the form. `auto` and `none` stand alone — they describe the whole machine —
 * so choosing one clears the named shells, and naming a shell clears them.
 */
export function toggleShell(current: GuardShell[], shell: GuardShell): GuardShell[] {
  if (current.includes(shell)) return current.filter((s) => s !== shell);
  if (EXCLUSIVE_GUARD_SHELLS.includes(shell)) return [shell];
  return [...current.filter((s) => !EXCLUSIVE_GUARD_SHELLS.includes(s)), shell];
}

/**
 * What the daemon refused a `createPolicy` for, one problem per line: its message lists them after
 * an "Invalid policy file:" first line, and is a single sentence otherwise.
 */
export function policyRefusals(message: string): string[] {
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length > 1 && /^Invalid policy file:?$/.test(lines[0] ?? '')) return lines.slice(1);
  return [message];
}

/** The host of a URL for a summary line; the URL itself when it does not parse (the form says so separately). */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
}

/** One phrase per thing the policy pins or takes away, for the form's footer. `strict` marks the restrictive ones. */
export function policyEffects(draft: PolicyDraft): Array<{ text: string; strict: boolean }> {
  const out: Array<{ text: string; strict: boolean }> = [];
  const forced = POLICY_SETTINGS.filter((s) => draft.forced[s.path]).length;
  out.push({ text: forced === 0 ? 'no settings forced' : `${forced} setting${forced === 1 ? '' : 's'} forced`, strict: forced > 0 });
  if (!draft.app.allowQuit) {
    out.push({ text: draft.app.users.length > 0 ? `cannot be quit, relaunched for ${draft.app.users.join(', ')}` : 'cannot be quit, relaunched for nobody', strict: true });
  }
  const restricted = POLICY_RESTRICTIONS.filter(({ key }) => (key === 'requireCharacterSession' ? draft.app.restrictions[key] : !draft.app.restrictions[key])).length;
  if (restricted > 0) out.push({ text: `${restricted} app restriction${restricted === 1 ? '' : 's'}`, strict: true });
  if (!draft.dev.allow) out.push({ text: draft.dev.devTools ? 'development switches off, DevTools kept' : 'development switches and DevTools off', strict: true });
  else if (!draft.dev.devTools) out.push({ text: 'DevTools off', strict: true });
  if (!draft.inputLock.enabled) out.push({ text: 'input locking refused', strict: true });
  if (draft.guard.mode !== 'off') out.push({ text: `session guard: ${draft.guard.mode}`, strict: draft.guard.mode === 'enforce' });
  if (draft.remote.enabled && draft.remote.url.trim()) out.push({ text: `policy fetched from ${hostOf(draft.remote.url)} every ${draft.remote.intervalMinutes} min`, strict: true });
  if (draft.packs.sources.length > 0) out.push({ text: `${draft.packs.sources.length} pack${draft.packs.sources.length === 1 ? '' : 's'} installed by policy${draft.packs.removeUnlisted ? ', others removed' : ''}`, strict: draft.packs.removeUnlisted });
  if (draft.lock.enabled) out.push({ text: 'locked behind a code once sealed', strict: true });
  return out;
}
