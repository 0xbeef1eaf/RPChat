import { describe, expect, it } from 'vitest';
import {
  LAYER_RULE_NAME,
  RULES_GLOBAL,
  WINDOW_RULE_NAME,
  escapeLua,
  evalCommand,
  isLuaParserResponse,
  luaCloseWindowCommand,
  luaDisableRulesCommand,
  luaFocusWindowCommand,
  luaMoveWindowCommand,
  luaPlacementCommand,
  luaRulesCommand,
  luaWantsPin,
  luaWorkspaceCommand,
} from './hypr-lua.js';

/** Verbatim answers from Hyprland 0.56.2 running a Lua config. */
const KEYWORD_REFUSAL = "keyword can't work with non-legacy parsers. Use eval.";
const DISPATCH_ERROR = `error: [string "return hl.dispatch(setfloating address:0x5654..."]:1: ')' expected near 'address'`;

describe('isLuaParserResponse', () => {
  it('recognises both ways a Lua session rejects the legacy syntax', () => {
    expect(isLuaParserResponse(KEYWORD_REFUSAL)).toBe(true);
    expect(isLuaParserResponse(DISPATCH_ERROR)).toBe(true);
    expect(isLuaParserResponse('ok')).toBe(false);
    expect(isLuaParserResponse('Invalid dispatcher')).toBe(false);
  });
});

describe('luaRulesCommand', () => {
  const command = luaRulesCommand();

  it('sends one single-line `eval` that replaces the rules from an earlier run', () => {
    expect(command.startsWith('eval ')).toBe(true);
    expect(command).not.toContain('\n');
    expect(command).toContain(`if _G.${RULES_GLOBAL} then`);
    expect(command).toContain('r:set_enabled(false)');
    expect(command.indexOf('set_enabled(false)')).toBeLessThan(command.indexOf('hl.window_rule'));
  });

  it('matches overlay titles and the helper namespace with Lua field names', () => {
    expect(command).toContain(`hl.window_rule({ name = "${WINDOW_RULE_NAME}", match = { title = "^(rp-overlay:.*)$" }`);
    // Lua props are not the legacy `noborder`/`norounding` spellings.
    expect(command).toContain('float = true');
    expect(command).toContain('pin = true');
    expect(command).toContain('no_initial_focus = true');
    expect(command).toContain('rounding = 0');
    expect(command).toContain('border_size = 0');
    expect(command).toContain('decorate = false');
    expect(command).toContain('suppress_event = "maximize"');
    expect(command).not.toMatch(/noborder|norounding|nodim\b/);
    expect(command).toContain(`hl.layer_rule({ name = "${LAYER_RULE_NAME}", match = { namespace = "^(rp-overlay.*)$" }, no_anim = true })`);
  });

  it('drops the rules again on shutdown', () => {
    expect(luaDisableRulesCommand()).toContain(`_G.${RULES_GLOBAL} = nil`);
  });
});

