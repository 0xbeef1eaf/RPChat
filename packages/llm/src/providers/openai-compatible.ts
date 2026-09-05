import OpenAI, { APIUserAbortError } from 'openai';
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
import { parseToolInput, resolveSupportsVision, stringifyToolInput, stripImages, toProviderError } from './common.js';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessage;
type FinishReason = OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'];
type StreamParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type ToolCallParam = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
type UserContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** Placeholder key sent to local servers (Ollama, LM Studio) that ignore auth but require the header. */
export const OPENAI_PLACEHOLDER_API_KEY = 'ollama';

// ---------------------------------------------------------------------------
// Pure mapping functions (exported for tests)
// ---------------------------------------------------------------------------

function joinText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * `system` + `LlmMessage[]` → OpenAI chat messages.
 * Assistant `tool_use` parts become `tool_calls`; each `tool_result` part becomes its own
 * `role: 'tool'` message (emitted before any user text so it directly follows the call).
 * User messages with images use a content-parts array (`text` + `image_url` data URLs).
 */
export function toOpenAiMessages(system: string, messages: LlmMessage[]): ChatMessageParam[] {
  const out: ChatMessageParam[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const text = joinText(msg.content);
      const toolCalls: ToolCallParam[] = msg.content
        .filter((p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use')
        .map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: stringifyToolInput(p.input) } }));
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      if (text.length > 0 || toolCalls.length > 0) out.push(assistant);
    } else {
      for (const part of msg.content) {
        if (part.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: part.toolUseId, content: part.content });
        }
      }
      const userContent = toUserContent(msg.content);
      if (userContent !== null) out.push({ role: 'user', content: userContent });
    }
  }
  return out;
}

/** Text/image parts of a user message → string (text only) or content-parts array (with images). */
function toUserContent(parts: ContentPart[]): string | UserContentPart[] | null {
  const hasImage = parts.some((p) => p.type === 'image');
  if (!hasImage) {
    const text = joinText(parts);
    return text.length > 0 ? text : null;
  }
  const out: UserContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) out.push({ type: 'text', text: part.text });
    else if (part.type === 'image') out.push({ type: 'image_url', image_url: { url: toDataUrl(part.mime, part.data) } });
  }
  return out.length > 0 ? out : null;
}

export function toDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** Parse a `data:<mime>;base64,<data>` URL back into an image part; `null` for anything else. */
export function fromDataUrl(url: string): Extract<ContentPart, { type: 'image' }> | null {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  return { type: 'image', mime: m[1] as Extract<ContentPart, { type: 'image' }>['mime'], data: m[2] ?? '' };
}

function isToolResultsOnly(msg: LlmMessage): boolean {
  return msg.content.length > 0 && msg.content.every((p) => p.type === 'tool_result');
}

function partText(content: string | null | undefined | ReadonlyArray<{ type: string; text?: string }>): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
}

/** User message content → parts, keeping text/image order. */
function userContentToParts(content: string | ReadonlyArray<UserContentPart>): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts: ContentPart[] = [];
  for (const c of content) {
    if (c.type === 'text') parts.push({ type: 'text', text: c.text });
    else if (c.type === 'image_url') {
      const img = fromDataUrl(c.image_url.url);
      if (img) parts.push(img);
    }
  }
  return parts;
}

/**
 * Inverse of {@link toOpenAiMessages}: consecutive `tool` messages are folded back into one
 * user message of `tool_result` parts (merged with directly following user text).
 * `isError` cannot be recovered (OpenAI has no flag for it).
 */
export function fromOpenAiMessages(params: ChatMessageParam[]): { system: string; messages: LlmMessage[] } {
  let system = '';
  const messages: LlmMessage[] = [];
  const last = (): LlmMessage | undefined => messages[messages.length - 1];
  for (const param of params) {
    switch (param.role) {
      case 'system':
      case 'developer':
        system += (system ? '\n' : '') + partText(param.content);
        break;
      case 'user': {
        const parts = userContentToParts(param.content);
        const prev = last();
        if (prev && prev.role === 'user' && isToolResultsOnly(prev)) {
          prev.content.push(...parts);
        } else {
          messages.push({ role: 'user', content: parts });
        }
        break;
      }
      case 'tool': {
        const part: ContentPart = { type: 'tool_result', toolUseId: param.tool_call_id, content: partText(param.content) };
        const prev = last();
        if (prev && prev.role === 'user' && isToolResultsOnly(prev)) {
          prev.content.push(part);
        } else {
          messages.push({ role: 'user', content: [part] });
        }
        break;
      }
      case 'assistant': {
        const content: ContentPart[] = [];
        const text = partText(param.content);
        if (text) content.push({ type: 'text', text });
        for (const call of param.tool_calls ?? []) {
          if (call.type === 'function') {
            content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) });
          }
        }
        messages.push({ role: 'assistant', content });
        break;
      }
      default:
        break;
    }
  }
  return { system, messages };
}

/** Non-streaming `ChatCompletionMessage` → `LlmMessage`. */
export function fromOpenAiMessage(message: ChatMessage): LlmMessage {
  const content: ContentPart[] = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    if (call.type === 'function') {
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) });
    }
  }
  return { role: 'assistant', content };
}

