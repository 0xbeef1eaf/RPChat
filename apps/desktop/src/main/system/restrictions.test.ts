import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_RESTRICTIONS } from '@rp/shared';
import type { AppRestrictions } from '@rp/shared';
import { RESTRICTED_CHANNELS, activeRestrictions, isRestrictable, refusalFor, rulesFor } from './restrictions.js';
import { appRestrictions, parsePolicy } from './policy.js';
import { INVOKE_METHODS } from '../../preload/api.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

/** Defaults with the named keys flipped away from permissive. */
function withOff(...keys: Array<keyof AppRestrictions>): AppRestrictions {
  const out = { ...DEFAULT_APP_RESTRICTIONS };
  for (const k of keys) out[k] = k.startsWith('require') ? true : false;
  return out;
}

describe('app restrictions — parsing', () => {
  it('defaults to permissive without a policy, a file or an app block', () => {
    expect(appRestrictions(null)).toEqual(DEFAULT_APP_RESTRICTIONS);
    expect(appRestrictions(parsePolicy({ version: 1 }))).toEqual(DEFAULT_APP_RESTRICTIONS);
    expect(appRestrictions(parsePolicy({ version: 1, app: {} }))).toEqual(DEFAULT_APP_RESTRICTIONS);
    // Every allow* defaults true and every require* false, so an old policy behaves as before.
    expect(DEFAULT_APP_RESTRICTIONS.allowPackEditor).toBe(true);
    expect(DEFAULT_APP_RESTRICTIONS.requireCharacterSession).toBe(false);
  });

  it('reads each restriction and leaves the others alone', () => {
    const p = parsePolicy({ version: 1, app: { allowSandbox: false, requireCharacterSession: true } });
    expect(appRestrictions(p)).toEqual(withOff('allowSandbox', 'requireCharacterSession'));
    expect(appRestrictions(parsePolicy({ version: 1, app: { allowPackEditor: false } })).allowPackRemove).toBe(true);
  });

  it('rejects non-booleans and keeps allowQuit/users working alongside', () => {
    expect(() => parsePolicy({ version: 1, app: { allowSandbox: 'no' } })).toThrow(/app\.allowSandbox must be a boolean/);
    expect(() => parsePolicy({ version: 1, app: { requireCharacterSession: 1 } })).toThrow(/app\.requireCharacterSession must be a boolean/);
    const both = parsePolicy({ version: 1, app: { allowQuit: false, users: ['alice'], allowPackRemove: false } });
    expect(both.app).toEqual({ allowQuit: false, users: ['alice'], allowPackRemove: false });
  });
});

