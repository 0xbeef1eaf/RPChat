import type { AppSettings } from './settings.js';

/**
 * Root-owned policy file (`/etc/rp-code/policy.json` on Linux). Values here override the user's
 * settings and cannot be changed from the app; the UI shows the affected controls as managed.
 * The system daemon enforces the input-lock limits independently of the app.
 */
export interface PolicyFile {
  version: 1;
  /** Settings paths that are forced. Only these keys are supported (dotted paths are documented in docs/spec/system.md). */
  settings?: {
    autonomy?: Partial<AppSettings['autonomy']>;
    maxInputLockMs?: number;
    permissions?: { moduleAllow?: Record<string, boolean> };
    web?: { allowlist?: string[] };
    desktop?: { launchAllowlist?: string[] };
    memory?: Partial<AppSettings['memory']>;
    senses?: Partial<Pick<AppSettings['senses'], 'includeInPrompt' | 'watchDirs' | 'calendarSources'>>;
    displayBackend?: AppSettings['displayBackend'];
    /**
     * `enabled: false` switches update checks off entirely; `automatic` pins the background check
     * toggle; `allowDowngrade` lets the daemon's `apply-update` install an older version than the
     * current system install (refused by default). `enabled`/`allowDowngrade` are daemon/updater
     * rules rather than user settings, so only `automatic` is reported as a managed path.
     */
    updates?: { automatic?: boolean; enabled?: boolean; allowDowngrade?: boolean };
    /** Browser extension limits: what characters may do in the browser and the block cap. */
    browser?: Partial<Pick<AppSettings['browser'], 'allowBlocking' | 'allowEval' | 'allowHistory' | 'homePage'>>;
  };
  /** Input-lock hard limits enforced by the daemon regardless of app settings. */
  inputLock?: {
    /** Absolute maximum for one lock, ms. Default 300_000. */
    maxDurationMs?: number;
    /** Hold this key for `emergencyHoldMs` to force an unlock. Default `esc`. */
    emergencyKey?: 'esc' | 'f1' | 'f12' | 'pause';
    emergencyHoldMs?: number;
    /** When false, `lock` is refused entirely. */
    enabled?: boolean;
  };
  /** Free text shown in Settings → System explaining who manages this machine. */
  managedBy?: string;
  /**
   * How the app itself may behave on this machine. `allowQuit: false` removes every way to quit
   * from the UI and has the daemon relaunch the app when its process dies anyway — but only for
   * the users listed in `users` (unix user names) while one of them owns the active graphical
   * session. An absent or empty `users` list means nobody is relaunched.
   */
  app?: {
    allowQuit?: boolean;
    users?: string[];
  } & Partial<AppRestrictions>;
  /**
   * The session guard (docs/system-integration.md "Session guard"): AppArmor confinement of the
   * `app.users` login sessions so their own terminals, keybind scripts and pickers cannot reach
   * the compositor's and shell's IPC sockets, write the wallpaper/shell config and state, or
   * signal/trace rp-code — while rp-code itself may. `mode` other than `off` needs `app.users`.
   */
  guard?: GuardPolicy;
  /**
   * The development switches (docs/spec/system.md "Policy `dev` block"). A block of its own rather
   * than an `app` restriction because it is decided differently: the main process reads it
   * synchronously at startup, straight from `POLICY_FILE_PATH`, before anything else has looked at
   * the environment — `RP_POLICY_FILE` is itself one of the switches it takes away, so the lock
   * cannot be read through a file the locked user chose.
   */
  dev?: DevPolicy;
}

/** `PolicyFile.dev`: whether the app honours its development switches at all. */
export interface DevPolicy {
  /**
   * `false` makes the app ignore every development switch: the `RP_*` environment overrides (the
   * mock provider, the smoke runs, the example pack and plugin, the user-data, policy-file,
   * daemon-socket, overlay-helper and system-install paths), `ELECTRON_RENDERER_URL` and
   * friends, and the inspector flags — a launch that asks for one of those is refused outright.
   * Default `true`: without this key the app behaves exactly as it always has.
   */
  allow?: boolean;
  /**
   * Whether DevTools may be opened in the app's windows. Defaults to `allow`, so `allow: false`
   * closes the inspector too; set it explicitly to keep the inspector on a locked machine (for
   * support) or to take it away while the environment switches stay.
   */
  devTools?: boolean;
}

