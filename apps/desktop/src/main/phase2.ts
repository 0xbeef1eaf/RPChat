/**
 * Adapter for the phase-2 core surface (docs/spec/living.md §3.1). Core adds
 * these members concurrently; every access goes through here so a missing one
 * fails with a clear error instead of an undefined call.
 */
import type { Engine } from '@rp/core';
import type { EventSubscription, HostEvent, HostEventName, MoodState, PackInspection, PresenceSnapshot, RoutineEntry, RoutineStatus } from '@rp/shared';
import { RpError } from '@rp/shared';

/** Host → core presence provider (mirrors `SensesProvider` in core). */
export interface SensesProviderLike {
  snapshot(sessionId?: string): Promise<PresenceSnapshot>;
  subscribe(listener: (event: HostEvent) => void): () => void;
  setInterest?(events: HostEventName[]): void;
}

export interface Phase2Engine {
  hostEvents?: { emit(event: HostEvent): void };
  mood?: { get(characterRef: string): Promise<MoodState> | MoodState };
  routine?: { status(characterRef: string): Promise<RoutineStatus> | RoutineStatus; entries(characterRef: string): Promise<RoutineEntry[]> | RoutineEntry[] };
  subscriptions?: { list(sessionId?: string): Promise<EventSubscription[]>; remove(id: string): Promise<unknown> };
  packs: { inspect?(sourcePath: string): Promise<PackInspection> };
  permissions: { effective?(packId: string): Promise<{ effective: string[]; blockedByPolicy: string[] }> | { effective: string[]; blockedByPolicy: string[] } };
  llm?: { describeImage(sessionId: string, pngBase64: string, question?: string): Promise<string> };
}

export function phase2(engine: Engine): Phase2Engine {
  return engine as unknown as Phase2Engine;
}

export function unavailable(what: string): RpError {
  return new RpError('INTERNAL', `${what} is not available in this build of @rp/core`);
}

/** Push a host event into core (no-op with a debug line when core has no event service yet). */
export function emitHostEvent(engine: Engine, event: HostEvent, logger?: Pick<Console, 'debug'>): void {
  const p = phase2(engine);
  if (p.hostEvents?.emit) p.hostEvents.emit(event);
  else logger?.debug?.(`[phase2] dropped host event ${event.name} (core has no hostEvents)`);
}
