import type { CapabilityRegistry } from '@rp/sdk';
import { generateSdkTypings } from '@rp/sdk';
import { createProvider } from '@rp/llm';
import type {
  CapabilityHandler,
  CapabilityInfo,
  CapabilityModuleSpec,
  CodeRunner,
  EventSubscription,
  HostEvent,
  MoodState,
  PermissionDecision,
  PermissionRequest,
  ProviderConfig,
  LlmProvider,
  RoutineEntry,
  RoutineStatus,
  Storage,
} from '@rp/shared';
import { RpError } from '@rp/shared';
import { ActionLoop } from './action-loop.js';
import { BehaviourRunner } from './behaviours.js';
import { CapabilityDispatcher } from './dispatcher.js';
import { TypedEmitter } from './emitter.js';
import { ChatHandler } from './handlers/chat.js';
import { LlmHandler } from './handlers/llm.js';
import { EventsHandler, MoodHandler, RoutineHandler } from './handlers/living.js';
import { HelpHandler } from './handlers/help.js';
import { LibHandler } from './handlers/lib.js';
import { MemoryHandler } from './handlers/memory.js';
import { PackHandler } from './handlers/pack.js';
import { StateHandler } from './handlers/state.js';
import { TimersHandler } from './handlers/timers.js';
import { AuditService } from './services/audit.js';
import { ChatService } from './services/chat.js';
import { EventService } from './services/events.js';
import { MoodService } from './services/mood.js';
import { RoutineService } from './services/routine.js';
import { SandboxService } from './services/sandbox.js';
import { HistoryService } from './services/history.js';
import { LibraryService } from './services/library.js';
import { MemoryService } from './services/memory.js';
import { PackService } from './services/packs.js';
import { PermissionService } from './services/permissions.js';
import { SessionService } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { TimerService } from './services/timers.js';
import type { Clock, EngineEmitter, EngineEvents, Logger, SensesProvider } from './types.js';
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
  /** Host presence sampler + raw host events (Phase 2). Optional: without it there is no senses line and only core-generated events. */
  senses?: SensesProvider;
}

