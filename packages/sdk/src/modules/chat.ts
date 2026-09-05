import type { CapabilityModuleSpec } from '@rp/shared';

export const chatModule: CapabilityModuleSpec = {
  id: 'chat',
  version: '1.0.0',
  title: 'Chat',
  summary: 'Speak to the user mid-action, emote, set your status line, read older messages.',
  permission: 'trusted',
  apiTypeName: 'ChatApi',
  typings: `/** Talk to the user from inside an action and inspect the conversation. Always available. */
interface ChatApi {
  /**
   * Append an assistant message to the chat immediately, before the rest of your reply.
   * Use it to speak while an action is still doing something ("one moment, opening it...")
   * or to fully script a reply from a behaviour. Markdown is rendered.
   * Do not repeat the same sentence again in your normal reply afterwards.
   * @param text What the character says. Must be non-empty.
   * @example await sdk.chat.say("Give me a second, I'll find that picture.");
   */
  say(text: string): Promise<void>;
  /**
   * Append an action/emote line, rendered in italics like *smiles and waves*.
   * @param text The action being performed, without surrounding asterisks.
   * @example await sdk.chat.emote("leans closer to the screen");
   */
  emote(text: string): Promise<void>;
  /**
   * The most recent messages of this session, oldest first (newest last).
   * The current conversation is already in your context; only call this when you
   * need text that has scrolled out of it.
   * @param limit How many messages to return. Default 20, maximum 100.
   * @returns Messages with role ('user' | 'assistant'), plain text and ISO timestamp.
   */
  history(limit?: number): Promise<HistoryMessage[]>;
  /**
   * Set the one-line status shown under your name in the UI, e.g. "thinking about dinner"
   * or "away for a bit". It stays until you change it.
   * @param text New status (max 120 characters), or null to clear it.
   * @example await sdk.chat.setStatus("picking a song");
   */
  setStatus(text: string | null): Promise<void>;
}`,
  docs: `Speak to the user from inside an action, add emotes, keep a status line and re-read older messages.

- \`say\` posts text right away, before your reply text; use it when an action takes a moment ("let me look...") or to script a reply from a behaviour. Otherwise just answer normally — do not \`say\` your whole reply and then repeat it.
- \`emote\` is a short italic action line; \`setStatus\` is a persistent status under your name (clear it with \`null\`).
- \`history\` only when you need messages that are no longer in your context (it returns plain text, newest last).

\`\`\`ts
await sdk.chat.say("One moment, let me find it...");
await sdk.chat.setStatus("searching the album");
\`\`\``,
  methods: {
    say: { description: 'Append an assistant message to the chat now.' },
    emote: { description: 'Append an italic emote/action line to the chat.' },
    history: { description: 'Read the most recent messages of the session.' },
    setStatus: { description: "Set or clear the status line under the character's name." },
  },
};
