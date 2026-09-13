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
    /** `enabled: false` switches update checks off entirely; `automatic` pins the background check toggle. */
    updates?: { automatic?: boolean; enabled?: boolean };
    /** Browser extension limits: what characters may do in the browser and the block cap. */
    browser?: Partial<Pick<AppSettings['browser'], 'allowBlocking' | 'maxBlockMs' | 'allowEval' | 'allowHistory' | 'homePage'>>;
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
}

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
  error?: string;
}

export interface SystemIntegrationStatus {
  platform: string;
  daemon: DaemonStatus;
  /**
   * Policy file present and readable. `canCreate`: the daemon is connected and no policy file
   * exists, so the user may create one once through the daemon without root (`system.createPolicy`).
   */
  policy: { present: boolean; canCreate: boolean; path?: string; managedBy?: string; managed: ManagedSettingsPaths; error?: string };
  /** udev rule and group membership as detected (Linux). */
  udev: { rulePresent: boolean; inGroup: boolean; groupName: string };
  autostart: { enabled: boolean; method: 'xdg' | 'systemd-user' | 'none'; path?: string };
  /** Whether the bundled installer script is available to run with elevated privileges. */
  installerAvailable: boolean;
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
  | { op: 'set-policy'; policy: PolicyFile };

export type DaemonResponse =
  | { ok: true; op: 'hello'; version: string; protocol: 1; devices: { keyboards: number; pointers: number; uinput: boolean } }
  | { ok: true; op: 'status'; locked: { until: string; reason?: string; devices: LockDevices } | null }
  | { ok: true; op: 'policy'; policy: PolicyFile | null; path: string }
  | { ok: true; op: 'lock'; until: string; durationMs: number; devices: LockDevices }
  | { ok: true; op: 'unlock' | 'type' | 'key' | 'click' | 'move' }
  | { ok: true; op: 'set-policy'; path: string }
  | { ok: false; error: string; code: 'REFUSED' | 'POLICY' | 'NO_DEVICES' | 'BUSY' | 'INVALID' | 'INTERNAL' | 'EXISTS' };

export const DAEMON_SOCKET_PATH = '/run/rp-code/daemon.sock';
export const POLICY_FILE_PATH = '/etc/rp-code/policy.json';
export const SYSTEM_GROUP = 'rp-code';
