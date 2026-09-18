/**
 * Page blocking (pure): turns the character's URL patterns into `declarativeNetRequest` dynamic
 * rules, keeps the rule table the worker persists in `chrome.storage.local`, and decides which
 * rules have expired. Nothing here touches `chrome.*`.
 *
 * Pattern forms (case-insensitive, scheme optional and ignored):
 *   `example.com`          the host and every subdomain, any path
 *   `*.example.com`        the same (the leading `*.` is accepted for symmetry with the allowlist)
 *   `example.com/path*`    the host (and subdomains) with a path prefix; `*` inside a path matches anything
 *   `example.com/exact`    that path exactly (query string / fragment allowed)
 * A block is a denylist (`mode: 'deny'`) unless it says otherwise: every pattern becomes one
 * `regexFilter` redirect rule. An allowlist (`mode: 'allow'`) inverts it — one catch-all rule sends
 * every top-level navigation to the blocked page, and each pattern (plus the app's own loopback
 * pages) gets a higher-priority `allow` rule that overrides it.
 * Either way the rules only ever match `main_frame` requests, so a page the user may open loads all
 * of its own assets, frames and requests however far off its patterns they are — and a port in the
 * URL does not defeat a rule.
 */

export const RULES_STORAGE_KEY = 'blockRules';
export const RULES_ALARM = 'rpchat-rules-expiry';
/** Longest regex the DNR API accepts (Chromium checks 2 KB after its own compilation; keep a margin). */
const MAX_REGEX_LENGTH = 1500;
export const MAX_PATTERNS_PER_RULE = 50;
/** Matches every top-level http(s) navigation: the catch-all an allowlist block redirects. */
export const CATCH_ALL_REGEX = '^https?://';
/**
 * DNR priorities. A denylist rule outranks an allowlist's `allow` (blocking one site stays possible
 * while an allowlist is up), which in turn outranks that allowlist's catch-all.
 */
export const RULE_PRIORITY = { catchAll: 1, allow: 2, deny: 3 } as const;

/** Whether the patterns are the pages that may *not* open (`deny`) or the only ones that may (`allow`). */
export type BlockMode = 'deny' | 'allow';

export interface BlockRule {
  /** The app's id for the block (returned by `sdk.browser.block`). */
  id: string;
  /** Denylist or allowlist; rules stored before allowlists existed read back as `deny`. */
  mode: BlockMode;
  patterns: string[];
  /** Where blocked navigations go instead of the extension's blocked page. */
  redirect?: string;
  /** ISO time after which the rule is removed by the expiry alarm. */
  expiresAt?: string;
  /** Character name shown on the blocked page. */
  by?: string;
  /** Why (the character's words), shown on the blocked page. */
  reason?: string;
  /** The DNR rule ids this block installed (one per pattern). */
  ruleIds: number[];
  createdAt: string;
}

export interface RuleTable {
  nextRuleId: number;
  rules: BlockRule[];
}

export interface DnrRuleLike {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { url: string } } | { type: 'block' } | { type: 'allow' };
  condition: { regexFilter: string; resourceTypes: ['main_frame']; isUrlFilterCaseSensitive: false };
}

export const EMPTY_TABLE: RuleTable = { nextRuleId: 1, rules: [] };

/** Hosts a character may never block: the app's own pages and browser internals. */
const PROTECTED_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);

/** Patterns an allowlist always lets through, for the same reason it may not deny them. */
export const ALWAYS_ALLOWED_PATTERNS = ['127.0.0.1', 'localhost', '0.0.0.0'];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** `{ host, path }` of a normalised pattern, or null when it is not one we accept. */
export function parsePattern(pattern: string): { host: string; path: string } | null {
  if (typeof pattern !== 'string') return null;
  let p = pattern.trim().toLowerCase();
  if (p.length === 0 || p.length > 512) return null;
  p = p.replace(/^[a-z*]+:\/\//, '');
  if (p.startsWith('*.')) p = p.slice(2);
  else if (p.startsWith('.')) p = p.slice(1);
  const slash = p.indexOf('/');
  // A port in the pattern is dropped: rules match any port (see `patternToRegex`).
  const host = (slash >= 0 ? p.slice(0, slash) : p).replace(/:\d+$/, '');
  const path = slash >= 0 ? p.slice(slash) : '';
  if (host.length === 0 || host.length > 253) return null;
  if (host === '*') return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  if (host.includes('*')) return null;
  return { host, path };
}

/** Whether blocking this pattern would cut the app's own pages or browser internals off. */
export function isProtectedPattern(pattern: string): boolean {
  const raw = typeof pattern === 'string' ? pattern.trim().toLowerCase() : '';
  if (/^(chrome|chrome-extension|edge|brave|about|devtools|file):/.test(raw)) return true;
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  return PROTECTED_HOSTS.has(parsed.host) || parsed.host.endsWith('.localhost');
}

/**
 * RE2 regex (as `regexFilter` wants it) for one pattern: `^https?://` + optional subdomains +
 * the host + optional port + the path rule. Null for a pattern `parsePattern` rejects.
 */
export function patternToRegex(pattern: string): string | null {
  const parsed = parsePattern(pattern);
  if (!parsed) return null;
  const host = `([^/?#:]+\\.)?${escapeRegex(parsed.host)}(:[0-9]+)?`;
  let tail: string;
  if (parsed.path === '' || parsed.path === '/' || parsed.path === '/*') tail = '([/?#].*)?$';
  else if (parsed.path.endsWith('*')) tail = `${parsed.path.slice(0, -1).split('*').map(escapeRegex).join('.*')}.*`;
  else tail = `${parsed.path.split('*').map(escapeRegex).join('.*')}([?#].*)?$`;
  const regex = `^https?://${host}${tail}`;
  return regex.length > MAX_REGEX_LENGTH ? null : regex;
}

/** Whether `url` (an absolute URL) matches a pattern — used to move tabs that are already on a blocked page. */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const regex = patternToRegex(pattern);
  if (!regex) return false;
  try {
    return new RegExp(regex, 'i').test(url);
  } catch {
    return false;
  }
}

