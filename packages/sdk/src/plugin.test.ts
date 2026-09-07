import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RpError } from '@rp/shared';
import type { PluginManifest } from '@rp/shared';
import { CapabilityRegistry } from './registry.js';
import { generateSdkTypings } from './generate.js';
import { isEscapingPath, loadPluginModuleSpecs, validatePluginManifest } from './plugin.js';

const CLOCK_TYPINGS = `/** A clock. */
interface ClockApi {
  /** Current time as ISO-8601. */
  now(): Promise<string>;
  /** Time zone name, e.g. "Europe/Oslo". */
  zone(): Promise<string>;
}`;

function manifest(overrides: Partial<PluginManifest> = {}, moduleOverrides: Record<string, unknown> = {}): PluginManifest {
  return {
    id: 'com.example.clock',
    name: 'Clock',
    version: '1.0.0',
    modules: [
      {
        id: 'clock',
        version: '1.0.0',
        title: 'Clock',
        summary: 'Tells the time.',
        permission: 'trusted',
        apiTypeName: 'ClockApi',
        typingsText: CLOCK_TYPINGS,
        docsText: 'Use `sdk.clock.now()` for the current time.',
        methods: { now: { description: 'Current time.' }, zone: { description: 'Time zone.' } },
        ...moduleOverrides,
      },
    ],
    ...overrides,
  };
}

function rpError(fn: () => unknown): RpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RpError);
    return e as RpError;
  }
  throw new Error('expected an RpError');
}

async function rpErrorAsync(p: Promise<unknown>): Promise<RpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpError);
    return e as RpError;
  }
  throw new Error('expected an RpError');
}

