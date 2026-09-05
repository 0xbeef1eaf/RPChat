import type { BehaviourHook, ChatEvent, CodeRunResult, Json, PermissionRequest, Session } from '@rp/shared';
import type { TypedEmitter } from './emitter.js';

export type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export type Clock = () => Date;

export interface EngineEvents extends Record<string, unknown> {
  chat: ChatEvent;
  'permission-request': PermissionRequest;
}

export type EngineEmitter = TypedEmitter<EngineEvents>;

/** Input handed to behaviour scripts (available inside the script as `input`). */
export type BehaviourInput = Json;

/**
 * Runs a character's behaviour script for a hook. Resolves `undefined` when the
 * character has no script for that hook. Implemented by `BehaviourRunner`; typed
 * as an interface so services created before it can be wired lazily.
 */
export interface BehaviourHooks {
  has(session: Session, hook: BehaviourHook): boolean;
  run(session: Session, hook: BehaviourHook, input?: BehaviourInput): Promise<CodeRunResult | undefined>;
}

export const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function isoNow(now: Clock): string {
  return now().toISOString();
}

/** Deep JSON round-trip: drops `undefined`, functions, and turns `undefined` itself into `null`. */
export function toJson(value: unknown): Json {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as Json);
}

export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}
