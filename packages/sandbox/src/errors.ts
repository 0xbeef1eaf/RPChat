import { RpError } from '@rp/shared';
import type { SerializedError } from '@rp/shared';
import type { SourceMapper } from './sourcemap.js';
import { codeFrame, mapStack } from './stack.js';

/** Why a run was cut short by the host. */
export type TerminationKind = 'timeout' | 'cpu' | 'aborted' | 'host-call-timeout';

export interface TerminationState {
  termination?: TerminationKind;
  /** Extra text for the timeout message (e.g. the host call that stalled). */
  terminationDetail?: string;
  /** The host refused a call because `maxHostCalls` was reached. */
  budgetExceeded?: boolean;
}

export interface TerminationLimits {
  timeoutMs: number;
  cpuMs: number;
  hostCallTimeoutMs: number;
}

/** What `context.dump()` gives us for a thrown value (Error objects become plain records). */
export interface IsolateErrorInfo {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: unknown;
  /** The raw dumped value when it was not an Error object. */
  raw?: unknown;
}

const MAX_MESSAGE_CHARS = 4096;

/** Normalise a dumped isolate value into name/message/stack/code. */
export function describeIsolateError(dumped: unknown): IsolateErrorInfo {
  if (dumped && typeof dumped === 'object' && !Array.isArray(dumped)) {
    const rec = dumped as Record<string, unknown>;
    if (typeof rec['message'] === 'string') {
      const info: IsolateErrorInfo = {
        name: typeof rec['name'] === 'string' ? rec['name'] : 'Error',
        message: rec['message'],
      };
      if (typeof rec['stack'] === 'string') info.stack = rec['stack'];
      if (typeof rec['code'] === 'string') info.code = rec['code'];
      if (rec['details'] !== undefined) info.details = rec['details'];
      return info;
    }
  }
  let text: string;
  try {
    text = typeof dumped === 'string' ? dumped : JSON.stringify(dumped) ?? String(dumped);
  } catch {
    text = String(dumped);
  }
  return { name: 'Error', message: `non-Error value thrown: ${text}`, raw: dumped };
}

export function timeoutError(state: TerminationState, limits: TerminationLimits): SerializedError {
  switch (state.termination) {
    case 'cpu':
      return { code: 'SANDBOX_TIMEOUT', message: `run exceeded its CPU budget of ${limits.cpuMs} ms` };
    case 'timeout':
      return { code: 'SANDBOX_TIMEOUT', message: `run exceeded its time limit of ${limits.timeoutMs} ms` };
    case 'host-call-timeout':
      return {
        code: 'SANDBOX_TIMEOUT',
        message: `host call ${state.terminationDetail ?? ''} did not complete within ${limits.hostCallTimeoutMs} ms`.replace(
          '  ',
          ' ',
        ),
      };
    case 'aborted':
    default:
      return { code: 'SANDBOX_TIMEOUT', message: 'run aborted' };
  }
}

/**
 * Map an error thrown inside the isolate (already dumped to a host value) to a
 * `SerializedError`, taking into account why the host may have interrupted it.
 */
export function mapIsolateError(dumped: unknown, state: TerminationState, limits: TerminationLimits): SerializedError {
  if (state.termination) return timeoutError(state, limits);

  const info = describeIsolateError(dumped);
  const message = info.message.length > MAX_MESSAGE_CHARS ? `${info.message.slice(0, MAX_MESSAGE_CHARS)}…` : info.message;
  const stack = info.stack !== undefined ? `${info.name}: ${message}\n${info.stack}` : undefined;

  if (info.name === 'InternalError') {
    if (/interrupted/i.test(message)) {
      return { code: 'SANDBOX_TIMEOUT', message: 'run interrupted', stack };
    }
    if (/out of memory/i.test(message)) {
      return { code: 'SANDBOX_MEMORY', message: 'isolate ran out of memory', stack };
    }
  }
  if (/out of memory/i.test(message)) {
    return { code: 'SANDBOX_MEMORY', message: 'isolate ran out of memory', stack };
  }

  if (info.code === 'SANDBOX_CALL_BUDGET' && state.budgetExceeded) {
    return { code: 'SANDBOX_CALL_BUDGET', message, stack, details: info.details };
  }

  const details: Record<string, unknown> = { name: info.name };
  if (info.code !== undefined) details['code'] = info.code;
  if (info.details !== undefined) details['details'] = info.details;
  if (info.raw !== undefined) details['thrown'] = info.raw;
  return {
    code: 'SANDBOX_RUNTIME',
    message: info.name === 'Error' || info.name === '' ? message : `${info.name}: ${message}`,
    stack,
    details,
  };
}

/**
 * Map an exception that escaped from the WebAssembly module itself (the host
 * JavaScript stack overflowed, or the module trapped/aborted). After such an
 * error the module is unusable and is replaced by the runner.
 */
export function mapHostCrash(err: unknown): SerializedError {
  if (err instanceof RpError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RangeError || /call stack/i.test(message)) {
    return { code: 'SANDBOX_RUNTIME', message: 'stack overflow (host stack exhausted)', details: { host: message } };
  }
  if (/out of memory|memory access out of bounds/i.test(message)) {
    return { code: 'SANDBOX_MEMORY', message: 'isolate crashed: out of memory', details: { host: message } };
  }
  return { code: 'INTERNAL', message: `isolate crashed: ${message}`, details: { host: message } };
}

/**
 * Point a failure at the model's own code: the stack is mapped back through the
 * source map, and the failing line is quoted with a caret. Compile errors have
 * no isolate stack but do carry a position, so they get the same treatment; the
 * host stack of the `RpError` the transpiler threw is dropped — host paths are
 * noise the model cannot act on.
 */
export function withSourceContext(error: SerializedError, source: string, mapper?: SourceMapper): SerializedError {
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? { ...(error.details as Record<string, unknown>) } : undefined;
  const mapped = mapStack(error.stack, mapper, source.split('\n').length);
  let at = mapped.at;
  if (!at && details && typeof details['line'] === 'number') {
    const column = typeof details['column'] === 'number' ? details['column'] : 1;
    at = { line: details['line'], column };
  }
  const out: SerializedError = { code: error.code, message: error.message };
  if (mapped.stack.length > 0) out.stack = mapped.stack;
  const extra: Record<string, unknown> = { ...(details ?? {}) };
  if (at) {
    extra['line'] = at.line;
    extra['column'] = at.column;
    const frame = codeFrame(source, at);
    if (frame !== undefined) extra['frame'] = frame;
  }
  if (Object.keys(extra).length > 0) out.details = extra;
  else if (error.details !== undefined) out.details = error.details;
  return out;
}