/** The effective `dev` block with defaults applied. */
export interface DevRules {
  allow: boolean;
  devTools: boolean;
}

/** What applies without a policy file: every development switch honoured, as before. */
export const DEFAULT_DEV_RULES: DevRules = { allow: true, devTools: true };

/**
 * Environment variables a locked-down app drops before anything reads them. Every `RP_*` variable
 * is a development override with a working default behind it (nothing in a real install sets one),
 * so the whole prefix goes — a switch added later is covered without touching this list.
 */
export const DEV_ENV_PREFIX = 'RP_';

/** Dropped alongside the prefix: they point the app, or a process it spawns, at foreign code. */
export const DEV_ENV_KEYS = ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'] as const;

/**
 * Command-line flags a locked-down app refuses to start with. They open a debugging channel into
 * the main process or the renderer, which would hand back everything the lock takes away. Matched
 * on the part before `=`. `--no-sandbox` is deliberately not here: real installs need it.
 */
export const DEV_ARGV_FLAGS = [
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--inspect-publish-uid',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-allow-origins',
  '--js-flags',
] as const;

export type GuardMode = 'off' | 'audit' | 'enforce';
export type GuardCompositorIpc = 'allow' | 'shell-only' | 'deny';
export type GuardShell = 'auto' | 'noctalia' | 'quickshell' | 'hyprpaper' | 'swww' | 'awww' | 'none';

export interface GuardPolicy {
  /** `off` (default) unloads, `audit` logs every attempt without blocking, `enforce` blocks. */
  mode?: GuardMode;
  /** Signals and ptrace from the session to rp-code are guarded. Default true. */
  protectApp?: boolean;
  /** The shell's IPC socket and its config/state files are guarded. Default true. */
  wallpaper?: boolean;
  /** Who may reach the compositor's control socket. Default `shell-only`. */
  compositorIpc?: GuardCompositorIpc;
  /** Which shell table row applies. Default `auto` (first whose binary exists). */
  /** One shell, or several: a bar with its own IPC socket and a wallpaper daemon are commonly both present. */
  shell?: GuardShell | GuardShell[];
  /** PAM login helpers carrying the per-user hats; default: those present on the box. */
  loginHelpers?: string[];
  /** More files the session may not write (absolute, `~/…` or `@{HOME}/…` globs). */
  extraDenyPaths?: string[];
  /** More unix socket paths the session may not connect to. */
  extraDenySockets?: string[];
  /** Absolute paths that leave the confinement entirely when executed. */
  allowBinaries?: string[];
}

export const GUARD_MODES: readonly GuardMode[] = ['off', 'audit', 'enforce'];
export const GUARD_COMPOSITOR_IPC: readonly GuardCompositorIpc[] = ['allow', 'shell-only', 'deny'];
/** `awww` is `swww` after its rename; both select the same row in the daemon. */
export const GUARD_SHELLS: readonly GuardShell[] = ['auto', 'noctalia', 'quickshell', 'hyprpaper', 'swww', 'awww', 'none'];

/** `status.guard` / `guard-apply` / `guard-status`: what the daemon has engaged. */
export interface GuardInfo {
  /** The AppArmor LSM is active (`/sys/kernel/security/apparmor` exists). */
  available: boolean;
  /** The policy's mode (what is or will be engaged). */
  mode: GuardMode;
  /** Profiles currently loaded (`rp-code-session`, `rp-code-app`, …); empty when off or failed. */
  loaded: string[];
  users: string[];
  /** Documented gaps for this configuration, one sentence each. */
  residual: string[];
  /**
   * What makes the guard ineffective right now and how to fix it, e.g. a login helper that
   * started before the profiles were loaded (sessions stay unconfined until it restarts).
   */
  warnings?: string[];
  /** The `pam_apparmor.so` session line is present (undefined when no known PAM file exists). */
  pamConfigured?: boolean;
  shell?: string;
  compositor?: string;
  appliedAt?: string;
  lastError?: string;
}

/** What kind of guarded resource a `guard-attempt` touched. */
export type GuardAttemptKind = 'ipc' | 'config' | 'signal' | 'ptrace' | 'exec';

/** One AppArmor audit record about an `rp-code-*` profile (the `guard-attempt` host event's data). */
export interface GuardAttempt {
  kind: GuardAttemptKind;
  /** The socket/file path, the peer profile (signal/ptrace) or the executable. */
  target: string;
  /** The process name (`comm`). */
  command: string;
  pid: number;
  /** `true` in enforce mode (`DENIED`); audit mode logs without blocking. */
  blocked: boolean;
  profile: string;
  operation: string;
  requested?: string;
}

