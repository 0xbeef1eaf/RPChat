# Long-term character memory

Goal: characters accumulate memories of the user, the relationship and past events across
sessions, so they feel consistent and alive. Two sources: the character itself
(`sdk.memory.remember`) and automatic **consolidation** by the engine; the user can review
and edit everything. Contracts: `@rp/shared/memory.ts`, `Storage.memories`, `Storage.embeddings`,
`IpcApi.memories`, `ChatEvent 'memory-added'`, `AppSettings.memory`, SDK module
`packages/sdk/src/modules/memory.ts` (trusted).

## Core (`@rp/core`)

`MemoryService` (`src/services/memory.ts`):
- `list(characterRef)`, `add(characterRef, text, { tags, importance, source, sessionId })` (text trimmed,
  max 500 chars, tags lower-cased/deduped, importance default 3), `update(entry)`, `remove(id)`.
- `search(characterRef, query, limit, { touch })`: pure scoring in `src/memory/rank.ts` — tokenise (lower-case,
  strip punctuation, drop stop-words), score = tag hits ×2 + token overlap (Jaccard-ish on text tokens)
  + importance × 0.15 + recency bonus (created within 7 days: +0.2; recalled within 7 days: +0.1)
  + the semantic boost below; ties by `updatedAt` desc. Recalled entries get `lastRecalledAt`/`recallCount`
  bumped (batched write) unless `touch: false` — browsing the panel is not a recall.
- **Semantic ranking** (`src/services/embeddings.ts`): when an embedder is available, `rankMemories` also gets a
  cosine similarity per memory and adds a boost of up to `SEMANTIC_WEIGHT` (3 — one and a half tag hits). The boost
  is not a function of the raw cosine: unrelated pairs score ~0.1 under OpenAI's models and ~0.65 under BGE's, so a
  fixed threshold cannot serve both. `standardScores` turns the pool's similarities into standard scores and the
  boost ramps from `SEMANTIC_MATCH_Z` (1σ, nothing) to `SEMANTIC_FULL_Z` (3σ, the lot); pools under
  `SEMANTIC_MIN_POOL` (4), or with no spread, score nothing. A boosted memory counts as a `match`, so meaning alone
  can answer a `recall` whose words appear nowhere, while tags and words keep their score — hybrid, not replaced.
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
  array in the reply (tolerate fences); each candidate → dedupe against existing (token Jaccard ≥ 0.6, or
  `EmbeddingService.duplicateOf`: a cosine at least `SEMANTIC_DUPLICATE_FRACTION` (0.75) of the way from the
  candidate's own baseline similarity to the pool up to 1, over a pool of at least `SEMANTIC_DUPLICATE_MIN_POOL` (5)
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
`MemoryStorage`; vectors live in a second aggregate, `embeddings` (one `MemoryVectorCache` per characterRef under
`embeddings/`) and not on `MemoryEntry` — entries cross IPC to the panel and are rewritten on every recall, and a
few hundred floats each would make both far more expensive.

## Embeddings (`src/services/embeddings.ts`)

`EmbeddingService` never throws into a turn and never holds one up for long; anything that goes wrong degrades to
keyword ranking.

- **Embedder**: `settings.memory.embeddingModel` with `embeddingProviderId` (default: the default provider) when that
  provider implements `embed()`, otherwise `EngineOptions.localEmbedder` — an on-device model the host supplies,
  resolved lazily and at most once. Neither → `similarities()` returns `undefined` and ranking stays lexical.
  `settings.memory.semanticRanking` (default true) is the master switch; `duplicateOf` is the consolidation check.
- **Cache**: `Storage.embeddings`, keyed by memory id with a hash of the embedded text (`text [tags]` — tags are part
  of what a memory means), so an edited memory re-embeds itself, a deleted one is pruned on the next pass, and a
  changed model invalidates the file whole. Vectors are stored as base64 float32.
- **Budget**: `EMBED_BATCH_SIZE` (64) texts per request, at most `EMBED_BACKLOG_PER_CALL` (128) new memories per call
  — a cold cache at the 500-memory cap is worked off over a few turns instead of making one reply wait for all of it.
  Query vectors are cached in memory (the focus text repeats across a conversation).
- **Failure**: logged once, not retried for a minute; the turn ranks lexically meanwhile.
- `check()` embeds one short text and reports `EmbeddingStatus` (`source`/`label`/`dims`/`problem`) for the settings
  screen — the only honest test of an endpoint and a model name that are invisible from the chat window otherwise.

Tests: rank scoring (tags beat body words, importance/recency tie-breaks, the same standard scores for two models
with different baselines, a boost only for standing out), `EmbeddingService` (cache re-use and invalidation, backlog,
failure cooldown, on-device fallback, `duplicateOf`), recall of a memory sharing no word with the query, forPrompt
budget and dedupe, consolidate with MockProvider returning fenced JSON (adds, dedupes, prunes, emits event), handler
limits, FileStorage round-trip.

## Renderer

- **Settings → Memory**: a "Recall by meaning" switch, the embeddings provider picker, the embedding model field and
  a **Check embedder** button showing what `memories.embeddingStatus()` reports.
- **Memories panel** per character (from the session's character; open from the character header and
  from the Packs view): list with search box, importance stars (editable), tags (editable chips), text
  (inline edit), source badge, "Forget" button with confirm, "Add memory" form, "Consolidate now" button
  (calls `memories.consolidate(sessionId)` when a session is open). The search box filters locally as before and, for
  queries of three characters or more, also asks `memories.search(characterRef, query, 5)` (debounced, `touch: false`)
  and lists the hits the word filter missed under "Not a word match, but about the same thing".
- A subtle "remembered: …" toast when `memory-added` arrives for the open session.

## Desktop main

`IpcApi.memories` → `engine.memories` service methods (`search` passes `touch: false`; `embeddingStatus` calls
`engine.embeddings.check()`); forward `memory-added` like other chat events.
