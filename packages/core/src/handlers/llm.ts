import type { ActionContext, CapabilityHandler, Json, LlmChatRequest } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { ChatService } from '../services/chat.js';
import type { ProviderFactory, SettingsService } from '../services/settings.js';
import type { TimerService } from '../services/timers.js';
import { TIMER_PROMPT_MAX } from '../services/timers.js';
import { timerInfo } from './timers.js';

export const ASK_DEFAULT_MAX_TOKENS = 512;
export const ASK_MAX_TOKENS = 2048;
export const ASK_TIMEOUT_MS = 60_000;
export const ASK_DEFAULT_SYSTEM = 'You are a helpful assistant. Answer concisely.';
export const ASK_PROMPT_MAX_CHARS = 32_000;

export interface LlmHandlerOptions {
  settings: SettingsService;
  providerFactory: ProviderFactory;
  timers: TimerService;
  sessions: { get(sessionId: string): Promise<{ providerId?: string; model?: string } | undefined> };
  /** Resolved lazily: the chat service is constructed after the handlers. */
  chat: () => Pick<ChatService, 'queueImmediateWake'>;
}

/** `sdk.llm`: `ask` (tool-less side completion, off the transcript) and `wake` (self-triggered turn now or later). */
export class LlmHandler implements CapabilityHandler {
  readonly moduleId = 'llm';

  constructor(private readonly o: LlmHandlerOptions) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'ask':
        return this.ask(args[0], args[1], context);
      case 'wake':
        return this.wake(args[0], args[1], context);
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.llm.${method}`);
    }
  }

  private async ask(promptArg: unknown, optsArg: unknown, context: ActionContext): Promise<string> {
    if (typeof promptArg !== 'string' || promptArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'prompt must be a non-empty string');
    if (promptArg.length > ASK_PROMPT_MAX_CHARS) throw new RpError('INVALID_ARGUMENT', `prompt must be at most ${ASK_PROMPT_MAX_CHARS} characters`);
    const opts = this.options(optsArg);
    let system = ASK_DEFAULT_SYSTEM;
    if (opts.system !== undefined && opts.system !== null) {
      if (typeof opts.system !== 'string') throw new RpError('INVALID_ARGUMENT', 'opts.system must be a string');
      if (opts.system.trim().length > 0) system = opts.system;
    }
    let maxTokens = ASK_DEFAULT_MAX_TOKENS;
    if (opts.maxTokens !== undefined && opts.maxTokens !== null) {
      if (typeof opts.maxTokens !== 'number' || !Number.isFinite(opts.maxTokens) || opts.maxTokens < 1) {
        throw new RpError('INVALID_ARGUMENT', 'opts.maxTokens must be a positive number');
      }
      maxTokens = Math.min(ASK_MAX_TOKENS, Math.floor(opts.maxTokens));
    }
    let temperature: number | undefined;
    if (opts.temperature !== undefined && opts.temperature !== null) {
      if (typeof opts.temperature !== 'number' || !Number.isFinite(opts.temperature) || opts.temperature < 0 || opts.temperature > 1) {
        throw new RpError('INVALID_ARGUMENT', 'opts.temperature must be between 0 and 1');
      }
      temperature = opts.temperature;
    }

    const session = await this.o.sessions.get(context.sessionId);
    const config = await this.o.settings.resolveProvider(session?.providerId);
    const provider = this.o.providerFactory(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const request: LlmChatRequest = {
        model: session?.model ?? config.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptArg }] }],
        maxTokens,
        signal: controller.signal,
      };
      if (temperature !== undefined) request.temperature = temperature;
      const response = await provider.chat(request);
      return response.message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
    } catch (err) {
      const rp = RpError.from(err, 'LLM_PROVIDER');
      throw new RpError('CAPABILITY_FAILED', `sdk.llm.ask failed: ${rp.message}`, { code: rp.code }, { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async wake(promptArg: unknown, optsArg: unknown, context: ActionContext): Promise<Json> {
    if (typeof promptArg !== 'string' || promptArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'prompt must be a non-empty string');
    const prompt = promptArg.trim();
    if (prompt.length > TIMER_PROMPT_MAX) throw new RpError('INVALID_ARGUMENT', `prompt must be at most ${TIMER_PROMPT_MAX} characters`);
    const opts = this.options(optsArg);
    const delay = opts.delayMs === undefined || opts.delayMs === null ? 0 : opts.delayMs;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) throw new RpError('INVALID_ARGUMENT', 'opts.delayMs must be a non-negative number');
    if (opts.label !== undefined && opts.label !== null && typeof opts.label !== 'string') throw new RpError('INVALID_ARGUMENT', 'opts.label must be a string');
    if (delay === 0) {
      this.o.chat().queueImmediateWake(context.sessionId, prompt);
      return { queued: true };
    }
    const timer = await this.o.timers.schedulePrompt(context, delay, prompt, typeof opts.label === 'string' ? opts.label : undefined);
    return { queued: false, timer: timerInfo(timer) };
  }

  private options(value: unknown): Record<string, Json> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new RpError('INVALID_ARGUMENT', 'opts must be an object');
    return value as Record<string, Json>;
  }
}
