/**
 * SDK plugins (docs/spec/plugins.md "Desktop main"): loads every folder under
 * `<userData>/plugins/` with a `plugin.json`, registers its modules with the
 * engine, and exposes install/remove/enable/reload for the settings UI.
 * Every plugin fails independently; module import is injectable for tests.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActionContext, CapabilityHandler, CapabilityModuleSpec, HostEvent, Json, PluginActivation, PluginEntryModule, PluginHost, PluginInfo, PluginManifest } from '@rp/shared';
import { RpError } from '@rp/shared';
import { normalizeRelativePath, resolveAssetPath } from '@rp/pack';
import { createPluginHost } from './host.js';
import type { PluginRegistry } from './registry.js';
import { PLUGIN_MANIFEST_FILENAME, loadPluginModuleSpecs, readPluginManifest } from './sdk-adapter.js';

/** The engine surface the service needs (`engine.capabilities.register/unregister` come with the plugin work in core). */
export interface PluginEngineLike {
  capabilities: {
    register?(spec: CapabilityModuleSpec, handler: CapabilityHandler): Promise<void> | void;
    unregister?(id: string): Promise<boolean | void> | boolean | void;
    list(): Array<{ id: string }>;
  };
  hostEvents?: { emit(event: HostEvent): void };
}

export type ModuleImporter = (file: string) => Promise<unknown>;

export interface PluginServiceDeps {
  pluginsDir: string;
  dataDir: string;
  registry: PluginRegistry;
  engine: PluginEngineLike;
  /** Ids of the app's built-in modules (plugins may never shadow them). */
  builtinIds: ReadonlySet<string>;
  appVersion: string;
  logger: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  notify?(title: string, body: string): void;
  openDirectory?(): Promise<string | undefined>;
  openPath?(dir: string): Promise<string>;
  importModule?: ModuleImporter;
}

interface Loaded {
  manifest: PluginManifest;
  dir: string;
  specs: CapabilityModuleSpec[];
  activation?: PluginActivation;
  registered: string[];
  state: PluginInfo['state'];
  error?: string;
}

/** Wraps a plugin's handler: fixed module id, errors surfaced as CAPABILITY_FAILED. */
export class PluginModuleHandler implements CapabilityHandler {
  constructor(
    readonly moduleId: string,
    private readonly pluginId: string,
    private readonly inner: Omit<CapabilityHandler, 'moduleId'> & Partial<Pick<CapabilityHandler, 'moduleId'>>,
  ) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    try {
      return await this.inner.invoke(method, args, context);
    } catch (err) {
      if (err instanceof RpError) throw err;
      throw new RpError('CAPABILITY_FAILED', `sdk.${this.moduleId}.${method} (plugin ${this.pluginId}) failed: ${(err as Error)?.message ?? String(err)}`, undefined, { cause: err });
    }
  }

  async preauthorize(method: string, args: Json[], context: ActionContext): Promise<boolean> {
    try {
      return this.inner.preauthorize ? Boolean(await this.inner.preauthorize(method, args, context)) : false;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }
}

/** ESM import with a cache-busting query (so `reload` sees new code); CommonJS fallback through `require`. */
let importCounter = 0;

export async function importPluginModule(file: string): Promise<unknown> {
  const url = `${pathToFileURL(file).href}?t=${Date.now()}-${++importCounter}`;
  try {
    return await import(/* @vite-ignore */ url);
  } catch (esmError) {
    try {
      const require = createRequire(import.meta.url);
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      return require(resolved) as unknown;
    } catch {
      throw esmError;
    }
  }
}

export function activateFrom(mod: unknown): PluginEntryModule['activate'] {
  const m = mod as { activate?: unknown; default?: unknown };
  if (typeof m?.activate === 'function') return m.activate as PluginEntryModule['activate'];
  const d = m?.default as { activate?: unknown } | undefined;
  if (typeof d === 'function') return d as PluginEntryModule['activate'];
  if (typeof d?.activate === 'function') return d.activate as PluginEntryModule['activate'];
  throw new RpError('INVALID_ARGUMENT', 'The entry module must export activate(host) (or export default { activate })');
}

export class PluginService {
  private readonly plugins = new Map<string, Loaded>();
  private readonly importModule: ModuleImporter;

  constructor(private readonly deps: PluginServiceDeps) {
    this.importModule = deps.importModule ?? importPluginModule;
  }

  get pluginsDir(): string {
    return this.deps.pluginsDir;
  }