/** One entry of the app's guard-attempt log (Settings → System → Audit log): the event plus when it arrived. */
export interface GuardAttemptRecord extends GuardAttempt {
  at: string;
}

/** A pushed daemon line (`{ ev: … }`), received on a connection that sent `subscribe`. */
export type DaemonEvent = { ev: 'guard-attempt'; at: string } & GuardAttempt;
export type DaemonEventName = DaemonEvent['ev'];
export const DAEMON_EVENT_NAMES: readonly DaemonEventName[] = ['guard-attempt'];

/**
 * The app-enforced restrictions of the `app` block (docs/spec/system.md "Restrictions"). Unlike
 * the `guard` block — AppArmor confinement the daemon applies to the *session around* the app —
 * these are refused by the main process itself, on the IPC boundary, so neither the UI nor a
 * character's script can reach the operation. The renderer also hides the matching controls, but
 * that is cosmetic: `registerIpc` is what actually enforces them.
 *
 * Every `allow*` key defaults to `true` and every `require*` key to `false`, so a policy that
 * does not mention them behaves exactly as before.
 */
export interface AppRestrictions {
  /** `false` closes the pack editor: the whole `editor:*` IPC namespace is refused and the nav entry is gone. */
  allowPackEditor: boolean;
  /** `false` refuses `packs.uninstall` — no installed pack can be removed. */
  allowPackRemove: boolean;
  /**
   * `false` freezes the installed packs on disk: `packs.install` and the editor's `installToApp`
   * are refused, so no pack is added, replaced or rewritten in the pack store.
   */
  allowPackInstall: boolean;
  /** `false` refuses `sessions.remove` — a conversation cannot be deleted. */
  allowDeleteSession: boolean;
  /** `false` refuses `sessions.clearMessages` and `sessions.removeMessage` — the chat history cannot be erased. */
  allowDeleteHistory: boolean;
  /** `false` refuses `memories.remove` — what a character remembers cannot be deleted. */
  allowDeleteMemories: boolean;
  /** `false` refuses `events.remove` — a character's event handlers cannot be unsubscribed by hand. */
  allowRemoveEvents: boolean;
  /** `false` closes the Sandbox tab: `sandbox.run`/`sandbox.cancel` are refused and the nav entry is gone. */
  allowSandbox: boolean;
  /**
   * `true` keeps the app inside a conversation: the UI always opens a session with a character
   * (creating one for the first installed character when none exists) and offers no way to sit on
   * an empty chat. Refuses `sessions.remove` for the last remaining session so the requirement
   * cannot be emptied out from under itself.
   */
  requireCharacterSession: boolean;
}

/** Permissive defaults: everything allowed, no session forced — what applies without a policy file. */
export const DEFAULT_APP_RESTRICTIONS: AppRestrictions = {
  allowPackEditor: true,
  allowPackRemove: true,
  allowPackInstall: true,
  allowDeleteSession: true,
  allowDeleteHistory: true,
  allowDeleteMemories: true,
  allowRemoveEvents: true,
  allowSandbox: true,
  requireCharacterSession: false,
};

/** The `allow*` restriction keys (all default `true`), for validation and iteration. */
export const APP_ALLOW_KEYS = [
  'allowPackEditor',
  'allowPackRemove',
  'allowPackInstall',
  'allowDeleteSession',
  'allowDeleteHistory',
  'allowDeleteMemories',
  'allowRemoveEvents',
  'allowSandbox',
] as const satisfies readonly (keyof AppRestrictions)[];

/** The `require*` restriction keys (all default `false`). */
export const APP_REQUIRE_KEYS = ['requireCharacterSession'] as const satisfies readonly (keyof AppRestrictions)[];

/**
 * The effective quit/relaunch half of `PolicyFile.app` (`allowQuit` defaults to true). The
 * restrictions travel separately as `AppRestrictions`: the daemon acts on this half, the app on
 * that one.
 */
export interface AppPolicy {
  allowQuit: boolean;
  users: string[];
}

/** `status.keepalive`: whether an app registered for relaunch on this daemon and what the policy says. */
export interface KeepaliveInfo {
  registered: boolean;
  relaunches: number;
  allowQuit: boolean;
}