describe('app restrictions — which channels they close', () => {
  it('refuses nothing while everything is allowed', () => {
    for (const channel of Object.keys(RESTRICTED_CHANNELS)) {
      expect(refusalFor(channel.replace(':*', ':anything'), DEFAULT_APP_RESTRICTIONS)).toBeNull();
    }
    expect(refusalFor('chat:send', withOff('allowSandbox', 'allowPackEditor'))).toBeNull();
  });

  it('closes the whole editor namespace on allowPackEditor', () => {
    const off = withOff('allowPackEditor');
    for (const method of ['create', 'saveScript', 'removeMedia', 'exportPack', 'installToApp']) {
      expect(refusalFor(`editor:${method}`, off), method).toMatch(/pack editor is disabled/i);
    }
    // A namespace it does not name stays open.
    expect(refusalFor('packs:list', off)).toBeNull();
  });

  it('maps each guard to its own channels', () => {
    expect(refusalFor('packs:uninstall', withOff('allowPackRemove'))).toMatch(/Removing a pack/);
    expect(refusalFor('packs:install', withOff('allowPackInstall'))).toMatch(/Installing a pack/);
    expect(refusalFor('sessions:remove', withOff('allowDeleteSession'))).toMatch(/Deleting a session/);
    expect(refusalFor('sessions:clearMessages', withOff('allowDeleteHistory'))).toMatch(/chat history/);
    expect(refusalFor('sessions:removeMessage', withOff('allowDeleteHistory'))).toMatch(/Deleting a message/);
    expect(refusalFor('memories:remove', withOff('allowDeleteMemories'))).toMatch(/Deleting a memory/);
    expect(refusalFor('events:remove', withOff('allowRemoveEvents'))).toMatch(/event handler/);
    expect(refusalFor('sandbox:run', withOff('allowSandbox'))).toMatch(/sandbox script/);
    expect(refusalFor('sandbox:cancel', withOff('allowSandbox'))).toMatch(/sandbox script/);
  });

  it('keeps reading operations open when only the writing ones are closed', () => {
    const off = withOff('allowPackRemove', 'allowPackInstall', 'allowDeleteSession', 'allowDeleteHistory', 'allowDeleteMemories', 'allowRemoveEvents');
    for (const open of ['packs:list', 'sessions:list', 'sessions:messages', 'memories:list', 'events:list', 'chat:send']) {
      expect(refusalFor(open, off), open).toBeNull();
    }
  });

  it('freezes the pack store through the editor too, even with the editor open', () => {
    // `allowPackEditor` still true: the editor works, but it may not write into the pack store.
    const off = withOff('allowPackInstall');
    expect(refusalFor('editor:saveManifest', off)).toBeNull();
    expect(refusalFor('editor:exportPack', off)).toBeNull();
    expect(refusalFor('editor:installToApp', off)).toMatch(/Installing a pack/);
  });

  it('names the policy owner when one is stated', () => {
    expect(refusalFor('sandbox:run', withOff('allowSandbox'), 'the household admin')).toMatch(/managed by the household admin/);
    expect(refusalFor('sandbox:run', withOff('allowSandbox'))).not.toMatch(/managed by/);
  });

  it('knows which channels could ever be restricted, so the rest skip the policy read', () => {
    expect(isRestrictable('editor:read')).toBe(true);
    expect(isRestrictable('packs:uninstall')).toBe(true);
    expect(isRestrictable('packs:list')).toBe(false);
    expect(isRestrictable('chat:send')).toBe(false);
    expect(isRestrictable('nocolon')).toBe(false);
  });

  it('applies the namespace rule before the channel rule', () => {
    expect(rulesFor('editor:installToApp').map((r) => r.key)).toEqual(['allowPackEditor', 'allowPackInstall']);
    expect(rulesFor('packs:uninstall').map((r) => r.key)).toEqual(['allowPackRemove']);
    expect(rulesFor('packs:list')).toEqual([]);
  });
});

describe('activeRestrictions', () => {
  it('lists nothing by default and one name per restriction in force', () => {
    expect(activeRestrictions(DEFAULT_APP_RESTRICTIONS)).toEqual([]);
    expect(activeRestrictions(withOff('allowSandbox', 'requireCharacterSession'))).toEqual(['allowSandbox', 'requireCharacterSession']);
  });
});

describe('the restriction table matches the real IPC surface', () => {
  it('names only channels that exist, so a rename cannot silently unguard one', () => {
    const real = new Set<string>();
    for (const [ns, methods] of Object.entries(INVOKE_METHODS)) for (const m of methods) real.add(`${ns}:${m}`);
    for (const channel of Object.keys(RESTRICTED_CHANNELS)) {
      if (channel.endsWith(':*')) {
        const ns = channel.slice(0, -2);
        expect([...real].some((c) => c.startsWith(`${ns}:`)), `${channel} covers no channel`).toBe(true);
        continue;
      }
      expect(real.has(channel), `${channel} is not an IpcApi channel`).toBe(true);
    }
  });

  it('guards every channel the seven guards name', () => {
    const mustBeGuarded = ['packs:uninstall', 'packs:install', 'sessions:remove', 'sessions:clearMessages', 'sessions:removeMessage', 'memories:remove', 'events:remove', 'sandbox:run', 'sandbox:cancel', 'editor:installToApp'];
    for (const c of mustBeGuarded) expect(isRestrictable(c), c).toBe(true);
  });
});

describe('the shipped policy templates', () => {
  const dist = path.resolve(url.fileURLToPath(import.meta.url), '../../../../../../native/rp-coded/dist');

  it('parse, and say what they claim to say', () => {
    const example = parsePolicy(JSON.parse(fs.readFileSync(path.join(dist, 'policy.example.json'), 'utf8')));
    // The example is "every key at its default": it must change nothing.
    expect(appRestrictions(example)).toEqual(DEFAULT_APP_RESTRICTIONS);
    expect(activeRestrictions(appRestrictions(example))).toEqual([]);

    const allOn = parsePolicy(JSON.parse(fs.readFileSync(path.join(dist, 'policy.all-on.json'), 'utf8')));
    // The all-on template locks every one of them.
    const r = appRestrictions(allOn);
    expect(activeRestrictions(r).length).toBe(Object.keys(DEFAULT_APP_RESTRICTIONS).length);
    expect(r.allowSandbox).toBe(false);
    expect(r.requireCharacterSession).toBe(true);
    expect(allOn.app?.allowQuit).toBe(false);
  });
});
