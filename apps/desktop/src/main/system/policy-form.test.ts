/**
 * The Settings → System policy form against the daemon's own validator. The policy file is
 * write-once, so a file the form lets a user build and the daemon then refuses leaves the machine
 * with no policy at all — these hold the two sides to the same rules.
 */
import type { AppSettings, PolicyFile } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { describe, expect, it } from 'vitest';
import { POLICY_SETTINGS, policyDraftFrom, policyDraftProblems, policyDraftToFile } from '../../renderer/lib/policy';
import type { PolicyDraft } from '../../renderer/lib/policy';
import { policyTemplate } from './integration';
import { managedPaths, parsePolicy } from './policy';

/** The very template the dialog is seeded with, from the same generator the daemon path uses. */
const base: AppSettings = defaultSettings();
const settings: AppSettings = { ...base, maxInputLockMs: 42_000, displayBackend: 'electron', web: { ...base.web, allowlist: ['a.example'] }, permissions: { moduleAllow: { desktop: false, web: true } } };
const POLICY_TEMPLATE = JSON.parse(policyTemplate(settings, 'alice')) as PolicyFile;

/** Drafts spanning what the form can produce: untouched, empty, maximally strict, partly forced. */
function drafts(): Array<[string, PolicyDraft]> {
  const seeded = policyDraftFrom(POLICY_TEMPLATE);

  const empty = policyDraftFrom({ version: 1 });

  const strict = policyDraftFrom(POLICY_TEMPLATE);
  strict.managedBy = 'IT';
  strict.app = { ...strict.app, allowQuit: false, users: ['alice', 'bob'] };
  for (const key of Object.keys(strict.app.restrictions) as Array<keyof typeof strict.app.restrictions>) {
    strict.app.restrictions[key] = key === 'requireCharacterSession';
  }
  strict.inputLock = { enabled: false, maxDurationMs: 1000, emergencyKey: 'f12', emergencyHoldMs: 500 };
  strict.guard = {
    mode: 'enforce',
    protectApp: true,
    wallpaper: true,
    compositorIpc: 'deny',
    shell: ['noctalia', 'awww'],
    loginHelpers: ['/usr/bin/greetd'],
    extraDenyPaths: ['~/.config/hypr/hyprpaper.conf', '@{HOME}/.local/state/x'],
    extraDenySockets: ['/run/user/1000/some.sock'],
    allowBinaries: ['/usr/bin/systemctl'],
  };

  const partial = policyDraftFrom(POLICY_TEMPLATE);
  for (const [i, spec] of POLICY_SETTINGS.entries()) partial.forced[spec.path] = i % 2 === 0;

  const nothing = policyDraftFrom(POLICY_TEMPLATE);
  for (const spec of POLICY_SETTINGS) nothing.forced[spec.path] = false;
  nothing.app.users = [];
  nothing.guard = { ...nothing.guard, shell: [], loginHelpers: [] };

  return [
    ['the template as it arrives', seeded],
    ['a policy that forces nothing', empty],
    ['the strictest the form allows', strict],
    ['every other key forced', partial],
    ['nothing forced and every optional list empty', nothing],
  ];
}

describe('the policy form', () => {
  it.each(drafts())('builds a file the daemon accepts: %s', (_what, draft) => {
    expect(policyDraftProblems(draft)).toEqual([]);
    expect(() => parsePolicy(policyDraftToFile(draft))).not.toThrow();
  });

  it.each(drafts())('builds a file that survives JSON, as it is sent: %s', (_what, draft) => {
    const file = policyDraftToFile(draft);
    expect(parsePolicy(JSON.parse(JSON.stringify(file)))).toEqual(parsePolicy(file));
  });

  it('reports every key it switched on as managed, and no others', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    for (const [i, spec] of POLICY_SETTINGS.entries()) draft.forced[spec.path] = i % 2 === 0;
    const managed = managedPaths(parsePolicy(policyDraftToFile(draft)));

    for (const spec of POLICY_SETTINGS) {
      // `moduleAllow` is reported one module at a time, and `allowDowngrade` is a daemon rule
      // rather than a setting the UI pins, so neither appears under its own path.
      if (spec.path === 'permissions.moduleAllow' || spec.path === 'updates.allowDowngrade') continue;
      expect(managed.includes(spec.path)).toBe(draft.forced[spec.path] === true);
    }
    const modules = Object.keys(POLICY_TEMPLATE.settings?.permissions?.moduleAllow ?? {});
    expect(modules.length).toBeGreaterThan(0);
    for (const id of modules) expect(managed.includes(`permissions.moduleAllow.${id}`)).toBe(draft.forced['permissions.moduleAllow'] === true);
  });

  it('refuses in the form exactly what the daemon refuses: a guard with nobody to confine', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.guard = { ...draft.guard, mode: 'enforce' };
    draft.app = { ...draft.app, users: [] };
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('session guard')]);
    expect(() => parsePolicy(policyDraftToFile(draft))).toThrow(/guard\.mode needs app\.users/);
  });

  it('refuses in the form what the daemon refuses about the input lock', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.inputLock = { ...draft.inputLock, maxDurationMs: 999, emergencyHoldMs: 499 };
    expect(policyDraftProblems(draft)).toHaveLength(2);
    expect(() => parsePolicy(policyDraftToFile(draft))).toThrow(/maxDurationMs|emergencyHoldMs/);
  });

  it('covers every settings key the daemon is willing to force', () => {
    // A key added to `parsePolicy` but not to the form's table would be silently uneditable, so
    // the two lists are compared through what the daemon reports as managed.
    const everything = policyDraftFrom(POLICY_TEMPLATE);
    for (const spec of POLICY_SETTINGS) everything.forced[spec.path] = true;
    const managed = managedPaths(parsePolicy(policyDraftToFile(everything)));
    const expected = new Set<string>();
    for (const spec of POLICY_SETTINGS) {
      if (spec.path === 'permissions.moduleAllow') {
        for (const id of Object.keys(POLICY_TEMPLATE.settings?.permissions?.moduleAllow ?? {})) expected.add(`permissions.moduleAllow.${id}`);
      } else if (spec.path !== 'updates.allowDowngrade') expected.add(spec.path);
    }
    expect([...managed].sort()).toEqual([...expected].sort());
  });
});