  /** Load every plugin folder; failures are isolated per plugin. */
  async loadAll(): Promise<PluginInfo[]> {
    await fs.mkdir(this.deps.pluginsDir, { recursive: true });
    const entries = await fs.readdir(this.deps.pluginsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.deps.pluginsDir, entry.name);
      try {
        await fs.access(path.join(dir, PLUGIN_MANIFEST_FILENAME));
      } catch {
        continue;
      }
      await this.load(dir).catch((err: unknown) => this.deps.logger.warn(`[plugins] ${entry.name}: ${(err as Error).message}`));
    }
    return this.list();
  }

  /** Load (or re-load) one plugin folder; returns its info, never throws for plugin errors. */
  async load(dir: string): Promise<PluginInfo> {
    let manifest: PluginManifest;
    try {
      manifest = await readPluginManifest(dir);
    } catch (err) {
      // No usable manifest: remember the folder under its name so the UI can show the problem.
      const id = path.basename(dir);
      const loaded: Loaded = { manifest: { id, name: id, version: '0.0.0', modules: [] }, dir, specs: [], registered: [], state: 'error', error: (err as Error).message };
      this.plugins.set(id, loaded);
      return this.info(loaded);
    }
    const existing = this.plugins.get(manifest.id);
    if (existing && existing.dir !== dir && existing.state !== 'error') {
      const loaded: Loaded = { manifest, dir, specs: [], registered: [], state: 'error', error: `Another plugin with id ${manifest.id} is already loaded from ${existing.dir}` };
      return this.info(loaded);
    }
    if (existing) await this.deactivate(existing);
    const loaded: Loaded = { manifest, dir, specs: [], registered: [], state: 'disabled' };
    this.plugins.set(manifest.id, loaded);
    if (!this.deps.registry.isEnabled(manifest.id)) return this.info(loaded);
    await this.activate(loaded);
    return this.info(loaded);
  }

  private async activate(loaded: Loaded): Promise<void> {
    const { manifest, dir } = loaded;
    try {
      const specs = await loadPluginModuleSpecs(dir, manifest);
      for (const spec of specs) {
        if (this.deps.builtinIds.has(spec.id)) throw new RpError('INVALID_ARGUMENT', `Module "${spec.id}" is built into the app and cannot be replaced by a plugin`);
        if (this.deps.engine.capabilities.list().some((m) => m.id === spec.id)) throw new RpError('INVALID_ARGUMENT', `Module "${spec.id}" is already provided by another plugin`);
      }
      loaded.specs = specs;
      const mainRel = manifest.main ?? 'main.js';
      if (!normalizeRelativePath(mainRel).ok) throw new RpError('INVALID_ARGUMENT', `main "${mainRel}" is not a relative path`);
      const mainFile = resolveAssetPath(dir, mainRel);
      const activate = activateFrom(await this.importModule(mainFile));
      const host = this.hostFor(manifest.id, dir);
      const activation = await activate(host);
      if (!activation || typeof activation !== 'object' || !activation.handlers || typeof activation.handlers !== 'object') {
        throw new RpError('INVALID_ARGUMENT', 'activate(host) must return { handlers: { <moduleId>: handler } }');
      }
      loaded.activation = activation;
      const register = this.deps.engine.capabilities.register;
      if (typeof register !== 'function') throw new RpError('INTERNAL', 'This build of @rp/core cannot register plugin modules (engine.capabilities.register missing)');
      for (const spec of specs) {
        const handler = activation.handlers[spec.id];
        if (!handler || typeof handler.invoke !== 'function') throw new RpError('INVALID_ARGUMENT', `activate(host) returned no handler for module "${spec.id}"`);
        await register.call(this.deps.engine.capabilities, spec, new PluginModuleHandler(spec.id, manifest.id, handler));
        loaded.registered.push(spec.id);
      }
      loaded.state = 'active';
      delete loaded.error;
      this.deps.logger.info(`[plugins] ${manifest.id}@${manifest.version} active (${specs.map((s) => s.id).join(', ')})`);
    } catch (err) {
      loaded.state = 'error';
      loaded.error = (err as Error).message;
      this.deps.logger.warn(`[plugins] ${manifest.id} failed: ${loaded.error}`);
      await this.deactivate(loaded, true);
    }
  }

  private async deactivate(loaded: Loaded, keepError = false): Promise<void> {
    const unregister = this.deps.engine.capabilities.unregister;
    for (const id of loaded.registered.splice(0)) {
      try {
        if (typeof unregister === 'function') await unregister.call(this.deps.engine.capabilities, id);
      } catch (err) {
        this.deps.logger.warn(`[plugins] unregister ${id} failed`, err);
      }
    }
    try {
      await loaded.activation?.dispose?.();
    } catch (err) {
      this.deps.logger.warn(`[plugins] ${loaded.manifest.id} dispose failed`, err);
    }
    loaded.activation = undefined;
    if (!keepError) {
      loaded.state = 'disabled';
      delete loaded.error;
    }
  }

  private hostFor(pluginId: string, dir: string): PluginHost {
    return createPluginHost({
      pluginId,
      pluginDir: dir,
      dataDir: path.join(this.deps.dataDir, pluginId),
      appVersion: this.deps.appVersion,
      logger: this.deps.logger,
      notify: (title, body) => (this.deps.notify ?? ((t, b) => this.deps.logger.info(`[plugins] notification: ${t} — ${b}`)))(title, body),
      emitHostEvent: (event) => {
        if (this.deps.engine.hostEvents?.emit) this.deps.engine.hostEvents.emit(event);
        else this.deps.logger.debug(`[plugins] dropped event ${event.name} (core has no hostEvents)`);
      },
    });
  }

  private info(loaded: Loaded): PluginInfo {
    const { manifest } = loaded;
    const info: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir: loaded.dir,
      enabled: this.deps.registry.isEnabled(manifest.id),
      state: loaded.state,
      modules: manifest.modules.map((m) => ({ id: m.id, title: m.title, permission: m.permission, methods: Object.keys(m.methods ?? {}) })),
    };
    if (manifest.description !== undefined) info.description = manifest.description;
    if (manifest.author !== undefined) info.author = manifest.author;
    if (loaded.error !== undefined) info.error = loaded.error;
    return info;
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((l) => this.info(l)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): PluginInfo | undefined {
    const loaded = this.plugins.get(id);
    return loaded ? this.info(loaded) : undefined;
  }

  private require(id: string): Loaded {
    const loaded = this.plugins.get(id);
    if (!loaded) throw new RpError('NOT_FOUND', `No plugin "${id}" is installed`);
    return loaded;
  }

  /** Copy a plugin folder into the plugins dir (validated first) and load it. */
  async install(dirArg?: string): Promise<PluginInfo | null> {
    let source = dirArg && dirArg.trim().length > 0 ? path.resolve(dirArg.trim()) : undefined;
    if (!source) {
      source = await this.deps.openDirectory?.();
      if (!source) return null;
    }
    const manifest = await readPluginManifest(source);
    for (const mod of manifest.modules) {
      if (this.deps.builtinIds.has(mod.id)) throw new RpError('INVALID_ARGUMENT', `Module "${mod.id}" is built into the app; the plugin cannot provide it`);
    }
    const existing = this.plugins.get(manifest.id);
    if (existing) await this.deactivate(existing);
    const dest = path.join(this.deps.pluginsDir, manifest.id);
    if (path.resolve(source) !== dest) {
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(this.deps.pluginsDir, { recursive: true });
      await fs.cp(source, dest, { recursive: true, dereference: true, filter: (src) => !['node_modules', '.git'].includes(path.basename(src)) });
    }
    this.deps.registry.setEnabled(manifest.id, true);
    return this.load(dest);
  }

  async remove(id: string): Promise<void> {
    const loaded = this.require(id);
    await this.deactivate(loaded);
    this.plugins.delete(id);
    this.deps.registry.remove(id);
    if (path.resolve(path.dirname(loaded.dir)) === path.resolve(this.deps.pluginsDir)) await fs.rm(loaded.dir, { recursive: true, force: true });
    await fs.rm(path.join(this.deps.dataDir, id), { recursive: true, force: true }).catch(() => undefined);
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const loaded = this.require(id);
    this.deps.registry.setEnabled(id, enabled);
    if (enabled) {
      if (loaded.state !== 'active') return this.load(loaded.dir);
    } else await this.deactivate(loaded);
    return this.info(loaded);
  }

  /** Dispose → re-read the manifest → re-import the entry module → re-register. */
  async reload(id: string): Promise<PluginInfo> {
    const loaded = this.require(id);
    return this.load(loaded.dir);
  }

  async openFolder(): Promise<void> {
    await fs.mkdir(this.deps.pluginsDir, { recursive: true });
    const error = await this.deps.openPath?.(this.deps.pluginsDir);
    if (error) throw new RpError('CAPABILITY_FAILED', error);
  }

  async dispose(): Promise<void> {
    for (const loaded of this.plugins.values()) await this.deactivate(loaded);
  }
}
