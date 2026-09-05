/** `sdk.presence`: fresh numbers from the senses provider. */
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { SensesProviderLike } from '../phase2.js';

export class PresenceHandler implements CapabilityHandler {
  readonly moduleId = 'presence';

  constructor(private readonly senses: SensesProviderLike) {}

  async invoke(method: string, _args: Json[], context: ActionContext): Promise<Json | void> {
    const snap = await this.senses.snapshot(context.sessionId);
    switch (method) {
      case 'status':
        return snap as unknown as Json;
      case 'nowPlaying':
        return (snap.nowPlaying ?? null) as unknown as Json;
      case 'activeWindow':
        return (snap.activeWindow ?? null) as unknown as Json;
      case 'idleMs':
        return snap.idleMs;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.presence.${method}`);
    }
  }
}