describe('luaPlacementCommand', () => {
  const base = { bounds: { x: 3940, y: 134, width: 700, height: 500 }, layer: 'overlay' as const, opacity: 0.6, clickThrough: true };

  it('guards the toggles, sizes before moving, and sets props with numeric values', () => {
    const cmd = luaPlacementCommand({ ...base, monitorName: 'DP-2' }, '0x55d2a1ff0000');
    expect(cmd).toContain('if x.address == "0x55d2a1ff0000" then w = x end');
    // `float` and `pin` are toggles in Lua: sending them blind would tile or unpin the overlay.
    expect(cmd).toContain('if not w.floating then hl.dispatch(hl.dsp.window.float({ window = w })) end');
    expect(cmd).toContain('if w.pinned ~= true then hl.dispatch(hl.dsp.window.pin({ window = w })) end');
    expect(cmd.indexOf('resize({ x = 700, y = 500')).toBeLessThan(cmd.indexOf('move({ x = 3940'));
    expect(cmd).toContain('move({ x = 3940, y = 134, monitor = "DP-2", window = w })');
    expect(cmd).toContain('set_prop({ window = w, prop = "opacity", value = 0.6 })');
    expect(cmd).toContain('set_prop({ window = w, prop = "opacity_override", value = 1 })');
    expect(cmd).toContain('set_prop({ window = w, prop = "opacity_inactive", value = 0.6 })');
    expect(cmd).toContain('set_prop({ window = w, prop = "opacity_inactive_override", value = 1 })');
    // Lua rejects booleans for `value`; click-through is 1/0.
    expect(cmd).toContain('set_prop({ window = w, prop = "no_focus", value = 1 })');
    expect(cmd).toContain('bring_to_top({ window = w })');
    expect(cmd).not.toContain('\n');
  });

  it('omits the monitor when the window already sits there, unpins below-layers and clears no_focus', () => {
    const cmd = luaPlacementCommand({ ...base, layer: 'bottom', clickThrough: false, opacity: 1 }, '0xabc');
    expect(cmd).toContain('move({ x = 3940, y = 134, window = w })');
    expect(cmd).toContain('if w.pinned ~= false then');
    expect(cmd).toContain('prop = "no_focus", value = 0');
    // Nothing raises a bottom-layer overlay.
    expect(cmd).not.toContain('bring_to_top');
  });

  it('mirrors the legacy pin policy and escapes what it interpolates', () => {
    expect([luaWantsPin('overlay'), luaWantsPin('top'), luaWantsPin('background'), luaWantsPin('bottom')]).toEqual([true, true, true, false]);
    expect(escapeLua('DP-"1"\\x')).toBe('DP-\\"1\\"\\\\x');
    expect(evalCommand('a\n  b')).toBe('eval a b');
  });
});

describe('sdk.desktop window commands in Lua', () => {
  it('looks the window up before focusing or closing it', () => {
    // A dispatcher whose `window` does not resolve acts on the *active* window, so
    // both snippets have to bail out when the address is gone.
    for (const cmd of [luaFocusWindowCommand('0xabc'), luaCloseWindowCommand('0xabc')]) {
      expect(cmd.startsWith('eval local w for _, x in ipairs(hl.get_windows())')).toBe(true);
      expect(cmd).toContain('if x.address == "0xabc" then w = x end');
      expect(cmd.indexOf('if not w then return end')).toBeLessThan(cmd.indexOf('hl.dispatch'));
    }
    expect(luaFocusWindowCommand('0xabc')).toContain('hl.dispatch(hl.dsp.focus({ window = w }))');
    expect(luaCloseWindowCommand('0xabc')).toContain('hl.dispatch(hl.dsp.window.close({ window = w }))');
  });

  it('carries a whole move in one eval, in the order the legacy commands go out', () => {
    const cmd = luaMoveWindowCommand('0x2', { x: 10, y: 20, width: 800, height: 600, workspace: 3 }, 'DP-1');
    expect(cmd).toBe(
      'eval local w for _, x in ipairs(hl.get_windows()) do if x.address == "0x2" then w = x end end if not w then return end ' +
        'hl.dispatch(hl.dsp.window.move({ workspace = "3", follow = false, window = w })) ' +
        'hl.dispatch(hl.dsp.window.move({ monitor = "DP-1", window = w })) ' +
        'hl.dispatch(hl.dsp.window.resize({ x = 800, y = 600, window = w })) ' +
        'hl.dispatch(hl.dsp.window.move({ x = 10, y = 20, window = w }))',
    );
    // `follow = false` is what keeps `movetoworkspacesilent`'s promise: the user stays put.
    expect(luaMoveWindowCommand('0x2', { workspace: 'mail' })).toContain('move({ workspace = "mail", follow = false, window = w })');
    expect(luaMoveWindowCommand('0x2', { x: 40 })).toContain('move({ x = 40, y = 0, window = w })');
    expect(luaMoveWindowCommand('0x2', {})).toBeUndefined();
  });

  it('switches the view with focus, not the workspace namespace', () => {
    expect(luaWorkspaceCommand(2)).toBe('eval hl.dispatch(hl.dsp.focus({ workspace = "2" }))');
    expect(luaWorkspaceCommand('name:mail')).toBe('eval hl.dispatch(hl.dsp.focus({ workspace = "name:mail" }))');
  });
});
