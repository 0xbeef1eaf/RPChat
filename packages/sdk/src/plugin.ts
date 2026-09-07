/**
 * SDK plugins: `plugin.json` manifest schema and loading of the capability module
 * specs a plugin declares. The host implementation (`main`) is loaded by `@rp/core`;
 * this file only deals with the declarative part (typings, docs, methods).
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RpError } from '@rp/shared';
import type { CapabilityModuleSpec, PluginManifest, PluginModuleManifest } from '@rp/shared';
import { API_TYPE_NAME_PATTERN, METHOD_KEY_PATTERN, MODULE_ID_PATTERN, SEMVER_PATTERN, validateModuleSpec } from './validate.js';

/** Reverse-DNS plugin id, e.g. `com.me.clock` (same shape as pack ids). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must be a non-empty string`);
const semver = (label: string) => z.string().regex(SEMVER_PATTERN, `${label} must be semver (major.minor.patch)`);

/** A path relative to the plugin dir: forward slashes, no absolute paths, no `..` segments. */
const relativePath = (label: string) =>
  z
    .string()
    .min(1, `${label} must be a non-empty relative path`)
    .refine((p) => !isEscapingPath(p), `${label} must be a relative path inside the plugin directory (no absolute paths or "..")`);

const permissionLevel = z.enum(['trusted', 'pack', 'prompt']);

export const pluginMethodSchema = z.object({
  description: nonEmpty('description'),
  permission: permissionLevel.optional(),
  dangerous: z.boolean().optional(),
});

export const pluginModuleSchema = z
  .object({
    id: z.string().regex(MODULE_ID_PATTERN, `module id must match ${MODULE_ID_PATTERN}`),
    version: semver('module version'),
    title: nonEmpty('title'),
    summary: nonEmpty('summary'),
    permission: permissionLevel,
    apiTypeName: z.string().regex(API_TYPE_NAME_PATTERN, `apiTypeName must match ${API_TYPE_NAME_PATTERN}`),
    typings: relativePath('typings').optional(),
    typingsText: nonEmpty('typingsText').optional(),
    docs: relativePath('docs').optional(),
    docsText: nonEmpty('docsText').optional(),
    methods: z.record(
      z.string().regex(METHOD_KEY_PATTERN, `method keys must be "name" or "group.name"`),
      pluginMethodSchema,
    ),
  })
  .superRefine((m, ctx) => {
    if (m.typings === undefined && m.typingsText === undefined) {
      ctx.addIssue({ code: 'custom', message: 'one of "typings" (file) or "typingsText" (inline) is required', path: ['typings'] });
    } else if (m.typings !== undefined && m.typingsText !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'give either "typings" or "typingsText", not both', path: ['typings'] });
    }
    if (m.docs === undefined && m.docsText === undefined) {
      ctx.addIssue({ code: 'custom', message: 'one of "docs" (file) or "docsText" (inline) is required', path: ['docs'] });
    } else if (m.docs !== undefined && m.docsText !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'give either "docs" or "docsText", not both', path: ['docs'] });
    }
  });

/** Schema of `plugin.json`. Built-in id collisions are checked by core at registration time, not here. */
export const pluginManifestSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN, `plugin id must be reverse-DNS, e.g. "com.me.clock"`),
    name: nonEmpty('name'),
    version: semver('version'),
    description: z.string().optional(),
    author: z.object({ name: nonEmpty('author.name'), url: z.string().optional() }).optional(),
    homepage: z.string().optional(),
    main: relativePath('main').optional(),
    minAppVersion: semver('minAppVersion').optional(),
    modules: z.array(pluginModuleSchema).min(1, 'modules must declare at least one module'),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.modules.forEach((mod, i) => {
      if (seen.has(mod.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate module id "${mod.id}"`, path: ['modules', i, 'id'] });
      }
      seen.add(mod.id);
    });
  });

export interface PluginManifestIssue {
  /** Dotted path into the manifest, e.g. `modules.0.typings`. */
  path: string;
  message: string;
}

/**
 * Validate parsed `plugin.json` content. Returns the typed manifest or throws
 * `RpError('INVALID_ARGUMENT')` whose `details.issues` lists every problem.
 */
export function validatePluginManifest(json: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(json);
  if (!result.success) {
    const issues: PluginManifestIssue[] = result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    throw new RpError('INVALID_ARGUMENT', `Invalid plugin manifest: ${summary}`, { issues });
  }
  return result.data as PluginManifest;
}

/**
 * Build the `CapabilityModuleSpec`s declared by a plugin manifest. `typings`/`docs` files are
 * read relative to `pluginDir` (they must stay inside it, symlinks included — `PATH_ESCAPE`
 * otherwise; `NOT_FOUND` when missing). Every spec is checked with `validateModuleSpec`; if
 * any module has problems, one `INVALID_ARGUMENT` error lists all of them in `details.modules`.
 */
export async function loadPluginModuleSpecs(pluginDir: string, manifest: PluginManifest): Promise<CapabilityModuleSpec[]> {
  const root = await realpath(path.resolve(pluginDir)).catch(() => {
    throw new RpError('NOT_FOUND', `Plugin directory not found: ${pluginDir}`, { pluginDir });
  });

  const specs: CapabilityModuleSpec[] = [];
  const failures: Array<{ module: string; problems: string[] }> = [];
  for (const mod of manifest.modules) {
    const typings = mod.typingsText ?? (await readPluginFile(root, requireField(mod, 'typings'), mod.id));
    const docs = mod.docsText ?? (await readPluginFile(root, requireField(mod, 'docs'), mod.id));
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
    const problems = validateModuleSpec(spec);
    if (problems.length > 0) failures.push({ module: mod.id, problems });
    else specs.push(spec);
  }

  if (failures.length > 0) {
    const summary = failures.map((f) => `${f.module}: ${f.problems.join('; ')}`).join(' | ');
    throw new RpError('INVALID_ARGUMENT', `Plugin "${manifest.id}" declares invalid module specs — ${summary}`, {
      pluginId: manifest.id,
      modules: failures,
    });
  }
  return specs;
}

function requireField(mod: PluginModuleManifest, field: 'typings' | 'docs'): string {
  const value = mod[field];
  if (value === undefined) {
    throw new RpError('INVALID_ARGUMENT', `Module "${mod.id}" has neither "${field}" nor "${field}Text"`, { module: mod.id, field });
  }
  return value;
}

/** True for absolute paths, drive-letter paths and any `..` segment. */
export function isEscapingPath(p: string): boolean {
  if (path.isAbsolute(p) || path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return true;
  return p.split(/[\\/]+/).some((seg) => seg === '..');
}

async function readPluginFile(root: string, relative: string, moduleId: string): Promise<string> {
  const details = { module: moduleId, path: relative };
  if (isEscapingPath(relative)) {
    throw new RpError('PATH_ESCAPE', `Module "${moduleId}": path "${relative}" escapes the plugin directory`, details);
  }
  const resolved = path.resolve(root, relative);
  if (!isInside(root, resolved)) {
    throw new RpError('PATH_ESCAPE', `Module "${moduleId}": path "${relative}" escapes the plugin directory`, details);
  }
  const real = await realpath(resolved).catch(() => {
    throw new RpError('NOT_FOUND', `Module "${moduleId}": file "${relative}" not found in the plugin directory`, details);
  });
  if (!isInside(root, real)) {
    throw new RpError('PATH_ESCAPE', `Module "${moduleId}": "${relative}" resolves outside the plugin directory (symlink)`, details);
  }
  return readFile(real, 'utf8');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
