import type { PolicyFile } from '@rp/shared';
import { describe, expect, it } from 'vitest';
import { POLICY_DEV, POLICY_SETTINGS, guardPathProblem, policyDraftFrom, policyDraftProblems, policyDraftToFile, policyEffects, policyRefusals, toggleShell, userNameProblem } from './policy';

/**
 * A stand-in for the daemon's template: every settings key present, every block a no-op. That the
 * files the form builds survive the daemon's own validator is checked in
 * `main/system/policy-form.test.ts`, which seeds itself from the real generator.
 */
const POLICY_TEMPLATE: PolicyFile = {
  version: 1,
  managedBy: '',
  settings: {
    maxInputLockMs: 300_000,
    autonomy: { maxSelfWakesPerHour: 30, maxConsecutiveSelfWakes: 10, maxTimersPerSession: 20, minRepeatIntervalMs: 60_000, minDelayMs: 30_000 },
    permissions: { functionAllow: { 'web.fetch': true, desktop: false } },
    web: { allowlist: ['example.com'] },
    desktop: { launchAllowlist: [] },
    memory: { enabled: true, consolidateEveryTurns: 8, maxEntriesPerCharacter: 300, promptBudgetTokens: 600 },
    senses: { includeInPrompt: true, watchDirs: [], calendarSources: [] },
    displayBackend: 'auto',
    updates: { enabled: true, automatic: true },
    browser: { allowBlocking: true, allowEval: true, allowHistory: true },
    media: { maxConcurrent: { image: 0, video: 0, audio: 0 }, maxQueued: { image: 8, video: 8, audio: 8 } },
  },
  inputLock: { enabled: true, maxDurationMs: 300_000, emergencyKey: 'esc', emergencyHoldMs: 5000 },
  app: { allowQuit: true, users: ['alice'] },
  guard: { mode: 'off', protectApp: true, wallpaper: true, compositorIpc: 'shell-only', shell: 'auto', extraDenyPaths: [], extraDenySockets: [], allowBinaries: [] },
};

describe('policyDraftFrom', () => {
  it('switches on exactly the settings keys the seed policy forces', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    // `updates.allowDowngrade` is the one key the POLICY_TEMPLATE omits, so it starts off at its fallback.
    expect(draft.forced['updates.allowDowngrade']).toBe(false);
    expect(draft.values['updates.allowDowngrade']).toBe(false);
    expect(POLICY_SETTINGS.filter((s) => !draft.forced[s.path]).map((s) => s.path)).toEqual(['updates.allowDowngrade']);
    expect(draft.values['web.allowlist']).toEqual(['example.com']);
    expect(draft.values['permissions.functionAllow']).toEqual({ 'web.fetch': true, desktop: false });
  });

  it('leaves every key off for a bare policy but keeps the blocks at their documented defaults', () => {
    const draft = policyDraftFrom({ version: 1 });
    expect(POLICY_SETTINGS.some((s) => draft.forced[s.path])).toBe(false);
    expect(draft.app).toEqual({ allowQuit: true, users: [], restrictions: expect.objectContaining({ allowSandbox: true, requireCharacterSession: false }) });
    expect(draft.guard).toMatchObject({ mode: 'off', protectApp: true, wallpaper: true, compositorIpc: 'shell-only', ipcGuard: 'auto', shell: ['auto'] });
    expect(draft.inputLock).toEqual({ enabled: true, maxDurationMs: 300_000, emergencyKey: 'esc', emergencyHoldMs: 5000 });
  });

  it('reads the app restrictions and a shell list back out of a policy', () => {
    const draft = policyDraftFrom({ version: 1, app: { allowQuit: false, users: ['a'], allowSandbox: false, requireCharacterSession: true }, guard: { mode: 'enforce', shell: ['noctalia', 'awww'] } });
    expect(draft.app.allowQuit).toBe(false);
    expect(draft.app.restrictions.allowSandbox).toBe(false);
    expect(draft.app.restrictions.requireCharacterSession).toBe(true);
    expect(draft.app.restrictions.allowPackEditor).toBe(true);
    expect(draft.guard.shell).toEqual(['noctalia', 'awww']);
  });

  it('reads the dev block back, with devTools following allow when the file leaves it out', () => {
    expect(policyDraftFrom({ version: 1 }).dev).toEqual({ allow: true, devTools: true });
    expect(policyDraftFrom({ version: 1, dev: {} }).dev).toEqual({ allow: true, devTools: true });
    expect(policyDraftFrom({ version: 1, dev: { allow: false } }).dev).toEqual({ allow: false, devTools: false });
    expect(policyDraftFrom({ version: 1, dev: { allow: false, devTools: true } }).dev).toEqual({ allow: false, devTools: true });
    expect(policyDraftFrom({ version: 1, dev: { devTools: false } }).dev).toEqual({ allow: true, devTools: false });
    // Every switch the form shows is one the draft carries.
    for (const { key } of POLICY_DEV) expect(typeof policyDraftFrom({ version: 1 }).dev[key]).toBe('boolean');
  });

  it('does not share lists or maps with the policy it was seeded from', () => {
    const seed = structuredClone(POLICY_TEMPLATE);
    const draft = policyDraftFrom(seed);
    (draft.values['web.allowlist'] as string[]).push('other.example');
    draft.guard.extraDenyPaths.push('/etc/x');
    expect(seed.settings?.web?.allowlist).toEqual(['example.com']);
    expect(seed.guard?.extraDenyPaths).toEqual([]);
  });
});

