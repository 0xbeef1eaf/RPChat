/** Stable error codes used across process and sandbox boundaries. */
export type RpErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_PROMPT_REJECTED'
  | 'CAPABILITY_UNKNOWN'
  | 'CAPABILITY_FAILED'
  | 'SANDBOX_TIMEOUT'
  | 'SANDBOX_MEMORY'
  | 'SANDBOX_CALL_BUDGET'
  | 'SANDBOX_COMPILE'
  | 'SANDBOX_RUNTIME'
  | 'PACK_INVALID'
  | 'PACK_CONFLICT'
  | 'PATH_ESCAPE'
  | 'LLM_PROVIDER'
  | 'LLM_ABORTED'
  | 'STORAGE'
  | 'INTERNAL';

export class RpError extends Error {
  readonly code: RpErrorCode;
  readonly details: unknown;

  constructor(code: RpErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RpError';
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message, details: toJsonSafe(this.details) };
  }

  static from(err: unknown, fallback: RpErrorCode = 'INTERNAL'): RpError {
    if (err instanceof RpError) return err;
    if (err instanceof Error) return new RpError(fallback, err.message, undefined, { cause: err });
    return new RpError(fallback, String(err));
  }
}

/** JSON-safe error representation that crosses IPC and sandbox boundaries. */
export interface SerializedError {
  code: RpErrorCode;
  message: string;
  details?: unknown;
  /** Present for sandbox runtime errors when available. */
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  const e = RpError.from(err);
  const out: SerializedError = e.toJSON();
  if (err instanceof Error && err.stack) out.stack = err.stack;
  return out;
}

function toJsonSafe(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}
