import type { AppSettings } from './settings.js';

/**
 * Root-owned policy file (`/etc/rpchat/policy.json` on Linux). Values here override the user's
 * settings and cannot be changed from the app; the UI shows the affected controls as managed.
 * The system daemon enforces the input-lock limits independently of the app.
 */
export interface PolicyFile {
  version: 1;
  /** Settings paths that are forced. Only these keys are supported (dotted paths are documented in docs/spec/system.md). */
  settings?: {
    autonomy?: Partial<AppSettings['autonomy']>;
    maxInputLockMs?: number;
    /**
     * `functionAllow` pins SDK functions for everyone: keys are a module id (`avatar`) or one
     * function (`avatar.show`), exactly as in `AppSettings.permissions`. A key left out of the
     * file stays the user's own choice. `moduleAllow` is the pre-function name of the same map
     * (module keys only), still read so policy files written before the change keep working.
     */
    permissions?: { functionAllow?: Record<string, boolean>; moduleAllow?: Record<string, boolean> };
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
    /**
     * Browser extension limits: what characters may do in the browser. The home page is not one of
     * them — only a character sets it, through `sdk.browser.setHomePage`.
     */
    browser?: Partial<Pick<AppSettings['browser'], 'allowBlocking' | 'allowEval' | 'allowHistory'>>;
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
   * signal/trace rpchat — while rpchat itself may. `mode` other than `off` needs `app.users`.
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
  /**
   * Remote configuration: where this machine's policy is fetched from. A policy that names a
   * `remote.url` is refreshed from it on the interval; the daemon verifies what comes back before
   * it replaces anything. The key that signs the chain is pinned by the Remote Link, never named
   * here: a policy must not be able to name the key that authorises it.
   */
  remote?: RemotePolicy;
  /** The packs this machine is meant to have, and where to download them. */
  packs?: PacksPolicy;
  /**
   * The TOTP lock. Once the machine is **sealed** the policy is no longer write-once-then-root's:
   * changing or removing it needs a code from the enrolled authenticator app, and the daemon puts
   * back anything that is edited behind its back. This block holds the knobs only — the secret is
   * in the root-only seal beside the policy file.
   */
  lock?: PolicyLock;
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
  /** Signals and ptrace from the session to rpchat are guarded. Default true. */
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
  /** Profiles currently loaded (`rpchat-session`, `rpchat-app`, …); empty when off or failed. */
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

/** One AppArmor audit record about an `rpchat-*` profile (the `guard-attempt` host event's data). */
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
export type DaemonEvent =
  | ({ ev: 'guard-attempt'; at: string } & GuardAttempt)
  /** A sealed file was changed behind the daemon's back, and what it did about it. */
  | ({ ev: 'policy-tamper'; at: string } & TamperRecord)
  /** The effective policy changed (a code-authorised write, a remote configuration, or a restore from the seal). */
  | { ev: 'policy-changed'; at: string; source: string; policyHash: string };
export type DaemonEventName = DaemonEvent['ev'];
export const DAEMON_EVENT_NAMES: readonly DaemonEventName[] = ['guard-attempt', 'policy-tamper', 'policy-changed'];

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
  /**
   * `false` refuses `chat.abort` — a reply already being generated has to finish. The channels
   * that abort the turn in flight on their way to doing something else (`chat.retry`,
   * `sessions.resetState`, `sessions.removeMessage`, `sessions.clearMessages`) are refused too,
   * but only *while* a reply is running, so those features still work the rest of the time.
   */
  allowStopGeneration: boolean;
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
  allowStopGeneration: true,
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
  'allowStopGeneration',
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
 * `status.install`: the system install (`/opt/rpchat`) as the daemon sees it. Absent in the
 * answer of a daemon that predates `apply-update`.
 */
export interface InstallInfo {
  /** `<root>/current/rpchat` exists and `versions.json` describes it. */
  systemInstall: boolean;
  current?: string;
  previous?: string;
  /** The running daemon's version. */
  daemonVersion: string;
}

/** Default system install root and the unpacked app inside it (`install.sh --system-install`). */
export const SYSTEM_INSTALL_ROOT = '/opt/rpchat';
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
  /** `/opt/rpchat/current`. */
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
    /**
     * The TOTP lock. `sealed` means the policy can only be changed with a code; `canCreate` is
     * false while it is, because creating one is not how a sealed policy is replaced.
     */
    seal: SealInfo;
    /** The daemon-owned filesystem the effective policy is published into; absent without one. */
    runtime?: RuntimeInfo;
    /**
     * The app is enforcing a sealed policy it cached itself, because the machine's policy file
     * and the daemon are both gone. Wiping `/etc/rpchat` does not leave the app unmanaged.
     */
    fromCache?: boolean;
    error?: string;
  };
  /** Remote configuration: what the daemon knows, plus the app's own fetch and pack state. */
  remote?: { daemon: RemoteInfo; app: RemoteConfigStatus };
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

/** JSON-lines protocol between the app and `rpchatd` over the unix socket. */
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
  /**
   * Create the policy file (write-once while unsealed: `EXISTS` when one is already there,
   * `INVALID` when the object fails validation). On a sealed machine `code` — the current code
   * from the enrolled authenticator app — replaces the policy instead and re-pins the seal;
   * without it, or with a wrong one, the answer is `CODE`.
   */
  | { op: 'set-policy'; policy: PolicyFile; code?: string }
  /**
   * Seal this machine: generate a TOTP secret, pin `policy` (or the policy already on disk) to it
   * and publish it into the runtime filesystem. The secret and the remote-configuration key come
   * back in the answer and are never readable again.
   */
  | { op: 'seal-policy'; policy?: PolicyFile; totp?: TotpConfig }
  /** Remove the seal with a valid code; `removePolicy` takes the policy file with it. */
  | { op: 'unseal-policy'; code: string; removePolicy?: boolean }
  /** The seal, the runtime filesystem and the remote-configuration state, without secrets. */
  | { op: 'seal-status' }
  /**
   * Apply a policy chain the app fetched. `document` is the response body verbatim — the
   * signatures cover exactly those bytes, so it must not be reformatted.
   */
  | { op: 'remote-apply'; document: string }
  /**
   * Paste a **Remote Link**. On an unlinked machine this is what seals it, in the mode the blob
   * names. On a machine already linked in `totp` mode it needs the current `code`; on one in
   * `chain` mode it is refused — only a signed link can move that machine's trust root.
   */
  | { op: 'set-remote-link'; blob: string; code?: string }
  /** Whether a downloaded pack may be installed: the app hashes the bytes, the daemon decides. */
  | { op: 'verify-pack'; id: string; sha256: string }
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
   * into `/opt/rpchat/current` and update the daemon itself when the bundle ships a newer one.
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
  | { ok: true; op: 'set-policy'; path: string; replaced: boolean }
  /** `secret`, `otpauth` and `remoteKey` are shown once and stored nowhere the app can read. */
  | { ok: true; op: 'seal-policy'; path: string; secret: string; otpauth: string; seal: SealInfo; runtime: RuntimeInfo }
  | { ok: true; op: 'unseal-policy'; path: string; removed: boolean }
  | { ok: true; op: 'seal-status'; seal: SealInfo; runtime: RuntimeInfo; remote: RemoteInfo }
  | { ok: true; op: 'remote-apply'; changed: boolean; applied: number; seq: number; unsealed: boolean; policyHash: string; runtime: RuntimeInfo; remote: RemoteInfo }
  /** `secret`/`otpauth` are present only when the blob asked for `totp` and this link sealed it. */
  | { ok: true; op: 'set-remote-link'; mode: SealMode; url: string; secret?: string; otpauth?: string; seal: SealInfo; runtime: RuntimeInfo; remote: RemoteInfo }
  | { ok: true; op: 'verify-pack'; signed: boolean }
  /** `restartDaemon`: the daemon updated itself and restarts right after answering (wait for it before relaunching). */
  | { ok: true; op: 'apply-update'; version: string; restartDaemon: boolean }
  | { ok: true; op: 'guard-apply' | 'guard-status'; guard: GuardInfo }
  | { ok: true; op: 'subscribe'; events: DaemonEventName[] }
  | { ok: false; error: string; code: 'REFUSED' | 'POLICY' | 'NO_DEVICES' | 'BUSY' | 'INVALID' | 'INTERNAL' | 'EXISTS' | 'CODE' };

export const DAEMON_SOCKET_PATH = '/run/rpchat/daemon.sock';
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
export const POLICY_FILE_PATH = '/etc/rpchat/policy.json';
export const SYSTEM_GROUP = 'rpchat';

// ---------------------------------------------------------------------------
// Remote configuration, remote packs and the TOTP-locked (sealed) policy
// ---------------------------------------------------------------------------

/**
 * `PolicyFile.remote`: where this machine's policy comes from. The app fetches `url` on the
 * interval and hands the bytes to the daemon, which decides whether to believe them
 * (`native/rpchatd/src/remote.rs`) — so a patched app cannot loosen a sealed machine, and the
 * daemon needs no TLS stack of its own.
 */
export interface RemotePolicy {
  /** `https://` anywhere, or `http://` on the loopback (an on-box management agent, the tests). */
  url: string;
  /** `false` stops the fetching without forgetting the address. Default true. */
  enabled?: boolean;
  /** How often to fetch, 5..1440. Default 60. */
  intervalMinutes?: number;
}

/** One pack a policy pins: where to download it and what it must turn out to be. */
export interface PackSource {
  /** The pack id the download must contain — checked after unpacking. */
  id: string;
  url: string;
  /**
   * The administrator's Ed25519 signature over this pack, base64. It covers the id, the version
   * and the SHA-256 of the file together (`rpchat-pack/v1\n<id>\n<version>\n<sha256>`), so a
   * signed pack cannot be re-labelled as a different one. **Required on a machine with a Remote
   * Link**: there, the policy itself arrived over the network, so a checksum in it proves only
   * that the policy and the pack agree — not that either came from the administrator.
   */
  signature?: string;
  /** SHA-256 of the `.rppack`, lower-case hex. The only check available without a pinned key. */
  sha256?: string;
  /** The version to install; when absent, whatever the download contains. */
  version?: string;
}

/**
 * How a sealed machine may be changed. The two are mutually exclusive: a machine with both would
 * be only as strong as the weaker one.
 *
 * - `totp` — a person types the code from the enrolled authenticator app and the policy becomes
 *   editable here. For a machine you will stand in front of.
 * - `chain` — no code exists. The machine pins a public key and the hash of the last policy link
 *   it applied; only a signed link continuing that chain can change anything, and letting the
 *   machine go is itself a link. For a fleet.
 */
export type SealMode = 'totp' | 'chain';
export const SEAL_MODES: readonly SealMode[] = ['totp', 'chain'];

/**
 * A **Remote Link**: the base64 blob an administrator hands out. Pasting one into Settings →
 * System points the machine at a policy chain, pins the key that signs it, and seals the machine
 * in the mode the blob names. It is self-signed by the key it carries, so a blob mangled or
 * swapped on the way is refused rather than trusted for having arrived in the right box.
 */
export interface RemoteLink {
  version: 1;
  /** Where the chain is published. */
  url: string;
  /** The Ed25519 public key, base64, that every link must be signed with. */
  key: string;
  keyId?: string;
  intervalMinutes?: number;
  /** Free text shown in Settings → System, so a person can see whose link they pasted. */
  managedBy?: string;
  /** Which way in the machine gets. Default `chain`. */
  mode?: SealMode;
  signature: { alg: 'ed25519'; value: string; keyId?: string };
}

/** One link of a policy chain: a policy, hash-linked to the one before it and signed. */
export interface ChainLink {
  /** Position in the chain, one more than the link before it. */
  seq: number;
  /** SHA-256 of the previous link's canonical bytes; empty for the genesis. */
  prev: string;
  issuedAt?: string;
  /** The policy this link puts in force. Absent keeps the one before it. */
  policy?: PolicyFile;
  /** Rotation: from the next link on, signatures are checked against this key. */
  nextKey?: string;
  /** `true` releases the machine — the seal is lifted and local changes are possible again. */
  unseal?: boolean;
  signature: { alg: 'ed25519'; value: string; keyId?: string };
}

/** A published chain: what a machine fetches from `remote.url`. */
export interface PolicyChain {
  version: 1;
  links: ChainLink[];
}

/**
 * `PolicyFile.packs`: the packs this machine is meant to have. The app installs them without the
 * user choosing a file, and keeps them installed.
 */
export interface PacksPolicy {
  sources?: PackSource[];
  /** Uninstall every pack that is not listed. Default false. */
  removeUnlisted?: boolean;
  /** How often to re-check the sources, 5..1440. Default 360. */
  refreshMinutes?: number;
}

/** TOTP parameters an authenticator app is enrolled with. */
export interface TotpConfig {
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  /** Seconds per code. */
  period: number;
  /** Steps of clock drift accepted on each side. */
  window: number;
}

/**
 * `PolicyFile.lock`: how hard the policy holds once the machine is **sealed**. The TOTP secret is
 * never here — this file is world-readable; it lives in the root-only seal
 * (`/etc/rpchat/policy.seal`) the daemon writes when it seals the machine.
 *
 * A policy that carries a `lock` block also tells the session guard to take `/etc/rpchat` and the
 * profile-escaping binaries away from the guarded sessions; sealing adds an empty one when the
 * policy has none, so what is in force is always readable in the file.
 */
export interface PolicyLock {
  algorithm?: TotpConfig['algorithm'];
  digits?: number;
  period?: number;
  window?: number;
  /** Rewrite the policy file from the seal when it is edited or deleted. Default true. */
  selfHeal?: boolean;
  /** Set the immutable attribute on the policy, the seal and its mirrors. Default true. */
  immutable?: boolean;
  /** Write the `RefuseManualStop=yes` drop-in for `rpchatd.service`. Default true. */
  refuseManualStop?: boolean;
  /** Deny guarded sessions `run0`, `systemd-run`, `machinectl`, `pkexec`, `chattr`, `apparmor_parser`. Default true. */
  denyEscapes?: boolean;
}

/** One noticed change to a sealed file, and what the daemon did about it. */
export interface TamperRecord {
  at: string;
  /** `policy-edited`, `policy-removed` or `seal-removed`. */
  kind: string;
  path: string;
  /** Whether the daemon put it back. */
  healed: boolean;
}

/** `seal-status.seal`: what the seal is, never what it knows. */
export interface SealInfo {
  sealed: boolean;
  /** Which way in this machine has. */
  mode: SealMode;
  sealedAt?: string;
  managedBy?: string;
  /** SHA-256 of the sealed policy. */
  policyHash?: string;
  /** The TOTP parameters — absent in `chain` mode, where there is no code at all. */
  totp?: TotpConfig;
  /** Consecutive wrong codes, and when the lockout they armed ends. */
  failures: number;
  lockedUntil?: string;
  /** Every place a copy of the seal is kept. */
  paths: string[];
  /** The protections actually in place right now, not what the policy asked for. */
  immutable: boolean;
  selfHeal: boolean;
  denyEscapes: boolean;
  refuseManualStop: boolean;
  tampers: TamperRecord[];
  /** What this seal cannot protect against, one sentence each. */
  residual: string[];
}

/** What applies before the daemon has answered, and on a machine that has no seal. */
export const DEFAULT_SEAL_INFO: SealInfo = {
  sealed: false,
  mode: 'totp',
  failures: 0,
  paths: [],
  immutable: false,
  selfHeal: false,
  denyEscapes: false,
  refuseManualStop: false,
  tampers: [],
  residual: [],
};

/** `seal-status.runtime`: the daemon-owned filesystem the effective policy is published into. */
export interface RuntimeInfo {
  dir: string;
  /** A tmpfs of the daemon's own is mounted there. */
  mounted: boolean;
  /** That mount is currently read-only. */
  readOnly: boolean;
  present: boolean;
  policyHash?: string;
  publishedAt?: string;
  /** Why the protection is not complete (empty when it is). */
  degraded: string[];
}

/** `seal-status.remote`: the policy chain this machine follows and how far along it is. */
export interface RemoteInfo {
  /** This machine has a Remote Link, so it has somewhere to fetch from and a key to check it. */
  configured: boolean;
  url?: string;
  enabled: boolean;
  intervalMinutes: number;
  /** The pinned public key (base64) and the name the administrator gave it. */
  key?: string;
  keyId?: string;
  /** Where the machine is on its chain: the last link's `seq` and hash. */
  seq: number;
  head?: string;
  /** When the Remote Link was pasted. */
  linkedAt?: string;
  /** Keys this chain has rotated through, oldest first. */
  rotations: string[];
  lastAppliedAt?: string;
  lastError?: string;
  /** The packs the policy pins, for the app to install. */
  packs: PackSource[];
  removeUnlisted: boolean;
  packRefreshMinutes: number;
}

/** What the app reports about its own half of remote configuration: the fetch and the packs. */
export interface RemoteConfigStatus {
  /** The policy names a source and it is switched on. */
  active: boolean;
  url?: string;
  intervalMinutes: number;
  /** When the app last fetched, whatever came of it. */
  lastCheckedAt?: string;
  /** When a document was last accepted by the daemon. */
  lastAppliedAt?: string;
  /** The last fetch or apply failure, cleared by a success. */
  lastError?: string;
  /** Where the machine is on its chain. */
  seq: number;
  /** One line per pinned pack. */
  packs: RemotePackStatus[];
  /** A fetch or a pack download is running right now. */
  busy: boolean;
}

/** How one pinned pack stands on this machine. */
export interface RemotePackStatus {
  id: string;
  url: string;
  /** The version the policy asks for, when it names one. */
  wanted?: string;
  /** The version installed right now. */
  installed?: string;
  state: 'installed' | 'pending' | 'downloading' | 'failed' | 'removed';
  error?: string;
  updatedAt?: string;
}

/**
 * The authoring side: the administrator's own signing key and the chain they are building
 * (`apps/desktop/src/main/system/chain-author.ts`). Nothing here describes *this* machine's
 * policy — it is the tooling for the machines that follow the chain.
 */
export interface ChainAuthorStatus {
  /** A signing key exists in this app's data. */
  hasKey: boolean;
  /** The public key, base64 — safe to show, and what a Remote Link carries. */
  publicKey?: string;
  keyId?: string;
  /** Whether the key is protected by the OS keyring rather than file permissions alone. */
  keyring: boolean;
  /** The chain being built: how many links and where it ends. */
  links: number;
  seq: number;
  head?: string;
  url?: string;
  mode: SealMode;
  managedBy?: string;
  /** Where the key and the chain live, so an administrator can back them up. */
  dir: string;
}

/** The runtime policy filesystem (`native/rpchatd/src/runtime.rs`). */
export const RUNTIME_POLICY_DIR = '/run/rpchat/policy';
export const RUNTIME_POLICY_FILE = `${RUNTIME_POLICY_DIR}/policy.json`;
export const RUNTIME_POLICY_STATE_FILE = `${RUNTIME_POLICY_DIR}/state.json`;
/**
 * The world-readable half of the seal. It carries the sealed policy and its hash but no secret,
 * so the app can tell a managed machine from an unmanaged one — and can keep enforcing the policy
 * — without being able to change anything.
 */
export const SEAL_MARKER_PATH = '/etc/rpchat/policy.sealed';
