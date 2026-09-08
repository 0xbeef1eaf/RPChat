# @rp/core — Chat engine

Depends on: `@rp/shared`, `@rp/sdk`, `@rp/pack`, `@rp/llm`. Uses `CodeRunner` as an injected interface (tests use `FakeRunner`). Node only (fs for storage).

## Exports

```ts
export interface EngineOptions {
  storage: Storage;
  registry: CapabilityRegistry;
  runner: CodeRunner;
  providerFactory: (config: ProviderConfig) => LlmProvider;   // default createProvider from @rp/llm
  /** Host handlers for modules with host effects (media, ui, system). Core supplies chat/log/state/pack/timers itself. */
  hostHandlers: CapabilityHandler[];
  permissionPrompter: (request: PermissionRequest) => Promise<PermissionDecision>;  // desktop routes to renderer
  appVersion: string;
  now?: () => Date;
  logger?: Pick<Console, 'debug'|'info'|'warn'|'error'>;
}
export class Engine {
  constructor(opts: EngineOptions);
  start(): Promise<void>;                 // loads installed packs, restores timers
  stop(): Promise<void>;
  readonly events: TypedEmitter<{ chat: ChatEvent; 'permission-request': PermissionRequest }>;
  packs: PackService;  sessions: SessionService;  chat: ChatService;  permissions: PermissionService;
  settings: SettingsService;  audit: AuditService;  timers: TimerService;  capabilities: { list(): CapabilityInfo[]; typings(): string };
}
export class FileStorage implements Storage { constructor(dataDir: string) }   // atomic writes, JSONL audit with cap (default 5000 entries)
export class MemoryStorage implements Storage {}
export class FakeRunner implements CodeRunner {}      // exported for desktop dev mode & tests: runs `handler(request)` you provide
export class PromptBuilder { build(input: PromptInput): { system: string; messages: LlmMessage[] } }
export class ActionLoop {...}       // testable without Engine
export class CapabilityDispatcher implements CapabilityInvoker {...}
export { extractFencedActions } // re-export for convenience
```

## Services

