import { z } from 'zod';
import type { BehaviourHook, CharacterDefinition, PackManifest } from '@rp/shared';
import { PACK_FORMAT_VERSION } from '@rp/shared';
import { assetKindFor, extensionOf } from './assets.js';
import { invalidError, relativePathSchema } from './zod-common.js';

export { relativePathSchema, issuesOf } from './zod-common.js';
export type { ValidationIssue } from './zod-common.js';

export const PACK_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Older packs listed the capability modules they wanted under `capabilities` (pack.json and
 * character.json). Permissions are app-wide now (Settings → Permissions), so the key is
 * accepted for compatibility, ignored, and stripped from the parsed value; the loader warns.
 */
export const IGNORED_CAPABILITIES_KEY = 'capabilities';

/** Every behaviour hook a character may bind a script to (runtime mirror of `BehaviourHook`). */
export const BEHAVIOUR_HOOKS = [
  'onInstall',
  'onSessionStart',
  'onUserMessage',
  'onTimer',
  'onEvent',
  'onSessionEnd',
] as const satisfies readonly BehaviourHook[];

// Compile-time exhaustiveness: fails to build if `BehaviourHook` gains a member missing above.
type MissingHook = Exclude<BehaviourHook, (typeof BEHAVIOUR_HOOKS)[number]>;
const _hooksExhaustive: [MissingHook] extends [never] ? true : false = true;
void _hooksExhaustive;

/** Extensions allowed for `avatarSet.expressions` (still images or short looping video). */
export const EXPRESSION_EXTENSIONS = ['png', 'gif', 'webp', 'apng', 'webm'] as const;

export const BEHAVIOUR_SCRIPT_EXTENSIONS = ['ts', 'js'] as const;

const behaviourPathSchema = relativePathSchema.check((ctx) => {
  const ext = extensionOf(ctx.value);
  if (!(BEHAVIOUR_SCRIPT_EXTENSIONS as readonly string[]).includes(ext)) {
    ctx.issues.push({
      code: 'custom',
      message: `behaviour script "${ctx.value}" must end with .ts or .js`,
      input: ctx.value,
    });
  }
});

const avatarPathSchema = relativePathSchema.check((ctx) => {
  if (assetKindFor(ctx.value) !== 'image') {
    ctx.issues.push({ code: 'custom', message: `avatar "${ctx.value}" is not an image file`, input: ctx.value });
  }
});

const expressionPathSchema = relativePathSchema.check((ctx) => {
  if (!(EXPRESSION_EXTENSIONS as readonly string[]).includes(extensionOf(ctx.value))) {
    ctx.issues.push({
      code: 'custom',
      message: `expression "${ctx.value}" must be a png/gif/webp/apng image or a webm video`,
      input: ctx.value,
    });
  }
});

const avatarSetSchema = z
  .object({
    expressions: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'expression names are lower-case slugs'), expressionPathSchema),
    defaultExpression: z.string().min(1).optional(),
    size: z.number().int().min(32).max(2048).optional(),
  })
  .check((ctx) => {
    const { expressions, defaultExpression } = ctx.value;
    if (Object.keys(expressions).length === 0) {
      ctx.issues.push({ code: 'custom', message: 'avatarSet.expressions must not be empty', input: expressions, path: ['expressions'] });
    }
    if (defaultExpression !== undefined && !(defaultExpression in expressions)) {
      ctx.issues.push({
        code: 'custom',
        message: `defaultExpression "${defaultExpression}" is not one of the expressions`,
        input: defaultExpression,
        path: ['defaultExpression'],
      });
    }
  });

const moodSchema = z.object({
  baseline: z.number().min(-1).max(1).optional(),
  energyBaseline: z.number().min(-1).max(1).optional(),
});

const semverSchema = z.string().regex(SEMVER_PATTERN, 'must be a semver version like 1.2.3');
/** The legacy `capabilities` key: accepted with any value, never validated, dropped after parsing. */
const ignoredCapabilitiesSchema = z.unknown().optional();

function uniqueCheck(label: string) {
  return (ctx: z.core.ParsePayload<string[]>): void => {
    const seen = new Set<string>();
    for (const v of ctx.value) {
      if (seen.has(v)) {
        ctx.issues.push({ code: 'custom', message: `duplicate ${label} "${v}"`, input: ctx.value });
        return;
      }
      seen.add(v);
    }
  };
}

const packAuthorSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});

const packManifestObject = z.object({
  formatVersion: z.literal(PACK_FORMAT_VERSION, { error: `formatVersion must be ${PACK_FORMAT_VERSION}` }),
  id: z.string().regex(PACK_ID_PATTERN, 'pack id must be reverse-DNS like com.example.pack (lower-case a-z, 0-9, ., -)'),
  name: z.string().min(1),
  version: semverSchema,
  description: z.string().optional(),
  author: packAuthorSchema.optional(),
  license: z.string().optional(),
  homepage: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  characters: z.array(relativePathSchema).min(1, 'a pack has exactly one character; list its directory').max(1, 'a pack has exactly one character; put a second character in a pack of its own').check(uniqueCheck('character directory')),
  [IGNORED_CAPABILITIES_KEY]: ignoredCapabilitiesSchema,
  mediaRoot: relativePathSchema.optional(),
  minAppVersion: semverSchema.optional(),
});

function dropIgnoredKeys<T extends object>(value: T): T {
  const out = { ...value } as Record<string, unknown>;
  delete out[IGNORED_CAPABILITIES_KEY];
  return out as T;
}

export const packManifestSchema: z.ZodType<PackManifest> = packManifestObject.transform(dropIgnoredKeys);

const exampleDialogueTurnSchema = z.object({
  user: z.string(),
  character: z.string(),
});

const modelHintsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
});

const characterDefinitionObject = z.object({
  id: z.string().regex(CHARACTER_ID_PATTERN, 'character id must match /^[a-z0-9][a-z0-9-_]*$/'),
  name: z.string().min(1),
  tagline: z.string().optional(),
  avatar: avatarPathSchema.optional(),
  persona: relativePathSchema,
  greeting: z.string().optional(),
  exampleDialogue: z.array(exampleDialogueTurnSchema).optional(),
  behaviours: z.partialRecord(z.enum(BEHAVIOUR_HOOKS), behaviourPathSchema).optional(),
  avatarSet: avatarSetSchema.optional(),
  mood: moodSchema.optional(),
  [IGNORED_CAPABILITIES_KEY]: ignoredCapabilitiesSchema,
  modelHints: modelHintsSchema.optional(),
});

export const characterDefinitionSchema: z.ZodType<CharacterDefinition> = characterDefinitionObject.transform(dropIgnoredKeys);

/** Validates the parsed contents of `pack.json`. Throws `RpError('PACK_INVALID', msg, { issues })`. */
export function validateManifest(json: unknown): PackManifest {
  const result = packManifestSchema.safeParse(json);
  if (!result.success) throw invalidError('pack.json', result.error);
  return result.data;
}

/** Validates the parsed contents of `character.json`. Throws `RpError('PACK_INVALID', msg, { issues })`. */
export function validateCharacter(json: unknown): CharacterDefinition {
  const result = characterDefinitionSchema.safeParse(json);
  if (!result.success) throw invalidError('character.json', result.error);
  return result.data;
}
