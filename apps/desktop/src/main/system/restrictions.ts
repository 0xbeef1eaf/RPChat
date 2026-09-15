/**
 * The app-enforced half of the policy's `app` block (docs/spec/system.md "Restrictions"):
 * operations a household admin can take away from this machine — the pack editor, removing or
 * rewriting packs, deleting sessions/history/memories, unsubscribing event handlers, the sandbox
 * — plus `requireCharacterSession`, which keeps the app inside a conversation.
 *
 * The `guard` block confines the session *around* the app with AppArmor; this confines the app
 * itself. Enforcement is one table consulted in `registerIpc`'s dispatch loop, so every guarded
 * channel is refused whoever asks: the UI, a devtools console, or a pack's own script. The
 * renderer hides the matching controls as well, but that is cosmetic — this is the real gate.
 *
 * Everything here is pure so the decisions are unit-tested without Electron.
 */
import type { AppRestrictions } from '@rp/shared';

/** One reason a channel can be refused: the restriction that forbids it and how to say so. */
export interface ChannelRule {
  key: keyof AppRestrictions;
  /** Sentence subject of the refusal, e.g. "Removing a pack is disabled by the system policy". */
  what: string;
}

/**
 * Channel → the restriction that forbids it. `"<ns>:*"` covers a whole namespace; a channel may
 * match both a wildcard and an exact rule and is refused when *either* forbids it (the pack
 * editor may be open while the pack store is still frozen, so `editor:installToApp` carries its
 * own `allowPackInstall` rule on top of the namespace's `allowPackEditor`).
 */
export const RESTRICTED_CHANNELS: Readonly<Record<string, ChannelRule>> = {
  // 1. The pack editor, whole namespace.
  'editor:*': { key: 'allowPackEditor', what: 'The pack editor' },
  // 2. Removing packs.
  'packs:uninstall': { key: 'allowPackRemove', what: 'Removing a pack' },
  // 3. Writing packs to disk — installing one is how a pack is added *or replaced*.
  'packs:install': { key: 'allowPackInstall', what: 'Installing a pack' },
  'editor:installToApp': { key: 'allowPackInstall', what: 'Installing a pack' },
  // 4. Delete Session / Delete History / Delete Memories.
  'sessions:remove': { key: 'allowDeleteSession', what: 'Deleting a session' },
  'sessions:clearMessages': { key: 'allowDeleteHistory', what: 'Deleting the chat history' },
  'sessions:removeMessage': { key: 'allowDeleteHistory', what: 'Deleting a message' },
  'memories:remove': { key: 'allowDeleteMemories', what: 'Deleting a memory' },
  // 7. Event handlers.
  'events:remove': { key: 'allowRemoveEvents', what: 'Removing an event handler' },
  // 6. The sandbox.
  'sandbox:run': { key: 'allowSandbox', what: 'Running a sandbox script' },
  'sandbox:cancel': { key: 'allowSandbox', what: 'Running a sandbox script' },
} as const;

/** Pure: every rule that applies to `channel` — its namespace wildcard first, then its own. */
export function rulesFor(channel: string): ChannelRule[] {
  const colon = channel.indexOf(':');
  if (colon < 0) return [];
  const out: ChannelRule[] = [];
  const wildcard = RESTRICTED_CHANNELS[`${channel.slice(0, colon)}:*`];
  if (wildcard) out.push(wildcard);
  const exact = RESTRICTED_CHANNELS[channel];
  if (exact) out.push(exact);
  return out;
}

/** Pure: whether any restriction could ever forbid `channel` (so the dispatcher can skip the rest). */
export function isRestrictable(channel: string): boolean {
  return rulesFor(channel).length > 0;
}

/**
 * Pure: why `channel` must be refused under `restrictions`, or `null` when it may proceed.
 * `managedBy` (the policy's free-text owner line) is appended so the UI can say who to ask.
 */
export function refusalFor(channel: string, restrictions: AppRestrictions, managedBy?: string): string | null {
  for (const rule of rulesFor(channel)) {
    if (restrictions[rule.key]) continue;
    return `${rule.what} is disabled by the system policy${managedBy ? ` (managed by ${managedBy})` : ''}`;
  }
  return null;
}

/** Pure: the restriction keys currently in force, sorted (for the policy log line and the UI). */
export function activeRestrictions(restrictions: AppRestrictions): string[] {
  return Object.entries(restrictions)
    .filter(([k, v]) => (k.startsWith('require') ? v === true : v === false))
    .map(([k]) => k)
    .sort();
}