function issuePaths(err: RpError): string[] {
  return (err.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
}

describe('validatePluginManifest', () => {
  it('accepts a valid manifest (inline typings/docs) and returns it typed', () => {
    const m = validatePluginManifest(manifest({ main: 'dist/main.js', author: { name: 'me' }, minAppVersion: '0.2.0' }));
    expect(m.id).toBe('com.example.clock');
    expect(m.modules[0]?.methods.now?.description).toBe('Current time.');
  });

  it('accepts file-based typings/docs', () => {
    const m = validatePluginManifest(manifest({}, { typingsText: undefined, docsText: undefined, typings: 'clock.d.ts', docs: 'docs/clock.md' }));
    expect(m.modules[0]?.typings).toBe('clock.d.ts');
  });

  it('rejects a bad plugin id', () => {
    for (const id of ['clock', 'Com.Example', 'com..example', '', 'com.example.']) {
      const err = rpError(() => validatePluginManifest(manifest({ id })));
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(issuePaths(err)).toContain('id');
    }
  });

  it('rejects missing or empty modules', () => {
    const { modules: _drop, ...noModules } = manifest();
    expect(issuePaths(rpError(() => validatePluginManifest(noModules)))).toContain('modules');
    expect(issuePaths(rpError(() => validatePluginManifest(manifest({ modules: [] }))))).toContain('modules');
  });

  it('rejects modules with neither typings nor typingsText (and docs likewise)', () => {
    const err = rpError(() => validatePluginManifest(manifest({}, { typingsText: undefined, docsText: undefined })));
    expect(issuePaths(err)).toEqual(['modules.0.typings', 'modules.0.docs']);
    expect(err.message).toContain('"typings" (file) or "typingsText" (inline)');
  });

  it('rejects modules with both typings and typingsText', () => {
    const err = rpError(() => validatePluginManifest(manifest({}, { typings: 'clock.d.ts' })));
    expect(issuePaths(err)).toEqual(['modules.0.typings']);
  });

  it('rejects bad module ids, versions, permissions, method keys and escaping paths', () => {
    const err = rpError(() =>
      validatePluginManifest(
        manifest(
          { version: '1', main: '../evil.js' },
          {
            id: 'Clock',
            version: 'v1',
            permission: 'root',
            apiTypeName: 'clockApi',
            typingsText: undefined,
            typings: '/etc/passwd',
            methods: { 'a.b.c': { description: 'x' }, now: { description: '' } },
          },
        ),
      ),
    );
    const paths = issuePaths(err);
    for (const p of ['version', 'main', 'modules.0.id', 'modules.0.version', 'modules.0.permission', 'modules.0.apiTypeName', 'modules.0.typings', 'modules.0.methods.now.description']) {
      expect(paths, p).toContain(p);
    }
    expect(paths.some((p) => p.startsWith('modules.0.methods.a.b.c'))).toBe(true);
  });

  it('rejects duplicate module ids and non-object input', () => {
    const dup = manifest();
    dup.modules.push({ ...dup.modules[0]! });
    expect(issuePaths(rpError(() => validatePluginManifest(dup)))).toContain('modules.1.id');
    expect(rpError(() => validatePluginManifest(null)).code).toBe('INVALID_ARGUMENT');
    expect(rpError(() => validatePluginManifest('x')).code).toBe('INVALID_ARGUMENT');
  });
});

describe('isEscapingPath', () => {
  it('flags absolute paths and .. segments only', () => {
    expect(isEscapingPath('clock.d.ts')).toBe(false);
    expect(isEscapingPath('a/b/../c.md')).toBe(true);
    expect(isEscapingPath('..\\x')).toBe(true);
    expect(isEscapingPath('/x')).toBe(true);
    expect(isEscapingPath('C:\\x')).toBe(true);
    expect(isEscapingPath('a..b/c')).toBe(false);
  });
});

describe('loadPluginModuleSpecs', () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'rp-sdk-plugin-'));
    dir = path.join(base, 'plugin');
    outside = path.join(base, 'outside');
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(dir, 'clock.d.ts'), CLOCK_TYPINGS);
    await writeFile(path.join(dir, 'docs', 'clock.md'), '# Clock\n\nUse `sdk.clock.now()`.');
    await writeFile(path.join(outside, 'secret.d.ts'), 'interface ClockApi { now(): Promise<string>; zone(): Promise<string>; }');
  });

  afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('builds specs from files and inline text, and they register and generate typings', async () => {
    const m = validatePluginManifest({
      ...manifest({}, { typingsText: undefined, docsText: undefined, typings: 'clock.d.ts', docs: 'docs/clock.md' }),
      modules: [
        ...manifest({}, { typingsText: undefined, docsText: undefined, typings: 'clock.d.ts', docs: 'docs/clock.md' }).modules,
        {
          id: 'greeter',
          version: '0.1.0',
          title: 'Greeter',
          summary: 'Says hi.',
          permission: 'pack',
          apiTypeName: 'GreeterApi',
          typingsText: '/** Greets. */\ninterface GreeterApi {\n  /** Say hi. */\n  hi(name: string): Promise<string>;\n}',
          docsText: 'Call `sdk.greeter.hi(name)`.',
          methods: { hi: { description: 'Say hi.', dangerous: true } },
        },
      ],
    });
    const specs = await loadPluginModuleSpecs(dir, m);
    expect(specs.map((s) => s.id)).toEqual(['clock', 'greeter']);
    expect(specs[0]?.typings).toBe(CLOCK_TYPINGS);
    expect(specs[0]?.docs).toContain('# Clock');
    expect(specs[1]?.typings).toContain('interface GreeterApi');

    const registry = new CapabilityRegistry();
    for (const s of specs) registry.register(s);
    const out = generateSdkTypings(registry);
    expect(out).toContain('  clock: ClockApi;');
    expect(out).toContain('// ---- module: greeter v0.1.0 ----');
    expect(registry.permissionFor('greeter', 'hi')).toBe('pack');
  });

  it('rejects typings paths that escape the plugin dir with ..', async () => {
    const m = manifest({}, { typingsText: undefined, typings: '../outside/secret.d.ts' });
    const err = await rpErrorAsync(loadPluginModuleSpecs(dir, m));
    expect(err.code).toBe('PATH_ESCAPE');
  });

  it('rejects absolute paths', async () => {
    const m = manifest({}, { typingsText: undefined, typings: path.join(outside, 'secret.d.ts') });
    expect((await rpErrorAsync(loadPluginModuleSpecs(dir, m))).code).toBe('PATH_ESCAPE');
  });

  it('rejects symlinks that resolve outside the plugin dir', async () => {
    await symlink(path.join(outside, 'secret.d.ts'), path.join(dir, 'link.d.ts'));
    const m = manifest({}, { typingsText: undefined, typings: 'link.d.ts' });
    const err = await rpErrorAsync(loadPluginModuleSpecs(dir, m));
    expect(err.code).toBe('PATH_ESCAPE');
    expect(err.message).toContain('symlink');
  });

  it('reports missing files and a missing plugin dir as NOT_FOUND', async () => {
    const m = manifest({}, { docsText: undefined, docs: 'docs/nope.md' });
    expect((await rpErrorAsync(loadPluginModuleSpecs(dir, m))).code).toBe('NOT_FOUND');
    expect((await rpErrorAsync(loadPluginModuleSpecs(path.join(dir, 'missing'), manifest()))).code).toBe('NOT_FOUND');
  });

  it('collects validateModuleSpec problems from every module into one INVALID_ARGUMENT', async () => {
    const m = manifest();
    // clock: `zone` declared in typings but missing from methods, `tick` in methods but not declared
    m.modules[0]!.methods = { now: { description: 'Now.' }, tick: { description: 'Tick.' } };
    // second module: undocumented method
    m.modules.push({
      id: 'bad',
      version: '1.0.0',
      title: 'Bad',
      summary: 'Broken.',
      permission: 'trusted',
      apiTypeName: 'BadApi',
      typingsText: 'interface BadApi {\n  run(): Promise<void>;\n}',
      docsText: 'x',
      methods: { run: { description: 'Run.' } },
    });
    const err = await rpErrorAsync(loadPluginModuleSpecs(dir, m));
    expect(err.code).toBe('INVALID_ARGUMENT');
    const failures = (err.details as { modules: Array<{ module: string; problems: string[] }> }).modules;
    expect(failures.map((f) => f.module)).toEqual(['clock', 'bad']);
    expect(failures[0]!.problems).toEqual([
      'methods.tick is not declared as a method of interface ClockApi in typings',
      'interface ClockApi declares method "zone" which is missing from methods',
    ]);
    expect(failures[1]!.problems).toEqual(['method "run" of interface BadApi has no TSDoc comment']);
    expect(err.message).toContain('clock:');
    expect(err.message).toContain('bad:');
  });
});
