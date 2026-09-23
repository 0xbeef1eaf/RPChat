import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { APIError, APIUserAbortError } from 'openai';
import { RpError } from '@rp/shared';
import type { LlmChatRequest, LlmMessage, ProviderConfig } from '@rp/shared';
import { RUN_ACTION_TOOL } from '../actions.js';
import { IMAGE_OMITTED_TEXT } from './common.js';
import {
  OpenAiCompatibleProvider,
  fromDataUrl,
  fromOpenAiFinishReason,
  fromOpenAiMessage,
  fromOpenAiMessages,
  reduceOpenAiStream,
  toDataUrl,
  toOpenAiMessages,
  toOpenAiParams,
  toOpenAiTools,
} from './openai-compatible.js';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChunkDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice['delta'];
type ChunkFinish = OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'];

const config: ProviderConfig = { id: 'p2', kind: 'openai-compatible', label: 'Local', model: 'llama', baseUrl: 'http://localhost:11434/v1' };

const transcript: LlmMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
      { type: 'tool_use', id: 'call_2', name: 'run_action', input: { purpose: 'q', code: 'return 2;' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'call_1', content: '{"ok":true}' },
      { type: 'tool_result', toolUseId: 'call_2', content: '{"ok":false}' },
      { type: 'text', text: 'and then?' },
    ],
  },
];

describe('openai message mapping', () => {
  it('maps tool_use to tool_calls and tool_results to separate tool messages, and round-trips', () => {
    const params = toOpenAiMessages('sys', transcript);
    expect(params).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'run_action', arguments: '{"purpose":"p","code":"return 1;"}' } },
          { id: 'call_2', type: 'function', function: { name: 'run_action', arguments: '{"purpose":"q","code":"return 2;"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"ok":false}' },
      { role: 'user', content: 'and then?' },
    ]);
    expect(fromOpenAiMessages(params)).toEqual({ system: 'sys', messages: transcript });
  });

  it('omits the system message when empty and uses null content for tool-only assistant turns', () => {
    const params = toOpenAiMessages('', [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'run_action', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c', content: 'r' }] },
    ]);
    expect(params[0]).toMatchObject({ role: 'assistant', content: null });
    expect(params[1]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'r' });
  });

  it('maps image parts to image_url data URLs in a content-parts array and round-trips', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAAA' }] },
    ];
    const params = toOpenAiMessages('', msgs);
    expect(params).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    expect(fromOpenAiMessages(params)).toEqual({ system: '', messages: msgs });
    expect(toDataUrl('image/gif', 'Zz==')).toBe('data:image/gif;base64,Zz==');
    expect(fromDataUrl('data:image/webp;base64,Q1==')).toEqual({ type: 'image', mime: 'image/webp', data: 'Q1==' });
    expect(fromDataUrl('https://example.com/a.png')).toBeNull();
    // text-only user messages stay plain strings
    expect(toOpenAiMessages('', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('replaces images by default (no vision) and keeps them when supportsVision is true', () => {
    const request: LlmChatRequest = {
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/jpeg', data: 'BBBB' }, { type: 'text', text: 'what is this?' }] }],
    };
    expect(toOpenAiParams(request, true).messages[0]).toEqual({ role: 'user', content: `${IMAGE_OMITTED_TEXT}what is this?` });
    expect(toOpenAiParams(request, true, true).messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
        { type: 'text', text: 'what is this?' },
      ],
    });
  });

  it('maps tools, finish reasons and non-streaming messages', () => {
    expect(toOpenAiTools([RUN_ACTION_TOOL])).toEqual([
      { type: 'function', function: { name: 'run_action', description: RUN_ACTION_TOOL.description, parameters: RUN_ACTION_TOOL.inputSchema } },
    ]);
    expect(fromOpenAiFinishReason('stop')).toBe('end');
    expect(fromOpenAiFinishReason('length')).toBe('max_tokens');
    expect(fromOpenAiFinishReason('tool_calls')).toBe('tool_use');
    expect(fromOpenAiFinishReason('stop', true)).toBe('tool_use');
    expect(fromOpenAiFinishReason(null)).toBe('end');
    expect(
      fromOpenAiMessage({
        role: 'assistant',
        content: 'x',
        refusal: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_action', arguments: '{"code":"1"}' } }],
      }),
    ).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 'c1', name: 'run_action', input: { code: '1' } },
      ],
    });
  });

  it('builds streaming params with usage and honours supportsTools', () => {
    const request: LlmChatRequest = { model: 'm', system: 's', messages: transcript, tools: [RUN_ACTION_TOOL], maxTokens: 50, temperature: 0.2 };
    const p = toOpenAiParams(request, true);
    expect(p.stream).toBe(true);
    expect(p.stream_options).toEqual({ include_usage: true });
    expect(p.tools).toHaveLength(1);
    expect(p.max_tokens).toBe(50);
    expect(p.temperature).toBe(0.2);
    expect(toOpenAiParams(request, false).tools).toBeUndefined();
    expect(toOpenAiParams(request, true).response_format).toBeUndefined();
  });

  it('sends a response format only when the request asks for one', () => {
    const base: LlmChatRequest = { model: 'm', system: 's', messages: transcript };
    expect(toOpenAiParams({ ...base, responseFormat: { type: 'json_object' } }, true).response_format).toEqual({ type: 'json_object' });
    const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
    expect(toOpenAiParams({ ...base, responseFormat: { type: 'json_schema', name: 'media_tags', schema } }, true).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'media_tags', strict: true, schema },
    });
  });

  it('passes the reasoning effort through, including the Ollama-only levels', () => {
    const base: LlmChatRequest = { model: 'm', system: 's', messages: transcript };
    expect(toOpenAiParams(base, true).reasoning_effort).toBeUndefined();
    expect(toOpenAiParams({ ...base, reasoningEffort: 'none' }, true).reasoning_effort).toBe('none');
    expect(toOpenAiParams({ ...base, reasoningEffort: 'high' }, true).reasoning_effort).toBe('high');
  });
});

