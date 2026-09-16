import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PolicyFile } from '@rp/shared';
import { DEFAULT_DEV_RULES, DEV_ARGV_FLAGS, POLICY_FILE_PATH } from '@rp/shared';
import { applyDevGuard, devEnvKeys, devRules, readDevRules, refusalMessage, refusedDevFlags, scrubDevEnv } from './dev-guard.js';

/** A reader that answers for one path and raises ENOENT for anything else, like `fs.readFileSync`. */
function fileAt(path: string, text: string): (p: string) => string {
  return (p: string): string => {
    if (p !== path) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return text;
  };
}

function missing(): (p: string) => string {
  return fileAt('/nowhere', '');
}

const devEnv = (): NodeJS.ProcessEnv => ({
  HOME: '/home/alice',
  DISPLAY: ':0',
  RP_MOCK_LLM: '1',
  RP_SMOKE: '1',
  RP_POLICY_FILE: '/tmp/mine.json',
  RP_OVERLAY_HELPER: '/tmp/helper',
  ELECTRON_RENDERER_URL: 'http://localhost:5173',
  NODE_OPTIONS: '--require /tmp/x.js',
});

describe('dev rules (pure)', () => {
  it('leaves every switch on without a policy and until one says otherwise', () => {
    expect(devRules(null)).toEqual(DEFAULT_DEV_RULES);
    expect(devRules({})).toEqual({ allow: true, devTools: true });
    expect(devRules({ dev: {} })).toEqual({ allow: true, devTools: true });
    expect(devRules({ dev: { allow: true } })).toEqual({ allow: true, devTools: true });
  });

  it('devTools follows allow unless the policy names it', () => {
    expect(devRules({ dev: { allow: false } })).toEqual({ allow: false, devTools: false });
    expect(devRules({ dev: { allow: false, devTools: true } })).toEqual({ allow: false, devTools: true });
    expect(devRules({ dev: { allow: true, devTools: false } })).toEqual({ allow: true, devTools: false });
  });
});

