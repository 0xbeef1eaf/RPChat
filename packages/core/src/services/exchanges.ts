import { randomUUID } from 'node:crypto';
import type { LlmChatRequest, LlmChatResponse, ModelExchange, ProviderConfig } from '@rp/shared';
import { serializeError } from '@rp/shared';
import type { Clock, EngineEmitter } from '../types.js';

/** Where a provider call comes from, for the `model-exchange` record. */
export interface ExchangeMeta {
  sessionId: string;
  kind: ModelExchange['kind'];
  /** Provider config label (or id). */
  provider: string;
  turnId?: string;
  messageId?: string;
  round?: number;
}

/** Name used for a provider in `model-exchange` records: its label, or its id when unlabelled. */
export function providerLabel(config: Pick<ProviderConfig, 'id' | 'label'>): string {
  return config.label && config.label.trim().length > 0 ? config.label : config.id;
}

/** Deep copy of the parts of a request that later code may mutate (system, messages, tools). */
export function snapshotRequest(provider: string, request: LlmChatRequest): ModelExchange['request'] {
  const out: ModelExchange['request'] = {
    provider,
    model: request.model,
    system: request.system,
    messages: structuredClone(request.messages),
  };
  if (request.systemStablePrefixChars !== undefined) out.systemStablePrefixChars = request.systemStablePrefixChars;
  if (request.tools) out.tools = structuredClone(request.tools);
  if (request.temperature !== undefined) out.temperature = request.temperature;
  if (request.maxTokens !== undefined) out.maxTokens = request.maxTokens;
  return out;
}

/**
 * Run one provider call and emit exactly one `model-exchange` chat event for it: the request
 * snapshot plus the response on success or the serialized error on failure (the error is
 * rethrown). Callers check `settings.debug.showModelTraffic` first; when it is off they call the
 * provider directly so nothing is copied.
 */
export async function recordExchange(
  emitter: EngineEmitter,
  now: Clock,
  meta: ExchangeMeta,
  request: LlmChatRequest,
  call: () => Promise<LlmChatResponse>,
): Promise<LlmChatResponse> {
  const started = now();
  const exchange: ModelExchange = {
    id: randomUUID(),
    sessionId: meta.sessionId,
    kind: meta.kind,
    startedAt: started.toISOString(),
    request: snapshotRequest(meta.provider, request),
  };
  if (meta.turnId !== undefined) exchange.turnId = meta.turnId;
  if (meta.messageId !== undefined) exchange.messageId = meta.messageId;
  if (meta.round !== undefined) exchange.round = meta.round;
  try {
    const response = await call();
    exchange.response = { message: structuredClone(response.message), stopReason: response.stopReason, usage: { ...response.usage }, model: response.model };
    return response;
  } catch (err) {
    exchange.error = serializeError(err);
    throw err;
  } finally {
    exchange.durationMs = Math.max(0, now().getTime() - started.getTime());
    emitter.emit('chat', { type: 'model-exchange', sessionId: meta.sessionId, exchange });
  }
}
