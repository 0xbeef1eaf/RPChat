import { describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { CapabilityModuleSpec } from '@rp/shared';
import { CapabilityRegistry } from './registry.js';
import { createStandardRegistry } from './index.js';

function spec(overrides: Partial<CapabilityModuleSpec> = {}): CapabilityModuleSpec {
  return {
    id: 'demo',
    version: '1.0.0',
    title: 'Demo',
    summary: 'A demo module.',
    permission: 'pack',
    apiTypeName: 'DemoApi',
    typings: `interface DemoApi {
  /** Ping. */
  ping(): Promise<void>;
  /** Wipe. */
  wipe(): Promise<void>;
}`,
    docs: 'Demo docs.',
    methods: {
      ping: { description: 'Ping.' },
      wipe: { description: 'Wipe.', permission: 'prompt', dangerous: true },
    },
    ...overrides,
  };
}

describe('CapabilityRegistry', () => {
  it('registers modules and lists them in registration order', () => {
    const r = new CapabilityRegistry();
    r.register(spec({ id: 'zeta', apiTypeName: 'DemoApi' }));
    r.register(spec({ id: 'alpha', apiTypeName: 'DemoApi' }));
    expect(r.list().map((m) => m.id)).toEqual(['zeta', 'alpha']);
    expect(r.has('zeta')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.get('alpha')?.id).toBe('alpha');
    expect(r.get('nope')).toBeUndefined();
  });

  it('rejects duplicate ids with INVALID_ARGUMENT', () => {
    const r = new CapabilityRegistry();
    r.register(spec());
    expect(() => r.register(spec())).toThrowError(RpError);
    try {
      r.register(spec());
    } catch (e) {
      expect((e as RpError).code).toBe('INVALID_ARGUMENT');
    }
    expect(r.list()).toHaveLength(1);
  });

  it('rejects invalid specs with INVALID_ARGUMENT and lists the problems in details', () => {
    const r = new CapabilityRegistry();
    let err: unknown;
    try {
      r.register(spec({ id: 'Bad Id', version: 'x' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpError);
    const rp = err as RpError;
    expect(rp.code).toBe('INVALID_ARGUMENT');
    const problems = (rp.details as { problems: string[] }).problems;
    expect(problems.some((p) => p.startsWith('id must match'))).toBe(true);
    expect(problems.some((p) => p.startsWith('version must be semver'))).toBe(true);
    expect(r.has('Bad Id')).toBe(false);
  });

  it('permissionFor returns the method override or the module default', () => {
    const r = new CapabilityRegistry();
    r.register(spec());
    expect(r.permissionFor('demo', 'ping')).toBe('pack');
    expect(r.permissionFor('demo', 'wipe')).toBe('prompt');
    expect(r.methodSpec('demo', 'wipe')).toEqual({ description: 'Wipe.', permission: 'prompt', dangerous: true });
  });

  it('throws CAPABILITY_UNKNOWN for unknown modules and methods', () => {
    const r = new CapabilityRegistry();
    r.register(spec());
    for (const fn of [
      () => r.permissionFor('nope', 'ping'),
      () => r.permissionFor('demo', 'nope'),
      () => r.methodSpec('nope', 'ping'),
      () => r.methodSpec('demo', 'toString'),
      () => r.methodSpec('demo', '__proto__'),
    ]) {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RpError);
      expect((err as RpError).code).toBe('CAPABILITY_UNKNOWN');
    }
  });

  it('resolves nested (dotted) method names', () => {
    const r = createStandardRegistry();
    expect(r.permissionFor('state', 'session.get')).toBe('trusted');
    expect(r.methodSpec('state', 'session.set').description).toMatch(/session/i);
  });
});
