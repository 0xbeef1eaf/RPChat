/** `sdk.browser`: opens http(s) URLs through the user's browser command template. */
import { shell } from 'electron';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CommandRunner } from './commands-runner.js';
import { commandFailed, isConfigured } from '../commands.js';
import { httpUrlArg } from './system.js';

export interface BrowserHandlerDeps {
  commands: CommandRunner;
  openExternal?: (url: string) => Promise<void>;
}

export class BrowserHandler implements CapabilityHandler {
  readonly moduleId = 'browser';

  constructor(private readonly deps: BrowserHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    if (method !== 'open') throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.browser.${method}`);
    const url = httpUrlArg(args[0]);
    const options = args[1] && typeof args[1] === 'object' ? (args[1] as { newWindow?: unknown }) : {};
    const tpl = await this.deps.commands.resolve('browser');
    if (!isConfigured(tpl)) {
      // Only reachable when the platform has no default (it always has one); still never silent.
      await (this.deps.openExternal ?? ((u: string) => shell.openExternal(u)))(url);
      return;
    }
    const newWindow = options.newWindow === true && tpl.command.includes('{newWindow}') ? '--new-window' : '';
    const result = await this.deps.commands.runTemplate(tpl, { url, newWindow }, 'browser');
    if (result.code !== 0) throw commandFailed('browser', tpl, result);
  }
}
