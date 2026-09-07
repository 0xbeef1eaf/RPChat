import { randomUUID } from 'node:crypto';
import { newQuickJSAsyncWASMModule, Scope } from 'quickjs-emscripten';
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
  QuickJSDeferredPromise,
  QuickJSHandle,
} from 'quickjs-emscripten';
import { DEFAULT_RUN_LIMITS, RpError, serializeError } from '@rp/shared';
import type {
  CallRecord,
  CapabilityResult,
  CodeRunRequest,
  CodeRunResult,
  CodeRunner,
  Json,
  LogEntry,
  LogLevel,
  RunLimits,
  SdkSurface,
  SerializedError,
} from '@rp/shared';
import { BOOTSTRAP_SOURCE, RESULT_SERIALISER_SUFFIX } from './bootstrap.js';
import { ENTRY_FUNCTION_NAME, transpile, wrapAsAsyncFunctionBody } from './transpile.js';
import { mapHostCrash, mapIsolateError, timeoutError } from './errors.js';
import type { TerminationKind, TerminationLimits, TerminationState } from './errors.js';

export interface QuickJsRunnerOptions {
  /** Defaults applied under `request.limits`. */
  limits?: Partial<RunLimits>;
  /**
   * Hard cap on a single host capability call (e.g. a `ui.confirm` dialog the
   * user never answers). Not part of `RunLimits` because it is a safety net,
   * not a budget: `timeoutMs`/`cpuMs` deliberately exclude time spent waiting
   * for host calls. Default 10 minutes.
   */
  hostCallTimeoutMs?: number;
  /**
   * QuickJS stack limit in bytes. Kept small (default 64 KiB) so that QuickJS's
   * own "stack overflow" check fires before the host's native stack does; a
   * native overflow escapes the wasm module and forces it to be replaced.
   */
  maxStackBytes?: number;
  /** Reserved; ES module loading is intentionally unsupported. */
  moduleLoader?: undefined;
}

export const DEFAULT_HOST_CALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_STACK_BYTES = 64 * 1024;

/**
 * The single cached WebAssembly module. When an exception escapes the module
 * (host stack overflow, wasm trap, emscripten abort) its internal state is no
 * longer trustworthy, so the slot is poisoned and the next run creates a fresh
 * module; the old one is simply dropped for the GC.
 */
interface ModuleSlot {
  module: Promise<QuickJSAsyncWASMModule>;
  poisoned: boolean;
}

let currentSlot: ModuleSlot | undefined;

function acquireModuleSlot(): ModuleSlot {
  if (!currentSlot || currentSlot.poisoned) {
    currentSlot = { module: newQuickJSAsyncWASMModule(), poisoned: false };
  }
  return currentSlot;
}

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const TRUNCATED_MARKER = '…[truncated]';

/**
 * Executes character code in a QuickJS WebAssembly isolate.
 *
 * One runtime per runner (reused across runs), one fresh context per run.
 * Runs on the same runner are serialised.
 */
