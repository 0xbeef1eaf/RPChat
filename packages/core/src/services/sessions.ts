import { randomUUID } from 'node:crypto';
import type { ChatMessage, CreateSessionInput, Session, Storage } from '@rp/shared';
import { RpError, serializeError } from '@rp/shared';
import type { PackService } from './packs.js';
import type { PermissionService } from './permissions.js';
import type { TimerService } from './timers.js';
import type { BehaviourHooks, Clock, EngineEmitter, Logger } from '../types.js';

const PREVIEW_CHARS = 120;

export type NewMessage = Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>;

/** Session CRUD plus the single place where messages are appended/updated (persist + event + stats). */
export class SessionService {
  private behaviours: BehaviourHooks | undefined;
  private beforeRemove: ((session: Session) => Promise<void>) | undefined;
  private afterRemove: ((session: Session) => Promise<void>) | undefined;

  constructor(
    private readonly storage: Pick<Storage, 'sessions' | 'messages' | 'state'>,
    private readonly packs: PackService,
    private readonly permissions: PermissionService,
    private readonly timers: TimerService,
    private readonly emitter: EngineEmitter,
    private readonly now: Clock,
    private readonly logger: Logger,
  ) {}

  setBehaviours(behaviours: BehaviourHooks): void {
    this.behaviours = behaviours;
  }

  /** Runs before a session is deleted (the Engine uses it for a final memory consolidation). Failures are logged. */
  setBeforeRemove(hook: (session: Session) => Promise<void>): void {
    this.beforeRemove = hook;
  }

  /** Runs after a session was deleted (the Engine removes its event subscriptions). */
  setAfterRemove(hook: (session: Session) => Promise<void>): void {
    this.afterRemove = hook;
  }

  async list(): Promise<Session[]> {
    const sessions = await this.storage.sessions.list();
    return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  get(sessionId: string): Promise<Session | undefined> {
    return this.storage.sessions.get(sessionId);
  }

  async require(sessionId: string): Promise<Session> {
    const session = await this.storage.sessions.get(sessionId);
    if (!session) throw new RpError('NOT_FOUND', `Session "${sessionId}" does not exist`, { sessionId });
    return session;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const { pack, character } = this.packs.getCharacter(input.characterRef);
    const at = this.now().toISOString();
    const session: Session = {
      id: randomUUID(),
      characterRef: input.characterRef,
      title: input.title?.trim() || `${character.definition.name} (${pack.manifest.name})`,
      createdAt: at,
      updatedAt: at,
      messageCount: 0,
    };
    if (input.scenario !== undefined) session.scenario = input.scenario;
    if (input.providerId !== undefined) session.providerId = input.providerId;
    if (input.model !== undefined) session.model = input.model;
    await this.storage.sessions.upsert(session);

    if (character.definition.greeting) {
      await this.addMessage({ sessionId: session.id, role: 'assistant', content: character.definition.greeting, origin: 'greeting' });
    }
    await this.runHook(session, 'onSessionStart');
    return this.require(session.id);
  }

  async update(session: Session): Promise<Session> {
    const existing = await this.require(session.id);
    const next: Session = {
      ...existing,
      ...session,
      id: existing.id,
      characterRef: existing.characterRef,
      createdAt: existing.createdAt,
      messageCount: existing.messageCount,
      updatedAt: this.now().toISOString(),
    };
    await this.storage.sessions.upsert(next);
    return next;
  }

  async remove(sessionId: string): Promise<void> {
    const session = await this.storage.sessions.get(sessionId);
    if (!session) return;
    if (this.beforeRemove) {
      try {
        await this.beforeRemove(session);
      } catch (err) {
        this.logger.warn(`[sessions] before-remove hook failed for ${sessionId}`, err);
      }
    }
    await this.runHook(session, 'onSessionEnd');
    await this.timers.removeForSession(sessionId);
    await this.storage.messages.removeForSession(sessionId);
    await this.storage.state.clear(`session:${sessionId}`);
    this.permissions.clearSession(sessionId);
    await this.storage.sessions.remove(sessionId);
    if (this.afterRemove) {
      try {
        await this.afterRemove(session);
      } catch (err) {
        this.logger.warn(`[sessions] after-remove hook failed for ${sessionId}`, err);
      }
    }
  }

  messages(sessionId: string): Promise<ChatMessage[]> {
    return this.storage.messages.list(sessionId);
  }

  /** Persist a new message, refresh the session stats and emit `message-added`. */
  async addMessage(input: NewMessage): Promise<ChatMessage> {
    const message: ChatMessage = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? this.now().toISOString() };
    await this.storage.messages.append(message);
    await this.refreshStats(message.sessionId);
    this.emitter.emit('chat', { type: 'message-added', sessionId: message.sessionId, message });
    return message;
  }

  /** Persist a changed message and refresh the session stats (no event; callers emit `message-updated`). */
  async persistMessage(message: ChatMessage): Promise<void> {
    await this.storage.messages.update(message);
    await this.refreshStats(message.sessionId);
  }

  private async refreshStats(sessionId: string): Promise<void> {
    const session = await this.storage.sessions.get(sessionId);
    if (!session) return;
    const messages = await this.storage.messages.list(sessionId);
    const last = [...messages].reverse().find((m) => m.content.trim().length > 0);
    session.messageCount = messages.length;
    session.updatedAt = this.now().toISOString();
    if (last) session.lastMessagePreview = last.content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
    await this.storage.sessions.upsert(session);
  }

  private async runHook(session: Session, hook: 'onSessionStart' | 'onSessionEnd'): Promise<void> {
    if (!this.behaviours || !this.packs.tryGetLoaded(session.characterRef.split('/')[0] ?? '')) return;
    try {
      await this.behaviours.run(session, hook);
    } catch (err) {
      this.logger.warn(`[sessions] ${hook} behaviour failed for ${session.characterRef}`, err);
      this.emitter.emit('chat', { type: 'error', sessionId: session.id, error: serializeError(err) });
    }
  }
}
