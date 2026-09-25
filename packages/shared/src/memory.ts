import type { CharacterRef, SessionId } from './ids.js';

/** Importance 1 (trivia) .. 5 (defining fact about the user or the relationship). */
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;

export type MemorySource = 'character' | 'consolidation' | 'user';

/**
 * One long-term memory of a character about the user, the relationship or past events.
 * Memories are per character (across sessions), ranked into the prompt automatically,
 * and editable by the user.
 */
export interface MemoryEntry {
  id: string;
  characterRef: CharacterRef;
  /** One to three sentences, written in the character's voice about what they remember. */
  text: string;
  tags: string[];
  importance: MemoryImportance;
  source: MemorySource;
  /** Session in which the memory formed, if any. */
  sessionId?: SessionId;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt?: string;
  recallCount: number;
}

/**
 * One character's memory vectors, cached beside the memories themselves.
 *
 * Kept out of `MemoryEntry` on purpose: entries cross IPC to the memories panel and are rewritten
 * whenever a recall bumps `recallCount`, and a few hundred floats per entry would make both of
 * those far more expensive than they are.
 */
export interface MemoryVectorCache {
  /** The embedder that produced every vector here (`EmbeddingStatus.label`); a change invalidates the file. */
  embedder: string;
  /** Vector width, so a truncated or mismatched file can be spotted without decoding. */
  dims: number;
  /** Memory id → the embedded text's hash (a stale one is re-embedded) and a base64 float32 vector. */
  vectors: Record<string, { hash: string; data: string }>;
}

/** What `IpcApi.memories.embeddingStatus()` reports, so settings can say whether semantic ranking is live. */
export interface EmbeddingStatus {
  /** Where vectors come from right now; `none` means memories are ranked by keywords alone. */
  source: 'provider' | 'local' | 'none';
  /** Human-readable embedder id (`ollama / nomic-embed-text`). */
  label?: string;
  /** Vector width, once something has actually been embedded. */
  dims?: number;
  /** Why there is no embedder, or why the last attempt failed. */
  problem?: string;
}

export interface MemorySettings {
  /** Master switch for automatic consolidation and prompt injection. Default true. */
  enabled: boolean;
  /**
   * Rank memories by meaning (embeddings) as well as by keywords. Default true, and harmless
   * without an embedder configured: the keyword ranking then stands on its own.
   */
  semanticRanking: boolean;
  /** Provider that embeds; unset falls back to the default chat provider when it supports embeddings. */
  embeddingProviderId?: string;
  /**
   * Embedding model, e.g. `nomic-embed-text` (Ollama) or `text-embedding-3-small` (OpenAI). Unset
   * means the provider path is off — an embedding model id cannot be guessed from a chat one.
   */
  embeddingModel?: string;
  /** Run consolidation after this many assistant turns in a session (and at session end). Default 6. */
  consolidateEveryTurns: number;
  /** Maximum memories kept per character; lowest importance/least recalled are pruned first. Default 500. */
  maxEntriesPerCharacter: number;
  /** Approximate token budget for memories injected into the prompt. Default 1500. */
  promptBudgetTokens: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  semanticRanking: true,
  consolidateEveryTurns: 6,
  maxEntriesPerCharacter: 500,
  promptBudgetTokens: 1500,
};
