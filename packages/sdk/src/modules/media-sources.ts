import type { CapabilityModuleSpec, MediaSourceInfo } from '@rp/shared';

/** Property name of the module on `sdk`. Reserved: no plugin may declare a module with this id. */
export const MEDIA_SOURCES_MODULE_ID = 'mediaSources';

/**
 * `sdk.mediaSources`: search the remote media sources plugins provide. Unlike the standard modules
 * it is not always there — core registers it while at least one source is, so a character whose
 * user has no such plugin never reads about it — and its docs name the sources of the moment, so
 * the model knows where it can look without spending a call on `list()`.
 */
export function mediaSourcesModule(sources: readonly MediaSourceInfo[]): CapabilityModuleSpec {
  // The prompt renders a method's TSDoc rather than the docs' prose, so the list goes in both.
  const lines = sources.map((s) => `\`${s.id}\` — ${oneLine(s.title)} (${s.kinds.join(', ')}): ${oneLine(s.description)}`);
  const example = sources[0];
  const kind = example?.kinds[0] ?? 'image';
  const show = kind === 'image' ? 'showImage(pick, { durationMs: 8000 })' : kind === 'video' ? 'playVideo(pick)' : 'playAudio(pick)';
  return {
    id: MEDIA_SOURCES_MODULE_ID,
    version: '1.0.0',
    title: 'Remote media sources',
    summary: 'Search pictures, video and sound outside your pack (photo libraries, image sites, …) that the user\'s plugins connect.',
    permission: 'pack',
    apiTypeName: 'MediaSourcesApi',
    typings: `/**
 * Places outside your pack where you can find pictures, video and sound — whatever the user's
 * plugins connect (a photo library, an image site, a stock-media service). Results are AssetRefs
 * with source 'remote' that sdk.media.* shows like a pack asset; they are downloaded when shown.
 */
interface MediaSourcesApi {
  /**
   * The sources available right now (they come and go with the user's plugins).
   * @returns id (pass it to search), title, one-line description and the kinds of media each serves.
   * @example const sources = await sdk.mediaSources.list();
   */
  list(): Promise<Array<{ id: string; title: string; description: string; kinds: Array<'image' | 'video' | 'audio'> }>>;
  /**
   * Search one source. Throws NOT_FOUND for a source that is not there (any more).
   * @param source A source id from list(). Right now: ${lines.length > 0 ? lines.join('; ') : 'none'}.
   * @param query text: what you are looking for, in plain words; tags: tags the results should carry;
   *   kind: only this kind; limit: 1..50, default 20; page: 1-based, for more results of the same search.
   * @returns AssetRefs with source 'remote', best matches first as the source ranks them; empty when nothing matched.
   *   Pass one to sdk.media.showImage/playVideo/playAudio/overlay.
   * @example const [pic] = await sdk.mediaSources.search(${JSON.stringify(example?.id ?? 'com.example.photos/albums')}, { text: "beach at sunset", kind: ${JSON.stringify(kind)}, limit: 5 });
   */
  search(source: string, query?: { text?: string; tags?: string[]; kind?: 'image' | 'video' | 'audio'; limit?: number; page?: number }): Promise<AssetRef[]>;
}`,
    docs: `Media from outside your pack, through the user's plugins. Sources right now:

${lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : '- (none)'}

- Reach for a source when the pack has nothing fitting, or when the user asks for something specific ("a photo from our trip", "a cat video"). Prefer the pack for your own look and recurring moments.
- \`search\` returns AssetRefs (\`source: 'remote'\`, \`path\` "<source>/<item>"); hand one straight to \`sdk.media\`. The first show downloads it, so a big video takes a moment.
- Keep queries short and concrete. An empty result is an answer: say so, or try other words once — do not loop.
- Remote refs are good for this session; search again rather than storing them for later.

\`\`\`ts
const [pick] = await sdk.mediaSources.search(${JSON.stringify(example?.id ?? 'com.example.photos/albums')}, { text: "cozy rainy evening", kind: ${JSON.stringify(kind)}, limit: 5 });
if (pick) await sdk.media.${show};
\`\`\``,
    methods: {
      list: { description: 'List the remote media sources plugins provide.' },
      search: { description: 'Search one remote media source for images, video or audio.' },
    },
  };
}

/** Plugin-supplied text made safe for a TSDoc line: one line, no comment terminator, bounded. */
function oneLine(text: string): string {
  return text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim().slice(0, 200);
}
