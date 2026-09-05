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

export interface MemorySettings {
  /** Master switch for automatic consolidation and prompt injection. Default true. */
  enabled: boolean;
  /** Run consolidation after this many assistant turns in a session (and at session end). Default 6. */
  consolidateEveryTurns: number;
  /** Maximum memories kept per character; lowest importance/least recalled are pruned first. Default 500. */
  maxEntriesPerCharacter: number;
  /** Approximate token budget for memories injected into the prompt. Default 1500. */
  promptBudgetTokens: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  consolidateEveryTurns: 6,
  maxEntriesPerCharacter: 500,
  promptBudgetTokens: 1500,
};
