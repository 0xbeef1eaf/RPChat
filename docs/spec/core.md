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
  settings: SettingsService;  audit: AuditService;  timers: TimerService;  library: LibraryService;  capabilities: { list(): CapabilityInfo[]; typings(): string };
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
- `lib`: `define/remove/list/source` on `LibraryService` for the acting character. `define`'s `fn` arrives as a string — a function argument was serialised by the sandbox to `return await (<fn>)(input);` (the `Handler` mechanism of `events.on`/`timers.runLater`), which the service unwraps; a plain string is taken as the function expression.
- `timers`: `schedule` persists `ScheduledTimer` + arms `setTimeout` (re-armed on `start()`, overdue timers fire immediately, ≤ 20 per session); on fire: if the character has `onTimer` behaviour run it with `{ timer }` else inject a system-origin user message `"[timer fired] label/payload JSON"` and run an LLM turn. Provide `cancel`, `list`.

**LibraryService** (`services/library.ts`): the character's own function library (`sdk.lib`). Functions live in the character state scope (`char:<packId>/<characterId>`) under the key `lib.functions` as `Record<name, LibFunction>` (`@rp/shared` `LibFunction { name, source, description?, bytes, updatedAt }`), so they survive sessions, restarts and pack re-installs and are invisible to other characters. `define(target, name, fn, opts?)` validates the name (`^[a-zA-Z_$][\w$]*$`, ≤ 64 chars, no reserved words, no `__proto__`), the caps (50 functions, 16 KiB per source, 128 KiB in total) and that the source parses with esbuild `transformSync` as a single function expression (never `new Function`); `remove`, `list`, `functions` (with sources, for the prompt), `source`. `preludeFor(packId, characterId)` renders `const lib = Object.freeze({\n  "<name>": (<source>),\n  …\n});` (`const lib = Object.freeze({});` when empty), cached per character and invalidated on every write and on pack changes. The prelude reaches every run as `CodeRunRequest.prelude`: `ChatService.runLlmTurn` sets `TurnInput.prelude` for `ActionLoop.runAction`, and `BehaviourRunner` (`run`/`runScript`: timer code, event handlers, lifecycle hooks) asks its `prelude` option. `ChatService` also removes `lib.functions` from the `<state>` block — the library has its own section.

**SessionService**: one session per character — `create` returns the character's existing session (newest by `updatedAt`) instead of a second one, so no second greeting or `onSessionStart`; `forCharacter(ref)` looks it up. `resetState(sessionId)` clears the `session:<id>` state scope (sandbox scratch, history summary, autonomy counters, consolidation marker), pending timers, session permission allows and, through the after-reset hook, event subscriptions; it emits `status: null` and `session-reset`. `ChatService.resetState` aborts a running turn first. Messages are untouched.

**Timer delays**: `settings.autonomy.minDelayMs` (default 30 s, hard floor 1 s) is the shortest delay for `timers.schedule`, `timers.runLater` and a delayed `llm.wake`; shorter values are raised to it (`validateDelay`), never rejected, and the engine rules quote the configured value each turn so characters plan in minutes. `llm.wake` without `delayMs` still runs right after the action.

