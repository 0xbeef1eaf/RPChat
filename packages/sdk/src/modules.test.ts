import { describe, expect, it } from 'vitest';
import { createStandardRegistry, validateModuleSpec, modules } from './index.js';

const EXPECTED: Record<string, { permission: string; methods: string[] }> = {
  chat: { permission: 'trusted', methods: ['say', 'emote', 'history', 'setStatus'] },
  log: { permission: 'trusted', methods: ['debug', 'info', 'warn', 'error'] },
  state: {
    permission: 'trusted',
    methods: ['get', 'set', 'delete', 'keys', 'all', 'session.get', 'session.set', 'session.delete', 'session.keys', 'session.all'],
  },
  pack: { permission: 'trusted', methods: ['asset', 'listAssets', 'findAssets', 'tags', 'readText', 'info'] },
  timers: { permission: 'trusted', methods: ['schedule', 'runLater', 'cancel', 'list'] },
  llm: { permission: 'trusted', methods: ['ask', 'wake'] },
  memory: { permission: 'trusted', methods: ['remember', 'recall', 'recent', 'update', 'forget'] },
  display: { permission: 'trusted', methods: ['monitors', 'backend'] },
  media: { permission: 'pack', methods: ['showImage', 'playVideo', 'playAudio', 'update', 'close', 'closeAll', 'list'] },
  ui: { permission: 'pack', methods: ['notify', 'confirm', 'choose', 'ask', 'pickFile', 'pickFolder'] },
  wallpaper: { permission: 'pack', methods: ['set', 'restore', 'current'] },
  browser: { permission: 'pack', methods: ['open'] },
  input: { permission: 'pack', methods: ['lock', 'unlock', 'gag', 'ungag', 'status', 'type', 'key', 'click', 'moveMouse'] },
  presence: { permission: 'pack', methods: ['status', 'nowPlaying', 'activeWindow', 'idleMs'] },
  screen: { permission: 'pack', methods: ['look', 'draw', 'clear'] },
  calendar: { permission: 'pack', methods: ['upcoming', 'today'] },
  web: { permission: 'pack', methods: ['fetch', 'rss', 'weather'] },
  events: { permission: 'trusted', methods: ['on', 'off', 'list', 'emit'] },
  avatar: { permission: 'pack', methods: ['show', 'set', 'say', 'animate', 'moveTo', 'hide', 'state', 'expressions'] },
  widgets: { permission: 'pack', methods: ['show', 'update', 'close', 'closeAll', 'list'] },
  voice: { permission: 'pack', methods: ['speak', 'stop', 'listen'] },
  desktop: {
    permission: 'pack',
    methods: ['launch', 'listWindows', 'focusWindow', 'moveWindow', 'workspace', 'currentWorkspace', 'setVolume', 'getVolume', 'setBrightness', 'doNotDisturb', 'setTheme'],
  },
  files: { permission: 'pack', methods: ['write', 'append', 'read', 'list', 'delete', 'open', 'homePath'] },
  mood: { permission: 'trusted', methods: ['get', 'nudge', 'set'] },
  routine: { permission: 'trusted', methods: ['set', 'get', 'now', 'override'] },
  messaging: { permission: 'pack', methods: ['send', 'channels'] },
  system: { permission: 'pack', methods: ['openExternal', 'exec', 'readFile', 'writeFile', 'clipboardWrite', 'clipboardRead'] },
};

/** Method-level overrides required by docs/spec/living.md §1: (P) = permission 'prompt', (D) = dangerous. */
const OVERRIDES: Record<string, { prompt?: string[]; dangerous?: string[] }> = {
  wallpaper: { dangerous: ['set'] },
  browser: { dangerous: ['open'] },
  screen: { dangerous: ['look'] },
  web: { dangerous: ['fetch'] },
  voice: { dangerous: ['listen'] },
  desktop: { dangerous: ['launch'] },
  files: { dangerous: ['open'] },
  messaging: { dangerous: ['send'] },
  input: { dangerous: ['lock', 'unlock', 'gag', 'ungag', 'type', 'key', 'click', 'moveMouse'] },
  system: { dangerous: ['openExternal', 'exec', 'readFile', 'writeFile', 'clipboardWrite', 'clipboardRead'] },
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
    for (const id of ['presence', 'screen', 'calendar', 'web', 'events', 'avatar', 'widgets', 'voice', 'desktop', 'files', 'mood', 'routine', 'messaging']) {
      const exported = (modules as Record<string, unknown>)[`${id}Module`] as { id: string } | undefined;
      expect(exported?.id, id).toBe(id);
    }
    // phase-2 modules sit after the v1 modules and before `system`, which stays last.
    const ids = r.list().map((m) => m.id);
    expect(ids.at(-1)).toBe('system');
    expect(ids.indexOf('presence')).toBe(ids.indexOf('input') + 1);
    expect(ids.slice(ids.indexOf('presence'), -1)).toEqual(['presence', 'screen', 'calendar', 'web', 'events', 'avatar', 'widgets', 'voice', 'desktop', 'files', 'mood', 'routine', 'messaging']);
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

  it('applies exactly the method-level prompt/dangerous overrides from the spec', () => {
    const r = createStandardRegistry();
    for (const spec of r.list()) {
      const exp = OVERRIDES[spec.id] ?? {};
      const prompted = Object.entries(spec.methods).filter(([, m]) => m.permission !== undefined).map(([n]) => n);
      const dangerous = Object.entries(spec.methods).filter(([, m]) => m.dangerous).map(([n]) => n);
      expect(prompted, `${spec.id} prompt overrides`).toEqual(exp.prompt ?? []);
      expect(dangerous, `${spec.id} dangerous`).toEqual(exp.dangerous ?? []);
      for (const name of exp.prompt ?? []) expect(r.permissionFor(spec.id, name)).toBe('prompt');
    }
    expect(modules.inputModule.version).toBe('1.2.0');
    expect(modules.systemModule.version).toBe('1.1.0');
  });

  it('marks every system method dangerous and pack-level (nothing built-in prompts per call)', () => {
    const r = createStandardRegistry();
    for (const [name, m] of Object.entries(modules.systemModule.methods)) {
      expect(m.dangerous, name).toBe(true);
      expect(r.permissionFor('system', name)).toBe('pack');
    }
    for (const spec of r.list()) {
      expect(spec.permission, spec.id).not.toBe('prompt');
      for (const [name, m] of Object.entries(spec.methods)) expect(m.permission, `${spec.id}.${name}`).not.toBe('prompt');
    }
  });

  it('presence docs steer the model to the prompt senses line', () => {
    expect(modules.presenceModule.docs).toMatch(/<senses>/);
    expect(modules.presenceModule.docs).toMatch(/status\(\).*fresh numbers/);
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
