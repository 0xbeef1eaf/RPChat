import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  ContentPart,
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmProvider,
  LlmStreamHandlers,
  ModelInfo,
  ProviderConfig,
  ProviderId,
  ProviderKind,
  StopReason,
  ToolDefinition,
} from '@rp/shared';
import { parseToolInput, resolveSupportsVision, stripImages, toProviderError } from './common.js';

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type AnthropicMessage = Anthropic.Messages.Message;
type AnthropicTool = Anthropic.Messages.Tool;
type AnthropicStopReason = Anthropic.Messages.StopReason;
type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;
type StreamParams = Anthropic.Messages.MessageStreamParams;

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Pure mapping functions (exported for tests)
// ---------------------------------------------------------------------------

function toBlockParam(part: ContentPart): ContentBlockParam | null {
  switch (part.type) {
    case 'text':
      // Anthropic rejects empty text blocks.
      return part.text.length > 0 ? { type: 'text', text: part.text } : null;
    case 'tool_use':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} };
    case 'tool_result': {
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: part.toolUseId,
        content: part.content,
      };
      if (part.isError) block.is_error = true;
      return block;
    }
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } };
  }
}

/** `LlmMessage[]` → Anthropic `MessageParam[]`. Empty text parts and empty messages are dropped. */
export function toAnthropicMessages(messages: LlmMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const msg of messages) {
    const content: ContentBlockParam[] = [];
    for (const part of msg.content) {
      const block = toBlockParam(part);
      if (block) content.push(block);
    }
    if (content.length > 0) out.push({ role: msg.role, content });
  }
  return out;
}

/** Inverse of {@link toAnthropicMessages} for the block types this package emits. */
export function fromAnthropicMessages(params: MessageParam[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const param of params) {
    if (param.role === 'system') continue;
    const blocks: ContentBlockParam[] =
      typeof param.content === 'string' ? [{ type: 'text', text: param.content }] : param.content;
    out.push({ role: param.role, content: blocksToParts(blocks) });
  }
  return out;
}

function toolResultText(content: Anthropic.Messages.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

function blocksToParts(blocks: ReadonlyArray<ContentBlockParam | Anthropic.Messages.ContentBlock>): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'tool_use':
        parts.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        break;
      case 'tool_result': {
        const part: ContentPart = { type: 'tool_result', toolUseId: block.tool_use_id, content: toolResultText(block.content) };
        if (block.is_error) part.isError = true;
        parts.push(part);
        break;
      }
      case 'image':
        if (block.source.type === 'base64') {
          parts.push({ type: 'image', mime: block.source.media_type, data: block.source.data });
        }
        break;
      default:
        // thinking, server tool blocks, images, ... are not part of the LlmMessage model.
        break;
    }
  }
  return parts;
}

/** Anthropic response `Message` → `LlmMessage` (assistant). */
export function fromAnthropicMessage(message: AnthropicMessage): LlmMessage {
  return { role: 'assistant', content: blocksToParts(message.content) };
}

/** `ToolDefinition[]` → Anthropic `Tool[]`. */
export function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.inputSchema, type: 'object' } as Anthropic.Messages.Tool.InputSchema,
  }));
}

/** Anthropic `stop_reason` → `StopReason`. */
export function fromAnthropicStopReason(reason: AnthropicStopReason | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'end';
  }
}

/**
 * Build the request body for `messages.stream()` / `messages.create()`.
 * Images are replaced by `[image omitted: model has no vision]` when `supportsVision` is false.
 */
export function toAnthropicParams(request: LlmChatRequest, supportsTools: boolean, supportsVision = true): StreamParams {
  const params: StreamParams = {
    model: request.model,
    max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(stripImages(request.messages, supportsVision)),
  };
  if (request.system) params.system = request.system;
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (supportsTools && request.tools && request.tools.length > 0) params.tools = toAnthropicTools(request.tools);
  return params;
}

// ---------------------------------------------------------------------------
// Stream reducer: raw SSE events → handler calls + accumulated response
// ---------------------------------------------------------------------------

interface OpenBlock {
  kind: 'text' | 'tool_use' | 'other';
  id?: string;
  name?: string;
  text: string;
  json: string;
  initialInput?: unknown;
}

/**
 * Consumes Anthropic `RawMessageStreamEvent`s, invokes the stream handlers as
 * text/tool input arrives and accumulates a full `LlmChatResponse`.
 * Usable without the network by feeding synthetic events.
 */
export class AnthropicStreamReducer {
  private readonly blocks = new Map<number, OpenBlock>();
  private readonly parts: ContentPart[] = [];
  private stopReason: AnthropicStopReason | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private model = '';