/** `ToolDefinition[]` → OpenAI function tools. */
export function toOpenAiTools(tools: ToolDefinition[]): ChatTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** OpenAI `finish_reason` → `StopReason`. `hasToolCalls` wins over a plain `stop`. */
export function fromOpenAiFinishReason(reason: FinishReason | undefined, hasToolCalls = false): StopReason {
  if (reason === 'length') return 'max_tokens';
  if (hasToolCalls || reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'end';
}

/**
 * Build the streaming request body.
 * Images are replaced by `[image omitted: model has no vision]` when `supportsVision` is false.
 */
export function toOpenAiParams(request: LlmChatRequest, supportsTools: boolean, supportsVision = false): StreamParams {
  const params: StreamParams = {
    model: request.model,
    messages: toOpenAiMessages(request.system, stripImages(request.messages, supportsVision)),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens;
  if (supportsTools && request.tools && request.tools.length > 0) params.tools = toOpenAiTools(request.tools);
  return params;
}

// ---------------------------------------------------------------------------
// Stream reducer: chunks → handler calls + accumulated response
// ---------------------------------------------------------------------------

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
  done: boolean;
}

/**
 * Consumes `ChatCompletionChunk`s, invokes the stream handlers and accumulates a
 * full `LlmChatResponse`. A tool call is reported complete (`onToolUse`) when the next
 * tool call index starts or when the stream finishes. Usable without the network.
 */
export class OpenAiStreamReducer {
  private text = '';
  private readonly toolCalls: PendingToolCall[] = [];
  private finishReason: FinishReason | undefined;
  private usage: { inputTokens: number; outputTokens: number } | undefined;
  private model = '';
  private nextSyntheticId = 0;

  constructor(private readonly handlers: LlmStreamHandlers = {}) {}

  push(chunk: ChatChunk): void {
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      this.usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk.choices[0];
    if (!choice) return;
    const delta = choice.delta;
    if (delta?.content) {
      this.text += delta.content;
      this.handlers.onTextDelta?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = typeof tc.index === 'number' ? tc.index : this.toolCalls.length - 1;
      let call = this.toolCalls.find((c) => c.index === index);
      if (!call) {
        // A new call begins: everything before it is complete.
        for (const prev of this.toolCalls) this.complete(prev);
        call = { index, id: '', name: '', args: '', started: false, done: false };
        this.toolCalls.push(call);
      }
      if (tc.id && !call.id) call.id = tc.id;
      if (tc.function?.name) call.name = call.started ? call.name : call.name + tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      if (!call.started && call.name) {
        if (!call.id) call.id = `call_${this.nextSyntheticId++}`;
        call.started = true;
        this.handlers.onToolUseStart?.(call.id, call.name);
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  private complete(call: PendingToolCall): void {
    if (call.done) return;
    call.done = true;
    if (!call.id) call.id = `call_${this.nextSyntheticId++}`;
    if (!call.started) {
      call.started = true;
      this.handlers.onToolUseStart?.(call.id, call.name);
    }
    this.handlers.onToolUse?.(call.id, call.name, parseToolInput(call.args));
  }

  /** Flush pending tool calls and return the accumulated response. */
  finish(fallbackModel = ''): LlmChatResponse {
    const calls = [...this.toolCalls].sort((a, b) => a.index - b.index);
    for (const call of calls) this.complete(call);
    const content: ContentPart[] = [];
    if (this.text.length > 0) content.push({ type: 'text', text: this.text });
    for (const call of calls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.args) });
    }
    return {
      message: { role: 'assistant', content },
      stopReason: fromOpenAiFinishReason(this.finishReason, calls.length > 0),
      usage: this.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: this.model || fallbackModel,
    };
  }
}

/** Convenience for tests: run a list of chunks through a reducer. */
export function reduceOpenAiStream(chunks: Iterable<ChatChunk>, handlers?: LlmStreamHandlers): LlmChatResponse {
  const reducer = new OpenAiStreamReducer(handlers);
  for (const chunk of chunks) reducer.push(chunk);
  return reducer.finish();
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createOpenAiClient(config: ProviderConfig): OpenAI {
  const options: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: config.apiKey || OPENAI_PLACEHOLDER_API_KEY,
  };
  if (config.baseUrl) options.baseURL = config.baseUrl;
  if (config.extraHeaders) options.defaultHeaders = config.extraHeaders;
  return new OpenAI(options);
}

/** Works with OpenAI, Ollama (`/v1`), LM Studio, OpenRouter and other compatible servers via `baseUrl`. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind: ProviderKind = 'openai-compatible';
  readonly id: ProviderId;
  readonly config: ProviderConfig;
  private readonly client: OpenAI;

  constructor(config: ProviderConfig, client?: OpenAI) {
    this.config = config;
    this.id = config.id;
    this.client = client ?? createOpenAiClient(config);
  }

  async chat(request: LlmChatRequest, handlers: LlmStreamHandlers = {}): Promise<LlmChatResponse> {
    const params = toOpenAiParams(request, this.config.supportsTools !== false, resolveSupportsVision(this.config));
    const reducer = new OpenAiStreamReducer(handlers);
    try {
      const stream = await this.client.chat.completions.create(params, { signal: request.signal ?? null });
      for await (const chunk of stream) reducer.push(chunk);
      if (request.signal?.aborted) throw new APIUserAbortError();
      return reducer.finish(request.model);
    } catch (err) {
      throw toProviderError(err, request.signal, err instanceof APIUserAbortError);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      for await (const m of this.client.models.list()) models.push({ id: m.id });
      return models;
    } catch {
      return [];
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: toProviderError(err).message };
    }
  }
}