/** Whether `url` matches any of the patterns. */
export function urlMatchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((p) => urlMatchesPattern(url, p));
}

/**
 * Whether a rule keeps `url` from opening: on the list for a denylist, off it for an allowlist —
 * which always lets the app's own pages through, as it may not list them itself.
 */
export function ruleBlocks(url: string, mode: BlockMode, patterns: string[]): boolean {
  if (mode === 'allow') return !urlMatchesAny(url, patterns) && !urlMatchesAny(url, ALWAYS_ALLOWED_PATTERNS);
  return urlMatchesAny(url, patterns);
}

/**
 * Build the DNR rules for one block; `target` is the blocked page URL (or the block's redirect).
 * A denylist is one redirect rule per pattern. An allowlist is the catch-all redirect plus one
 * `allow` rule per pattern: an unusable pattern would quietly shut out a site the character meant
 * to let through, so the whole set is refused (empty) instead of being installed short.
 */
export function dnrRulesFor(patterns: string[], firstRuleId: number, target: string, mode: BlockMode = 'deny'): DnrRuleLike[] {
  const condition = (regexFilter: string): DnrRuleLike['condition'] => ({ regexFilter, resourceTypes: ['main_frame'], isUrlFilterCaseSensitive: false });
  const out: DnrRuleLike[] = [];
  let id = firstRuleId;
  if (mode === 'allow') {
    out.push({ id: id++, priority: RULE_PRIORITY.catchAll, action: { type: 'redirect', redirect: { url: target } }, condition: condition(CATCH_ALL_REGEX) });
    for (const pattern of new Set([...patterns, ...ALWAYS_ALLOWED_PATTERNS])) {
      const regexFilter = patternToRegex(pattern);
      if (!regexFilter) return [];
      out.push({ id: id++, priority: RULE_PRIORITY.allow, action: { type: 'allow' }, condition: condition(regexFilter) });
    }
    return out;
  }
  for (const pattern of patterns) {
    const regexFilter = patternToRegex(pattern);
    if (!regexFilter) continue;
    out.push({ id: id++, priority: RULE_PRIORITY.deny, action: { type: 'redirect', redirect: { url: target } }, condition: condition(regexFilter) });
  }
  return out;
}

/**
 * Validate and normalise the patterns of a `rules.block` request; throws with a reason when any is
 * unusable. The app's own pages are refused in a denylist only — an allowlist lets them through
 * whether or not it names them.
 */
export function normalisePatterns(raw: unknown, mode: BlockMode = 'deny'): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('patterns must be a non-empty array of strings');
  if (raw.length > MAX_PATTERNS_PER_RULE) throw new Error(`at most ${MAX_PATTERNS_PER_RULE} patterns per block`);
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || !parsePattern(p)) throw new Error(`"${String(p).slice(0, 80)}" is not a URL pattern (use example.com, *.example.com or example.com/path*)`);
    if (mode === 'deny' && isProtectedPattern(p)) throw new Error(`"${p}" cannot be blocked (the app's own pages and browser internals are protected)`);
    const clean = p.trim().toLowerCase().replace(/^[a-z*]+:\/\//, '');
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** Sanitise a stored table (anything odd → empty). */
export function readTable(value: unknown): RuleTable {
  if (!value || typeof value !== 'object') return { ...EMPTY_TABLE, rules: [] };
  const t = value as Partial<RuleTable>;
  const rules = Array.isArray(t.rules)
    ? t.rules
        .filter((r): r is BlockRule => Boolean(r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.patterns) && Array.isArray(r.ruleIds)))
        .map((r) => ({ ...r, mode: r.mode === 'allow' ? ('allow' as const) : ('deny' as const) }))
    : [];
  const nextRuleId = typeof t.nextRuleId === 'number' && Number.isInteger(t.nextRuleId) && t.nextRuleId >= 1 ? t.nextRuleId : Math.max(1, ...rules.flatMap((r) => r.ruleIds)) + 1;
  return { nextRuleId, rules };
}

/** Rules whose `expiresAt` is at or before `now`. */
export function expiredRules(table: RuleTable, now: number = Date.now()): BlockRule[] {
  return table.rules.filter((r) => typeof r.expiresAt === 'string' && Date.parse(r.expiresAt) <= now);
}

/** The earliest future expiry in the table (ms epoch), or undefined when nothing expires. */
export function nextExpiry(table: RuleTable, now: number = Date.now()): number | undefined {
  let best: number | undefined;
  for (const r of table.rules) {
    if (typeof r.expiresAt !== 'string') continue;
    const at = Date.parse(r.expiresAt);
    if (!Number.isFinite(at)) continue;
    const when = Math.max(at, now + 1000);
    if (best === undefined || when < best) best = when;
  }
  return best;
}

/** What `rules.list` returns (no DNR internals). */
export function describeRule(rule: BlockRule): { id: string; mode: BlockMode; patterns: string[]; redirect?: string; expiresAt?: string; by?: string; reason?: string; createdAt: string } {
  return {
    id: rule.id,
    mode: rule.mode === 'allow' ? 'allow' : 'deny',
    patterns: [...rule.patterns],
    ...(rule.redirect ? { redirect: rule.redirect } : {}),
    ...(rule.expiresAt ? { expiresAt: rule.expiresAt } : {}),
    ...(rule.by ? { by: rule.by } : {}),
    ...(rule.reason ? { reason: rule.reason } : {}),
    createdAt: rule.createdAt,
  };
}
