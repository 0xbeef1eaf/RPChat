import { randomUUID } from 'node:crypto';
import type { CapabilityRegistry } from '@rp/sdk';
import type { ActionContext, AppSettings, PermissionDecision, PermissionLevel, PermissionRequest } from '@rp/shared';
import type { EngineEmitter, Logger } from '../types.js';

export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionDecision>;

export type PermissionVerdict = 'allow' | 'deny' | 'prompt';

/** Why a non-trusted module is unavailable: only ever the app-wide policy. */
export type DenialReason = 'policy';

export const DENIAL_TEXT: Record<DenialReason, string> = {
  policy: 'switched off under Settings → Permissions',
};

/** Longer explanation for the prompt: what the user can do about it. */
export const DENIAL_HINT: Record<DenialReason, string> = {
  policy: 'switched off by the user under Settings → Permissions (applies to every character)',
};

export interface EffectiveCapabilities {
  /** Every registered non-trusted module the app-wide policy allows, in registry order. */
  effective: string[];
  /** Every registered non-trusted module the policy switches off, with the (only) reason. */
  denied: Record<string, DenialReason>;
}

/** `true` unless the app-wide policy explicitly turns the module off. */
export function policyAllows(settings: Pick<AppSettings, 'permissions'>, module: string): boolean {
  return settings.permissions?.moduleAllow?.[module] !== false;
}

/**
 * Per-call permission logic. Permissions are app-wide: the only control is the user's policy
 * under Settings → Permissions (`settings.permissions.moduleAllow`), which applies to every
 * installed character alike. Packs neither request nor are granted anything.
 *
 * - `trusted` methods are always allowed.
 * - `pack` methods are allowed unless the policy switches the module off.
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
    private readonly settings: () => Promise<Pick<AppSettings, 'permissions'>> = async () => ({ permissions: { moduleAllow: {} } }),
  ) {}

  /** Every non-trusted module the policy allows and, per switched-off module, the reason. */
  async effective(_packId?: string): Promise<EffectiveCapabilities> {
    const settings = await this.settings();
    const effective: string[] = [];
    const denied: Record<string, DenialReason> = {};
    for (const spec of this.registry.list()) {
      if (spec.permission === 'trusted') continue;
      if (policyAllows(settings, spec.id)) effective.push(spec.id);
      else denied[spec.id] = 'policy';
    }
    return { effective, denied };
  }

  /** Module ids usable right now: every `trusted` module plus the effective set, in registry order. */
  async allowedModules(packId?: string): Promise<string[]> {
    const { effective } = await this.effective(packId);
    const ok = new Set(effective);
    return this.registry
      .list()
      .filter((spec) => spec.permission === 'trusted' || ok.has(spec.id))
      .map((spec) => spec.id);
  }

  /** Module ids registered but switched off (for error messages and the help module). */
  async deniedModules(packId?: string): Promise<string[]> {
    return Object.keys((await this.effective(packId)).denied);
  }

  async isAllowed(context: ActionContext, module: string, method: string): Promise<PermissionVerdict> {
    const level: PermissionLevel = this.registry.permissionFor(module, method);
    if (level === 'trusted') return 'allow';
    if (!policyAllows(await this.settings(), module)) return 'deny';
    if (level === 'pack') return 'allow';
    return this.sessionAllows.has(this.sessionKey(context.sessionId, module, method)) ? 'allow' : 'prompt';
  }

  /** Human-readable reason a module is unavailable (for error messages and the prompt). */
  async denialReason(_packId: string, _module: string): Promise<string> {
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
