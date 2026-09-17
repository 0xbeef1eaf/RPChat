import type { CapabilityModuleSpec } from '@rp/shared';

export const helpModule: CapabilityModuleSpec = {
  id: 'help',
  version: '1.0.0',
  title: 'SDK help',
  summary: 'Look up the full typings and guide of any available sdk module on demand.',
  permission: 'trusted',
  apiTypeName: 'HelpApi',
  typings: `/**
 * The SDK index in your prompt is abridged. When you need the exact options, return
 * shapes or pitfalls of a module, fetch its complete reference here instead of guessing.
 */
interface HelpApi {
  /** The available modules with their one-line summaries. */
  modules(): Promise<Array<{ id: string; title: string; summary: string }>>;
  /**
   * Complete TypeScript typings and the usage guide of one available module.
   * @param id Module id as it appears on sdk, e.g. "media".
   * @returns The module's reference. \`unavailable\`, when present, names the functions of it you
   *   may not call even though the typings still describe them.
   * @example const ref = await sdk.help.module("media"); console.info(ref.typings);
   */
  module(id: string): Promise<{ id: string; title: string; typings: string; docs: string; unavailable?: string[] }>;
}`,
  docs: `Fetch the full reference of a module when the index in your prompt is not enough. The result comes back as the action result; read it, then act in your next action.

- Costs one action round; do it only when you are unsure about a signature or option.
- Only available modules can be looked up; others fail with \`NOT_FOUND\`. A module may be available with some of its functions switched off: those are listed in \`unavailable\` even though the typings still declare them.

\`\`\`ts
const ref = await sdk.help.module("avatar");
return ref.typings;
\`\`\``,
  methods: {
    modules: { description: 'List available modules.' },
    module: { description: 'Full typings and guide of one module.' },
  },
};
