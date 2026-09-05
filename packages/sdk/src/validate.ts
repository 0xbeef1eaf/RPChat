import type { CapabilityModuleSpec, PermissionLevel } from '@rp/shared';

/** Property name on the `sdk` global. */
export const MODULE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
/** Interface name declared in `typings`. */
export const API_TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Plain semver (`major.minor.patch`, optional pre-release / build suffix). */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** Method keys: `name` or `group.name` (one level of nesting). */
export const METHOD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)?$/;

const PERMISSION_LEVELS: ReadonlySet<string> = new Set<PermissionLevel>(['trusted', 'pack', 'prompt']);

/** A member of the api interface body that looks like a method (`name(` or `name<`). */
const METHOD_MEMBER = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[(<]/;
/** A member whose type is an inline object literal: `name: {` (one level of nesting, e.g. `session: {`). */
const GROUP_MEMBER = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*\{/;

/**
 * Validate a `CapabilityModuleSpec`. Returns a list of human-readable problems;
 * an empty list means the spec is valid. Purely regex/string based (no
 * TypeScript compiler at runtime) — see the tests for the compile check.
 *
 * Checks: id pattern, semver, permission level, non-empty title/summary/docs,
 * `typings` declares `interface <apiTypeName>` (no `import`/`export`), every
 * `methods` key is a method member of that interface (dotted keys address
 * members of a nested object-literal member), every method-looking member of
 * the interface is listed in `methods`, and every method member has TSDoc.
 */
export function validateModuleSpec(spec: CapabilityModuleSpec): string[] {
  const problems: string[] = [];
  if (spec === null || typeof spec !== 'object') return ['spec must be an object'];

  const { id, version, title, summary, permission, apiTypeName, typings, docs, methods } = spec;

  if (typeof id !== 'string' || !MODULE_ID_PATTERN.test(id)) {
    problems.push(`id must match ${MODULE_ID_PATTERN} (got ${JSON.stringify(id)})`);
  }
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    problems.push(`version must be semver (got ${JSON.stringify(version)})`);
  }
  if (typeof title !== 'string' || title.trim() === '') problems.push('title must be a non-empty string');
  if (typeof summary !== 'string' || summary.trim() === '') problems.push('summary must be a non-empty string');
  if (typeof permission !== 'string' || !PERMISSION_LEVELS.has(permission)) {
    problems.push(`permission must be one of trusted|pack|prompt (got ${JSON.stringify(permission)})`);
  }
  if (typeof apiTypeName !== 'string' || !API_TYPE_NAME_PATTERN.test(apiTypeName)) {
    problems.push(`apiTypeName must match ${API_TYPE_NAME_PATTERN} (got ${JSON.stringify(apiTypeName)})`);
  }
  if (typeof docs !== 'string' || docs.trim() === '') problems.push('docs must be a non-empty markdown string');

  // ---- methods record --------------------------------------------------
  const methodKeys: string[] = [];
  if (methods === null || typeof methods !== 'object' || Array.isArray(methods)) {
    problems.push('methods must be an object');
  } else {
    for (const [key, m] of Object.entries(methods)) {
      if (!METHOD_KEY_PATTERN.test(key)) {
        problems.push(`methods key ${JSON.stringify(key)} must be "name" or "group.name"`);
        continue;
      }
      methodKeys.push(key);
      if (m === null || typeof m !== 'object') {
        problems.push(`methods.${key} must be an object`);
        continue;
      }
      if (typeof m.description !== 'string' || m.description.trim() === '') {
        problems.push(`methods.${key}.description must be a non-empty string`);
      }
      if (m.permission !== undefined && !PERMISSION_LEVELS.has(m.permission)) {
        problems.push(`methods.${key}.permission must be one of trusted|pack|prompt`);
      }
      if (m.dangerous !== undefined && typeof m.dangerous !== 'boolean') {
        problems.push(`methods.${key}.dangerous must be a boolean`);
      }
    }
  }

  // ---- typings -----------------------------------------------------------
  if (typeof typings !== 'string' || typings.trim() === '') {
    problems.push('typings must be a non-empty string');
    return problems;
  }
  if (/^\s*(import|export)\b/m.test(typings)) {
    problems.push('typings must not contain import/export statements (they are emitted into a global declaration file)');
  }
  if (typeof apiTypeName !== 'string' || !API_TYPE_NAME_PATTERN.test(apiTypeName)) return problems;

  const body = extractInterfaceBody(stripComments(typings), apiTypeName);
  if (body === undefined) {
    problems.push(`typings must declare "interface ${apiTypeName} { ... }"`);
    return problems;
  }

  const members = scanMethodMembers(body);
  for (const key of methodKeys) {
    if (!members.includes(key)) {
      problems.push(`methods.${key} is not declared as a method of interface ${apiTypeName} in typings`);
    }
  }
  for (const member of members) {
    if (!methodKeys.includes(member)) {
      problems.push(`interface ${apiTypeName} declares method "${member}" which is missing from methods`);
    }
  }

  for (const member of findUndocumentedMethods(typings, apiTypeName)) {
    problems.push(`method "${member}" of interface ${apiTypeName} has no TSDoc comment`);
  }

  return problems;
}

/** Remove block and line comments (good enough for declaration sources without string literals containing them). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Return the text between the braces of `interface <name> { ... }`, or undefined. */
export function extractInterfaceBody(source: string, name: string): string | undefined {
  const decl = new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`);
  const m = decl.exec(source);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return undefined;
}

/**
 * List method-looking members of an interface body (comments already stripped):
 * `name` for top-level methods, `group.name` for methods inside a member whose
 * type is an inline object literal. Deeper nesting is ignored.
 */
export function scanMethodMembers(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let group: string | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line !== '') {
      if (depth === 0) {
        const method = METHOD_MEMBER.exec(line);
        if (method) {
          out.push(method[1]!);
        } else {
          const g = GROUP_MEMBER.exec(line);
          if (g && netBraces(line) > 0) group = g[1]!;
        }
      } else if (depth === 1 && group !== undefined) {
        const method = METHOD_MEMBER.exec(line);
        if (method) out.push(`${group}.${method[1]!}`);
      }
    }
    depth += netBraces(line);
    if (depth <= 0) {
      depth = 0;
      group = undefined;
    }
  }
  return out;
}

function netBraces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === '{') n++;
    else if (ch === '}') n--;
  }
  return n;
}

/** Method members (dotted for nested) of the interface that are not immediately preceded by a `/** ... *\/` comment. */
export function findUndocumentedMethods(typings: string, apiTypeName: string): string[] {
  const decl = new RegExp(`\\binterface\\s+${apiTypeName}\\b[^{]*\\{`);
  const m = decl.exec(typings);
  if (!m) return [];
  const start = m.index + m[0].length;
  const lines = typings.slice(start).split('\n');

  const out: string[] = [];
  let depth = 1; // inside the interface body
  let group: string | undefined;
  let inBlockComment = false;
  let previousEndsDoc = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false;
        previousEndsDoc = true;
      }
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      else previousEndsDoc = line.startsWith('/**');
      continue;
    }
    if (line.startsWith('//')) continue;

    if (depth === 1) {
      const method = METHOD_MEMBER.exec(line);
      if (method) {
        if (!previousEndsDoc) out.push(method[1]!);
      } else {
        const g = GROUP_MEMBER.exec(line);
        if (g && netBraces(line) > 0) group = g[1]!;
      }
    } else if (depth === 2 && group !== undefined) {
      const method = METHOD_MEMBER.exec(line);
      if (method && !previousEndsDoc) out.push(`${group}.${method[1]!}`);
    }
    previousEndsDoc = false;
    depth += netBraces(line);
    if (depth <= 1) group = undefined;
    if (depth <= 0) break;
  }
  return out;
}
