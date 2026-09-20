/**
 * Electron main process entry: app lifecycle, Wayland switches, single
 * instance, the `rp-asset://` protocol, CSP headers, engine + IPC wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, nativeImage, protocol, session } from 'electron';
import { ASSET_PROTOCOL, IPC_EVENT_CHANNELS } from '@rp/shared';
import type { ChatMessage, UpdateStatus } from '@rp/shared';
import { handleAssetRequest } from './asset-protocol.js';
import { isHyprland } from './display/layers.js';
import { createApp } from './engine.js';
import type { AppServices } from './engine.js';
import { applyDevGuard, refusalMessage } from './dev-guard.js';
import { isBrowserSmokeRun, isSmokeRun, runBrowserSmoke, runSmokeTurn, smokeEnableModelTraffic, smokeLoadPlugin } from './dev-mode.js';
import { registerIpc } from './ipc.js';
import { createLogger } from './logger.js';
import { trayMenuTemplate } from './quit-guard.js';
import { WindowManager } from './windows.js';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** apps/desktop in a dev checkout, the asar root when packaged. */
const APP_ROOT = path.resolve(OUT_DIR, '..');
/**
 * `dev.allow: false` in the root-owned policy (dev-guard.ts): the development switches are deleted
 * from the environment here, and a launch asking for an inspector flag is refused (`app.exit`
 * ends the process there and then). This runs before anything at all has read the environment —
 * the logger's `RP_DEBUG`, `RP_USER_DATA` below, the window manager's `ELECTRON_RENDERER_URL`,
 * the engine's paths — so everything after this line sees an environment the policy has vetted.
 */
const devGuard = applyDevGuard({ logger: console });
if (devGuard.refuse) {
  console.error(refusalMessage(devGuard.refusedFlags));
  app.exit(1);
}
const logger = createLogger();
const env = process.env;
/** `rpchat --hidden` (autostart): start minimized to the tray, no window until Show. */
const START_HIDDEN = process.argv.includes('--hidden');
let tray: Tray | undefined;
/** Set by the tray's Quit (and before-quit) so the close-to-tray handler lets the window close. */
let quitting = false;

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

/**
 * esbuild spawns a platform binary; inside a packaged app that binary lives in the asar, which
 * cannot be executed, so point esbuild at the `app.asar.unpacked` copy (electron-builder's
 * `asarUnpack` keeps it there). No-op in development or when already configured.
 */
function configureEsbuildBinary(): void {
  if (process.env.ESBUILD_BINARY_PATH || !app.isPackaged) return;
  const platformKey = `${process.platform}-${process.arch}`;
  const subpath = process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  const candidate = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', platformKey, subpath);
  if (fs.existsSync(candidate)) process.env.ESBUILD_BINARY_PATH = candidate;
}

