import { randomUUID } from 'node:crypto';
import type { CapabilityRegistry } from '@rp/sdk';
import type {
  ActionContext,
  AppSettings,
  CapabilityGrant,
  PermissionDecision,
  PermissionLevel,
  PermissionRequest,
  Storage,
} from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Clock, EngineEmitter, Logger } from '../types.js';

export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionDecision>;

export type PermissionVerdict = 'allow' | 'deny' | 'prompt';

/** Why a non-trusted module is unavailable to a pack. */
export type DenialReason = 'not-requested' | 'policy' | 'not-granted';

export const DENIAL_TEXT: Record<DenialReason, string> = {
  'not-requested': 'not requested by the pack',
  policy: 'denied by your settings',
  'not-granted': 'not granted',
};

/** Longer explanation for the prompt: what the user (or pack author) can do about it. */
export const DENIAL_HINT: Record<DenialReason, string> = {
  'not-requested': 'the pack does not request it; the pack author must add it to the manifest capabilities',
  policy: 'switched off globally by the user under Settings → Permissions',
  'not-granted': 'switched off for this pack by the user under Packs → this pack → permission toggles',
};

export interface EffectiveCapabilities {
  /** requested ∩ global policy ∩ per-pack grant (non-trusted modules only). */
  effective: string[];
  /** Requested modules the global policy denies. */
  blockedByPolicy: string[];
  /** Every registered non-trusted module the pack cannot use, with the reason. */
  denied: Record<string, DenialReason>;
}

/** `true` unless the global policy explicitly turns the module off. */
export function policyAllows(settings: Pick<AppSettings, 'permissions'>, module: string): boolean {
  return settings.permissions?.moduleAllow?.[module] !== false;
}

/**
 * Grant store + per-call permission logic. A pack's effective capabilities are the
 * intersection of what it requested, what the global policy allows and the per-pack grant:
 *
 * - `trusted` methods are always allowed.
 * - `pack` methods need all three.
 * - `prompt` methods need all three and then a user confirmation, unless an `allow-session`
 *   decision was remembered for this session+module+method (or the handler pre-authorises the call).
 */
export class PermissionService {
  private readonly sessionAllows = new Set<string>();
  private readonly grantListeners = new Set<(packId: string) => void>();

  constructor(
    private readonly storage: Pick<Storage, 'grants' | 'packs'>,
    private readonly registry: CapabilityRegistry,
    private readonly prompter: PermissionPrompter,
    private readonly emitter: EngineEmitter,
    private readonly now: Clock,
    private readonly logger: Logger,
    private readonly settings: () => Promise<Pick<AppSettings, 'permissions'>> = async () => ({ permissions: { moduleAllow: {} } }),
  ) {}

  grantsFor(packId: string): Promise<CapabilityGrant[]> {
    return this.storage.grants.list(packId);
  }

  async setGrant(packId: string, module: string, granted: boolean): Promise<void> {
    if (!this.registry.has(module)) {
      throw new RpError('CAPABILITY_UNKNOWN', `Unknown capability module "${module}"`, { module });
    }
    await this.storage.grants.set({ packId, module, granted, grantedAt: this.now().toISOString() });
    if (!granted) {
      for (const key of [...this.sessionAllows]) if (key.split(' ')[1] === module) this.sessionAllows.delete(key);
    }
    for (const listener of this.grantListeners) {
      try {
        listener(packId);
      } catch (err) {
        this.logger.warn('[permissions] grant listener failed', err);
      }
    }
  }

  /** Subscribe to grant changes (used by PackService to run deferred `onInstall` hooks). */
  onGrantsChanged(listener: (packId: string) => void): () => void {
    this.grantListeners.add(listener);
    return () => this.grantListeners.delete(listener);
  }

  async isGranted(packId: string, module: string): Promise<boolean> {
    const grants = await this.storage.grants.list(packId);
    return grants.some((g) => g.module === module && g.granted);
  }

  /** Modules the pack asked for (pack + character level), from its install record. */
  async requestedModules(packId: string): Promise<string[]> {
    const record = await this.storage.packs.get(packId);
    return record?.requestedCapabilities ?? [];
  }

  /** The intersection and, per denied module, why. */
  async effective(packId: string): Promise<EffectiveCapabilities> {
    const [requested, grants, settings] = await Promise.all([this.requestedModules(packId), this.storage.grants.list(packId), this.settings()]);
    const requestedSet = new Set(requested);
    const granted = new Set(grants.filter((g) => g.granted).map((g) => g.module));
    const effective: string[] = [];
    const blockedByPolicy: string[] = [];
    const denied: Record<string, DenialReason> = {};
    for (const spec of this.registry.list()) {
      if (spec.permission === 'trusted') continue;
      const id = spec.id;
      if (!requestedSet.has(id)) {
        denied[id] = 'not-requested';
        continue;
      }
      if (!policyAllows(settings, id)) {
        denied[id] = 'policy';
        blockedByPolicy.push(id);
        continue;
      }
      if (!granted.has(id)) {
        denied[id] = 'not-granted';
        continue;
      }
      effective.push(id);
    }
    return { effective, blockedByPolicy, denied };
  }

  /** Module ids usable by the pack right now: every `trusted` module plus the effective set, in registry order. */
  async allowedModules(packId: string): Promise<string[]> {
    const { effective } = await this.effective(packId);
    const ok = new Set(effective);
    return this.registry
      .list()
      .filter((spec) => spec.permission === 'trusted' || ok.has(spec.id))
      .map((spec) => spec.id);
  }

  /** Module ids registered but not usable by the pack (for the "not available" prompt section). */
  async deniedModules(packId: string): Promise<string[]> {
    return Object.keys((await this.effective(packId)).denied);
  }

  async isAllowed(context: ActionContext, module: string, method: string): Promise<PermissionVerdict> {
    const level: PermissionLevel = this.registry.permissionFor(module, method);
    if (level === 'trusted') return 'allow';
    const { effective } = await this.effective(context.packId);
    if (!effective.includes(module)) return 'deny';
    if (level === 'pack') return 'allow';
    return this.sessionAllows.has(this.sessionKey(context.sessionId, module, method)) ? 'allow' : 'prompt';
  }

  /** Human-readable reason a module is unavailable to the pack (for error messages and the prompt). */
  async denialReason(packId: string, module: string): Promise<string> {
    const { denied } = await this.effective(packId);
    const reason = denied[module];
    return reason ? DENIAL_TEXT[reason] : DENIAL_TEXT['not-granted'];
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

  async removeForPack(packId: string): Promise<void> {
    await this.storage.grants.removeForPack(packId);
  }

  private sessionKey(sessionId: string, module: string, method: string): string {
    return `${sessionId} ${module} ${method}`;
  }
}