describe('reading the dev block', () => {
  it('allows everything when there is no policy file', () => {
    const read = readDevRules({ path: POLICY_FILE_PATH, readFile: missing() });
    expect(read).toEqual({ rules: DEFAULT_DEV_RULES, source: 'no-policy' });
  });

  it('reads only the dev block, ignoring problems elsewhere in the file', () => {
    const text = JSON.stringify({ version: 7, settings: { nonsense: 1 }, app: { allowQuit: 'yes' }, dev: { allow: false } });
    const read = readDevRules({ path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
    expect(read).toEqual({ rules: { allow: false, devTools: false }, source: 'policy' });
  });

  it('leaves dev mode alone for a policy that says nothing about it', () => {
    const policy: PolicyFile = { version: 1, app: { allowQuit: false, users: ['alice'] } };
    const read = readDevRules({ path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, JSON.stringify(policy)) });
    expect(read).toEqual({ rules: { allow: true, devTools: true }, source: 'policy' });
  });

  it('fails closed on a policy file that exists but cannot be read or parsed', () => {
    const denied = (): string => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const unreadable = readDevRules({ path: POLICY_FILE_PATH, readFile: denied });
    expect(unreadable.rules).toEqual({ allow: false, devTools: false });
    expect(unreadable.source).toBe('unreadable');
    expect(unreadable.problem).toContain('permission denied');

    for (const text of ['{ "version": 1,', 'null', '[]', '"a string"']) {
      const read = readDevRules({ path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
      expect(read.rules).toEqual({ allow: false, devTools: false });
      expect(read.source).toBe('unreadable');
    }
  });

  it('ignores a dev key that is not an object', () => {
    for (const dev of ['off', 42, null, ['allow']]) {
      const text = JSON.stringify({ version: 1, dev });
      expect(readDevRules({ path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) }).rules).toEqual({ allow: true, devTools: true });
    }
  });
});

describe('the switches themselves', () => {
  it('finds every RP_ variable plus the named ones, and nothing else', () => {
    expect(devEnvKeys(devEnv())).toEqual(['ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'RP_MOCK_LLM', 'RP_OVERLAY_HELPER', 'RP_POLICY_FILE', 'RP_SMOKE']);
    // A switch added later is covered by the prefix without touching the list.
    expect(devEnvKeys({ RP_SOMETHING_NEW: '1' })).toEqual(['RP_SOMETHING_NEW']);
    expect(devEnvKeys({ HOME: '/home/alice', PATH: '/usr/bin', ELECTRON_OZONE_PLATFORM_HINT: 'auto' })).toEqual([]);
  });

  it('scrubDevEnv deletes them in place and leaves the rest of the environment alone', () => {
    const env = devEnv();
    expect(scrubDevEnv(env)).toEqual(['ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'RP_MOCK_LLM', 'RP_OVERLAY_HELPER', 'RP_POLICY_FILE', 'RP_SMOKE']);
    expect(env).toEqual({ HOME: '/home/alice', DISPLAY: ':0' });
    expect(scrubDevEnv(env)).toEqual([]);
  });

  it('refusedDevFlags catches the debugging flags with and without a value, and lets a real launch through', () => {
    expect(refusedDevFlags(['/opt/rp-code/rp-code', '--hidden', '--no-sandbox', '--ozone-platform=wayland'])).toEqual([]);
    expect(refusedDevFlags(['rp-code', '--inspect'])).toEqual(['--inspect']);
    expect(refusedDevFlags(['rp-code', '--remote-debugging-port=9222', '--js-flags=--expose-gc'])).toEqual(['--remote-debugging-port=9222', '--js-flags=--expose-gc']);
    // Not a flag, just a file that happens to be named like one.
    expect(refusedDevFlags(['rp-code', 'inspect', '/tmp/--inspect'])).toEqual([]);
    for (const flag of DEV_ARGV_FLAGS) expect(refusedDevFlags(['rp-code', flag])).toEqual([flag]);
  });
});

describe('applyDevGuard', () => {
  it('changes nothing while dev mode is allowed', () => {
    const env = devEnv();
    const decision = applyDevGuard({ env, argv: ['rp-code', '--inspect'], path: POLICY_FILE_PATH, readFile: missing() });
    expect(decision).toEqual({ rules: DEFAULT_DEV_RULES, source: 'no-policy', refuse: false, refusedFlags: [], removedEnv: [] });
    expect(env).toEqual(devEnv());
  });

  it('strips the switches out of the environment when the policy locks dev mode', () => {
    const env = devEnv();
    const text = JSON.stringify({ version: 1, dev: { allow: false } });
    const decision = applyDevGuard({ env, argv: ['rp-code', '--hidden'], path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
    expect(decision.rules).toEqual({ allow: false, devTools: false });
    expect(decision.refuse).toBe(false);
    expect(decision.removedEnv).toContain('RP_MOCK_LLM');
    expect(env.RP_MOCK_LLM).toBeUndefined();
    expect(env.ELECTRON_RENDERER_URL).toBeUndefined();
    expect(env.HOME).toBe('/home/alice');
  });

  it('cannot be unlocked through RP_POLICY_FILE: the override is read from nowhere and dropped', () => {
    const env = { ...devEnv(), RP_POLICY_FILE: '/tmp/free.json' };
    const locked = JSON.stringify({ version: 1, dev: { allow: false } });
    // The reader answers for the canonical path only; the file the launch pointed at is never opened.
    const decision = applyDevGuard({ env, argv: ['rp-code'], path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, locked) });
    expect(decision.rules.allow).toBe(false);
    expect(decision.removedEnv).toContain('RP_POLICY_FILE');
    expect(env.RP_POLICY_FILE).toBeUndefined();
  });

  it('refuses a locked launch that asks for a debugging channel, and names the flags', () => {
    const text = JSON.stringify({ version: 1, dev: { allow: false } });
    const decision = applyDevGuard({ env: devEnv(), argv: ['rp-code', '--remote-debugging-port=9222'], path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
    expect(decision.refuse).toBe(true);
    expect(decision.refusedFlags).toEqual(['--remote-debugging-port=9222']);
    expect(refusalMessage(decision.refusedFlags)).toContain('--remote-debugging-port=9222');
  });

  it('keeps DevTools when the policy asks for them on a locked machine', () => {
    const text = JSON.stringify({ version: 1, dev: { allow: false, devTools: true } });
    const decision = applyDevGuard({ env: devEnv(), argv: ['rp-code'], path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
    expect(decision.rules).toEqual({ allow: false, devTools: true });
    expect(decision.removedEnv.length).toBeGreaterThan(0);
  });

  it('closes DevTools without touching the environment when only they are forbidden', () => {
    const env = devEnv();
    const text = JSON.stringify({ version: 1, dev: { devTools: false } });
    const decision = applyDevGuard({ env, argv: ['rp-code', '--inspect'], path: POLICY_FILE_PATH, readFile: fileAt(POLICY_FILE_PATH, text) });
    expect(decision.rules).toEqual({ allow: true, devTools: false });
    expect(decision.refuse).toBe(false);
    expect(env.RP_MOCK_LLM).toBe('1');
  });
});

describe('reading a real policy file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-dev-guard-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the file off disk with the default reader, and treats a missing one as no policy', () => {
    const file = path.join(dir, 'policy.json');
    expect(readDevRules({ path: file })).toEqual({ rules: DEFAULT_DEV_RULES, source: 'no-policy' });

    fs.writeFileSync(file, `${JSON.stringify({ version: 1, managedBy: 'IT', dev: { allow: false } }, null, 2)}\n`);
    expect(readDevRules({ path: file })).toEqual({ rules: { allow: false, devTools: false }, source: 'policy' });

    const env = { RP_MOCK_LLM: '1', HOME: '/home/alice' };
    expect(applyDevGuard({ env, argv: ['rp-code'], path: file }).removedEnv).toEqual(['RP_MOCK_LLM']);
    expect(env).toEqual({ HOME: '/home/alice' });

    fs.writeFileSync(file, 'not json at all');
    expect(readDevRules({ path: file }).rules).toEqual({ allow: false, devTools: false });
  });
});
