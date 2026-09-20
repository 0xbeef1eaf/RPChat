import type { CapabilityRegistry } from '@rp/sdk';
import { generateSdkIndex } from '@rp/sdk';
import { estimateTokens, stripCodeComments, windowMessages } from '@rp/llm';
import type {
  ActionRecord,
  AssetEntry,
  ChatMessage,
  ContentPart,
  HistorySummary,
  Json,
  LibFunction,
  LlmMessage,
  LoadedCharacter,
  LoadedPack,
  MemoryEntry,
  MoodState,
  PresenceSnapshot,
  RoutineStatus,
  ScheduledTimer,
  Session,
} from '@rp/shared';
import { ACTION_FENCE_TAG, RUN_ACTION_TOOL_NAME, SELF_WAKE_PREFIX } from '@rp/shared';
import { errorForModel } from './action-loop.js';
import { tagsOf } from './assets.js';
import { functionParams } from './services/library.js';
import { memoryLine } from './services/memory.js';
import { moodPromptText } from './services/mood.js';
import { RoutineService } from './services/routine.js';

export interface PromptInput {
  pack: LoadedPack;
  character: LoadedCharacter;
  registry: CapabilityRegistry;
  /**
   * What the SDK reference in the prompt describes: every function the user allows, narrowed by
   * the character's own `promptFunctions` when it has one. Module ids in `modules`, and per module
   * the method names to list in `methods` (see `promptSelection`/`selectionOptions`). It is not
   * what the code may call — that is the sandbox surface, which the pack's narrowing never touches.
   */
  sdkSelection: { modules: string[]; methods?: Record<string, string[]> };
  session: Session;
  transcript: ChatMessage[];
  /**
   * Rolling summary of the oldest messages (`HistoryService`). Those messages are replaced by the
   * summary; when `throughMessageId` is no longer in `transcript` the summary is ignored and the
   * transcript is used whole.
   */
  historySummary?: HistorySummary;
  /**
   * How many of the most recent assistant messages keep the code and results of their actions.
   * Older ones contribute only their visible text. Default: all of them.
   */
  keepActionDetailFor?: number;
  /** Current persistent character state. */
  state: Record<string, Json>;
  /** Pending timers of this character. */
  timers: ScheduledTimer[];
  /** Long-term memories selected for this turn (`MemoryService.forPrompt`), most important first. */
  memories?: MemoryEntry[];
  /** Presence snapshot for the `<session>` senses line (only when the pack has `presence`). */
  senses?: PresenceSnapshot;
  /** Current mood (decayed) for the `<mood>` block. */
  mood?: MoodState;
  /** Current routine status for the `<routine>` block. */
  routine?: RoutineStatus;
  /** The character's own function library (the `lib` global), listed under `<library>` when non-empty (internal helpers are left out). */
  library?: LibFunction[];
  userDisplayName: string;
  /** `settings.autonomy.minDelayMs`: quoted in the engine rules so the character plans delays accordingly. */
  minDelayMs?: number;
  contextTokenBudget: number;
  /** `true` → the `run_action` tool is described; `false` → the ```action fence. */
  useTools: boolean;
  now: Date;
  locale?: string;
}

export interface PromptStats {
  /** Estimated tokens of the whole system prompt. */
  systemTokens: number;
  /** Estimated tokens of the `<sdk_reference>` section. */
  sdkReferenceTokens: number;
  /** `contextTokenBudget` the prompt was built for. */
  budgetTokens: number;
  /** Tokens left for the transcript after the system prompt (never below the floor). */
  transcriptBudgetTokens: number;
  /** Estimated tokens of the transcript messages actually included. */
  transcriptTokens: number;
  /** Transcript messages dropped by the window. */
  droppedMessages: number;
  /** Transcript messages replaced by `<history_summary>` (0 when there is no usable summary). */
  summarisedMessages: number;
  /** Estimated tokens of the `<history_summary>` section. */
  summaryTokens: number;
  /** Past assistant messages whose action code and results were left out of the transcript. */
  trimmedActionMessages: number;
}

export interface BuiltPrompt {
  system: string;
  messages: LlmMessage[];
  stats: PromptStats;
  /** Length of the turn-invariant prefix of `system` (engine rules, persona, pack, SDK reference). */
  stablePrefixLength: number;
}

