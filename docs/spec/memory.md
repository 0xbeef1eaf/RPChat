# Long-term character memory

Goal: characters accumulate memories of the user, the relationship and past events across
sessions, so they feel consistent and alive. Two sources: the character itself
(`sdk.memory.remember`) and automatic **consolidation** by the engine; the user can review
and edit everything. Contracts: `@rp/shared/memory.ts`, `Storage.memories`,
`IpcApi.memories`, `ChatEvent 'memory-added'`, `AppSettings.memory`, SDK module
`packages/sdk/src/modules/memory.ts` (trusted).

## Core (`@rp/core`)

`MemoryService` (`src/services/memory.ts`):
- `list(characterRef)`, `add(characterRef, text, { tags, importance, source, sessionId })` (text trimmed,
  max 500 chars, tags lower-cased/deduped, importance default 3), `update(entry)`, `remove(id)`.
- `search(characterRef, query, limit)`: pure scoring in `src/memory/rank.ts` — tokenise (lower-case,
  strip punctuation, drop stop-words), score = tag hits ×2 + token overlap (Jaccard-ish on text tokens)
  + importance × 0.15 + recency bonus (created within 7 days: +0.2; recalled within 7 days: +0.1);
  ties by `updatedAt` desc. Recalled entries get `lastRecalledAt`/`recallCount` bumped (batched write).
- `forPrompt(characterRef, focusText, budgetTokens)`: top matches for `focusText` (`ChatService.memoryFocus`:
  the last `MEMORY_FOCUS_MESSAGES` non-empty user/assistant messages, newest last — the latest message alone
  is too narrow a handle for a thread picked up a few messages ago), always including the top-3 by importance
  and the 3 newest, deduped,
  trimmed to the token budget with `estimateTokens`; returns entries in stable order (importance desc,
  createdAt asc) for the `<memory>` section.
- `consolidate(sessionId)`: takes messages since the last consolidation marker (`session` state key
  `memory.lastConsolidatedMessageId`), skips if fewer than 4 user/assistant messages; builds a tool-less
  provider call with system prompt "You maintain the long-term memory of <character>. From the
  conversation, extract durable facts about the user, their life, preferences, the relationship and
  notable events worth remembering later. Return ONLY a JSON array of {text, tags, importance} …
  existing memories (do not repeat): [...]" and the transcript as one user message; parse the first JSON
  array in the reply (tolerate fences); each candidate → dedupe against existing (token Jaccard ≥ 0.6
  → skip, or update importance if higher) → `add(..., source: 'consolidation')` → emit
  `memory-added`. Prune to `maxEntriesPerCharacter` (drop lowest importance, then least recalled, never
  `user`-sourced ones first). Failures are logged, never surface to the user.
- Triggers: `ChatService` counts assistant turns per session; every `consolidateEveryTurns` and on
  `SessionService.remove`/explicit `memories.consolidate(sessionId)` IPC. Runs after `turn-finished`,
  not inside the turn (fire-and-forget with a per-session lock; abort-safe).
- `uninstall` of a pack keeps memories (like state); a `PackService.purgeCharacterData` can remove them.

Handler `src/handlers/memory.ts` (module `memory`): `remember/recall/recent/update/forget` on top of the
service, with the limits from the SDK typings (recall/recent limit default 10, max 50). Character scope is
`characterRef(context.packId, context.characterId)`.

PromptBuilder: the `<memory>` section becomes two parts: `<state>` (existing JSON state, capped) and
`<memories>` — "Things you remember (most important first):" followed by `- (importance/5, date) text
[tags]` lines from `forPrompt`, or "Nothing yet." Add guidance to the engine rules: memories are your own
past; refer to them naturally, do not list them; use sdk.memory.remember for new durable facts.

Storage: `memories` aggregate in `FileStorage` (one JSON file per characterRef under `memories/`) and
`MemoryStorage`.

Tests: rank scoring (tags beat body words, importance/recency tie-breaks), forPrompt budget and
dedupe, consolidate with MockProvider returning fenced JSON (adds, dedupes, prunes, emits event), handler
limits, FileStorage round-trip.

## Renderer

- **Memories panel** per character (from the session's character; open from the character header and
  from the Packs view): list with search box, importance stars (editable), tags (editable chips), text
  (inline edit), source badge, "Forget" button with confirm, "Add memory" form, "Consolidate now" button
  (calls `memories.consolidate(sessionId)` when a session is open).
- A subtle "remembered: …" toast when `memory-added` arrives for the open session.

## Desktop main

`IpcApi.memories` → `engine.memories` service methods; forward `memory-added` like other chat events.
