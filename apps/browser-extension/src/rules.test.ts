import { describe, expect, it } from 'vitest';
import { CATCH_ALL_REGEX, RULE_PRIORITY, describeRule, dnrRulesFor, expiredRules, isProtectedPattern, nextExpiry, normalisePatterns, parsePattern, patternToRegex, readTable, ruleBlocks, urlMatchesPattern } from './lib/rules.js';
import type { RuleTable } from './lib/rules.js';

describe('block patterns → DNR rules', () => {
  it('parses hosts, subdomain wildcards and paths', () => {
    expect(parsePattern('example.com')).toEqual({ host: 'example.com', path: '' });
    expect(parsePattern('*.Example.com')).toEqual({ host: 'example.com', path: '' });
    expect(parsePattern('https://example.com/path*')).toEqual({ host: 'example.com', path: '/path*' });
    expect(parsePattern('example.com/a/b')).toEqual({ host: 'example.com', path: '/a/b' });
    for (const bad of ['', '*', 'ex ample.com', 'a*.com', 'javascript:alert(1)', '//x', 'x'.repeat(600)]) expect(parsePattern(bad), bad).toBeNull();
  });

  it('builds a regexFilter that matches the host, its subdomains and any port', () => {
    const host = patternToRegex('example.com')!;
    const re = new RegExp(host, 'i');
    for (const url of ['https://example.com/', 'http://example.com', 'https://www.example.com/x?y', 'http://example.com:8080/a', 'HTTPS://EXAMPLE.COM/']) expect(re.test(url), url).toBe(true);
    for (const url of ['https://notexample.com/', 'https://example.com.evil.test/', 'https://evil.test/?u=example.com', 'ftp://example.com/']) expect(re.test(url), url).toBe(false);
    const prefix = new RegExp(patternToRegex('example.com/news*')!, 'i');
    expect(prefix.test('https://example.com/news/today')).toBe(true);
    expect(prefix.test('https://m.example.com:81/newsletter')).toBe(true);
    expect(prefix.test('https://example.com/about')).toBe(false);
    const exact = new RegExp(patternToRegex('example.com/exact')!, 'i');
    expect(exact.test('https://example.com/exact')).toBe(true);
    expect(exact.test('https://example.com/exact?q=1#h')).toBe(true);
    expect(exact.test('https://example.com/exactly')).toBe(false);
    const inner = new RegExp(patternToRegex('example.com/*/video')!, 'i');
    expect(inner.test('https://example.com/a/b/video?x')).toBe(true);
    expect(patternToRegex('*')).toBeNull();
    expect(urlMatchesPattern('https://shop.example.com/cart', '*.example.com')).toBe(true);
    expect(urlMatchesPattern('https://example.org/', 'example.com')).toBe(false);
  });

  it('turns every pattern into one main_frame redirect rule with consecutive ids', () => {
    const rules = dnrRulesFor(['a.test', 'b.test/x*', 'not valid host!'], 7, 'chrome-extension://abc/blocked.html?rule=r1');
    expect(rules.map((r) => r.id)).toEqual([7, 8]);
    expect(rules[0]).toMatchObject({ priority: RULE_PRIORITY.deny, action: { type: 'redirect', redirect: { url: 'chrome-extension://abc/blocked.html?rule=r1' } }, condition: { resourceTypes: ['main_frame'], isUrlFilterCaseSensitive: false } });
    expect(rules[1]!.condition.regexFilter).toBe(patternToRegex('b.test/x*'));
  });

  it('turns an allowlist into a catch-all redirect the listed pages and the app itself override', () => {
    const rules = dnrRulesFor(['wiki.test'], 1, 'chrome-extension://abc/blocked.html?rule=r1', 'allow');
    expect(rules[0]).toMatchObject({ id: 1, priority: RULE_PRIORITY.catchAll, action: { type: 'redirect' }, condition: { regexFilter: CATCH_ALL_REGEX, resourceTypes: ['main_frame'] } });
    expect(rules.slice(1).map((r) => r.condition.regexFilter)).toEqual(['wiki.test', '127.0.0.1', 'localhost', '0.0.0.0'].map((p) => patternToRegex(p)));
    // Every allow rule outranks the catch-all, and a denylist rule outranks them in turn.
    expect(rules.slice(1).every((r) => r.action.type === 'allow' && r.priority === RULE_PRIORITY.allow)).toBe(true);
    expect(RULE_PRIORITY.deny).toBeGreaterThan(RULE_PRIORITY.allow);
    expect(RULE_PRIORITY.allow).toBeGreaterThan(RULE_PRIORITY.catchAll);
    // An unusable pattern would shut out a site meant to stay open, so the whole set is refused.
    expect(dnrRulesFor(['wiki.test', 'not a host!'], 1, 'x', 'allow')).toEqual([]);
  });

  it('decides what each mode keeps shut, the app\'s own pages always being open', () => {
    expect(ruleBlocks('https://a.test/x', 'deny', ['a.test'])).toBe(true);
    expect(ruleBlocks('https://b.test/x', 'deny', ['a.test'])).toBe(false);
    expect(ruleBlocks('https://b.test/x', 'allow', ['a.test'])).toBe(true);
    expect(ruleBlocks('https://sub.a.test/x', 'allow', ['a.test'])).toBe(false);
    for (const url of ['http://127.0.0.1:47821/media', 'http://localhost:47821/x', 'http://app.localhost/x']) expect(ruleBlocks(url, 'allow', ['a.test']), url).toBe(false);
  });

  it('protects the app, localhost and browser internals', () => {
    for (const p of ['127.0.0.1', '127.0.0.1/smoke*', 'localhost', 'http://localhost:47821/x', 'app.localhost', '0.0.0.0', 'chrome://settings', 'chrome-extension://abc/x', 'file:///etc']) expect(isProtectedPattern(p), p).toBe(true);
    for (const p of ['example.com', '*.example.com', 'localhost.example.com']) expect(isProtectedPattern(p), p).toBe(false);
    expect(() => normalisePatterns(['localhost'])).toThrow(/protected/);
    // An allowlist may name them: it lets them through either way.
    expect(normalisePatterns(['localhost'], 'allow')).toEqual(['localhost']);
    expect(() => normalisePatterns(['not a host'], 'allow')).toThrow(/not a URL pattern/);
    expect(() => normalisePatterns(['not a host'])).toThrow(/not a URL pattern/);
    expect(() => normalisePatterns([])).toThrow(/non-empty/);
    expect(() => normalisePatterns(Array.from({ length: 51 }, (_, i) => `h${i}.test`))).toThrow(/at most 50/);
    expect(normalisePatterns(['HTTPS://Example.com/', 'example.com/', 'b.test'])).toEqual(['example.com/', 'b.test']);
  });
});

