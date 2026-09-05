import { RpError } from '@rp/shared';

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