/**
 * `status.install`: the system install (`/opt/rp-code`) as the daemon sees it. Absent in the
 * answer of a daemon that predates `apply-update`.
 */
export interface InstallInfo {
  /** `<root>/current/rp-code` exists and `versions.json` describes it. */
  systemInstall: boolean;
  current?: string;
  previous?: string;
  /** The running daemon's version. */
  daemonVersion: string;
}

/** Default system install root and the unpacked app inside it (`install.sh --system-install`). */
export const SYSTEM_INSTALL_ROOT = '/opt/rp-code';
export const SYSTEM_INSTALL_DIR = `${SYSTEM_INSTALL_ROOT}/current`;

/** Dotted settings paths the policy currently forces (e.g. `autonomy.maxSelfWakesPerHour`). */
export type ManagedSettingsPaths = string[];

export interface DaemonStatus {
  /** Whether the app could reach the daemon socket and complete `hello`. */
  connected: boolean;
  version?: string;
  socketPath?: string;
  /** Whether the daemon runs with device access (root) and found input devices. */
  devices?: { keyboards: number; pointers: number; uinput: boolean };
  locked?: { until: string; reason?: string; devices: LockDevices } | null;
  /** Relaunch registration state, when the daemon reports it (protocol 1 daemons from 0.2 on). */
  keepalive?: KeepaliveInfo;
  /** System install state, when the daemon reports it (daemons with `apply-update`). */
  install?: InstallInfo;
  /** Session guard state, when the daemon reports it (daemons with `guard-apply`). */
  guard?: GuardInfo;
  error?: string;
}

/** `SystemIntegrationStatus.guard`: the policy's guard block as the app reads it plus what the daemon engaged. */
export interface GuardStatus extends GuardInfo {
  /** The policy file has a `guard` block with `mode` other than `off`. */
  configured: boolean;
  /** The connected daemon reports guard state (older daemons do not). */
  daemonSupportsGuard: boolean;
}

/** `SystemIntegrationStatus.install`: whether this app runs from the system install and what the daemon knows about it. */
export interface SystemInstallStatus {
  /** Running from `dir` (realpath of the executable) *and* the daemon is connected. */
  systemInstall: boolean;
  /** `/opt/rp-code/current`. */
  dir: string;
  /** The executable runs from `dir` (whether or not the daemon is connected). */
  execInDir: boolean;
  /** The connected daemon answers `status.install` (knows `apply-update`); false for an older daemon or without one. */
  daemonSupportsUpdates: boolean;
  /** The launch is an AppImage, so the installer can unpack it into `dir` (`install.sh --system-install`). */
  canSystemInstall: boolean;
  current?: string;
  previous?: string;
  daemonVersion?: string;
}

export interface SystemIntegrationStatus {
  platform: string;
  daemon: DaemonStatus;
  /**
   * Policy file present and readable. `canCreate`: the daemon is connected and no policy file
   * exists, so the user may create one once through the daemon without root (`system.createPolicy`).
   */
  policy: {
    present: boolean;
    canCreate: boolean;
    path?: string;
    managedBy?: string;
    managed: ManagedSettingsPaths;
    /** `app.allowQuit` (true without a policy file). `app.allowQuit` is not a settings key, so it is not in `managed`. */
    allowQuit: boolean;
    /** `app.users`: the unix user names the daemon relaunches the app for (only meaningful with `allowQuit: false`). */
    users: string[];
    /** The effective `app` restrictions (`DEFAULT_APP_RESTRICTIONS` without a policy file); not settings keys, so not in `managed`. */
    restrictions: AppRestrictions;
    /**
     * The `dev` block as this process read it when it started (dev-guard.ts). It is deliberately
     * the boot decision rather than the file's current content: the lock is applied once, so a
     * policy edited since says nothing about the app that is running.
     */
    dev: DevRules;
    error?: string;
  };
  /** udev rule and group membership as detected (Linux). */
  udev: { rulePresent: boolean; inGroup: boolean; groupName: string };
  autostart: { enabled: boolean; method: 'xdg' | 'systemd-user' | 'none'; path?: string };
  /** Whether the bundled installer script is available to run with elevated privileges. */
  installerAvailable: boolean;
  install: SystemInstallStatus;
  guard: GuardStatus;
}

/** Which input devices a lock covers. */
export type LockDevices = 'keyboard' | 'mouse' | 'both';

