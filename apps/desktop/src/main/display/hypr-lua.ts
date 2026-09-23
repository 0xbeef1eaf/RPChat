/**
 * Hyprland's Lua configuration dialect (docs/spec/overlay.md §1.2.2).
 *
 * From 0.5x a Hyprland session whose config is Lua (`hyprland.lua`) answers
 * every `keyword …` and legacy `dispatch …` request with
 * "keyword can't work with non-legacy parsers. Use eval." — the whole
 * `hyprland-ipc` command set has to go through `eval <lua>` instead, where
 * dispatchers take one named-argument table (`hl.dsp.window.move{ x, y, window }`)
 * and window properties use their Lua names (`opacity`, not `alpha`).
 *
 * This module builds those snippets, for the overlays and for the window
 * commands of `sdk.desktop`. Everything here is pure: the caller sends the
 * strings and decides, from Hyprland's answer, which dialect the running
 * session speaks.
 */
import type { OverlayLayer } from '@rp/shared';
import { OVERLAY_TITLE_PREFIX, clampOpacity } from './layers.js';

/** Which config parser the running Hyprland uses; decided from its answers, never guessed. */
export type HyprParser = 'legacy' | 'lua';

/** Layer-shell namespace of the `rp-overlay-wlr` helper (`DEFAULT_NAMESPACE`). */
export const OVERLAY_NAMESPACE = 'rp-overlay';
export const OVERLAY_TITLE_MATCH = `^(${OVERLAY_TITLE_PREFIX}.*)$`;
export const OVERLAY_NAMESPACE_MATCH = `^(${OVERLAY_NAMESPACE}.*)$`;

/** Lua global holding our rule handles, so re-registering can disable the previous ones. */
export const RULES_GLOBAL = '__rp_overlay_rules';
export const WINDOW_RULE_NAME = 'rpchat-overlays';
export const LAYER_RULE_NAME = 'rpchat-overlay-layers';

/**
 * True when Hyprland rejected a request because the session runs a Lua config.
 * Both the `keyword` refusal and the Lua syntax error from a legacy `dispatch`
 * mean the same thing: talk Lua from here on.
 */
