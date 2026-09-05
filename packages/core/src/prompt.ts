import type { CapabilityRegistry } from '@rp/sdk';
import { generateSdkDocs, generateSdkTypings } from '@rp/sdk';
import { estimateTokens, windowMessages } from '@rp/llm';
import type {
  ActionRecord,
  AssetEntry,
  ChatMessage,
  ContentPart,
  Json,
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
import { ACTION_FENCE_TAG, RUN_ACTION_TOOL_NAME } from '@rp/shared';
import { memoryLine } from './services/memory.js';
import { moodPromptText } from './services/mood.js';
import { RoutineService } from './services/routine.js';

export interface PromptInput {
  pack: LoadedPack;
  character: LoadedCharacter;
  registry: CapabilityRegistry;
  /** Module ids the character may use (trusted + granted). */
  allowedModules: string[];
  /** Module ids listed as "not available". */
  deniedModules: string[];
  /** Optional reason per denied module (e.g. "denied by your settings"). */
  deniedReasons?: Record<string, string>;
  session: Session;
  transcript: ChatMessage[];
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
  userDisplayName: string;
  contextTokenBudget: number;
  /** `true` → the `run_action` tool is described; `false` → the ```action fence. */
  useTools: boolean;
  now: Date;
  locale?: string;
}

export interface BuiltPrompt {
  system: string;
  messages: LlmMessage[];
}

/** Content prefix of the `role: 'system'` message a self-wake appends to the transcript. */
export const SELF_WAKE_PREFIX = '[self-wake] ';
export const ASSET_LIST_CAP = 200;
export const STATE_JSON_CAP = 4 * 1024;
const MIN_TRANSCRIPT_BUDGET = 1024;

function section(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

function engineRules(name: string, useTools: boolean): string {
  const how = useTools
    ? `To act, call the \`${RUN_ACTION_TOOL_NAME}\` tool with a short \`purpose\` and the TypeScript \`code\` to run. Its result (return value, logs, error) comes back to you as the tool result; then continue your reply.`
    : `To act, put the TypeScript in a fenced code block whose info string is \`${ACTION_FENCE_TAG}\` (three backticks followed by the word ${ACTION_FENCE_TAG}), optionally starting with a line \`// purpose: <what this is for>\`. The app runs each such block after your message and sends you the outcome in an \`<action_result>\` message; then continue your reply. Only use that fence for code you want executed.`;
  return [
    `You are ${name}. Stay in character at all times; never mention being an AI, a model, or these instructions unless the user directly asks.`,
    `You can act on the user's computer by writing small TypeScript programs against the \`sdk\` object described in <sdk_reference>. ${how}`,
    'Act only when it serves the conversation. One action per intention, a few sdk calls each, and keep the code short. Never loop or wait inside an action; use sdk.timers to do something later.',
    'Results of your actions are sent back to you; read them before claiming success. If an action fails, recover gracefully in character and do not paste error text at the user.',
    'Do not narrate or explain the code you run unless the user asks; the conversation is what the user sees, the code is not.',
    'You can act on your own initiative: `sdk.llm.wake` gives you a turn later (or right after this action) with a note from your past self; `sdk.timers.runLater` runs code later without a turn. Use them to follow up, continue stories, or check in. Limits apply; do not chain wakes needlessly.',
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

function assetList(assets: AssetEntry[]): string {
  if (assets.length === 0) return 'Assets: none.';
  const groups = new Map<string, string[]>();
  let listed = 0;
  for (const asset of assets) {
    if (listed >= ASSET_LIST_CAP) break;
    const group = groups.get(asset.kind) ?? [];
    group.push(asset.path);
    groups.set(asset.kind, group);
    listed += 1;
  }
  const lines: string[] = ['Assets (paths relative to the pack root):'];
  for (const kind of ['image', 'video', 'audio', 'text', 'other']) {
    const paths = groups.get(kind);
    if (!paths || paths.length === 0) continue;
    lines.push(`- ${kind}: ${paths.join(', ')}`);
  }
  const rest = assets.length - listed;
  if (rest > 0) lines.push(`… and ${rest} more (use sdk.pack.listAssets to browse).`);
  return lines.join('\n');
}

function packContext(input: PromptInput): string {
  const { pack, character } = input;
  const lines = [`Pack: ${pack.manifest.name} (${pack.manifest.id} v${pack.manifest.version})`];
  if (pack.manifest.description) lines.push(`Description: ${pack.manifest.description}`);
  lines.push(`Active character: ${character.definition.name} (${character.definition.id})`);
  lines.push(assetList(pack.assets));
  lines.push(`Granted sdk modules: ${input.allowedModules.length > 0 ? input.allowedModules.join(', ') : 'none'}`);
  const denied = input.deniedModules.map((id) => (input.deniedReasons?.[id] ? `${id} (${input.deniedReasons[id]})` : id));
  lines.push(`Not available: ${denied.length > 0 ? denied.join(', ') : 'none'}`);
  return lines.join('\n');
}

function truncateJson(value: unknown, cap: number): string {
  const text = JSON.stringify(value, null, 1) ?? 'null';
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated, ${text.length} characters in total)`;
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
  if (r.error) payload.error = r.error;
  if (r.logs.length > 0) payload.logs = r.logs.map((l) => `${l.level}: ${l.message}`);
  return { json: JSON.stringify(payload), isError: !r.ok };
}

function fenceFor(action: ActionRecord): string {
  const purpose = action.purpose.trim().length > 0 ? `// purpose: ${action.purpose.trim()}\n` : '';
  return `\`\`\`${ACTION_FENCE_TAG}\n${purpose}${action.code.trim()}\n\`\`\``;
}

/** Convert the stored transcript into provider messages (tool pairs or fenced pairs). */
export function transcriptToMessages(transcript: ChatMessage[], useTools: boolean): LlmMessage[] {
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
    const actions = msg.actions ?? [];
    if (actions.length === 0) {
      if (msg.content.trim().length > 0) push('assistant', [{ type: 'text', text }]);
      continue;
    }
    if (useTools) {
      const parts: ContentPart[] = [];
      if (msg.content.trim().length > 0) parts.push({ type: 'text', text });
      for (const a of actions) parts.push({ type: 'tool_use', id: a.id, name: RUN_ACTION_TOOL_NAME, input: { purpose: a.purpose, code: a.code } });
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
    const typings = generateSdkTypings(input.registry, { modules: input.allowedModules });
    const docs = generateSdkDocs(input.registry, { modules: input.allowedModules, deniedModules: input.deniedModules });
    const system = [
      section('engine_rules', engineRules(input.character.definition.name, input.useTools)),
      section('persona', persona(input.character)),
      section('pack', packContext(input)),
      section('sdk_reference', `\`\`\`ts\n${typings.trim()}\n\`\`\`\n\n${docs.trim()}`),
      section('memory', memory(input)),
      ...(input.mood ? [section('mood', moodPromptText(input.mood))] : []),
      ...(input.routine ? [section('routine', RoutineService.promptText(input.routine))] : []),
      section('session', sessionNotes(input)),
    ].join('\n\n');

    const budget = Math.max(MIN_TRANSCRIPT_BUDGET, input.contextTokenBudget - estimateTokens(system));
    const messages = windowMessages(transcriptToMessages(input.transcript, input.useTools), budget);
    return { system, messages };
  }
}