async function main(): Promise<void> {
  let services: AppServices | undefined;
  let stopping = false;
  configureEsbuildBinary();

  const windows = new WindowManager({
    outDir: OUT_DIR,
    ...(env.ELECTRON_RENDERER_URL ? { rendererUrl: env.ELECTRON_RENDERER_URL } : {}),
    devTools: devGuard.rules.devTools,
    logger,
    onMainClosed: () => {
      // Questions asked in windows of their own outlive the chat window; only those that fell
      // back to its in-app modal go away with it.
      const inMainWindow = (id: string): boolean => !windows.hasPromptWindow(id);
      services?.permissionPrompts.rejectAll(inMainWindow);
      services?.uiPrompts.rejectAll(inMainWindow);
    },
    prepareWindow: (title) => services?.prepareWindow(title) ?? Promise.resolve(),
    onPromptDismissed: (id) => {
      // Closing the window is a dismissal: deny the permission, cancel the question.
      services?.permissionPrompts.respond(id, 'deny');
      services?.uiPrompts.respond(id, null);
    },
  });

  // Running `rpchat` while it is already up (e.g. after an autostart with --hidden) shows it.
  app.on('second-instance', () => {
    const win = windows.getMainWindow() ?? windows.createMainWindow();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.on('window-all-closed', () => {
    // With a tray icon the app keeps running in the background; without one (tray unavailable)
    // closing quits — unless the policy forbids quitting, in which case the app stays up without a window.
    if (process.platform !== 'darwin' && !tray && (services?.quitGuard.allowQuit ?? true)) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && services) windows.createMainWindow();
  });

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    services?.updates.stop();
    await services?.stop();
  };
  app.on('before-quit', (event) => {
    if (stopping || !services) {
      quitting = true;
      return;
    }
    // `app.allowQuit: false`: every quit (Ctrl+Q from the default menu, `app.quit()` from anywhere)
    // is cancelled unless it was authorised internally (update restart) — see quit-guard.ts.
    if (services.quitGuard.beforeQuit() === 'block') {
      event.preventDefault();
      quitting = false;
      return;
    }
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });

  await app.whenReady();
  installCsp(Boolean(env.ELECTRON_RENDERER_URL));

  const version = resolveAppVersion();
  try {
    services = await createApp({ userData: app.getPath('userData'), appRoot: APP_ROOT, appVersion: version, windows, logger, env, dev: devGuard.rules });
  } catch (err) {
    logger.error('[main] engine failed to start', err);
    app.exit(1);
    return;
  }
  const { engine } = services;

  const active = services;
  protocol.handle(ASSET_PROTOCOL, (request) => handleAssetRequest(request, { packRootFor: (packId) => active.packRootFor(packId), logger }));

  // `app.allowQuit` from the policy: applied now (before the tray exists so its menu is right from
  // the start), on every window show/close, and whenever the watcher sees the policy change — an
  // edited file included, since the watcher polls for one.
  const refreshQuitPolicy = (): Promise<void> =>
    active.policy
      .current()
      .then((state) => {
        active.quitGuard.apply(state.policy);
      })
      .catch(() => undefined);
  await refreshQuitPolicy();
  active.policy.onChange((state) => active.quitGuard.apply(state.policy));
  // Tell the daemon how to bring this launch back (Linux only: that is where rpchatd runs). The
  // daemon acts on it only while the policy says `app.allowQuit: false` for this user.
  if (process.platform === 'linux') active.keepalive.start();

  // Which conversation the user is actually looking at: the UI reports it, and an unprompted
  // message is announced unless it lands in that one.
  let visibleSession: string | null = null;
  registerIpc({ services, windows, logger, version, setVisibleSession: (id) => (visibleSession = id) });
  if (isSmokeRun(env)) await smokeEnableModelTraffic(engine);
  // The tray is always there (not only for --hidden): it is how the app stays alive for timers,
  // self-wakes and the browser bridge while the window is closed, and how you quit.
  tray = createTray(windows, active, () => {
    if (!active.quitGuard.mayQuit) return;
    quitting = true;
    void shutdown().finally(() => app.quit());
  });
  const win = windows.createMainWindow({ hidden: START_HIDDEN });
  installCloseToTray(win, active);
  win.once('ready-to-show', () => {
    logger.info(`[main] window ${START_HIDDEN ? 'ready (hidden, tray)' : 'opened'} (userData: ${app.getPath('userData')})`);
    active.updates.start();
  });
  watchUpdateReady(active, windows);
  watchUnpromptedMessages(active, windows, () => visibleSession);
  logger.info(`[main] rpchat ${version} ready; ${engine.packs.characters().length} character(s) available`);
  if (isBrowserSmokeRun(env)) {
    setTimeout(() => void runBrowserSmoke({ engine: active.engine, loopback: active.loopback, browser: active.browser, senses: active.senses, userData: app.getPath('userData') }, logger, env), 500);
  } else if (isSmokeRun(env)) {
    await smokeLoadPlugin(active.plugins, APP_ROOT, logger, env);
    setTimeout(
      () =>
        void runSmokeTurn(active.engine, logger, () => active.media.list(), async () => {
          // Give the editor tour a project to open: the installed Luna pack copied into the workspace.
          const packs = await active.engine.packs.list();
          const luna = packs.find((p) => p.packId === 'com.example.luna');
          if (luna && !(await active.editor.listProjects()).some((p) => p.packId === luna.packId)) await active.editor.importInstalled(luna.packId);
        }),
      1500,
    );
  }
}

