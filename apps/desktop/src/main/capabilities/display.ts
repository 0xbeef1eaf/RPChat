/** `sdk.display`: read-only monitor list and backend capabilities. */
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { DisplayBackend } from '../display/backend.js';

export class DisplayHandler implements CapabilityHandler {
  readonly moduleId = 'display';

  constructor(private readonly backend: () => DisplayBackend) {}

  async invoke(method: string, _args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'monitors':
        return (await this.backend().monitors()) as unknown as Json;
      case 'backend':
        return this.backend().info() as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.display.${method}`);
    }
  }
}
