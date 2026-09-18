/** Helpers for the messaging-channel editor in Settings → Integrations. */
import type { MessagingChannel } from '@rp/shared';

/**
 * Pulls the bot token and chat id back out of a telegram channel saved the older way — the whole
 * `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>` endpoint in one URL field — so
 * editing such a channel shows the two fields filled in instead of starting from nothing.
 */
export function splitTelegramUrl(url: string | undefined): { token: string; chatId: string } {
  if (!url || !url.trim()) return { token: '', chatId: '' };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { token: '', chatId: '' };
  }
  const token = /^\/bot([^/]+)/.exec(parsed.pathname)?.[1] ?? '';
  return { token: decodeURIComponent(token), chatId: parsed.searchParams.get('chat_id') ?? '' };
}

/** The channel as the editor should show it: telegram always in `token`/`chatId` form. */
export function channelForEditing(channel: MessagingChannel): MessagingChannel {
  if (channel.kind !== 'telegram' || channel.token) return { ...channel };
  const { token, chatId } = splitTelegramUrl(channel.url);
  if (!token) return { ...channel };
  return { ...channel, token, chatId: channel.chatId || chatId, url: undefined };
}

/** What to store for a channel the user just edited: only the fields its kind uses. */
export function channelForSaving(draft: MessagingChannel): MessagingChannel {
  const clean: MessagingChannel = { name: draft.name.trim(), kind: draft.kind };
  if (draft.kind === 'command') {
    clean.command = { command: draft.command?.command ?? '', shell: draft.command?.shell || undefined };
  } else if (draft.kind === 'telegram') {
    if (draft.token?.trim()) clean.token = draft.token.trim();
    if (draft.chatId?.trim()) clean.chatId = draft.chatId.trim();
    // A channel with no token keeps whatever endpoint URL it had, so nothing breaks mid-edit.
    if (!clean.token && draft.url?.trim()) clean.url = draft.url.trim();
  } else if (draft.url?.trim()) {
    clean.url = draft.url.trim();
  }
  return clean;
}

/** How a channel is described in the list, with any bot token left out. */
export function channelSummary(channel: MessagingChannel): string {
  const parts: string[] = [channel.kind];
  if (channel.kind === 'telegram' && channel.token) parts.push(`bot ${channel.token.split(':')[0]}${channel.chatId ? ` → ${channel.chatId}` : ''}`);
  else if (channel.url) parts.push(channel.url.replace(/(bot)[^/]+/, '$1…'));
  if (channel.command) parts.push(channel.command.command);
  return parts.join(' · ');
}
