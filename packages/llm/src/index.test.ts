import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { ProviderConfig } from '@rp/shared';
import { AnthropicProvider, MockProvider, OpenAiCompatibleProvider, RUN_ACTION_TOOL, createProvider, toProviderError } from './index.js';

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
