import type { ActionContext, CapabilityInvoker, SdkSurface } from './capability.js';
import type { SerializedError } from './errors.js';
import type { ActionId, Json } from './ids.js';

export type ActionLanguage = 'ts' | 'js';

export interface RunLimits {
  /** Wall-clock timeout for the whole run, including awaited host calls. Default 10_000. */
  timeoutMs: number;
  /** CPU time budget enforced through the interrupt handler. Default 2_000. */
  cpuMs: number;
  /** Isolate memory limit in bytes. Default 64 MiB. */
  memoryBytes: number;
  /** Max host capability calls per run. Default 50. */
  maxHostCalls: number;
  /** Max bytes of captured console/log output. Default 16 KiB. */
  maxLogBytes: number;
  /** Max bytes of the JSON-serialised return value. Default 16 KiB. */
  maxResultBytes: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 10_000,
  cpuMs: 2_000,
  memoryBytes: 64 * 1024 * 1024,
  maxHostCalls: 50,
  maxLogBytes: 16 * 1024,
  maxResultBytes: 16 * 1024,
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  at: string;
}

export interface CodeRunRequest {
  /** Body of an async function. `sdk` and `console` are in scope. */
  code: string;
  language: ActionLanguage;
  context: ActionContext;
  /** Modules/methods to expose as `sdk`. Denied modules are simply absent. */
  surface: SdkSurface;
  invoker: CapabilityInvoker;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
}

export interface CallRecord {
  callId: string;
  module: string;
  method: string;
  args: Json[];
  ok: boolean;
  error?: SerializedError;
  durationMs: number;
}

export interface CodeRunResult {
  ok: boolean;
  /** JSON value returned by the code (undefined → null). */
  returnValue?: Json;
  error?: SerializedError;
  logs: LogEntry[];
  calls: CallRecord[];
  durationMs: number;
  /** Transpiled JavaScript actually executed (for the action card / debugging). */
  compiledCode?: string;
}

/** Contract implemented by `@rp/sandbox` (QuickJS) and by test fakes in `@rp/core`. */
export interface CodeRunner {
  run(request: CodeRunRequest): Promise<CodeRunResult>;
  dispose(): Promise<void>;
}

/** An action the LLM asked to run, as attached to a chat message. */
export interface ActionRecord {
  id: ActionId;
  purpose: string;
  code: string;
  language: ActionLanguage;
  /** How the action was extracted. */
  source: 'tool' | 'fenced';
  startedAt: string;
  result?: CodeRunResult;
}

/** Name of the tool exposed to LLM providers that support tool calling. */
export const RUN_ACTION_TOOL_NAME = 'run_action';
/** Fenced-block info string used in fallback mode: ```action */
export const ACTION_FENCE_TAG = 'action';
