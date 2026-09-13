/**
 * `sdk.browser`: `open` runs the user's browser command (or the extension when connected); every
 * other method drives tabs through the browser-extension bridge and fails with `CAPABILITY_FAILED`
 * while no extension is connected. URLs opened or navigated to must be http(s) and, when the user
 * set `settings.web.allowlist`, on it.
 */
import { shell } from 'electron';
import type { ActionContext, BrowserBridgeEvent, BrowserTabInfo, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CommandRunner } from './commands-runner.js';
import { commandFailed, isConfigured } from '../commands.js';
import { isAllowlisted } from './allowlist.js';
import { httpUrlArg } from './system.js';

/** The slice of `BrowserBridge` the handler needs (injectable for tests). */
export interface BrowserBridgeLike {
  readonly connected: boolean;
  request(op: string, args?: Record<string, Json>): Promise<Json>;
  status(): Promise<{ connected: boolean; browser?: string }>;
  onEvent?(listener: (event: BrowserBridgeEvent) => void): () => void;
}

export interface BrowserHandlerDeps {
  commands: CommandRunner;
  openExternal?: (url: string) => Promise<void>;
  bridge?: BrowserBridgeLike;
  /** `settings.web.allowlist` (empty = any host). */
  allowlist?: () => Promise<string[]>;
}

export const NOT_CONNECTED_MESSAGE = 'The browser extension is not connected (Settings → Browser: install the extension policy or load it unpacked)';

function record(v: Json | undefined): Record<string, Json> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
}

function tabIdArg(v: Json | undefined, what = 'tabId'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RpError('INVALID_ARGUMENT', `${what} must be a tab id (non-negative integer) from sdk.browser.tabs() or openTab()`);
  return v;
}

function stringArg(v: Json | undefined, what: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new RpError('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  return v;
}

function optionalNumber(v: Json | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export class BrowserHandler implements CapabilityHandler {
  readonly moduleId = 'browser';

  constructor(private readonly deps: BrowserHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'open':
        return this.open(httpUrlArg(args[0]), record(args[1]));
      case 'status': {
        if (!this.deps.bridge) return { connected: false };
        const s = await this.deps.bridge.status();
        return s.browser ? { connected: s.connected, browser: s.browser } : { connected: s.connected };
      }
      case 'tabs':
        return this.bridged('tabs.list');
      case 'openTab': {
        const url = await this.allowed(httpUrlArg(args[0]));
        const o = record(args[1]);
        return this.bridged('tabs.open', { url, active: o['active'] !== false, newWindow: o['newWindow'] === true });
      }
      case 'activate':
        return this.bridged('tabs.activate', { tabId: tabIdArg(args[0]) });
      case 'close':
        await this.bridged('tabs.close', { tabId: tabIdArg(args[0]) });
        return;
      case 'navigate':
        return this.bridged('tabs.navigate', { tabId: tabIdArg(args[0]), url: await this.allowed(httpUrlArg(args[1])) });
      case 'back':
        return this.bridged('tabs.back', { tabId: tabIdArg(args[0]) });
      case 'forward':
        return this.bridged('tabs.forward', { tabId: tabIdArg(args[0]) });
      case 'reload':
        return this.bridged('tabs.reload', { tabId: tabIdArg(args[0]) });
      case 'read': {
        const tabId = args[0] === undefined || args[0] === null ? await this.activeTabId() : tabIdArg(args[0]);
        const o = record(args[1]);
        const maxChars = optionalNumber(o['maxChars']);
        return this.bridged('page.read', { tabId, ...(maxChars !== undefined ? { maxChars } : {}) });
      }
      case 'query': {
        const o = record(args[2]);
        const limit = optionalNumber(o['limit']);
        return this.bridged('page.query', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), ...(limit !== undefined ? { limit } : {}) });
      }
      case 'click': {
        const o = record(args[2]);
        const index = optionalNumber(o['index']);
        return this.bridged('page.click', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), ...(index !== undefined ? { index } : {}) });
      }
      case 'type': {
        if (typeof args[2] !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
        const o = record(args[3]);
        return this.bridged('page.type', { tabId: tabIdArg(args[0]), selector: stringArg(args[1], 'selector'), text: args[2], submit: o['submit'] === true });
      }
      case 'scroll': {
        const o = record(args[1]);
        const y = optionalNumber(o['y']);
        const selector = typeof o['selector'] === 'string' ? o['selector'] : undefined;
        if (y === undefined && !selector) throw new RpError('INVALID_ARGUMENT', 'scroll needs { y } or { selector }');
        return this.bridged('page.scroll', { tabId: tabIdArg(args[0]), ...(y !== undefined ? { y } : {}), ...(selector ? { selector } : {}) });
      }
      case 'screenshot': {
        const tabId = args[0] === undefined || args[0] === null ? await this.activeTabId() : tabIdArg(args[0]);
        return this.bridged('page.screenshot', { tabId, format: 'png' });
      }
      case 'find':
        return this.bridged('page.find', { tabId: tabIdArg(args[0]), text: stringArg(args[1], 'text') });
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.browser.${method}`);
    }
  }

  /** Enforce the user's host allowlist (empty = any http(s) host). */
  private async allowed(url: string): Promise<string> {
    const allowlist = this.deps.allowlist ? await this.deps.allowlist() : [];
    if (allowlist.length > 0 && !isAllowlisted(url, allowlist)) {
      throw new RpError('PERMISSION_DENIED', `The host of ${url} is not on the user's web allowlist; they can add it under Settings → Integrations → Web access`, { url, allowlist });
    }
    return url;
  }

  private bridge(): BrowserBridgeLike {
    const bridge = this.deps.bridge;
    if (!bridge || !bridge.connected) throw new RpError('CAPABILITY_FAILED', NOT_CONNECTED_MESSAGE);
    return bridge;
  }

  private bridged(op: string, args: Record<string, Json> = {}): Promise<Json> {
    return this.bridge().request(op, args);
  }

  private async activeTabId(): Promise<number> {
    const tabs = (await this.bridged('tabs.list')) as unknown as BrowserTabInfo[];
    const active = Array.isArray(tabs) ? tabs.find((t) => t.active && t.url.startsWith('http')) ?? tabs.find((t) => t.active) : undefined;
    if (!active) throw new RpError('NOT_FOUND', 'No active browser tab; pass a tabId from sdk.browser.tabs()');
    return active.id;
  }

  private async open(url: string, options: Record<string, Json>): Promise<Json | void> {
    await this.allowed(url);
    const newWindow = options['newWindow'] === true;
    if (this.deps.bridge?.connected) {
      return this.deps.bridge.request('tabs.open', { url, active: true, newWindow });
    }
    const tpl = await this.deps.commands.resolve('browser');
    if (!isConfigured(tpl)) {
      // Only reachable when the platform has no default (it always has one); still never silent.
      await (this.deps.openExternal ?? ((u: string) => shell.openExternal(u)))(url);
      return null;
    }
    const flag = newWindow && tpl.command.includes('{newWindow}') ? '--new-window' : '';
    const result = await this.deps.commands.runTemplate(tpl, { url, newWindow: flag }, 'browser');
    if (result.code !== 0) throw commandFailed('browser', tpl, result);
    return null;
  }
}