export class QuickJsRunner implements CodeRunner {
  private readonly options: QuickJsRunnerOptions;
  private slot: ModuleSlot | undefined;
  private runtime: QuickJSAsyncRuntime | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: QuickJsRunnerOptions = {}) {
    this.options = options;
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new RpError('INTERNAL', 'QuickJsRunner has been disposed');
    const started = performance.now();
    const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...this.options.limits, ...request.limits };
    const hostCallTimeoutMs = this.options.hostCallTimeoutMs ?? DEFAULT_HOST_CALL_TIMEOUT_MS;

    let compiledCode: string;
    try {
      compiledCode = transpile(request.code, request.language).js;
    } catch (err) {
      return {
        ok: false,
        error: serializeError(err),
        logs: [],
        calls: [],
        durationMs: elapsed(started),
      };
    }

    return this.withLock(async () => {
      if (this.disposed) throw new RpError('INTERNAL', 'QuickJsRunner has been disposed');
      const baseResult = { logs: [] as LogEntry[], calls: [] as CallRecord[], compiledCode };
      if (request.signal?.aborted) {
        return {
          ok: false,
          error: timeoutError({ termination: 'aborted' }, { ...limits, hostCallTimeoutMs }),
          ...baseResult,
          durationMs: elapsed(started),
        };
      }

      const slot = acquireModuleSlot();
      const runtime = await this.getRuntime(slot);
      const session = new RunSession(runtime, request, limits, hostCallTimeoutMs);
      let outcome: Outcome;
      try {
        outcome = await session.execute(compiledCode);
      } finally {
        if (session.crashed === undefined) session.cleanup();
        if (session.crashed !== undefined) {
          // The wasm module is in an undefined state: do not touch it again.
          slot.poisoned = true;
          this.runtime = undefined;
        }
      }

      const result: CodeRunResult = {
        ok: outcome.ok,
        logs: session.logs,
        calls: session.calls,
        durationMs: elapsed(started),
        compiledCode,
      };
      if (outcome.ok) result.returnValue = outcome.value;
      else result.error = outcome.error;
      return result;
    });
  }

  async dispose(): Promise<void> {
    await this.withLock(async () => {
      this.disposed = true;
      const runtime = this.runtime;
      const slot = this.slot;
      this.runtime = undefined;
      this.slot = undefined;
      if (runtime && slot && !slot.poisoned && runtime.alive) {
        try {
          runtime.dispose();
        } catch {
          // QuickJS asserts when objects leaked; the module is unusable from here on.
          slot.poisoned = true;
        }
      }
    });
  }

  private async getRuntime(slot: ModuleSlot): Promise<QuickJSAsyncRuntime> {
    if (this.runtime && this.slot === slot && !slot.poisoned && this.runtime.alive) return this.runtime;
    if (this.runtime && this.slot && !this.slot.poisoned && this.runtime.alive) {
      try {
        this.runtime.dispose();
      } catch {
        this.slot.poisoned = true;
      }
    }
    this.runtime = undefined;
    const module = await slot.module;
    const runtime = module.newRuntime();
    runtime.setMaxStackSize(this.options.maxStackBytes ?? DEFAULT_MAX_STACK_BYTES);
    this.runtime = runtime;
    this.slot = slot;
    return runtime;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

type Outcome = { ok: true; value: Json } | { ok: false; error: SerializedError };

interface PendingHostCall {
  deferred: QuickJSDeferredPromise;
  module: string;
  method: string;
  args: Json[];
}

/** Thrown internally when an exception escapes the wasm module. */
class IsolateCrash extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('isolate crashed');
    this.name = 'IsolateCrash';
    this.cause = cause;
  }
}

/**
 * Tracks how much of the run the isolate actually spent running. Time between
 * `pause()` and `resume()` (a pending host call) counts towards neither the
 * wall-clock nor the CPU budget; time inside wasm entries counts towards both.
 */
class RunClock {
  private readonly startedAt = performance.now();
  private wasmMs = 0;
  private pausedMs = 0;
  private entryStart: number | undefined;
  private pauseStart: number | undefined;

  enter(): void {
    this.entryStart = performance.now();
  }

  exit(): void {
    if (this.entryStart !== undefined) this.wasmMs += performance.now() - this.entryStart;
    this.entryStart = undefined;
  }

  pause(): void {
    this.pauseStart = performance.now();
  }

  resume(): void {
    if (this.pauseStart !== undefined) this.pausedMs += performance.now() - this.pauseStart;
    this.pauseStart = undefined;
  }

  /** Wall-clock time excluding paused stretches. */
  activeMs(now = performance.now()): number {
    const paused = this.pausedMs + (this.pauseStart !== undefined ? now - this.pauseStart : 0);
    return now - this.startedAt - paused;
  }

  /** Time spent inside the interpreter (approximates CPU time). */
  cpuMs(now = performance.now()): number {
    return this.wasmMs + (this.entryStart !== undefined ? now - this.entryStart : 0);
  }
}

class RunSession implements TerminationState {
  readonly logs: LogEntry[] = [];
  readonly calls: CallRecord[] = [];
  /** Set when an exception escaped the wasm module. */
  crashed: unknown = undefined;

  termination: TerminationKind | undefined;
  terminationDetail: string | undefined;
  budgetExceeded = false;

  private readonly context: QuickJSAsyncContext;
  private readonly scope = new Scope();
  private readonly clock = new RunClock();
  private readonly pending: PendingHostCall[] = [];
  /** The call currently awaiting the invoker (already removed from `pending`). */
  private inFlight: PendingHostCall | undefined;
  private readonly terminated: Promise<never>;
  private rejectTerminated!: (err: Error) => void;
  private readonly onAbort = (): void => this.terminate('aborted');
  private readonly terminationLimits: TerminationLimits;
  private callCount = 0;
  private logBytes = 0;
  private logsClosed = false;
  private jobError: unknown = undefined;
  private hasJobError = false;
  private readonly surface: Map<string, Set<string>>;