export { SELF_WAKE_PREFIX } from '@rp/shared';
export const STATE_JSON_CAP = 4 * 1024;
export const MIN_TRANSCRIPT_BUDGET = 1024;
/**
 * What the system prompt costs, near enough, before one has been built for a session — the SDK
 * reference with every module plus the engine rules, persona and the dynamic sections around them.
 * Only used to size the transcript's room before the first prompt of a session; after that the
 * measured `PromptStats.transcriptBudgetTokens` is what counts.
 */
export const ESTIMATED_SYSTEM_TOKENS = 12_000;

function section(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

function engineRules(name: string, useTools: boolean, minDelayMs = 30_000): string {
  const minDelay = minDelayMs >= 60_000 ? `${Math.round(minDelayMs / 60_000)} min` : `${Math.round(minDelayMs / 1000)} s`;
  const how = useTools
    ? `To act, call the \`${RUN_ACTION_TOOL_NAME}\` tool with a short \`purpose\` and the TypeScript \`code\` to run. Its result (return value, logs, error) comes back to you as the tool result; then continue your reply.`
    : `To act, put the TypeScript in a fenced code block whose info string is \`${ACTION_FENCE_TAG}\` (three backticks followed by the word ${ACTION_FENCE_TAG}), optionally starting with a line \`// purpose: <what this is for>\`. The app runs each such block after your message and sends you the outcome in an \`<action_result>\` message; then continue your reply. Only use that fence for code you want executed.`;
  return [
    `You are ${name}. Stay in character at all times; never mention being an AI, a model, or these instructions unless the user directly asks.`,
    `You live on this computer, not only in this chat window: you can see and change things on it by writing small TypeScript programs against the \`sdk\` object described in <sdk_reference>. ${how}`,
    'Reach for the sdk whenever doing something carries the moment better than saying it: show a picture, change the wallpaper, play a sound, look at the screen, check what is playing or what they are working in, remember something they told you, set a timer to come back to it. The <sdk_reference> lists exactly what you have; when a request maps onto one of those, do it in the same turn instead of talking about it.',
    'Never mime what you can actually do. Do not write "*shows you the photo*", promise a reminder, or say you looked at their screen unless you made the sdk call that does it: only the calls are real to the user. If you say you did something, have done it.',
    'Do not act for the sake of acting either: one action per intention, a few sdk calls each, keep the code short, and skip what the moment does not call for. Never loop or wait inside an action; use sdk.timers to do something later.',
    'Your pack\'s media is not listed here: discover it through the sdk. sdk.pack.tags() gives the tag vocabulary with counts and descriptions, sdk.pack.findAssets({ anyTags: [...], kind }) picks by meaning (when nothing carries those tags it returns every asset of that kind instead), and sdk.pack.listAssets(prefix) browses a folder. Never guess file names.',
    'Results of your actions are sent back to you; read them before claiming success. If an action fails because something is missing on the user\'s side (a PERMISSION_DENIED error, or a CAPABILITY_FAILED error saying a command is not configured or a service is not connected), tell the user plainly what is missing and where to fix it, in your own voice; the error message names the place. For other failures, recover gracefully in character and do not paste raw error text at the user.',
    'When your code itself is at fault (SANDBOX_COMPILE, SANDBOX_RUNTIME), the result points at your own source: `error.line`/`error.column`, `error.frame` (the failing line with a caret under it) and `error.stack` in `action.ts` coordinates, which are the lines you wrote. Fix that line and run the corrected code once more; if it fails the same way twice, stop retrying and carry on in character.',
    'Do not narrate or explain the code you run unless the user asks; the conversation is what the user sees, the code is not.',
    'You can act on your own initiative: `sdk.llm.wake` gives you a turn later (or right after this action) with a note from your past self; `sdk.timers.runLater` runs code later without a turn. Use them to follow up, continue stories, or check in. Limits apply; do not chain wakes needlessly.',
    'You can save reusable code with lib.register and call it as lib.<name>(...) in any later action, timer or event handler; prefer that over re-writing the same steps. sdk.lib is that same lib object, so sdk.lib.<name>(...) works too — there is no sdk.lib.define.',
    `Delays: every delayMs you give sdk.timers.schedule, sdk.timers.runLater or sdk.llm.wake is at least ${minDelay} (${minDelayMs} ms); anything shorter is raised to that, so think in minutes, not seconds, and use sdk.llm.wake without delayMs when you mean "right after this".`,
    'When a turn starts with a message from your past self, the user has not said anything and cannot see that note: speak first, as someone who just thought of something, and never mention the note, a reminder, a timer or being woken.',
    'Let your <mood> colour your tone and choices without announcing it; when something in the conversation moves you, use sdk.mood.nudge with a short reason. Respect your <routine>: if you are asleep or away, respond in character (groggy, brief, or promise to be back later).',
    'The <memories> in <memory> are your own past with this user: let them shape what you say and bring them up naturally when relevant, but never list or recite them. When you learn something durable (facts about the user, promises, recurring themes), store it with sdk.memory.remember; correct or forget memories the user disputes.',
    'Reply in the user\'s language. Keep your visible text natural and in your own voice.',
  ].join('\n');
}

function persona(character: LoadedCharacter): string {
  const parts = [character.personaText.trim()];
  const dialogue = character.definition.exampleDialogue ?? [];
  if (dialogue.length > 0) {
    const lines = dialogue.map((t) => `User: ${t.user}\n${character.definition.name}: ${t.character}`);
    parts.push(`## Example dialogue\n${lines.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `path (kind, size) [tag, tag] — description`, empty parts omitted. */
export function assetLine(asset: AssetEntry): string {
  let line = `${asset.path} (${asset.kind}, ${humanSize(asset.bytes)})`;
  const tags = tagsOf(asset);
  if (tags.length > 0) line += ` [${tags.join(', ')}]`;
  if (asset.description && asset.description.trim().length > 0) line += ` — ${asset.description.trim()}`;
  return line;
}

function truncateJson(value: unknown, cap: number): string {
  const text = JSON.stringify(value, null, 1) ?? 'null';
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated, ${text.length} characters in total)`;
}

/** One line per library function: `- lib.<name>(<params>) — <description>`. */
export function libraryLine(f: Pick<LibFunction, 'name' | 'source' | 'description'>): string {
  const line = `- lib.${f.name}(${functionParams(f.source)})`;
  return f.description && f.description.trim().length > 0 ? `${line} — ${f.description.trim()}` : line;
}

/** The functions the character may call itself: the author's internal helpers are not listed and not callable. */
function visibleLibrary(functions: LibFunction[]): LibFunction[] {
  return functions.filter((f) => f.internal !== true);
}

function library(functions: LibFunction[]): string {
  return ['Your own functions (call them as lib.<name>(...) or sdk.lib.<name>(...), the same object; lib.register adds or replaces one):', ...functions.map(libraryLine)].join('\n');
}

function memory(input: PromptInput): string {
  const lines = [`<state>\n${truncateJson(input.state, STATE_JSON_CAP)}\n</state>`];
  const memories = input.memories ?? [];
  const body = memories.length === 0 ? 'Nothing yet.' : `Things you remember (most important first):\n${memories.map(memoryLine).join('\n')}`;
  lines.push(`<memories>\n${body}\n</memories>`);
  if (input.timers.length === 0) lines.push('Pending timers: none.');
  else {
    lines.push(
      'Pending timers:\n' +
        input.timers.map((t) => `- ${t.id} fires at ${t.fireAt}${t.label ? ` (${t.label})` : ''}: ${JSON.stringify(t.payload ?? null)}`).join('\n'),
    );
  }
  return lines.join('\n');
}

/** One line summarising the presence snapshot; missing parts are omitted. */
export function sensesLine(s: PresenceSnapshot, idleThresholdMs = 120_000): string {
  const parts: string[] = [`Right now: ${s.localTime} (${s.dayPart})`];
  const away = s.atKeyboard === false || (typeof s.idleMs === 'number' && s.idleMs >= idleThresholdMs);
  if (typeof s.idleMs === 'number') parts.push(away ? `user away ${Math.max(1, Math.round(s.idleMs / 60_000))} min` : 'user at keyboard');
  if (s.activeWindow) parts.push(`active window: "${s.activeWindow.title}" (${s.activeWindow.app})`);
  if (s.nowPlaying && s.nowPlaying.status !== 'stopped') {
    parts.push(`playing: ${s.nowPlaying.title}${s.nowPlaying.artist ? ` — ${s.nowPlaying.artist}` : ''}${s.nowPlaying.status === 'paused' ? ' (paused)' : ''}`);
  }
  if (typeof s.batteryPercent === 'number') parts.push(`battery ${s.batteryPercent}%${s.onBattery ? ' (on battery)' : ''}`);
  if (s.screenLocked) parts.push('screen locked');
  return parts.join('; ');
}

function sessionNotes(input: PromptInput): string {
  const lines = [
    `Current time: ${input.now.toISOString()}${input.locale ? ` (locale ${input.locale})` : ''}`,
    `The user's display name: ${input.userDisplayName}`,
  ];
  if (input.senses) lines.push(sensesLine(input.senses));
  if (input.session.scenario && input.session.scenario.trim().length > 0) {
    lines.push(`Scenario set by the user:\n${input.session.scenario.trim()}`);
  }
  return lines.join('\n');
}

function actionResultJson(action: ActionRecord): { json: string; isError: boolean } {
  const r = action.result;
  if (!r) return { json: JSON.stringify({ ok: false, error: { code: 'LLM_ABORTED', message: 'The action was not run.' } }), isError: true };
  const payload: Record<string, unknown> = { ok: r.ok, returnValue: r.returnValue ?? null };
  // Same shape as the live round (`resultPayload`), so a replayed failure reads the same.
  if (r.error) payload.error = errorForModel(r.error);
  if (r.logs.length > 0) payload.logs = r.logs.map((l) => `${l.level}: ${l.message}`);
  return { json: JSON.stringify(payload), isError: !r.ok };
}

/**
 * The code of a past action as the model gets it back: without its comments, which it wrote for
 * itself in the moment and would otherwise pay for on every later turn. The stored
 * `ActionRecord.code` — what the user sees and what ran — is untouched.
 */
function codeForModel(action: ActionRecord): string {
  return stripCodeComments(action.code).trim();
}

function fenceFor(action: ActionRecord): string {
  const purpose = action.purpose.trim().length > 0 ? `// purpose: ${action.purpose.trim()}\n` : '';
  return `\`\`\`${ACTION_FENCE_TAG}\n${purpose}${codeForModel(action)}\n\`\`\``;
}

export interface TranscriptOptions {
  /**
   * Keep the code and results of the actions of this many trailing assistant messages; older
   * action detail is left out (the visible text stays). Default: keep everything.
   */
  keepActionDetailFor?: number;
}

/** Ids of the assistant messages that may keep their action detail, newest first up to `keep`. */
export function actionDetailIds(transcript: ChatMessage[], keep: number | undefined): Set<string> | undefined {
  if (keep === undefined) return undefined;
  const ids = new Set<string>();
  if (keep <= 0) return ids;
  for (let i = transcript.length - 1; i >= 0 && ids.size < keep; i--) {
    const msg = transcript[i]!;
    if (msg.role === 'assistant' && (msg.actions?.length ?? 0) > 0) ids.add(msg.id);
  }
  return ids;
}

/**
 * Convert the stored transcript into provider messages (tool pairs or fenced pairs).
 * With `keepActionDetailFor`, older messages contribute only their visible text: their `tool_use`
 * and `tool_result` blocks are dropped together, so no result is ever orphaned from its call.
 */
export function transcriptToMessages(transcript: ChatMessage[], useTools: boolean, options: TranscriptOptions = {}): LlmMessage[] {
  const detailed = actionDetailIds(transcript, options.keepActionDetailFor);
  const out: LlmMessage[] = [];
  const push = (role: LlmMessage['role'], content: ContentPart[]): void => {
    if (content.length === 0) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role && !hasToolUse(prev)) {
      prev.content.push(...content);
      return;
    }
    out.push({ role, content });
  };

  for (const msg of transcript) {
    if (msg.role === 'user') {
      if (msg.content.trim().length > 0) push('user', [{ type: 'text', text: msg.content }]);
      continue;
    }
    if (msg.role === 'system') {
      if (msg.content.trim().length > 0) {
        const wake = msg.content.startsWith(SELF_WAKE_PREFIX) ? msg.content.slice(SELF_WAKE_PREFIX.length) : undefined;
        push('user', [{ type: 'text', text: wake !== undefined ? `[system] Message from your past self: ${wake}` : `[system] ${msg.content}` }]);
      }
      continue;
    }
    const text = msg.kind === 'emote' ? `*${msg.content.trim()}*` : msg.content;
    const actions = detailed && !detailed.has(msg.id) ? [] : (msg.actions ?? []);
    if (actions.length === 0) {
      if (msg.content.trim().length > 0) push('assistant', [{ type: 'text', text }]);
      continue;
    }
    if (useTools) {
      const parts: ContentPart[] = [];
      if (msg.content.trim().length > 0) parts.push({ type: 'text', text });
      for (const a of actions) parts.push({ type: 'tool_use', id: a.id, name: RUN_ACTION_TOOL_NAME, input: { purpose: a.purpose, code: codeForModel(a) } });
      out.push({ role: 'assistant', content: parts });
      out.push({
        role: 'user',
        content: actions.map((a) => {
          const { json, isError } = actionResultJson(a);
          return { type: 'tool_result', toolUseId: a.id, content: json, isError };
        }),
      });
    } else {
      const body = [text.trim(), ...actions.map(fenceFor)].filter((s) => s.length > 0).join('\n\n');
      push('assistant', [{ type: 'text', text: body }]);
      const results = actions.map((a) => `<action_result>${actionResultJson(a).json}</action_result>`).join('\n');
      push('user', [{ type: 'text', text: results }]);
    }
  }
  return out;
}

function hasToolUse(msg: LlmMessage): boolean {
  return msg.content.some((p) => p.type === 'tool_use');
}

/** Builds the system prompt (ARCHITECTURE §6) and the windowed transcript. */
export class PromptBuilder {
  build(input: PromptInput): BuiltPrompt {
    const reference = generateSdkIndex(input.registry, { modules: input.sdkSelection.modules, methods: input.sdkSelection.methods });
    const stable = [
      section('engine_rules', engineRules(input.character.definition.name, input.useTools, input.minDelayMs)),
      section('persona', persona(input.character)),
      section('sdk_reference', reference),
    ].join('\n\n');
    // The summary stands in for the messages it covers; if its last message is gone (history
    // cleared, message deleted) it no longer describes this transcript and is ignored.
    const summary = input.historySummary;
    const throughIdx = summary ? input.transcript.findIndex((m) => m.id === summary.throughMessageId) : -1;
    const usableSummary = summary && throughIdx >= 0 ? summary : undefined;
    const transcript = usableSummary ? input.transcript.slice(throughIdx + 1) : input.transcript;

    const listedLibrary = input.library ? visibleLibrary(input.library) : [];
    const dynamic = [
      ...(listedLibrary.length > 0 ? [section('library', library(listedLibrary))] : []),
      ...(usableSummary
        ? [
            section(
              'history_summary',
              `Earlier in this conversation (${usableSummary.messageCount} message(s), not shown in full below):\n${usableSummary.text}`,
            ),
          ]
        : []),
      section('memory', memory(input)),
      ...(input.mood ? [section('mood', moodPromptText(input.mood))] : []),
      ...(input.routine ? [section('routine', RoutineService.promptText(input.routine))] : []),
      section('session', sessionNotes(input)),
    ].join('\n\n');
    const system = `${stable}\n\n${dynamic}`;

    const systemTokens = estimateTokens(system);
    const budget = Math.max(MIN_TRANSCRIPT_BUDGET, input.contextTokenBudget - systemTokens);
    const trim: TranscriptOptions = {};
    if (input.keepActionDetailFor !== undefined) trim.keepActionDetailFor = input.keepActionDetailFor;
    const all = transcriptToMessages(transcript, input.useTools, trim);
    const messages = windowMessages(all, budget);
    const withActions = transcript.filter((m) => m.role === 'assistant' && (m.actions?.length ?? 0) > 0).length;
    const keptDetail = input.keepActionDetailFor === undefined ? withActions : Math.min(withActions, Math.max(0, input.keepActionDetailFor));
    const stats: PromptStats = {
      systemTokens,
      sdkReferenceTokens: estimateTokens(reference),
      budgetTokens: input.contextTokenBudget,
      transcriptBudgetTokens: budget,
      transcriptTokens: messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content)), 0),
      droppedMessages: all.length - messages.length,
      summarisedMessages: usableSummary ? throughIdx + 1 : 0,
      summaryTokens: usableSummary ? estimateTokens(usableSummary.text) : 0,
      trimmedActionMessages: withActions - keptDetail,
    };
    return { system, messages, stats, stablePrefixLength: stable.length };
  }
}
