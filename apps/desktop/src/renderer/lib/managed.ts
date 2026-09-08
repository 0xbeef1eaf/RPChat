/** Managed (policy-forced) settings paths. */

/**
 * True when `path` is forced by policy: an exact match, or any parent path is listed
 * (`autonomy` covers `autonomy.maxSelfWakesPerHour`). A managed child does not make the parent managed.
 */
export function isManaged(managed: readonly string[] | undefined, path: string): boolean {
  if (!managed || managed.length === 0 || !path) return false;
  for (const m of managed) {
    if (m === path) return true;
    if (path.startsWith(`${m}.`)) return true;
  }
  return false;
}

/** Managed paths at or below `path` (for "partially managed" hints, e.g. the permissions map). */
export function managedChildren(managed: readonly string[] | undefined, path: string): string[] {
  if (!managed) return [];
  return managed.filter((m) => m === path || m.startsWith(`${path}.`)).map((m) => (m === path ? '' : m.slice(path.length + 1))).filter(Boolean);
}
