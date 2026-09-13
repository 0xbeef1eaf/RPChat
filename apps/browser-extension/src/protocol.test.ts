import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  BridgeError,
  backoffDelay,
  describeBrowser,
  describeTab,
  dispatch,
  errorFrom,
  isNavigableUrl,
  isWebUrl,
  normaliseText,
  okResponse,
  parseRequest,
  positiveInt,
  resolvePort,
} from './lib/protocol.js';

describe('parseRequest', () => {
  it('accepts well-formed requests and defaults args', () => {
    expect(parseRequest('{"id":"1","op":"tabs.list"}')).toEqual({ id: '1', op: 'tabs.list', args: {} });
    expect(parseRequest('{"id":"2","op":"tabs.open","args":{"url":"https://a.test"}}')).toEqual({ id: '2', op: 'tabs.open', args: { url: 'https://a.test' } });
  });
  it('rejects garbage, arrays and frames without id/op', () => {
    expect(parseRequest('nope')).toBeNull();
    expect(parseRequest('[1]')).toBeNull();
    expect(parseRequest('{"op":"x"}')).toBeNull();
    expect(parseRequest('{"id":"","op":"x"}')).toBeNull();
    expect(parseRequest('{"id":"1","op":"x","args":[1]}')).toEqual({ id: '1', op: 'x', args: {} });
  });
});

describe('dispatch', () => {
  const handlers = {
    echo: async (args: Record<string, unknown>) => args['value'],
    boom: async () => {
      throw new BridgeError('NOT_FOUND', 'gone');
    },
    crash: async () => {
      throw new Error('kaboom');
    },
    nothing: async () => undefined,
  };
  it('routes to the handler and wraps the value', async () => {
    expect(await dispatch({ id: 'a', op: 'echo', args: { value: 42 } }, handlers)).toEqual({ id: 'a', ok: true, value: 42 });
    expect(await dispatch({ id: 'n', op: 'nothing', args: {} }, handlers)).toEqual({ id: 'n', ok: true, value: null });
  });
  it('turns errors into error frames, never throws', async () => {
    expect(await dispatch({ id: 'b', op: 'boom', args: {} }, handlers)).toEqual({ id: 'b', ok: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    expect(await dispatch({ id: 'c', op: 'crash', args: {} }, handlers)).toEqual({ id: 'c', ok: false, error: { code: 'FAILED', message: 'kaboom' } });
    expect(await dispatch({ id: 'd', op: 'missing', args: {} }, handlers)).toMatchObject({ id: 'd', ok: false, error: { code: 'UNKNOWN_OP' } });
    expect(await dispatch({ id: 'e', op: 'toString', args: {} }, handlers)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OP' } });
  });
  it('helpers', () => {
    expect(okResponse('x', undefined)).toEqual({ id: 'x', ok: true, value: null });
    expect(errorFrom('x', 'str')).toEqual({ id: 'x', ok: false, error: { code: 'FAILED', message: 'str' } });
  });
});

describe('URL policy', () => {
  it('allows only http(s), and file: on request', () => {
    expect(isNavigableUrl('https://example.com/a?b=c')).toBe(true);
    expect(isNavigableUrl('http://127.0.0.1:47821/x')).toBe(true);
    expect(isNavigableUrl('file:///tmp/a.html')).toBe(false);
    expect(isNavigableUrl('file:///tmp/a.html', { allowFile: true })).toBe(true);
    for (const bad of ['chrome://extensions', 'chrome-extension://abc/x', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'ftp://x', '', 'not a url', 42, null]) {
      expect(isNavigableUrl(bad), String(bad)).toBe(false);
    }
    expect(isNavigableUrl(`https://a.test/${'x'.repeat(9000)}`)).toBe(false);
  });
  it('isWebUrl excludes the store and internals', () => {
    expect(isWebUrl('https://example.com')).toBe(true);
    expect(isWebUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isWebUrl('chrome://newtab')).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
  it('describeTab hides internal pages but lists them', () => {
    expect(describeTab({ id: 3, windowId: 1, url: 'https://a.test/p', title: 'A', active: true, index: 0 })).toEqual({ id: 3, windowId: 1, url: 'https://a.test/p', title: 'A', active: true, index: 0 });
    expect(describeTab({ id: 4, windowId: 1, url: 'chrome://settings/passwords', title: 'Passwords', index: 1 })).toEqual({ id: 4, windowId: 1, url: 'chrome://', title: '', active: false, index: 1 });
    expect(describeTab({ id: 5 })).toEqual({ id: 5, windowId: -1, url: '', title: '', active: false, index: -1 });
  });
});

describe('backoffDelay', () => {
  it('doubles and caps at 30 s', () => {
    const noJitter = () => 0;
    expect(backoffDelay(0, noJitter)).toBe(1000);
    expect(backoffDelay(1, noJitter)).toBe(2000);
    expect(backoffDelay(3, noJitter)).toBe(8000);
    expect(backoffDelay(5, noJitter)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, noJitter)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(-2, noJitter)).toBe(1000);
  });
  it('adds bounded jitter', () => {
    const d = backoffDelay(2, () => 0.999);
    expect(d).toBeGreaterThan(4000);
    expect(d).toBeLessThanOrEqual(5000);
    expect(backoffDelay(10, () => 0.999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
});

describe('normaliseText', () => {
  it('collapses whitespace and trims', () => {
    expect(normaliseText('  Hello \t  world \n\n\n  again \r\n done  ')).toBe('Hello world\nagain\ndone');
  });
  it('caps with a marker', () => {
    const out = normaliseText('abcdefghijklmnopqrstuvwxyz'.repeat(10), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('[…truncated]')).toBe(true);
    expect(normaliseText('short', 0)).toBe('short');
  });
});

describe('misc helpers', () => {
  it('resolvePort prefers managed, then local, then default', () => {
    expect(resolvePort(undefined, undefined)).toBe(47821);
    expect(resolvePort(undefined, 5000)).toBe(5000);
    expect(resolvePort(6000, 5000)).toBe(6000);
    expect(resolvePort('7000', undefined)).toBe(7000);
    expect(resolvePort(70000, 'x')).toBe(47821);
    expect(resolvePort(0, -1, 9)).toBe(9);
  });
  it('positiveInt', () => {
    expect(positiveInt(undefined, 5)).toBe(5);
    expect(positiveInt(3.9, 5)).toBe(3);
    expect(positiveInt(-1, 5)).toBe(5);
    expect(positiveInt(1e9, 5, 100)).toBe(100);
  });
  it('describeBrowser uses brands when present', () => {
    expect(describeBrowser({ userAgent: 'UA', userAgentData: { brands: [{ brand: 'Not;A=Brand', version: '99' }, { brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }] } })).toBe('Chromium 141; Google Chrome 141');
    expect(describeBrowser({ userAgent: 'UA' })).toBe('UA');
    expect(describeBrowser({})).toBe('unknown');
  });
});
