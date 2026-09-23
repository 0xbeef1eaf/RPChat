import type { CapabilityRegistry } from '@rp/sdk';
import type { ChatMessage, LlmProvider, ProviderConfig, ScheduledTimer, Session, Storage } from '@rp/shared';
import { RpError, parseCharacterRef, serializeError } from '@rp/shared';
import type { ActionLoop } from '../action-loop.js';
import type { MemoryService } from './memory.js';
import type { BehaviourRunner } from '../behaviours.js';
import { ESTIMATED_SYSTEM_TOKENS, MIN_TRANSCRIPT_BUDGET, PromptBuilder, SELF_WAKE_PREFIX } from '../prompt.js';
import type { AuditService } from './audit.js';
import type { HistoryService } from './history.js';
import type { PackService } from './packs.js';
import { promptSelection, selectionOptions } from './permissions.js';
import type { PermissionService } from './permissions.js';
import type { SessionService } from './sessions.js';
import type { ProviderFactory, SettingsService } from './settings.js';
import type { TimerService } from './timers.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';
import { KeyedQueue } from '../keyed-queue.js';
import { characterScope } from '../handlers/state.js';
import { providerLabel } from './exchanges.js';
import { LIB_STATE_KEY } from './library.js';
import type { LibraryService } from './library.js';

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
  /** When present, old messages are replaced by a rolling summary written in the background. */
  history?: HistoryService;
  /** Used for `timers.run` entries of code timers and `llm.wake` denials. */
  audit?: Pick<AuditService, 'record'>;
  /** Host presence sampler (Phase 2); the senses line is added when the pack has `presence`. */
  senses?: Pick<import('../types.js').SensesProvider, 'snapshot'>;
  mood?: Pick<import('./mood.js').MoodService, 'get'>;
  routine?: Pick<import('./routine.js').RoutineService, 'status'>;
  /** The character's function library: its prelude goes into every action, its listing into the prompt. */
  library?: Pick<LibraryService, 'preludeFor' | 'functions'>;
}

export type SelfWakeSource = 'immediate' | 'timer' | 'wake-timer';

const AUTONOMY_TIMESTAMPS_KEY = 'autonomy.wakeTimestamps';
const AUTONOMY_CONSECUTIVE_KEY = 'autonomy.consecutive';
const HOUR_MS = 60 * 60 * 1000;
/** How many of the latest messages the memory ranker matches against (`memoryFocus`). */
const MEMORY_FOCUS_MESSAGES = 6;

/**
 * Serialises turns per session, runs behaviours around the LLM turn, handles timer wake-ups.
 *
 * Two queues, deliberately separate. `turns` is the session's conversation: the user's messages,
 * self-wakes, the LLM turns they run, and the edits (retry, reset, clear) that must not race with
 * one. `background` is the character's own code — a `code` timer, an `onTimer` behaviour — keyed by
 * what triggered it, so a repeating timer never overlaps itself but nothing it does holds up a
 * reply. Event handlers already worked this way (`EventService.fire`); timers now match them.
 *
 * The tradeoff is the one the event handlers already accepted: a background run and a turn can
 * interleave their writes, so a read-modify-write split across the two — `sdk.state.get` in one and
 * `sdk.state.set` in the other — can lose an update. A single call is safe (`FileStorage` holds one
 * mutable map per scope and serialises the writes to its file); a pair of them is not, and nothing
 * on the host side can make it so. Character code that needs the pair to be atomic needs an atomic
 * primitive in the SDK, which this does not add.
 */
export class ChatService {
  private readonly turns = new KeyedQueue();
  private readonly background = new KeyedQueue();
  /** The in-flight LLM turn of a session: what Stop aborts and what `isRunning` reports. */
  private readonly controllers = new Map<string, AbortController>();
  /** In-flight background runs, keyed like `background`, so shutdown can cut them short. */
  private readonly backgroundControllers = new Map<string, AbortController>();
  private readonly providers = new Map<string, LlmProvider>();
  private readonly promptBuilder: PromptBuilder;
  private readonly turnCounts = new Map<string, number>();
  private readonly pendingWakes = new Map<string, string>();
  /** What the last prompt of a session actually measured, for the background jobs after the turn. */
  private readonly lastPrompt = new Map<string, { transcriptBudgetTokens: number; droppedMessages: number }>();

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
      await this.o.storage.state.set(`session:${sessionId}`, AUTONOMY_CONSECUTIVE_KEY, 0); // a user message resets the consecutive limit
      const fresh = await this.o.sessions.require(sessionId);

