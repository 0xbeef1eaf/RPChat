# @rp/sandbox — QuickJS code runner

Depends on: `@rp/shared`, `@rp/sdk` (only for `describeSurface` in tests), `quickjs-emscripten` (use the **asyncify** release variant so host functions can be async: `import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten'` or `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-asyncify`), `esbuild` (transform only, `loader: 'ts'`, `format: 'esm'` → we wrap as function body so use `format: 'iife'`-free approach: transform the TS then wrap).

## Exports

```ts
export class QuickJsRunner implements CodeRunner {
  constructor(options?: { limits?: Partial<RunLimits>; moduleLoader?: undefined })
  run(request: CodeRunRequest): Promise<CodeRunResult>;
  dispose(): Promise<void>;
}
export function transpile(code: string, language: 'ts' | 'js', options?: { prelude?: string }): { js: string; map?: string; preludeLines: number } // throws RpError('SANDBOX_COMPILE', message, { line, column }) — or { library: true, libraryLine, libraryColumn } for a prelude error (§5)
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

### 3.1 Failures the model can act on (`sourcemap.ts`, `stack.ts`)

The code that runs is not the code the model wrote: esbuild reformats it and the runner wraps it (`__rp_main`, then the async IIFE), so an isolate frame like `action.js:6:38` names a line the model never typed. `transpile` therefore also returns esbuild's source map, and `withSourceContext` rewrites every failure against the model's own source before it leaves the sandbox:

- `SourceMapper` (a base64-VLQ decoder, no dependency) maps a position in the evaluated code back through `ASYNC_WRAPPER_LINES` and `PRELUDE_LINES` to the model's line and column.
- `mapStack` rewrites each frame as `at <fn> (action.ts:<line>:<col>)`, keeps `(native)` frames, renames the entry function to `<your code>`, and drops what the model cannot act on: `bootstrap.js`, unmapped wrapper lines, frames past the end of its source, and anything after the first ten.
- `codeFrame` quotes the failing line with two lines of context and a caret under the column.
- Compile errors get the same `line`/`column`/`frame` from esbuild's location, and their host stack (the `RpError` thrown in `transpile`) is dropped — host paths are noise.

The result is `SerializedError` with a mapped `stack` and `details: { line, column, frame, … }`. Core's `errorForModel` (used by both the live tool result and the replayed `<action_result>`, so they read alike) forwards `code`, `message`, `line`, `column`, `frame`, `details` and `stack`, and the system prompt tells the model those fields point at its own `action.ts` lines and that it may fix them and run once more.
7. Always release every handle (use `Scope` / `using` helpers), dispose the context, and return `durationMs` and `compiledCode`.

## 4. Function arguments (handlers)

`sdk.events.on` and `sdk.timers.runLater` store code to run later, in a fresh isolate. Written as a
string it is unchecked and awkward; written as a function it is part of the model's own code. JSON has
no functions, so the bootstrap's `JSON.stringify` replacer turns a function argument into the action
body that calls it — `return await (<its source>)(input);` — using the source the isolate compiled,
which is already plain JavaScript (esbuild stripped the types). The host is unchanged: it still
receives, validates and stores a string, and `wrapBehaviourScript` binds `input` when it runs.

A handler therefore closes over nothing: no variable from the surrounding action, no helper defined
above it. Whatever it needs travels in `opts.input`. Arguments that are not serialisable at all still
reject with `sdk.<module>.<method>: arguments must be JSON-serialisable`.

## 5. Prelude (`CodeRunRequest.prelude`)

The host may put source in front of the user's code: the character's function library, which core's
`LibraryService` renders as `const lib = Object.freeze({ "<name>": (<source>), … });` (or
`const lib = Object.freeze({});` when empty). `transpile(code, language, { prelude })` places it between
the wrapper's first line and the code, plus a newline, inside the same `async function __rp_main`, so
`lib` is a local const the user's code sees and nothing else changes: same isolate, same `sdk`, same
limits. `Transpiled.preludeLines` counts its lines and the `SourceMapper` subtracts them
(`originalLineOffset = PRELUDE_LINES + preludeLines`), so `line`, `column`, `frame` and `stack` keep
pointing at the user's own lines.

Failures that belong to the library are named as such rather than mapped onto the action: a stack frame
inside the prelude is kept as `at lib.<name> (library:<line>:<col>)` (QuickJS names the function after
the property it sits under) but never becomes the code frame, and a syntax error inside the prelude is a
`SANDBOX_COMPILE` whose message starts with `syntax error in your function library` and whose details
carry `{ library: true, libraryLine, libraryColumn }` instead of `line`/`column` — no caret ever points
into code the model did not write this turn. Without `prelude` nothing is prepended and `lib` is
undefined.

## Tests (must run in vitest under Node 22 — wasm only, no native)

- returns JSON value; `await sdk.x.y()` reaches the invoker with parsed args and context
- nested `sdk.state.session.get`
- console output captured and truncated
- infinite loop `while(true){}` → SANDBOX_TIMEOUT within ~cpuMs
- memory bomb (array growth) → SANDBOX_MEMORY or SANDBOX_TIMEOUT, process survives
- host call budget enforced
- host error propagates as a catchable Error inside the isolate with `.code`
- TypeScript syntax (types, generics, `satisfies`) transpiles; syntax error → SANDBOX_COMPILE with line
- a runtime failure reports the model's own line/column, a caret frame and a stack in `action.ts` coordinates
- `signal.abort()` mid-await rejects with SANDBOX_TIMEOUT
- prelude: `lib.double` defined by the prelude is callable from the code; a failure in the code after a three-line prelude still reports the user's line; a failure inside a library function shows `at lib.<name> (library:…)`; a prelude syntax error is reported as a library problem without a caret into the action
- runner survives 200 sequential runs without leaking (assert no exceptions; optional memory check)