  constructor(
    private readonly runtime: QuickJSAsyncRuntime,
    private readonly request: CodeRunRequest,
    private readonly limits: RunLimits,
    private readonly hostCallTimeoutMs: number,
  ) {
    this.terminationLimits = { timeoutMs: limits.timeoutMs, cpuMs: limits.cpuMs, hostCallTimeoutMs };
    this.terminated = new Promise<never>((_, reject) => {
      this.rejectTerminated = reject;
    });
    this.terminated.catch(() => undefined);
    this.surface = indexSurface(request.surface);
    runtime.setMemoryLimit(limits.memoryBytes);
    this.context = runtime.newContext();
  }

  async execute(compiledCode: string): Promise<Outcome> {
    const { context, runtime } = this;
    this.request.signal?.addEventListener('abort', this.onAbort, { once: true });
    runtime.setInterruptHandler(() => this.shouldInterrupt());
    try {
      this.installBootstrap();

      const entry = wrapAsAsyncFunctionBody(`${compiledCode}\nreturn ${ENTRY_FUNCTION_NAME}();`) + RESULT_SERIALISER_SUFFIX;
      const evalResult = this.enter(() => context.evalCode(entry, 'action.js', { type: 'global' }));
      if (evalResult.error) {
        return { ok: false, error: this.mapError(this.dumpAndDispose(evalResult.error)) };
      }
      const main = this.scope.manage(evalResult.value);

      for (;;) {
        this.pumpJobs();
        if (this.termination) return this.timeoutOutcome();
        if (this.hasJobError) return { ok: false, error: this.mapError(this.jobError) };

        const state = this.enter(() => context.getPromiseState(main));
        if (state.type === 'fulfilled') {
          const valueHandle = state.value;
          const text = this.enter(() => {
            try {
              return context.getString(valueHandle);
            } finally {
              if (valueHandle.alive) valueHandle.dispose();
            }
          });
          if (this.termination) return this.timeoutOutcome();
          return this.parseResult(text);
        }
        if (state.type === 'rejected') {
          return { ok: false, error: this.mapError(this.dumpAndDispose(state.error)) };
        }

        const next = this.pending.shift();
        if (!next) {
          if (runtime.hasPendingJob()) continue;
          return {
            ok: false,
            error: {
              code: 'SANDBOX_RUNTIME',
              message: 'run stalled: the code is waiting for a promise that can never settle',
            },
          };
        }
        await this.performHostCall(next);
        if (this.termination) return this.timeoutOutcome();
      }
    } catch (err) {
      if (err instanceof IsolateCrash) {
        return { ok: false, error: mapHostCrash(err.cause) };
      }
      // An abort/timeout interrupt can land while the bootstrap or the entry call is still
      // evaluating; that surfaces as an evaluation error, but the termination is the real cause.
      if (this.termination) return this.timeoutOutcome();
      if (this.crashed === undefined) this.crashed = err;
      return { ok: false, error: mapHostCrash(err) };
    } finally {
      this.request.signal?.removeEventListener('abort', this.onAbort);
      if (this.crashed === undefined) {
        try {
          runtime.removeInterruptHandler();
        } catch (err) {
          this.crashed = err;
        }
      }
    }
  }

  /** Release every handle and the context. Not called after a crash. */
  cleanup(): void {
    try {
      const unsettled = this.pending.splice(0);
      if (this.inFlight) unsettled.push(this.inFlight);
      this.inFlight = undefined;
      for (const call of unsettled) {
        if (call.deferred.alive) call.deferred.dispose();
      }
      if (this.scope.alive) this.scope.dispose();
      if (this.context.alive) this.context.dispose();
    } catch (err) {
      this.crashed = err;
    }
  }

  // ---- isolate plumbing -------------------------------------------------

