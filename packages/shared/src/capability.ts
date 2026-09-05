import type { CallId, CharacterId, Json, PackId, SessionId } from './ids.js';
import type { SerializedError } from './errors.js';

/**
 * Permission level of a capability module (or of a single method override).
 *
 * - `trusted`: always available; effects stay inside the app's own data.
 * - `pack`: must be requested in the pack manifest and granted by the user (per pack).
 * - `prompt`: as `pack`, and every call additionally needs a user confirmation
 *   (which may be remembered for the session).
 */
export type PermissionLevel = 'trusted' | 'pack' | 'prompt';

export interface CapabilityMethodSpec {
  /** One-line description (also used in UI permission prompts). */
  description: string;
  /** Overrides the module-level permission for this method only. */
  permission?: PermissionLevel;
  /** Marks the method as having effects outside the app (shown with a warning in the UI). */
  dangerous?: boolean;
}

/**
 * Declarative description of one SDK module. Owned by `@rp/sdk`.
 * The same spec drives: generated `sdk.d.ts`, generated docs for the LLM,
 * the sandbox `sdk` proxy, and permission checks.
 */
export interface CapabilityModuleSpec {
  /** Property name on the global `sdk` object. Pattern: /^[a-z][a-zA-Z0-9]*$/ */
  id: string;
  /** Semver of the module surface. */
  version: string;
  /** Short human-readable title, e.g. "Media playback". */
  title: string;
  /** One-line summary used in the `Sdk` interface TSDoc and permission UI. */
  summary: string;
  permission: PermissionLevel;
  /** Name of the interface declared in `typings`, e.g. `MediaApi`. */
  apiTypeName: string;
  /**
   * TypeScript declaration source. Must declare `interface <apiTypeName> { ... }`
   * with TSDoc on every member. May declare additional helper types/interfaces.
   * Must not use `import`/`export`; shared helper types (e.g. `AssetRef`) are
   * declared once by `@rp/sdk` in its preamble.
   */
  typings: string;
  /** Markdown guidance for the LLM: what the module is for, examples, pitfalls. */
  docs: string;
  /** Every method exposed on the module; keys must match the members declared in `typings`. */
  methods: Record<string, CapabilityMethodSpec>;
}

/** Compact description of the SDK surface used by the sandbox to build the `sdk` proxy. */
export interface SdkSurface {
  modules: Array<{ id: string; methods: string[] }>;
}

/** Identifies who is acting; attached to every capability call for permission checks and audit. */
export interface ActionContext {
  packId: PackId;
  characterId: CharacterId;
  sessionId: SessionId;
  /** Absolute path of the installed pack root (for asset resolution on the host). */
  packRoot: string;
  /** Why this code is running. */
  trigger: ActionTrigger;
}

export type ActionTrigger =
  | { kind: 'llm'; actionId: string; messageId: string }
  | { kind: 'behaviour'; hook: BehaviourHook }
  | { kind: 'timer'; timerId: string }
  | { kind: 'event'; subscriptionId: string; event: string };

export type BehaviourHook = 'onInstall' | 'onSessionStart' | 'onUserMessage' | 'onTimer' | 'onEvent' | 'onSessionEnd';

/** A single `sdk.<module>.<method>(...args)` invocation crossing the sandbox boundary. */
export interface CapabilityCall {
  callId: CallId;
  module: string;
  method: string;
  args: Json[];
  context: ActionContext;
}

export type CapabilityResult =
  | { ok: true; value: Json }
  | { ok: false; error: SerializedError };

/**
 * Host-side implementation of one module. Implemented in `apps/desktop` (Electron)
 * and, for modules with no host effects (`state`, `log`, `pack`, `timers`, `chat`), in `@rp/core`.
 */
export interface CapabilityHandler {
  readonly moduleId: string;
  /** Called with validated permission. Throw `RpError` for failures. */
  invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void>;
  /**
   * For `prompt`-level methods only: return true to skip the per-call confirmation because the
   * call is covered by a user-configured allowlist (e.g. a web domain, a launchable app, a path
   * inside the character's own home directory). Denials are still audited normally.
   */
  preauthorize?(method: string, args: Json[], context: ActionContext): Promise<boolean>;
  dispose?(): Promise<void> | void;
}

/**
 * Entry point the sandbox uses to reach the host. Implemented by core's
 * `CapabilityDispatcher` (permission check → audit → handler).
 */
export interface CapabilityInvoker {
  invoke(call: CapabilityCall): Promise<CapabilityResult>;
}

/** A stored decision about a `pack`-level capability for one pack. */
export interface CapabilityGrant {
  packId: PackId;
  module: string;
  granted: boolean;
  grantedAt: string;
}

/** A pending `prompt`-level confirmation shown to the user. */
export interface PermissionRequest {
  requestId: string;
  call: Pick<CapabilityCall, 'callId' | 'module' | 'method' | 'args'>;
  context: Pick<ActionContext, 'packId' | 'characterId' | 'sessionId'>;
  description: string;
  dangerous: boolean;
}

export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny';
