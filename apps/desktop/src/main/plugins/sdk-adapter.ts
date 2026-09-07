/**
 * `validatePluginManifest` / `loadPluginModuleSpecs` from `@rp/sdk` (being added
 * concurrently). Resolved at call time; a local fallback with the same contract
 * keeps the desktop working (and its tests green) until they land.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as sdk from '@rp/sdk';
import { validateModuleSpec } from '@rp/sdk';
import type { CapabilityModuleSpec, PluginManifest, PluginModuleManifest } from '@rp/shared';
import { RpError } from '@rp/shared';
import { normalizeRelativePath, resolveAssetPath } from '@rp/pack';

const PLUGIN_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const MODULE_ID = /^[a-z][a-zA-Z0-9]*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;
const PERMISSIONS = new Set(['trusted', 'pack', 'prompt']);

interface SdkPluginApi {
  validatePluginManifest?(json: unknown): PluginManifest;
  loadPluginModuleSpecs?(pluginDir: string, manifest: PluginManifest): Promise<CapabilityModuleSpec[]>;
}

function api(): SdkPluginApi {
  return sdk as unknown as SdkPluginApi;
}

/** Structural validation of `plugin.json` (fallback for `@rp/sdk.validatePluginManifest`). */
export function validatePluginManifestFallback(json: unknown): PluginManifest {
  const problems: string[] = [];
  const m = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  if (!m) throw new RpError('INVALID_ARGUMENT', 'plugin.json must be a JSON object');
  if (typeof m.id !== 'string' || !PLUGIN_ID.test(m.id)) problems.push('id must be a reverse-DNS id, e.g. com.me.clock');
  if (typeof m.name !== 'string' || m.name.trim().length === 0) problems.push('name is required');
  if (typeof m.version !== 'string' || m.version.trim().length === 0) problems.push('version is required');
  if (m.main !== undefined && (typeof m.main !== 'string' || !normalizeRelativePath(m.main).ok)) problems.push('main must be a relative path');
  if (!Array.isArray(m.modules) || m.modules.length === 0) problems.push('modules must be a non-empty array');
  const ids = new Set<string>();
  for (const [i, raw] of (Array.isArray(m.modules) ? m.modules : []).entries()) {
    const mod = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const where = `modules[${i}]`;
    if (typeof mod.id !== 'string' || !MODULE_ID.test(mod.id)) problems.push(`${where}.id must match /^[a-z][a-zA-Z0-9]*$/`);
    else if (ids.has(mod.id)) problems.push(`${where}.id "${mod.id}" is duplicated`);
    else ids.add(mod.id);
    for (const key of ['version', 'title', 'summary'] as const) if (typeof mod[key] !== 'string' || (mod[key] as string).length === 0) problems.push(`${where}.${key} is required`);
    if (typeof mod.permission !== 'string' || !PERMISSIONS.has(mod.permission)) problems.push(`${where}.permission must be trusted, pack or prompt`);
    if (typeof mod.apiTypeName !== 'string' || !TYPE_NAME.test(mod.apiTypeName)) problems.push(`${where}.apiTypeName must be a PascalCase interface name`);
    if (typeof mod.typings !== 'string' && typeof mod.typingsText !== 'string') problems.push(`${where} needs typings (file) or typingsText`);
    if (typeof mod.docs !== 'string' && typeof mod.docsText !== 'string') problems.push(`${where} needs docs (file) or docsText`);
    if (!mod.methods || typeof mod.methods !== 'object' || Object.keys(mod.methods as object).length === 0) problems.push(`${where}.methods must list at least one method`);
  }
  if (problems.length > 0) throw new RpError('INVALID_ARGUMENT', `Invalid plugin.json:\n${problems.join('\n')}`, { problems });
  return m as unknown as PluginManifest;
}

async function readRelative(pluginDir: string, rel: string, what: string): Promise<string> {
  try {
    return await fs.readFile(resolveAssetPath(pluginDir, rel), 'utf8');
  } catch (err) {
    throw new RpError('INVALID_ARGUMENT', `${what} file "${rel}" cannot be read: ${(err as Error).message}`, undefined, { cause: err });
  }
}

/** Build + validate `CapabilityModuleSpec`s from a manifest (fallback for `@rp/sdk.loadPluginModuleSpecs`). */
export async function loadPluginModuleSpecsFallback(pluginDir: string, manifest: PluginManifest): Promise<CapabilityModuleSpec[]> {
  const specs: CapabilityModuleSpec[] = [];
  const problems: string[] = [];
  for (const mod of manifest.modules as PluginModuleManifest[]) {
    const typings = mod.typingsText ?? (mod.typings ? await readRelative(pluginDir, mod.typings, `modules.${mod.id} typings`) : '');
    const docs = mod.docsText ?? (mod.docs ? await readRelative(pluginDir, mod.docs, `modules.${mod.id} docs`) : '');
    const spec: CapabilityModuleSpec = {
      id: mod.id,
      version: mod.version,
      title: mod.title,
      summary: mod.summary,
      permission: mod.permission,
      apiTypeName: mod.apiTypeName,
      typings,
      docs,
      methods: mod.methods,
    };
    const issues = validateModuleSpec(spec);
    if (issues.length > 0) problems.push(...issues.map((p) => `${mod.id}: ${p}`));
    specs.push(spec);
  }
  if (problems.length > 0) throw new RpError('INVALID_ARGUMENT', `Plugin ${manifest.id} declares invalid modules:\n${problems.join('\n')}`, { problems });
  return specs;
}

export function validatePluginManifest(json: unknown): PluginManifest {
  const fn = api().validatePluginManifest;
  return typeof fn === 'function' ? fn(json) : validatePluginManifestFallback(json);
}

export function loadPluginModuleSpecs(pluginDir: string, manifest: PluginManifest): Promise<CapabilityModuleSpec[]> {
  const fn = api().loadPluginModuleSpecs;
  return typeof fn === 'function' ? fn(pluginDir, manifest) : loadPluginModuleSpecsFallback(pluginDir, manifest);
}

export const PLUGIN_MANIFEST_FILENAME = 'plugin.json';

export async function readPluginManifest(dir: string): Promise<PluginManifest> {
  const file = path.join(dir, PLUGIN_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new RpError('NOT_FOUND', `${file} not found`, undefined, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new RpError('INVALID_ARGUMENT', `${file} is not valid JSON: ${(err as Error).message}`);
  }
  return validatePluginManifest(json);
}
