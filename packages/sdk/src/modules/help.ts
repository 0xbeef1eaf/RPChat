import type { CapabilityModuleSpec } from '@rp/shared';

export const helpModule: CapabilityModuleSpec = {
  id: 'help',
  version: '1.0.0',
  title: 'SDK help',
  summary: 'Look up the full typings and guide of any granted sdk module on demand.',
  permission: 'trusted',
  apiTypeName: 'HelpApi',
  typings: `/**
 * The SDK index in your prompt is abridged. When you need the exact options, return
 * shapes or pitfalls of a module, fetch its complete reference here instead of guessing.
 */
interface HelpApi {
  /** The granted modules with their one-line summaries. */
  modules(): Promise<Array<{ id: string; title: string; summary: string }>>;
  /**
   * Complete TypeScript typings and the usage guide of one granted module.
   * @param id Module id as it appears on sdk, e.g. "media".
   * @example const ref = await sdk.help.module("media"); sdk.log.info(ref.typings);
   */
  module(id: string): Promise<{ id: string; title: string; typings: string; docs: string }>;
}`,
  docs: `Fetch the full reference of a module when the index in your prompt is not enough. The result comes back as the action result; read it, then act in your next action.

- Costs one action round; do it only when you are unsure about a signature or option.
- Only granted modules can be looked up; others fail with \`NOT_FOUND\`.

\`\`\`ts
const ref = await sdk.help.module("avatar");
return ref.typings;
\`\`\``,
  methods: {
    modules: { description: 'List granted modules.' },
    module: { description: 'Full typings and guide of one module.' },
  },
};
