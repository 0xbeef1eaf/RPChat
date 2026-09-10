import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { RpError } from '@rp/shared';
import type { LlmChatRequest, LlmMessage, ProviderConfig } from '@rp/shared';
import { RUN_ACTION_TOOL } from '../actions.js';
import { IMAGE_OMITTED_TEXT } from './common.js';
import {
  AnthropicProvider,
  fromAnthropicMessage,
  fromAnthropicMessages,
  fromAnthropicStopReason,
  reduceAnthropicStream,
  toAnthropicMessages,
  toAnthropicParams,
  toAnthropicTools,
} from './anthropic.js';

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

const config: ProviderConfig = { id: 'p1', kind: 'anthropic', label: 'Anthropic', model: 'claude-test', apiKey: 'k' };

const transcript: LlmMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'toolu_1', content: '{"ok":true,"returnValue":1}' },
      { type: 'tool_result', toolUseId: 'toolu_1b', content: 'boom', isError: true },
      { type: 'text', text: 'and then?' },
    ],
  },
];

describe('anthropic message mapping', () => {
  it('maps parts to blocks and round-trips', () => {
    const params = toAnthropicMessages(transcript);
    expect(params).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true,"returnValue":1}' },
          { type: 'tool_result', tool_use_id: 'toolu_1b', content: 'boom', is_error: true },
          { type: 'text', text: 'and then?' },
        ],
      },
    ]);
    expect(fromAnthropicMessages(params)).toEqual(transcript);
  });

  it('drops empty text parts and empty messages', () => {
    expect(
      toAnthropicMessages([
        { role: 'user', content: [{ type: 'text', text: '' }] },
        { role: 'assistant', content: [] },
        { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'x' }] },
      ]),
    ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
  });

  it('maps tools and stop reasons', () => {
    const [tool] = toAnthropicTools([RUN_ACTION_TOOL]);
    expect(tool?.name).toBe('run_action');
    expect(tool?.input_schema.type).toBe('object');
    expect(tool?.input_schema.required).toEqual(['purpose', 'code']);
    expect(fromAnthropicStopReason('end_turn')).toBe('end');
    expect(fromAnthropicStopReason('tool_use')).toBe('tool_use');
    expect(fromAnthropicStopReason('max_tokens')).toBe('max_tokens');
    expect(fromAnthropicStopReason('stop_sequence')).toBe('end');
    expect(fromAnthropicStopReason(null)).toBe('end');
  });

  it('builds params honouring supportsTools, system and defaults', () => {
    const request: LlmChatRequest = { model: 'm', system: 'sys', messages: transcript, tools: [RUN_ACTION_TOOL], temperature: 0.7 };
    const withTools = toAnthropicParams(request, true);
    expect(withTools.tools).toHaveLength(1);
    expect(withTools.system).toBe('sys');
    expect(withTools.temperature).toBe(0.7);
    expect(withTools.max_tokens).toBeGreaterThan(0);
    const without = toAnthropicParams({ ...request, system: '', maxTokens: 12 }, false);
    expect(without.tools).toBeUndefined();
    expect(without.system).toBeUndefined();
    expect(without.max_tokens).toBe(12);
  });

  it('maps image parts to base64 image blocks and round-trips', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAAA' }] },
    ];
    const params = toAnthropicMessages(msgs);
    expect(params).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
    expect(fromAnthropicMessages(params)).toEqual(msgs);
  });

  it('keeps images by default (vision on) and replaces them when supportsVision is false', () => {
    const request: LlmChatRequest = {
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/jpeg', data: 'BBBB' }, { type: 'text', text: 'what is this?' }] }],
    };
    expect(toAnthropicParams(request, true).messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(toAnthropicParams(request, true, false).messages[0]?.content).toEqual([
      { type: 'text', text: IMAGE_OMITTED_TEXT },
      { type: 'text', text: 'what is this?' },
    ]);
    // the request itself is not mutated
    expect(request.messages[0]?.content[0]).toEqual({ type: 'image', mime: 'image/jpeg', data: 'BBBB' });
  });

  it('converts a response message, ignoring unknown block types', () => {
    const message = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'tool_use',
      stop_sequence: null,
      container: null,
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'ok', citations: null },
        { type: 'tool_use', id: 'toolu_9', name: 'run_action', input: { purpose: 'p', code: 'c' }, caller: { type: 'direct' } },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    } as unknown as Anthropic.Messages.Message;
    expect(fromAnthropicMessage(message)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_9', name: 'run_action', input: { purpose: 'p', code: 'c' } },
      ],
    });
  });
});

function syntheticEvents(): StreamEvent[] {
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      container: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  } as unknown as StreamEvent;
  return [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_action', input: {}, caller: { type: 'direct' } },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"purpose":"p",' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"code":"return 1;"}' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null },
      usage: {
        output_tokens: 42,
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        output_tokens_details: null,
      },
    },
    { type: 'message_stop' },
  ];
}

