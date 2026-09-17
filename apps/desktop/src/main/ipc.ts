/**
 * Implements every `IpcApi` method as `ipcMain.handle('<ns>:<method>')`,
 * validates the sender (only our windows) and forwards engine events to the
 * main window on the `IPC_EVENT_CHANNELS`.
 */
import { dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  BrowserBlock,
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
import { notConfigured } from './commands.js';
import type { AppServices } from './engine.js';
import { phase2, unavailable } from './phase2.js';
import type { ChainAuthor } from './system/chain-author.js';
import { isRestrictable, refusalFor, refusalForStoppingTurn, stopsRunningTurn } from './system/restrictions.js';
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
  /** The UI reports which session's chat is on screen (null on any other view). */
  setVisibleSession?: (sessionId: string | null) => void;
}

const COMMAND_NAMES: ReadonlySet<string> = new Set<keyof CommandTemplates>([
  'wallpaper', 'browser', 'activeWindow', 'nowPlaying', 'screenshot', 'tts', 'stt', 'launch', 'volumeSet', 'volumeGet', 'brightness', 'webcamImage', 'webcamVideo',
]);

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
      setVisibleSession: async (_e, sessionId) => {
        opts.setVisibleSession?.(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null);
      },
      restrictions: async () => (await services.policy.current()).restrictions,
    },
    packs: {
      list: () => engine.packs.list(),
      pickInstallSource: async (event, kind) => {
        const parent = windows.getMainWindow();
        const options: Electron.OpenDialogOptions =
          kind === 'directory'
            ? { title: 'Choose a pack directory', properties: ['openDirectory'] }
            : { title: 'Choose a pack file', properties: ['openFile'], filters: [{ name: 'rpchat packs', extensions: ['rppack', 'zip'] }] };
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        void event;
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      inspect: (_e, sourcePath) => {
        const inspect = phase2(engine).packs.inspect;
        if (!inspect) throw unavailable('engine.packs.inspect');
        return inspect.call(engine.packs, requireString(sourcePath, 'sourcePath'));
      },
      install: (_e, sourcePath) => engine.packs.install(requireString(sourcePath, 'sourcePath')),
      uninstall: (_e, packId) => engine.packs.uninstall(requireString(packId, 'packId')),
      exportPack: (_e, packId, destinationFile) => engine.packs.exportPack(requireString(packId, 'packId'), requireString(destinationFile, 'destinationFile')),
    },
    capabilities: {
      list: async () => engine.capabilities.list(),
      typings: async () => engine.capabilities.typings(),
    },
    characters: {
      list: async () => engine.packs.characters(),
      status: async (_e, characterRef) => {
        const ref = requireString(characterRef, 'characterRef');
        const p = phase2(engine);
        if (!p.mood || !p.routine) throw unavailable('engine.mood / engine.routine');
        const [mood, routine, routineEntries] = await Promise.all([p.mood.get(ref), p.routine.status(ref), p.routine.entries(ref)]);
        return { mood, routine, routineEntries };
      },
    },
    events: {
      list: async (_e, sessionId) => {
        const subs = phase2(engine).subscriptions;
        if (!subs) throw unavailable('engine.subscriptions');
        return subs.list(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined);
      },
      remove: async (_e, id) => {
        const subs = phase2(engine).subscriptions;
        if (!subs) throw unavailable('engine.subscriptions');
        await subs.remove(requireString(id, 'id'));
      },
    },
    senses: {
      snapshot: () => services.senses.provider.snapshot(),
    },
    sessions: {
      list: () => engine.sessions.list(),
      create: (_e, input: CreateSessionInput) => engine.sessions.create(input),
      get: (_e, sessionId) => engine.sessions.get(requireString(sessionId, 'sessionId')),
      update: (_e, session: Session) => engine.sessions.update(session),
      remove: async (_e, sessionId) => {
        const id = requireString(sessionId, 'sessionId');
        // `requireCharacterSession` keeps the app inside a conversation, so the last one may not go.
        const { restrictions, managedBy } = await services.policy.current();
        if (restrictions.requireCharacterSession) {
          const sessions = await engine.sessions.list();
          if (sessions.length <= 1 && sessions.some((x) => x.id === id)) {
            throw new RpError('PERMISSION_DENIED', `The system policy${managedBy ? ` (managed by ${managedBy})` : ''} keeps a conversation open: the last session cannot be deleted`);
          }
        }
        return engine.sessions.remove(id);
      },
      messages: (_e, sessionId) => engine.sessions.messages(requireString(sessionId, 'sessionId')),
      removeMessage: (_e, sessionId, messageId) => engine.chat.removeMessage(requireString(sessionId, 'sessionId'), requireString(messageId, 'messageId')),
      clearMessages: (_e, sessionId) => engine.chat.clearMessages(requireString(sessionId, 'sessionId')),
      resetState: (_e, sessionId) => engine.chat.resetState(requireString(sessionId, 'sessionId')),
    },
    chat: {
      send: (_e, sessionId, text) => engine.chat.send(requireString(sessionId, 'sessionId'), text),
      retry: (_e, sessionId) => engine.chat.retry(requireString(sessionId, 'sessionId')),
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
      managed: async () => (await services.policy.current()).managed,
      update: async (_e, patch: Partial<AppSettings>) => {
        const next = await engine.settings.update(patch ?? {});
        if (patch && patch.displayBackend !== undefined) {
          await services.selectBackend(next.displayBackend).catch((err) => logger.warn('[display] backend switch failed', err));
        }
        if (patch && patch.senses !== undefined) await services.senses.refresh().catch((err) => logger.warn('[senses] refresh failed', err));
        if (patch && patch.updates !== undefined) services.updates.refreshSchedule();
        return next;
      },
      testProvider: (_e, config: ProviderConfig) => engine.settings.testProvider(config),
      listModels: (_e, config: ProviderConfig) => engine.settings.listModels(config),
      testCommand: async (_e, name: keyof CommandTemplates, template: CommandTemplate) => {
        if (!COMMAND_NAMES.has(name)) throw new RpError('INVALID_ARGUMENT', `Unknown command template "${String(name)}"`);
        const tpl: CommandTemplate = template && typeof template === 'object' ? template : { command: '' };
        const effective = tpl.command && tpl.command.trim().length > 0 ? tpl : { ...services.commands.defaults()[name], ...(tpl.timeoutMs ? { timeoutMs: tpl.timeoutMs } : {}) };
        if (!effective.command || effective.command.trim().length === 0) {
          throw notConfigured(name);
        }
        const vars = {
          file: await services.sampleImage(),
          url: 'https://example.com',
          seconds: '3',
          durationMs: '3000',
          monitor: '',
          reason: 'test',
          devices: 'both',
          newWindow: '',
          text: 'Hello from rpchat',
          level: '50',
          on: '0',
          onWord: 'false',
          theme: 'dark',
          darkMode: 'true',
          app: 'true',
          args: '',
          combo: 'shift',
          x: '10',
          y: '10',
          button: 'left',
          buttonNum: '1',
          buttonHex: '0xC0',
          rate: '',
          voice: '',
        };
        return services.commands.runTemplate(effective, vars, `test:${name}`);
      },
      defaultCommands: async () => services.commands.defaults(),
    },
    audit: {
      list: (_e, options) => engine.audit.list(options ?? {}),
    },
    sandbox: {
      run: (_e, request) => {
        if (!request || typeof request !== 'object') throw new RpError('INVALID_ARGUMENT', 'request must be an object');
        return engine.sandbox.run(request);
      },
      cancel: (_e, runId) => engine.sandbox.cancel(requireString(runId, 'runId')),
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
    editor: {
      workspaceDir: async () => services.editor.workspaceDir,
      listProjects: () => services.editor.listProjects(),
      create: (_e, input) => services.editor.create(input),
      open: (_e, dir) => services.editor.open(typeof dir === 'string' ? dir : undefined),
      importInstalled: (_e, packId) => services.editor.importInstalled(requireString(packId, 'packId')),
      forget: (_e, key) => services.editor.forget(requireString(key, 'key')),
      read: (_e, key) => services.editor.read(requireString(key, 'key')),
      saveManifest: (_e, key, manifest) => services.editor.saveManifest(requireString(key, 'key'), manifest),
      saveCharacter: (_e, key, input) => services.editor.saveCharacter(requireString(key, 'key'), input),
      saveScript: (_e, key, input) => services.editor.saveScript(requireString(key, 'key'), input),
      removeScript: (_e, key, dir, name) => services.editor.removeScript(requireString(key, 'key'), requireString(dir, 'dir'), requireString(name, 'name')),
      scriptTemplate: async () => services.editor.scriptTemplate(),
      pickAvatar: (_e, key, dir) => services.editor.pickAvatar(requireString(key, 'key'), requireString(dir, 'dir')),
      pickExpression: (_e, key, dir, expression) => services.editor.pickExpression(requireString(key, 'key'), requireString(dir, 'dir'), expression),
      addMedia: (_e, key, options) => services.editor.addMedia(requireString(key, 'key'), options ?? {}),
      addMediaFiles: (_e, key, files, options) => services.editor.addMediaFiles(requireString(key, 'key'), files, options ?? {}),
      removeMedia: (_e, key, assetPath) => services.editor.removeMedia(requireString(key, 'key'), requireString(assetPath, 'assetPath')),
      saveMediaManifest: (_e, key, manifest) => services.editor.saveMediaManifest(requireString(key, 'key'), manifest),
      suggestMediaTags: (_e, key, paths, options) => services.editor.suggestMediaTags(requireString(key, 'key'), paths, options ?? {}),
      saveReadme: (_e, key, text) => services.editor.saveReadme(requireString(key, 'key'), text),
      validate: (_e, key) => services.editor.validate(requireString(key, 'key')),
      checkScript: (_e, source, kind) => services.editor.checkScript(requireString(source, 'source'), kind === 'function' ? 'function' : 'behaviour'),
      exportPack: (_e, key) => services.editor.exportPack(requireString(key, 'key')),
      installToApp: (_e, key) => services.editor.installToApp(requireString(key, 'key')),
      revealInFolder: (_e, key) => services.editor.revealInFolder(requireString(key, 'key')),
      behaviourTemplates: async () => services.editor.behaviourTemplates(),
      voiceStudio: () => services.editor.voiceStudio(),
      pickVoice: (_e, key, dir) => services.editor.pickVoice(requireString(key, 'key'), requireString(dir, 'dir')),
      previewVoice: (_e, key, dir, opts) => services.editor.previewVoice(requireString(key, 'key'), requireString(dir, 'dir'), opts ?? {}),
    },
    system: {
      status: () => services.system.status(),
      install: (_e, options) => services.system.install(options && typeof options === 'object' ? options : {}),
      setAutostart: (_e, enabled) => services.system.setAutostart(Boolean(enabled)),
      installerPath: () => services.system.installerPath(),
      createPolicy: (_e, text) => services.system.createPolicy(requireString(text, 'text')),
      sealPolicy: (_e, text) => services.system.sealPolicy(typeof text === 'string' ? text : undefined),
      setRemoteLink: (_e, blob, code) => services.system.setRemoteLink(requireString(blob, 'blob'), typeof code === 'string' ? code : undefined),
      replacePolicy: (_e, text, code) => services.system.replacePolicy(requireString(text, 'text'), requireString(code, 'code')),
      unsealPolicy: (_e, code, removePolicy) => services.system.unsealPolicy(requireString(code, 'code'), Boolean(removePolicy)),
      remoteRefresh: () => services.system.remoteRefresh(),
      authorStatus: () => services.system.author.status(),
      authorCreateKey: (_e, replace) => services.system.author.createKey(Boolean(replace)),
      authorImportKey: (_e, pem) => services.system.author.importKey(requireString(pem, 'pem')),
      authorExportKey: () => services.system.author.exportKey(),
      authorForget: () => services.system.author.forget(),
      authorConfigure: (_e, settings) => services.system.author.configure((settings ?? {}) as Parameters<ChainAuthor['configure']>[0]),
      authorRemoteLink: () => services.system.author.remoteLink(),
      authorAppendLink: (_e, input) => services.system.author.appendLink((input ?? {}) as Parameters<ChainAuthor['appendLink']>[0]),
      authorDropLastLink: () => services.system.author.dropLastLink(),
      authorChain: () => services.system.author.publishedChain(),
      authorSignPack: (_e, input) => services.system.author.signPack((input ?? {}) as Parameters<ChainAuthor['signPack']>[0]),
      policyTemplate: async () => services.system.policyTemplate(await engine.settings.get()),
      guardApply: () => services.system.guardApply(),
      guardAttempts: () => services.system.guardAttempts(),
    },
    browser: {
      status: () => services.browser.status(),
      setPort: async (_e, port) => {
        await services.setBridgePort(Number(port));
        return services.browser.status();
      },
      trust: async (_e, id) => {
        await services.browser.trust(requireString(id, 'id'));
        return services.browser.status();
      },
      untrust: async (_e, id) => {
        const wanted = requireString(id, 'id');
        const current = (await engine.settings.get()).browser;
        await engine.settings.update({ browser: { ...current, trustedExtensionIds: current.trustedExtensionIds.filter((x) => x !== wanted) } });
        services.browser.untrust(wanted);
        return services.browser.status();
      },
      installPolicy: async () => {
        const [id, status, settings] = await Promise.all([services.extension.id(), services.browser.status(), engine.settings.get()]);
        return services.system.installBrowserPolicy({
          extensionId: id,
          updateUrl: status.updateUrl,
          port: status.requestedPort,
          extraPolicyDirs: settings.browser.extraPolicyDirs,
        });
      },
      removePolicy: async () => services.system.removeBrowserPolicy((await engine.settings.get()).browser.extraPolicyDirs),
      extensionDir: async () => services.extension.dir() ?? null,
      blocks: async () => (services.browser.connected ? ((await services.browser.request('rules.list')) as unknown as BrowserBlock[]) : []),
      clearBlocks: async () => (services.browser.connected ? ((await services.browser.request('rules.clear')) as unknown as { removed: number }) : { removed: 0 }),
    },
    updates: {
      status: () => services.updates.status(),
      check: () => services.updates.check(),
      download: () => services.updates.download(),
      install: () => services.updates.install(),
    },
    plugins: {
      pluginsDir: async () => services.plugins.pluginsDir,
      list: async () => services.plugins.list(),
      install: (_e, dir) => services.plugins.install(typeof dir === 'string' ? dir : undefined),
      remove: (_e, id) => services.plugins.remove(requireString(id, 'id')),
      setEnabled: (_e, id, enabled) => services.plugins.setEnabled(requireString(id, 'id'), Boolean(enabled)),
      reload: (_e, id) => services.plugins.reload(requireString(id, 'id')),
      openFolder: () => services.plugins.openFolder(),
    },
    prompts: {
      pending: async (event) => windows.promptPayloadFor(event.sender),
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
      // Resolved once per channel: an unguarded one never reads the policy at call time.
      const guarded = isRestrictable(channel);
      // Channels that cut a reply short on their way to what they do; checked only when one runs.
      const mayStopTurn = stopsRunningTurn(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        if (!windows.isOurs(event.sender)) {
          logger.warn(`[ipc] rejected ${channel} from an unknown sender (webContents ${event.sender.id})`);
          throw new RpError('PERMISSION_DENIED', 'Unknown sender');
        }
        // The policy's `app` restrictions, re-read per call so a policy change takes effect at once.
        if (guarded) {
          const state = await services.policy.current();
          const refusal = refusalFor(channel, state.restrictions, state.managedBy);
          if (refusal) {
            logger.info(`[ipc] refused ${channel}: ${refusal}`);
            throw new RpError('PERMISSION_DENIED', refusal);
          }
        }
        // `allowStopGeneration` off: retrying, resetting or editing the history is refused while a
        // reply is in flight, since each of those aborts it first. Every such channel takes the
        // session id first, so the policy is only read when that session is actually running.
        if (mayStopTurn && typeof args[0] === 'string' && engine.chat.isRunning(args[0])) {
          const state = await services.policy.current();
          const refusal = refusalForStoppingTurn(state.restrictions, state.managedBy);
          if (refusal) {
            logger.info(`[ipc] refused ${channel}: ${refusal}`);
            throw new RpError('PERMISSION_DENIED', refusal);
          }
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
  const offUpdates = services.updates.subscribe((status) => {
    windows.sendToMain(IPC_EVENT_CHANNELS.updateStatus, status);
  });
  const offBrowser = services.browser.onStatus((status) => {
    windows.sendToMain(IPC_EVENT_CHANNELS.browserStatus, status);
  });

  logger.info(`[ipc] ${channels.length} channels registered (app ${opts.version})`);
  return () => {
    offChat();
    offUpdates();
    offBrowser();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
