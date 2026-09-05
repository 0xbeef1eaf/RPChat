import type { CapabilityRegistry } from '@rp/sdk';
import type { ChatMessage, LlmProvider, ProviderConfig, ScheduledTimer, Session, Storage } from '@rp/shared';
import { RpError, parseCharacterRef, serializeError } from '@rp/shared';
import type { ActionLoop } from '../action-loop.js';
import type { MemoryService } from './memory.js';
import type { BehaviourRunner } from '../behaviours.js';
import { PromptBuilder } from '../prompt.js';
import type { PackService } from './packs.js';
import type { PermissionService } from './permissions.js';
import type { SessionService } from './sessions.js';
import type { ProviderFactory, SettingsService } from './settings.js';
import type { TimerService } from './timers.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';
import { characterScope } from '../handlers/state.js';

export interface ChatServiceOptions {
  storage: Pick<Storage, 'state'>;
  packs: PackService;
  sessions: SessionService;
  settings: SettingsService;
  permissions: PermissionService;
  timers: TimerService;
  behaviours: BehaviourRunner;
  actionLoop: ActionLoop;
  providerFactory: ProviderFactory;
  registry: CapabilityRegistry;
  emitter: EngineEmitter;
  now: Clock;
  logger: Logger;
  promptBuilder?: PromptBuilder;
  locale?: string;
  /** When present, memories are injected into the prompt and consolidated every `settings.memory.consolidateEveryTurns` turns. */
  memories?: MemoryService;
}

