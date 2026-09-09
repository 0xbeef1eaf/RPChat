/**
 * In-place application updates (Linux AppImage) from the private GitHub releases of this
 * repository. The main-process `UpdateService` owns the state machine; the renderer only
 * renders `UpdateStatus` and calls the `IpcApi.updates` methods.
 */

export type UpdateState =
  /** Development run or a build that cannot update itself; the updater is never touched. */
  | 'unsupported'
  /** Checking is switched off by the system policy (`settings.updates.enabled: false`). */
  | 'disabled'
  /** No GitHub token stored yet; the private release feed cannot be read. */
  | 'no-token'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  /** Downloaded; `install()` restarts into the new version. */
  | 'ready'
  | 'error';

/** How the running binary was installed; decides what "update" can mean. */
export type UpdatePackaging = 'appimage' | 'deb' | 'dev' | 'other';

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
  /** AppImage in a writable location: the update can be downloaded and swapped in place. */
  canInstallInPlace: boolean;
  tokenPresent: boolean;
  /** Where the token lives: encrypted through the OS keyring (`safeStorage`) or a 0600 plaintext file. */
  tokenStorage: 'keyring' | 'file' | 'none';
  /** Human-readable explanation for `unsupported` / `disabled` / a `deb` install. */
  reason?: string;
  /** Whether the policy file forces any `updates.*` setting. */
  managed: boolean;
}

/** Repository whose releases carry the update feed (`latest-linux.yml` + AppImage). */
export const UPDATE_REPO = { owner: '0xbeef1eaf', repo: 'llm-rp-code' } as const;

/** Release page for a given version tag (used for package installs, which are only notified). */
export function releasePageUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/${tag}`;
}

/** Where to create the fine-grained personal access token (read-only Contents on the repository). */
export const UPDATE_TOKEN_HELP_URL = 'https://github.com/settings/personal-access-tokens';
