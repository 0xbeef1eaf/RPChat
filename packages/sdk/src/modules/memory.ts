import type { CapabilityModuleSpec } from '@rp/shared';

export const memoryModule: CapabilityModuleSpec = {
  id: 'memory',
  version: '1.0.0',
  title: 'Long-term memory',
  summary: 'Remember and recall facts about the user, the relationship and past events across sessions.',
  permission: 'trusted',
  apiTypeName: 'MemoryApi',
  typings: `/**
 * Your long-term memory: short natural-language notes that persist across sessions and are
 * ranked into your prompt automatically when relevant. The app also consolidates memories
 * from conversations on its own; use remember() for things worth keeping right now.
 * For structured data (counters, flags, handles) use sdk.state instead.
 */
interface MemoryApi {
  /**
   * Store a memory. Write it as you would recall it later ("They get anxious before Monday meetings").
   * @param text 1–3 sentences, max 500 characters.
   * @param options tags for retrieval (e.g. ["work", "anxiety"]); importance 1 (trivia) .. 5 (defining), default 3.
   * @example await sdk.memory.remember("Their cat is called Miso and sleeps on the keyboard.", { tags: ["pets"], importance: 3 });
   */
  remember(text: string, options?: { tags?: string[]; importance?: 1 | 2 | 3 | 4 | 5 }): Promise<MemoryEntry>;
  /**
   * Find memories relevant to a query (keyword and tag match, boosted by importance and recency).
   * @param query Free text or a few keywords.
   * @param limit Default 10, max 50.
   */
  recall(query: string, limit?: number): Promise<MemoryEntry[]>;
  /** Most recently formed memories, newest first. Default 10, max 50. */
  recent(limit?: number): Promise<MemoryEntry[]>;
  /** Change a memory's text, tags or importance. Fields you omit stay as they are. */
  update(id: string, patch: { text?: string; tags?: string[]; importance?: 1 | 2 | 3 | 4 | 5 }): Promise<MemoryEntry>;
  /** Delete a memory (for example when the user corrects you). */
  forget(id: string): Promise<boolean>;
}`,
  docs: `Keep and use long-term memories so you feel consistent across sessions. Always available.

- The most relevant memories are already in your prompt under <memory>; you do not need to recall() them again. Use recall() when you suspect there is something more specific to look up.
- remember() sparingly: things the user told you about themselves, promises made, recurring themes, inside jokes. Not the current small talk.
- When the user corrects a fact, update() or forget() the old memory in the same action.

\`\`\`ts
const hits = await sdk.memory.recall("birthday");
if (hits.length === 0) {
  await sdk.memory.remember("Their birthday is 14 March; they like low-key celebrations.", { tags: ["birthday"], importance: 4 });
}
\`\`\``,
  methods: {
    remember: { description: 'Store a long-term memory.' },
    recall: { description: 'Search memories by keywords/tags.' },
    recent: { description: 'List the newest memories.' },
    update: { description: 'Edit a memory.' },
    forget: { description: 'Delete a memory.' },
  },
};
