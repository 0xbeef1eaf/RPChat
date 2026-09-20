/**
 * The float rules that keep a question from being tiled into the user's layout. No Hyprland
 * session exists in CI, so the commands are built purely and the transport is a fake that
 * records them and answers like a real (legacy or Lua) session does.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@rp/core';
import type { HyprEventListener, HyprTransport } from './hyprland.js';
import { FLOAT_RULES_GLOBAL, HyprFloater, floatRuleCommand, luaDropFloatRulesCommand, luaFloatRuleCommand, titleMatch } from './hypr-float.js';

/** Verbatim refusal from Hyprland 0.56.2 when the session runs a Lua config. */
const LUA_REFUSAL = "keyword can't work with non-legacy parsers. Use eval.";

const silent: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeTransport implements HyprTransport {
  readonly commands: string[] = [];
  private readonly listeners = new Set<HyprEventListener>();
  /** Answer given to anything but `j/version`; a function may vary it per command. */
  answer: string | ((command: string) => string) = 'ok';

  async request(command: string): Promise<string> {
    this.commands.push(command);
    if (command === 'j/version') return JSON.stringify({ branch: 'main', tag: 'v0.45.0' });
    return typeof this.answer === 'string' ? this.answer : this.answer(command);
  }

  subscribe(listener: HyprEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: string, data = ''): void {
    for (const l of this.listeners) l(event, data);
  }
}

describe('titleMatch', () => {
  it('anchors the exact title and escapes what a regex would read', () => {
    expect(titleMatch('Luna asks')).toBe('^(Luna asks)$');
    expect(titleMatch('Lu(na) [2]. asks')).toBe('^(Lu\\(na\\) \\[2\\]\\. asks)$');
  });

  it('matches a comma with a wildcard: it separates the fields of a rule and cannot be escaped', () => {
    expect(titleMatch('Luna, the fox asks')).toBe('^(Luna. the fox asks)$');
  });
});

describe('floatRuleCommand', () => {
  it('floats the window that opens with the title, under either rule keyword', () => {
    expect(floatRuleCommand('Luna asks')).toBe('keyword windowrule float,title:^(Luna asks)$');
    expect(floatRuleCommand('Luna asks', 'windowrulev2')).toBe('keyword windowrulev2 float,title:^(Luna asks)$');
  });
});

describe('luaFloatRuleCommand', () => {
  it('is one single-line `eval` that keeps the rule handle for shutdown', () => {
    const command = luaFloatRuleCommand('Luna asks', 'rpchat-prompt-0');
    expect(command.startsWith('eval ')).toBe(true);
    expect(command).not.toContain('\n');
    expect(command).toContain(`_G.${FLOAT_RULES_GLOBAL} = _G.${FLOAT_RULES_GLOBAL} or {}`);
    expect(command).toContain('hl.window_rule({ name = "rpchat-prompt-0", match = { title = "^(Luna asks)$" }, float = true })');
    expect(luaDropFloatRulesCommand()).toContain('r:set_enabled(false)');
  });
});

describe('HyprFloater', () => {
  it('registers one rule per title and asks for the rule keyword only once', async () => {
    const t = new FakeTransport();
    const floater = new HyprFloater({ transport: t, logger: silent });
    await floater.floatWindow('Luna asks');
    await floater.floatWindow('Luna asks');
    await floater.floatWindow('Luna needs permission');
    expect(t.commands).toEqual([
      'j/version',
      'keyword windowrule float,title:^(Luna asks)$',
      'keyword windowrule float,title:^(Luna needs permission)$',
    ]);
  });

  it('switches to `eval` when the session runs a Lua config, and drops those rules on dispose', async () => {
    const t = new FakeTransport();
    t.answer = (command) => (command.startsWith('keyword ') ? LUA_REFUSAL : 'ok');
    const floater = new HyprFloater({ transport: t, logger: silent });
    await floater.floatWindow('Luna asks');
    await floater.floatWindow('Luna needs permission');
    expect(t.commands.filter((c) => c.startsWith('keyword '))).toHaveLength(1);
    const evals = t.commands.filter((c) => c.startsWith('eval '));
    expect(evals).toHaveLength(2);
    expect(evals[0]).toContain('title = "^(Luna asks)$"');
    expect(evals[1]).toContain('title = "^(Luna needs permission)$"');
    await floater.dispose();
    expect(t.commands.at(-1)).toBe(luaDropFloatRulesCommand());
  });

  it('registers again after a config reload dropped the dynamic rules', async () => {
    const t = new FakeTransport();
    const floater = new HyprFloater({ transport: t, logger: silent });
    await floater.floatWindow('Luna asks');
    t.emit('configreloaded');
    await floater.floatWindow('Luna asks');
    expect(t.commands.filter((c) => c.startsWith('keyword '))).toEqual([
      'keyword windowrule float,title:^(Luna asks)$',
      'keyword windowrule float,title:^(Luna asks)$',
    ]);
  });

  it('never keeps the question waiting: a failing transport and a silent one both resolve', async () => {
    const failing: HyprTransport = { request: () => Promise.reject(new Error('no socket')) };
    await expect(new HyprFloater({ transport: failing, logger: silent }).floatWindow('Luna asks')).resolves.toBeUndefined();

    vi.useFakeTimers();
    try {
      const mute: HyprTransport = { request: () => new Promise<string>(() => undefined) };
      const waited = new HyprFloater({ transport: mute, logger: silent, timeoutMs: 500 }).floatWindow('Luna asks');
      vi.advanceTimersByTime(500);
      await expect(waited).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing once disposed', async () => {
    const t = new FakeTransport();
    const floater = new HyprFloater({ transport: t, logger: silent });
    await floater.dispose();
    await floater.floatWindow('Luna asks');
    expect(t.commands).toEqual([]);
  });
});
