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

  /** The SDK surface currently allowed for a pack (trusted + granted modules). */
  async surfaceFor(packId: string): Promise<SdkSurface> {
    const modules = await this.o.permissions.allowedModules(packId);
    return describeSurface(this.o.registry, { modules });
  }

  async limits(): Promise<RunLimits> {
    return (await this.o.settings.get()).runLimits;
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
    if (options.signal) request.signal = options.signal;
    const result = await this.o.runner.run(request);
    if (!result.ok) {
      this.o.logger.warn(`[behaviours] ${hook} of ${packId}/${characterId} failed: ${result.error?.message ?? 'unknown error'}`);
    }
    return result;
  }
}
