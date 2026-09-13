import type { CapabilityRegistry } from '@rp/sdk';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';

/** `sdk.help`: full typings and docs of an available module, on demand (the prompt only carries the abridged index). */
export class HelpHandler implements CapabilityHandler {
  readonly moduleId = 'help';

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly permissions: { allowedModules(packId: string): Promise<string[]> },
  ) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const allowed = await this.permissions.allowedModules(context.packId);
    switch (method) {
      case 'modules':
        return this.registry
          .list()
          .filter((spec) => allowed.includes(spec.id))
          .map((spec) => ({ id: spec.id, title: spec.title, summary: spec.summary }));
      case 'module': {
        const id = args[0];
        if (typeof id !== 'string' || id.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'module id must be a non-empty string');
        const key = id.trim().replace(/^sdk\./, '');
        const spec = this.registry.get(key);
        if (!spec || !allowed.includes(spec.id)) throw new RpError('NOT_FOUND', `sdk.${key} is not available (available: ${allowed.join(', ')})`);
        return { id: spec.id, title: spec.title, typings: spec.typings, docs: spec.docs };
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.help.${method}`);
    }
  }
}
