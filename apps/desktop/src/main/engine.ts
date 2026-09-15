/** Builds the `@rp/core` Engine with the desktop's storage, sandbox, display backend and host handlers. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Notification, app, dialog, safeStorage, screen, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { Engine, FileStorage } from '@rp/core';
import type { Logger, ProviderFactory } from '@rp/core';
import { createStandardRegistry } from '@rp/sdk';
import { QuickJsRunner } from '@rp/sandbox';
import { createProvider } from '@rp/llm';
import type { AppSettings, LoadedPack, PermissionDecision, PermissionRequest, Storage, UiPromptAnswer, UiPromptRequest } from '@rp/shared';
import { SYSTEM_INSTALL_DIR } from '@rp/shared';
import { IPC_EVENT_CHANNELS, RpError, assetUrl, parseCharacterRef } from '@rp/shared';
import { defaultSettings, mergeSettings } from '@rp/core';
import { hasExecutable } from './commands.js';
import { AvatarHandler } from './capabilities/avatar.js';
import { BrowserHandler } from './capabilities/browser.js';
import { CalendarHandler } from './capabilities/calendar.js';
import { DesktopHandler } from './capabilities/desktop.js';
import { FilesHandler } from './capabilities/files.js';
import { MessagingHandler } from './capabilities/messaging.js';
import { PresenceHandler } from './capabilities/presence.js';
import { ScreenHandler } from './capabilities/screen.js';
import { TTS_PACK_ID, VOICES_DIRNAME, VoiceHandler, readVoiceModels } from './capabilities/voice.js';
import { findSherpaTts } from './capabilities/voice-models.js';
import { VOICE_BANK_DIRNAME, VOICE_BANK_PACK_ID, VoiceBank } from './capabilities/voice-bank.js';
import { WebHandler } from './capabilities/web.js';
import { WidgetsHandler } from './capabilities/widgets.js';
import { electronCapturer } from './capture.js';
import { ProjectRegistry, keyFromAssetHost } from './editor/registry.js';
import { EditorService } from './editor/service.js';
import { electronImageReader } from './editor/images.js';
import { MediaTagger } from './editor/tagger.js';
import { PluginRegistry } from './plugins/registry.js';
import { PluginService } from './plugins/service.js';
import { DaemonClient } from './system/daemon-client.js';
import { SystemIntegration } from './system/integration.js';
import { PolicyWatcher, applyPolicy, stripManagedPatch } from './system/policy.js';
import { KeepaliveLink } from './system/keepalive-link.js';
import { QuitGuard, launchSpec } from './quit-guard.js';
import { UpdateService } from './updates/service.js';
import type { SystemInstallDeps, UpdaterLike } from './updates/service.js';
import { SystemInstallUpdater } from './updates/system-updater.js';
import { isSystemInstallExec } from './system/integration.js';
import { createHyprTransport } from './display/hyprland.js';
import type { HyprTransport } from './display/hyprland.js';
import { detectWindowSystem, isHyprland } from './display/layers.js';
import { phase2, unavailable } from './phase2.js';
import { createSenses } from './senses/index.js';
import type { Senses } from './senses/index.js';
import { CommandRunner } from './capabilities/commands-runner.js';
import { DisplayHandler } from './capabilities/display.js';
import { InputHandler } from './capabilities/input.js';
import { MediaHandler, MediaManager } from './capabilities/media.js';
import { SystemHandler } from './capabilities/system.js';
import { UiHandler } from './capabilities/ui.js';
import { WallpaperHandler } from './capabilities/wallpaper.js';
import type { DisplayBackend } from './display/backend.js';
import { selectBackend } from './display/backend.js';
import { findHelperBinary } from './display/helper-process.js';
import { ensureExamplePack, ensureMockProvider, isMockLlm, isSmokeRun, mockProviderFactory } from './dev-mode.js';
import { LoopbackServer } from './loopback.js';
import { BrowserBridge } from './browser/bridge.js';
import { EXTENSION_KEY_FILENAME, EXTENSION_ROUTE_PREFIX, ExtensionService } from './browser/extension.js';
import { PendingPrompts } from './prompts.js';
import type { WindowManager } from './windows.js';

export interface AppServices {
  engine: Engine;
  media: MediaManager;
  senses: Senses;
  editor: EditorService;
  plugins: PluginService;
  system: SystemIntegration;
  updates: UpdateService;
  policy: PolicyWatcher;
  daemon: DaemonClient;
  /** `app.allowQuit` enforcement: tray/close/before-quit decisions and the signal handlers (quit-guard.ts). */
  quitGuard: QuitGuard;
  /** The long-lived relaunch registration with rp-coded (unregistered before an authorised quit). */
  keepalive: KeepaliveLink;
  commands: CommandRunner;
  permissionPrompts: PendingPrompts<PermissionDecision>;
  uiPrompts: PendingPrompts<UiPromptAnswer>;
  backend(): DisplayBackend;
  /** Re-select the display backend after the setting changed. */
  selectBackend(setting: AppSettings['displayBackend']): Promise<void>;
  /** Always started: it carries the browser-extension bridge as well as the overlay media pages. */
  loopback: LoopbackServer;
  /** Browser extension bridge and the bundled extension it serves (docs/browser-extension.md). */
  browser: BrowserBridge;
  extension: ExtensionService;
  /** Save `settings.browser.bridgePort` and rebind the loopback server. */
  setBridgePort(port: number): Promise<void>;
  /** Save `settings.browser.homePage` ('' clears it) and push it to the connected extension. */
  setHomePage(url: string): Promise<void>;
  /** Absolute path of the bundled sample image (copied out of the asar when needed). */
  sampleImage(): Promise<string>;
  /** Root directory served for a pack id by rp-asset:// (installed packs + app-generated roots). */
  packRootFor(packId: string): string | undefined;
  stop(): Promise<void>;
}

