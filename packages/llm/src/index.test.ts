import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { LlmMessage, ProviderConfig } from '@rp/shared';
import {
  AnthropicProvider,
  IMAGE_OMITTED_TEXT,
  MockProvider,
  OpenAiCompatibleProvider,
  RUN_ACTION_TOOL,
  createProvider,
  resolveSupportsVision,
  stripImages,
  toProviderError,
} from './index.js';

describe('createProvider', () => {
  it('instantiates by kind without touching the network', () => {
    const base = { id: 'x', label: 'x', model: 'm' };
    expect(createProvider({ ...base, kind: 'mock' })).toBeInstanceOf(MockProvider);
    expect(createProvider({ ...base, kind: 'anthropic', apiKey: 'k' })).toBeInstanceOf(AnthropicProvider);
    // Local OpenAI-compatible server: no API key at all.
    const local = createProvider({ ...base, kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', extraHeaders: { 'X-Test': '1' } });
    expect(local).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(local.kind).toBe('openai-compatible');
    expect(local.id).toBe('x');
    expect(() => createProvider({ ...base, kind: 'nope' } as unknown as ProviderConfig)).toThrow(RpError);
  });

  it('exports the run_action tool', () => {
    expect(RUN_ACTION_TOOL.name).toBe('run_action');
  });
});

describe('toProviderError', () => {
  it('passes RpError through, maps AbortError-like and plain errors', () => {
    const rp = new RpError('LLM_PROVIDER', 'x');
    expect(toProviderError(rp)).toBe(rp);
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(toProviderError(abort).code).toBe('LLM_ABORTED');
    const plain = toProviderError(new Error('ECONNREFUSED'));
    expect(plain.code).toBe('LLM_PROVIDER');
    expect(plain.message).toBe('ECONNREFUSED');
    expect(plain.details).toEqual({});
    expect(toProviderError('weird').message).toBe('weird');
  });
});

describe('vision helpers', () => {
  it('defaults supportsVision to true for anthropic and false otherwise, unless set', () => {
    expect(resolveSupportsVision({ kind: 'anthropic' })).toBe(true);
    expect(resolveSupportsVision({ kind: 'openai-compatible' })).toBe(false);
    expect(resolveSupportsVision({ kind: 'mock' })).toBe(false);
    expect(resolveSupportsVision({ kind: 'anthropic', supportsVision: false })).toBe(false);
    expect(resolveSupportsVision({ kind: 'openai-compatible', supportsVision: true })).toBe(true);
  });

  it('stripImages replaces images only when vision is off and leaves other parts alone', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', mime: 'image/png', data: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'run_action', input: {} }] },
    ];
    expect(stripImages(msgs, true)).toBe(msgs);
    const stripped = stripImages(msgs, false);
    expect(stripped).not.toBe(msgs);
    expect(stripped[0]?.content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: IMAGE_OMITTED_TEXT }]);
    expect(stripped[1]).toEqual(msgs[1]);
    const noImages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }];
    expect(stripImages(noImages, false)).toBe(noImages);
  });
});
