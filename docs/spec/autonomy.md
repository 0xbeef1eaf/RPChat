# Autonomy: code timers and self-wakes (core)

Characters can act without the user typing. Contracts: `ScheduledTimer.kind` (`wake | code | prompt`),
`AppSettings.autonomy`, SDK modules `timers` (v1.1: `runLater`) and `llm` (`ask`, `wake`).

## TimerService

- `schedule(ctx, delayMs, payload, opts)` → kind `wake` (unchanged behaviour).
- `runLater(ctx, delayMs, handler, { input, label, repeatEveryMs, maxRuns })` → kind `code`; the
  handler reaches the host as code either way (a function argument is serialised to an action body in
  the isolate, see `docs/spec/sandbox.md` §4); validate
  1 s ≤ delay ≤ 7 d, code non-empty ≤ 16 KiB, `repeatEveryMs ≥ settings.autonomy.minRepeatIntervalMs`,
  per-session count ≤ `maxTimersPerSession` (INVALID_ARGUMENT otherwise). On fire: run `code` through the
  same runner path as behaviours (`const input = <json>;` prepended, `language: 'ts'`, trigger
  `{ kind: 'timer', timerId }`, character-scoped surface and permissions), audit the run, emit nothing to the
  transcript unless the code speaks. Repeat: after a run, if `repeat` and (`remaining` undefined or > 0),
  reschedule `fireAt += everyMs`, decrement `remaining`, `runs++`; else delete.
- `schedulePrompt(ctx, delayMs, prompt, label)` → kind `prompt`. On fire: `ChatService.selfWake(sessionId, prompt)`.
- `list` includes `kind` and `repeat`; `cancel` works for all kinds.

## ChatService.selfWake(sessionId, prompt, source)

- Appends a `role: 'system'` message with `origin: 'timer'` and content `[self-wake] <prompt>` (rendered in
  the prompt as a user message: `[system] Message from your past self: <prompt>`), then runs a normal turn
  (tools enabled). Queued behind any running turn for that session.
- Guards (per session, in memory + persisted counters in session state under `autonomy.*`):
  `maxSelfWakesPerHour` (sliding window of timestamps) and `maxConsecutiveSelfWakes` (reset when a user
  message arrives). When exceeded: drop the wake, write an audit entry `llm.wake` outcome `denied`, emit
  `status` "paused: autonomy limit reached" for the session, and log. Timer-kind `wake` (payload) turns also
  count toward the limits; `code` timers do not (they make no LLM call) but they may call `sdk.llm.wake`.

## `llm` handler (core, trusted)

- `ask(prompt, { system, maxTokens ≤ 2048 (default 512), temperature })`: provider from the session
  (or default), tool-less `chat()` with `system` (default "You are a helpful assistant. Answer concisely.")
  and one user message; returns text; 60 s abort; errors → CAPABILITY_FAILED with the provider message.
  Not written to the transcript; audited.
- `wake(prompt, { delayMs = 0, label })`: prompt trimmed, ≤ 2000 chars. `delayMs === 0` → register a
  pending wake on the session's action loop; when the current turn finishes (`turn-finished`), the engine
  runs `selfWake` (at most one immediate wake per turn; later calls replace the earlier prompt, joined with a
  newline). `delayMs ≥ 1000` → `TimerService.schedulePrompt`. Returns `{ queued, timer }`.

## Prompt builder

Engine rules gain: "You can act on your own initiative: `sdk.llm.wake` gives you a turn later (or right after
this action) with a note from your past self; `sdk.timers.runLater` runs code later without a turn. Use them
to follow up, continue stories, or check in. Limits apply; do not chain wakes needlessly."

## Tests

- runLater: validation, fires code with `input`, repeat with maxRuns, cancel; code that calls `sdk.chat.say` produces a message-added.
- selfWake: immediate wake runs after turn-finished (event order), delayed wake via timer, per-hour and consecutive limits drop with audit + status, counters reset on user message.
- ask: MockProvider called without tools, transcript unchanged.
