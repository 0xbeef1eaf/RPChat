/**
 * Implements every `IpcApi` method as `ipcMain.handle('<ns>:<method>')`,
 * validates the sender (only our windows) and forwards engine events to the
 * main window on the `IPC_EVENT_CHANNELS`.
 */
import { dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AppSettings,
  CommandTemplate,
  CommandTemplates,
  CreateSessionInput,
  IpcApi,
  MediaWindowEvent,
  MemoryEntry,
  MemoryImportance,
  PermissionDecision,
  ProviderConfig,
  Session,
  UiPromptAnswer,
} from '@rp/shared';
import { IPC_EVENT_CHANNELS, RpError } from '@rp/shared';
import type { Engine, Logger } from '@rp/core';
import type { AppServices } from './engine.js';
import type { WindowManager } from './windows.js';

/** The memory service surface main needs (`engine.memories`, added by @rp/core). */
export interface MemoryServiceLike {
  list(characterRef: string): Promise<MemoryEntry[]>;
  add(characterRef: string, text: string, options?: { tags?: string[]; importance?: number; source?: 'user' | 'character' | 'consolidation'; sessionId?: string }): Promise<MemoryEntry>;
  update(entry: Pick<MemoryEntry, 'id'> & Partial<Pick<MemoryEntry, 'text' | 'tags' | 'importance'>>): Promise<MemoryEntry>;
  remove(id: string): Promise<unknown>;
  consolidate(sessionId: string, options?: { auto?: boolean }): Promise<MemoryEntry[]>;
}

export function memoriesOf(engine: Engine): MemoryServiceLike {
  const service = (engine as unknown as { memories?: MemoryServiceLike }).memories;
  if (!service) throw new RpError('INTERNAL', 'The memory service is not available in this build');
  return service;
}

type Handlers = { [NS in keyof IpcApi]: { [M in keyof IpcApi[NS]]?: IpcApi[NS][M] extends (...args: infer A) => infer R ? (event: IpcMainInvokeEvent, ...args: A) => R : never } };

export interface RegisterIpcOptions {
  services: AppServices;
  windows: WindowManager;
  logger: Logger;
  version: string;
}

const COMMAND_NAMES: ReadonlySet<string> = new Set<keyof CommandTemplates>(['wallpaper', 'browser', 'inputLock', 'inputUnlock']);

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new RpError('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  return v;
}

