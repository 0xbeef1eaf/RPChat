/**
 * Identifier types shared across packages. They are plain strings at runtime;
 * the aliases exist to make signatures self-documenting.
 */

/** Reverse-DNS pack id, e.g. `com.example.luna`. Pattern: /^[a-z0-9]+(\.[a-z0-9-]+)+$/ */
export type PackId = string;
/** Character id, unique within its pack. Pattern: /^[a-z0-9][a-z0-9-_]*$/ */
export type CharacterId = string;
/** A character addressed globally: `${packId}/${characterId}`. */
export type CharacterRef = string;
export type SessionId = string;
export type MessageId = string;
export type ActionId = string;
export type TimerId = string;
export type MediaItemId = string;
export type CallId = string;
export type ProviderId = string;

export function characterRef(packId: PackId, characterId: CharacterId): CharacterRef {
  return `${packId}/${characterId}`;
}

export function parseCharacterRef(ref: CharacterRef): { packId: PackId; characterId: CharacterId } {
  const idx = ref.lastIndexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new Error(`Invalid character ref: ${ref}`);
  }
  return { packId: ref.slice(0, idx), characterId: ref.slice(idx + 1) };
}

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

/** Any JSON-serialisable value. Everything crossing the sandbox boundary must be `Json`. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
