import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@rp/shared';
import { RpError } from '@rp/shared';
import { LlmHandler } from './llm.js';
import type { LlmHandlerOptions } from './llm.js';

function handler(config: ProviderConfig | Error, onChat?: () => void): LlmHandler {
  const settings = {
    resolveProvider: async () => {
      if (config instanceof Error) throw config;
      return config;
    },
  } as unknown as LlmHandlerOptions['settings'];
  return new LlmHandler({
    settings,
    providerFactory: () =>
      ({
        chat: async () => {
          onChat?.();
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'a desk with two monitors' }] }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' };
        },
      }) as never,
    timers: {} as never,
    sessions: { get: async () => undefined },
    chat: () => ({ queueImmediateWake: async () => undefined }) as never,
  });
}

describe('LlmHandler.describeImage configuration errors', () => {
  it('refuses providers configured without vision, naming the provider and Settings → Providers', async () => {
    let called = false;
    const h = handler({ id: 'local', kind: 'openai-compatible', label: 'Local llama', model: 'llama-3' }, () => (called = true));
    await expect(h.describeImage('s', 'AAAA')).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message:
        'The session\'s LLM provider "Local llama" (llama-3) is configured without vision support, so the screenshot cannot be described; the user can enable "supports vision" for it or pick a vision-capable model under Settings → Providers',
      details: { providerId: 'local', model: 'llama-3' },
    });
    expect(called).toBe(false);
  });

  it('describes with vision-capable, explicitly enabled and mock providers', async () => {
    for (const config of [
      { id: 'a', kind: 'anthropic', label: 'Anthropic', model: 'm' },
      { id: 'o', kind: 'openai-compatible', label: 'Open', model: 'm', supportsVision: true },
      { id: 'mock', kind: 'mock', label: 'Mock', model: 'm' },
    ] as ProviderConfig[]) {
      expect(await handler(config).describeImage('s', 'AAAA', 'what?')).toBe('a desk with two monitors');
    }
  });

  it('reports a missing provider as a configuration failure', async () => {
    const h = handler(new RpError('LLM_PROVIDER', 'No LLM provider configured. Add one in settings and choose a default.'));
    await expect(h.describeImage('s', 'AAAA')).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: 'Cannot describe the screenshot: No LLM provider configured. Add one in settings and choose a default. (Settings → Providers)',
    });
  });
});
