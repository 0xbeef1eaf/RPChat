/**
 * The app-enforced half of the policy's `app` block (docs/spec/system.md "Restrictions"):
 * operations a household admin can take away from this machine — the pack editor, removing or
 * rewriting packs, stopping a reply mid-generation, deleting sessions/history/memories,
 * unsubscribing event handlers, closing a character's media, the sandbox — plus
 * `requireCharacterSession`, which keeps the app inside a conversation.
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
  // 4. Stopping a reply that is already being generated.
  'chat:abort': { key: 'allowStopGeneration', what: 'Stopping a reply' },
  // 5. Delete Session / Delete History / Delete Memories.
  'sessions:remove': { key: 'allowDeleteSession', what: 'Deleting a session' },
  'sessions:clearMessages': { key: 'allowDeleteHistory', what: 'Deleting the chat history' },
  'sessions:removeMessage': { key: 'allowDeleteHistory', what: 'Deleting a message' },
  'memories:remove': { key: 'allowDeleteMemories', what: 'Deleting a memory' },
  // 6. Event handlers.
  'events:remove': { key: 'allowRemoveEvents', what: 'Removing an event handler' },
  // 7. Sweeping a character's media off the screen by hand.
  'media:closeAll': { key: 'allowCloseMedia', what: 'Closing a character’s media' },
  // 8. The sandbox.
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

/** Pure: the one sentence every refusal here is phrased as, so they all read alike. */
function denial(what: string, managedBy?: string): string {
  return `${what} is disabled by the system policy${managedBy ? ` (managed by ${managedBy})` : ''}`;
}

/**
 * Pure: why `channel` must be refused under `restrictions`, or `null` when it may proceed.
 * `managedBy` (the policy's free-text owner line) is appended so the UI can say who to ask.
 */
export function refusalFor(channel: string, restrictions: AppRestrictions, managedBy?: string): string | null {
  for (const rule of rulesFor(channel)) {
    if (restrictions[rule.key]) continue;
    return denial(rule.what, managedBy);
  }
  return null;
}

/**
 * The side doors out of `allowStopGeneration`. None of these channels is *for* stopping a reply,
 * but each aborts the turn in flight on its way to what it does do — so under a policy that says
 * a reply has to finish, each is refused while one is running, and works as usual otherwise.
 * `chat:abort` is not here: it exists only to stop, so it is refused outright by the table above.
 */
export const TURN_STOPPING_CHANNELS: ReadonlySet<string> = new Set([
  'chat:retry',
  'sessions:resetState',
  'sessions:removeMessage',
  'sessions:clearMessages',
]);

/** Pure: whether `channel` aborts a running turn as a side effect (so the dispatcher checks it). */
export function stopsRunningTurn(channel: string): boolean {
  return TURN_STOPPING_CHANNELS.has(channel);
}

/**
 * Pure: why a channel must be refused *because a reply is running*, or `null` when it may
 * proceed. Only meaningful for a `TURN_STOPPING_CHANNELS` member with a turn actually in flight;
 * the caller checks both, since whether a turn runs is not something this file can know.
 */
export function refusalForStoppingTurn(restrictions: AppRestrictions, managedBy?: string): string | null {
  if (restrictions.allowStopGeneration) return null;
  return `${denial('Stopping a reply', managedBy)}: wait for this one to finish`;
}

/** Pure: the restriction keys currently in force, sorted (for the policy log line and the UI). */
export function activeRestrictions(restrictions: AppRestrictions): string[] {
  return Object.entries(restrictions)
    .filter(([k, v]) => (k.startsWith('require') ? v === true : v === false))
    .map(([k]) => k)
    .sort();
}
