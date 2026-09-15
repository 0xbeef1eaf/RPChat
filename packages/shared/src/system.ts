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
  app?: { allowQuit?: boolean; users?: string[] };
  /**
   * The session guard (docs/system-integration.md "Session guard"): AppArmor confinement of the
   * `app.users` login sessions so their own terminals, keybind scripts and pickers cannot reach
   * the compositor's and shell's IPC sockets, write the wallpaper/shell config and state, or
   * signal/trace rp-code — while rp-code itself may. `mode` other than `off` needs `app.users`.
   */
  guard?: GuardPolicy;
}

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

/** The effective `PolicyFile.app` block with defaults applied (`allowQuit` defaults to true). */
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