function chunk(delta: ChunkDelta, finish: ChunkFinish = null, usage?: Chunk['usage']): Chunk {
  const c: Chunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'llama',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage !== undefined) c.usage = usage;
  return c;
}

function syntheticChunks(): Chunk[] {
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'run_action', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"purpose":"p",' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"code":"return 1;"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'run_action', arguments: '{"purpose":"q","code":"return 2;"}' } }] }),
    chunk({}, 'tool_calls'),
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'llama', choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } },
  ];
}

describe('OpenAiStreamReducer', () => {
  it('streams text and tool calls in order and accumulates the response', () => {
    const calls: string[] = [];
    const response = reduceOpenAiStream(syntheticChunks(), {
      onTextDelta: (d) => calls.push(`text:${d}`),
      onToolUseStart: (id, name) => calls.push(`start:${id}:${name}`),
      onToolUse: (id, name, input) => calls.push(`use:${id}:${name}:${JSON.stringify(input)}`),
    });
    expect(calls).toEqual([
      'text:Hel',
      'text:lo',
      'start:call_a:run_action',
      'use:call_a:run_action:{"purpose":"p","code":"return 1;"}',
      'start:call_b:run_action',
      'use:call_b:run_action:{"purpose":"q","code":"return 2;"}',
    ]);
    expect(response).toEqual({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'call_a', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
          { type: 'tool_use', id: 'call_b', name: 'run_action', input: { purpose: 'q', code: 'return 2;' } },
        ],
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 7, outputTokens: 9 },
      model: 'llama',
    });
  });

  it('handles servers that omit ids, report stop instead of tool_calls, and send no usage', () => {
    const chunks: Chunk[] = [
      chunk({ tool_calls: [{ index: 0, function: { name: 'run_action', arguments: '{}' } }] }),
      chunk({}, 'stop'),
    ];
    const ids: string[] = [];
    const response = reduceOpenAiStream(chunks, { onToolUseStart: (id) => ids.push(id) });
    expect(ids).toHaveLength(1);
    expect(response.message.content).toEqual([{ type: 'tool_use', id: ids[0], name: 'run_action', input: {} }]);
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('maps length to max_tokens and keeps invalid JSON arguments as raw text', () => {
    const chunks: Chunk[] = [
      chunk({ content: 'trunc' }, 'length'),
    ];
    expect(reduceOpenAiStream(chunks).stopReason).toBe('max_tokens');
    const bad: Chunk[] = [chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'run_action', arguments: '{not json' } }] }, 'tool_calls')];
    expect(reduceOpenAiStream(bad).message.content).toEqual([{ type: 'tool_use', id: 'x', name: 'run_action', input: '{not json' }]);
  });
});