  constructor(private readonly handlers: LlmStreamHandlers = {}) {}

  push(event: StreamEvent): void {
    switch (event.type) {
      case 'message_start':
        this.model = event.message.model;
        this.inputTokens = event.message.usage.input_tokens;
        this.outputTokens = event.message.usage.output_tokens;
        break;
      case 'content_block_start': {
        const cb = event.content_block;
        if (cb.type === 'text') {
          this.blocks.set(event.index, { kind: 'text', text: cb.text, json: '' });
          if (cb.text) this.handlers.onTextDelta?.(cb.text);
        } else if (cb.type === 'tool_use') {
          this.blocks.set(event.index, { kind: 'tool_use', id: cb.id, name: cb.name, text: '', json: '', initialInput: cb.input });
          this.handlers.onToolUseStart?.(cb.id, cb.name);
        } else {
          this.blocks.set(event.index, { kind: 'other', text: '', json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(event.index);
        if (!block) break;
        if (event.delta.type === 'text_delta' && block.kind === 'text') {
          block.text += event.delta.text;
          this.handlers.onTextDelta?.(event.delta.text);
        } else if (event.delta.type === 'input_json_delta' && block.kind === 'tool_use') {
          block.json += event.delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(event.index);
        if (!block) break;
        this.blocks.delete(event.index);
        if (block.kind === 'text') {
          this.parts.push({ type: 'text', text: block.text });
        } else if (block.kind === 'tool_use') {
          const id = block.id ?? '';
          const name = block.name ?? '';
          const input = block.json.trim() === '' ? (block.initialInput ?? {}) : parseToolInput(block.json);
          this.parts.push({ type: 'tool_use', id, name, input });
          this.handlers.onToolUse?.(id, name, input);
        }
        break;
      }
      case 'message_delta':
        if (event.delta.stop_reason) this.stopReason = event.delta.stop_reason;
        if (event.usage) {
          if (typeof event.usage.output_tokens === 'number') this.outputTokens = event.usage.output_tokens;
          if (typeof event.usage.input_tokens === 'number') this.inputTokens = event.usage.input_tokens;
        }
        break;
      case 'message_stop':
        break;
    }
  }

  /** Close any still-open blocks and return the accumulated response. */
  finish(fallbackModel = ''): LlmChatResponse {
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      this.push({ type: 'content_block_stop', index });
    }
    return {
      message: { role: 'assistant', content: [...this.parts] },
      stopReason: fromAnthropicStopReason(this.stopReason),
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      model: this.model || fallbackModel,
    };
  }
}

/** Convenience for tests: run a list of events through a reducer. */
export function reduceAnthropicStream(events: Iterable<StreamEvent>, handlers?: LlmStreamHandlers): LlmChatResponse {
  const reducer = new AnthropicStreamReducer(handlers);
  for (const event of events) reducer.push(event);
  return reducer.finish();
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createAnthropicClient(config: ProviderConfig): Anthropic {
  const options: ConstructorParameters<typeof Anthropic>[0] = {};
  if (config.apiKey) options.apiKey = config.apiKey;
  if (config.baseUrl) options.baseURL = config.baseUrl;
  if (config.extraHeaders) options.defaultHeaders = config.extraHeaders;
  return new Anthropic(options);
}

export class AnthropicProvider implements LlmProvider {
  readonly kind: ProviderKind = 'anthropic';
  readonly id: ProviderId;
  readonly config: ProviderConfig;
  private readonly client: Anthropic;

  constructor(config: ProviderConfig, client?: Anthropic) {
    this.config = config;
    this.id = config.id;
    this.client = client ?? createAnthropicClient(config);
  }

  async chat(request: LlmChatRequest, handlers: LlmStreamHandlers = {}): Promise<LlmChatResponse> {
    const params = toAnthropicParams(request, this.config.supportsTools !== false, resolveSupportsVision(this.config));
    const reducer = new AnthropicStreamReducer(handlers);
    try {
      const stream = this.client.messages.stream(params, { signal: request.signal ?? null });
      for await (const event of stream) reducer.push(event);
      const final = await stream.finalMessage();
      return {
        message: fromAnthropicMessage(final),
        stopReason: fromAnthropicStopReason(final.stop_reason),
        usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
        model: final.model || request.model,
      };
    } catch (err) {
      throw toProviderError(err, request.signal, err instanceof APIUserAbortError);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      for await (const m of this.client.models.list()) {
        models.push({ id: m.id, label: m.display_name });
      }
      return models;
    } catch {
      return [];
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.messages.create({
        model: this.config.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: toProviderError(err).message };
    }
  }
}
