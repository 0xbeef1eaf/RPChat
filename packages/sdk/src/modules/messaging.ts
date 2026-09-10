import type { CapabilityModuleSpec } from '@rp/shared';

export const messagingModule: CapabilityModuleSpec = {
  id: 'messaging',
  version: '1.0.0',
  title: 'Messaging',
  summary: 'Send short messages to channels the user configured (Discord/Slack/Telegram webhooks or a command).',
  permission: 'pack',
  apiTypeName: 'MessagingApi',
  typings: `/**
 * Post text to outside channels the user set up in Settings > Messaging (webhooks or a custom
 * command). You can only send, not read. Channel names are user-defined; look them up with channels().
 */
interface MessagingApi {
  /**
   * Send a message to a channel. Fails with NOT_FOUND for unknown channel names.
   * @param channel Channel name from channels().
   * @param text Plain text (Markdown where the service supports it). Keep it short.
   * @returns ok: whether the service accepted the message.
   * @example await sdk.messaging.send("phone", "Reminder from Luna: the laundry is done.");
   */
  send(channel: string, text: string): Promise<{ ok: boolean }>;
  /** Channels the user configured, with their kind ('discord' | 'slack' | 'telegram' | 'generic-json' | 'command'). */
  channels(): Promise<Array<{ name: string; kind: 'discord' | 'slack' | 'telegram' | 'generic-json' | 'command' }>>;
}`,
  docs: `Reach the user (or their friends) outside this app: a Telegram nudge when they are away, a note to a Discord channel. Requires the \`messaging\` capability and channels configured by the user.

- Messages leave the machine and cannot be unsent: send only what the user would happily see delivered, never private details from state, files or the screen.
- Typical use is from a timer or event ("user idle 30 min → ping their phone"). Check \`channels()\` once and remember the name.
- One message per occasion; do not chatter into channels.
- \`send()\` throws NOT_FOUND for an unknown channel (the message lists the configured ones) and CAPABILITY_FAILED when the channel is misconfigured or delivery fails (Settings → Integrations → Messaging channels); \`{ ok: false }\` means the service rejected the message. Tell the user.

\`\`\`ts
const ch = (await sdk.messaging.channels()).find(c => c.kind === "telegram");
if (ch) await sdk.messaging.send(ch.name, "Tea's getting cold — Luna");
return { sent: Boolean(ch) };
\`\`\``,
  methods: {
    send: { description: 'Send a message to a configured channel.', dangerous: true },
    channels: { description: 'List configured messaging channels.' },
  },
};
