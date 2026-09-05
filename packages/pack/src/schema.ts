import { z } from 'zod';
import type { BehaviourHook, CharacterDefinition, PackManifest } from '@rp/shared';
import { PACK_FORMAT_VERSION, RpError } from '@rp/shared';
import { assetKindFor, extensionOf } from './assets.js';
import { normalizeRelativePath } from './paths.js';

export const PACK_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const CAPABILITY_ID_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

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
const _hooksExhaustive: MissingHook extends never ? true : never = true;
void _hooksExhaustive;

export const BEHAVIOUR_SCRIPT_EXTENSIONS = ['ts', 'js'] as const;

/** A path relative to the pack (or character) directory that cannot escape it. */
export const relativePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .check((ctx) => {
    const n = normalizeRelativePath(ctx.value);
    if (!n.ok) ctx.issues.push({ code: 'custom', message: `unsafe path "${ctx.value}": ${n.reason}`, input: ctx.value });
  });

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

const semverSchema = z.string().regex(SEMVER_PATTERN, 'must be a semver version like 1.2.3');
const capabilityIdSchema = z.string().regex(CAPABILITY_ID_PATTERN, 'capability ids match /^[a-z][a-zA-Z0-9]*$/');

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
  characters: z.array(relativePathSchema).min(1, 'a pack needs at least one character').check(uniqueCheck('character directory')),
  capabilities: z.array(capabilityIdSchema).optional(),
  mediaRoot: relativePathSchema.optional(),
  minAppVersion: semverSchema.optional(),
});

export const packManifestSchema: z.ZodType<PackManifest> = packManifestObject;

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
  capabilities: z.array(capabilityIdSchema).optional(),
  modelHints: modelHintsSchema.optional(),
});

export const characterDefinitionSchema: z.ZodType<CharacterDefinition> = characterDefinitionObject;

/** One validation problem, JSON-safe, as carried in `RpError.details.issues`. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

function invalid(what: string, error: z.ZodError): RpError {
  const issues = issuesOf(error);
  const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return new RpError('PACK_INVALID', `Invalid ${what}: ${summary}`, { issues });
}

/** Validates the parsed contents of `pack.json`. Throws `RpError('PACK_INVALID', msg, { issues })`. */
export function validateManifest(json: unknown): PackManifest {
  const result = packManifestSchema.safeParse(json);
  if (!result.success) throw invalid('pack.json', result.error);
  return result.data;
}

/** Validates the parsed contents of `character.json`. Throws `RpError('PACK_INVALID', msg, { issues })`. */
export function validateCharacter(json: unknown): CharacterDefinition {
  const result = characterDefinitionSchema.safeParse(json);
  if (!result.success) throw invalid('character.json', result.error);
  return result.data;
}
