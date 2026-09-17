import { describe, expect, it } from 'vitest';
import type { PolicyFile } from '@rp/shared';
import { KEEPALIVE_ENV_KEYS } from '@rp/shared';
import { GUARDED_SIGNALS, QuitGuard, keepaliveEnv, launchSpec, quitDecision, trayMenuTemplate } from './quit-guard.js';
import type { GuardedSignal } from './quit-guard.js';

const forbid: PolicyFile = { version: 1, app: { allowQuit: false, users: ['alice'] } };

describe('quit guard (pure)', () => {
  it('quitDecision blocks only an unauthorised quit while the policy forbids quitting', () => {
    expect(quitDecision({ allowQuit: true, authorised: false })).toBe('proceed');
    expect(quitDecision({ allowQuit: true, authorised: true })).toBe('proceed');
    expect(quitDecision({ allowQuit: false, authorised: true })).toBe('proceed');
    expect(quitDecision({ allowQuit: false, authorised: false })).toBe('block');
  });

  it('trayMenuTemplate keeps Show/Hide/Check for updates and drops Quit (and its separator) when disallowed', () => {
    const allowed = trayMenuTemplate(true);
    expect(allowed.map((i) => ('type' in i ? i.type : i.id))).toEqual(['show', 'hide', 'check-updates', 'separator', 'quit']);
    const forbidden = trayMenuTemplate(false);
    expect(forbidden.map((i) => ('type' in i ? i.type : i.id))).toEqual(['show', 'hide', 'check-updates']);
    expect(forbidden.some((i) => 'label' in i && /quit/i.test(i.label))).toBe(false);
    expect(allowed.find((i) => 'id' in i && i.id === 'quit')).toEqual({ id: 'quit', label: 'Quit' });
  });

  it('keepaliveEnv copies only the whitelist and drops empty values', () => {
    const env = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', HOME: '/home/alice', PATH: '/usr/bin', LD_PRELOAD: '/evil.so', RP_MOCK_LLM: '1', LANG: '', XAUTHORITY: undefined, APPIMAGE: '/opt/rp.AppImage' };
    expect(keepaliveEnv(env)).toEqual({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', HOME: '/home/alice', PATH: '/usr/bin', APPIMAGE: '/opt/rp.AppImage' });
    for (const key of Object.keys(keepaliveEnv(env))) expect(KEEPALIVE_ENV_KEYS).toContain(key);
    expect(keepaliveEnv({})).toEqual({});
  });

  it('launchSpec repeats this launch, or the AppImage itself with no arguments', () => {
    const env = { HOME: '/home/alice', NODE_OPTIONS: '--inspect' };
    expect(launchSpec({ execPath: '/opt/rpchat/rpchat', argv: ['/opt/rpchat/rpchat', '--hidden'], cwd: '/home/alice', env })).toEqual({ exec: '/opt/rpchat/rpchat', args: ['--hidden'], cwd: '/home/alice', env: { HOME: '/home/alice' } });
    expect(launchSpec({ execPath: '/x/node_modules/electron/dist/electron', argv: ['electron', 'out/main/index.js', '--no-sandbox'], cwd: '/x', env: {} })).toEqual({ exec: '/x/node_modules/electron/dist/electron', args: ['out/main/index.js', '--no-sandbox'], cwd: '/x', env: {} });
    expect(launchSpec({ execPath: '/tmp/.mount_rpXYZ/rpchat', argv: ['/tmp/.mount_rpXYZ/rpchat', '--hidden'], appImage: '/home/alice/Applications/rpchat.AppImage', cwd: '/home/alice', env: { APPIMAGE: '/home/alice/Applications/rpchat.AppImage' } })).toEqual({
      exec: '/home/alice/Applications/rpchat.AppImage',
      args: [],
      cwd: '/home/alice',
      env: { APPIMAGE: '/home/alice/Applications/rpchat.AppImage' },
    });
  });
});

describe('QuitGuard', () => {
  function harness() {
    const handlers = new Map<GuardedSignal, () => void>();
    const log: string[] = [];
    const allowedSignals: GuardedSignal[] = [];
    const guard = new QuitGuard({
      signals: { on: (sig, h) => void handlers.set(sig, h), off: (sig, h) => void (handlers.get(sig) === h && handlers.delete(sig)) },
      logger: { info: (m: string) => log.push(`info ${m}`), warn: (m: string) => log.push(`warn ${m}`) },
      onAllowedSignal: (sig) => allowedSignals.push(sig),
    });
    return { guard, handlers, log, allowedSignals };
  }

  it('starts permissive, installs signal handlers only while the policy forbids quitting, and removes them again', () => {
    const { guard, handlers, log } = harness();
    expect(guard.allowQuit).toBe(true);
    expect(guard.mayQuit).toBe(true);
    expect(guard.beforeQuit()).toBe('proceed');
    expect(handlers.size).toBe(0);
    expect(guard.apply(null)).toBe(false);
    expect(guard.apply({ version: 1 })).toBe(false);
    expect(guard.apply({ version: 1, app: { allowQuit: true } })).toBe(false);
    expect(handlers.size).toBe(0);

    expect(guard.apply(forbid)).toBe(true);
    expect(guard.current).toEqual({ allowQuit: false, users: ['alice'] });
    expect([...handlers.keys()].sort()).toEqual([...GUARDED_SIGNALS].sort());
    expect(guard.apply(forbid)).toBe(false);
    expect(guard.mayQuit).toBe(false);
    expect(guard.beforeQuit()).toBe('block');
    expect(log.some((l) => /quit blocked/.test(l))).toBe(true);
    // A signal while forbidden is swallowed with a log line.
    handlers.get('SIGTERM')!();
    expect(log.at(-1)).toMatch(/ignoring SIGTERM/);

    // Only the user list changed: still forbidden, handlers untouched but listeners notified.
    const seen: string[][] = [];
    guard.onChange((p) => seen.push(p.users));
    expect(guard.apply({ version: 1, app: { allowQuit: false, users: ['alice', 'bob'] } })).toBe(true);
    expect(seen).toEqual([['alice', 'bob']]);
    expect(handlers.size).toBe(GUARDED_SIGNALS.length);

    // Back to allowed: handlers gone, quits proceed.
    expect(guard.apply({ version: 1 })).toBe(true);
    expect(handlers.size).toBe(0);
    expect(guard.beforeQuit()).toBe('proceed');
  });

  it('allowQuitOnce lets exactly one quit through and a signal in that window quits too', () => {
    const { guard, handlers, allowedSignals } = harness();
    guard.apply(forbid);
    expect(guard.beforeQuit()).toBe('block');
    guard.allowQuitOnce();
    expect(guard.mayQuit).toBe(true);
    handlers.get('SIGINT')!();
    expect(allowedSignals).toEqual(['SIGINT']);
    expect(guard.beforeQuit()).toBe('proceed');
    expect(guard.beforeQuit()).toBe('block');
    guard.dispose();
    expect(handlers.size).toBe(0);
  });
});
