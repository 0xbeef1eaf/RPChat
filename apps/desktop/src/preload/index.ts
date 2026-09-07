import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi } from '@rp/shared';
import { buildApi } from './api.js';

/**
 * `window.rp` = the IpcApi plus one preload-only helper: `app.pathForFile(file)`
 * turns a dropped/picked `File` into its absolute path (for `editor.addMediaFiles`).
 */
export type PreloadApi = IpcApi & { app: IpcApi['app'] & { pathForFile(file: File): string } };

const api = buildApi(ipcRenderer) as PreloadApi;
api.app.pathForFile = (file: File): string => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('rp', api);
