import type { CapabilityModuleSpec } from '@rp/shared';

export const chatModule: CapabilityModuleSpec = {
  id: 'chat',
  version: '1.0.0',
  title: 'Chat',
  summary: 'Emote, set your status line, read older messages.',
  permission: 'trusted',
  apiTypeName: 'ChatApi',
  typings: `/** Emote, keep a status line and inspect the conversation. Always available. */
interface ChatApi {
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
  docs: `Add emotes, keep a status line and re-read older messages.

- Say what you want to say in your normal reply text — there is no API for speaking; an action is not the place for dialogue.
- \`emote\` is a short italic action line, posted right away; it is also how a behaviour, timer or event script puts something in the chat without a model turn (for real unprompted speech use \`sdk.llm.wake\`).
- \`setStatus\` is a persistent status under your name (clear it with \`null\`).
- \`history\` only when you need messages that are no longer in your context (it returns plain text, newest last).

\`\`\`ts
await sdk.chat.emote("leans back and stretches");
await sdk.chat.setStatus("searching the album");
\`\`\``,
  methods: {
    emote: { description: 'Append an italic emote/action line to the chat.' },
    history: { description: 'Read the most recent messages of the session.' },
    setStatus: { description: "Set or clear the status line under the character's name." },
  },
};
