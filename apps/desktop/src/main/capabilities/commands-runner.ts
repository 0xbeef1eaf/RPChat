/** Shared access to the user's command templates for the wallpaper/browser/screen/voice/desktop handlers and the senses samplers. */
import type { AppSettings, CommandTemplate, CommandTemplates } from '@rp/shared';
import { COMMAND_TEMPLATE_INFO, RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandResult } from '../commands.js';
import { commandFailed, defaultTemplates, effectiveTemplate, isConfigured, notConfigured, runTemplate, templateLocation } from '../commands.js';

export interface CommandRunnerDeps {
  settings(): Promise<AppSettings>;
  logger: Logger;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  run?: (tpl: CommandTemplate, vars: Record<string, string>, opts?: { signal?: AbortSignal }) => Promise<CommandResult>;
}

/**
 * When the executable of a template is missing, say so together with where the template lives.
 * `label` is the template name for template runs; other labels (messaging channels, settings
 * "Test") keep the plain message from `runTemplate`.
 */
export function describeSpawnFailure(err: unknown, label: string): unknown {
  if (!(err instanceof RpError) || err.code !== 'CAPABILITY_FAILED' || !Object.prototype.hasOwnProperty.call(COMMAND_TEMPLATE_INFO, label)) return err;
  const details = err.details as { file?: unknown; code?: unknown } | undefined;
  if (details?.code !== 'ENOENT' || typeof details.file !== 'string') return err;
  return new RpError(
    'CAPABILITY_FAILED',
    `The ${label} command needs "${details.file}", which is not installed or not on PATH; install it or set another command in ${templateLocation(label)}`,
    { ...details, template: label },
    { cause: err },
  );
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

  /**
   * The template the **user** set for `name`, ignoring the platform default. Callers that have a
   * better built-in than the default (the voice handler's neural models, which should outrank
   * espeak-ng but never a command the user typed themselves) use this to tell the two apart.
   */
  async userTemplate(name: keyof CommandTemplates): Promise<CommandTemplate | undefined> {
    const settings = await this.deps.settings();
    return settings.commandTemplates?.[name];
  }

  /** The template that would run for `name` (user's or platform default); may be unconfigured. */
  async resolve(name: keyof CommandTemplates): Promise<CommandTemplate> {
    const settings = await this.deps.settings();
    return effectiveTemplate(name, settings.commandTemplates, this.defaults());
  }

  async isConfigured(name: keyof CommandTemplates): Promise<boolean> {
    return isConfigured(await this.resolve(name));
  }

  /**
   * Run `name` with `vars`. Throws CAPABILITY_FAILED naming the template, the SDK method and the
   * settings location when nothing is configured or the executable is missing.
   */
  async run(name: keyof CommandTemplates, vars: Record<string, string>, label: string = name): Promise<CommandResult> {
    const tpl = await this.resolve(name);
    if (!isConfigured(tpl)) throw notConfigured(name);
    return this.runTemplate(tpl, vars, label === name ? name : `${name} (${label})`);
  }

  /**
   * Like `run` but throws `commandFailed` when the process exits non-zero, so callers that only
   * care about success do not repeat the exit-code check.
   */
  async runChecked(name: keyof CommandTemplates, vars: Record<string, string>): Promise<CommandResult> {
    const tpl = await this.resolve(name);
    if (!isConfigured(tpl)) throw notConfigured(name);
    const result = await this.runTemplate(tpl, vars, name);
    if (result.code !== 0) throw commandFailed(name, tpl, result);
    return result;
  }

  /** Like `run` but without the info log line (for frequent polls such as senses samplers). */
  async runQuiet(name: keyof CommandTemplates, vars: Record<string, string>): Promise<CommandResult> {
    const tpl = await this.resolve(name);
    if (!isConfigured(tpl)) throw notConfigured(name);
    try {
      return await (this.deps.run ?? ((t, v) => runTemplate(t, v, { platform: this.platform, env: this.env })))(tpl, vars);
    } catch (err) {
      throw describeSpawnFailure(err, name);
    }
  }

  async runTemplate(tpl: CommandTemplate, vars: Record<string, string>, label: string, opts: { signal?: AbortSignal } = {}): Promise<CommandResult> {
    const started = Date.now();
    let result: CommandResult;
    try {
      result = await (this.deps.run ?? ((t, v, o) => runTemplate(t, v, { platform: this.platform, env: this.env, ...(o?.signal ? { signal: o.signal } : {}) })))(tpl, vars, opts);
    } catch (err) {
      this.deps.logger.warn(`[commands] ${label}: "${tpl.command}" could not start: ${(err as Error).message}`);
      throw describeSpawnFailure(err, label.split(' ')[0] ?? label);
    }
    this.deps.logger.info(`[commands] ${label}: "${tpl.command}" → exit ${result.code} in ${Date.now() - started} ms${result.stderr ? ` (stderr: ${result.stderr.trim().slice(0, 200)})` : ''}`);
    return result;
  }
}
