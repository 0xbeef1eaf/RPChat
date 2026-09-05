# @rp/sandbox — QuickJS code runner

Depends on: `@rp/shared`, `@rp/sdk` (only for `describeSurface` in tests), `quickjs-emscripten` (use the **asyncify** release variant so host functions can be async: `import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten'` or `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-asyncify`), `esbuild` (transform only, `loader: 'ts'`, `format: 'esm'` → we wrap as function body so use `format: 'iife'`-free approach: transform the TS then wrap).

## Exports

```ts
export class QuickJsRunner implements CodeRunner {
  constructor(options?: { limits?: Partial<RunLimits>; moduleLoader?: undefined })
  run(request: CodeRunRequest): Promise<CodeRunResult>;
  dispose(): Promise<void>;
}
export function transpile(code: string, language: 'ts' | 'js'): { js: string } // throws RpError('SANDBOX_COMPILE', message, { line, column })
export function wrapAsAsyncFunctionBody(js: string): string;   // `(async () => {\n${js}\n})()` — must keep `return` valid
```

## Execution model

1. `transpile` with esbuild (`target: 'es2020'`, `format: 'esm'` is wrong for a body — use `loader: 'ts'` on `async function __rp_main(){ <code> }` then extract; simplest: transform the string `async function __rp_main() {\n${code}\n}` and append `__rp_main()` in the isolate).
2. Create a fresh `QuickJSAsyncContext` per run from a shared runtime (`newQuickJSAsyncWASMModule()` cached at first use; one `QuickJSAsyncRuntime` per runner, `setMemoryLimit`, `setMaxStackSize(1 MB)`).
3. Interrupt handler: `shouldInterruptAfterDeadline(start + cpuMs)` and also honour `signal`. Wall-clock timeout via `Promise.race` in the host + interrupting; ensure the context is disposed either way.
4. Install globals in the isolate:
   - `__rp_host_call(module, method, argsJson) : Promise<string>` — `newAsyncifiedFunction`; host parses args, enforces `maxHostCalls` (throw SANDBOX_CALL_BUDGET), calls `request.invoker.invoke(...)`, records a `CallRecord`, returns `JSON.stringify(CapabilityResult)`. In the isolate, a small bootstrap script builds `sdk` from the `SdkSurface` JSON: for each module, an object with each method as `(...args) => __rp_host_call(mod, name, JSON.stringify(args)).then(r => { const x = JSON.parse(r); if (x.ok) return x.value; throw Object.assign(new Error(x.error.message), { code: x.error.code, details: x.error.details }) })`. Support one level of nesting for dotted method names (`session.get` → `sdk.state.session.get`).
   - `console.{log,info,debug,warn,error}` → appended to `logs` (JSON-stringify non-strings, join with spaces, enforce `maxLogBytes`, then truncate with a final "…[truncated]" entry).
   - `sdk.log.*` also lands in `logs` (handled by the bootstrap, not via host call).
   - No `setTimeout` etc. Provide `sleep(ms)` as a host-backed helper? No — keep v1 minimal; document that timers are via `sdk.timers`.
5. Evaluate the bootstrap, then the user code with `evalCodeAsync`; the result is a promise handle — `resolvePromise` → `runtime.executePendingJobs()` loop as required by quickjs-emscripten. Convert the settled value with `context.dump`, enforce `maxResultBytes` (truncate → error `SANDBOX_RUNTIME` "result too large").
6. Errors: compile → `SANDBOX_COMPILE`; interrupt/timeout → `SANDBOX_TIMEOUT`; out of memory → `SANDBOX_MEMORY`; thrown → `SANDBOX_RUNTIME` with message + stack (from the isolate error's `stack` property).
7. Always release every handle (use `Scope` / `using` helpers), dispose the context, and return `durationMs` and `compiledCode`.

## Tests (must run in vitest under Node 22 — wasm only, no native)

- returns JSON value; `await sdk.x.y()` reaches the invoker with parsed args and context
- nested `sdk.state.session.get`
- console output captured and truncated
- infinite loop `while(true){}` → SANDBOX_TIMEOUT within ~cpuMs
- memory bomb (array growth) → SANDBOX_MEMORY or SANDBOX_TIMEOUT, process survives
- host call budget enforced
- host error propagates as a catchable Error inside the isolate with `.code`
- TypeScript syntax (types, generics, `satisfies`) transpiles; syntax error → SANDBOX_COMPILE with line
- `signal.abort()` mid-await rejects with SANDBOX_TIMEOUT
- runner survives 200 sequential runs without leaking (assert no exceptions; optional memory check)