      const hook = await this.runBehaviour(fresh, 'onUserMessage', { text });
      const skip = hook?.ok === true && isSkipLlm(hook.returnValue);
      if (skip) return;
      await this.runLlmTurn(fresh, 'llm');
      await this.afterTurn(sessionId);
    });
  }

  /**
   * Re-generate the character's last reply: drop the assistant messages the last turn produced
   * and run the turn again over the history that produced them. Nothing the user typed is
   * re-sent and nothing before the reply is touched, so a retried timer or event turn is still
   * answering the same `[self-wake]` note. With no reply to drop (the turn errored, or was
   * aborted before it said anything) it simply runs the turn again.
   *
   * What the discarded reply already did — media it opened, memories it wrote, timers it set —
   * is not undone: a retry is about the words, not about rewinding the machine.
   */
  async retry(sessionId: string): Promise<void> {
    const session = await this.o.sessions.require(sessionId);
    this.requireCharacter(session); // fail fast (NOT_FOUND) before queueing
    await this.abort(sessionId);
    await this.enqueue(sessionId, async () => {
      const transcript = await this.o.sessions.messages(sessionId);
      const discard = trailingReply(transcript);
      if (discard.length === transcript.length) {
        throw new RpError('INVALID_ARGUMENT', 'There is nothing to reply to yet', { sessionId });
      }
      for (const message of discard) await this.o.sessions.removeMessage(sessionId, message.id);
      const fresh = await this.o.sessions.require(sessionId);
      await this.runLlmTurn(fresh, 'llm');
      await this.afterTurn(sessionId);
    });
  }

  /**
   * Whether a turn is in flight for this session. The app's `allowStopGeneration` restriction
   * reads it to tell a plain retry or reset from one that would cut a reply short.
   */
  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** Abort the running turn of a session (provider request and sandbox run). */
  async abort(sessionId: string): Promise<void> {
    this.controllers.get(sessionId)?.abort();
  }

  /** Delete one message; a running or queued turn is aborted first so it cannot resurrect it. */
  async removeMessage(sessionId: string, messageId: string): Promise<void> {
    await this.abort(sessionId);
    await this.runExclusive(sessionId, () => this.o.sessions.removeMessage(sessionId, messageId));
  }

  /** Reset the session's runtime state (see `SessionService.resetState`); a running turn is aborted first. */
  async resetState(sessionId: string): Promise<void> {
    await this.abort(sessionId);
    await this.runExclusive(sessionId, () => this.o.sessions.resetState(sessionId));
  }

  /** Clear the whole history of a session; a running or queued turn is aborted first. */
  async clearMessages(sessionId: string): Promise<void> {
    await this.abort(sessionId);
    await this.runExclusive(sessionId, async () => {
      await this.o.sessions.clearMessages(sessionId);
      // The summary describes messages that no longer exist, and so do the prompt's measurements.
      await this.o.history?.clear(sessionId);
      this.lastPrompt.delete(sessionId);
    });
  }

  /**
   * Run `task` serialised with the session's turns. Only the Sandbox tab uses this now: the user is
   * sitting in front of that run, so it is meant to have the session to itself. The character's own
   * background code (`code` timers, `onTimer`, event handlers) runs off the turn queue instead.
   */
  runExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const result = this.enqueue(sessionId, task);
    void result.then(() => this.flushImmediateWake(sessionId), () => this.flushImmediateWake(sessionId));
    return result;
  }

  /**
   * `true` while a turn is running or queued for the session. Background code (timers, event
   * handlers) is deliberately not counted: it does not stop the character from being spoken to.
   */
  isBusy(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  /**
   * Wait for everything queued on the session to finish — its turns and the background runs
   * they may have started. A background run can queue a turn (an immediate self-wake) and a turn
   * can start a background run, so this keeps draining until both are quiet.
   */
  async idle(sessionId?: string): Promise<void> {
    for (let pass = 0; pass < 100; pass++) {
      await this.turns.idle(sessionId);
      await this.backgroundIdle(sessionId);
      const turnsQuiet = sessionId === undefined ? this.turns.size === 0 : !this.turns.has(sessionId);
      if (turnsQuiet && this.backgroundKeys(sessionId).length === 0) return;
    }
  }

  /** Background keys are `<sessionId>\0<what triggered the run>`, so they can be drained per session. */
  private backgroundKeys(sessionId?: string): string[] {
    const keys = this.background.keys();
    return sessionId === undefined ? keys : keys.filter((key) => key.startsWith(`${sessionId}\u0000`));
  }

  private async backgroundIdle(sessionId?: string): Promise<void> {
    await Promise.all(this.backgroundKeys(sessionId).map((key) => this.background.idle(key)));
  }

  /**
   * Queue a self-wake that runs right after the current turn finishes (or immediately when the
   * session is idle). A second call before it runs joins the prompts with a newline.
   */
  queueImmediateWake(sessionId: string, prompt: string): void {
    const existing = this.pendingWakes.get(sessionId);
    this.pendingWakes.set(sessionId, existing ? `${existing}\n${prompt}` : prompt);
    if (!this.isBusy(sessionId)) this.flushImmediateWake(sessionId);
  }

  /** Move the pending immediate wake (if any) onto the session queue. */
  private flushImmediateWake(sessionId: string): void {
    const prompt = this.pendingWakes.get(sessionId);
    if (prompt === undefined) return;
    this.pendingWakes.delete(sessionId);
    void this.selfWake(sessionId, prompt, 'immediate').catch((err) => this.o.logger.warn('[chat] immediate self-wake failed', err));
  }

  /**
   * Wake the character with a prompt from its past self: appends a `[self-wake]` system message and
   * runs a normal turn, queued behind any running turn. Subject to the autonomy limits; a dropped
   * wake is audited (`llm.wake` denied) and announced through a `status` event. Resolves `true` when it ran.
   */
  async selfWake(sessionId: string, prompt: string, source: SelfWakeSource = 'immediate'): Promise<boolean> {
    const session = await this.o.sessions.get(sessionId);
    if (!session) return false;
    const { packId } = parseCharacterRef(session.characterRef);
    if (!this.o.packs.tryGetLoaded(packId)) return false;
    return this.enqueue(sessionId, async () => {
      const fresh = await this.o.sessions.require(sessionId);
      if (!(await this.consumeSelfWake(fresh, source, prompt))) return false;
      await this.o.sessions.addMessage({ sessionId, role: 'system', content: `${SELF_WAKE_PREFIX}${prompt}`, origin: 'timer' });
      await this.runLlmTurn(await this.o.sessions.require(sessionId), 'timer');
      await this.afterTurn(sessionId);
      return true;
    });
  }

  /** Apply the per-hour and consecutive self-wake limits; records the wake when allowed. */
  private async consumeSelfWake(session: Session, source: SelfWakeSource, prompt: string): Promise<boolean> {
    const { autonomy } = await this.o.settings.get();
    const scope = `session:${session.id}`;
    const nowMs = this.o.now().getTime();
    const rawStamps = await this.o.storage.state.get(scope, AUTONOMY_TIMESTAMPS_KEY);
    const stamps = (Array.isArray(rawStamps) ? rawStamps : []).filter((s): s is string => typeof s === 'string' && nowMs - Date.parse(s) < HOUR_MS);
    const rawConsecutive = await this.o.storage.state.get(scope, AUTONOMY_CONSECUTIVE_KEY);
    const consecutive = typeof rawConsecutive === 'number' ? rawConsecutive : 0;
    const reason =
      stamps.length >= autonomy.maxSelfWakesPerHour
        ? `per-hour limit (${autonomy.maxSelfWakesPerHour}) reached`
        : consecutive >= autonomy.maxConsecutiveSelfWakes
          ? `consecutive limit (${autonomy.maxConsecutiveSelfWakes}) reached`
          : undefined;
    if (reason) {
      this.o.logger.warn(`[chat] self-wake dropped in session ${session.id}: ${reason}`);
      await this.o.audit?.record({
        sessionId: session.id,
        characterRef: session.characterRef,
        module: 'llm',
        method: 'wake',
        args: [prompt, { source }],
        outcome: 'denied',
        error: { code: 'PERMISSION_DENIED', message: `Self-wake dropped: ${reason}` },
      });
      this.o.emitter.emit('chat', { type: 'status', sessionId: session.id, text: 'paused: autonomy limit reached' });
      return false;
    }
    stamps.push(this.o.now().toISOString());
    await this.o.storage.state.set(scope, AUTONOMY_TIMESTAMPS_KEY, stamps);
    await this.o.storage.state.set(scope, AUTONOMY_CONSECUTIVE_KEY, consecutive + 1);
    return true;
  }

  /** Timer fired: dispatch by kind (`wake` → onTimer behaviour or LLM turn; `code` → run the code; `prompt` → self-wake). */
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
    if (timer.kind === 'prompt') {
      await this.selfWake(session.id, timer.prompt ?? '', 'timer');
      return;
    }
    if (timer.kind === 'code') {
      // Off the session's turn queue: the timer's code is the character's own background work,
      // and a reply it lands in the middle of should not have to wait for it. Still awaited here,
      // so `TimerService` re-arms a repeating timer only once this run is done.
      await this.runInBackground(session.id, `timer:${timer.id}`, (signal) => this.runCodeTimer(session, timer, signal));
      return;
    }
    if (this.o.behaviours.has(session, 'onTimer')) {
      const info: Record<string, import('@rp/shared').Json> = { id: timer.id, payload: (timer.payload ?? null) as import('@rp/shared').Json };
      if (timer.label !== undefined) info.label = timer.label;
      await this.runInBackground(session.id, `timer:${timer.id}`, (signal) =>
        this.runBehaviour(session, 'onTimer', { timer: info }, { kind: 'timer', timerId: timer.id }, signal),
      );
      return;
    }
    // No script to run: this one is a turn, and turns stay on the session's queue.
    await this.enqueue(session.id, async () => {
      if (!(await this.consumeSelfWake(session, 'wake-timer', JSON.stringify(timer.payload ?? null)))) return;
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

  /**
   * Run a background task off the session's turn queue, serialised against anything else queued
   * under the same `key` (a repeating timer, the same subscription). Its abort signal is registered
   * so `abortBackground` can cut it short at shutdown; the session's Stop button does not reach it,
   * because stopping a reply is not meant to cancel the character's standing work.
   */
  private async runInBackground(sessionId: string, key: string, task: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    const full = `${sessionId}\u0000${key}`;
    await this.background.run(full, async () => {
      const controller = new AbortController();
      this.backgroundControllers.set(full, controller);
      try {
        await task(controller.signal);
      } catch (err) {
        this.o.logger.warn(`[chat] background run ${key} in session ${sessionId} failed`, err);
      } finally {
        if (this.backgroundControllers.get(full) === controller) this.backgroundControllers.delete(full);
      }
    });
    this.flushImmediateWake(sessionId);
  }

  /** Cut short every background run, or only a session's. Used when the engine stops. */
  abortBackground(sessionId?: string): void {
    for (const [key, controller] of this.backgroundControllers) {
      if (sessionId !== undefined && !key.startsWith(`${sessionId}\u0000`)) continue;
      controller.abort();
    }
  }

  /** Run a `code` timer through the behaviour path (character surface + permissions) and audit it. */
  private async runCodeTimer(session: Session, timer: ScheduledTimer, signal: AbortSignal): Promise<void> {
    const { packId, characterId } = parseCharacterRef(session.characterRef);
    const started = this.o.now().getTime();
    let result: import('@rp/shared').CodeRunResult | undefined;
    let failure: unknown;
    try {
      result = await this.o.behaviours.runScript(packId, characterId, session.id, timer.code ?? '', (timer.input ?? null) as import('@rp/shared').Json, { kind: 'timer', timerId: timer.id }, { signal });
    } catch (err) {
      failure = err;
    }
    const error = failure ? serializeError(failure) : result && !result.ok ? result.error : undefined;
    if (error) this.o.logger.warn(`[chat] code timer ${timer.id} failed: ${error.message}`);
    const entry: Parameters<AuditService['record']>[0] = {
      sessionId: session.id,
      characterRef: session.characterRef,
      module: 'timers',
      method: 'run',
      args: [timer.id, timer.label ?? null, { runs: (timer.runs ?? 0) + 1 }],
      outcome: error ? 'failed' : 'allowed',
      durationMs: this.o.now().getTime() - started,
    };
    if (error) entry.error = error;
    await this.o.audit?.record(entry);
  }

  /**
   * After `turn-finished`: run a queued immediate self-wake, count turns, then kick off the two
   * background jobs — memory consolidation and, once the transcript outgrows its share of the room
   * the last prompt measured for it, history compression. Both run off the turn.
   */
  private async afterTurn(sessionId: string): Promise<void> {
    this.finishTurn(sessionId);
    const count = (this.turnCounts.get(sessionId) ?? 0) + 1;
    this.turnCounts.set(sessionId, count);
    const settings = await this.o.settings.get();

    const memories = this.o.memories;
    if (memories) {
      const every = Math.max(1, Math.floor(settings.memory.consolidateEveryTurns));
      if (settings.memory.enabled && count % every === 0 && !memories.isConsolidating(sessionId)) {
        void memories.consolidate(sessionId, { auto: true }).catch((err) => this.o.logger.warn('[chat] consolidation failed', err));
      }
    }

    const history = this.o.history;
    if (history && !history.isCompressing(sessionId)) {
      const transcript = await this.o.sessions.messages(sessionId);
      const last = this.lastPrompt.get(sessionId);
      // Messages the window dropped are covered by neither the summary nor the prompt — they fell
      // out of the conversation entirely. Summarise now so the next turn keeps them.
      const dropped = (last?.droppedMessages ?? 0) > 0;
      if (dropped || history.shouldCompress(transcript, settings.history, this.transcriptBudget(sessionId, settings))) {
        void history.compress(sessionId, { auto: true }).catch((err) => this.o.logger.warn('[chat] history compression failed', err));
      }
    }
  }

  /**
   * The room the transcript has, as the last prompt of this session measured it; before there is
   * one, the budget less an estimate of the system prompt.
   */
  private transcriptBudget(sessionId: string, settings: { contextTokenBudget: number }): number {
    const measured = this.lastPrompt.get(sessionId)?.transcriptBudgetTokens;
    if (measured !== undefined) return measured;
    return Math.max(MIN_TRANSCRIPT_BUDGET, settings.contextTokenBudget - ESTIMATED_SYSTEM_TOKENS);
  }

  /** Called when a turn's work is complete: an immediate wake queued during the turn runs next. */
  private finishTurn(sessionId: string): void {
    this.flushImmediateWake(sessionId);
  }

  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.turns.run(sessionId, task);
  }

  private requireCharacter(session: Session): ReturnType<PackService['getCharacter']> {
    return this.o.packs.getCharacter(session.characterRef);
  }

  /**
   * Run a behaviour hook. With no `signal` it is part of the turn (`onUserMessage`, which runs
   * before the LLM call and which Stop must reach), so it registers as the session's running
   * controller; with one it is a background run that brought its own.
   */
  private async runBehaviour(
    session: Session,
    hook: 'onUserMessage' | 'onTimer',
    input: import('@rp/shared').Json,
    trigger?: import('@rp/shared').ActionTrigger,
    signal?: AbortSignal,
  ): Promise<import('@rp/shared').CodeRunResult | undefined> {
    if (!this.o.behaviours.has(session, hook)) return undefined;
    const controller = signal ? undefined : new AbortController();
    if (controller) this.controllers.set(session.id, controller);
    try {
      const options: import('../behaviours.js').BehaviourRunOptions = { signal: signal ?? controller!.signal };
      if (trigger) options.trigger = trigger;
      return await this.o.behaviours.run(session, hook, input, options);
    } catch (err) {
      this.o.logger.warn(`[chat] ${hook} behaviour failed in session ${session.id}`, err);
      this.o.emitter.emit('chat', { type: 'error', sessionId: session.id, error: serializeError(err) });
      return undefined;
    } finally {
      if (controller && this.controllers.get(session.id) === controller) this.controllers.delete(session.id);
    }
  }

  /** Fill `sinceLastMessageMs`, `localTime` and `dayPart` when the host left them out. */
  private completeSnapshot(snapshot: import('@rp/shared').PresenceSnapshot, transcript: ChatMessage[]): import('@rp/shared').PresenceSnapshot {
    const now = this.o.now();
    const out = { ...snapshot };
    if (out.sinceLastMessageMs === undefined) {
      const lastUser = [...transcript].reverse().find((m) => m.role === 'user');
      out.sinceLastMessageMs = lastUser ? now.getTime() - Date.parse(lastUser.createdAt) : null;
    }
    if (!out.localTime) out.localTime = now.toLocaleTimeString(this.o.locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (!out.dayPart) out.dayPart = dayPartOf(now.getHours());
    if (!out.at) out.at = now.toISOString();
    return out;
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

    // What the code may call, and — narrowed by the pack author's `promptFunctions` — what the
    // character is told about. The two differ on purpose: an author may keep a module out of the
    // reference while their own `lib` functions still use it.
    const allowedFunctions = await this.o.permissions.allowedFunctions(pack.manifest.id);
    const sdkSelection = selectionOptions(promptSelection(allowedFunctions, character.definition.promptFunctions));
    const allowedModules = allowedFunctions.map((m) => m.id);
    const surface = await this.o.behaviours.surfaceFor(pack.manifest.id);
    const target = { packId: pack.manifest.id, characterId: character.definition.id };
    const state = await this.o.storage.state.all(characterScope(target));
    delete state[LIB_STATE_KEY]; // the library has its own <library> section; the raw sources would only bloat <state>
    const library = this.o.library ? await this.o.library.functions(target) : [];
    const prelude = this.o.library ? await this.o.library.preludeFor(target.packId, target.characterId) : undefined;
    const timers = await this.o.timers.list({ characterRef: session.characterRef });
    const transcript = await this.o.sessions.messages(session.id);
    let memories: import('@rp/shared').MemoryEntry[] = [];
    if (this.o.memories && settings.memory.enabled) {
      memories = await this.o.memories.forPrompt(session.characterRef, memoryFocus(transcript), settings.memory.promptBudgetTokens);
    }

    const summary = this.o.history ? await this.o.history.summaryFor(session.id) : undefined;

    const promptInput: import('../prompt.js').PromptInput = {
      pack,
      character,
      registry: this.o.registry,
      sdkSelection,
      session,
      transcript,
      state,
      timers,
      memories,
      userDisplayName: settings.userDisplayName,
      minDelayMs: Math.max(1000, settings.autonomy.minDelayMs),
      contextTokenBudget: settings.contextTokenBudget,
      keepActionDetailFor: Math.max(0, Math.floor(settings.history.keepActionDetailFor)),
      useTools,
      now: this.o.now(),
    };
    if (summary) promptInput.historySummary = summary;
    if (library.length > 0) promptInput.library = library;
    if (this.o.locale !== undefined) promptInput.locale = this.o.locale;
    if (this.o.senses && settings.senses.includeInPrompt && allowedModules.includes('presence')) {
      try {
        promptInput.senses = this.completeSnapshot(await this.o.senses.snapshot(session.id), transcript);
      } catch (err) {
        this.o.logger.warn('[chat] senses snapshot failed', err);
      }
    }
    if (this.o.mood) promptInput.mood = await this.o.mood.get(session.characterRef);
    if (this.o.routine) promptInput.routine = await this.o.routine.status(session.characterRef);
    const { system, messages, stats, stablePrefixLength } = this.promptBuilder.build(promptInput);
    this.lastPrompt.set(session.id, { transcriptBudgetTokens: stats.transcriptBudgetTokens, droppedMessages: stats.droppedMessages });
    if (stats.systemTokens * 2 > stats.budgetTokens || stats.droppedMessages > 0) {
      this.o.logger.warn(
        `[chat] prompt budget: system ~${stats.systemTokens} tokens (sdk reference ~${stats.sdkReferenceTokens}) of ${stats.budgetTokens}; ` +
          `${stats.transcriptBudgetTokens} left for the transcript, ${stats.droppedMessages} older message(s) dropped` +
          (stats.summarisedMessages > 0 ? `; ${stats.summarisedMessages} summarised into ~${stats.summaryTokens} tokens` : '') +
          (stats.trimmedActionMessages > 0 ? `; action detail trimmed from ${stats.trimmedActionMessages} message(s)` : '') +
          (stats.systemTokens * 2 > stats.budgetTokens ? ' — raise Settings → General → context token budget or switch off modules under Settings → Permissions' : ''),
      );
    }

    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    try {
      const turn: import('../action-loop.js').TurnInput = {
        session,
        provider,
        model,
        system,
        systemStablePrefixChars: stablePrefixLength,
        messages,
        useTools,
        maxActionRounds: settings.maxActionRounds,
        actor: { packId: pack.manifest.id, characterId: character.definition.id, packRoot: pack.root },
        surface,
        limits: settings.runLimits,
        signal: controller.signal,
        origin,
        captureExchanges: settings.debug.showModelTraffic,
        providerLabel: providerLabel(config),
      };
      if (prelude !== undefined) turn.prelude = prelude;
      const hints = character.definition.modelHints;
      if (hints?.temperature !== undefined) turn.temperature = hints.temperature;
      if (hints?.maxTokens !== undefined) turn.maxTokens = hints.maxTokens;
      return await this.o.actionLoop.runTurn(turn);
    } finally {
      if (this.controllers.get(session.id) === controller) this.controllers.delete(session.id);
    }
  }
}

/**
 * What the memory ranker matches against: the last few things either of them said, newest last.
 * The latest message alone is too narrow a handle — a thread picked up a few messages ago should
 * still pull its memories into the prompt.
 */
export function memoryFocus(transcript: ChatMessage[], count = MEMORY_FOCUS_MESSAGES): string {
  const said = transcript.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0);
  return said
    .slice(-Math.max(1, count))
    .map((m) => m.content)
    .join('\n');
}

/**
 * The messages the last turn produced: the run of assistant messages at the end of the
 * transcript (a turn can add several — an `sdk.chat.emote`, then the reply). Everything
 * before them is the turn's input and stays.
 *
 * Within that run, only the messages of the last turn are its own. Background code runs
 * alongside a turn now, so an event handler or a timer may have said something in the middle of
 * the reply; those messages carry no `turnId` and are not the turn's to take back. Messages from
 * before `turnId` existed have none either, so a run with no turn in it at all is treated the old
 * way — the whole run is the reply.
 */
export function trailingReply(transcript: ChatMessage[]): ChatMessage[] {
  let start = transcript.length;
  while (start > 0 && transcript[start - 1]?.role === 'assistant') start--;
  const run = transcript.slice(start);
  const last = [...run].reverse().find((m) => m.turnId !== undefined)?.turnId;
  if (last === undefined) return run;
  return run.filter((m) => m.turnId === last);
}

export function dayPartOf(hour: number): import('@rp/shared').PresenceSnapshot['dayPart'] {
  if (hour < 5) return 'night';
  if (hour < 8) return 'early-morning';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'late-evening';
}

function isSkipLlm(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { skipLlm?: unknown }).skipLlm === true;
}
