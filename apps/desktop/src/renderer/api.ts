import type { IpcApi } from '@rp/shared';

/**
 * Typed accessor for the bridge the preload script exposes as `window.rp`.
 * Throws a clear error when the page is loaded outside Electron (e.g. a plain
 * browser during development), instead of a confusing `undefined` access.
 */
export function api(): IpcApi {
  const rp = (globalThis as { rp?: IpcApi }).rp;
  if (!rp) {
    throw new Error('window.rp is not available: the preload script did not run (not inside Electron?)');
  }
  return rp;
}

export function hasApi(): boolean {
  return Boolean((globalThis as { rp?: IpcApi }).rp);
}

/** Normalise anything thrown across IPC into a human-readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Electron prefixes errors from ipcMain.handle with the channel name.
    return err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
