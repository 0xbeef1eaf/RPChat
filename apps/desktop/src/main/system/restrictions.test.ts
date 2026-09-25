import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_RESTRICTIONS } from '@rp/shared';
import type { AppRestrictions } from '@rp/shared';
import { RESTRICTED_CHANNELS, TURN_STOPPING_CHANNELS, activeRestrictions, isRestrictable, refusalFor, refusalForStoppingTurn, rulesFor, stopsRunningTurn } from './restrictions.js';
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
    expect(refusalFor('sessions:resetState', withOff('allowResetState'))).toMatch(/Resetting the session state/);
    expect(refusalFor('memories:remove', withOff('allowDeleteMemories'))).toMatch(/Deleting a memory/);
    expect(refusalFor('events:remove', withOff('allowRemoveEvents'))).toMatch(/event handler/);
    expect(refusalFor('media:closeAll', withOff('allowCloseMedia'))).toMatch(/Closing a character’s media/);
    expect(refusalFor('sandbox:run', withOff('allowSandbox'))).toMatch(/sandbox script/);
    expect(refusalFor('sandbox:cancel', withOff('allowSandbox'))).toMatch(/sandbox script/);
  });

  it('keeps reading operations open when only the writing ones are closed', () => {
    const off = withOff('allowPackRemove', 'allowPackInstall', 'allowDeleteSession', 'allowDeleteHistory', 'allowDeleteMemories', 'allowRemoveEvents');
    for (const open of ['packs:list', 'sessions:list', 'sessions:messages', 'memories:list', 'events:list', 'chat:send']) {
      expect(refusalFor(open, off), open).toBeNull();
    }
  });

  it('keeps the messages reachable when only the reset is closed, and the reset when only they are', () => {
    // A reset is not a delete and a delete is not a reset: neither key covers the other.
    const noReset = withOff('allowResetState');
    expect(refusalFor('sessions:clearMessages', noReset)).toBeNull();
    expect(refusalFor('sessions:removeMessage', noReset)).toBeNull();
    expect(refusalFor('events:remove', noReset)).toBeNull();
    const noHistory = withOff('allowDeleteHistory');
    expect(refusalFor('sessions:resetState', noHistory)).toBeNull();
  });

  it('takes only the by-hand sweep away with allowCloseMedia, leaving the rest of the media channel open', () => {
    const off = withOff('allowCloseMedia');
    // The window's own reports still arrive: a click or a timeout still closes what it closed.
    expect(refusalFor('media:report', off)).toBeNull();
    // And nothing else in the app is touched.
    expect(refusalFor('chat:send', off)).toBeNull();
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

  it('guards every channel the guards name', () => {
    const mustBeGuarded = ['packs:uninstall', 'packs:install', 'chat:abort', 'sessions:remove', 'sessions:clearMessages', 'sessions:removeMessage', 'sessions:resetState', 'memories:remove', 'events:remove', 'media:closeAll', 'sandbox:run', 'sandbox:cancel', 'editor:installToApp'];
    for (const c of mustBeGuarded) expect(isRestrictable(c), c).toBe(true);
  });

  it('names only real channels among the ones that stop a running turn', () => {
    const real = new Set<string>();
    for (const [ns, methods] of Object.entries(INVOKE_METHODS)) for (const m of methods) real.add(`${ns}:${m}`);
    for (const channel of TURN_STOPPING_CHANNELS) expect(real.has(channel), `${channel} is not an IpcApi channel`).toBe(true);
  });
});

describe('allowStopGeneration', () => {
  it('refuses the Stop button outright', () => {
    expect(refusalFor('chat:abort', withOff('allowStopGeneration'))).toMatch(/Stopping a reply is disabled/);
    expect(refusalFor('chat:abort', DEFAULT_APP_RESTRICTIONS)).toBeNull();
    // Sending and retrying are not stopping, so the table itself leaves them alone.
    expect(refusalFor('chat:send', withOff('allowStopGeneration'))).toBeNull();
    expect(refusalFor('chat:retry', withOff('allowStopGeneration'))).toBeNull();
    // Nor is resetting: with its own key still on, a reset is refused only while a reply runs.
    expect(refusalFor('sessions:resetState', withOff('allowStopGeneration'))).toBeNull();
  });

  it('knows which channels cut a reply short on their way past', () => {
    for (const c of ['chat:retry', 'sessions:resetState', 'sessions:removeMessage', 'sessions:clearMessages']) {
      expect(stopsRunningTurn(c), c).toBe(true);
    }
    // `chat:abort` is refused by the table instead; nothing else is in the set.
    expect(stopsRunningTurn('chat:abort')).toBe(false);
    expect(stopsRunningTurn('chat:send')).toBe(false);
    expect(stopsRunningTurn('sessions:remove')).toBe(false);
  });

  it('refuses those only when the restriction is in force, and says to wait', () => {
    expect(refusalForStoppingTurn(DEFAULT_APP_RESTRICTIONS)).toBeNull();
    // Another restriction being off does not make a running reply untouchable.
    expect(refusalForStoppingTurn(withOff('allowDeleteHistory'))).toBeNull();
    expect(refusalForStoppingTurn(withOff('allowResetState'))).toBeNull();
    expect(refusalForStoppingTurn(withOff('allowStopGeneration'))).toBe('Stopping a reply is disabled by the system policy: wait for this one to finish');
    expect(refusalForStoppingTurn(withOff('allowStopGeneration'), 'the household admin')).toMatch(/managed by the household admin\): wait for this one to finish$/);
  });
});

describe('the shipped policy templates', () => {
  const dist = path.resolve(url.fileURLToPath(import.meta.url), '../../../../../../native/rpchatd/dist');

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