**PackService**: `install(sourcePath)` (dir or .rppack → copies/extracts into `<dataDir>/packs/<id>/<version>/`, writes `InstalledPackRecord`; if same id already installed: replace, keeping grants; then runs `onInstall` behaviours for each character *only if* all requested `pack`/`prompt` capabilities are already granted — otherwise defer until grants change), `uninstall(id)` (removes files, record, grants, and sessions' ability to continue: sessions remain but `send` fails with NOT_FOUND), `list()`, `getLoaded(packId): LoadedPack` (cached), `characters(): CharacterSummary[]`, `exportPack(id, dest)`.
Pack installation directory root is `EngineOptions.storage`-adjacent: pass `dataDir` via `FileStorage` (expose `storage.dataDir`) — or accept `packsDir` in EngineOptions; choose `packsDir: string` in EngineOptions.

**PermissionService**: `grantsFor(packId)`, `setGrant(packId, module, granted)`, `isAllowed(context, module, method): Promise<'allow' | 'deny' | 'prompt'>` (trusted → allow; pack → grant lookup; prompt → grant lookup AND then prompt unless a session-scoped remembered decision exists), `prompt(request)` → uses `permissionPrompter`, stores `allow-session` decisions in memory keyed by sessionId+module+method.

**CapabilityDispatcher** (`invoke(call)`): resolve handler by module (core-provided or host), check registry knows module/method (CAPABILITY_UNKNOWN), permission check (PERMISSION_DENIED / PERMISSION_PROMPT_REJECTED), invoke, wrap errors, append `AuditEntry` (allowed/denied/failed with durationMs), return `CapabilityResult`. Values must be JSON: run the result through `JSON.parse(JSON.stringify())`, `undefined` → `null`.

**Core-provided handlers** (`src/handlers/`): 
- `chat`: `say`/`emote` append an assistant `ChatMessage` (origin from context.trigger, kind emote) and emit `message-added`; `history`; `setStatus` emits `status`.
- `log`: no-op on host (sandbox captures) — still register so calls don't fail if someone routes them.
- `state`: scopes `char:<packId>/<charId>` and `session:<sessionId>`; values capped at 32 KiB each, 200 keys per scope.
- `pack`: uses `@rp/pack` `resolveAssetPath` + asset index; `readText` limited to text kind.
- `timers`: `schedule` persists `ScheduledTimer` + arms `setTimeout` (re-armed on `start()`, overdue timers fire immediately, ≤ 20 per session); on fire: if the character has `onTimer` behaviour run it with `{ timer }` else inject a system-origin user message `"[timer fired] label/payload JSON"` and run an LLM turn. Provide `cancel`, `list`.

**PromptBuilder**: implements ARCHITECTURE §6. Sections wrapped in `<engine_rules>`, `<persona>`, `<pack>`, `<sdk_reference>`, `<memory>`, `<session>` tags. `<sdk_reference>` is the abridged `generateSdkIndex` output (the `help` module serves full typings/docs per module on demand). `build()` also returns `stats` (system/sdk-reference token estimates, transcript budget, dropped messages); `ChatService` logs a warning when the system prompt exceeds half of `contextTokenBudget` or messages were dropped. Asset list grouped by kind, capped at 200 entries with "… and N more". State JSON capped at 4 KiB. When `useToolCalling` is false or the provider lacks tools, engine rules explain the ```action fence instead of the tool. Transcript → `LlmMessage[]`: user/assistant text; assistant messages with actions expand to assistant(text + tool_use parts) + user(tool_result parts) pairs (or, in fenced mode, assistant text containing the fence + user `<action_result>` JSON). System-origin messages (timer wake-ups) become user messages prefixed with `[system]`. Apply `windowMessages` with `contextTokenBudget` (default 64k) minus the system prompt estimate.

**ActionLoop** (`runTurn`): 
```
emit turn-started
create assistant message (empty) → emit message-added
for round in 0..maxActionRounds:
  provider.chat(request, { onTextDelta → append to message.content, emit text-delta })
  actions = tool_use parts named run_action (+ fenced blocks from text when in fenced mode or when found anyway)
  if none: break
  for each action (sequential): emit action-started; runner.run(...); attach result; emit action-finished
  append tool_result parts (JSON of { ok, returnValue, error, logs }) to the next request
  if round == max: append a final user message "[system] action limit reached, reply with text only" and do one last provider.chat without tools
persist message, emit message-updated, turn-finished; on error attach error and emit error
```
Abort: `chat.abort(sessionId)` aborts the provider `signal` and the runner `signal`; partial text is kept and persisted.
`sdk.chat.say` during an action appends a separate assistant message *before* the streaming one is finalised; that is fine — order them by createdAt.

**ChatService**: `send(sessionId, text)` → persist user message, run `onUserMessage` behaviours (may return `{ skipLlm: true }`), run `ActionLoop.runTurn`. Serialise turns per session (a queue); `send` while a turn runs waits for it. `abort(sessionId)`.

**SessionService**: CRUD; `create` writes the greeting as first assistant message (origin greeting) and runs `onSessionStart` behaviours; `remove` deletes messages, session state and timers.

**SettingsService**: `get()`, `update(patch)` with `DEFAULT_SETTINGS` + `DEFAULT_RUN_LIMITS` merge, provider CRUD by array replace, `testProvider`, `listModels`.

## Tests (vitest, MemoryStorage + MockProvider + FakeRunner)

- install `examples/packs/minimal` and `luna` (from the repo), list characters, uninstall cleans grants
- create session → greeting message present; onSessionStart behaviour ran (FakeRunner asserts hook + says something via invoker → message-added)
- full turn: mock provider returns tool_use run_action → FakeRunner returns value → second mock turn returns text; assert event order and persisted message with actions[0].result
- fenced fallback mode (supportsTools false) extracts ```action block and feeds `<action_result>` back
- permission: media without grant → CapabilityResult PERMISSION_DENIED + audit entry denied; with grant → host handler invoked; prompt-level → prompter called, `allow-session` remembered
- state handler scoping and caps; timers fire (use fake `now` + exposed `timers.fireDue()` for deterministic tests)
- FileStorage round trip in a temp dir, atomic write leaves no `.tmp` files, audit cap
- windowing: long transcript stays under budget and keeps tool pairs
