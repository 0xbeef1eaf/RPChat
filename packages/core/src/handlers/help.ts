import type { CapabilityRegistry } from '@rp/sdk';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { AllowedModule } from '../services/permissions.js';
import { promptSelection } from '../services/permissions.js';

/**
 * `sdk.help`: full typings and docs of an available module, on demand (the prompt only carries the
 * abridged index). It is the prompt's own continuation, so it shows exactly what the index shows —
 * the functions the user allows, narrowed by the pack's `promptFunctions` — rather than everything
 * the character's code could reach.
 */
export class HelpHandler implements CapabilityHandler {
  readonly moduleId = 'help';

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly permissions: { allowedFunctions(packId: string): Promise<AllowedModule[]> },
    /** The character's `promptFunctions`, when it has one; `undefined` means "everything allowed". */
    private readonly promptFunctionsFor: (packId: string, characterId: string) => readonly string[] | undefined = () => undefined,
  ) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const listed = promptSelection(await this.permissions.allowedFunctions(context.packId), this.promptFunctionsFor(context.packId, context.characterId));
    const allowed = listed.map((m) => m.id);
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
        const entry = listed.find((m) => m.id === key);
        if (!spec || !entry) throw new RpError('NOT_FOUND', `sdk.${key} is not available (available: ${allowed.join(', ')})`);
        // The typings are one authored block per module, so a method that is not in `entry` cannot
        // be cut out of them; it is named instead, the way the generated docs name it.
        const hidden = Object.keys(spec.methods).filter((name) => !entry.methods.includes(name));
        const out: Record<string, Json> = { id: spec.id, title: spec.title, typings: spec.typings, docs: spec.docs };
        if (hidden.length > 0) out.unavailable = hidden.map((name) => `${spec.id}.${name}`);
        return out;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.help.${method}`);
    }
  }
}
