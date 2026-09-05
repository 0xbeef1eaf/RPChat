/** Shared access to the user's command templates for the wallpaper/browser/input handlers. */
import type { AppSettings, CommandTemplate, CommandTemplates } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandResult } from '../commands.js';
import { defaultTemplates, effectiveTemplate, isConfigured, notConfigured, runTemplate } from '../commands.js';

export interface CommandRunnerDeps {
  settings(): Promise<AppSettings>;
  logger: Logger;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  run?: (tpl: CommandTemplate, vars: Record<string, string>, opts?: { signal?: AbortSignal }) => Promise<CommandResult>;
}

export class CommandRunner {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: CommandRunnerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
  }

  defaults(): CommandTemplates {
    return defaultTemplates(this.platform, this.env);
  }

  /** The template that would run for `name` (user's or platform default); may be unconfigured. */
  async resolve(name: keyof CommandTemplates): Promise<CommandTemplate> {
    const settings = await this.deps.settings();
    return effectiveTemplate(name, settings.commandTemplates, this.defaults());
  }

  async isConfigured(name: keyof CommandTemplates): Promise<boolean> {
    return isConfigured(await this.resolve(name));
  }

  /** Run `name` with `vars`; throws CAPABILITY_FAILED when nothing is configured. */
  async run(name: keyof CommandTemplates, vars: Record<string, string>, what: string): Promise<CommandResult> {
    const tpl = await this.resolve(name);
    if (!isConfigured(tpl)) throw notConfigured(what);
    return this.runTemplate(tpl, vars, name);
  }

  /** Like `run` but without the info log line (for frequent polls such as senses samplers). */
  async runQuiet(name: keyof CommandTemplates, vars: Record<string, string>): Promise<CommandResult> {
    const tpl = await this.resolve(name);
    if (!isConfigured(tpl)) throw notConfigured(name);
    return (this.deps.run ?? ((t, v) => runTemplate(t, v, { platform: this.platform, env: this.env })))(tpl, vars);
  }

  async runTemplate(tpl: CommandTemplate, vars: Record<string, string>, label: string, opts: { signal?: AbortSignal } = {}): Promise<CommandResult> {
    const started = Date.now();
    const result = await (this.deps.run ?? ((t, v, o) => runTemplate(t, v, { platform: this.platform, env: this.env, ...(o?.signal ? { signal: o.signal } : {}) })))(tpl, vars, opts);
    this.deps.logger.info(`[commands] ${label}: "${tpl.command}" → exit ${result.code} in ${Date.now() - started} ms${result.stderr ? ` (stderr: ${result.stderr.trim().slice(0, 200)})` : ''}`);
    return result;
  }
}
