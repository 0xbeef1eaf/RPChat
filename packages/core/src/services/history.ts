import { estimateTokens } from '@rp/llm';
import type {
  ChatMessage,
  HistorySettings,
  HistorySummary,
  HistorySummarySegment,
  Json,
  LlmChatRequest,
  LlmProvider,
  ProviderConfig,
  Storage,
} from '@rp/shared';
import { parseCharacterRef } from '@rp/shared';
import { providerLabel, recordExchange } from './exchanges.js';
import type { PackService } from './packs.js';
import type { ProviderFactory, SettingsService } from './settings.js';
import { actionDetailIds } from '../prompt.js';
import type { Clock, EngineEmitter, Logger } from '../types.js';

/** State scope and key the rolling summary of a session lives under. */
export const HISTORY_STATE_SCOPE = (sessionId: string): string => `session:${sessionId}`;
export const HISTORY_SUMMARY_KEY = 'history.summary';
/** Below this many summarisable messages a compression is not worth a model call. */
export const COMPRESSION_MIN_MESSAGES = 6;
/** Cap on the transcript handed to the summariser, in characters. */
const COMPRESSION_TRANSCRIPT_CHARS = 24_000;
/**
 * Share of the room the transcript actually has that a session may fill before it is summarised,
 * when `compressAboveTokens` is left on auto. Below 1 so compression has time to run in the
 * background — it starts after a turn and the next turn does not wait for it.
 */
export const COMPRESS_BUDGET_FRACTION = 0.6;
/** Floor for the derived threshold: below this, summarising costs more than it saves. */
export const COMPRESS_MIN_THRESHOLD = 2_000;

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
 * The transcript size at which a session is summarised: `compressAboveTokens` when the user set
 * one, otherwise a share of the room the transcript has left once the system prompt is paid for.
 * Deriving it matters because the absolute number is meaningless on its own — 6000 tokens is most
 * of a 16k context and an eighth of a 64k one.
 */
export function compressionThreshold(history: Pick<HistorySettings, 'compressAboveTokens'>, transcriptBudgetTokens: number): number {
  if (history.compressAboveTokens > 0) return Math.floor(history.compressAboveTokens);
  return Math.max(COMPRESS_MIN_THRESHOLD, Math.round(Math.max(0, transcriptBudgetTokens) * COMPRESS_BUDGET_FRACTION));
}

/**
 * Keeps a long session inside the context window by summarising its oldest messages in the
 * background. The summary replaces those messages in the prompt; storage and the chat view keep
 * every message, so nothing the user can see is lost.
 *
 * A compression recaps only the messages it newly covers and appends that as a segment; earlier
 * segments are kept word for word. Re-summarising a summary loses a little every time, so it
 * happens only when the whole thing outgrows `summaryBudgetTokens`, not on every pass.
 */
export class HistoryService {
  private readonly compressing = new Map<string, Promise<HistorySummary | undefined>>();

  constructor(private readonly o: HistoryServiceOptions) {}

