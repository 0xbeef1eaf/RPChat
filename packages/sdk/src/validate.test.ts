import { describe, expect, it } from 'vitest';
import type { CapabilityModuleSpec } from '@rp/shared';
import { extractInterfaceBody, scanMethodMembers, stripComments, validateModuleSpec } from './validate.js';

const base: CapabilityModuleSpec = {
  id: 'demo',
  version: '1.2.3',
  title: 'Demo',
  summary: 'Demo module.',
  permission: 'trusted',
  apiTypeName: 'DemoApi',
  typings: `/** Helper. */
interface DemoThing { name: string }
/** Demo. */
interface DemoApi {
  /** Ping the thing. */
  ping(target: DemoThing, opts?: { retries?: number }): Promise<void>;
  /** Generic. */
  pick<T extends string>(items: T[]): Promise<T>;
  /** Multi-line return type. */
  stats(): Promise<{
    count: number;
    names: string[];
  }>;
  /** A nested group. */
  nested: {
    /** Inner get. */
    get(key: string): Promise<string>;
    /** Inner set. */
    set(key: string, value: string): Promise<void>;
  };
  /** Plain property, not a method. */
  readonly version: string;
}`,
  docs: 'Docs.',
  methods: {
    ping: { description: 'Ping.' },
    pick: { description: 'Pick.' },
    stats: { description: 'Stats.' },
    'nested.get': { description: 'Get.' },
    'nested.set': { description: 'Set.' },
  },
};

describe('validateModuleSpec', () => {
  it('accepts a valid spec (including generics, multi-line members, nested groups and plain properties)', () => {
    expect(validateModuleSpec(base)).toEqual([]);
  });

  it('reports a method declared in typings but missing from methods', () => {
    const { stats: _drop, ...methods } = base.methods;
    expect(validateModuleSpec({ ...base, methods })).toEqual([
      `interface DemoApi declares method "stats" which is missing from methods`,
    ]);
  });

  it('reports a nested method missing from methods', () => {
    const { 'nested.set': _drop, ...methods } = base.methods;
    expect(validateModuleSpec({ ...base, methods })).toEqual([
      `interface DemoApi declares method "nested.set" which is missing from methods`,
    ]);
  });

  it('reports a methods key that is not declared in the interface', () => {
    const problems = validateModuleSpec({
      ...base,
      methods: { ...base.methods, ghost: { description: 'Ghost.' }, 'nested.ghost': { description: 'Ghost.' } },
    });
    expect(problems).toEqual([
      'methods.ghost is not declared as a method of interface DemoApi in typings',
      'methods.nested.ghost is not declared as a method of interface DemoApi in typings',
    ]);
  });

  it('reports a missing interface declaration', () => {
    expect(validateModuleSpec({ ...base, apiTypeName: 'OtherApi' })).toEqual([
      'typings must declare "interface OtherApi { ... }"',
    ]);
  });

  it('reports undocumented methods', () => {
    const typings = base.typings.replace('  /** Ping the thing. */\n', '').replace('    /** Inner set. */\n', '');
    expect(validateModuleSpec({ ...base, typings })).toEqual([
      'method "ping" of interface DemoApi has no TSDoc comment',
      'method "nested.set" of interface DemoApi has no TSDoc comment',
    ]);
  });

  it('rejects import/export in typings', () => {
    const problems = validateModuleSpec({ ...base, typings: `import type { X } from 'y';\n${base.typings}` });
    expect(problems).toContain('typings must not contain import/export statements (they are emitted into a global declaration file)');
  });

  it('validates scalar fields', () => {
    const problems = validateModuleSpec({
      ...base,
      id: 'Not-valid',
      version: '1.0',
      title: ' ',
      summary: '',
      permission: 'root' as never,
      apiTypeName: 'lowercase',
      docs: '',
      methods: { ...base.methods, 'a.b.c': { description: 'x' }, ping: { description: '', permission: 'nope' as never } },
    });
    expect(problems.some((p) => p.startsWith('id must match'))).toBe(true);
    expect(problems.some((p) => p.startsWith('version must be semver'))).toBe(true);
    expect(problems).toContain('title must be a non-empty string');
    expect(problems).toContain('summary must be a non-empty string');
    expect(problems.some((p) => p.startsWith('permission must be one of'))).toBe(true);
    expect(problems.some((p) => p.startsWith('apiTypeName must match'))).toBe(true);
    expect(problems).toContain('docs must be a non-empty markdown string');
    expect(problems).toContain('methods key "a.b.c" must be "name" or "group.name"');
    expect(problems).toContain('methods.ping.description must be a non-empty string');
    expect(problems).toContain('methods.ping.permission must be one of trusted|pack|prompt');
  });

  it('handles garbage input', () => {
    expect(validateModuleSpec(null as never)).toEqual(['spec must be an object']);
    expect(validateModuleSpec({} as never).length).toBeGreaterThan(3);
  });
});

describe('typings scanning helpers', () => {
  it('extracts the interface body by matching braces', () => {
    const src = stripComments(base.typings);
    const body = extractInterfaceBody(src, 'DemoApi');
    expect(body).toContain('ping(');
    expect(body).toContain('readonly version: string;');
    expect(body?.trimEnd().endsWith('readonly version: string;')).toBe(true);
    expect(extractInterfaceBody(src, 'DemoThing')).toBe(' name: string ');
    expect(extractInterfaceBody(src, 'Missing')).toBeUndefined();
  });

  it('lists top-level and one-level nested methods only', () => {
    const body = extractInterfaceBody(stripComments(base.typings), 'DemoApi')!;
    expect(scanMethodMembers(body)).toEqual(['ping', 'pick', 'stats', 'nested.get', 'nested.set']);
  });

  it('ignores methods inside comments', () => {
    const src = `interface A {
  /**
   * Example:
   *   fake(): void;
   */
  real(): void;
}`;
    expect(scanMethodMembers(extractInterfaceBody(stripComments(src), 'A')!)).toEqual(['real']);
  });
});
