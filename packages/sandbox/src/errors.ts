import { RpError } from '@rp/shared';
import type { SerializedError } from '@rp/shared';

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
