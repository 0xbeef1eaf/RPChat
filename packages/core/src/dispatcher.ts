import type { CapabilityRegistry } from '@rp/sdk';
import type {
  ActionContext,
  AuditEntry,
  CapabilityCall,
  CapabilityHandler,
  CapabilityInvoker,
  CapabilityResult,
  Json,
  LoadedPack,
  SerializedError,
} from '@rp/shared';
import { RpError, characterRef, serializeError } from '@rp/shared';
import { coerceAssetArg } from './assets.js';
import type { AuditService } from './services/audit.js';
import type { PermissionService } from './services/permissions.js';
import type { Clock, Logger } from './types.js';
import { NOOP_LOGGER, toJson } from './types.js';

export interface DispatcherOptions {
  registry: CapabilityRegistry;
  /** Core handlers first, host handlers after; a later handler for the same module wins (with a warning). */
  handlers: CapabilityHandler[];
  permissions: Pick<PermissionService, 'isAllowed' | 'prompt' | 'buildRequest'> & Partial<Pick<PermissionService, 'denialReason'>>;
  audit: Pick<AuditService, 'record'>;
  /** Used to normalise `media.*` asset arguments to pack-root-relative paths. */
  packs?: { tryGetLoaded(packId: string): LoadedPack | undefined };
  now?: Clock;
  logger?: Logger;
}

/** `module.method` calls whose first argument is an asset (string or AssetRef) and the kind it must have. */
const ASSET_ARG_METHODS: Record<string, 'image' | 'video' | 'audio'> = {
  'media.showImage': 'image',
  'media.playVideo': 'video',
  'media.playAudio': 'audio',
  'wallpaper.set': 'image',
};

/** `module.method` calls whose first argument is a `MediaHandle` (or its id) that host handlers receive as the id string. */
const HANDLE_ARG_METHODS = new Set(['media.close', 'media.update']);

const AUDIT_STRING_CAP = 1024;