export interface CreateAppOptions {
  userData: string;
  /** Directory containing the app's package.json and `resources/` (dev checkout: apps/desktop). */
  appRoot: string;
  appVersion: string;
  windows: WindowManager;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

export async function createApp(opts: CreateAppOptions): Promise<AppServices> {
  const env = opts.env ?? process.env;
  const { logger, windows } = opts;
  // Declared up front: handler closures reference it before the Engine is constructed.
  let engine: Engine;
  const dataDir = path.join(opts.userData, 'data');
  const packsDir = path.join(opts.userData, 'packs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(packsDir, { recursive: true });
  // `as Storage`: @rp/core's FileStorage gains `subscriptions` with the phase-2 core work.
  const storage = new FileStorage(dataDir) as unknown as Storage;
  const stored = mergeSettings(await storage.settings.get().catch(() => defaultSettings()));
  const hypr: HyprTransport | undefined = process.platform === 'linux' && isHyprland(env) ? createHyprTransport(env, logger) : undefined;
  const windowSystem = detectWindowSystem(env);
  /** Extra roots served by rp-asset:// besides installed packs (generated speech files). */
  const ttsDir = path.join(opts.userData, 'tts');
  /** Unpacked sherpa-onnx voice models, one subdirectory each (docs/spec/living.md §4). */
  const voicesDir = path.join(opts.userData, VOICES_DIRNAME);
  /** Downloaded kyutai reference clips and their cached sample sentences (the editor's voice picker). */
  const voiceBankDir = path.join(opts.userData, VOICE_BANK_DIRNAME);
  const extraRoots: Record<string, string> = { [TTS_PACK_ID]: ttsDir, [VOICE_BANK_PACK_ID]: path.join(voiceBankDir, 'previews') };
  const registry = new ProjectRegistry(path.join(dataDir, 'editor-projects.json'));
  const packRootFor = (packId: string): string | undefined => {
    const editorKey = keyFromAssetHost(packId);
    if (editorKey) return registry.get(editorKey)?.dir;
    return extraRoots[packId] ?? engine.packs.tryGetLoaded(packId)?.root;
  };

  // ---- loopback server (overlay media pages + browser extension bridge) ----------------
  const bridgePortEnv = Number(env.RP_BROWSER_BRIDGE_PORT);
  const loopback = new LoopbackServer({
    rendererDir: windows.rendererDir,
    ...(env.ELECTRON_RENDERER_URL ? { devServerUrl: env.ELECTRON_RENDERER_URL } : {}),
    assets: { packRootFor, logger },
    logger,
    port: Number.isInteger(bridgePortEnv) && bridgePortEnv > 0 ? bridgePortEnv : stored.browser.bridgePort,
  });
  await loopback.start();
  const loopbackFor = async (): Promise<LoopbackServer> => loopback;
  const resourcesDirs = [...(app.isPackaged ? [process.resourcesPath] : []), path.join(opts.appRoot, 'resources'), path.join(app.getAppPath(), 'resources')];

  // ---- display backend ----------------------------------------------------
  const backendContext = {
    env,
    logger,
    screen,
    createWindow: (title: string) => windows.createOverlayWindow(title),
    findHelper: () =>
      findHelperBinary({
        env,
        resourcesDirs,
        exists: (file) => {
          try {
            return fs.statSync(file).isFile();
          } catch {
            return false;
          }
        },
        onPath: (name) => hasExecutable(name, env),
      }),
    loopback: loopbackFor,
    ...(hypr ? { hyprTransport: hypr } : {}),
  };
  let backend: DisplayBackend = await selectBackend(stored.displayBackend, backendContext);
  let backendSetting = stored.displayBackend;
  logger.info(`[display] backend: ${backend.name} (${JSON.stringify(backend.info().supports)})`);

  // ---- prompts ------------------------------------------------------------
  // Every question gets a focused window of its own; the in-app modal is the fallback for when
  // one cannot be opened. Answering (or timing out) closes the window it was asked in.
  const closePromptWindow = (id: string): void => windows.closePromptWindow(id);
  const permissionPrompts = new PendingPrompts<PermissionDecision>({ fallback: 'deny', onSettled: closePromptWindow });
  const uiPrompts = new PendingPrompts<UiPromptAnswer>({ fallback: null, onSettled: closePromptWindow });
  const characterOf = (packId: string, characterId: string): { name: string; packName: string } => {
    const found = engine.packs.characters().find((c) => c.ref === `${packId}/${characterId}`);
    return { name: found?.name ?? characterId, packName: found?.packName ?? packId };
  };
  const permissionPrompter = (request: PermissionRequest): Promise<PermissionDecision> =>
    permissionPrompts.ask(request.requestId, () => {
      const who = characterOf(request.context.packId, request.context.characterId);
      return (
        windows.openPromptWindow({ kind: 'permission', request, characterName: who.name, packName: who.packName }) ||
        windows.sendToMain(IPC_EVENT_CHANNELS.permissionRequest, request)
      );
    });

  // ---- handlers -----------------------------------------------------------
  const settingsOf = (): Promise<AppSettings> => engine.settings.get();
  const commands = new CommandRunner({ settings: settingsOf, logger, env });
  const packs = { getLoaded: (packId: string): LoadedPack => engine.packs.getLoaded(packId) };
  // ---- phase 2 senses (created early: media clicks/closes are host events too) ----------
  const senses = createSenses({ settings: settingsOf, commands, env, ...(hypr ? { hypr } : {}), logger });
  const emit = (event: Parameters<typeof senses.provider.push>[0]): void => senses.provider.push(event);
  const media = new MediaManager({ backend: () => backend, audioWindow: () => windows.audioWindow(), packs, settings: settingsOf, logger, emit });
  const ui = new UiHandler({
    prompts: uiPrompts,
    deliver: (request: UiPromptRequest) => windows.openPromptWindow({ kind: 'ui', prompt: request }) || windows.sendToMain(IPC_EVENT_CHANNELS.uiPrompt, request),
    characterName: (context): string => {
      try {
        return engine.packs.getCharacter(`${context.packId}/${context.characterId}`).character.definition.name;
      } catch {
        return context.characterId;
      }
    },
    logger,
  });
  const wallpaper = new WallpaperHandler({
    commands,
    packs,
    backend: () => backend,
    restoreFile: async () => (await settingsOf()).wallpaperRestoreFile,
    // The wallpaper read before the first change becomes the restore file, unless one is set.
    remember: async (file) => {
      if ((await settingsOf()).wallpaperRestoreFile.trim().length === 0) await engine.settings.update({ wallpaperRestoreFile: file });
    },
    logger,
  });
  // ---- browser extension bridge -----------------------------------------------------------
  const extension = new ExtensionService({ resourcesDirs, keyFile: path.join(opts.userData, EXTENSION_KEY_FILENAME), port: () => loopback.listeningPort, logger });
  loopback.route(EXTENSION_ROUTE_PREFIX, (req, res, url) => extension.handle(req, res, url));
  const browser = new BrowserBridge({
    trusted: async () => (await settingsOf()).browser.trustedExtensionIds,
    remember: async (id) => {
      const current = (await settingsOf()).browser;
      if (!current.trustedExtensionIds.includes(id)) await engine.settings.update({ browser: { ...current, trustedExtensionIds: [...current.trustedExtensionIds, id] } });
    },
    confirm: (id, browserName) => {
      const promptId = `browser-trust:${id}:${Date.now()}`;
      const request: UiPromptRequest = { promptId, sessionId: '', characterName: 'rp-code', kind: 'confirm', question: `Browser extension ${id} (${browserName}) wants to connect to rp-code — Allow?` };
      return uiPrompts.ask(promptId, () => windows.openPromptWindow({ kind: 'ui', prompt: request }) || windows.sendToMain(IPC_EVENT_CHANNELS.uiPrompt, request)).then((answer) => answer === true);
    },
    ports: () => ({ port: loopback.listeningPort, requested: loopback.requestedPort }),
    extension: { id: () => extension.id(), version: () => extension.version(), dir: () => extension.dir(), updateUrl: () => extension.updateUrl() },
    homePage: async () => (await settingsOf()).browser.homePage,
    logger,
    ...(isSmokeRun(env) ? { autoTrust: true } : {}),
  });
  loopback.onUpgrade(browser.upgradeHandler());
  // The home page lives in settings; the extension's copy (chrome.storage.local) follows on every connection.
  const pushHomePage = async (): Promise<void> => {
    if (!browser.connected) return;
    const url = (await settingsOf()).browser.homePage;
    await browser.request('home.set', { url: url || null }).catch((err: unknown) => logger.warn('[browser] could not push the home page to the extension', err));
  };
  let lastPushedTo: string | undefined;
  browser.onStatus((s) => {
    const key = s.connected ? `${s.extensionId ?? ''}` : undefined;
    if (key && key !== lastPushedTo) {
      lastPushedTo = key;
      void pushHomePage();
    } else if (!key) lastPushedTo = undefined;
  });
  const setHomePage = async (url: string): Promise<void> => {
    if (url !== '' && !/^https?:\/\//i.test(url)) throw new RpError('INVALID_ARGUMENT', 'The home page must be an http(s) URL (or empty to clear it)');
    const current = (await settingsOf()).browser;
    if (current.homePage !== url) await engine.settings.update({ browser: { ...current, homePage: url } });
    await pushHomePage();
  };
  // ---- system integration (Linux daemon + root-owned policy) --------------------
  const daemon = new DaemonClient({ ...(env.RP_DAEMON_SOCKET ? { socketPath: env.RP_DAEMON_SOCKET } : {}), logger });
  const policy = new PolicyWatcher(env.RP_POLICY_FILE, logger);
  const input = new InputHandler({ maxLockMs: async () => (await settingsOf()).maxInputLockMs, logger, ...(process.platform === 'linux' ? { daemon } : {}) });

  // ---- phase 2: handlers ---------------------------------------------------
  browser.onEvent((ev) => {
    if (ev.event !== 'tab-updated' || ev.data.status !== 'complete' || typeof ev.data.url !== 'string') return;
    emit({ name: 'browser-navigated', data: { tabId: ev.data.tabId, url: ev.data.url, title: ev.data.title ?? '' }, at: new Date().toISOString() });
  });
  const avatar = new AvatarHandler({ backend: () => backend, packs, emit, logger });
  const widgets = new WidgetsHandler({ backend: () => backend, emit, packs, defaultLayer: async () => ((await settingsOf()).mediaAlwaysOnTop ? 'top' : 'bottom') });
  const screenHandler = new ScreenHandler({
    backend: () => backend,
    commands,
    capturer: electronCapturer(),
    preferTemplate: () => windowSystem === 'wayland',
    tmpDir: path.join(opts.userData, 'tmp'),
    describeImage: (sessionId, png, question) => {
      const llm = phase2(engine).llm;
      if (!llm?.describeImage) throw unavailable('engine.llm.describeImage');
      return llm.describeImage(sessionId, png, question);
    },
    logger,
  });
  const findSherpa = (): string | undefined =>
    findSherpaTts({
      env,
      resourcesDirs,
      exists: (file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      },
      onPath: (name) => hasExecutable(name, env),
    });
  const voice = new VoiceHandler({
    commands,
    audioWindow: () => windows.audioWindow(),
    ttsDir,
    voicesDir,
    packs,
    voiceSettings: async () => (await settingsOf()).voice,
    findSherpa,
    logger,
  });
  const voiceBank = new VoiceBank({
    dir: voiceBankDir,
    models: () => readVoiceModels(voicesDir),
    findSherpa,
    numThreads: async () => (await settingsOf()).voice.numThreads,
    logger,
  });
  const desktop = new DesktopHandler({ commands, ...(hypr ? { hypr } : {}), launchAllowlist: async () => (await settingsOf()).desktop.launchAllowlist, logger });
  const files = new FilesHandler({ userData: opts.userData, openPath: (p) => shell.openPath(p) });
  const messaging = new MessagingHandler({ channels: async () => (await settingsOf()).messaging.channels, runCommand: (tpl, vars, label) => commands.runTemplate(tpl, vars, label) });
  const web = new WebHandler({ settings: async () => (await settingsOf()).web });
  const calendar = new CalendarHandler({ sources: async () => (await settingsOf()).senses.calendarSources, logger });

  const mock = isMockLlm(env);
  const providerFactory: ProviderFactory = mock ? mockProviderFactory() : createProvider;
  const tagger = new MediaTagger({
    resolveProvider: (providerId) => engine.settings.resolveProvider(providerId),
    providerFactory,
    readImage: electronImageReader(),
    logger,
  });

  const editor = new EditorService({
    userData: opts.userData,
    registry,
    packs: {
      install: (dir) => engine.packs.install(dir),
      tryGetLoaded: (packId) => engine.packs.tryGetLoaded(packId),
      installedIds: async () => (await engine.storage.packs.list()).map((p) => p.packId),
    },
    dialogs: {
      openDirectory: async (title) => {
        const r = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? undefined : r.filePaths[0];
      },
      openFiles: async (title, filters, multi) => {
        const r = await dialog.showOpenDialog({ title, filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] });
        return r.canceled ? [] : r.filePaths;
      },
      saveFile: async (title, defaultPath, filters) => {
        const r = await dialog.showSaveDialog({ title, defaultPath, filters });
        return r.canceled || !r.filePath ? undefined : r.filePath;
      },
    },
    reveal: (absolute) => shell.showItemInFolder(absolute),
    logger,
    tagger,
    voiceBank,
  });

  engine = new Engine({
    storage,
    registry: createStandardRegistry(),
    runner: new QuickJsRunner(),
    packsDir,
    providerFactory,
    hostHandlers: [
      new MediaHandler(media),
      ui,
      new SystemHandler({ home: os.homedir() }),
      new DisplayHandler(() => backend),
      wallpaper,
      new BrowserHandler({
        commands,
        bridge: browser,
        allowlist: async () => (await settingsOf()).web.allowlist,
        browserSettings: async () => (await settingsOf()).browser,
        setHomePage,
        characterName: (context) => characterOf(context.packId, context.characterId).name,
        packs,
        assetUrl: (packId, asset) => loopback.rewriteAssetUrl(assetUrl(packId, asset)),
      }),
      input,
      new PresenceHandler(senses.provider),
      screenHandler,
      calendar,
      web,
      avatar,
      widgets,
      voice,
      desktop,
      files,
      messaging,
    ],
    permissionPrompter,
    appVersion: opts.appVersion,
    logger,
    locale: app.getLocale(),
    // `senses` is the phase-2 `EngineOptions.senses` (SensesProvider); spread so older core builds ignore it.
    ...({ senses: senses.provider } as object),
  });

  // Every settings read (ours and core's) goes through the policy; updates cannot touch managed paths.
  const rawGet = engine.settings.get.bind(engine.settings);
  const rawUpdate = engine.settings.update.bind(engine.settings);
  engine.settings.get = async () => applyPolicy(await rawGet(), (await policy.current()).policy).settings;
  engine.settings.update = async (patch) => {
    const state = await policy.current();
    await rawUpdate(stripManagedPatch(patch ?? {}, state.managed));
    return engine.settings.get();
  };
  // System install (docs/system-integration.md): the executable runs from /opt/rp-code/current
  // (realpath, so a launch through the /usr/local/bin symlink counts) and the daemon applies updates.
  const execPathReal = ((): string => {
    try {
      return fs.realpathSync(process.execPath);
    } catch {
      return process.execPath;
    }
  })();
  const systemInstallDir = env.RP_SYSTEM_INSTALL_DIR ?? SYSTEM_INSTALL_DIR;
  const systemInstalled = process.platform === 'linux' && app.isPackaged && isSystemInstallExec(execPathReal, systemInstallDir);
  const system = new SystemIntegration({
    platform: process.platform,
    daemon,
    policy,
    resourcesDirs,
    appBin: env.APPIMAGE ?? process.execPath,
    appImage: Boolean(env.APPIMAGE),
    execPath: execPathReal,
    systemInstallDir,
    logger,
  });
  // `app.allowQuit`: the guard mirrors the policy (index.ts applies it on every policy read) and the
  // keepalive link tells the daemon how to bring this launch back (AppImage or bare executable).
  const quitGuard = new QuitGuard({ logger, onAllowedSignal: () => app.quit() });
  const keepalive = new KeepaliveLink({
    ...(env.RP_DAEMON_SOCKET ? { socketPath: env.RP_DAEMON_SOCKET } : {}),
    registration: launchSpec({ execPath: process.execPath, argv: process.argv, appImage: env.APPIMAGE, cwd: process.cwd(), env }),
    logger,
  });
  // Session guard attempts arrive on the keepalive link: keep the last few for Settings → System
  // and hand each one to the characters as a `guard-attempt` host event.
  keepalive.onEvent((event) => {
    if (event.ev !== 'guard-attempt') return;
    const record = system.guardLog.push(event);
    logger.info(`[guard] ${record.blocked ? 'blocked' : 'logged'} ${record.kind} ${record.operation} on ${record.target} by ${record.command} (pid ${record.pid})`);
    const { at, ...data } = record;
    emit({ name: 'guard-attempt', data, at });
  });
  /** An update restart is an authorised quit: let it through and make sure the daemon does not race the updater's relaunch. */
  const beforeRestart = async (): Promise<void> => {
    quitGuard.allowQuitOnce();
    await keepalive.unregister();
  };

  // ---- in-place updates (AppImage from the private GitHub releases) ---------------
  // A system install downloads through its own updater (no APPIMAGE env, no delta) and hands the
  // file to the daemon; the AppImage keeps electron-updater's swap-in-place (also on quit).
  const updater: UpdaterLike = systemInstalled ? new SystemInstallUpdater() : autoUpdater;
  updater.logger = {
    info: (m?: unknown) => logger.info(`[updater] ${String(m)}`),
    warn: (m?: unknown) => logger.warn(`[updater] ${String(m)}`),
    error: (m?: unknown) => logger.error(`[updater] ${String(m)}`),
    debug: (m: string) => logger.debug(`[updater] ${m}`),
  };
  if (!systemInstalled) updater.autoInstallOnAppQuit = true;
  const systemInstall: SystemInstallDeps | undefined = systemInstalled
    ? {
        dir: systemInstallDir,
        available: async () => {
          if (!(await daemon.isAvailable())) return { daemonConnected: false, daemonSupportsUpdates: false };
          const status = await daemon.status();
          if (!status.connected) return { daemonConnected: false, daemonSupportsUpdates: false };
          const info = status.install;
          const out: Awaited<ReturnType<SystemInstallDeps['available']>> = { daemonConnected: true, daemonSupportsUpdates: info?.systemInstall === true };
          if (info?.current !== undefined) out.current = info.current;
          if (info?.previous !== undefined) out.previous = info.previous;
          return out;
        },
        applyUpdate: (input) => daemon.applyUpdate(input),
        waitForDaemon: (timeoutMs) => daemon.waitForHello(timeoutMs),
        relaunch: () => {
          // Explicit execPath: the running binary's /proc/self/exe now points into previous/.
          app.relaunch({ execPath: path.join(systemInstallDir, 'rp-code'), args: process.argv.slice(1) });
          app.quit();
        },
      }
    : undefined;
  const updates = new UpdateService({
    updater,
    ...(systemInstall ? { systemInstall } : {}),
    appVersion: opts.appVersion,
    isPackaged: app.isPackaged,
    ...(env.APPIMAGE ? { appImagePath: env.APPIMAGE } : {}),
    execPath: execPathReal,
    userDataDir: opts.userData,
    settings: { get: () => engine.settings.get() },
    policy,
    safeStorage,
    logger,
    beforeRestart,
  });

  await engine.start();
  const builtinIds = new Set(createStandardRegistry().list().map((m) => m.id));
  const plugins = new PluginService({
    pluginsDir: path.join(opts.userData, 'plugins'),
    dataDir: path.join(opts.userData, 'plugin-data'),
    registry: new PluginRegistry(path.join(dataDir, 'plugins.json')),
    engine: engine as unknown as ConstructorParameters<typeof PluginService>[0]['engine'],
    builtinIds,
    appVersion: opts.appVersion,
    logger,
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
      else logger.info(`[plugins] notification: ${title} — ${body}`);
    },
    openDirectory: async () => {
      const r = await dialog.showOpenDialog({ title: 'Choose a plugin folder (contains plugin.json)', properties: ['openDirectory'] });
      return r.canceled ? undefined : r.filePaths[0];
    },
    openPath: (dir) => shell.openPath(dir),
  });
  await plugins.loadAll();
  await senses.refresh().catch((err: unknown) => logger.warn('[senses] initial settings read failed', err));
  if (mock) await ensureMockProvider(engine, logger);
  if (mock || !app.isPackaged) await ensureExamplePack(engine, opts.appRoot, logger, env);

  const sampleImage = async (): Promise<string> => {
    const target = path.join(opts.userData, 'sample.png');
    if (fs.existsSync(target)) return target;
    for (const dir of resourcesDirs) {
      const candidate = path.join(dir, 'sample.png');
      if (fs.existsSync(candidate)) {
        await fs.promises.copyFile(candidate, target);
        return target;
      }
    }
    // Last resort: a 1×1 transparent PNG.
    await fs.promises.writeFile(target, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    return target;
  };

  let stopped = false;
  return {
    engine,
    media,
    senses,
    editor,
    plugins,
    system,
    updates,
    policy,
    daemon,
    quitGuard,
    keepalive,
    commands,
    permissionPrompts,
    uiPrompts,
    loopback,
    browser,
    extension,
    setHomePage,
    async setBridgePort(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RpError('INVALID_ARGUMENT', 'port must be 1..65535');
      const current = (await settingsOf()).browser;
      if (current.bridgePort !== port) await engine.settings.update({ browser: { ...current, bridgePort: port } });
      if (loopback.listeningPort === port) return;
      browser.close();
      await loopback.rebind(port);
      logger.info(`[browser] bridge port set to ${port} (listening on ${loopback.listeningPort})`);
    },
    backend: () => backend,
    async selectBackend(setting) {
      if (setting === backendSetting) return;
      const previous = backend;
      const next = await selectBackend(setting, backendContext);
      backend = next;
      backendSetting = setting;
      logger.info(`[display] backend switched to ${next.name}`);
      await previous.dispose().catch((err: unknown) => logger.warn('[display] dispose of previous backend failed', err));
    },
    sampleImage,
    packRootFor,
    async stop() {
      if (stopped) return;
      stopped = true;
      updates.stop();
      permissionPrompts.rejectAll();
      uiPrompts.rejectAll();
      await senses.dispose().catch((err: unknown) => logger.warn('[senses] dispose failed', err));
      await plugins.dispose().catch((err: unknown) => logger.warn('[plugins] dispose failed', err));
      // An ordinary stop is an intended exit: unregister so the daemon does not relaunch us.
      await keepalive.unregister();
      quitGuard.dispose();
      daemon.close();
      browser.close();
      await engine.stop().catch((err: unknown) => logger.warn('[engine] stop failed', err));
      await backend.dispose().catch((err: unknown) => logger.warn('[display] dispose failed', err));
      await loopback.close().catch(() => undefined);
    },
  };
}

/** `packId/characterId` → character display name (used for prompts). */
export function characterNameOf(engine: Engine, ref: string): string {
  try {
    return engine.packs.getCharacter(ref).character.definition.name;
  } catch {
    return parseCharacterRef(ref).characterId;
  }
}
