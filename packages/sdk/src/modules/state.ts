import type { CapabilityModuleSpec } from '@rp/shared';

export const stateModule: CapabilityModuleSpec = {
  id: 'state',
  version: '1.0.0',
  title: 'Memory',
  summary: 'Persistent key/value memory per character, plus per-session scratch space.',
  permission: 'trusted',
  apiTypeName: 'StateApi',
  typings: `/**
 * Key/value memory. The top-level methods are per character and persist across
 * sessions (long-term memory: facts about the user, preferences, progress).
 * The nested session store lives only as long as the current session (scratch
 * values, "what I already showed today"). Values must be Json and small (a few KiB).
 * The current character state is included in your prompt, so read it only when you
 * need a value you cannot see.
 */
interface StateApi {
  /**
   * Read a persistent value.
   * @param key Any short string, e.g. "user.name" or "favouriteSong".
   * @returns The stored Json value, or undefined if the key does not exist.
   * @example const name = await sdk.state.get("user.name");
   */
  get(key: string): Promise<Json | undefined>;
  /**
   * Store a persistent value (overwrites). Use to remember things the user told
   * you that should survive into future conversations.
   * @param key Short string key.
   * @param value Any Json value (object, array, string, number, boolean, null).
   * @example await sdk.state.set("user.birthday", "1990-05-12");
   */
  set(key: string, value: Json): Promise<void>;
  /** Remove a persistent key. No error if it does not exist. */
  delete(key: string): Promise<void>;
  /** All persistent keys, sorted. */
  keys(): Promise<string[]>;
  /** Every persistent key/value as one object. */
  all(): Promise<Record<string, Json>>;
  /**
   * Same API, but scoped to the current session: values disappear when the
   * session ends. Good for counters, "already greeted", temporary choices.
   */
  session: {
    /** Read a session-scoped value, or undefined if absent. */
    get(key: string): Promise<Json | undefined>;
    /** Store a session-scoped value (overwrites). @example await sdk.state.session.set("greeted", true); */
    set(key: string, value: Json): Promise<void>;
    /** Remove a session-scoped key. No error if it does not exist. */
    delete(key: string): Promise<void>;
    /** All session-scoped keys, sorted. */
    keys(): Promise<string[]>;
    /** Every session-scoped key/value as one object. */
    all(): Promise<Record<string, Json>>;
  };
}`,
  docs: `Remember things. \`sdk.state.*\` is long-term memory for this character (survives across sessions); \`sdk.state.session.*\` is scratch space for the current session only.

- Store small Json values under short, stable keys (\`"user.name"\`, \`"lastShownImage"\`). Do not store the transcript or large blobs.
- Your current persistent state is already shown in your prompt; write when you learn something worth keeping, read only what you cannot see.
- \`get\` returns \`undefined\` for missing keys — check before using the value.

\`\`\`ts
await sdk.state.set("user.petName", "Biscuit");
const shown = (await sdk.state.session.get("imagesShown")) ?? 0;
await sdk.state.session.set("imagesShown", (shown as number) + 1);
\`\`\``,
  methods: {
    get: { description: 'Read a persistent character value.' },
    set: { description: 'Write a persistent character value.' },
    delete: { description: 'Delete a persistent character value.' },
    keys: { description: 'List persistent character keys.' },
    all: { description: 'Read all persistent character values.' },
    'session.get': { description: 'Read a session-scoped value.' },
    'session.set': { description: 'Write a session-scoped value.' },
    'session.delete': { description: 'Delete a session-scoped value.' },
    'session.keys': { description: 'List session-scoped keys.' },
    'session.all': { description: 'Read all session-scoped values.' },
  },
};