function fakeClient(opts: { chunks?: Chunk[]; throws?: unknown }): { client: OpenAI; received: { params: unknown; options: unknown }[] } {
  const received: { params: unknown; options: unknown }[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: unknown, options: unknown) {
          received.push({ params, options });
          if (opts.throws) throw opts.throws;
          const chunks = opts.chunks ?? [];
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, received };
}

describe('OpenAiCompatibleProvider.chat (fake client)', () => {
  const request: LlmChatRequest = {
    model: 'llama',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [RUN_ACTION_TOOL],
  };

  it('streams and resolves with the accumulated response, forwarding the signal', async () => {
    const { client, received } = fakeClient({ chunks: syntheticChunks() });
    const provider = new OpenAiCompatibleProvider(config, client);
    const controller = new AbortController();
    const deltas: string[] = [];
    const response = await provider.chat({ ...request, signal: controller.signal }, { onTextDelta: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('Hello');
    expect(response.stopReason).toBe('tool_use');
    expect(response.message.content).toHaveLength(3);
    expect((received[0]!.options as { signal: AbortSignal }).signal).toBe(controller.signal);
    const sent = received[0]!.params as { tools?: unknown[]; stream: boolean; messages: unknown[] };
    expect(sent.stream).toBe(true);
    expect(sent.tools).toHaveLength(1);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('applies config.reasoningEffort, and lets the request override it', async () => {
    const { client, received } = fakeClient({ chunks: [chunk({ content: 'x' }, 'stop')] });
    const provider = new OpenAiCompatibleProvider({ ...config, reasoningEffort: 'none' }, client);
    await provider.chat(request);
    expect((received[0]!.params as { reasoning_effort?: string }).reasoning_effort).toBe('none');

    await provider.chat({ ...request, reasoningEffort: 'high' });
    expect((received[1]!.params as { reasoning_effort?: string }).reasoning_effort).toBe('high');
  });

  it('honours config.supportsVision at the provider level', async () => {
    const withImage: LlmChatRequest = {
      ...request,
      messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'DDDD' }] }],
    };
    const blind = fakeClient({ chunks: [chunk({ content: 'x' }, 'stop')] });
    await new OpenAiCompatibleProvider(config, blind.client).chat(withImage);
    expect((blind.received[0]!.params as { messages: unknown[] }).messages[1]).toEqual({ role: 'user', content: IMAGE_OMITTED_TEXT });

    const sighted = fakeClient({ chunks: [chunk({ content: 'x' }, 'stop')] });
    await new OpenAiCompatibleProvider({ ...config, supportsVision: true }, sighted.client).chat(withImage);
    expect((sighted.received[0]!.params as { messages: unknown[] }).messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,DDDD' } }],
    });
  });

  it('omits tools when supportsTools is false', async () => {
    const { client, received } = fakeClient({ chunks: [chunk({ content: 'x' }, 'stop')] });
    const provider = new OpenAiCompatibleProvider({ ...config, supportsTools: false }, client);
    const response = await provider.chat(request);
    expect(response.message.content).toEqual([{ type: 'text', text: 'x' }]);
    expect(response.stopReason).toBe('end');
    expect((received[0]!.params as { tools?: unknown }).tools).toBeUndefined();
  });

  it('maps abort to LLM_ABORTED and API errors to LLM_PROVIDER', async () => {
    const aborted = new OpenAiCompatibleProvider(config, fakeClient({ throws: new APIUserAbortError() }).client);
    await expect(aborted.chat(request)).rejects.toMatchObject({ code: 'LLM_ABORTED' });

    const apiErr = new APIError(401, { error: { message: 'bad key' } }, 'Unauthorized', undefined);
    const failing = new OpenAiCompatibleProvider(config, fakeClient({ throws: apiErr }).client);
    const err = await failing.chat(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpError);
    expect((err as RpError).code).toBe('LLM_PROVIDER');
    expect((err as RpError).details).toMatchObject({ status: 401 });
  });
});
