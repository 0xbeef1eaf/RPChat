import { RpError } from '@rp/shared';
import type { ContentPart, LlmMessage } from '@rp/shared';

/** Duck-typed view of the SDKs' `APIError` (both SDKs share this shape). */
interface ApiErrorLike {
  status?: number | undefined;
  error?: unknown;
  message?: string;
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * Convert an SDK/network error into an `RpError`.
 * `LLM_ABORTED` when the request was cancelled (via `signal` or the SDK's abort error),
 * otherwise `LLM_PROVIDER` with `{ status, body }` details when available.
 */
export function toProviderError(err: unknown, signal?: AbortSignal, isAbortError = false): RpError {
  if (err instanceof RpError) return err;
  if (isAbortError || signal?.aborted || isAbortLike(err)) {
    return new RpError('LLM_ABORTED', 'LLM request aborted', undefined, { cause: err });
  }
  const e = (typeof err === 'object' && err !== null ? err : {}) as ApiErrorLike;
  const message = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : String(err);
  const details: { status?: number; body?: unknown } = {};
  if (typeof e.status === 'number') details.status = e.status;
  if (e.error !== undefined) details.body = e.error;
  return new RpError('LLM_PROVIDER', message, details, { cause: err });
}

/** Parse a tool-call argument string; empty → `{}`, invalid JSON → the raw string. */
export function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return json;
  }
}

/** Stringify a tool input for transport; non-serialisable values become `{}`. */
export function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

/** Text substituted for an image part when the configured model has no vision. */
export const IMAGE_OMITTED_TEXT = '[image omitted: model has no vision]';

/** Resolve `supportsVision` for a provider kind: Anthropic defaults to true, everything else to false. */
export function resolveSupportsVision(config: { kind: string; supportsVision?: boolean }): boolean {
  return config.supportsVision ?? config.kind === 'anthropic';
}

/**
 * When `supportsVision` is false, replace every `image` part with the
 * `[image omitted: model has no vision]` text part. Returns the input untouched
 * (same array) when nothing needs replacing.
 */
export function stripImages(messages: LlmMessage[], supportsVision: boolean): LlmMessage[] {
  if (supportsVision || !messages.some((m) => m.content.some((p) => p.type === 'image'))) return messages;
  return messages.map((m) => ({
    ...m,
    content: m.content.map((p): ContentPart => (p.type === 'image' ? { type: 'text', text: IMAGE_OMITTED_TEXT } : p)),
  }));
}