export function registerIpc(opts: RegisterIpcOptions): () => void {
  const { services, windows, logger } = opts;
  const { engine } = services;

  const handlers: Handlers = {
    app: {
      version: async () => opts.version,
      windowKind: async (event) => windows.kindOf(event.sender) ?? 'main',
      openPath: async (_e, target) => {
        const error = await shell.openPath(requireString(target, 'path'));
        if (error) throw new RpError('CAPABILITY_FAILED', error);
      },
    },
    packs: {
      list: () => engine.packs.list(),
      pickInstallSource: async (event, kind) => {
        const parent = windows.getMainWindow();
        const options: Electron.OpenDialogOptions =
          kind === 'directory'
            ? { title: 'Choose a pack directory', properties: ['openDirectory'] }
            : { title: 'Choose a pack file', properties: ['openFile'], filters: [{ name: 'rp-code packs', extensions: ['rppack', 'zip'] }] };
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        void event;
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      install: (_e, sourcePath) => engine.packs.install(requireString(sourcePath, 'sourcePath')),
      uninstall: (_e, packId) => engine.packs.uninstall(requireString(packId, 'packId')),
      setGrant: (_e, packId, module, granted) => engine.permissions.setGrant(requireString(packId, 'packId'), requireString(module, 'module'), Boolean(granted)),
      exportPack: (_e, packId, destinationFile) => engine.packs.exportPack(requireString(packId, 'packId'), requireString(destinationFile, 'destinationFile')),
    },
    capabilities: {
      list: async () => engine.capabilities.list(),
      typings: async () => engine.capabilities.typings(),
    },
    characters: {
      list: async () => engine.packs.characters(),
    },
    sessions: {
      list: () => engine.sessions.list(),
      create: (_e, input: CreateSessionInput) => engine.sessions.create(input),
      get: (_e, sessionId) => engine.sessions.get(requireString(sessionId, 'sessionId')),
      update: (_e, session: Session) => engine.sessions.update(session),
      remove: (_e, sessionId) => engine.sessions.remove(requireString(sessionId, 'sessionId')),
      messages: (_e, sessionId) => engine.sessions.messages(requireString(sessionId, 'sessionId')),
    },
    chat: {
      send: (_e, sessionId, text) => engine.chat.send(requireString(sessionId, 'sessionId'), text),
      abort: (_e, sessionId) => engine.chat.abort(requireString(sessionId, 'sessionId')),
    },
    permissions: {
      respond: async (_e, requestId, decision: PermissionDecision) => {
        const valid: PermissionDecision[] = ['allow-once', 'allow-session', 'deny'];
        const answer = valid.includes(decision) ? decision : 'deny';
        if (!services.permissionPrompts.respond(requireString(requestId, 'requestId'), answer)) {
          logger.debug(`[ipc] permissions.respond for unknown request ${requestId}`);
        }
      },
    },
    settings: {
      get: () => engine.settings.get(),
      update: async (_e, patch: Partial<AppSettings>) => {
        const next = await engine.settings.update(patch ?? {});
        if (patch && patch.displayBackend !== undefined) {
          await services.selectBackend(next.displayBackend).catch((err) => logger.warn('[display] backend switch failed', err));
        }
        return next;
      },
      testProvider: (_e, config: ProviderConfig) => engine.settings.testProvider(config),
      listModels: (_e, config: ProviderConfig) => engine.settings.listModels(config),
      testCommand: async (_e, name: keyof CommandTemplates, template: CommandTemplate) => {
        if (!COMMAND_NAMES.has(name)) throw new RpError('INVALID_ARGUMENT', `Unknown command template "${String(name)}"`);
        const tpl: CommandTemplate = template && typeof template === 'object' ? template : { command: '' };
        const effective = tpl.command && tpl.command.trim().length > 0 ? tpl : { ...services.commands.defaults()[name], ...(tpl.timeoutMs ? { timeoutMs: tpl.timeoutMs } : {}) };
        if (!effective.command || effective.command.trim().length === 0) {
          throw new RpError('CAPABILITY_FAILED', `No ${name} command configured and no platform default is available`);
        }
        const vars = { file: await services.sampleImage(), url: 'https://example.com', seconds: '3', durationMs: '3000', monitor: '', reason: 'test', newWindow: '' };
        return services.commands.runTemplate(effective, vars, `test:${name}`);
      },
      defaultCommands: async () => services.commands.defaults(),
    },
    audit: {
      list: (_e, options) => engine.audit.list(options ?? {}),
    },
    memories: {
      list: (_e, characterRef) => memoriesOf(engine).list(requireString(characterRef, 'characterRef')),
      add: (_e, characterRef, text, options) => {
        const o = options && typeof options === 'object' ? options : {};
        const addOptions: { tags?: string[]; importance?: MemoryImportance; source: 'user' } = { source: 'user' };
        if (Array.isArray(o.tags)) addOptions.tags = o.tags;
        if (typeof o.importance === 'number') addOptions.importance = o.importance;
        return memoriesOf(engine).add(requireString(characterRef, 'characterRef'), requireString(text, 'text'), addOptions);
      },
      update: (_e, entry: MemoryEntry) => {
        if (!entry || typeof entry !== 'object') throw new RpError('INVALID_ARGUMENT', 'entry must be an object');
        return memoriesOf(engine).update(entry);
      },
      remove: async (_e, id) => {
        await memoriesOf(engine).remove(requireString(id, 'id'));
      },
      consolidate: (_e, sessionId) => memoriesOf(engine).consolidate(requireString(sessionId, 'sessionId'), { auto: false }),
    },
    ui: {
      respondPrompt: async (_e, promptId, answer: UiPromptAnswer) => {
        const clean: UiPromptAnswer = typeof answer === 'boolean' || typeof answer === 'string' ? answer : null;
        if (!services.uiPrompts.respond(requireString(promptId, 'promptId'), clean)) logger.debug(`[ipc] ui.respondPrompt for unknown prompt ${promptId}`);
      },
    },
    media: {
      report: async (event, report: MediaWindowEvent) => {
        if (!report || typeof report !== 'object' || typeof report.type !== 'string') return;
        if (!windows.dispatchReport(event.sender, report)) logger.debug(`[ipc] media.report from an unknown window: ${report.type}`);
      },
      closeAll: () => services.media.closeAll(),
    },
    display: {
      backend: async () => services.backend().info(),
      monitors: () => services.backend().monitors(),
    },
  };

  const channels: string[] = [];
  for (const [ns, methods] of Object.entries(handlers)) {
    for (const [method, fn] of Object.entries(methods as Record<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>)) {
      const channel = `${ns}:${method}`;
      ipcMain.handle(channel, async (event, ...args) => {
        if (!windows.isOurs(event.sender)) {
          logger.warn(`[ipc] rejected ${channel} from an unknown sender (webContents ${event.sender.id})`);
          throw new RpError('PERMISSION_DENIED', 'Unknown sender');
        }
        try {
          return await fn(event, ...args);
        } catch (err) {
          const rp = RpError.from(err);
          if (rp.code === 'INTERNAL' || rp.code === 'STORAGE') logger.error(`[ipc] ${channel} failed`, err);
          else logger.debug(`[ipc] ${channel} → ${rp.code}: ${rp.message}`);
          // Electron serialises thrown errors as `Error: <message>`; keep the code in the message for the UI.
          throw new Error(rp.message);
        }
      });
      channels.push(channel);
    }
  }

  const offChat = engine.events.on('chat', (event) => {
    if (!windows.sendToMain(IPC_EVENT_CHANNELS.chatEvent, event)) logger.debug(`[ipc] dropped chat event ${event.type} (no main window)`);
  });

  logger.info(`[ipc] ${channels.length} channels registered (app ${opts.version})`);
  return () => {
    offChat();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
