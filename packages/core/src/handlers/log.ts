import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import type { Logger } from '../types.js';

/**
 * `sdk.log`: the sandbox captures log calls itself; this handler only exists so a
 * routed call never fails. It forwards to the engine logger at debug level.
 */
export class LogHandler implements CapabilityHandler {
  readonly moduleId = 'log';

  constructor(private readonly logger: Logger) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    this.logger.debug(`[sdk.log.${method}] ${context.packId}/${context.characterId}`, ...args);
    return null;
  }
}
