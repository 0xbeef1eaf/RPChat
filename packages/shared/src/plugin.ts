import type { CapabilityHandler, CapabilityModuleSpec, PermissionLevel } from './capability.js';
import type { Json } from './ids.js';

/**
 * `plugin.json` at the root of a plugin folder. A plugin adds one or more SDK capability
 * modules: the typings/docs/methods come from this manifest (and the files it points to),
 * the host implementation from `main` (a JavaScript module loaded in the app's main process).
 *
 * Plugins run as trusted code inside the app. Only install plugins you trust.
 */
export interface PluginManifest {
  /** Reverse-DNS id, e.g. `com.me.clock`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  homepage?: string;
  /** Entry module relative to the plugin dir (ESM or CommonJS). Default `main.js`. */
  main?: string;
  /** Minimum app version this plugin needs. */
  minAppVersion?: string;
  modules: PluginModuleManifest[];
}

/** One capability module as declared in `plugin.json`; file paths are relative to the plugin dir. */
export interface PluginModuleManifest {
  /** Property name on `sdk`. Must not collide with a built-in module. */
  id: string;
  version: string;
  title: string;
  summary: string;
  permission: PermissionLevel;
  apiTypeName: string;
  /** Path to a `.d.ts` fragment declaring `interface <apiTypeName>` (or inline text via `typingsText`). */
  typings?: string;
  typingsText?: string;
  /** Path to a markdown file with guidance for the model (or inline via `docsText`). */
  docs?: string;
  docsText?: string;
  methods: CapabilityModuleSpec['methods'];
}

/** What the app hands to a plugin's `activate(host)`. */
export interface PluginHost {
  readonly pluginId: string;
  readonly pluginDir: string;
  /** Per-plugin writable directory under the app's user data. */
  readonly dataDir: string;
  readonly appVersion: string;
  readonly log: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** Per-plugin persistent key/value store. */
  readonly storage: {
    get(key: string): Promise<Json | undefined>;
    set(key: string, value: Json): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /** Run an external program without a shell. */
  exec(command: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** HTTP(S) request through the app (no allowlist; plugins are trusted). */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  /** OS notification. */
  notify(title: string, body?: string): void;
  /**
   * Raise a host event that characters can subscribe to with `sdk.events.on("custom:<name>", ...)`.
   * `characterRef` limits delivery to one character; omit to reach every subscriber.
   */
  emitEvent(name: string, data?: Json, opts?: { characterRef?: string }): void;
}

/** Returned by `activate`. */
export interface PluginActivation {
  /** One handler per module declared in the manifest, keyed by module id. */
  handlers: Record<string, CapabilityHandler | Omit<CapabilityHandler, 'moduleId'>>;
  /** Called when the plugin is disabled, reloaded or the app quits. */
  dispose?(): Promise<void> | void;
}

/** Shape of the entry module: `export function activate(host) { ... }` (or `export default`). */
export interface PluginEntryModule {
  activate(host: PluginHost): PluginActivation | Promise<PluginActivation>;
}

export type PluginState = 'active' | 'disabled' | 'error';

/** What the UI shows for an installed plugin. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  dir: string;
  enabled: boolean;
  state: PluginState;
  /** Load/activation error, when state is `error`. */
  error?: string;
  modules: Array<{ id: string; title: string; permission: PermissionLevel; methods: string[] }>;
}