/**
 * Announce a downloaded update once: a native dialog when the window is visible (Restart now /
 * Later), otherwise a notification whose click brings the window back (tray mode).
 */
function watchUpdateReady(services: AppServices, windows: WindowManager): void {
  let announced: string | undefined;
  services.updates.subscribe((status: UpdateStatus) => {
    if (status.state !== 'ready' || !status.latestVersion || announced === status.latestVersion) return;
    announced = status.latestVersion;
    const version = status.latestVersion;
    const win = windows.getMainWindow();
    if (win && win.isVisible()) {
      void dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'Update ready',
          message: `Update to ${version} is ready`,
          detail:
            status.packaging === 'system'
              ? `rpchat ${version} has been downloaded. Restart now to have the system service install it (the previous version is kept), or later from Settings → Updates.`
              : `rpchat ${version} has been downloaded. Restart now to apply it, or later from Settings → Updates (it is also applied when you quit).`,
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((r) => {
          if (r.response === 0) return services.updates.install();
          return undefined;
        })
        .catch((err: unknown) => logger.warn('[updates] restart failed', err));
      return;
    }
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: 'rpchat', body: `rpchat ${version} is ready to install` });
    note.on('click', () => {
      const w = windows.getMainWindow() ?? windows.createMainWindow();
      w.show();
      w.focus();
    });
    note.show();
  });
}

/**
 * A character speaking on its own initiative (sdk.llm.wake, timers, behaviours) gets a desktop
 * notification unless the user is looking at that very conversation, so the message reaches them
 * like a text from a friend rather than sitting unseen in the tray — or, just as easily missed,
 * in a chat view behind Settings. `visibleSession` is what the UI last reported.
 */
function watchUnpromptedMessages(services: AppServices, windows: WindowManager, visibleSession: () => string | null): void {
  const pending = new Map<string, ChatMessage>(); // sessionId → latest unprompted turn reply, announced when the turn ends
  const shouldNotify = (sessionId: string): boolean => {
    const win = windows.getMainWindow();
    const watching = Boolean(win && win.isVisible() && win.isFocused()) && visibleSession() === sessionId;
    return !watching && Notification.isSupported();
  };
  const announce = (m: ChatMessage): void => {
    const text = m.content.trim();
    if (text.length === 0 || !shouldNotify(m.sessionId)) return;
    void services.engine.sessions
      .get(m.sessionId)
      .then((session) => {
        const character = session ? services.engine.packs.characters().find((c) => c.ref === session.characterRef) : undefined;
        const note = new Notification({ title: character?.name ?? 'rpchat', body: text.length > 240 ? `${text.slice(0, 237)}…` : text });
        note.on('click', () => {
          const w = windows.getMainWindow() ?? windows.createMainWindow();
          w.show();
          w.focus();
          // Bring the user to the conversation the notification is about, not just to the app.
          windows.sendToMain(IPC_EVENT_CHANNELS.showSession, m.sessionId);
        });
        note.show();
      })
      .catch((err: unknown) => logger.debug('[main] unprompted-message notification skipped', err));
  };
  services.engine.events.on('chat', (event) => {
    switch (event.type) {
      case 'message-added':
        // sdk.chat.emote from a behaviour or timer script is complete when added.
        if (event.message.role === 'assistant' && event.message.origin === 'behaviour') announce(event.message);
        return;
      case 'message-updated':
        // A self-wake turn streams into its reply; remember it and announce once the turn is over.
        if (event.message.role === 'assistant' && event.message.origin === 'timer') pending.set(event.sessionId, event.message);
        return;
      case 'turn-finished': {
        const m = pending.get(event.sessionId);
        pending.delete(event.sessionId);
        if (m) announce(m);
        return;
      }
      default:
        return;
    }
  });
}

