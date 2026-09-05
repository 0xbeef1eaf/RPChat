import type { CapabilityRegistry } from '@rp/sdk';
import { generateSdkTypings } from '@rp/sdk';
import { createProvider } from '@rp/llm';
import type {
  CapabilityHandler,
  CapabilityInfo,
  CodeRunner,
  PermissionDecision,
  PermissionRequest,
  ProviderConfig,
  LlmProvider,
  Storage,
} from '@rp/shared';
import { ActionLoop } from './action-loop.js';
import { BehaviourRunner } from './behaviours.js';
import { CapabilityDispatcher } from './dispatcher.js';
import { TypedEmitter } from './emitter.js';
import { ChatHandler } from './handlers/chat.js';
import { LogHandler } from './handlers/log.js';
import { MemoryHandler } from './handlers/memory.js';
import { PackHandler } from './handlers/pack.js';
import { StateHandler } from './handlers/state.js';
import { TimersHandler } from './handlers/timers.js';
import { AuditService } from './services/audit.js';
import { ChatService } from './services/chat.js';
import { MemoryService } from './services/memory.js';
import { PackService } from './services/packs.js';
import { PermissionService } from './services/permissions.js';
import { SessionService } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { TimerService } from './services/timers.js';
import type { Clock, EngineEmitter, EngineEvents, Logger } from './types.js';
import { NOOP_LOGGER } from './types.js';

export interface EngineOptions {
  storage: Storage;
  registry: CapabilityRegistry;
  runner: CodeRunner;
  /** Directory where installed packs are copied/extracted (`<packsDir>/<id>/<version>/`). */
  packsDir: string;
  /** Default: `createProvider` from `@rp/llm`. */
  providerFactory?: (config: ProviderConfig) => LlmProvider;
  /** Host handlers for modules with host effects (media, ui, system). Core supplies chat/log/state/pack/timers itself. */
  hostHandlers: CapabilityHandler[];
  /** Asked for every `prompt`-level call (the desktop app routes this to the renderer). */
  permissionPrompter: (request: PermissionRequest) => Promise<PermissionDecision>;
  appVersion: string;
  now?: Clock;
  logger?: Logger;
  /** BCP-47 locale shown to the model in the session notes. */
  locale?: string;
}

/** The chat engine: wires storage, packs, sessions, permissions, the dispatcher and the action loop. */
export class Engine {
  readonly events: EngineEmitter = new TypedEmitter<EngineEvents>();
  readonly appVersion: string;
  readonly registry: CapabilityRegistry;
  readonly storage: Storage;
  readonly runner: CodeRunner;

  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly permissions: PermissionService;
  readonly timers: TimerService;
  readonly packs: PackService;
  readonly sessions: SessionService;
  /** Long-term character memories (`IpcApi.memories` maps 1:1 onto list/add/update/remove/consolidate). */
  readonly memories: MemoryService;
  readonly dispatcher: CapabilityDispatcher;
  readonly behaviours: BehaviourRunner;
  readonly actionLoop: ActionLoop;
  readonly chat: ChatService;
  readonly capabilities: { list(): CapabilityInfo[]; typings(): string };

  private readonly logger: Logger;
  private started = false;

  constructor(opts: EngineOptions) {
    const now: Clock = opts.now ?? (() => new Date());
    const logger = opts.logger ?? NOOP_LOGGER;
    const providerFactory = opts.providerFactory ?? createProvider;
    this.logger = logger;
    this.appVersion = opts.appVersion;
    this.registry = opts.registry;
    this.storage = opts.storage;
    this.runner = opts.runner;
    this.events.onListenerError = (event, err) => logger.error(`[engine] listener for "${String(event)}" threw`, err);

    this.settings = new SettingsService(opts.storage, providerFactory);
    this.audit = new AuditService(opts.storage, now, logger);
    this.permissions = new PermissionService(opts.storage, opts.registry, opts.permissionPrompter, this.events, now, logger);
    this.timers = new TimerService(opts.storage, now, logger);
    this.packs = new PackService(opts.storage, opts.packsDir, opts.registry, this.permissions, this.timers, now, logger);
    this.sessions = new SessionService(opts.storage, this.packs, this.permissions, this.timers, this.events, now, logger);
    this.memories = new MemoryService({
      storage: opts.storage,
      settings: this.settings,
      packs: this.packs,
      providerFactory,
      emitter: this.events,
      now,
      logger,
    });
    this.sessions.setBeforeRemove(async (session) => {
      await this.memories.consolidate(session.id, { auto: true });
    });

    const coreHandlers: CapabilityHandler[] = [
      new ChatHandler(this.sessions, opts.storage.messages, this.events),
      new LogHandler(logger),
      new StateHandler(opts.storage.state),
      new PackHandler(this.packs),
      new TimersHandler(this.timers, now),
      new MemoryHandler(this.memories),
    ];
    this.dispatcher = new CapabilityDispatcher({
      registry: opts.registry,
      handlers: [...coreHandlers, ...opts.hostHandlers],
      permissions: this.permissions,
      audit: this.audit,
      packs: this.packs,
      now,
      logger,
    });

    this.behaviours = new BehaviourRunner({
      packs: this.packs,
      permissions: this.permissions,
      settings: this.settings,
      registry: opts.registry,
      runner: opts.runner,
      invoker: this.dispatcher,
      logger,
    });
    this.sessions.setBehaviours(this.behaviours);
    this.packs.setInstallHookRunner((pack) => this.behaviours.runInstallHooks(pack));

    this.actionLoop = new ActionLoop({
      runner: opts.runner,
      invoker: this.dispatcher,
      messages: { add: (m) => this.sessions.addMessage(m), persist: (m) => this.sessions.persistMessage(m) },
      emitter: this.events,
      now,
      logger,
    });

    const chatOptions: ConstructorParameters<typeof ChatService>[0] = {
      storage: opts.storage,
      packs: this.packs,
      sessions: this.sessions,
      settings: this.settings,
      permissions: this.permissions,
      timers: this.timers,
      behaviours: this.behaviours,
      actionLoop: this.actionLoop,
      providerFactory,
      registry: opts.registry,
      emitter: this.events,
      now,
      logger,
      memories: this.memories,
    };
    if (opts.locale !== undefined) chatOptions.locale = opts.locale;
    this.chat = new ChatService(chatOptions);
    this.timers.setFireHandler((timer) => this.chat.handleTimer(timer));

    this.capabilities = {
      list: () =>
        opts.registry.list().map((spec) => ({
          id: spec.id,
          title: spec.title,
          summary: spec.summary,
          permission: spec.permission,
          methods: Object.entries(spec.methods).map(([name, m]) => ({
            name,
            description: m.description,
            dangerous: m.dangerous === true,
          })),
        })),
      typings: () => generateSdkTypings(opts.registry),
    };
  }

  /** Load installed packs and arm persisted timers. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.packs.start();
    await this.timers.start();
    this.logger.info(`[engine] started (app ${this.appVersion}, ${this.packs.characters().length} character(s))`);
  }

  /** Stop timers, dispose handlers and the runner, close storage. Never keeps the process alive. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.timers.stop();
    await this.chat.idle();
    await this.memories.idle();
    await this.dispatcher.dispose();
    await this.runner.dispose();
    await this.storage.close();
  }
}