describe('AnthropicStreamReducer', () => {
  it('streams text and tool input in order and accumulates the response', () => {
    const calls: string[] = [];
    const response = reduceAnthropicStream(syntheticEvents(), {
      onTextDelta: (d) => calls.push(`text:${d}`),
      onToolUseStart: (id, name) => calls.push(`start:${id}:${name}`),
      onToolUse: (id, name, input) => calls.push(`use:${id}:${name}:${JSON.stringify(input)}`),
    });
    expect(calls).toEqual([
      'text:Hel',
      'text:lo',
      'start:toolu_1:run_action',
      'use:toolu_1:run_action:{"purpose":"p","code":"return 1;"}',
    ]);
    expect(response).toEqual({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'toolu_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
        ],
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 42 },
      model: 'claude-test',
    });
  });

  it('uses the initial input when no json deltas arrive', () => {
    const events: StreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'noop', input: { a: 1 }, caller: { type: 'direct' } },
      },
      { type: 'content_block_stop', index: 0 },
    ];
    const response = reduceAnthropicStream(events);
    expect(response.message.content).toEqual([{ type: 'tool_use', id: 'toolu_2', name: 'noop', input: { a: 1 } }]);
    expect(response.stopReason).toBe('end');
  });
});

/** Minimal stand-in for `client.messages.stream()`. */
function fakeClient(opts: { events?: StreamEvent[]; final?: Anthropic.Messages.Message; throws?: unknown }): {
  client: Anthropic;
  received: { params: unknown; options: unknown }[];
} {
  const received: { params: unknown; options: unknown }[] = [];
  const client = {
    messages: {
      stream(params: unknown, options: unknown) {
        received.push({ params, options });
        const events = opts.events ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) {
              if (opts.throws) throw opts.throws;
              yield e;
            }
          },
          async finalMessage() {
            if (opts.throws) throw opts.throws;
            return opts.final;
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, received };
}

describe('AnthropicProvider.chat (fake client)', () => {
  const request: LlmChatRequest = {
    model: 'claude-test',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [RUN_ACTION_TOOL],
  };

  it('streams through handlers and resolves with the final message', async () => {
    const final = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test-final',
      stop_reason: 'tool_use',
      stop_sequence: null,
      container: null,
      content: [
        { type: 'text', text: 'Hello', citations: null },
        { type: 'tool_use', id: 'toolu_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' }, caller: { type: 'direct' } },
      ],
      usage: { input_tokens: 10, output_tokens: 42 },
    } as unknown as Anthropic.Messages.Message;
    const { client, received } = fakeClient({ events: syntheticEvents(), final });
    const provider = new AnthropicProvider(config, client);
    const deltas: string[] = [];
    const tools: string[] = [];
    const response = await provider.chat(request, { onTextDelta: (d) => deltas.push(d), onToolUse: (id) => tools.push(id) });
    expect(deltas.join('')).toBe('Hello');
    expect(tools).toEqual(['toolu_1']);
    expect(response.model).toBe('claude-test-final');
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 42 });
    expect(response.message.content).toHaveLength(2);
    const sent = received[0]!.params as { tools?: unknown[]; system?: string };
    expect(sent.tools).toHaveLength(1);
    expect(sent.system).toBe('sys');
  });

  it('strips images at the provider level when config.supportsVision is false', async () => {
    const { client, received } = fakeClient({ throws: new Error('stop here') });
    const provider = new AnthropicProvider({ ...config, supportsVision: false }, client);
    const withImage: LlmChatRequest = {
      ...request,
      messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/webp', data: 'CCCC' }] }],
    };
    await expect(provider.chat(withImage)).rejects.toBeInstanceOf(RpError);
    const sent = received[0]!.params as { messages: { content: unknown[] }[] };
    expect(sent.messages[0]?.content).toEqual([{ type: 'text', text: IMAGE_OMITTED_TEXT }]);
  });

  it('omits tools when supportsTools is false', async () => {
    const { client, received } = fakeClient({ throws: new Error('stop here') });
    const provider = new AnthropicProvider({ ...config, supportsTools: false }, client);
    await expect(provider.chat(request)).rejects.toBeInstanceOf(RpError);
    expect((received[0]!.params as { tools?: unknown }).tools).toBeUndefined();
  });

  it('maps abort to LLM_ABORTED and API errors to LLM_PROVIDER with details', async () => {
    const aborted = new AnthropicProvider(config, fakeClient({ throws: new APIUserAbortError() }).client);
    await expect(aborted.chat(request)).rejects.toMatchObject({ code: 'LLM_ABORTED' });

    const controller = new AbortController();
    controller.abort();
    const viaSignal = new AnthropicProvider(config, fakeClient({ throws: new Error('fetch failed') }).client);
    await expect(viaSignal.chat({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'LLM_ABORTED' });

    const apiErr = new APIError(429, { type: 'rate_limit_error' }, 'Rate limited', undefined);
    const failing = new AnthropicProvider(config, fakeClient({ throws: apiErr }).client);
    const err = await failing.chat(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpError);
    expect((err as RpError).code).toBe('LLM_PROVIDER');
    expect((err as RpError).details).toEqual({ status: 429, body: { type: 'rate_limit_error' } });
  });
});

describe('prompt caching', () => {
  it('splits the system prompt at the stable prefix and marks the prefix cacheable', () => {
    const request: LlmChatRequest = { model: 'm', system: 'STABLE-PART\n\ndynamic', systemStablePrefixChars: 11, messages: transcript };
    const params = toAnthropicParams(request, true);
    expect(params.system).toEqual([
      { type: 'text', text: 'STABLE-PART', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\ndynamic' },
    ]);
    expect(toAnthropicParams({ ...request, systemStablePrefixChars: undefined }, true).system).toBe('STABLE-PART\n\ndynamic');
    expect(toAnthropicParams({ ...request, systemStablePrefixChars: 999 }, true).system).toBe('STABLE-PART\n\ndynamic');
  });
});
