import type { CapabilityCall, CodeRunRequest, CodeRunResult, CodeRunner, Json, RpErrorCode } from '@rp/shared';
import { RpError, serializeError } from '@rp/shared';

/** What a `FakeRunner` handler may return: a full/partial result, a plain JSON return value, or nothing. */
export type FakeRunOutcome = Partial<CodeRunResult> | Json | void;

export type FakeRunHandler = (request: CodeRunRequest, runner: FakeRunner) => Promise<FakeRunOutcome> | FakeRunOutcome;

const RESULT_KEYS = new Set(['ok', 'returnValue', 'error', 'logs', 'calls', 'durationMs', 'compiledCode']);

function isPartialResult(value: unknown): value is Partial<CodeRunResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((k) => RESULT_KEYS.has(k)) &&
    ('ok' in value || 'returnValue' in value || 'error' in value || 'logs' in value)
  );
}

/**
 * `CodeRunner` stand-in for tests and the desktop dev mode. It does not execute
 * the code; it hands every request to the `handler` you supply, which can
 * inspect `request.code` / `request.context` and call `runner.call(request, ...)`
 * to reach the host through the real invoker (permission checks and audit included).
 *
 * The handler may return a plain JSON value (becomes `returnValue`), a partial
 * `CodeRunResult` (merged), or nothing. A thrown error becomes a failed result.
 */
export class FakeRunner implements CodeRunner {
  /** Every request received, in order. */
  readonly requests: CodeRunRequest[] = [];
  disposed = false;
  private handler: FakeRunHandler;
  private readonly callRecords = new WeakMap<CodeRunRequest, CodeRunResult['calls']>();
  private callCounter = 0;

  constructor(handler?: FakeRunHandler) {
    this.handler = handler ?? (() => undefined);
  }

  /** Replace the handler for subsequent runs. */
  setHandler(handler: FakeRunHandler): void {
    this.handler = handler;
  }

  /**
   * Invoke `sdk.<module>.<method>(...args)` on behalf of the code under test,
   * exactly as the sandbox proxy would. Resolves with the value, or throws an
   * `RpError` carrying the returned error code.
   */
  async call(request: CodeRunRequest, module: string, method: string, ...args: Json[]): Promise<Json> {
    const allowed = request.surface.modules.find((m) => m.id === module);
    if (!allowed || !allowed.methods.includes(method)) {
      throw new RpError('CAPABILITY_UNKNOWN', `sdk.${module}.${method} is not on the surface of this run`);
    }
    const call: CapabilityCall = {
      callId: `fake_call_${++this.callCounter}`,
      module,
      method,
      args,
      context: request.context,
    };
    const started = Date.now();
    const result = await request.invoker.invoke(call);
    let records = this.callRecords.get(request);
    if (!records) {
      records = [];
      this.callRecords.set(request, records);
    }
    if (result.ok) {
      records.push({ callId: call.callId, module, method, args, ok: true, durationMs: Date.now() - started });
      return result.value;
    }
    records.push({ callId: call.callId, module, method, args, ok: false, error: result.error, durationMs: Date.now() - started });
    throw new RpError(result.error.code as RpErrorCode, result.error.message, result.error.details);
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.requests.push(request);
    this.callRecords.set(request, []);
    const started = Date.now();
    let outcome: FakeRunOutcome;
    try {
      outcome = await this.handler(request, this);
    } catch (err) {
      return {
        ok: false,
        error: serializeError(err instanceof RpError ? err : RpError.from(err, 'SANDBOX_RUNTIME')),
        logs: [],
        calls: this.callRecords.get(request) ?? [],
        durationMs: Date.now() - started,
      };
    }
    const calls = this.callRecords.get(request) ?? [];
    const base: CodeRunResult = { ok: true, returnValue: null, logs: [], calls, durationMs: Date.now() - started };
    if (outcome === undefined) return base;
    if (isPartialResult(outcome)) {
      return { ...base, ...outcome, calls: outcome.calls ?? calls, logs: outcome.logs ?? [] };
    }
    return { ...base, returnValue: outcome as Json };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
