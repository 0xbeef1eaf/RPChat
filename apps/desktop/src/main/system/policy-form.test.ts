/**
 * The Settings → System policy form against the daemon's own validator. The policy file is
 * write-once, so a file the form lets a user build and the daemon then refuses leaves the machine
 * with no policy at all — these hold the two sides to the same rules.
 */
import type { AppSettings, PolicyFile } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { describe, expect, it } from 'vitest';
import { POLICY_SETTINGS, packSourceProblem, policyDraftFrom, policyDraftProblems, policyDraftToFile, policyEffects, policyUrlProblem } from '../../renderer/lib/policy';
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
  strict.remote = { enabled: true, url: 'https://policies.example.com/rpchat.json', intervalMinutes: 15 };
  strict.packs = {
    sources: [
      { id: 'luna', url: 'https://packs.example.com/luna.rppack', signature: 'a'.repeat(86), version: '1.2.0' },
      { id: 'onboarding', url: 'https://packs.example.com/onboarding.rppack' },
    ],
    removeUnlisted: true,
    refreshMinutes: 60,
  };
  strict.lock = { enabled: true, digits: 8, period: 60, selfHeal: true, immutable: true, refuseManualStop: true, denyEscapes: true };

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

  it('refuses in the form exactly what the daemon refuses: a remote source that is not https', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.remote = { enabled: true, url: 'http://policies.example.com/p.json', intervalMinutes: 60 };
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('https://')]);
    expect(() => parsePolicy(policyDraftToFile(draft))).toThrow(/remote\.url/);
    // The loopback is the documented exception on both sides.
    draft.remote.url = 'http://127.0.0.1:8080/p.json';
    expect(policyDraftProblems(draft)).toEqual([]);
    expect(() => parsePolicy(policyDraftToFile(draft))).not.toThrow();
    expect(policyUrlProblem('https://x/y')).toBeNull();
  });

  it('refuses in the form exactly what the daemon refuses: a pack the daemon would not take', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.packs = { sources: [{ id: 'Luna', url: 'https://packs.example.com/luna.rppack' }], removeUnlisted: false, refreshMinutes: 360 };
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('not a pack id')]);
    expect(() => parsePolicy(policyDraftToFile(draft))).toThrow(/pack id/);
    draft.packs.sources = [{ id: 'luna', url: 'https://packs.example.com/luna.rppack', sha256: 'nope' }];
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('64 hex')]);
    draft.packs.sources = [{ id: 'luna', url: 'https://packs.example.com/luna.rppack', signature: 'not a signature' }];
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('Ed25519 signature')]);
    expect(packSourceProblem({ id: 'luna', url: 'https://x/y.rppack' })).toBeNull();
    // A pack listed twice is refused here as well as by the daemon.
    draft.packs.sources = [
      { id: 'luna', url: 'https://x/y.rppack' },
      { id: 'luna', url: 'https://x/z.rppack' },
    ];
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('twice')]);
  });

  it('says in the footer what remote management and the lock add', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.remote = { enabled: true, url: 'https://policies.example.com/p.json', intervalMinutes: 30 };
    draft.packs = { sources: [{ id: 'luna', url: 'https://x/y.rppack' }], removeUnlisted: true, refreshMinutes: 360 };
    draft.lock = { enabled: true, digits: 6, period: 30, selfHeal: true, immutable: true, refuseManualStop: true, denyEscapes: true };
    const texts = policyEffects(draft).map((e) => e.text);
    expect(texts).toContain('policy fetched from policies.example.com every 30 min');
    expect(texts).toContain('1 pack installed by policy, others removed');
    expect(texts).toContain('locked behind a code once sealed');
  });

  it('keeps the remote, packs and lock blocks when a policy is loaded back into the form', () => {
    const policy: PolicyFile = {
      version: 1,
      remote: { url: 'https://policies.example.com/p.json', intervalMinutes: 15 },
      packs: { sources: [{ id: 'luna', url: 'https://x/y.rppack', signature: 'b'.repeat(86), version: '2.0.0' }], removeUnlisted: true, refreshMinutes: 45 },
      lock: { digits: 8, period: 45, selfHeal: false, immutable: false, refuseManualStop: false, denyEscapes: false },
    };
    const round = policyDraftToFile(policyDraftFrom(policy));
    expect(round.remote).toEqual(policy.remote);
    expect(round.packs).toEqual(policy.packs);
    expect(round.lock).toEqual(policy.lock);
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
