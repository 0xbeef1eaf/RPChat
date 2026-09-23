import type { ActionContext, CapabilityHandler, ChatMessage, Json, Storage } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { SessionService } from '../services/sessions.js';
import type { EngineEmitter } from '../types.js';

const STATUS_MAX = 120;
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 100;

function originOf(context: ActionContext): NonNullable<ChatMessage['origin']> {
  switch (context.trigger.kind) {
    case 'llm':
      return 'llm';
    case 'timer':
      return 'timer';
    case 'event':
      return 'event';
    default:
      return 'behaviour';
  }
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RpError('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  }
  return value;
}

/** `sdk.chat`: emote appends an assistant message, history reads the transcript, setStatus emits a status event. */
export class ChatHandler implements CapabilityHandler {
  readonly moduleId = 'chat';

  constructor(
    private readonly sessions: SessionService,
    private readonly messages: Storage['messages'],
    private readonly emitter: EngineEmitter,
  ) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'emote': {
        const text = requireText(args[0], 'text');
        await this.sessions.require(context.sessionId);
        const message: Parameters<SessionService['addMessage']>[0] = {
          sessionId: context.sessionId,
          role: 'assistant',
          content: text,
          origin: originOf(context),
          kind: 'emote',
        };
        // Said as part of a reply, so a retry of that reply takes it with it. Code running in the
        // background (a timer, an event handler) has no turn, and what it says outlives one.
        if (context.trigger.kind === 'llm' && context.trigger.turnId !== undefined) message.turnId = context.trigger.turnId;
        await this.sessions.addMessage(message);
        return;
      }
      case 'history': {
        const raw = args[0];
        const limit = raw === undefined || raw === null ? HISTORY_DEFAULT : Number(raw);
        if (!Number.isFinite(limit) || limit < 1) throw new RpError('INVALID_ARGUMENT', 'limit must be a positive number');
        const all = await this.messages.list(context.sessionId);
        return all
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.length > 0)
          .slice(-Math.min(Math.floor(limit), HISTORY_MAX))
          .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.kind === 'emote' ? `*${m.content}*` : m.content, at: m.createdAt }));
      }
      case 'setStatus': {
        const value = args[0];
        if (value !== null && value !== undefined && typeof value !== 'string') {
          throw new RpError('INVALID_ARGUMENT', 'status must be a string or null');
        }
        const text = typeof value === 'string' ? value.trim().slice(0, STATUS_MAX) : '';
        this.emitter.emit('chat', { type: 'status', sessionId: context.sessionId, text: text.length > 0 ? text : null });
        return;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.chat.${method}`);
    }
  }
}
