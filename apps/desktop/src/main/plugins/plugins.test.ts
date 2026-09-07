import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilityHandler, CapabilityModuleSpec } from '@rp/shared';
import { JsonFileStorage, createPluginHost } from './host.js';
import { PluginRegistry } from './registry.js';
import { loadPluginModuleSpecsFallback, validatePluginManifestFallback } from './sdk-adapter.js';
import { PluginService } from './service.js';

const TYPINGS = `/** Clock helpers. */
interface ClockApi {
  /**
   * The current time.
   * @returns iso and local strings.
   */
  now(): Promise<{ iso: string; local: string }>;
}`;

const MANIFEST = {
  id: 'com.test.clock',
  name: 'Clock',
  version: '1.0.0',
  modules: [
    { id: 'clock', version: '1.0.0', title: 'Clock', summary: 'Tells the time.', permission: 'trusted', apiTypeName: 'ClockApi', typings: 'modules/clock.d.ts', docsText: 'Use now().', methods: { now: { description: 'Current time.' } } },
  ],
};

/** Records registrations like core's engine.capabilities would. */
function fakeEngine() {
  const registered = new Map<string, { spec: CapabilityModuleSpec; handler: CapabilityHandler }>();
  const events: unknown[] = [];
  return {
    registered,
    events,
    capabilities: {
      list: () => [...registered.values()].map((r) => r.spec),
      register: (spec: CapabilityModuleSpec, handler: CapabilityHandler) => {
        if (registered.has(spec.id)) throw new Error(`duplicate ${spec.id}`);
        registered.set(spec.id, { spec, handler });
      },
      unregister: async (id: string) => {
        const r = registered.get(id);
        await r?.handler.dispose?.();
        return registered.delete(id);
      },
    },
    hostEvents: { emit: (e: unknown) => void events.push(e) },
  };
}

function writePlugin(dir: string, manifest: unknown, main: string): void {
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'modules', 'clock.d.ts'), TYPINGS);
  fs.writeFileSync(path.join(dir, 'main.js'), main);
}

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe('plugin manifest + specs (fallback loaders)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-plugin-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('validates the manifest shape and builds validated specs from files', async () => {
    expect(validatePluginManifestFallback(MANIFEST).id).toBe('com.test.clock');
    expect(() => validatePluginManifestFallback({ ...MANIFEST, id: 'Nope' })).toThrow(/reverse-DNS/);
    expect(() => validatePluginManifestFallback({ ...MANIFEST, modules: [{ ...MANIFEST.modules[0], id: 'Clock!' }] })).toThrow(/modules\[0\]\.id/);
    expect(() => validatePluginManifestFallback({ ...MANIFEST, modules: [] })).toThrow(/non-empty/);
    const dir = path.join(tmp, 'clock');
    writePlugin(dir, MANIFEST, '');
    const specs = await loadPluginModuleSpecsFallback(dir, validatePluginManifestFallback(MANIFEST));
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: 'clock', apiTypeName: 'ClockApi', docs: 'Use now().', methods: { now: { description: 'Current time.' } } });
    expect(specs[0]?.typings).toContain('interface ClockApi');
    const bad = { ...MANIFEST, modules: [{ ...MANIFEST.modules[0], methods: { later: { description: 'not in typings' } } }] };
    await expect(loadPluginModuleSpecsFallback(dir, validatePluginManifestFallback(bad))).rejects.toThrow(/invalid modules/);
  });
});

describe('PluginHost', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-plugin-host-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('storage round-trips through the JSON file and events are prefixed custom:', async () => {
    const store = new JsonFileStorage(path.join(tmp, 'storage.json'));
    await store.set('a', { n: 1 });
    await store.set('b', 'x');
    expect(await store.get('a')).toEqual({ n: 1 });
    expect((await store.keys()).sort()).toEqual(['a', 'b']);
    await store.delete('a');
    expect(await new JsonFileStorage(path.join(tmp, 'storage.json')).get('b')).toBe('x');
    expect(await new JsonFileStorage(path.join(tmp, 'storage.json')).get('a')).toBeUndefined();
    const events: unknown[] = [];
    const notes: string[] = [];
    const host = createPluginHost({ pluginId: 'com.test.x', pluginDir: tmp, dataDir: path.join(tmp, 'data'), appVersion: '0.1.0', logger, notify: (t, b) => notes.push(`${t}|${b}`), emitHostEvent: (e) => events.push(e) });
    host.emitEvent('countdown', { label: 'tea' }, { characterRef: 'com.x/luna' });
    expect(events[0]).toMatchObject({ name: 'custom:countdown', data: { label: 'tea', plugin: 'com.test.x', characterRef: 'com.x/luna' } });
    host.notify('Hi');
    expect(notes).toEqual(['Hi|']);
    const r = await host.exec('node', ['-e', 'console.log("out"); process.exit(3)']);
    expect(r).toMatchObject({ code: 3, stdout: 'out\n' });
    await host.storage.set('k', 1);
    expect(fs.existsSync(path.join(tmp, 'data', 'storage.json'))).toBe(true);
  });
});

