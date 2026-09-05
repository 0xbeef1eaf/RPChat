import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { LlmChatRequest, ProviderConfig } from '@rp/shared';
import { MockProvider, chunkText } from './mock.js';

const config: ProviderConfig = { id: 'mock', kind: 'mock', label: 'Mock', model: 'mock-1' };
const request: LlmChatRequest = { model: 'mock-1', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };

describe('chunkText', () => {
  it('splits into at most n non-empty chunks that concatenate back', () => {
    expect(chunkText('', 3)).toEqual([]);
    expect(chunkText('ab', 3)).toEqual(['a', 'b']);
    const chunks = chunkText('Hello, world!', 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('Hello, world!');
  });
});

describe('MockProvider', () => {
  it('streams text in ~3 chunks then tool calls, in order, and resolves the full response', async () => {
    const provider = new MockProvider(config, {
      script: [{ text: 'Hello there!', toolCalls: [{ name: 'run_action', input: { purpose: 'p', code: 'return 1;' } }] }],
    });
    const events: string[] = [];
    const response = await provider.chat(request, {
      onTextDelta: (d) => events.push(`text:${d}`),
      onToolUseStart: (id, name) => events.push(`start:${id}:${name}`),
      onToolUse: (id, name, input) => events.push(`use:${id}:${name}:${JSON.stringify(input)}`),
    });
    expect(events).toEqual([
      'text:Hell',
      'text:o th',
      'text:ere!',
      'start:mock_tool_1:run_action',
      'use:mock_tool_1:run_action:{"purpose":"p","code":"return 1;"}',
    ]);
    expect(response.message).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello there!' },
        { type: 'tool_use', id: 'mock_tool_1', name: 'run_action', input: { purpose: 'p', code: 'return 1;' } },
      ],
    });
    expect(response.stopReason).toBe('tool_use');
    expect(response.model).toBe('mock-1');
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(provider.requests).toEqual([request]);
    expect(provider.responses).toEqual([response]);
  });

  it('consumes the script in order, honours stopReason, and errors when exhausted', async () => {
    const provider = new MockProvider(config, { script: [{ text: 'one' }, { text: 'two', stopReason: 'max_tokens' }] });
    expect((await provider.chat(request)).message.content).toEqual([{ type: 'text', text: 'one' }]);
    const second = await provider.chat(request);
    expect(second.message.content).toEqual([{ type: 'text', text: 'two' }]);
    expect(second.stopReason).toBe('max_tokens');
    expect(provider.remainingTurns).toBe(0);
    await expect(provider.chat(request)).rejects.toMatchObject({ code: 'LLM_PROVIDER' });
    expect(provider.requests).toHaveLength(3);
  });

  it('supports the respond function form', async () => {
    const provider = new MockProvider(config, {
      respond: (req) => ({ text: `echo: ${req.messages.at(-1)?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }),
    });
    const response = await provider.chat(request);
    expect(response.message.content).toEqual([{ type: 'text', text: 'echo: hello' }]);
    expect(response.stopReason).toBe('end');
  });

  it('replies with a default turn when unscripted', async () => {
    const provider = new MockProvider(config);
    const response = await provider.chat(request);
    expect(response.message.content[0]).toMatchObject({ type: 'text' });
  });

  it('aborts via signal, including during delayMs', async () => {
    const provider = new MockProvider(config, { script: [{ text: 'slow', delayMs: 10_000 }, { text: 'x' }] });
    const controller = new AbortController();
    const pending = provider.chat({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RpError);
    await expect(pending).rejects.toMatchObject({ code: 'LLM_ABORTED' });

    const already = new AbortController();
    already.abort();
    await expect(provider.chat({ ...request, signal: already.signal })).rejects.toMatchObject({ code: 'LLM_ABORTED' });
  });

  it('exposes listModels and test', async () => {
    const provider = new MockProvider(config);
    expect(await provider.listModels()).toEqual([{ id: 'mock-1', label: 'mock-1 (mock)' }]);
    expect((await provider.test()).ok).toBe(true);
  });
});
