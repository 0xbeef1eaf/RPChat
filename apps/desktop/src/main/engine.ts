/** Builds the `@rp/core` Engine with the desktop's storage, sandbox, display backend and host handlers. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, screen } from 'electron';
import { Engine, FileStorage } from '@rp/core';
import type { Logger, ProviderFactory } from '@rp/core';
import { createStandardRegistry } from '@rp/sdk';
import { QuickJsRunner } from '@rp/sandbox';
import { createProvider } from '@rp/llm';
import type { AppSettings, LoadedPack, PermissionDecision, PermissionRequest, UiPromptAnswer, UiPromptRequest } from '@rp/shared';
import { IPC_EVENT_CHANNELS, parseCharacterRef } from '@rp/shared';
import { defaultSettings, mergeSettings } from '@rp/core';
import { hasExecutable } from './commands.js';
import { BrowserHandler } from './capabilities/browser.js';
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
import { ensureExamplePack, ensureMockProvider, isMockLlm, mockProviderFactory } from './dev-mode.js';
import { LoopbackServer } from './loopback.js';
import { PendingPrompts } from './prompts.js';
import type { WindowManager } from './windows.js';

export interface AppServices {
  engine: Engine;
  media: MediaManager;
  commands: CommandRunner;
  permissionPrompts: PendingPrompts<PermissionDecision>;
  uiPrompts: PendingPrompts<UiPromptAnswer>;
  backend(): DisplayBackend;
  /** Re-select the display backend after the setting changed. */
  selectBackend(setting: AppSettings['displayBackend']): Promise<void>;
  loopback: LoopbackServer | undefined;
  /** Absolute path of the bundled sample image (copied out of the asar when needed). */
  sampleImage(): Promise<string>;
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
  const storage = new FileStorage(dataDir);
  const stored = mergeSettings(await storage.settings.get().catch(() => defaultSettings()));

  // ---- display backend ----------------------------------------------------
  let loopback: LoopbackServer | undefined;
  const loopbackFor = async (): Promise<LoopbackServer> => {
    if (loopback) return loopback;
    const server = new LoopbackServer({
      rendererDir: windows.rendererDir,
      ...(env.ELECTRON_RENDERER_URL ? { devServerUrl: env.ELECTRON_RENDERER_URL } : {}),
      assets: { packRootFor: (packId) => engine.packs.tryGetLoaded(packId)?.root, logger },
      logger,
    });
    await server.start();
    loopback = server;
    return server;
  };
  const resourcesDirs = [...(app.isPackaged ? [process.resourcesPath] : []), path.join(opts.appRoot, 'resources'), path.join(app.getAppPath(), 'resources')];
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
  };
  let backend: DisplayBackend = await selectBackend(stored.displayBackend, backendContext);
  let backendSetting = stored.displayBackend;
  logger.info(`[display] backend: ${backend.name} (${JSON.stringify(backend.info().supports)})`);

  // ---- prompts ------------------------------------------------------------
  const permissionPrompts = new PendingPrompts<PermissionDecision>({ fallback: 'deny' });
  const uiPrompts = new PendingPrompts<UiPromptAnswer>({ fallback: null });
  const permissionPrompter = (request: PermissionRequest): Promise<PermissionDecision> =>
    permissionPrompts.ask(request.requestId, () => windows.sendToMain(IPC_EVENT_CHANNELS.permissionRequest, request));

  // ---- handlers -----------------------------------------------------------
  const settingsOf = (): Promise<AppSettings> => engine.settings.get();
  const commands = new CommandRunner({ settings: settingsOf, logger, env });
  const packs = { getLoaded: (packId: string): LoadedPack => engine.packs.getLoaded(packId) };
  const media = new MediaManager({ backend: () => backend, audioWindow: () => windows.audioWindow(), packs, settings: settingsOf, logger });
  const ui = new UiHandler({
    prompts: uiPrompts,
    deliver: (request: UiPromptRequest) => windows.sendToMain(IPC_EVENT_CHANNELS.uiPrompt, request),
    characterName: (context): string => {
      try {
        return engine.packs.getCharacter(`${context.packId}/${context.characterId}`).character.definition.name;
      } catch {
        return context.characterId;
      }
    },
    logger,
  });
  const wallpaper = new WallpaperHandler({ commands, packs, backend: () => backend, restoreFile: async () => (await settingsOf()).wallpaperRestoreFile });
  const input = new InputHandler({ commands, maxLockMs: async () => (await settingsOf()).maxInputLockMs, logger });

  const mock = isMockLlm(env);
  const providerFactory: ProviderFactory = mock ? mockProviderFactory() : createProvider;
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
      new BrowserHandler({ commands }),
      input,
    ],
    permissionPrompter,
    appVersion: opts.appVersion,
    logger,
    locale: app.getLocale(),
  });

  await engine.start();
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
    commands,
    permissionPrompts,
    uiPrompts,
    loopback,
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
    async stop() {
      if (stopped) return;
      stopped = true;
      permissionPrompts.rejectAll();
      uiPrompts.rejectAll();
      await engine.stop().catch((err: unknown) => logger.warn('[engine] stop failed', err));
      await backend.dispose().catch((err: unknown) => logger.warn('[display] dispose failed', err));
      await loopback?.close().catch(() => undefined);
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