describe('rule table and expiry', () => {
  const table: RuleTable = {
    nextRuleId: 5,
    rules: [
      { id: 'a', mode: 'deny', patterns: ['a.test'], ruleIds: [1], createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' },
      { id: 'b', mode: 'deny', patterns: ['b.test'], ruleIds: [2, 3], createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T03:00:00.000Z', by: 'Mira', redirect: 'https://calm.test/' },
      { id: 'c', mode: 'allow', patterns: ['c.test'], ruleIds: [4], createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  it('finds expired rules and the next expiry', () => {
    const t0 = Date.parse('2026-01-01T00:30:00Z');
    expect(expiredRules(table, t0).map((r) => r.id)).toEqual([]);
    expect(nextExpiry(table, t0)).toBe(Date.parse('2026-01-01T01:00:00Z'));
    const t1 = Date.parse('2026-01-01T02:00:00Z');
    expect(expiredRules(table, t1).map((r) => r.id)).toEqual(['a']);
    expect(nextExpiry({ ...table, rules: [table.rules[2]!] }, t1)).toBeUndefined();
    // An expiry that already passed is still scheduled (a second ahead) so the purge runs.
    expect(nextExpiry(table, Date.parse('2026-01-01T05:00:00Z'))).toBe(Date.parse('2026-01-01T05:00:01Z'));
  });
  it('sanitises a stored table and describes rules without DNR internals', () => {
    expect(readTable(undefined)).toEqual({ nextRuleId: 1, rules: [] });
    // A rule stored before allowlists existed reads back as a denylist.
    expect(readTable({ rules: [{ id: 'x', patterns: ['x.test'], ruleIds: [9] }, { bogus: true }] })).toEqual({ nextRuleId: 10, rules: [{ id: 'x', mode: 'deny', patterns: ['x.test'], ruleIds: [9] }] });
    expect(readTable(table)).toEqual(table);
    expect(describeRule(table.rules[1]!)).toEqual({ id: 'b', mode: 'deny', patterns: ['b.test'], redirect: 'https://calm.test/', expiresAt: '2026-01-01T03:00:00.000Z', by: 'Mira', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(describeRule(table.rules[2]!)).toEqual({ id: 'c', mode: 'allow', patterns: ['c.test'], createdAt: '2026-01-01T00:00:00.000Z' });
  });
});
