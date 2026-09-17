/**
 * In-place application updates (Linux AppImage) from the public GitHub releases of this
 * repository. The main-process `UpdateService` owns the state machine; the renderer only
 * renders `UpdateStatus` and calls the `IpcApi.updates` methods.
 */

export type UpdateState =
  /** Development run or a build that cannot update itself; the updater is never touched. */
  | 'unsupported'
  /** Checking is switched off by the system policy (`settings.updates.enabled: false`). */
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  /** Downloaded; `install()` restarts into the new version. */
  | 'ready'
  /** System install: the daemon is applying the downloaded update (may take a minute). */
  | 'installing'
  | 'error';

/**
 * How the running binary was installed; decides what "update" can mean. `system`: the unpacked
 * app under `/opt/rpchat/current` (see docs/system-integration.md), updated by the daemon.
 */
export type UpdatePackaging = 'appimage' | 'deb' | 'dev' | 'other' | 'system';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
  /** 0..100 while `downloading`. */
  progressPercent?: number;
  error?: string;
  /** ISO time of the last completed check (successful or not). */
  checkedAt?: string;
  packaging: UpdatePackaging;
  /** AppImage in a writable location, or a system install whose daemon can apply updates: the update can be downloaded and installed from here. */
  canInstallInPlace: boolean;
  /** `packaging === 'system'`: what the daemon reports about the install. */
  systemInstall?: { dir: string; daemonConnected: boolean; daemonSupportsUpdates: boolean; current?: string; previous?: string };
  /** Human-readable explanation for `unsupported` / `disabled` / a `deb` install. */
  reason?: string;
  /** Whether the policy file forces any `updates.*` setting. */
  managed: boolean;
}

/** Repository whose releases carry the update feed (`latest-linux.yml` + AppImage). */
export const UPDATE_REPO = { owner: '0xbeef1eaf', repo: 'RPChat' } as const;

/** Release page for a given version tag (used for package installs, which are only notified). */
export function releasePageUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/${tag}`;
}
