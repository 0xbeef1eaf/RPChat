/**
 * Electron main process entry: app lifecycle, Wayland switches, single
 * instance, the `rp-asset://` protocol, CSP headers, engine + IPC wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, protocol, session } from 'electron';
import { ASSET_PROTOCOL } from '@rp/shared';
import { handleAssetRequest } from './asset-protocol.js';
import { isHyprland } from './display/layers.js';
import { createApp } from './engine.js';
import type { AppServices } from './engine.js';
import { isSmokeRun, runSmokeTurn } from './dev-mode.js';
import { registerIpc } from './ipc.js';
import { createLogger } from './logger.js';
import { WindowManager } from './windows.js';

const logger = createLogger();
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** apps/desktop in a dev checkout, the asar root when packaged. */
const APP_ROOT = path.resolve(OUT_DIR, '..');
const env = process.env;

/** `app.getVersion()` is Electron's own version when launched as `electron out/main/index.js`; prefer our package.json. */
function resolveAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (pkg.name === '@rp/desktop' && typeof pkg.version === 'string') return pkg.version;
  } catch {
    /* fall through */
  }
  return app.getVersion();
}

// ---- before ready ---------------------------------------------------------

if (env.RP_USER_DATA) app.setPath('userData', path.resolve(env.RP_USER_DATA));

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
  if (isHyprland(env) || env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'wayland');
}

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
]);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  void main();
}

// ---- lifecycle --------------------------------------------------------------

async function main(): Promise<void> {
  let services: AppServices | undefined;
  let stopping = false;

  const windows = new WindowManager({
    outDir: OUT_DIR,
    ...(env.ELECTRON_RENDERER_URL ? { rendererUrl: env.ELECTRON_RENDERER_URL } : {}),
    logger,
    onMainClosed: () => {
      services?.permissionPrompts.rejectAll();
      services?.uiPrompts.rejectAll();
    },
  });

  app.on('second-instance', () => {
    const win = windows.getMainWindow() ?? windows.createMainWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && services) windows.createMainWindow();
  });

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await services?.stop();
  };
  app.on('before-quit', (event) => {
    if (stopping || !services) return;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });

  await app.whenReady();
  installCsp(Boolean(env.ELECTRON_RENDERER_URL));

  const version = resolveAppVersion();
  try {
    services = await createApp({ userData: app.getPath('userData'), appRoot: APP_ROOT, appVersion: version, windows, logger, env });
  } catch (err) {
    logger.error('[main] engine failed to start', err);
    app.exit(1);
    return;
  }
  const { engine } = services;

  const active = services;
  protocol.handle(ASSET_PROTOCOL, (request) => handleAssetRequest(request, { packRootFor: (packId) => active.packRootFor(packId), logger }));

  registerIpc({ services, windows, logger, version });
  const win = windows.createMainWindow();
  win.once('ready-to-show', () => logger.info(`[main] window opened (userData: ${app.getPath('userData')})`));
  logger.info(`[main] rp-code ${version} ready; ${engine.packs.characters().length} character(s) available`);
  if (isSmokeRun(env)) {
    setTimeout(() => void runSmokeTurn(active.engine, logger, () => active.media.list()), 1500);
  }
}

/** Strict CSP for our renderer windows; relaxed only for Vite's dev server (inline HMR client, websocket). */
function installCsp(dev: boolean): void {
  const policy = [
    `default-src 'self' ${ASSET_PROTOCOL}:`,
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${ASSET_PROTOCOL}: 'self' data: blob:`,
    `media-src ${ASSET_PROTOCOL}: 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'${dev ? ' ws: http://localhost:* http://127.0.0.1:*' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'none'`,
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-security-policy') delete headers[key];
      headers['Content-Security-Policy'] = [policy];
    }
    callback({ responseHeaders: headers });
  });
}