/** How often core evaluates `time` events and routine transitions. */
const TICK_MS = 60_000;

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
  /** Background summarisation of the older messages of a session. */
  readonly history: HistoryService;
  /** Per-character function libraries: the `lib` prelude of every run (and, through it, `sdk.lib`). */
  readonly library: LibraryService;
  /** Event subscriptions + host-event routing (`hostEvents`/`subscriptions` are the host-facing views). */
  readonly eventService: EventService;
  readonly mood: MoodService;
  readonly routine: RoutineService;
  /** Host → core event injection (same effect as `SensesProvider.subscribe`). */
  readonly hostEvents: { emit(event: HostEvent): void };
  /** Live event subscriptions (`IpcApi.events`). */
  readonly subscriptions: { list(sessionId?: string): Promise<EventSubscription[]>; remove(id: string): Promise<boolean> };
  /** Vision helper for host handlers (`screen.look`). */
  readonly llm: { describeImage(sessionId: string, pngBase64: string, question?: string): Promise<string> };
  readonly dispatcher: CapabilityDispatcher;
  readonly behaviours: BehaviourRunner;
  readonly actionLoop: ActionLoop;
  readonly chat: ChatService;
  /** Ad-hoc scripts run by hand from the Sandbox tab (`IpcApi.sandbox`), as the character's own code would run. */
  readonly sandbox: SandboxService;
  /**
   * The live capability surface. `list()`/`typings()` read the registry at call time;
   * `register`/`unregister` add or remove a plugin-provided module (spec + host handler) at runtime —
   * prompts, permissions, `packs.inspect`/`install` and the sandbox surface see the change immediately.
   */
  readonly capabilities: {
    list(): CapabilityInfo[];
    typings(): string;
    register(spec: CapabilityModuleSpec, handler: CapabilityHandler): void;
    unregister(id: string): Promise<boolean>;
  };

  private readonly logger: Logger;
  private readonly senses: SensesProvider | undefined;
  private unsubscribeSenses: (() => void) | undefined;
  private tickHandle: NodeJS.Timeout | undefined;
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
    this.senses = opts.senses;
    this.permissions = new PermissionService(opts.registry, opts.permissionPrompter, this.events, logger, () => this.settings.get());
    this.timers = new TimerService(opts.storage, now, logger, async () => (await this.settings.get()).autonomy);
    this.packs = new PackService(opts.storage, opts.packsDir, this.timers, now, logger);
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
    this.history = new HistoryService({
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
    this.library = new LibraryService(this.packs);

    this.routine = new RoutineService({
      storage: opts.storage,
      characterRefs: () => this.packs.characters().map((c) => c.ref),
      now,
      logger,
    });
    this.mood = new MoodService({
      storage: opts.storage,
      packs: this.packs,
      routineState: (ref, at) => this.routine.state(ref, at),
      emitter: this.events,
      now,
    });

    const coreHandlers: CapabilityHandler[] = [
      new ChatHandler(this.sessions, opts.storage.messages, this.events),
      new HelpHandler(opts.registry, this.permissions),
      new LibHandler(this.library),
      new StateHandler(opts.storage.state),
      new PackHandler(this.packs),
      new TimersHandler(this.timers),
      new MemoryHandler(this.memories),
      new LlmHandler({
        settings: this.settings,
        providerFactory,
        timers: this.timers,
        sessions: this.sessions,
        chat: () => this.chat,
        emitter: this.events,
        now,
      }),
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

    // Event service + its handler need the behaviour runner and the chat queue; both exist before start().
    let eventService: EventService | undefined;
    const events = (): EventService => {
      if (!eventService) throw new Error('EventService not ready');
      return eventService;
    };
    this.dispatcher.registerHandler(new EventsHandler({
      on: (ctx, event, code, o) => events().on(ctx, event, code, o),
      off: (ctx, id) => events().off(ctx, id),
      list: (sessionId) => events().list(sessionId),
      emitCustom: (ctx, name, data) => events().emitCustom(ctx, name, data),
    } as EventService));
    this.dispatcher.registerHandler(new MoodHandler(this.mood));
    this.dispatcher.registerHandler(new RoutineHandler(this.routine));

    this.behaviours = new BehaviourRunner({
      packs: this.packs,
      permissions: this.permissions,
      settings: this.settings,
      registry: opts.registry,
      runner: opts.runner,
      invoker: this.dispatcher,
      logger,
      prelude: (packId, characterId) => this.library.preludeFor(packId, characterId),
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
      history: this.history,
      audit: this.audit,
      mood: this.mood,
      routine: this.routine,
      library: this.library,
    };
    if (opts.locale !== undefined) chatOptions.locale = opts.locale;
    if (opts.senses) chatOptions.senses = opts.senses;
    this.chat = new ChatService(chatOptions);
    this.timers.setFireHandler((timer) => this.chat.handleTimer(timer));
    this.sandbox = new SandboxService({
      packs: this.packs,
      sessions: this.sessions,
      behaviours: this.behaviours,
      audit: this.audit,
      runExclusive: (sessionId, task) => this.chat.runExclusive(sessionId, task),
      now,
      logger,
    });

    const eventOptions: ConstructorParameters<typeof EventService>[0] = {
      storage: opts.storage,
      packs: this.packs,
      behaviours: this.behaviours,
      audit: this.audit,
      emitter: this.events,
      now,
      logger,
    };
    if (opts.senses?.setInterest) eventOptions.setInterest = (names) => opts.senses?.setInterest?.(names);
    eventService = new EventService(eventOptions);
    this.eventService = eventService;
    this.hostEvents = { emit: (event) => void this.eventService.handleHostEvent(event, hostEventScope(event)) };
    this.subscriptions = { list: (sessionId) => this.eventService.list(sessionId), remove: (id) => this.eventService.remove(id) };
    this.sessions.setAfterRemove((session) => this.eventService.removeForSession(session.id));
    this.sessions.setAfterReset((session) => this.eventService.removeForSession(session.id));
    this.sessions.setAfterCreate(() => this.eventService.updateInterest());
    this.packs.onPacksChanged(() => this.eventService.updateInterest());
    this.packs.onPacksChanged(() => this.library.invalidate());
    const llmHandler = this.dispatcher.handlerFor('llm') as LlmHandler;
    this.llm = { describeImage: (sessionId, png, question) => llmHandler.describeImage(sessionId, png, question) };

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
      register: (spec, handler) => {
        if (!spec || typeof spec.id !== 'string') throw new RpError('INVALID_ARGUMENT', 'A capability module spec with an id is required');
        if (opts.registry.has(spec.id)) {
          throw new RpError('INVALID_ARGUMENT', `Capability module "${spec.id}" is already registered`, { module: spec.id });
        }
        if (handler.moduleId !== spec.id) {
          throw new RpError('INVALID_ARGUMENT', `Handler moduleId "${handler.moduleId}" does not match spec id "${spec.id}"`, { module: spec.id });
        }
        opts.registry.register(spec); // validates the spec; throws INVALID_ARGUMENT
        this.dispatcher.addHandler(handler);
        this.logger.info(`[engine] registered capability module "${spec.id}"`);
      },
      unregister: async (id) => {
        const hadSpec = opts.registry.unregister(id);
        const hadHandler = await this.dispatcher.removeHandler(id);
        if (hadSpec || hadHandler) this.logger.info(`[engine] unregistered capability module "${id}"`);
        return hadSpec || hadHandler;
      },
    };
  }

  /** Load installed packs and arm persisted timers. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.packs.start();
    await this.timers.start();
    await this.routine.tick(); // record the initial routine states without emitting transitions
    await this.eventService.updateInterest();
    if (this.senses) {
      try {
        this.unsubscribeSenses = this.senses.subscribe((event) => void this.eventService.handleHostEvent(event, hostEventScope(event)));
      } catch (err) {
        this.logger.warn('[engine] senses.subscribe failed', err);
      }
    }
    this.tickHandle = setInterval(() => void this.tick(), TICK_MS);
    this.tickHandle.unref?.();
    this.logger.info(`[engine] started (app ${this.appVersion}, ${this.packs.characters().length} character(s))`);
  }

  /**
   * One evaluation step (normally every minute): `time` events and routine transitions
   * (`routine-changed` chat + host events, optional self-wake). Exposed for deterministic tests.
   */
  async tick(now: Date = new Date()): Promise<void> {
    try {
      await this.eventService.tick(now);
      for (const t of await this.routine.tick(now)) {
        const session = (await this.sessions.list()).find((s) => s.characterRef === t.characterRef);
        this.events.emit('chat', { type: 'routine-changed', sessionId: session?.id ?? '', routine: t.status });
        const data: Record<string, import('@rp/shared').Json> = { from: t.from, to: t.to };
        if (t.status.label !== undefined) data.label = t.status.label;
        await this.eventService.handleHostEvent({ name: 'routine-changed', data, at: now.toISOString() }, { characterRef: t.characterRef });
        if (session && t.entry?.wakePrompt) await this.chat.selfWake(session.id, t.entry.wakePrompt, 'timer');
      }
    } catch (err) {
      this.logger.warn('[engine] tick failed', err);
    }
  }

  /** Current mood + routine of a character (`IpcApi.characters.status`). */
  async characterStatus(characterRef: string): Promise<{ mood: MoodState; routine: RoutineStatus; routineEntries: RoutineEntry[] }> {
    return { mood: await this.mood.get(characterRef), routine: await this.routine.status(characterRef), routineEntries: await this.routine.entries(characterRef) };
  }

  /** Stop timers, dispose handlers and the runner, close storage. Never keeps the process alive. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = undefined;
    this.unsubscribeSenses?.();
    this.unsubscribeSenses = undefined;
    await this.timers.stop();
    this.sandbox.cancelAll();
    await this.eventService.idle();
    await this.chat.idle();
    await this.memories.idle();
    await this.history.idle();
    await this.dispatcher.dispose();
    await this.runner.dispose();
    await this.storage.close();
  }
}

/**
 * Host events that belong to one character (avatar clicks, widget messages) carry
 * `data.characterRef`; scope their dispatch so only that character's subscriptions fire.
 */
function hostEventScope(event: HostEvent): { characterRef?: string } {
  const data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof data['characterRef'] === 'string') {
    return { characterRef: data['characterRef'] };
  }
  return {};
}