  /** The stored summary of a session, if one has been written. */
  async summaryFor(sessionId: string): Promise<HistorySummary | undefined> {
    const raw = await this.o.storage.state.get(HISTORY_STATE_SCOPE(sessionId), HISTORY_SUMMARY_KEY);
    return isSummary(raw) ? withSegments(raw) : undefined;
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
   * every turn: it only estimates tokens over the messages already in hand, counting them the way
   * the prompt will actually send them — action code and results that `keepActionDetailFor` leaves
   * out cost nothing here either.
   */
  shouldCompress(transcript: ChatMessage[], settings: HistorySettings, transcriptBudgetTokens: number): boolean {
    if (!settings.compress) return false;
    const keep = Math.max(0, Math.floor(settings.keepRecentMessages));
    if (transcript.length - keep < COMPRESSION_MIN_MESSAGES) return false;
    return transcriptTokens(transcript, settings.keepActionDetailFor) > compressionThreshold(settings, transcriptBudgetTokens);
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

    // Only the messages after the previous summary are sent; the segments already written carry
    // the rest and are not rewritten.
    const previous = await this.summaryFor(sessionId);
    const previousIdx = previous ? all.findIndex((m) => m.id === previous.throughMessageId) : -1;
    const carried = previous && previousIdx >= 0 ? previous : undefined;
    const covered = carried ? previousIdx + 1 : 0;
    const fresh = all.slice(covered, cutoff).filter((m) => m.content.trim().length > 0 || (m.actions?.length ?? 0) > 0);
    if (fresh.length < COMPRESSION_MIN_MESSAGES) return undefined;
    const through = all[cutoff - 1];
    if (!through) return undefined;

    const config = await this.o.settings.resolveProvider(session.providerId);
    const provider: LlmProvider = this.o.providerFactory(config);
    const model = session.model ?? config.model;
    const budgetChars = Math.max(400, settings.history.summaryBudgetTokens * 4);
    // Half the budget per segment, so a fold always has room left for the newest one.
    const segmentChars = Math.max(300, Math.floor(budgetChars / 2));
    const call = (system: string, user: string, maxChars: number): Promise<string | undefined> =>
      this.summarise({ sessionId, provider, config, model, system, user, maxChars, budgetTokens: settings.history.summaryBudgetTokens, debug: settings.debug.showModelTraffic });

    const system = [
      `You keep a running summary of a long conversation between ${settings.userDisplayName || 'the user'} and ${characterName}, so its earliest parts can be dropped from ${characterName}'s context without being forgotten.`,
      'Recap the messages below: what happened, what each of them said and decided, promises and plans, ongoing threads, running jokes, how things stand between them, and anything either would be expected to remember later. Record what the character did on the computer, not only what was said — the bracketed lines are their actions.',
      `Write plain third-person prose, at most ${segmentChars} characters. Keep concrete details (names, numbers, preferences, commitments) over generalities. No headings, no bullet points, no preamble, no commentary about summarising.`,
      carried
        ? `What happened before these messages, for context only. It is already recorded, so continue from it and do not repeat it:\n${carried.text}`
        : 'These are the earliest messages of the conversation.',
    ].join('\n');

    const text = await call(system, this.renderTranscript(fresh, characterName, settings.userDisplayName), segmentChars);
    if (text === undefined) return undefined;

    const appended: HistorySummarySegment[] = [...(carried?.segments ?? []), { text, messageCount: cutoff - covered }];
    const segments = await this.foldToBudget(appended, budgetChars, characterName, call);

    const summary: HistorySummary = {
      text: joinSegments(segments),
      segments,
      throughMessageId: through.id,
      messageCount: cutoff,
      updatedAt: this.o.now().toISOString(),
    };
    await this.o.storage.state.set(HISTORY_STATE_SCOPE(sessionId), HISTORY_SUMMARY_KEY, summary as unknown as Json);
    this.o.logger.info(
      `[history] summarised ${summary.messageCount} message(s) of session ${sessionId} into ${segments.length} segment(s), ~${estimateTokens(summary.text)} tokens`,
    );
    return summary;
  }

  /**
   * Bring the summary back under its budget by condensing every segment but the newest into one.
   * The newest is the one whose detail is still in play, so it stays as written. One model call at
   * most: if it fails the segments are left as they are and the next compression tries again.
   */
  private async foldToBudget(
    segments: HistorySummarySegment[],
    budgetChars: number,
    characterName: string,
    call: (system: string, user: string, maxChars: number) => Promise<string | undefined>,
  ): Promise<HistorySummarySegment[]> {
    if (segments.length < 2 || joinSegments(segments).length <= budgetChars) return segments;
    const newest = segments[segments.length - 1]!;
    const older = segments.slice(0, -1);
    const room = Math.max(300, budgetChars - newest.text.length - SEGMENT_SEPARATOR.length);
    const system = [
      `You are condensing the older half of a running summary of a long conversation involving ${characterName}, because it has outgrown its space.`,
      `Rewrite it as one passage of at most ${room} characters, keeping every concrete detail you can fit — names, numbers, preferences, commitments, promises and unresolved threads — and dropping colour and repetition first.`,
      'Plain third-person prose. No headings, no bullet points, no preamble, no commentary about summarising.',
    ].join('\n');
    const folded = await call(system, joinSegments(older), room);
    if (folded === undefined) return segments;
    return [{ text: folded, messageCount: older.reduce((n, s) => n + s.messageCount, 0) }, newest];
  }

  /** One summariser call: returns the reply trimmed to `maxChars`, or undefined when it is empty. */
  private async summarise(input: {
    sessionId: string;
    provider: LlmProvider;
    config: Pick<ProviderConfig, 'id' | 'label'>;
    model: string;
    system: string;
    user: string;
    maxChars: number;
    budgetTokens: number;
    debug: boolean;
  }): Promise<string | undefined> {
    const request: LlmChatRequest = {
      model: input.model,
      system: input.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
      maxTokens: Math.max(256, Math.floor(input.budgetTokens * 1.5)),
      temperature: 0,
    };
    const response = input.debug
      ? await recordExchange(
          this.o.emitter,
          this.o.now,
          { sessionId: input.sessionId, kind: 'history', provider: providerLabel(input.config) },
          request,
          () => input.provider.chat(request),
        )
      : await input.provider.chat(request);
    const text = response.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
    if (text.length === 0) return undefined;
    return text.length > input.maxChars ? `${text.slice(0, input.maxChars).trimEnd()}…` : text;
  }

  /**
   * The messages as the summariser sees them: who said what, plus a bracketed line per action so
   * what the character *did* survives into the summary. The code itself is left out — the purpose
   * and whether it worked is what is worth remembering.
   */
  private renderTranscript(messages: ChatMessage[], characterName: string, userName: string): string {
    const lines: string[] = [];
    for (const m of messages) {
      const who = m.role === 'user' ? userName || 'User' : m.role === 'system' ? 'System' : characterName;
      if (m.content.trim().length > 0) lines.push(`${who}: ${m.kind === 'emote' ? `*${m.content}*` : m.content}`);
      for (const a of m.actions ?? []) {
        const purpose = a.purpose.trim();
        const what = purpose.length > 0 ? purpose : 'ran some code';
        lines.push(a.result?.error ? `  [${characterName} tried to ${what} — it failed]` : `  [${characterName}: ${what}]`);
      }
    }
    const text = lines.join('\n');
    return text.length > COMPRESSION_TRANSCRIPT_CHARS ? `…\n${text.slice(-COMPRESSION_TRANSCRIPT_CHARS)}` : text;
  }
}

const SEGMENT_SEPARATOR = '\n\n';

function joinSegments(segments: HistorySummarySegment[]): string {
  return segments.map((s) => s.text).join(SEGMENT_SEPARATOR);
}

/**
 * Rough token cost of a transcript. With `keepActionDetailFor`, action code and results are
 * counted only for the messages that will still carry them into the prompt (`actionDetailIds`);
 * left out, a session full of tool calls reads as several times the context it really occupies.
 */
export function transcriptTokens(messages: ChatMessage[], keepActionDetailFor?: number): number {
  const detailed = actionDetailIds(messages, keepActionDetailFor);
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
    if (detailed && !detailed.has(m.id)) continue;
    for (const a of m.actions ?? []) {
      total += estimateTokens(a.code) + estimateTokens(a.purpose);
      const r = a.result;
      if (r) total += estimateTokens(JSON.stringify(r.returnValue ?? null)) + (r.logs?.length ?? 0) * 8 + (r.error ? estimateTokens(JSON.stringify(r.error)) : 0);
    }
  }
  return total;
}

/** A summary written before segments existed is one segment covering everything it recaps. */
function withSegments(summary: HistorySummary): HistorySummary {
  if (Array.isArray(summary.segments) && summary.segments.length > 0) return summary;
  return { ...summary, segments: [{ text: summary.text, messageCount: summary.messageCount ?? 0 }] };
}

function isSummary(value: unknown): value is HistorySummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && typeof v.throughMessageId === 'string' && v.text.trim().length > 0;
}
