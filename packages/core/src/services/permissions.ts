import { randomUUID } from 'node:crypto';
import type { CapabilityRegistry } from '@rp/sdk';
import type { ActionContext, AppSettings, PermissionDecision, PermissionLevel, PermissionRequest } from '@rp/shared';
import { functionAllowed, functionKey, isAlwaysAvailableModule, selectionCovers } from '@rp/shared';
import type { EngineEmitter, Logger } from '../types.js';

export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionDecision>;

export type PermissionVerdict = 'allow' | 'deny' | 'prompt';

/** Why a function is unavailable: only ever the app-wide policy. */
export type DenialReason = 'policy';

export const DENIAL_TEXT: Record<DenialReason, string> = {
  policy: 'switched off under Settings → Permissions',
};

/** Longer explanation for the prompt: what the user can do about it. */
export const DENIAL_HINT: Record<DenialReason, string> = {
  policy: 'switched off by the user under Settings → Permissions (applies to every character)',
};

/** One module and the functions of it that are available, in registry order. */
export interface AllowedModule {
  id: string;
  methods: string[];
}

/** What the app-wide policy leaves of the SDK, function by function. */
export interface EffectiveCapabilities {
  /** Every module with at least one allowed function, each with its allowed method names. */
  effective: AllowedModule[];
  /** Every switched-off function as `module.method`, with the (only) reason. */
  denied: Record<string, DenialReason>;
}

/** `true` unless the app-wide policy explicitly turns this function (or its whole module) off. */
export function policyAllows(settings: Pick<AppSettings, 'permissions'>, module: string, method: string): boolean {
  return functionAllowed(settings.permissions?.functionAllow, module, method);
}

/** The `modules`/`methods` pair the `@rp/sdk` generators take, from a list of allowed modules. */
export function selectionOptions(allowed: readonly AllowedModule[]): { modules: string[]; methods: Record<string, string[]> } {
  const methods: Record<string, string[]> = {};
  for (const m of allowed) methods[m.id] = m.methods;
  return { modules: allowed.map((m) => m.id), methods };
}

/**
 * What the character's prompt describes: the functions it may call, narrowed to the pack author's
 * `promptFunctions` selection when the character has one. The narrowing is the author's editorial
 * choice about the prompt and never widens anything — a function the user switched off stays out,
 * and one left out of the prompt is still there for the pack's own `lib` code to call.
 */
export function promptSelection(allowed: readonly AllowedModule[], promptFunctions?: readonly string[]): AllowedModule[] {
  // No list at all means "everything allowed"; an empty one is a deliberate "nothing but `lib`".
  if (!promptFunctions) return allowed.map((m) => ({ ...m }));
  const out: AllowedModule[] = [];
  for (const m of allowed) {
    const methods = m.methods.filter((method) => selectionCovers(promptFunctions, m.id, method));
    if (methods.length > 0) out.push({ id: m.id, methods });
  }
  return out;
}

/**
 * Per-call permission logic. Permissions are app-wide and per function: the only control is the
 * user's policy under Settings → Permissions (`settings.permissions.functionAllow`), which applies
 * to every installed character alike. Packs neither request nor are granted anything.
 *
 * - `sdk.lib` is the character's own function library and is always available.
 * - a switched-off function is denied, whatever its level.
 * - `trusted` and `pack` methods the policy allows are called without asking.
 * - `prompt` methods additionally need a user confirmation on every call, unless an
 *   `allow-session` decision was remembered for this session+module+method (or the handler
 *   pre-authorises the call).
 *
 * The `packId` parameters remain for call-site compatibility; the answer no longer depends on them.
 */
export class PermissionService {
  private readonly sessionAllows = new Set<string>();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly prompter: PermissionPrompter,
    private readonly emitter: EngineEmitter,
    private readonly logger: Logger,
    private readonly settings: () => Promise<Pick<AppSettings, 'permissions'>> = async () => ({ permissions: { functionAllow: {} } }),
  ) {}

  /** Every function the policy allows, grouped by module, and the switched-off ones with the reason. */
  async effective(_packId?: string): Promise<EffectiveCapabilities> {
    const settings = await this.settings();
    const effective: AllowedModule[] = [];
    const denied: Record<string, DenialReason> = {};
    for (const spec of this.registry.list()) {
      const methods: string[] = [];
      for (const method of Object.keys(spec.methods)) {
        if (policyAllows(settings, spec.id, method)) methods.push(method);
        else denied[functionKey(spec.id, method)] = 'policy';
      }
      if (methods.length > 0) effective.push({ id: spec.id, methods });
    }
    return { effective, denied };
  }

  /** Every module with at least one allowed function, each with its allowed methods, in registry order. */
  async allowedFunctions(packId?: string): Promise<AllowedModule[]> {
    return (await this.effective(packId)).effective;
  }

  /** Module ids with at least one function left. */
  async allowedModules(packId?: string): Promise<string[]> {
    return (await this.allowedFunctions(packId)).map((m) => m.id);
  }

  /** `module.method` keys switched off (for error messages and the help module). */
  async deniedFunctions(packId?: string): Promise<string[]> {
    return Object.keys((await this.effective(packId)).denied);
  }

  /** Module ids registered but switched off entirely (no function of them is left). */
  async deniedModules(packId?: string): Promise<string[]> {
    const left = new Set(await this.allowedModules(packId));
    return this.registry
      .list()
      .map((spec) => spec.id)
      .filter((id) => !left.has(id));
  }

  async isAllowed(context: ActionContext, module: string, method: string): Promise<PermissionVerdict> {
    if (isAlwaysAvailableModule(module)) return 'allow';
    const level: PermissionLevel = this.registry.permissionFor(module, method);
    if (!policyAllows(await this.settings(), module, method)) return 'deny';
    if (level !== 'prompt') return 'allow';
    return this.sessionAllows.has(this.sessionKey(context.sessionId, module, method)) ? 'allow' : 'prompt';
  }

  /** Human-readable reason a function is unavailable (for error messages and the prompt). */
  async denialReason(_packId: string, _module: string, _method?: string): Promise<string> {
    return DENIAL_TEXT.policy;
  }

  /** Ask the user through the injected prompter; remembers `allow-session` decisions in memory. */
  async prompt(request: PermissionRequest): Promise<PermissionDecision> {
    this.emitter.emit('permission-request', request);
    let decision: PermissionDecision;
    try {
      decision = await this.prompter(request);
    } catch (err) {
      this.logger.warn('[permissions] prompter failed; treating as deny', err);
      decision = 'deny';
    }
    if (decision === 'allow-session') {
      this.sessionAllows.add(this.sessionKey(request.context.sessionId, request.call.module, request.call.method));
    }
    return decision;
  }

  buildRequest(context: ActionContext, module: string, method: string, args: PermissionRequest['call']['args'], callId: string): PermissionRequest {
    const spec = this.registry.methodSpec(module, method);
    return {
      requestId: randomUUID(),
      call: { callId, module, method, args },
      context: { packId: context.packId, characterId: context.characterId, sessionId: context.sessionId },
      description: spec.description,
      dangerous: spec.dangerous === true,
    };
  }

  /** Forget the remembered `allow-session` decisions of one session. */
  clearSession(sessionId: string): void {
    for (const key of [...this.sessionAllows]) if (key.startsWith(`${sessionId} `)) this.sessionAllows.delete(key);
  }

  private sessionKey(sessionId: string, module: string, method: string): string {
    return `${sessionId} ${module} ${method}`;
  }
}
