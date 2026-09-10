import { randomUUID } from 'node:crypto';
import { estimateTokens } from '@rp/llm';
import type { ChatMessage, LlmChatRequest, LlmProvider, MemoryEntry, MemoryImportance, MemorySource, Storage } from '@rp/shared';
import { RpError, parseCharacterRef } from '@rp/shared';
import { jaccard, promptOrder, rankMemories, tokenize } from '../memory/rank.js';
import { providerLabel, recordExchange } from './exchanges.js';
import type { PackService } from './packs.js';
import type { ProviderFactory, SettingsService } from './settings.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';

export const MEMORY_TEXT_MAX = 500;
export const MEMORY_TAGS_MAX = 10;
export const MEMORY_TAG_MAX_CHARS = 32;
export const CONSOLIDATION_MIN_MESSAGES = 4;
export const CONSOLIDATION_DEDUPE_THRESHOLD = 0.6;
const CONSOLIDATION_MARKER_KEY = 'memory.lastConsolidatedMessageId';
const CONSOLIDATION_MAX_TOKENS = 1024;
const CONSOLIDATION_TRANSCRIPT_CHARS = 24_000;

export interface AddMemoryOptions {
  tags?: string[];
  importance?: number;
  /** Default `user` (what the UI creates); the SDK handler passes `character`, consolidation passes `consolidation`. */
  source?: MemorySource;
  sessionId?: string;
}

export interface MemoryServiceOptions {
  storage: Pick<Storage, 'memories' | 'messages' | 'state' | 'sessions'>;
  settings: SettingsService;
  packs: Pick<PackService, 'getCharacter' | 'tryGetLoaded'>;
  providerFactory: ProviderFactory;
  emitter: EngineEmitter;
  now: Clock;
  logger: Logger;
}

export interface ConsolidateOptions {
  /** `true` when triggered automatically: honours `settings.memory.enabled`. */
  auto?: boolean;
}

interface Candidate {
  text: string;
  tags: string[];
  importance: MemoryImportance;
}

export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().slice(0, MEMORY_TAG_MAX_CHARS);
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
    if (out.length >= MEMORY_TAGS_MAX) break;
  }
  return out;
}

export function normalizeImportance(input: unknown, fallback: MemoryImportance = 3): MemoryImportance {
  const n = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n))) as MemoryImportance;
}

export function normalizeText(input: unknown): string {
  if (typeof input !== 'string') throw new RpError('INVALID_ARGUMENT', 'memory text must be a string');
  const text = input.replace(/\s+/g, ' ').trim();
  if (text.length === 0) throw new RpError('INVALID_ARGUMENT', 'memory text must not be empty');
  return text.length > MEMORY_TEXT_MAX ? `${text.slice(0, MEMORY_TEXT_MAX - 1).trimEnd()}…` : text;
}

/** Render one memory as a prompt line: `- (importance/5, date) text [tags]`. */
export function memoryLine(entry: MemoryEntry): string {
  const date = entry.createdAt.slice(0, 10);
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  return `- (${entry.importance}/5, ${date}) ${entry.text}${tags}`;
}

/** Extract the first JSON array from model output (tolerates code fences and prose around it). */
export function parseJsonArray(text: string): unknown[] | undefined {
  const cleaned = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const start = cleaned.indexOf('[');
  if (start < 0) return undefined;
  for (let end = cleaned.lastIndexOf(']'); end > start; end = cleaned.lastIndexOf(']', end - 1)) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try a shorter slice
    }
  }
  return undefined;
}

/** Long-term character memories: CRUD, ranking, prompt selection and LLM-driven consolidation. */
export class MemoryService {
  private readonly consolidating = new Map<string, Promise<MemoryEntry[]>>();

  constructor(private readonly o: MemoryServiceOptions) {}

  /** All memories of a character, most recently updated first. */
  async list(characterRef: string): Promise<MemoryEntry[]> {
    const entries = await this.o.storage.memories.list(characterRef);
    return entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  get(id: string): Promise<MemoryEntry | undefined> {
    return this.o.storage.memories.get(id);
  }

  async add(characterRef: string, text: string, options: AddMemoryOptions = {}): Promise<MemoryEntry> {
    parseCharacterRef(characterRef);
    const at = this.o.now().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      characterRef,
      text: normalizeText(text),
      tags: normalizeTags(options.tags),
      importance: normalizeImportance(options.importance),
      source: options.source ?? 'user',
      createdAt: at,
      updatedAt: at,
      recallCount: 0,
    };
    if (options.sessionId !== undefined) entry.sessionId = options.sessionId;
    await this.o.storage.memories.upsert(entry);
    return entry;
  }

