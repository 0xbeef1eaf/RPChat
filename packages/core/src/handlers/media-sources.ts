import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { MEDIA_SOURCES_MODULE_ID } from '@rp/sdk';
import type { MediaSourceService } from '../services/media-sources.js';

/**
 * `sdk.mediaSources`: list and search the remote media sources plugins provide. The handler is
 * always attached; the module's spec is only registered while a source is (see `Engine`), and
 * the dispatcher refuses calls to a module the registry does not have.
 */
export class MediaSourcesHandler implements CapabilityHandler {
  readonly moduleId = MEDIA_SOURCES_MODULE_ID;

  constructor(private readonly sources: MediaSourceService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'list':
        return this.sources.list().map((s) => ({ id: s.id, title: s.title, description: s.description, kinds: s.kinds }));
      case 'search':
        return (await this.sources.search(args[0], args[1], context)) as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.mediaSources.${method}`);
    }
  }
}