export function isLuaParserResponse(text: string): boolean {
  return /non-legacy parser|hl\.dispatch\(/i.test(text);
}

/** `"` and `\` are the only characters that can appear in an address or monitor name and hurt. */
export function escapeLua(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function luaBool(v: boolean): string {
  return v ? 'true' : 'false';
}

/** Lua has no boolean window props: `set_prop` wants a number or string. */
function propValue(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(Number.isInteger(value) ? value : Number(value.toFixed(3)));
}

/** One `eval` request, whitespace collapsed (Hyprland reads the command as a single line). */
export function evalCommand(lua: string): string {
  return `eval ${lua.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * Window rules matching every overlay title, so the compositor honours the
 * placement the SDK asks for from the moment the window maps. Field names are
 * the Lua ones (`border_size = 0`, not `noborder`).
 */
export const LUA_WINDOW_RULE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['float', 'true'], // never tiled: the SDK owns position and size
  ['pin', 'true'], // visible on every workspace
  ['no_initial_focus', 'true'], // showing media must not steal focus
  ['no_anim', 'true'], // animations would drag the window off the placement
  ['no_blur', 'true'],
  ['no_dim', 'true'],
  ['no_shadow', 'true'],
  ['no_max_size', 'true'], // the SDK may ask for more than the layout allows
  ['rounding', '0'],
  ['border_size', '0'],
  ['decorate', 'false'],
  ['suppress_event', '"maximize"'], // a maximise request would drop the placement
];

/** `hl.window_rule` + `hl.layer_rule` for our overlays, replacing any rules from an earlier run. */
export function luaRulesCommand(): string {
  const fields = LUA_WINDOW_RULE_FIELDS.map(([key, value]) => `${key} = ${value}`).join(', ');
  return evalCommand(`
    ${disableRulesLua()}
    _G.${RULES_GLOBAL} = {
      hl.window_rule({ name = "${WINDOW_RULE_NAME}", match = { title = "${escapeLua(OVERLAY_TITLE_MATCH)}" }, ${fields} }),
      hl.layer_rule({ name = "${LAYER_RULE_NAME}", match = { namespace = "${escapeLua(OVERLAY_NAMESPACE_MATCH)}" }, no_anim = true }),
    }
  `);
}

function disableRulesLua(): string {
  return `if _G.${RULES_GLOBAL} then for _, r in ipairs(_G.${RULES_GLOBAL}) do pcall(function() r:set_enabled(false) end) end _G.${RULES_GLOBAL} = nil end`;
}

/** Drop our rules again (on shutdown): an IPC-only session leaves nothing behind. */
export function luaDisableRulesCommand(): string {
  return evalCommand(disableRulesLua());
}

/** Resolves the window into `w`; every snippet below is a no-op when it is gone. */
function lookupLua(address: string): string {
  return `local w for _, x in ipairs(hl.get_windows()) do if x.address == "${escapeLua(address)}" then w = x end end if not w then return end`;
}

function dispatchDsp(call: string): string {
  return `hl.dispatch(hl.dsp.${call})`;
}

function dispatch(call: string): string {
  return dispatchDsp(`window.${call}`);
}

export interface LuaPlacement {
  /** Absolute logical px. */
  bounds: { x: number; y: number; width: number; height: number };
  layer: OverlayLayer;
  opacity: number;
  clickThrough: boolean;
  /** Name of the monitor the overlay belongs on (`move` reassigns the workspace). */
  monitorName?: string;
}

/** Whether a layer wants the window pinned (mirrors `wantsPin` for the legacy tier). */
export function luaWantsPin(layer: OverlayLayer): boolean {
  return layer === 'overlay' || layer === 'top' || layer === 'background';
}

/**
 * Place and style one overlay. `float` and `pin` are toggles in Lua, so both
 * are guarded by the window's current state — sending them blindly would
 * tile or unpin the overlay on every update.
 */
export function luaPlacementCommand(placement: LuaPlacement, address: string): string {
  const { bounds, layer, opacity, clickThrough, monitorName } = placement;
  const monitor = monitorName ? `, monitor = "${escapeLua(monitorName)}"` : '';
  const lines = [
    lookupLua(address),
    `if not w.floating then ${dispatch('float({ window = w })')} end`,
    dispatch(`resize({ x = ${Math.round(bounds.width)}, y = ${Math.round(bounds.height)}, window = w })`),
    dispatch(`move({ x = ${Math.round(bounds.x)}, y = ${Math.round(bounds.y)}${monitor}, window = w })`),
    `if w.pinned ~= ${luaBool(luaWantsPin(layer))} then ${dispatch('pin({ window = w })')} end`,
    ...(layer === 'top' || layer === 'overlay' ? [dispatch('bring_to_top({ window = w })')] : []),
    ...propLines(opacity, clickThrough),
  ];
  return evalCommand(lines.join(' '));
}

function propLines(opacity?: number, clickThrough?: boolean): string[] {
  const out: string[] = [];
  if (opacity !== undefined) {
    // `opacity_inactive` as well: an overlay is never focused, so without it the compositor's
    // inactive opacity dims a window the pack asked to be fully opaque (see `opacityCommands`).
    const value = propValue(clampOpacity(opacity));
    out.push(dispatch(`set_prop({ window = w, prop = "opacity", value = ${value} })`));
    out.push(dispatch('set_prop({ window = w, prop = "opacity_override", value = 1 })'));
    out.push(dispatch(`set_prop({ window = w, prop = "opacity_inactive", value = ${value} })`));
    out.push(dispatch('set_prop({ window = w, prop = "opacity_inactive_override", value = 1 })'));
  }
  if (clickThrough !== undefined) out.push(dispatch(`set_prop({ window = w, prop = "no_focus", value = ${propValue(clickThrough)} })`));
  return out;
}

// ---- `sdk.desktop` window control (capabilities/desktop.ts) --------------------
//
// Addresses are the normalised `0x…` form `listWindows()` hands out, as in `luaPlacementCommand`.

/** Where `sdk.desktop.moveWindow` wants a window; `monitor` is already resolved to a name. */
export interface LuaWindowMove {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  workspace?: string | number;
}

/** `focusWindow`: focus is a top-level dispatcher, and takes the window like every other one. */
export function luaFocusWindowCommand(address: string): string {
  return evalCommand(`${lookupLua(address)} ${dispatchDsp('focus({ window = w })')}`);
}

/**
 * `closeWindow`. The lookup has to stay in front of it: a dispatcher whose `window`
 * does not resolve falls back to the *active* window, and closing whatever the user
 * happens to be looking at is the one thing this must never do.
 */
export function luaCloseWindowCommand(address: string): string {
  return evalCommand(`${lookupLua(address)} ${dispatch('close({ window = w })')}`);
}

/** `moveWindow` as a single `eval` — the legacy commands in the same order, one window lookup. */
export function luaMoveWindowCommand(address: string, to: LuaWindowMove, monitorName?: string): string | undefined {
  const lines: string[] = [];
  // `follow = false` is `movetoworkspacesilent`: the window moves, the user stays where they are.
  if (to.workspace !== undefined) lines.push(dispatch(`move({ workspace = "${escapeLua(String(to.workspace))}", follow = false, window = w })`));
  if (monitorName !== undefined) lines.push(dispatch(`move({ monitor = "${escapeLua(monitorName)}", window = w })`));
  if (to.width !== undefined || to.height !== undefined) lines.push(dispatch(`resize({ x = ${Math.round(to.width ?? 0)}, y = ${Math.round(to.height ?? 0)}, window = w })`));
  if (to.x !== undefined || to.y !== undefined) lines.push(dispatch(`move({ x = ${Math.round(to.x ?? 0)}, y = ${Math.round(to.y ?? 0)}, window = w })`));
  if (lines.length === 0) return undefined;
  return evalCommand([lookupLua(address), ...lines].join(' '));
}

/** `workspace(target)`: switching the view is `focus`, not the `workspace` namespace (which moves and renames them). */
export function luaWorkspaceCommand(target: string | number): string {
  return evalCommand(dispatchDsp(`focus({ workspace = "${escapeLua(String(target))}" })`));
}