/** Serialises turns per session, runs behaviours around the LLM turn, handles timer wake-ups. */
export class ChatService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly providers = new Map<string, LlmProvider>();
  private readonly promptBuilder: PromptBuilder;
  private readonly turnCounts = new Map<string, number>();

  constructor(private readonly o: ChatServiceOptions) {
    this.promptBuilder = o.promptBuilder ?? new PromptBuilder();
  }

  /** Persist the user's message, run `onUserMessage`, then an LLM turn. Resolves when the turn is finished. */
  async send(sessionId: string, text: string): Promise<void> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new RpError('INVALID_ARGUMENT', 'Message text must be a non-empty string');
    }
    const session = await this.o.sessions.require(sessionId);
    this.requireCharacter(session); // fail fast (NOT_FOUND) before queueing
    await this.enqueue(sessionId, async () => {
      await this.o.sessions.addMessage({ sessionId, role: 'user', content: text });
      const fresh = await this.o.sessions.require(sessionId);

      const hook = await this.runBehaviour(fresh, 'onUserMessage', { text });
      const skip = hook?.ok === true && isSkipLlm(hook.returnValue);
      if (skip) return;
      await this.runLlmTurn(fresh, 'llm');
      await this.afterTurn(sessionId);
    });
  }

  /** Abort the running turn of a session (provider request and sandbox run). */
  async abort(sessionId: string): Promise<void> {
    this.controllers.get(sessionId)?.abort();
  }

  /** `true` while a turn is running or queued for the session. */
  isBusy(sessionId: string): boolean {
    return this.queues.has(sessionId);
  }

  /** Wait for everything queued on the session to finish. */
  async idle(sessionId?: string): Promise<void> {
    const pending = sessionId === undefined ? [...this.queues.values()] : [this.queues.get(sessionId)];
    await Promise.all(pending.map((p) => p?.catch(() => undefined)));
  }

  /** Timer wake-up: `onTimer` behaviour if present, else a system message and an LLM turn. */
  async handleTimer(timer: ScheduledTimer): Promise<void> {
    const session = await this.o.sessions.get(timer.sessionId);
    if (!session) {
      this.o.logger.info(`[chat] timer ${timer.id} dropped: session ${timer.sessionId} no longer exists`);
      return;
    }
    if (session.characterRef !== timer.characterRef) {
      this.o.logger.warn(`[chat] timer ${timer.id} dropped: character mismatch`);
      return;
    }
    const { packId } = parseCharacterRef(session.characterRef);
    if (!this.o.packs.tryGetLoaded(packId)) {
      this.o.logger.info(`[chat] timer ${timer.id} dropped: pack ${packId} is not installed`);
      return;
    }
    await this.enqueue(session.id, async () => {
      if (this.o.behaviours.has(session, 'onTimer')) {
        const info: Record<string, import('@rp/shared').Json> = { id: timer.id, payload: (timer.payload ?? null) as import('@rp/shared').Json };
        if (timer.label !== undefined) info.label = timer.label;
        await this.runBehaviour(session, 'onTimer', { timer: info }, { kind: 'timer', timerId: timer.id });
        return;
      }
      const label = timer.label ? `${timer.label} ` : '';
      await this.o.sessions.addMessage({
        sessionId: session.id,
        role: 'system',
        content: `[timer fired] ${label}${JSON.stringify(timer.payload ?? null)}`,
        origin: 'timer',
      });
      await this.runLlmTurn(await this.o.sessions.require(session.id), 'timer');
      await this.afterTurn(session.id);
    });
  }

  // ---- internals ----------------------------------------------------------

  /** Count assistant turns and kick off memory consolidation (fire-and-forget) every N turns. */
  private async afterTurn(sessionId: string): Promise<void> {
    const memories = this.o.memories;
    if (!memories) return;
    const count = (this.turnCounts.get(sessionId) ?? 0) + 1;
    this.turnCounts.set(sessionId, count);
    const settings = await this.o.settings.get();
    const every = Math.max(1, Math.floor(settings.memory.consolidateEveryTurns));
    if (!settings.memory.enabled || count % every !== 0 || memories.isConsolidating(sessionId)) return;
    void memories.consolidate(sessionId, { auto: true }).catch((err) => this.o.logger.warn('[chat] consolidation failed', err));
  }

  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(sessionId, next);
    next
      .finally(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  private requireCharacter(session: Session): ReturnType<PackService['getCharacter']> {
    return this.o.packs.getCharacter(session.characterRef);
  }

  private async runBehaviour(
    session: Session,
    hook: 'onUserMessage' | 'onTimer',
    input: import('@rp/shared').Json,
    trigger?: import('@rp/shared').ActionTrigger,
  ): Promise<import('@rp/shared').CodeRunResult | undefined> {
    if (!this.o.behaviours.has(session, hook)) return undefined;
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    try {
      const options: import('../behaviours.js').BehaviourRunOptions = { signal: controller.signal };
      if (trigger) options.trigger = trigger;
      return await this.o.behaviours.run(session, hook, input, options);
    } catch (err) {
      this.o.logger.warn(`[chat] ${hook} behaviour failed in session ${session.id}`, err);
      this.o.emitter.emit('chat', { type: 'error', sessionId: session.id, error: serializeError(err) });
      return undefined;
    } finally {
      if (this.controllers.get(session.id) === controller) this.controllers.delete(session.id);
    }
  }

  private providerFor(config: ProviderConfig): LlmProvider {
    const key = JSON.stringify(config);
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.o.providerFactory(config);
      this.providers.set(key, provider);
    }
    return provider;
  }

  private async runLlmTurn(session: Session, origin: 'llm' | 'timer'): Promise<ChatMessage> {
    const { pack, character } = this.requireCharacter(session);
    const settings = await this.o.settings.get();
    const config = await this.o.settings.resolveProvider(session.providerId);
    const provider = this.providerFor(config);
    const model = session.model ?? character.definition.modelHints?.model ?? config.model;
    const useTools = settings.useToolCalling && config.supportsTools !== false;

    const allowedModules = await this.o.permissions.allowedModules(pack.manifest.id);
    const deniedModules = await this.o.permissions.deniedModules(pack.manifest.id);
    const surface = await this.o.behaviours.surfaceFor(pack.manifest.id);
    const state = await this.o.storage.state.all(characterScope({ packId: pack.manifest.id, characterId: character.definition.id }));
    const timers = await this.o.timers.list({ characterRef: session.characterRef });
    const transcript = await this.o.sessions.messages(session.id);
    let memories: import('@rp/shared').MemoryEntry[] = [];
    if (this.o.memories && settings.memory.enabled) {
      const lastUser = [...transcript].reverse().find((m) => m.role === 'user')?.content ?? '';
      const lastAssistant = [...transcript].reverse().find((m) => m.role === 'assistant' && m.content.trim().length > 0)?.content ?? '';
      memories = await this.o.memories.forPrompt(session.characterRef, `${lastUser}\n${lastAssistant}`, settings.memory.promptBudgetTokens);
    }

    const promptInput: import('../prompt.js').PromptInput = {
      pack,
      character,
      registry: this.o.registry,
      allowedModules,
      deniedModules,
      session,
      transcript,
      state,
      timers,
      memories,
      userDisplayName: settings.userDisplayName,
      contextTokenBudget: settings.contextTokenBudget,
      useTools,
      now: this.o.now(),
    };
    if (this.o.locale !== undefined) promptInput.locale = this.o.locale;
    const { system, messages } = this.promptBuilder.build(promptInput);

    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    try {
      const turn: import('../action-loop.js').TurnInput = {
        session,
        provider,
        model,
        system,
        messages,
        useTools,
        maxActionRounds: settings.maxActionRounds,
        actor: { packId: pack.manifest.id, characterId: character.definition.id, packRoot: pack.root },
        surface,
        limits: settings.runLimits,
        signal: controller.signal,
        origin,
      };
      const hints = character.definition.modelHints;
      if (hints?.temperature !== undefined) turn.temperature = hints.temperature;
      if (hints?.maxTokens !== undefined) turn.maxTokens = hints.maxTokens;
      return await this.o.actionLoop.runTurn(turn);
    } finally {
      if (this.controllers.get(session.id) === controller) this.controllers.delete(session.id);
    }
  }
}

function isSkipLlm(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { skipLlm?: unknown }).skipLlm === true;
}