describe('policyDraftToFile', () => {
  it('round-trips the template through the form without changing it', () => {
    const written = policyDraftToFile(policyDraftFrom(POLICY_TEMPLATE));
    expect(written.settings).toEqual(POLICY_TEMPLATE.settings);
    expect(written.app).toMatchObject({ allowQuit: true, users: ['alice'] });
    expect(written.guard?.shell).toBe('auto');
    // A blank "managed by" is a placeholder, not a value worth writing.
    expect(written.managedBy).toBeUndefined();
  });

  it('omits a settings key that is switched off, and the whole block when none is on', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.forced['autonomy.minDelayMs'] = false;
    draft.forced['web.allowlist'] = false;
    const written = policyDraftToFile(draft);
    expect(written.settings?.autonomy).not.toHaveProperty('minDelayMs');
    expect(written.settings?.autonomy?.maxSelfWakesPerHour).toBe(30);
    expect(written.settings?.web).toBeUndefined();

    for (const spec of POLICY_SETTINGS) draft.forced[spec.path] = false;
    expect(policyDraftToFile(draft).settings).toBeUndefined();
  });

  it('omits the lists parsePolicy refuses when empty', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.app.users = [];
    draft.guard.loginHelpers = [];
    const written = policyDraftToFile(draft);
    expect(written.app).not.toHaveProperty('users');
    expect(written.guard).not.toHaveProperty('loginHelpers');
  });

  it('writes one shell as a name and several as a list', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.guard.shell = ['noctalia'];
    expect(policyDraftToFile(draft).guard?.shell).toBe('noctalia');
    draft.guard.shell = ['noctalia', 'awww'];
    expect(policyDraftToFile(draft).guard?.shell).toEqual(['noctalia', 'awww']);
    draft.guard.shell = [];
    expect(policyDraftToFile(draft).guard).not.toHaveProperty('shell');
  });

  it('writes every app restriction so the file says what it allows outright', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.app.allowQuit = false;
    draft.app.restrictions.allowSandbox = false;
    const written = policyDraftToFile(draft);
    expect(written.app).toMatchObject({ allowQuit: false, allowSandbox: false, allowPackEditor: true, requireCharacterSession: false });
  });

  it('always writes the dev block, so the file says outright what development is allowed', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    expect(policyDraftToFile(draft).dev).toEqual({ allow: true, devTools: true });
    draft.dev = { allow: false, devTools: false };
    expect(policyDraftToFile(draft).dev).toEqual({ allow: false, devTools: false });
    draft.dev = { allow: false, devTools: true };
    expect(policyDraftToFile(draft).dev).toEqual({ allow: false, devTools: true });
  });

  it('keeps guard.ipcGuard through an edit rather than silently turning it off', () => {
    // The form is the only way most people ever touch the policy, so a key it does not carry is
    // a key that disappears the first time someone changes anything else.
    const draft = policyDraftFrom({ ...POLICY_TEMPLATE, guard: { ...POLICY_TEMPLATE.guard, mode: 'audit', ipcGuard: 'off' } });
    expect(draft.guard.ipcGuard).toBe('off');
    expect(policyDraftToFile(draft).guard?.ipcGuard).toBe('off');
    draft.guard.ipcGuard = 'auto';
    expect(policyDraftToFile(draft).guard?.ipcGuard).toBe('auto');
  });

  it('survives a second round trip through its own output', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.managedBy = 'IT';
    draft.guard = { ...draft.guard, mode: 'enforce', ipcGuard: 'off', shell: ['quickshell', 'hyprpaper'], extraDenyPaths: ['~/.config/hypr/*'], loginHelpers: ['/usr/bin/greetd'] };
    const once = policyDraftToFile(draft);
    const twice = policyDraftToFile(policyDraftFrom(once));
    expect(twice).toEqual(once);
  });
});

