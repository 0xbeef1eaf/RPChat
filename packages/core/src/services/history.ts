import { estimateTokens } from '@rp/llm';
import type { ChatMessage, HistorySummary, Json, LlmChatRequest, LlmProvider, Storage } from '@rp/shared';
import { parseCharacterRef } from '@rp/shared';
import { providerLabel, recordExchange } from './exchanges.js';
import type { PackService } from './packs.js';
import type { ProviderFactory, SettingsService } from './settings.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';

/** State scope and key the rolling summary of a session lives under. */
export const HISTORY_STATE_SCOPE = (sessionId: string): string => `session:${sessionId}`;
export const HISTORY_SUMMARY_KEY = 'history.summary';
/** Below this many summarisable messages a compression is not worth a model call. */
export const COMPRESSION_MIN_MESSAGES = 6;
/** Cap on the transcript handed to the summariser, in characters. */
const COMPRESSION_TRANSCRIPT_CHARS = 24_000;

export interface HistoryServiceOptions {
  storage: Pick<Storage, 'messages' | 'sessions' | 'state'>;
  settings: SettingsService;
  packs: Pick<PackService, 'getCharacter' | 'tryGetLoaded'>;
  providerFactory: ProviderFactory;
  emitter: EngineEmitter;
  now: Clock;
  logger: Logger;
}

export interface CompressOptions {
  /** `true` when triggered automatically: honours `settings.history.compress`. */
  auto?: boolean;
}

/**
 * Keeps a long session inside the context window by summarising its oldest messages in the
 * background. The summary replaces those messages in the prompt; storage and the chat view keep
 * every message, so nothing the user can see is lost.
 */
export class HistoryService {
  private readonly compressing = new Map<string, Promise<HistorySummary | undefined>>();

  constructor(private readonly o: HistoryServiceOptions) {}

  /** The stored summary of a session, if one has been written. */
  async summaryFor(sessionId: string): Promise<HistorySummary | undefined> {
    const raw = await this.o.storage.state.get(HISTORY_STATE_SCOPE(sessionId), HISTORY_SUMMARY_KEY);
    return isSummary(raw) ? raw : undefined;
  }

  /** Forget a session's summary (its messages are gone or no longer match it). */
  async clear(sessionId: string): Promise<void> {
    await this.o.storage.state.delete(HISTORY_STATE_SCOPE(sessionId), HISTORY_SUMMARY_KEY);
  }

  /** Whether a compression is running for the session. */
  isCompressing(sessionId: string): boolean {
    return this.compressing.has(sessionId);
  }

  /** Wait for in-flight compressions (all, or one session's). */
  async idle(sessionId?: string): Promise<void> {
    const pending = sessionId === undefined ? [...this.compressing.values()] : [this.compressing.get(sessionId)];
    await Promise.all(pending.map((p) => p?.catch(() => undefined)));
  }

  /**
   * Whether the transcript is long enough to be worth compressing. Cheap enough to call after
   * every turn: it only estimates tokens over the messages already in hand.
   */
  shouldCompress(transcript: ChatMessage[], settings: { compress: boolean; compressAboveTokens: number; keepRecentMessages: number }): boolean {
    if (!settings.compress) return false;
    const keep = Math.max(0, Math.floor(settings.keepRecentMessages));
    if (transcript.length - keep < COMPRESSION_MIN_MESSAGES) return false;
    return transcriptTokens(transcript) > Math.max(0, settings.compressAboveTokens);
  }

  /**
   * Extend the session's summary to cover everything except the most recent
   * `keepRecentMessages` messages. Serialised per session; a call while one runs returns the
   * running promise. Never throws.
   */
  compress(sessionId: string, options: CompressOptions = {}): Promise<HistorySummary | undefined> {
    const running = this.compressing.get(sessionId);
    if (running) return running;
    const task = this.runCompression(sessionId, options)
      .catch((err) => {
        this.o.logger.warn(`[history] compression failed for session ${sessionId}`, err);
        return undefined;
      })
      .finally(() => {
        if (this.compressing.get(sessionId) === task) this.compressing.delete(sessionId);
      });
    this.compressing.set(sessionId, task);
    return task;
  }