/** Copy of `args` for the audit log with long strings shortened. */
function auditArgs(args: unknown[]): unknown[] {
  const shorten = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > AUDIT_STRING_CAP ? `${v.slice(0, AUDIT_STRING_CAP)}… (${v.length} chars)` : v;
    if (depth > 4 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => shorten(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = shorten(val, depth + 1);
    return out;
  };
  return args.map((a) => shorten(a, 0));
}

/**
 * Routes `sdk.<module>.<method>` calls from the sandbox to handlers:
 * registry check → permission check (with prompt) → argument normalisation →
 * handler → JSON-clean result. Every outcome (allowed / denied / failed) is audited.
 */
export class CapabilityDispatcher implements CapabilityInvoker {
  private readonly handlers = new Map<string, CapabilityHandler>();
  private readonly registry: CapabilityRegistry;
  private readonly permissions: DispatcherOptions['permissions'];
  private readonly audit: DispatcherOptions['audit'];
  private readonly packs: DispatcherOptions['packs'];
  private readonly now: Clock;
  private readonly logger: Logger;

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.audit = options.audit;
    this.packs = options.packs;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? NOOP_LOGGER;
    for (const handler of options.handlers) this.registerHandler(handler);
  }

  registerHandler(handler: CapabilityHandler): void {
    if (this.handlers.has(handler.moduleId)) {
      this.logger.warn(`[dispatcher] handler for module "${handler.moduleId}" replaced`);
    }
    this.handlers.set(handler.moduleId, handler);
  }

  handlerFor(moduleId: string): CapabilityHandler | undefined {
    return this.handlers.get(moduleId);
  }

  /** Modules that have both a registry spec and a handler. */
  availableModules(): string[] {
    return this.registry
      .list()
      .map((s) => s.id)
      .filter((id) => this.handlers.has(id));
  }

  async invoke(call: CapabilityCall): Promise<CapabilityResult> {
    const started = this.now().getTime();
    const context = call.context;
    const args: Json[] = Array.isArray(call.args) ? call.args : [];
    const module = String(call.module ?? '');
    const method = String(call.method ?? '');

    const finish = async (outcome: AuditEntry['outcome'], error?: SerializedError, finalArgs: unknown[] = args): Promise<void> => {
      const entry: Omit<AuditEntry, 'id' | 'at'> = {
        sessionId: context?.sessionId ?? '',
        characterRef: context ? characterRef(context.packId, context.characterId) : '',
        module,
        method,
        args: auditArgs(finalArgs),
        outcome,
        durationMs: this.now().getTime() - started,
      };
      if (error) entry.error = error;
      await this.audit.record(entry);
    };

    const fail = async (err: unknown, outcome: 'denied' | 'failed', finalArgs?: unknown[]): Promise<CapabilityResult> => {
      const error = serializeError(err);
      await finish(outcome, error, finalArgs);
      return { ok: false, error };
    };

    if (!context || typeof context.packId !== 'string' || typeof context.sessionId !== 'string') {
      return fail(new RpError('INVALID_ARGUMENT', 'Capability call has no valid ActionContext'), 'failed');
    }

    // 1. Registry knows the module + method?
    try {
      this.registry.methodSpec(module, method);
    } catch (err) {
      return fail(err, 'denied');
    }
    const handler = this.handlers.get(module);
    if (!handler) {
      return fail(new RpError('CAPABILITY_UNKNOWN', `No host handler for sdk.${module}`, { module }), 'denied');
    }

    // 2. Permission.
    try {
      const verdict = await this.permissions.isAllowed(context, module, method);
      if (verdict === 'deny') {
        const reason = this.permissions.denialReason ? await this.permissions.denialReason(context.packId, module) : 'not granted';
        return fail(
          new RpError('PERMISSION_DENIED', `sdk.${module}.${method} is not available to pack ${context.packId}: ${reason}`, { module, method, reason }),
          'denied',
        );
      }
      if (verdict === 'prompt') {
        let preauthorized = false;
        if (handler.preauthorize) {
          try {
            preauthorized = (await handler.preauthorize(method, args, context)) === true;
          } catch (err) {
            this.logger.warn(`[dispatcher] preauthorize of sdk.${module}.${method} threw; prompting instead`, err);
          }
        }
        const decision = preauthorized ? 'allow-once' : await this.permissions.prompt(this.permissions.buildRequest(context, module, method, args, call.callId));
        if (decision === 'deny') {
          return fail(
            new RpError('PERMISSION_PROMPT_REJECTED', `The user declined sdk.${module}.${method}`, { module, method }),
            'denied',
          );
        }
      }
    } catch (err) {
      return fail(err, 'failed');
    }

    // 3. Argument normalisation (media asset paths → pack-root-relative strings).
    let finalArgs = args;
    try {
      finalArgs = this.normaliseArgs(context, module, method, args);
    } catch (err) {
      return fail(err, 'failed');
    }

    // 4. Handler.
    try {
      const value = await handler.invoke(method, finalArgs, context);
      const json = toJson(value);
      await finish('allowed', undefined, finalArgs);
      return { ok: true, value: json };
    } catch (err) {
      const rp = err instanceof RpError ? err : RpError.from(err, 'CAPABILITY_FAILED');
      return fail(rp, 'failed', finalArgs);
    }
  }

  async dispose(): Promise<void> {
    for (const handler of this.handlers.values()) {
      try {
        await handler.dispose?.();
      } catch (err) {
        this.logger.warn(`[dispatcher] dispose of ${handler.moduleId} failed`, err);
      }
    }
    this.handlers.clear();
  }

  /**
   * Asset arguments (`media.showImage/playVideo/playAudio`, `wallpaper.set`) become validated
   * pack-root-relative path strings of the required kind; handle arguments (`media.close/update`)
   * become the handle's id string. Everything else passes through unchanged.
   */
  private normaliseArgs(context: ActionContext, module: string, method: string, args: Json[]): Json[] {
    const key = `${module}.${method}`;
    const wantedKind = ASSET_ARG_METHODS[key];
    if (wantedKind) {
      const pack = this.packs?.tryGetLoaded(context.packId);
      if (!pack) throw new RpError('NOT_FOUND', `Pack "${context.packId}" is not installed`, { packId: context.packId });
      const ref = coerceAssetArg(pack, args[0]);
      if (ref.kind !== wantedKind) {
        throw new RpError('INVALID_ARGUMENT', `sdk.${key} needs a ${wantedKind} asset; "${ref.path}" is ${ref.kind}`, {
          path: ref.path,
          kind: ref.kind,
        });
      }
      const out = [...args];
      out[0] = ref.path;
      return out;
    }
    if (HANDLE_ARG_METHODS.has(key)) {
      const handle = args[0];
      const id =
        typeof handle === 'string'
          ? handle
          : handle && typeof handle === 'object' && !Array.isArray(handle) && typeof handle.id === 'string'
            ? handle.id
            : undefined;
      if (id === undefined || id.length === 0) {
        throw new RpError('INVALID_ARGUMENT', `sdk.${key} needs a MediaHandle or its id string`);
      }
      const out = [...args];
      out[0] = id;
      return out;
    }
    return args;
  }
}
