export const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_ASSET = 20;
export const MAX_DESCRIPTION_LENGTH = 200;

/** Lower-cases and trims a tag; returns `undefined` when the result is not a valid tag. */
export function normalizeTag(raw: string): string | undefined {
  const tag = raw.trim().toLowerCase();
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) return undefined;
  return tag;
}

/** Normalises, drops invalid entries, deduplicates and sorts. */
export function normalizeTags(raw: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t !== undefined) set.add(t);
  }
  return [...set].sort();
}
