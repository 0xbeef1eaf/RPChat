import { z } from 'zod';
import type { MediaManifest } from '@rp/shared';
import { MAX_DESCRIPTION_LENGTH, MAX_TAGS_PER_ASSET, MAX_TAG_LENGTH, TAG_PATTERN, normalizeTag } from './tags.js';
import { invalidError, relativePathSchema } from './zod-common.js';

const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'tag must not be empty')
  .max(MAX_TAG_LENGTH, `tag must be at most ${MAX_TAG_LENGTH} characters`)
  .regex(TAG_PATTERN, 'tags are lower-case: letters, digits, "-" and "_", starting with a letter or digit');

const tagListSchema = z
  .array(tagSchema)
  .transform((tags) => [...new Set(tags)].sort())
  .check((ctx) => {
    if (ctx.value.length > MAX_TAGS_PER_ASSET) {
      ctx.issues.push({
        code: 'custom',
        message: `at most ${MAX_TAGS_PER_ASSET} tags per entry (got ${ctx.value.length})`,
        input: ctx.value,
      });
    }
  });

const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'description must not be empty')
  .max(MAX_DESCRIPTION_LENGTH, `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);

/** `match` may contain `*`, `**` and `?`; it is otherwise a safe pack-relative path. */
const matchSchema = relativePathSchema;

const mediaManifestEntrySchema = z.object({
  match: matchSchema,
  tags: tagListSchema.optional(),
  description: descriptionSchema.optional(),
});

/** Vocabulary keys are normalised like tags; values are short meanings. */
const vocabularySchema = z.record(z.string(), descriptionSchema).transform((rec, ctx) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) {
    const tag = normalizeTag(key);
    if (tag === undefined) {
      ctx.issues.push({ code: 'custom', message: `invalid tag "${key}" in vocabulary`, input: key, path: [key] });
      continue;
    }
    out[tag] = value;
  }
  return out;
});

const mediaManifestObject = z.object({
  entries: z.array(mediaManifestEntrySchema),
  tags: vocabularySchema.optional(),
  folderTags: z.boolean().optional(),
});

export const mediaManifestSchema: z.ZodType<MediaManifest> = mediaManifestObject;

/** Validates the parsed contents of `media.json`. Throws `RpError('PACK_INVALID', msg, { issues })`. */
export function validateMediaManifest(json: unknown): MediaManifest {
  const result = mediaManifestSchema.safeParse(json);
  if (!result.success) throw invalidError('media.json', result.error);
  return result.data;
}