  /** Change text/tags/importance of an existing memory (other fields are kept from storage). */
  async update(entry: Pick<MemoryEntry, 'id'> & Partial<Pick<MemoryEntry, 'text' | 'tags' | 'importance'>>): Promise<MemoryEntry> {
    const existing = await this.o.storage.memories.get(entry.id);
    if (!existing) throw new RpError('NOT_FOUND', `Memory "${entry.id}" does not exist`, { id: entry.id });
    const next: MemoryEntry = {
      ...existing,
      text: entry.text !== undefined ? normalizeText(entry.text) : existing.text,
      tags: entry.tags !== undefined ? normalizeTags(entry.tags) : existing.tags,
      importance: entry.importance !== undefined ? normalizeImportance(entry.importance, existing.importance) : existing.importance,
      updatedAt: this.o.now().toISOString(),
    };
    await this.o.storage.memories.upsert(next);
    return next;
  }

  /** `true` when a memory was removed. */
  async remove(id: string): Promise<boolean> {
    const existing = await this.o.storage.memories.get(id);
    if (!existing) return false;
    await this.o.storage.memories.remove(id);
    return true;
  }

  async removeForCharacter(characterRef: string): Promise<void> {
    await this.o.storage.memories.removeForCharacter(characterRef);
  }

  /** Newest memories first. */
  async recent(characterRef: string, limit = 10): Promise<MemoryEntry[]> {
    const entries = await this.o.storage.memories.list(characterRef);
    return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, Math.max(0, limit));
  }

  /** Ranked keyword/tag search. Returned entries get their recall stats bumped (unless `touch` is false). */
  async search(characterRef: string, query: string, limit = 10, options: { touch?: boolean } = {}): Promise<MemoryEntry[]> {
    const entries = await this.o.storage.memories.list(characterRef);
    const now = this.o.now();
    const hits = rankMemories(entries, query, now)
      .filter((s) => s.match > 0)
      .slice(0, Math.max(0, limit))
      .map((s) => s.entry);
    if (options.touch !== false && hits.length > 0) {
      const at = now.toISOString();
      await Promise.all(
        hits.map((h) => {
          h.lastRecalledAt = at;
          h.recallCount = (h.recallCount ?? 0) + 1;
          return this.o.storage.memories.upsert(h);
        }),
      );
    }
    return hits;
  }

  /**
   * Memories for the `<memories>` prompt section: the best matches for `focusText`, always
   * including the top-3 by importance and the 3 newest, deduplicated, trimmed to `budgetTokens`,
   * in stable order (importance desc, createdAt asc).
   */
  async forPrompt(characterRef: string, focusText: string, budgetTokens: number): Promise<MemoryEntry[]> {
    const entries = await this.o.storage.memories.list(characterRef);
    if (entries.length === 0 || budgetTokens <= 0) return [];
    const now = this.o.now();
    const byImportance = [...entries].sort((a, b) => b.importance - a.importance || (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 3);
    const newest = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 3);
    const ranked = rankMemories(entries, focusText, now).map((s) => s.entry);

    const picked: MemoryEntry[] = [];
    const seen = new Set<string>();
    let used = 0;
    for (const entry of [...byImportance, ...newest, ...ranked]) {
      if (seen.has(entry.id)) continue;
      const cost = estimateTokens(memoryLine(entry)) + 1;
      if (used + cost > budgetTokens) {
        if (picked.length === 0) continue; // keep looking for something that fits
        break;
      }
      seen.add(entry.id);
      picked.push(entry);
      used += cost;
    }
    return promptOrder(picked);
  }

  /** Whether a consolidation is running for the session. */
  isConsolidating(sessionId: string): boolean {
    return this.consolidating.has(sessionId);
  }

  /** Wait for in-flight consolidations (all, or one session's). */
  async idle(sessionId?: string): Promise<void> {
    const pending = sessionId === undefined ? [...this.consolidating.values()] : [this.consolidating.get(sessionId)];
    await Promise.all(pending.map((p) => p?.catch(() => undefined)));
  }

  /**
   * Distil durable memories from the session's messages since the last consolidation marker.
   * Serialised per session; a call while one runs returns the running promise. Never throws.
   */
  consolidate(sessionId: string, options: ConsolidateOptions = {}): Promise<MemoryEntry[]> {
    const running = this.consolidating.get(sessionId);
    if (running) return running;
    const task = this.runConsolidation(sessionId, options)
      .catch((err) => {
        this.o.logger.warn(`[memory] consolidation failed for session ${sessionId}`, err);
        return [] as MemoryEntry[];
      })
      .finally(() => {
        if (this.consolidating.get(sessionId) === task) this.consolidating.delete(sessionId);
      });
    this.consolidating.set(sessionId, task);
    return task;
  }

  private async runConsolidation(sessionId: string, options: ConsolidateOptions): Promise<MemoryEntry[]> {
    const settings = await this.o.settings.get();
    if (options.auto && !settings.memory.enabled) return [];
    const session = await this.o.storage.sessions.get(sessionId);
    if (!session) return [];
    const { packId } = parseCharacterRef(session.characterRef);
    if (!this.o.packs.tryGetLoaded(packId)) return [];
    const { character } = this.o.packs.getCharacter(session.characterRef);
    const characterName = character.definition.name;

    const all = await this.o.storage.messages.list(sessionId);
    const marker = await this.o.storage.state.get(`session:${sessionId}`, CONSOLIDATION_MARKER_KEY);
    const markerIdx = typeof marker === 'string' ? all.findIndex((m) => m.id === marker) : -1;
    const fresh = all.slice(markerIdx + 1).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0);
    if (fresh.length < CONSOLIDATION_MIN_MESSAGES) return [];
    const lastId = all[all.length - 1]?.id;

    const existing = await this.o.storage.memories.list(session.characterRef);
    const config = await this.o.settings.resolveProvider(session.providerId);
    const provider: LlmProvider = this.o.providerFactory(config);
    const model = session.model ?? config.model;

    const system = [
      `You maintain the long-term memory of ${characterName}. From the conversation, extract durable facts about the user, their life, preferences, the relationship and notable events worth remembering later.`,
      `Write each memory in ${characterName}'s voice as one to three sentences (max ${MEMORY_TEXT_MAX} characters). Skip small talk, transient states and anything already known.`,
      'Return ONLY a JSON array of {"text": string, "tags": string[], "importance": 1-5} objects (importance 1 = trivia, 5 = defining fact). Return [] when there is nothing new.',
      `Existing memories (do not repeat): ${JSON.stringify(existing.map((e) => e.text))}`,
    ].join('\n');
    const transcript = this.renderTranscript(fresh, characterName, settings.userDisplayName);

    const request: LlmChatRequest = {
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      maxTokens: CONSOLIDATION_MAX_TOKENS,
      temperature: 0,
    };
    const response = settings.debug.showModelTraffic
      ? await recordExchange(this.o.emitter, this.o.now, { sessionId, kind: 'memory', provider: providerLabel(config) }, request, () => provider.chat(request))
      : await provider.chat(request);
    const reply = response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const candidates = this.parseCandidates(reply);

    const added: MemoryEntry[] = [];
    const pool = [...existing];
    for (const c of candidates) {
      const tokens = tokenize(c.text);
      const dup = pool.find((e) => jaccard(tokens, tokenize(e.text)) >= CONSOLIDATION_DEDUPE_THRESHOLD);
      if (dup) {
        if (c.importance > dup.importance) {
          const updated = await this.update({ id: dup.id, importance: c.importance });
          pool[pool.indexOf(dup)] = updated;
        }
        continue;
      }
      const entry = await this.add(session.characterRef, c.text, { tags: c.tags, importance: c.importance, source: 'consolidation', sessionId });
      pool.push(entry);
      added.push(entry);
      this.o.emitter.emit('chat', { type: 'memory-added', sessionId, memory: entry });
    }

    if (lastId !== undefined) await this.o.storage.state.set(`session:${sessionId}`, CONSOLIDATION_MARKER_KEY, lastId);
    await this.prune(session.characterRef, settings.memory.maxEntriesPerCharacter);
    return added;
  }

  /** Drop memories beyond `max`: lowest importance, then least recalled, then oldest; `user` ones last. */
  async prune(characterRef: string, max: number): Promise<number> {
    const entries = await this.o.storage.memories.list(characterRef);
    if (entries.length <= max) return 0;
    const order = [...entries].sort(
      (a, b) =>
        Number(a.source === 'user') - Number(b.source === 'user') ||
        a.importance - b.importance ||
        (a.recallCount ?? 0) - (b.recallCount ?? 0) ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
    );
    const victims = order.slice(0, entries.length - max);
    for (const v of victims) await this.o.storage.memories.remove(v.id);
    return victims.length;
  }

  private renderTranscript(messages: ChatMessage[], characterName: string, userName: string): string {
    const lines = messages.map((m) => `${m.role === 'user' ? userName || 'User' : characterName}: ${m.kind === 'emote' ? `*${m.content}*` : m.content}`);
    let text = lines.join('\n');
    if (text.length > CONSOLIDATION_TRANSCRIPT_CHARS) text = `…\n${text.slice(-CONSOLIDATION_TRANSCRIPT_CHARS)}`;
    return text;
  }

  private parseCandidates(reply: string): Candidate[] {
    const raw = parseJsonArray(reply);
    if (!raw) {
      this.o.logger.warn('[memory] consolidation reply contained no JSON array');
      return [];
    }
    const out: Candidate[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const { text, tags, importance } = item as { text?: unknown; tags?: unknown; importance?: unknown };
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      out.push({ text: normalizeText(text), tags: normalizeTags(tags), importance: normalizeImportance(importance) });
    }
    return out;
  }
}
