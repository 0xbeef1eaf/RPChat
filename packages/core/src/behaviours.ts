import type { CapabilityRegistry } from '@rp/sdk';
import { describeSurface } from '@rp/sdk';
import type {
  ActionContext,
  ActionTrigger,
  BehaviourHook,
  CapabilityInvoker,
  CodeRunRequest,
  CodeRunResult,
  CodeRunner,
  LoadedPack,
  RunLimits,
  SdkSurface,
  Session,
} from '@rp/shared';
import { RpError, parseCharacterRef } from '@rp/shared';
import type { PackService } from './services/packs.js';
import type { PermissionService } from './services/permissions.js';
import type { SettingsService } from './services/settings.js';
import type { BehaviourHooks, BehaviourInput, Logger } from './types.js';

export interface BehaviourRunnerOptions {
  packs: PackService;
  permissions: PermissionService;
  settings: SettingsService;
  registry: CapabilityRegistry;
  runner: CodeRunner;
  invoker: CapabilityInvoker;
  logger: Logger;
  /**
   * The character's function library prelude (`LibraryService.preludeFor`), prepended to every run
   * when given. `internals: true` is asked for code the pack's author shipped (the behaviour hooks),
   * which may call the library's internal helpers; code the character wrote never sees them.
   */
  prelude?: (packId: string, characterId: string, opts?: { internals?: boolean }) => Promise<string>;
}

export interface BehaviourRunOptions {
  trigger?: ActionTrigger;
  signal?: AbortSignal;
}

/**
 * Turn a hook script into the code the sandbox runs: the hook input is bound
 * to a `const input` on the same line (so line numbers in errors stay right).
 */
export function wrapBehaviourScript(source: string, input: BehaviourInput | undefined): string {
  const bound = JSON.stringify(input === undefined ? null : input);
  return `const input = ${bound}; ${source}`;
}

/** Runs pack behaviour scripts (`onInstall`, `onSessionStart`, `onUserMessage`, `onTimer`, `onSessionEnd`). */
export class BehaviourRunner implements BehaviourHooks {
  constructor(private readonly o: BehaviourRunnerOptions) {}

  has(session: Session, hook: BehaviourHook): boolean {
    const { packId, characterId } = parseCharacterRef(session.characterRef);
    const pack = this.o.packs.tryGetLoaded(packId);
    const character = pack?.characters.find((c) => c.definition.id === characterId);
    return character?.behaviourSources[hook] !== undefined;
  }

  async run(session: Session, hook: BehaviourHook, input?: BehaviourInput, options: BehaviourRunOptions = {}): Promise<CodeRunResult | undefined> {
    const { packId, characterId } = parseCharacterRef(session.characterRef);
    return this.runFor(packId, characterId, session.id, hook, input, options);
  }

  /** Run `onInstall` for every character of a pack that has one (no session; a synthetic session id is used). */
  async runInstallHooks(pack: LoadedPack): Promise<void> {
    for (const character of pack.characters) {
      if (character.behaviourSources.onInstall === undefined) continue;
      const sessionId = `install:${pack.manifest.id}`;
      try {
        const result = await this.runFor(pack.manifest.id, character.definition.id, sessionId, 'onInstall', { packId: pack.manifest.id });
        if (result && !result.ok) {
          this.o.logger.warn(`[behaviours] onInstall of ${pack.manifest.id}/${character.definition.id} failed`, result.error);
        }
      } catch (err) {
        this.o.logger.warn(`[behaviours] onInstall of ${pack.manifest.id}/${character.definition.id} threw`, err);
      }
    }
  }

  /**
   * Run an arbitrary action body (e.g. a `code` timer) with the character's surface and permissions,
   * `input` bound like a behaviour script. Throws `NOT_FOUND` when the pack/character is gone.
   */
  async runScript(
    packId: string,
    characterId: string,
    sessionId: string,
    source: string,
    input: BehaviourInput | undefined,
    trigger: ActionTrigger,
    options: { signal?: AbortSignal } = {},
  ): Promise<CodeRunResult> {
    const pack = this.o.packs.getLoaded(packId);
    if (!pack.characters.some((c) => c.definition.id === characterId)) {
      throw new RpError('NOT_FOUND', `Character "${characterId}" does not exist in pack ${packId}`);
    }
    const context: ActionContext = { packId, characterId, sessionId, packRoot: pack.root, trigger };
    const request: CodeRunRequest = {
      code: wrapBehaviourScript(source, input),
      language: 'ts',
      context,
      surface: await this.surfaceFor(packId),
      invoker: this.o.invoker,
      limits: await this.limits(),
    };
    const prelude = await this.preludeFor(packId, characterId);
    if (prelude !== undefined) request.prelude = prelude;
    if (options.signal) request.signal = options.signal;
    return this.o.runner.run(request);
  }

  /** The SDK surface currently allowed (trusted + every module the app-wide policy allows; the same for every pack). */
  async surfaceFor(packId: string): Promise<SdkSurface> {
    const modules = await this.o.permissions.allowedModules(packId);
    return describeSurface(this.o.registry, { modules });
  }

  async limits(): Promise<RunLimits> {
    return (await this.o.settings.get()).runLimits;
  }

  /**
   * The `const lib = …` prelude for a character, when a library is wired in. With
   * `internals: true` the library's internal helpers are part of `lib` — only for scripts the
   * pack ships, not for code the character wrote (a `code` timer, an action).
   */
  async preludeFor(packId: string, characterId: string, opts: { internals?: boolean } = {}): Promise<string | undefined> {
    return this.o.prelude ? this.o.prelude(packId, characterId, opts) : undefined;
  }

  private async runFor(
    packId: string,
    characterId: string,
    sessionId: string,
    hook: BehaviourHook,
    input: BehaviourInput | undefined,
    options: BehaviourRunOptions = {},
  ): Promise<CodeRunResult | undefined> {
    const pack = this.o.packs.getLoaded(packId);
    const character = pack.characters.find((c) => c.definition.id === characterId);
    if (!character) throw new RpError('NOT_FOUND', `Character "${characterId}" does not exist in pack ${packId}`);
    const source = character.behaviourSources[hook];
    if (source === undefined) return undefined;

    const context: ActionContext = {
      packId,
      characterId,
      sessionId,
      packRoot: pack.root,
      trigger: options.trigger ?? { kind: 'behaviour', hook },
    };
    const request: CodeRunRequest = {
      code: wrapBehaviourScript(source, input),
      language: 'ts',
      context,
      surface: await this.surfaceFor(packId),
      invoker: this.o.invoker,
      limits: await this.limits(),
    };
    // A hook file comes from the pack itself, so it may use the author's internal helpers.
    const prelude = await this.preludeFor(packId, characterId, { internals: true });
    if (prelude !== undefined) request.prelude = prelude;
    if (options.signal) request.signal = options.signal;
    const result = await this.o.runner.run(request);
    if (!result.ok) {
      this.o.logger.warn(`[behaviours] ${hook} of ${packId}/${characterId} failed: ${result.error?.message ?? 'unknown error'}`);
    }
    return result;
  }
}