  private installBootstrap(): void {
    const { context, scope } = this;
    const bootResult = this.enter(() => context.evalCode(BOOTSTRAP_SOURCE, 'bootstrap.js', { type: 'global' }));
    if (bootResult.error) {
      throw new RpError('INTERNAL', 'sandbox bootstrap failed', this.dumpAndDispose(bootResult.error));
    }
    const bootFn = scope.manage(bootResult.value);
    const surfaceJson = scope.manage(context.newString(JSON.stringify(this.request.surface)));
    const hostCallFn = scope.manage(context.newFunction('__rp_host_call', (mod, method, argsJson) => this.onHostCall(mod, method, argsJson)));
    const logFn = scope.manage(context.newFunction('__rp_log', (level, message) => this.onLog(level, message)));

    const callResult = this.enter(() => context.callFunction(bootFn, context.undefined, surfaceJson, hostCallFn, logFn));
    if (callResult.error) {
      throw new RpError('INTERNAL', 'sandbox bootstrap failed', this.dumpAndDispose(callResult.error));
    }
    callResult.value.dispose();
    for (const h of [bootFn, surfaceJson, hostCallFn, logFn]) if (h.alive) h.dispose();
  }

  /** Runs inside the isolate's call into the host; never suspends the wasm stack. */
  private onHostCall(modH: QuickJSHandle | undefined, methodH: QuickJSHandle | undefined, argsH: QuickJSHandle | undefined): QuickJSHandle {
    const { context } = this;
    const module = modH ? String(context.dump(modH)) : '';
    const method = methodH ? String(context.dump(methodH)) : '';
    const argsJson = argsH ? String(context.dump(argsH)) : '[]';
    const deferred = context.newPromise();

    const refuse = (error: SerializedError): QuickJSHandle => {
      this.settle(deferred, { ok: false, error });
      return deferred.handle;
    };

    if (this.termination) return refuse(timeoutError(this, this.terminationLimits));
    if (!this.surface.get(module)?.has(method)) {
      return refuse({ code: 'CAPABILITY_UNKNOWN', message: `sdk.${module}.${method} is not available` });
    }
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch (err) {
      return refuse({ code: 'INVALID_ARGUMENT', message: `arguments are not valid JSON: ${(err as Error).message}` });
    }
    if (!Array.isArray(args)) {
      return refuse({ code: 'INVALID_ARGUMENT', message: 'arguments must be an array' });
    }
    if (this.callCount >= this.limits.maxHostCalls) {
      this.budgetExceeded = true;
      return refuse({
        code: 'SANDBOX_CALL_BUDGET',
        message: `host call budget of ${this.limits.maxHostCalls} calls per run exceeded`,
        details: { maxHostCalls: this.limits.maxHostCalls },
      });
    }
    this.callCount += 1;
    this.pending.push({ deferred, module, method, args: args as Json[] });
    return deferred.handle;
  }

  private onLog(levelH: QuickJSHandle | undefined, messageH: QuickJSHandle | undefined): void {
    if (this.logsClosed) return;
    const { context } = this;
    const rawLevel = levelH ? String(context.dump(levelH)) : 'info';
    const level = (LOG_LEVELS.has(rawLevel) ? rawLevel : 'info') as LogLevel;
    const message = messageH ? String(context.dump(messageH)) : '';
    const at = new Date().toISOString();
    const bytes = Buffer.byteLength(message, 'utf8');
    if (this.logBytes + bytes > this.limits.maxLogBytes) {
      const remaining = this.limits.maxLogBytes - this.logBytes;
      if (remaining > 0) this.logs.push({ level, message: truncateUtf8(message, remaining), at });
      this.logs.push({ level: 'warn', message: TRUNCATED_MARKER, at });
      this.logsClosed = true;
      return;
    }
    this.logBytes += bytes;
    this.logs.push({ level, message, at });
  }

