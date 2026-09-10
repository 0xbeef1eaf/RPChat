/** `sdk.messaging`: send text to user-configured channels (webhooks or a command template). */
import type { ActionContext, CapabilityHandler, CommandTemplate, Json, MessagingChannel } from '@rp/shared';
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
      // url: https://api.telegram.org/bot<token>/sendMessage?chat_id=<id> → POST JSON { chat_id, text }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
      }
      const chatId = parsed.searchParams.get('chat_id');
      parsed.searchParams.delete('chat_id');
      const body: Record<string, string> = { text };
      if (chatId) body.chat_id = chatId;
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
      throw new RpError('CAPABILITY_FAILED', `Messaging channel "${channel.name}" (${channel.kind}) has no valid http(s) webhook URL; edit it under Settings → Integrations → Messaging channels`, { channel: channel.name });
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
