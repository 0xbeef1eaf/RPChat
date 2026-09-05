import type { ActionContext, CapabilityHandler, Json, Storage } from '@rp/shared';
import { RpError } from '@rp/shared';
import { jsonBytes } from '../types.js';

export const STATE_MAX_VALUE_BYTES = 32 * 1024;
export const STATE_MAX_KEYS = 200;
const KEY_MAX_CHARS = 200;

export function characterScope(context: Pick<ActionContext, 'packId' | 'characterId'>): string {
  return `char:${context.packId}/${context.characterId}`;
}

export function sessionScope(context: Pick<ActionContext, 'sessionId'>): string {
  return `session:${context.sessionId}`;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > KEY_MAX_CHARS) {
    throw new RpError('INVALID_ARGUMENT', `key must be a string of 1..${KEY_MAX_CHARS} characters`);
  }
  return value;
}

/** `sdk.state`: character-scoped persistent memory and `session.*` scratch space, with size caps. */
export class StateHandler implements CapabilityHandler {
  readonly moduleId = 'state';

  constructor(private readonly state: Storage['state']) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const [head, tail] = method.split('.', 2);
    const nested = tail !== undefined;
    const op = nested ? tail : head;
    if (nested && head !== 'session') throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.state.${method}`);
    const scope = nested ? sessionScope(context) : characterScope(context);

    switch (op) {
      case 'get':
        return this.state.get(scope, requireKey(args[0]));
      case 'set': {
        const key = requireKey(args[0]);
        const value = args.length > 1 ? args[1] : undefined;
        if (value === undefined) throw new RpError('INVALID_ARGUMENT', 'value is required (use delete to remove a key)');
        const bytes = jsonBytes(value);
        if (bytes > STATE_MAX_VALUE_BYTES) {
          throw new RpError('INVALID_ARGUMENT', `value is ${bytes} bytes; the limit is ${STATE_MAX_VALUE_BYTES} bytes per key`, {
            bytes,
            limit: STATE_MAX_VALUE_BYTES,
          });
        }
        const existing = await this.state.get(scope, key);
        if (existing === undefined) {
          const count = (await this.state.keys(scope)).length;
          if (count >= STATE_MAX_KEYS) {
            throw new RpError('INVALID_ARGUMENT', `this scope already holds ${STATE_MAX_KEYS} keys; delete some first`, {
              limit: STATE_MAX_KEYS,
            });
          }
        }
        await this.state.set(scope, key, value as Json);
        return;
      }
      case 'delete':
        await this.state.delete(scope, requireKey(args[0]));
        return;
      case 'keys':
        return this.state.keys(scope);
      case 'all':
        return this.state.all(scope);
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.state.${method}`);
    }
  }
}
