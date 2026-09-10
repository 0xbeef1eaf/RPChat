import type {
  AppSettings,
  AuditEntry,
  CapabilityGrant,
  ChatMessage,
  EventSubscription,
  InstalledPackRecord,
  Json,
  MemoryEntry,
  ScheduledTimer,
  Session,
  SessionId,
  Storage,
} from '@rp/shared';
import { defaultSettings } from '../defaults.js';

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** In-memory `Storage` for tests and dev mode. Values are deep-copied on the way in and out. */
export class MemoryStorage implements Storage {
  private settingsValue: AppSettings | undefined;
  private readonly packRecords = new Map<string, InstalledPackRecord>();
  private readonly grantRecords = new Map<string, CapabilityGrant>();
  private readonly sessionRecords = new Map<string, Session>();
  private readonly messageRecords = new Map<string, ChatMessage[]>();
  private readonly stateRecords = new Map<string, Map<string, Json>>();
  private readonly timerRecords = new Map<string, ScheduledTimer>();
  private readonly memoryRecords = new Map<string, MemoryEntry>();
  private readonly subscriptionRecords = new Map<string, EventSubscription>();
  private readonly auditEntries: AuditEntry[] = [];

  constructor(private readonly auditCap = 5000) {}

  readonly settings: Storage['settings'] = {
    get: async () => clone(this.settingsValue ?? defaultSettings()),
    set: async (settings) => {
      this.settingsValue = clone(settings);
    },
  };

  readonly packs: Storage['packs'] = {
    list: async () => [...this.packRecords.values()].map(clone),
    get: async (packId) => clone(this.packRecords.get(packId)),
    upsert: async (record) => {
      this.packRecords.set(record.packId, clone(record));
    },
    remove: async (packId) => {
      this.packRecords.delete(packId);
    },
  };

  readonly grants: Storage['grants'] = {
    list: async (packId) =>
      [...this.grantRecords.values()].filter((g) => packId === undefined || g.packId === packId).map(clone),
    set: async (grant) => {
      this.grantRecords.set(`${grant.packId} ${grant.module}`, clone(grant));
    },
    removeForPack: async (packId) => {
      for (const [key, grant] of this.grantRecords) if (grant.packId === packId) this.grantRecords.delete(key);
    },
  };

  readonly sessions: Storage['sessions'] = {
    list: async () => [...this.sessionRecords.values()].map(clone),
    get: async (id) => clone(this.sessionRecords.get(id)),
    upsert: async (session) => {
      this.sessionRecords.set(session.id, clone(session));
    },
    remove: async (id) => {
      this.sessionRecords.delete(id);
    },
  };

  readonly messages: Storage['messages'] = {
    list: async (sessionId: SessionId) => (this.messageRecords.get(sessionId) ?? []).map(clone),
    append: async (message) => {
      let list = this.messageRecords.get(message.sessionId);
      if (!list) {
        list = [];
        this.messageRecords.set(message.sessionId, list);
      }
      list.push(clone(message));
    },
    update: async (message) => {
      const list = this.messageRecords.get(message.sessionId);
      const idx = list?.findIndex((m) => m.id === message.id) ?? -1;
      if (list && idx >= 0) list[idx] = clone(message);
      else await this.messages.append(message);
    },
    remove: async (sessionId, messageId) => {
      const list = this.messageRecords.get(sessionId);
      if (list) this.messageRecords.set(sessionId, list.filter((m) => m.id !== messageId));
    },
    removeForSession: async (sessionId) => {
      this.messageRecords.delete(sessionId);
    },
  };

  readonly state: Storage['state'] = {
    get: async (scope, key) => clone(this.stateRecords.get(scope)?.get(key)),
    set: async (scope, key, value) => {
      let map = this.stateRecords.get(scope);
      if (!map) {
        map = new Map();
        this.stateRecords.set(scope, map);
      }
      map.set(key, clone(value));
    },
    delete: async (scope, key) => {
      this.stateRecords.get(scope)?.delete(key);
    },
    keys: async (scope) => [...(this.stateRecords.get(scope)?.keys() ?? [])].sort(),
    all: async (scope) => {
      const out: Record<string, Json> = {};
      const map = this.stateRecords.get(scope);
      if (!map) return out;
      for (const key of [...map.keys()].sort()) out[key] = clone(map.get(key) as Json);
      return out;
    },
    clear: async (scope) => {
      this.stateRecords.delete(scope);
    },
  };

  readonly timers: Storage['timers'] = {
    list: async () => [...this.timerRecords.values()].map(clone),
    upsert: async (timer) => {
      this.timerRecords.set(timer.id, clone(timer));
    },
    remove: async (id) => {
      this.timerRecords.delete(id);
    },
  };

  readonly memories: Storage['memories'] = {
    list: async (characterRef) => [...this.memoryRecords.values()].filter((m) => m.characterRef === characterRef).map(clone),
    get: async (id) => clone(this.memoryRecords.get(id)),
    upsert: async (entry) => {
      this.memoryRecords.set(entry.id, clone(entry));
    },
    remove: async (id) => {
      this.memoryRecords.delete(id);
    },
    removeForCharacter: async (characterRef) => {
      for (const [id, m] of this.memoryRecords) if (m.characterRef === characterRef) this.memoryRecords.delete(id);
    },
  };

  readonly subscriptions: Storage['subscriptions'] = {
    list: async (sessionId) =>
      [...this.subscriptionRecords.values()].filter((s) => sessionId === undefined || s.sessionId === sessionId).map(clone),
    upsert: async (sub) => {
      this.subscriptionRecords.set(sub.id, clone(sub));
    },
    remove: async (id) => {
      this.subscriptionRecords.delete(id);
    },
    removeForSession: async (sessionId) => {
      for (const [id, s] of this.subscriptionRecords) if (s.sessionId === sessionId) this.subscriptionRecords.delete(id);
    },
  };

  readonly audit: Storage['audit'] = {
    append: async (entry) => {
      this.auditEntries.push(clone(entry));
      if (this.auditEntries.length > this.auditCap) this.auditEntries.splice(0, this.auditEntries.length - this.auditCap);
    },
    list: async (options) => {
      let entries = this.auditEntries;
      if (options?.sessionId !== undefined) entries = entries.filter((e) => e.sessionId === options.sessionId);
      if (options?.limit !== undefined) entries = entries.slice(-Math.max(0, options.limit));
      return entries.map(clone);
    },
  };

  async close(): Promise<void> {
    /* nothing to release */
  }
}