describe('PluginService', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-plugin-svc-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const GOOD = (marker: string) => `export function activate(host) {
  host.log.info('activated');
  return { handlers: { clock: { async invoke(method) { if (method === 'now') return { iso: '${marker}', local: 'x' }; throw new Error('unknown ' + method); } } }, dispose() { globalThis.__disposed = (globalThis.__disposed ?? 0) + 1; } };
}`;

  it('loads plugins with error isolation, registers handlers, reloads and disables', async () => {
    const pluginsDir = path.join(tmp, 'plugins');
    writePlugin(path.join(pluginsDir, 'com.test.clock'), MANIFEST, GOOD('v1'));
    writePlugin(path.join(pluginsDir, 'com.test.broken'), { ...MANIFEST, id: 'com.test.broken', modules: [{ ...MANIFEST.modules[0], id: 'boom' }] }, 'export function activate() { throw new Error("kaboom"); }');
    writePlugin(path.join(pluginsDir, 'com.test.shadow'), { ...MANIFEST, id: 'com.test.shadow', modules: [{ ...MANIFEST.modules[0], id: 'media' }] }, GOOD('x'));
    fs.mkdirSync(path.join(pluginsDir, 'not-a-plugin'));
    const engine = fakeEngine();
    const registry = new PluginRegistry(path.join(tmp, 'data', 'plugins.json'));
    const service = new PluginService({ pluginsDir, dataDir: path.join(tmp, 'plugin-data'), registry, engine, builtinIds: new Set(['media', 'chat']), appVersion: '0.1.0', logger });
    const list = await service.loadAll();
    expect(list.map((p) => [p.id, p.state])).toEqual([
      ['com.test.broken', 'error'],
      ['com.test.clock', 'active'],
      ['com.test.shadow', 'error'],
    ]);
    expect(list.find((p) => p.id === 'com.test.broken')?.error).toMatch(/kaboom/);
    expect(list.find((p) => p.id === 'com.test.shadow')?.error).toMatch(/built into the app/);
    expect([...engine.registered.keys()]).toEqual(['clock']);
    const ctx = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: '/', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } as const };
    expect(await engine.registered.get('clock')!.handler.invoke('now', [], ctx)).toEqual({ iso: 'v1', local: 'x' });
    await expect(engine.registered.get('clock')!.handler.invoke('nope', [], ctx)).rejects.toThrow(/plugin com.test.clock.*unknown nope/);
    // Reload picks up new code (cache-busting import) and replaces the handler.
    writePlugin(path.join(pluginsDir, 'com.test.clock'), MANIFEST, GOOD('v2'));
    const before = (globalThis as { __disposed?: number }).__disposed ?? 0;
    const reloaded = await service.reload('com.test.clock');
    expect(reloaded.state).toBe('active');
    expect((globalThis as { __disposed?: number }).__disposed).toBe(before + 1);
    expect(await engine.registered.get('clock')!.handler.invoke('now', [], ctx)).toEqual({ iso: 'v2', local: 'x' });
    // Disable → unregistered and remembered; enable → back.
    expect((await service.setEnabled('com.test.clock', false)).state).toBe('disabled');
    expect(engine.registered.has('clock')).toBe(false);
    expect(new PluginRegistry(path.join(tmp, 'data', 'plugins.json')).isEnabled('com.test.clock')).toBe(false);
    expect((await service.setEnabled('com.test.clock', true)).state).toBe('active');
    expect(engine.registered.has('clock')).toBe(true);
    // Install from an outside folder copies it in; remove deletes it.
    const outside = path.join(tmp, 'outside', 'com.test.other');
    writePlugin(outside, { ...MANIFEST, id: 'com.test.other', modules: [{ ...MANIFEST.modules[0], id: 'other' }] }, GOOD('o').replace('clock:', 'other:'));
    const installed = await service.install(outside);
    expect(installed).toMatchObject({ id: 'com.test.other', state: 'active', dir: path.join(pluginsDir, 'com.test.other') });
    expect(engine.registered.has('other')).toBe(true);
    await service.remove('com.test.other');
    expect(fs.existsSync(path.join(pluginsDir, 'com.test.other'))).toBe(false);
    expect(engine.registered.has('other')).toBe(false);
    await expect(service.install(path.join(pluginsDir, 'com.test.shadow'))).rejects.toThrow(/built into the app/);
    await service.dispose();
    expect(engine.registered.size).toBe(0);
  });
});
