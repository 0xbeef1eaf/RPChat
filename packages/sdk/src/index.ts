/**
 * @rp/sdk — capability module registry, the standard modules, and the
 * generators that turn module specs into `sdk.d.ts`, LLM docs and the
 * sandbox surface. Depends on `@rp/shared` only.
 */
import { CapabilityRegistry } from './registry.js';
import { standardModules } from './modules/index.js';

export { CapabilityRegistry } from './registry.js';
export { validateModuleSpec } from './validate.js';
export {
  generateSdkTypings,
  generateSdkDocs,
  describeSurface,
  GENERAL_DOCS,
  CONSOLE_TYPINGS,
  TYPINGS_HEADER,
} from './generate.js';
export type { GenerateTypingsOptions, GenerateDocsOptions, DescribeSurfaceOptions } from './generate.js';
export { SDK_PREAMBLE_TYPINGS } from './preamble.js';
export {
  pluginManifestSchema,
  pluginModuleSchema,
  pluginMethodSchema,
  validatePluginManifest,
  loadPluginModuleSpecs,
  isEscapingPath,
  PLUGIN_ID_PATTERN,
} from './plugin.js';
export type { PluginManifestIssue } from './plugin.js';
export * as modules from './modules/index.js';

/** A registry with all v1 standard modules registered (chat, log, state, pack, timers, media, ui, system). */
export function createStandardRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const spec of standardModules) registry.register(spec);
  return registry;
}
