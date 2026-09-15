import { RpError } from '@rp/shared';
import type { LlmProvider, ProviderConfig } from '@rp/shared';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';

export { AnthropicProvider, MockProvider, OpenAiCompatibleProvider };
export type { MockProviderOptions, MockToolCall, MockTurn } from './providers/mock.js';
export { chunkText } from './providers/mock.js';
export {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  AnthropicStreamReducer,
  createAnthropicClient,
  fromAnthropicMessage,
  fromAnthropicMessages,
  fromAnthropicStopReason,
  reduceAnthropicStream,
  toAnthropicMessages,
  toAnthropicParams,
  toAnthropicTools,
} from './providers/anthropic.js';
export {
  OPENAI_PLACEHOLDER_API_KEY,
  OpenAiStreamReducer,
  createOpenAiClient,
  fromDataUrl,
  fromOpenAiFinishReason,
  fromOpenAiMessage,
  fromOpenAiMessages,
  reduceOpenAiStream,
  toDataUrl,
  toOpenAiMessages,
  toOpenAiParams,
  toOpenAiTools,
} from './providers/openai-compatible.js';
export {
  IMAGE_OMITTED_TEXT,
  parseToolInput,
  resolveSupportsVision,
  stringifyToolInput,
  stripImages,
  toProviderError,
} from './providers/common.js';
export { estimateMessageTokens, estimateTokens, groupToolPairs, windowMessages } from './tokens.js';
export { stripCodeComments } from './comments.js';
export { RUN_ACTION_TOOL, extractFencedActions, stripFencedActions } from './actions.js';
export type { FencedAction } from './actions.js';

/** Instantiate the provider implementation for `config.kind`. */
export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(config);
    case 'mock':
      return new MockProvider(config);
    default:
      throw new RpError('INVALID_ARGUMENT', `Unknown provider kind: ${String((config as { kind: unknown }).kind)}`);
  }
}
