import { contextBridge, ipcRenderer } from 'electron';
import { buildApi } from './api.js';

contextBridge.exposeInMainWorld('rp', buildApi(ipcRenderer));
