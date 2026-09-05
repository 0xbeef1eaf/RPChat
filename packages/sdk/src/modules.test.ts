import { describe, expect, it } from 'vitest';
import { createStandardRegistry, validateModuleSpec, modules } from './index.js';

const EXPECTED: Record<string, { permission: string; methods: string[] }> = {
  chat: { permission: 'trusted', methods: ['say', 'emote', 'history', 'setStatus'] },
  log: { permission: 'trusted', methods: ['debug', 'info', 'warn', 'error'] },
  state: {
    permission: 'trusted',
    methods: ['get', 'set', 'delete', 'keys', 'all', 'session.get', 'session.set', 'session.delete', 'session.keys', 'session.all'],
  },
  pack: { permission: 'trusted', methods: ['asset', 'listAssets', 'readText', 'info'] },
  timers: { permission: 'trusted', methods: ['schedule', 'cancel', 'list'] },
  memory: { permission: 'trusted', methods: ['remember', 'recall', 'recent', 'update', 'forget'] },
  display: { permission: 'trusted', methods: ['monitors', 'backend'] },
  media: { permission: 'pack', methods: ['showImage', 'playVideo', 'playAudio', 'update', 'close', 'closeAll', 'list'] },
  ui: { permission: 'pack', methods: ['notify', 'confirm', 'choose'] },
  wallpaper: { permission: 'pack', methods: ['set', 'restore', 'current'] },
  browser: { permission: 'pack', methods: ['open'] },
  input: { permission: 'prompt', methods: ['lock', 'unlock', 'status'] },
  system: { permission: 'prompt', methods: ['openExternal', 'exec', 'readFile', 'writeFile', 'clipboardWrite'] },
};

describe('standard modules', () => {
  it('are all valid specs', () => {
    for (const spec of modules.standardModules) {
      expect(validateModuleSpec(spec), spec.id).toEqual([]);
    }
  });

  it('are exported individually and registered in canonical order', () => {
    const r = createStandardRegistry();
    expect(r.list().map((m) => m.id)).toEqual(Object.keys(EXPECTED));
    expect(modules.standardModules.map((m) => m.id)).toEqual(Object.keys(EXPECTED));
    expect(modules.chatModule.id).toBe('chat');
    expect(modules.logModule.id).toBe('log');
    expect(modules.stateModule.id).toBe('state');
    expect(modules.packModule.id).toBe('pack');
    expect(modules.timersModule.id).toBe('timers');
    expect(modules.displayModule.id).toBe('display');
    expect(modules.mediaModule.id).toBe('media');
    expect(modules.uiModule.id).toBe('ui');
    expect(modules.systemModule.id).toBe('system');
  });

  it('expose exactly the methods and permissions from the spec', () => {
    const r = createStandardRegistry();
    for (const [id, exp] of Object.entries(EXPECTED)) {
      const spec = r.get(id)!;
      expect(spec.permission, id).toBe(exp.permission);
      expect(Object.keys(spec.methods), id).toEqual(exp.methods);
      expect(spec.apiTypeName).toBe(`${id[0]!.toUpperCase()}${id.slice(1)}Api`);
      expect(spec.docs.split('\n').length).toBeLessThanOrEqual(20);
      expect(spec.docs).toContain('```ts');
    }
  });

  it('marks every system method dangerous and prompt-level', () => {
    const r = createStandardRegistry();
    for (const [name, m] of Object.entries(modules.systemModule.methods)) {
      expect(m.dangerous, name).toBe(true);
      expect(r.permissionFor('system', name)).toBe('prompt');
    }
  });

  it('documents every method with parameters and return values where they exist', () => {
    // Every "@param" mentioned must correspond to a real parameter name of that method.
    for (const spec of modules.standardModules) {
      const paramDocs = spec.typings.matchAll(/@param\s+(\w+)/g);
      for (const m of paramDocs) {
        expect(spec.typings, `${spec.id}: @param ${m[1]}`).toMatch(new RegExp(`[(,]\\s*${m[1]}\\??:`));
      }
    }
  });
});
