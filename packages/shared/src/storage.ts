import type { AuditEntry, ChatMessage, ScheduledTimer, Session } from './chat.js';
import type { Json, SessionId } from './ids.js';
import type { InstalledPackRecord } from './pack.js';
import type { MemoryEntry } from './memory.js';
import type { EventSubscription } from './senses.js';
import type { AppSettings } from './settings.js';

/** Persistence contract. Implemented by `FileStorage` and `MemoryStorage` in `@rp/core`. */
export interface Storage {
  settings: {
    get(): Promise<AppSettings>;
    set(settings: AppSettings): Promise<void>;
  };
  packs: {
    list(): Promise<InstalledPackRecord[]>;
    get(packId: string): Promise<InstalledPackRecord | undefined>;
    upsert(record: InstalledPackRecord): Promise<void>;
    remove(packId: string): Promise<void>;
  };
  sessions: {
    list(): Promise<Session[]>;
    get(id: SessionId): Promise<Session | undefined>;
    upsert(session: Session): Promise<void>;
    remove(id: SessionId): Promise<void>;
  };
  messages: {
    list(sessionId: SessionId): Promise<ChatMessage[]>;
    append(message: ChatMessage): Promise<void>;
    update(message: ChatMessage): Promise<void>;
    /** Delete one message; no error when it does not exist. */
    remove(sessionId: SessionId, messageId: string): Promise<void>;
    removeForSession(sessionId: SessionId): Promise<void>;
  };
  /** Key/value state scoped by `scope` (e.g. `char:<packId>/<charId>` or `session:<id>`). */
  state: {
    get(scope: string, key: string): Promise<Json | undefined>;
    set(scope: string, key: string, value: Json): Promise<void>;
    delete(scope: string, key: string): Promise<void>;
    keys(scope: string): Promise<string[]>;
    all(scope: string): Promise<Record<string, Json>>;
    clear(scope: string): Promise<void>;
  };
  timers: {
    list(): Promise<ScheduledTimer[]>;
    upsert(timer: ScheduledTimer): Promise<void>;
    remove(id: string): Promise<void>;
  };
  memories: {
    list(characterRef: string): Promise<MemoryEntry[]>;
    get(id: string): Promise<MemoryEntry | undefined>;
    upsert(entry: MemoryEntry): Promise<void>;
    remove(id: string): Promise<void>;
    removeForCharacter(characterRef: string): Promise<void>;
  };
  subscriptions: {
    list(sessionId?: SessionId): Promise<EventSubscription[]>;
    upsert(sub: EventSubscription): Promise<void>;
    remove(id: string): Promise<void>;
    removeForSession(sessionId: SessionId): Promise<void>;
  };
  audit: {
    append(entry: AuditEntry): Promise<void>;
    list(options?: { sessionId?: SessionId; limit?: number }): Promise<AuditEntry[]>;
  };
  close(): Promise<void>;
}