/** Cached `settings.closeToTray` (the close handler must decide synchronously); refreshed on every settings read. */
let closeToTray = true;

/**
 * Closing the main window hides it to the tray when `settings.closeToTray` is on and a tray
 * exists; the tray menu's Quit (or any app quit) really closes it. While the policy forbids
 * quitting the window always hides — with or without a tray, whatever `closeToTray` says —
 * because letting it close would end the app. Applied to every main window.
 */
function installCloseToTray(win: BrowserWindow, services: AppServices): void {
  const refresh = (): void => {
    // Reading the settings goes through the policy watcher, so this also notices policy edits.
    void services.engine.settings
      .get()
      .then((settings) => {
        closeToTray = settings.closeToTray !== false;
        return services.policy.current();
      })
      .then((state) => {
        services.quitGuard.apply(state.policy);
      })
      .catch(() => undefined);
  };
  refresh();
  win.on('close', (event) => {
    if (quitting) return;
    if (!services.quitGuard.allowQuit) {
      event.preventDefault();
      win.hide();
      logger.info('[main] window hidden instead of closed: quitting is disabled by policy');
      refresh();
      return;
    }
    if (!tray || !closeToTray) return;
    event.preventDefault();
    win.hide();
    refresh();
  });
  win.on('show', refresh);
}

/** Tray icon with Show/Hide / Check for updates / Quit (no Quit while the policy forbids quitting); present on every launch. */
function createTray(windows: WindowManager, services: AppServices, quit: () => void): Tray | undefined {
  try {
    const iconFile = [path.join(APP_ROOT, 'resources', 'tray.png'), path.join(process.resourcesPath ?? '', 'tray.png')].find((f) => fs.existsSync(f));
    const icon = iconFile ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
    const t = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 22, height: 22 }));
    t.setToolTip('rpchat');
    const show = (): void => {
      const existing = windows.getMainWindow();
      const w = existing ?? windows.createMainWindow();
      if (!existing) installCloseToTray(w, services);
      w.show();
      w.focus();
    };
    const toggle = (): void => {
      const w = windows.getMainWindow();
      if (w && w.isVisible() && w.isFocused()) w.hide();
      else show();
    };
    const checkForUpdates = (): void => {
      void services.updates
        .check()
        .then((status) => {
          if (status.state === 'available' || status.state === 'downloading') {
            if (Notification.isSupported()) new Notification({ title: 'rpchat', body: `rpchat ${status.latestVersion ?? ''} is available${status.canInstallInPlace ? ' and downloading' : ''}` }).show();
          } else if (status.state === 'up-to-date' && Notification.isSupported()) new Notification({ title: 'rpchat', body: `rpchat ${status.currentVersion} is up to date` }).show();
          else if (status.state === 'error') logger.warn(`[updates] ${status.error ?? 'check failed'}`);
        })
        .catch((err: unknown) => {
          logger.warn('[updates] tray check failed', err);
          show();
        });
    };
    const actions: Record<'show' | 'hide' | 'check-updates' | 'quit', () => void> = { show, hide: () => windows.getMainWindow()?.hide(), 'check-updates': checkForUpdates, quit };
    const buildMenu = (): Menu => Menu.buildFromTemplate(trayMenuTemplate(services.quitGuard.allowQuit).map((item) => ('type' in item ? item : { label: item.label, click: actions[item.id] })));
    t.setContextMenu(buildMenu());
    // The policy can change while running (root edits the file): rebuild so Quit appears/disappears.
    services.quitGuard.onChange((policy) => {
      t.setContextMenu(buildMenu());
      logger.info(`[main] tray menu rebuilt: quitting ${policy.allowQuit ? 'allowed' : 'disabled by policy'}`);
    });
    t.on('click', toggle);
    logger.info(`[main] tray icon created (${iconFile ? path.basename(iconFile) : 'no icon file'})`);
    return t;
  } catch (err) {
    logger.warn('[main] tray icon unavailable', err);
    return undefined;
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