**PromptBuilder**: implements ARCHITECTURE §6. Sections wrapped in `<engine_rules>`, `<persona>`, `<sdk_reference>`, `<library>` (only when `PromptInput.library` is non-empty: a heading line "Your own functions (call them as lib.<name>(...); sdk.lib.define adds or replaces one)" then one line per function `- lib.<name>(<params>) — <description>`, params being the text between the source's first `(` and its matching `)`, whitespace-collapsed; it is dynamic, so it opens the non-cached tail right after `<sdk_reference>`), `<history_summary>` (only when a summary covers part of the transcript), `<memory>`, `<session>` tags. The engine rules add: "You can save reusable code with sdk.lib.define and call it as lib.<name>(...) in any later action, timer or event handler; prefer that over re-writing the same steps." `<sdk_reference>` is the `generateSdkIndex` output: every granted module's methods with signature, full TSDoc summary, parameters, returns and first example, straight from the typings; ungranted modules are not mentioned at all (the `help` module serves complete typings/docs per module on demand). `build()` also returns `stats` (system/sdk-reference token estimates, transcript budget, dropped messages, summarised messages and summary tokens, messages whose action detail was trimmed); `ChatService` logs a warning when the system prompt exceeds half of `contextTokenBudget` or messages were dropped.  There is no pack/asset listing: the engine rules direct the character to `sdk.pack.tags()` / `findAssets` / `listAssets` (the abridged SDK index already names the granted modules). The rules push the character towards acting rather than describing action — reach for the sdk when doing beats saying, never mime a capability it has (no `*shows you the photo*` without `sdk.media.showImage`), balanced by the restraint rules (one action per intention, short code, nothing the moment does not call for). State JSON capped at 4 KiB. When `useToolCalling` is false or the provider lacks tools, engine rules explain the ```action fence instead of the tool. Transcript → `LlmMessage[]`: user/assistant text; assistant messages with actions expand to assistant(text + tool_use parts) + user(tool_result parts) pairs (or, in fenced mode, assistant text containing the fence + user `<action_result>` JSON). System-origin messages (timer wake-ups) become user messages prefixed with `[system]`. Apply `windowMessages` with `contextTokenBudget` (default 64k) minus the system prompt estimate.

**HistoryService** (`settings.history`): keeps a long session inside the context window without deleting anything. Two independent mechanisms, both prompt-only — storage and the chat view always hold every message with its actions.

- *Background summarisation.* After a turn, `ChatService.afterTurn` calls `shouldCompress` (transcript token estimate, action code and results included) and, above `compressAboveTokens`, kicks off `compress()` off the turn. It summarises everything except the last `keepRecentMessages` messages into a rolling `HistorySummary` (`text`, `throughMessageId`, `messageCount`), stored in state under `session:<id>` / `history.summary`. Runs are serialised per session and never throw; a second call while one runs returns the running promise. Each run sends only the messages added since the previous summary and the previous summary text, so cost stays flat as the session grows. `PromptBuilder` drops every message up to `throughMessageId` and emits `<history_summary>` instead; if that message is no longer in the transcript (history cleared, message deleted) the summary is ignored and the transcript is used whole. `ChatService.clearMessages` clears the summary with the messages.
- *Action trimming.* `keepActionDetailFor` (default 0: no past tool calls are re-sent; the in-flight turn always carries its own rounds) keeps the code and results of the N most recent assistant messages that acted; older messages contribute only their visible text. Saved settings still on the earlier default of 2 are migrated to 0. `transcriptToMessages` drops a message's `tool_use` and `tool_result` blocks together, so a result is never orphaned from its call, in both tool and fenced mode.

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
Model traffic: with `TurnInput.captureExchanges` (ChatService passes `settings.debug.showModelTraffic`, plus `providerLabel` = the provider config's label or id) every provider call emits exactly one `model-exchange` chat event (`ModelExchange`: kind `turn`, `round` index from 0, the final text-only call after the action limit included, `turnId`, `messageId`, a `structuredClone` snapshot of system/messages/tools taken before the call, then `response` with usage/stop reason or the serialized `error`, and `durationMs`). `sdk.llm.ask` (and screenshot descriptions) emit the same event with kind `llm.ask`, memory extraction with kind `memory`; all three go through `services/exchanges.ts` `recordExchange`. When the setting is off nothing is copied or emitted.
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
- library: define through the dispatcher from a serialised function → list/source round-trip; the next turn's `CodeRunRequest.prelude` carries it (FakeRunner), as do `timers.runLater` handlers, event handlers and behaviour hooks; the prompt shows `<library>` with params after `<sdk_reference>`; bad names, oversized or non-function sources are rejected; remove works; the library survives sessions of the same character and is not visible to another character
- state handler scoping and caps; timers fire (use fake `now` + exposed `timers.fireDue()` for deterministic tests)
- FileStorage round trip in a temp dir, atomic write leaves no `.tmp` files, audit cap
- windowing: long transcript stays under budget and keeps tool pairs
