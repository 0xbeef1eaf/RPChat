import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { LibraryService } from '../services/library.js';

/**
 * `sdk.lib`: define / remove / list / source of the acting character's function
 * library. `define`'s `fn` arrives as a string: a function argument was
 * serialised by the sandbox to the action body that calls it (`return await
 * (<fn>)(input);`), which `LibraryService` unwraps; a plain string is taken as
 * the function expression itself.
 */
export class LibHandler implements CapabilityHandler {
  readonly moduleId = 'lib';

  constructor(private readonly library: LibraryService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const target = { packId: context.packId, characterId: context.characterId };
    switch (method) {
      case 'define': {
        const [name, fn, opts] = args;
        if (typeof fn !== 'string') throw new RpError('INVALID_ARGUMENT', 'fn must be a function (or a string holding a function expression)');
        const options: { description?: string } = {};
        if (opts !== undefined && opts !== null) {
          if (typeof opts !== 'object' || Array.isArray(opts)) throw new RpError('INVALID_ARGUMENT', 'opts must be an object');
          if (opts.description !== undefined && opts.description !== null) {
            if (typeof opts.description !== 'string') throw new RpError('INVALID_ARGUMENT', 'opts.description must be a string');
            options.description = opts.description;
          }
        }
        return this.library.define(target, name as string, fn, options) as Promise<Json>;
      }
      case 'remove':
        return this.library.remove(target, args[0] as string);
      case 'list':
        return this.library.list(target) as Promise<Json>;
      case 'source':
        return this.library.source(target, args[0] as string);
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.lib.${method}`);
    }
  }
}
