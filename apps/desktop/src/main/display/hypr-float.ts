/**
 * Floating app windows under Hyprland (docs/spec/overlay.md §1.2.3).
 *
 * The windows `sdk.ui` opens — `confirm`/`choose`/`ask`, and the permission
 * requests that are asked the same way — are dialogs: small, sized by their
 * question and gone again as soon as it is answered. A tiling compositor would
 * fold each one into the layout instead, resizing everything the user has open
 * around a box that lives for a few seconds. Overlays avoid that with a window
 * rule on their `rp-overlay:` title (see `windowRuleCommands`), but a question
 * wears the character's name in its title bar, so it gets a rule of its own,
 * registered from the title the window is about to open with — the compositor
 * floats it the moment it maps, and it is never tiled, not even for a frame.
 *
 * A rule per title, registered at most once each. `hyprctl reload` drops the
 * dynamic rules, so `configreloaded` clears the cache and the next question
 * registers again; under a Lua config the rule handles are kept in a Lua global
 * and disabled on shutdown, so the app leaves nothing behind.
 */
import type { Logger } from '@rp/core';
import type { HyprTransport, RuleKeyword } from './hyprland.js';
import { isOkResponse, parseHyprVersion, ruleKeyword } from './hyprland.js';
import type { HyprParser } from './hypr-lua.js';
import { escapeLua, evalCommand, isLuaParserResponse } from './hypr-lua.js';

/** Lua global holding the prompt rule handles, so shutdown can disable them. */
export const FLOAT_RULES_GLOBAL = '__rp_float_rules';
export const FLOAT_RULE_NAME = 'rpchat-prompt';

/** How long a caller waits for the compositor before the window is shown regardless. */
export const DEFAULT_RULE_TIMEOUT_MS = 500;

/**
 * A Hyprland title matcher for exactly this window. The title is a regex to
 * Hyprland, so its specials are escaped; a comma cannot be escaped at all (it
 * separates the fields of a rule), so it is matched by the `.` wildcard.
 */
export function titleMatch(title: string): string {
  const escaped = title.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/,/g, '.');
  return `^(${escaped})$`;
}

/** The legacy-parser rule: float the window that opens with this title. */
export function floatRuleCommand(title: string, keyword: RuleKeyword = 'windowrule'): string {
  return `keyword ${keyword} float,title:${titleMatch(title)}`;
}

/** The same rule for a Lua session, appending its handle to `FLOAT_RULES_GLOBAL`. */
export function luaFloatRuleCommand(title: string, name = FLOAT_RULE_NAME): string {
  return evalCommand(`
    _G.${FLOAT_RULES_GLOBAL} = _G.${FLOAT_RULES_GLOBAL} or {}
    table.insert(_G.${FLOAT_RULES_GLOBAL}, hl.window_rule({ name = "${escapeLua(name)}", match = { title = "${escapeLua(titleMatch(title))}" }, float = true }))
  `);
}

/** Drop every rule this run registered (on shutdown, and before a Lua session re-registers). */
export function luaDropFloatRulesCommand(): string {
  return evalCommand(
    `if _G.${FLOAT_RULES_GLOBAL} then for _, r in ipairs(_G.${FLOAT_RULES_GLOBAL}) do pcall(function() r:set_enabled(false) end) end _G.${FLOAT_RULES_GLOBAL} = nil end`,
  );
}

export interface HyprFloaterOptions {
  transport: HyprTransport;
  logger: Logger;
  /** Cap on how long `floatWindow` makes its caller wait (default `DEFAULT_RULE_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * Registers the float rules and remembers which titles already have one. Hyprland
 * never sees a request from here outside a Hyprland session: it is only built when
 * `HYPRLAND_INSTANCE_SIGNATURE` is set.
 */
export class HyprFloater {
  /** title → the registration for it (kept whether it succeeded or not: one attempt per title). */
  private readonly registered = new Map<string, Promise<void>>();
  /** Which config dialect this session speaks; learned from Hyprland's first answer. */
  private parser: HyprParser | undefined;
  private keyword: RuleKeyword | undefined;
  private readonly timeoutMs: number;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly opts: HyprFloaterOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RULE_TIMEOUT_MS;
    this.watchReloads();
  }

  /**
   * Ask Hyprland to float the window that is about to open with `title`. Resolves once the rule
   * is in place — or once the wait is up, because a question the user is waiting on matters more
   * than its placement.
   */
  floatWindow(title: string): Promise<void> {
    if (this.disposed || title.length === 0) return Promise.resolve();
    let pending = this.registered.get(title);
    if (!pending) {
      pending = this.register(title);
      this.registered.set(title, pending);
    }
    return Promise.race([pending, this.after(this.timeoutMs)]);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.registered.clear();
    if (this.parser !== 'lua') return;
    try {
      await this.opts.transport.request(luaDropFloatRulesCommand());
    } catch (err) {
      this.opts.logger.debug('[display:hyprland] dropping the prompt float rules failed', err);
    }
  }

  private async register(title: string): Promise<void> {
    if (this.parser === 'lua') return this.registerLua(title);
    const command = floatRuleCommand(title, await this.ruleKeyword());
    const res = await this.request(command);
    if (res === undefined) return;
    if (isOkResponse(res)) {
      this.parser ??= 'legacy';
      return;
    }
    if (isLuaParserResponse(res)) {
      this.parser = 'lua';
      this.opts.logger.info('[display:hyprland] Hyprland runs a Lua config: registering the prompt float rules through `eval`');
      return this.registerLua(title);
    }
    this.opts.logger.warn(`[display:hyprland] float rule for "${title}" answered: ${res.trim()}`);
  }

  private async registerLua(title: string): Promise<void> {
    const res = await this.request(luaFloatRuleCommand(title, `${FLOAT_RULE_NAME}-${this.registered.size}`));
    if (res !== undefined && !isOkResponse(res)) this.opts.logger.warn(`[display:hyprland] Lua float rule for "${title}" answered: ${res.trim()}`);
  }

  /** A request whose failure is only worth a debug line: without the rule the window merely tiles. */
  private async request(command: string): Promise<string | undefined> {
    try {
      return await this.opts.transport.request(command);
    } catch (err) {
      this.opts.logger.debug(`[display:hyprland] "${command}" failed`, err);
      return undefined;
    }
  }

  /** `windowrule` from Hyprland 0.45 on, `windowrulev2` before it (asked once). */
  private async ruleKeyword(): Promise<RuleKeyword> {
    if (this.keyword) return this.keyword;
    const res = await this.request('j/version');
    this.keyword = ruleKeyword(res === undefined ? undefined : parseHyprVersion(res));
    return this.keyword;
  }

  /** A config reload drops every dynamic rule: forget them so the next question registers again. */
  private watchReloads(): void {
    if (!this.opts.transport.subscribe) return;
    try {
      this.unsubscribe = this.opts.transport.subscribe((event) => {
        if (event === 'configreloaded') this.registered.clear();
      });
    } catch (err) {
      this.opts.logger.debug('[display:hyprland] float rules: event subscription failed', err);
    }
  }

  private after(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
  }
}
