import type { ActionContext, CapabilityHandler, CapabilityModuleSpec, PermissionLevel } from './capability.js';
import type { Json } from './ids.js';
import type { MediaKind } from './media.js';

/**
 * `plugin.json` at the root of a plugin folder. A plugin adds SDK capability modules and/or
 * remote media sources: the typings/docs/methods come from this manifest (and the files it
 * points to), the host implementation from `main` (a JavaScript module loaded in the app's
 * main process).
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
  /** SDK modules the plugin adds. May be empty when the plugin only provides media sources. */
  modules: PluginModuleManifest[];
  /** Remote media sources the plugin adds (`sdk.mediaSources`). A plugin declares modules, sources or both. */
  mediaSources?: PluginMediaSourceManifest[];
}

/**
 * One remote media source as declared in `plugin.json`: somewhere characters can search for
 * pictures, video or sound that are not on this machine (a photo library, an image board, a
 * stock-media API). Characters reach it as `<pluginId>/<id>` through `sdk.mediaSources`.
 */
export interface PluginMediaSourceManifest {
  /** Local id, unique in the plugin: `/^[a-z][a-z0-9-]{0,39}$/`. */
  id: string;
  /** Short name shown to the user and the model, e.g. "Family photos". */
  title: string;
  /** One line for the model: what is in there and when it is a good place to look. */
  description: string;
  /** The kinds of media it serves. */
  kinds: MediaKind[];
}

/** What a character asked a media source for (`sdk.mediaSources.search`). Every field is optional. */
export interface MediaSourceQuery {
  /** Free text, as the character wrote it. */
  text?: string;
  /** Tags the results should carry; how strictly is up to the source. */
  tags?: string[];
  /** Only items of this kind (always one of the source's declared `kinds`). */
  kind?: MediaKind;
  /** How many results the character wants, 1..50 (default 20). Returning fewer is fine. */
  limit?: number;
  /** 1-based page of results, for "show me more". Sources that cannot page may ignore it. */
  page?: number;
}

/** One search result. Only `id` and `kind` are required. */
export interface RemoteMediaItem {
  /** The source's own id for the item, handed back to `fetch` (≤ 512 characters, no control characters). */
  id: string;
  kind: MediaKind;
  /** MIME type, when known; otherwise the app reads it off the download. */
  mime?: string;
  /** One line describing the item, shown to the model. */
  description?: string;
  /** Lower-case tags describing the item. */
  tags?: string[];
  /** Size in bytes, when known. */
  bytes?: number;
}

/**
 * Where the bytes of an item are: an HTTP(S) URL the app downloads (with any headers it needs,
 * e.g. an API key), or a file on this machine the plugin already fetched.
 */
export type RemoteMediaLocation = { url: string; headers?: Record<string, string> } | { file: string };

/** The host side of one media source, returned from `activate(host)` under its id. */
export interface MediaSourceProvider {
  /** Find items. Throw to report a failure; the message reaches the character. */
  search(query: MediaSourceQuery, context: ActionContext): Promise<RemoteMediaItem[]> | RemoteMediaItem[];
  /**
   * Where to get the bytes of an item `search` returned. Called when a character shows it (results
   * are downloaded on demand and cached); URLs that expire are fine, since this is asked again
   * whenever the cached copy is gone.
   */
  fetch(itemId: string, context: ActionContext): Promise<RemoteMediaLocation> | RemoteMediaLocation;
}

/** A remote media source as the app lists it: the provider's declaration under its full id. */
export interface MediaSourceInfo {
  /** `<pluginId>/<id>`, the id characters use. */
  id: string;
  pluginId: string;
  title: string;
  description: string;
  kinds: MediaKind[];
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
  /** One provider per media source declared in the manifest, keyed by its local id. */
  mediaSources?: Record<string, MediaSourceProvider>;
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
  /** Remote media sources, by their full `<pluginId>/<id>`. */
  mediaSources: Array<{ id: string; title: string; kinds: MediaKind[] }>;
}