  private async runCompression(sessionId: string, options: CompressOptions): Promise<HistorySummary | undefined> {
    const settings = await this.o.settings.get();
    if (options.auto && !settings.history.compress) return undefined;
    const session = await this.o.storage.sessions.get(sessionId);
    if (!session) return undefined;
    const { packId } = parseCharacterRef(session.characterRef);
    if (!this.o.packs.tryGetLoaded(packId)) return undefined;
    const { character } = this.o.packs.getCharacter(session.characterRef);
    const characterName = character.definition.name;

    const all = await this.o.storage.messages.list(sessionId);
    const keep = Math.max(0, Math.floor(settings.history.keepRecentMessages));
    const cutoff = all.length - keep;
    if (cutoff <= 0) return undefined;

    // Only the messages after the previous summary are sent; the summary itself carries the rest.
    const previous = await this.summaryFor(sessionId);
    const previousIdx = previous ? all.findIndex((m) => m.id === previous.throughMessageId) : -1;
    const covered = previous && previousIdx >= 0 ? previousIdx + 1 : 0;
    const fresh = all.slice(covered, cutoff).filter((m) => m.content.trim().length > 0);
    if (fresh.length < COMPRESSION_MIN_MESSAGES) return undefined;
    const through = all[cutoff - 1];
    if (!through) return undefined;

    const config = await this.o.settings.resolveProvider(session.providerId);
    const provider: LlmProvider = this.o.providerFactory(config);
    const model = session.model ?? config.model;
    const maxChars = Math.max(400, settings.history.summaryBudgetTokens * 4);
    const carried = previous && previousIdx >= 0 ? previous.text : undefined;

    const system = [
      `You keep a running summary of a long conversation between ${settings.userDisplayName || 'the user'} and ${characterName}, so its earliest parts can be dropped from ${characterName}'s context without being forgotten.`,
      'Rewrite the summary so it covers the earlier summary AND the new messages: what happened, what each of them said and decided, promises and plans, ongoing threads, running jokes, how things stand between them, and anything either would be expected to remember later.',
      `Write plain third-person prose, at most ${maxChars} characters. Keep concrete details (names, numbers, preferences, commitments) over generalities. No headings, no bullet points, no preamble, no commentary about summarising.`,
      carried ? `The summary so far:\n${carried}` : 'There is no earlier summary; this is the first one.',
    ].join('\n');

    const request: LlmChatRequest = {
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: this.renderTranscript(fresh, characterName, settings.userDisplayName) }] }],
      maxTokens: Math.max(256, Math.floor(settings.history.summaryBudgetTokens * 1.5)),
      temperature: 0,
    };
    const response = settings.debug.showModelTraffic
      ? await recordExchange(this.o.emitter, this.o.now, { sessionId, kind: 'history', provider: providerLabel(config) }, request, () => provider.chat(request))
      : await provider.chat(request);
    const text = response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
    if (text.length === 0) return undefined;

    const summary: HistorySummary = {
      text: text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text,
      throughMessageId: through.id,
      messageCount: covered + fresh.length,
      updatedAt: this.o.now().toISOString(),
    };
    await this.o.storage.state.set(HISTORY_STATE_SCOPE(sessionId), HISTORY_SUMMARY_KEY, summary as unknown as Json);
    this.o.logger.info(`[history] summarised ${summary.messageCount} message(s) of session ${sessionId} into ~${estimateTokens(summary.text)} tokens`);
    return summary;
  }

  private renderTranscript(messages: ChatMessage[], characterName: string, userName: string): string {
    const lines = messages.map((m) => {
      const who = m.role === 'user' ? userName || 'User' : m.role === 'system' ? 'System' : characterName;
      return `${who}: ${m.kind === 'emote' ? `*${m.content}*` : m.content}`;
    });
    const text = lines.join('\n');
    return text.length > COMPRESSION_TRANSCRIPT_CHARS ? `…\n${text.slice(-COMPRESSION_TRANSCRIPT_CHARS)}` : text;
  }
}

/** Rough token cost of a transcript, action code and results included. */
export function transcriptTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
    for (const a of m.actions ?? []) {
      total += estimateTokens(a.code) + estimateTokens(a.purpose);
      const r = a.result;
      if (r) total += estimateTokens(JSON.stringify(r.returnValue ?? null)) + (r.logs?.length ?? 0) * 8 + (r.error ? estimateTokens(JSON.stringify(r.error)) : 0);
    }
  }
  return total;
}

function isSummary(value: unknown): value is HistorySummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && typeof v.throughMessageId === 'string' && v.text.trim().length > 0;
}
