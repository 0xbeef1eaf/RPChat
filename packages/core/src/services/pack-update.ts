/**
 * What happens to a character's conversation when its pack is installed over an earlier version:
 * the session follows the updated character instead of waiting for a restart (or, when the update
 * renamed the character id, instead of dying with NOT_FOUND).
 *
 * A pack has exactly one character (docs/spec/pack.md), so the pack's session is that character's
 * session whatever its id says: a rename moves the session's `characterRef` over, and with it the
 * character's own data — its state scope, memories and their cached vectors, pending timers and
 * event subscriptions. What the new pack says about the character (persona, behaviours, library,
 * avatar) is read from the loaded pack on every turn, so that needs nothing here.
 */
import type { LoadedPack, Storage } from '@rp/shared';
import { characterRef as refOf, parseCharacterRef } from '@rp/shared';
import { characterScope } from '../handlers/state.js';
import type { PackService } from './packs.js';
import { autoSessionTitle } from './sessions.js';
import type { TimerService } from './timers.js';
import type { Clock, Logger } from '../types.js';

export interface PackUpdateDeps {
  storage: Pick<Storage, 'sessions' | 'state' | 'memories' | 'embeddings' | 'subscriptions'>;
  packs: Pick<PackService, 'tryGetLoaded'>;
  timers: Pick<TimerService, 'list' | 'schedule'>;
  now: Clock;
  logger: Logger;
}

/**
 * Bring the sessions of `packId` up to date after the pack changed. `previous` is the pack as it
 * was loaded before (absent when the pack is new to this install, e.g. one installed over the
 * sessions an earlier uninstall left behind): it is what tells a title the app generated from a
 * title the user wrote, so without it every title is left alone. A no-op when the pack is not
 * loaded any more — that is the uninstall side of a pack change, where the session stays as it is.
 */
export async function followPackUpdate(deps: PackUpdateDeps, packId: string, previous?: LoadedPack): Promise<void> {
  const pack = deps.packs.tryGetLoaded(packId);
  if (!pack) return;
  const wantedRef = refOf(packId, pack.character.definition.id);
  const staleTitle = previous ? autoSessionTitle(previous.character.definition.name, previous.manifest.name) : undefined;
  const freshTitle = autoSessionTitle(pack.character.definition.name, pack.manifest.name);
  const moved = new Set<string>();

  for (const session of await deps.storage.sessions.list()) {
    if (!session.characterRef.startsWith(`${packId}/`)) continue;
    const next = { ...session };
    if (session.characterRef !== wantedRef) {
      if (!moved.has(session.characterRef)) {
        moved.add(session.characterRef);
        await moveCharacterData(deps, session.characterRef, wantedRef);
      }
      next.characterRef = wantedRef;
      deps.logger.info(`[packs] ${packId}: session ${session.id} follows the character renamed ${session.characterRef} → ${wantedRef}`);
    }
    // A title the user wrote stays; the one `SessionService.create` generated follows the new names.
    if (staleTitle !== undefined && session.title === staleTitle && session.title !== freshTitle) {
      next.title = freshTitle;
    }
    if (next.characterRef === session.characterRef && next.title === session.title) continue;
    next.updatedAt = deps.now().toISOString();
    await deps.storage.sessions.upsert(next);
  }
}

/**
 * Carry everything keyed by a character's ref over to the ref it has after a rename: its state
 * scope (`char:<ref>`, which is also where mood and routine live), its memories and their cached
 * vectors, and the pending timers and event subscriptions that name it. Keys already present under
 * the new ref win — the new pack shipped them, so they are what the author meant.
 */
async function moveCharacterData(deps: PackUpdateDeps, from: string, to: string): Promise<void> {
  const fromScope = characterScope(parseCharacterRef(from));
  const toScope = characterScope(parseCharacterRef(to));
  const values = await deps.storage.state.all(fromScope);
  for (const [key, value] of Object.entries(values)) {
    if ((await deps.storage.state.get(toScope, key)) === undefined) await deps.storage.state.set(toScope, key, value);
  }
  await deps.storage.state.clear(fromScope);

  const memories = await deps.storage.memories.list(from);
  for (const entry of memories) await deps.storage.memories.upsert({ ...entry, characterRef: to });
  const vectors = await deps.storage.embeddings.get(from);
  if (vectors) await deps.storage.embeddings.set(to, vectors);
  // Storage keyed per character (`FileStorage`: one file each) keeps the old entries until they go.
  await deps.storage.memories.removeForCharacter(from);
  await deps.storage.embeddings.removeForCharacter(from);

  for (const timer of await deps.timers.list({ characterRef: from })) await deps.timers.schedule({ ...timer, characterRef: to });
  for (const sub of await deps.storage.subscriptions.list()) {
    if (sub.characterRef === from) await deps.storage.subscriptions.upsert({ ...sub, characterRef: to });
  }
  deps.logger.info(`[packs] moved the character data of ${from} to ${to}: ${Object.keys(values).length} state key(s), ${memories.length} memory/ies`);
}