/** JSON-lines protocol between the app and `rp-coded` over the unix socket. */
export type DaemonRequest =
  | { op: 'hello'; version: 1 }
  | { op: 'status' }
  | { op: 'policy' }
  /** `devices` defaults to `both`; `keyboard` grabs keyboards only, `mouse` grabs pointers/touchpads only. */
  | { op: 'lock'; durationMs: number; reason?: string; devices?: LockDevices }
  | { op: 'unlock' }
  | { op: 'type'; text: string }
  | { op: 'key'; combo: string }
  | { op: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { op: 'move'; x: number; y: number }
  /** Create the policy file once (write-once): `EXISTS` when one is already there, `INVALID` when the object fails validation. */
  | { op: 'set-policy'; policy: PolicyFile }
  /**
   * Keepalive registration on a long-lived connection: how to relaunch this app in the user's
   * session (`exec` absolute, `args` ≤ 32, `env` from `KEEPALIVE_ENV_KEYS` only, values ≤ 4 KiB).
   * When the connection drops without `unregister` and the policy says `app.allowQuit: false`,
   * the daemon relaunches `exec args…` as the registering user once the process is gone.
   */
  | { op: 'register'; exec: string; args: string[]; cwd: string; env: Record<string, string> }
  /** Forget the registration on this connection (sent before an authorised quit such as an update restart). */
  | { op: 'unregister' }
  /**
   * System install: verify `file` (an AppImage under the requesting user's home, owned by them)
   * against `sha512` (base64, as `latest-linux.yml` gives it), extract it as that user, swap it
   * into `/opt/rp-code/current` and update the daemon itself when the bundle ships a newer one.
   * `version` must be semver and not older than the installed one unless the policy says
   * `updates.allowDowngrade`. May take minutes; the client uses a long timeout.
   */
  | { op: 'apply-update'; file: string; version: string; sha512: string }
  /** Session guard: (re)generate and load the profiles from the policy now. */
  | { op: 'guard-apply' }
  /** Session guard: what is engaged, without touching anything. */
  | { op: 'guard-status' }
  /** Receive pushed `{ ev: … }` lines (`DaemonEvent`) on this connection for these events; `[]` unsubscribes. */
  | { op: 'subscribe'; events: DaemonEventName[] };

export type DaemonResponse =
  | { ok: true; op: 'hello'; version: string; protocol: 1; devices: { keyboards: number; pointers: number; uinput: boolean } }
  | { ok: true; op: 'status'; locked: { until: string; reason?: string; devices: LockDevices } | null; keepalive?: KeepaliveInfo; install?: InstallInfo; guard?: GuardInfo }
  | { ok: true; op: 'policy'; policy: PolicyFile | null; path: string }
  | { ok: true; op: 'lock'; until: string; durationMs: number; devices: LockDevices }
  | { ok: true; op: 'unlock' | 'type' | 'key' | 'click' | 'move' | 'register' | 'unregister' }
  | { ok: true; op: 'set-policy'; path: string }
  /** `restartDaemon`: the daemon updated itself and restarts right after answering (wait for it before relaunching). */
  | { ok: true; op: 'apply-update'; version: string; restartDaemon: boolean }
  | { ok: true; op: 'guard-apply' | 'guard-status'; guard: GuardInfo }
  | { ok: true; op: 'subscribe'; events: DaemonEventName[] }
  | { ok: false; error: string; code: 'REFUSED' | 'POLICY' | 'NO_DEVICES' | 'BUSY' | 'INVALID' | 'INTERNAL' | 'EXISTS' };

export const DAEMON_SOCKET_PATH = '/run/rp-code/daemon.sock';
/**
 * Environment variables a keepalive registration may carry (the daemon rejects any other key):
 * what a relaunched app needs to find the user's display, session bus and home. The daemon adds
 * nothing from its own environment.
 */
export const KEEPALIVE_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_ID',
  'XDG_CURRENT_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'SWAYSOCK',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XAUTHORITY',
  'APPIMAGE',
  'APPDIR',
  'ELECTRON_OZONE_PLATFORM_HINT',
] as const;
/** Longest env value a registration may carry (bytes of UTF-8). */
export const KEEPALIVE_ENV_VALUE_MAX = 4096;
/** Most `args` a registration may carry. */
export const KEEPALIVE_ARGS_MAX = 32;
export const POLICY_FILE_PATH = '/etc/rp-code/policy.json';
export const SYSTEM_GROUP = 'rp-code';
