/** `sdk.messaging`: send text to user-configured channels (webhooks or a command template). */
import type { ActionContext, CapabilityHandler, CommandTemplate, Json, MessagingChannel, TelegramChat } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CommandResult } from '../commands.js';

export const MESSAGING_TIMEOUT_MS = 10_000;
export const MESSAGE_MAX_CHARS = 4000;

export interface MessageRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

/** A bot token from @BotFather: the bot's own user id, a colon, then its secret. */
export const TELEGRAM_TOKEN_RE = /^\d+:[\w-]+$/;

/** The api.telegram.org endpoint for one bot method. `token` must have passed `TELEGRAM_TOKEN_RE`. */
export function telegramApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Pure: the chats out of a `getUpdates` response, newest first, one entry per chat. This is how the
 * user finds a chat id — Telegram never tells a bot its chat ids, they only show up once someone
 * writes to the bot (or it is added to a group), so an empty list means "nobody has yet".
 */
export function telegramChatsFromUpdates(payload: unknown): TelegramChat[] {
  const updates = (payload as { result?: unknown } | null)?.result;
  if (!Array.isArray(updates)) return [];
  const seen = new Map<string, TelegramChat>();
  for (const update of [...updates].reverse()) {
    for (const key of ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member']) {
      const chat = (update as Record<string, { chat?: unknown } | undefined>)?.[key]?.chat as
        | { id?: unknown; title?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown; type?: unknown }
        | undefined;
      if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue;
      const id = String(chat.id);
      if (seen.has(id)) continue;
      const name = typeof chat.title === 'string' && chat.title
        ? chat.title
        : [chat.first_name, chat.last_name].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
      const username = typeof chat.username === 'string' && chat.username ? `@${chat.username}` : '';
      seen.set(id, { id, title: name || username || id, type: typeof chat.type === 'string' ? chat.type : 'unknown' });
    }
  }
  return [...seen.values()];
}

/**
 * Asks Telegram which chats the bot has heard from, so Settings can offer them instead of asking
 * the user to read a chat id out of a raw `getUpdates` response.
 */
export async function fetchTelegramChats(token: string, fetchImpl: typeof fetch = fetch): Promise<TelegramChat[]> {
  const trimmed = token.trim();
  if (!TELEGRAM_TOKEN_RE.test(trimmed)) {
    throw new RpError('INVALID_ARGUMENT', 'That does not look like a bot token; @BotFather gives you `<bot id>:<secret>`');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MESSAGING_TIMEOUT_MS);
  let payload: unknown;
  try {
    const res = await fetchImpl(`${telegramApiUrl(trimmed, 'getUpdates')}?limit=100`, { signal: controller.signal });
    payload = await res.json().catch(() => undefined);
    if (!res.ok) {
      const described = (payload as { description?: unknown } | undefined)?.description;
      throw new RpError('CAPABILITY_FAILED', `Telegram refused the token: ${typeof described === 'string' ? described : `HTTP ${res.status}`}`);
    }
  } catch (err) {
    if (err instanceof RpError) throw err;
    throw new RpError('CAPABILITY_FAILED', `Could not reach Telegram: ${(err as Error).message}`, undefined, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  return telegramChatsFromUpdates(payload);
}

/** Pure: the HTTP request for a webhook channel (undefined for `command` channels). */
export function buildMessageRequest(channel: MessagingChannel, text: string): MessageRequest | undefined {
  const url = channel.url ?? '';
  switch (channel.kind) {
    case 'discord':
      return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) };
    case 'slack':
      return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
    case 'generic-json':
      return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, channel: channel.name }) };
    case 'telegram': {
      const token = channel.token?.trim() ?? '';
      const chatId = channel.chatId?.trim() ?? '';
      // Preferred: the token and the chat id as their own fields → POST JSON { chat_id, text }.
      if (token) {
        if (!TELEGRAM_TOKEN_RE.test(token)) return undefined;
        const body: Record<string, string> = { text };
        if (chatId) body.chat_id = chatId;
        return { url: telegramApiUrl(token, 'sendMessage'), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      }
      // Older channels hold the whole endpoint in `url`, with the chat id in its query string.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
      }
      const id = chatId || parsed.searchParams.get('chat_id') || '';
      parsed.searchParams.delete('chat_id');
      const body: Record<string, string> = { text };
      if (id) body.chat_id = id;
      return { url: parsed.toString(), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }
    default:
      return undefined;
  }
}

export interface MessagingHandlerDeps {
  channels(): Promise<MessagingChannel[]>;
  runCommand(tpl: CommandTemplate, vars: Record<string, string>, label: string): Promise<CommandResult>;
  fetchImpl?: typeof fetch;
}

export class MessagingHandler implements CapabilityHandler {
  readonly moduleId = 'messaging';

  constructor(private readonly deps: MessagingHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'channels':
        return (await this.deps.channels()).map((c) => ({ name: c.name, kind: c.kind }));
      case 'send':
        return { ok: await this.send(args[0], args[1]) };
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.messaging.${method}`);
    }
  }

  private async send(nameArg: unknown, textArg: unknown): Promise<boolean> {
    if (typeof nameArg !== 'string' || nameArg.length === 0) throw new RpError('INVALID_ARGUMENT', 'channel must be a non-empty string');
    if (typeof textArg !== 'string' || textArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
    const text = textArg.length > MESSAGE_MAX_CHARS ? `${textArg.slice(0, MESSAGE_MAX_CHARS - 1)}…` : textArg;
    const channel = (await this.deps.channels()).find((c) => c.name === nameArg);
    if (!channel) {
      const names = (await this.deps.channels()).map((c) => c.name);
      throw new RpError(
        'NOT_FOUND',
        names.length === 0
          ? `No messaging channels are configured; the user can add one under Settings → Integrations → Messaging channels`
          : `No messaging channel named "${nameArg}" (configured: ${names.join(', ')}); the user manages them under Settings → Integrations → Messaging channels`,
        { channel: nameArg, configured: names },
      );
    }
    if (channel.kind === 'command') {
      if (!channel.command || channel.command.command.trim().length === 0) {
        throw new RpError('CAPABILITY_FAILED', `Messaging channel "${channel.name}" has no command; edit it under Settings → Integrations → Messaging channels`, { channel: channel.name });
      }
      const result = await this.deps.runCommand(channel.command, { text, channel: channel.name }, `messaging:${channel.name}`);
      return result.code === 0;
    }
    const request = buildMessageRequest(channel, text);
    if (!request || !/^https?:\/\//i.test(request.url)) {
      throw new RpError(
        'CAPABILITY_FAILED',
        channel.kind === 'telegram'
          ? `Messaging channel "${channel.name}" needs a Telegram bot token (\`<bot id>:<secret>\` from @BotFather) and a chat id; set them under Settings → Integrations → Messaging channels`
          : `Messaging channel "${channel.name}" (${channel.kind}) has no valid http(s) webhook URL; edit it under Settings → Integrations → Messaging channels`,
        { channel: channel.name },
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MESSAGING_TIMEOUT_MS);
    try {
      const init: RequestInit = { method: request.method, headers: request.headers, signal: controller.signal };
      if (request.body !== undefined) init.body = request.body;
      const res = await (this.deps.fetchImpl ?? fetch)(request.url, init);
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      throw new RpError('CAPABILITY_FAILED', `Sending to "${channel.name}" failed: ${(err as Error).message}`, undefined, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}