describe('policyDraftProblems', () => {
  it('passes the POLICY_TEMPLATE through clean', () => {
    expect(policyDraftProblems(policyDraftFrom(POLICY_TEMPLATE))).toEqual([]);
  });

  it('catches the guard needing a user before the file is written', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.guard.mode = 'enforce';
    draft.app.users = [];
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('session guard')]);
  });

  it('catches numbers below the daemon’s floors', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.values['maxInputLockMs'] = 500;
    draft.inputLock.maxDurationMs = 10;
    draft.inputLock.emergencyHoldMs = 100;
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('Longest input lock'), expect.stringContaining('input-lock limit'), expect.stringContaining('emergency-unlock hold')]);
  });

  it('ignores a bad value on a key that is switched off', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.values['autonomy.maxSelfWakesPerHour'] = 'often';
    draft.forced['autonomy.maxSelfWakesPerHour'] = false;
    expect(policyDraftProblems(draft)).toEqual([]);
  });

  it('has no home page to force: only a character sets one (sdk.browser.setHomePage)', () => {
    expect(POLICY_SETTINGS.map((s) => s.path)).not.toContain('browser.homePage');
  });

  it('catches guard paths the daemon would refuse to turn into rules', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.guard.extraDenyPaths = ['~/.config/ok', 'relative/path'];
    draft.guard.loginHelpers = ['~/bin/greetd'];
    expect(policyDraftProblems(draft)).toEqual([expect.stringContaining('Login helpers'), expect.stringContaining('Extra denied paths')]);
  });
});

describe('guardPathProblem', () => {
  it('accepts absolute paths, and home-rooted ones only where they are allowed', () => {
    expect(guardPathProblem('/etc/rpchat', false)).toBeNull();
    expect(guardPathProblem('~/.config/hypr/*', true)).toBeNull();
    expect(guardPathProblem('@{HOME}/.cache/x', true)).toBeNull();
    expect(guardPathProblem('~/.config/hypr', false)).toBe('The path must be absolute.');
  });

  it('rejects what would break the generated AppArmor rule', () => {
    expect(guardPathProblem('/etc/my files', true)).toMatch(/spaces/);
    expect(guardPathProblem('/etc/"x"', true)).toMatch(/spaces/);
    expect(guardPathProblem('', true)).toMatch(/empty/);
    expect(guardPathProblem(`/${'x'.repeat(1024)}`, true)).toMatch(/1024/);
  });
});

describe('userNameProblem', () => {
  it('rejects blank names and names with spaces', () => {
    expect(userNameProblem('alice')).toBeNull();
    expect(userNameProblem('  ')).toMatch(/blank/);
    expect(userNameProblem('two words')).toMatch(/spaces/);
  });
});

describe('policyEffects', () => {
  it('says a permissive policy forces nothing', () => {
    const draft = policyDraftFrom({ version: 1 });
    expect(policyEffects(draft)).toEqual([{ text: 'no settings forced', strict: false }]);
  });

  it('names what a strict policy takes away', () => {
    const draft = policyDraftFrom(POLICY_TEMPLATE);
    draft.app.allowQuit = false;
    draft.app.restrictions.allowSandbox = false;
    draft.app.restrictions.requireCharacterSession = true;
    draft.inputLock.enabled = false;
    draft.guard.mode = 'enforce';
    expect(policyEffects(draft)).toEqual([
      { text: `${POLICY_SETTINGS.length - 1} settings forced`, strict: true },
      { text: 'cannot be quit, relaunched for alice', strict: true },
      { text: '2 app restrictions', strict: true },
      { text: 'input locking refused', strict: true },
      { text: 'session guard: enforce', strict: true },
    ]);
  });

  it('says how far the development lock goes, and mentions DevTools on their own', () => {
    const draft = policyDraftFrom({ version: 1 });
    draft.dev = { allow: false, devTools: false };
    expect(policyEffects(draft)).toContainEqual({ text: 'development switches and DevTools off', strict: true });
    draft.dev = { allow: false, devTools: true };
    expect(policyEffects(draft)).toContainEqual({ text: 'development switches off, DevTools kept', strict: true });
    draft.dev = { allow: true, devTools: false };
    expect(policyEffects(draft)).toContainEqual({ text: 'DevTools off', strict: true });
    draft.dev = { allow: true, devTools: true };
    expect(policyEffects(draft)).toEqual([{ text: 'no settings forced', strict: false }]);
  });
});

describe('toggleShell', () => {
  it('adds and removes named shells, which stack', () => {
    expect(toggleShell([], 'noctalia')).toEqual(['noctalia']);
    expect(toggleShell(['noctalia'], 'awww')).toEqual(['noctalia', 'awww']);
    expect(toggleShell(['noctalia', 'awww'], 'noctalia')).toEqual(['awww']);
  });

  it('keeps auto and none to themselves', () => {
    expect(toggleShell(['noctalia', 'awww'], 'auto')).toEqual(['auto']);
    expect(toggleShell(['auto'], 'noctalia')).toEqual(['noctalia']);
    expect(toggleShell(['none'], 'auto')).toEqual(['auto']);
    // Picking the one already picked clears it, leaving the daemon its own default.
    expect(toggleShell(['auto'], 'auto')).toEqual([]);
  });
});

describe('policyRefusals', () => {
  it('splits the daemon’s list of problems and passes a plain message through', () => {
    expect(policyRefusals('Invalid policy file:\nversion must be 1\napp.users must be a non-empty array of user names')).toEqual([
      'version must be 1',
      'app.users must be a non-empty array of user names',
    ]);
    expect(policyRefusals('the daemon is not connected')).toEqual(['the daemon is not connected']);
    expect(policyRefusals('Invalid policy file:')).toEqual(['Invalid policy file:']);
  });
});
