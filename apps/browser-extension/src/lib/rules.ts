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
 * Every pattern becomes one `regexFilter` rule for `main_frame` requests only, so embedded
 * resources are untouched and a port in the URL does not defeat the rule.
 */

export const RULES_STORAGE_KEY = 'blockRules';
export const RULES_ALARM = 'rpchat-rules-expiry';
/** Longest regex the DNR API accepts (Chromium checks 2 KB after its own compilation; keep a margin). */
const MAX_REGEX_LENGTH = 1500;
export const MAX_PATTERNS_PER_RULE = 50;

export interface BlockRule {
  /** The app's id for the block (returned by `sdk.browser.block`). */
  id: string;
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
  action: { type: 'redirect'; redirect: { url: string } } | { type: 'block' };
  condition: { regexFilter: string; resourceTypes: ['main_frame']; isUrlFilterCaseSensitive: false };
}

export const EMPTY_TABLE: RuleTable = { nextRuleId: 1, rules: [] };

/** Hosts a character may never block: the app's own pages and browser internals. */
const PROTECTED_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);

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

/** Build the DNR rules for one block; `target` is the blocked page URL (or the block's redirect). */
export function dnrRulesFor(patterns: string[], firstRuleId: number, target: string): DnrRuleLike[] {
  const out: DnrRuleLike[] = [];
  let id = firstRuleId;
  for (const pattern of patterns) {
    const regexFilter = patternToRegex(pattern);
    if (!regexFilter) continue;
    out.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { url: target } },
      condition: { regexFilter, resourceTypes: ['main_frame'], isUrlFilterCaseSensitive: false },
    });
  }
  return out;
}

/** Validate and normalise the patterns of a `rules.block` request; throws with a reason when any is unusable. */
export function normalisePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('patterns must be a non-empty array of strings');
  if (raw.length > MAX_PATTERNS_PER_RULE) throw new Error(`at most ${MAX_PATTERNS_PER_RULE} patterns per block`);
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || !parsePattern(p)) throw new Error(`"${String(p).slice(0, 80)}" is not a URL pattern (use example.com, *.example.com or example.com/path*)`);
    if (isProtectedPattern(p)) throw new Error(`"${p}" cannot be blocked (the app's own pages and browser internals are protected)`);
    const clean = p.trim().toLowerCase().replace(/^[a-z*]+:\/\//, '');
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** Sanitise a stored table (anything odd → empty). */
export function readTable(value: unknown): RuleTable {
  if (!value || typeof value !== 'object') return { ...EMPTY_TABLE, rules: [] };
  const t = value as Partial<RuleTable>;
  const rules = Array.isArray(t.rules) ? t.rules.filter((r): r is BlockRule => Boolean(r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.patterns) && Array.isArray(r.ruleIds))) : [];
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
export function describeRule(rule: BlockRule): { id: string; patterns: string[]; redirect?: string; expiresAt?: string; by?: string; reason?: string; createdAt: string } {
  return {
    id: rule.id,
    patterns: [...rule.patterns],
    ...(rule.redirect ? { redirect: rule.redirect } : {}),
    ...(rule.expiresAt ? { expiresAt: rule.expiresAt } : {}),
    ...(rule.by ? { by: rule.by } : {}),
    ...(rule.reason ? { reason: rule.reason } : {}),
    createdAt: rule.createdAt,
  };
}
