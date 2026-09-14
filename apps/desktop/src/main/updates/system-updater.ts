/**
 * `electron-updater` for the system install (docs/system-integration.md "System install"): the
 * app runs unpacked from `/opt/rp-code/current`, so there is no `APPIMAGE` environment variable
 * (`AppImageUpdater` would refuse to check and to download) and no old AppImage to download a
 * delta against (so it is always a full download). Installing is not electron-updater's job
 * here either: `UpdateService.install` hands the downloaded file to the `rp-coded` daemon,
 * which verifies and swaps it in; `quitAndInstall`/`autoInstallOnAppQuit` are never used.
 *
 * Only the download step is overridden (`doDownloadUpdate` is a protected extension point);
 * checking, the private GitHub provider, caching under `~/.cache/rp-code-updater/pending` and
 * the `update-downloaded` event (with `downloadedFile` and the manifest's `sha512`) are the
 * library's own.
 */
import { chmod } from 'node:fs/promises';
import { AppImageUpdater } from 'electron-updater';
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater';
import { findFile } from 'electron-updater/out/providers/Provider';

/** `AppUpdater.httpExecutor` exists at runtime but is not part of the typings (the options are the `task` callback's, passed through). */
interface HttpDownloader {
  httpExecutor: { download(url: URL, destination: string, options: object): Promise<string> };
}

export class SystemInstallUpdater extends AppImageUpdater {
  constructor() {
    super(null);
    this.autoInstallOnAppQuit = false;
    this.disableDifferentialDownload = true;
  }

  /** No `APPIMAGE` check: a packaged build is enough (the AppImage check is what the base class adds). */
  override isUpdaterActive(): boolean {
    return this.app.isPackaged || this.forceDevUpdateConfig;
  }

  /** Full download of the release's AppImage into the updater cache (no delta: there is no old AppImage). */
  protected override doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<string[]> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
    const fileInfo = findFile(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), 'AppImage', ['rpm', 'deb', 'pacman']);
    if (!fileInfo) return Promise.reject(new Error('The release has no AppImage to download'));
    return this.executeDownload({
      fileExtension: 'AppImage',
      fileInfo,
      downloadUpdateOptions,
      task: async (updateFile, downloadOptions) => {
        await (this as unknown as HttpDownloader).httpExecutor.download(fileInfo.url, updateFile, downloadOptions);
        await chmod(updateFile, 0o755);
      },
    });
  }

  /** Never used: the daemon installs. Guards against a stray `quitAndInstall`. */
  protected override doInstall(): boolean {
    this.dispatchError(new Error('A system install is updated by the rp-code daemon (Settings → Updates), not by replacing a file'));
    return false;
  }
}