  private async performHostCall(call: PendingHostCall): Promise<void> {
    const { module, method, args } = call;
    const callId = randomUUID();
    const startedAt = performance.now();
    let result: CapabilityResult;
    this.inFlight = call;
    this.clock.pause();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const invocation = Promise.resolve().then(() =>
        this.request.invoker.invoke({ callId, module, method, args, context: this.request.context }),
      );
      invocation.catch(() => undefined);
      timer = setTimeout(() => this.terminate('host-call-timeout', `sdk.${module}.${method}`), this.hostCallTimeoutMs);
      result = normaliseCapabilityResult(await Promise.race([invocation, this.terminated]));
    } catch (err) {
      if (this.termination) return; // leave the isolate promise pending; the run is over
      result = { ok: false, error: serializeError(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.clock.resume();
    }
    if (this.termination) return;

    const record: CallRecord = {
      callId,
      module,
      method,
      args,
      ok: result.ok,
      durationMs: elapsed(startedAt),
    };
    if (!result.ok) record.error = result.error;
    this.calls.push(record);
    this.inFlight = undefined;
    this.enter(() => this.settle(call.deferred, result));
  }

  /** Resolve the isolate-side promise with the JSON text of the result (the bootstrap throws on `ok: false`). */
  private settle(deferred: QuickJSDeferredPromise, result: CapabilityResult): void {
    let json: string;
    try {
      json = JSON.stringify(result);
      if (typeof json !== 'string') throw new TypeError('result serialised to undefined');
    } catch (err) {
      json = JSON.stringify({
        ok: false,
        error: { code: 'CAPABILITY_FAILED', message: `capability result is not JSON-serialisable: ${(err as Error).message}` },
      } satisfies CapabilityResult);
    }
    const handle = this.context.newString(json);
    try {
      deferred.resolve(handle);
    } finally {
      if (handle.alive) handle.dispose();
    }
  }

  private pumpJobs(): void {
    const { runtime } = this;
    while (runtime.hasPendingJob()) {
      const result = this.enter(() => runtime.executePendingJobs());
      if (result.error) {
        this.jobError = this.dumpAndDispose(result.error);
        this.hasJobError = true;
        return;
      }
    }
  }

  private shouldInterrupt(): boolean {
    if (this.termination) return true;
    if (this.request.signal?.aborted) {
      this.terminate('aborted');
      return true;
    }
    const now = performance.now();
    if (this.clock.cpuMs(now) > this.limits.cpuMs) {
      this.terminate('cpu');
      return true;
    }
    if (this.clock.activeMs(now) > this.limits.timeoutMs) {
      this.terminate('timeout');
      return true;
    }
    return false;
  }

  private terminate(kind: TerminationKind, detail?: string): void {
    if (this.termination) return;
    this.termination = kind;
    this.terminationDetail = detail;
    this.rejectTerminated(new Error(`run terminated: ${kind}`));
  }

  // ---- helpers ------------------------------------------------------------

  /** Run a synchronous wasm entry with CPU accounting; escaping exceptions poison the module. */
  private enter<T>(fn: () => T): T {
    if (this.crashed !== undefined) throw new IsolateCrash(this.crashed);
    this.clock.enter();
    try {
      return fn();
    } catch (err) {
      this.crashed = err;
      throw new IsolateCrash(err);
    } finally {
      this.clock.exit();
    }
  }

  private dumpAndDispose(handle: QuickJSHandle): unknown {
    return this.enter(() => {
      try {
        return this.context.dump(handle);
      } finally {
        if (handle.alive) handle.dispose();
      }
    });
  }

  private mapError(dumped: unknown): SerializedError {
    return mapIsolateError(dumped, this, this.terminationLimits);
  }

  private timeoutOutcome(): Outcome {
    return { ok: false, error: timeoutError(this, this.terminationLimits) };
  }

  private parseResult(text: string): Outcome {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.limits.maxResultBytes) {
      return {
        ok: false,
        error: {
          code: 'SANDBOX_RUNTIME',
          message: `result too large (${bytes} bytes, limit ${this.limits.maxResultBytes} bytes)`,
          details: { bytes, limit: this.limits.maxResultBytes },
        },
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) as Json };
    } catch (err) {
      return { ok: false, error: { code: 'SANDBOX_RUNTIME', message: `return value is not valid JSON: ${(err as Error).message}` } };
    }
  }
}

function indexSurface(surface: SdkSurface): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const mod of surface.modules) {
    const methods = index.get(mod.id) ?? new Set<string>();
    for (const m of mod.methods) methods.add(m);
    index.set(mod.id, methods);
  }
  return index;
}

function normaliseCapabilityResult(value: unknown): CapabilityResult {
  if (value && typeof value === 'object' && 'ok' in value) {
    const r = value as { ok: unknown; value?: unknown; error?: unknown };
    if (r.ok === true) return { ok: true, value: (r.value === undefined ? null : r.value) as Json };
    if (r.ok === false) {
      const e = r.error as Partial<SerializedError> | undefined;
      return {
        ok: false,
        error: {
          code: e?.code ?? 'CAPABILITY_FAILED',
          message: e?.message ?? 'capability failed',
          details: e?.details,
        },
      };
    }
  }
  return { ok: false, error: { code: 'CAPABILITY_FAILED', message: 'invoker returned a malformed CapabilityResult' } };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8').replace(/�+$/u, '');
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 100) / 100;
}
