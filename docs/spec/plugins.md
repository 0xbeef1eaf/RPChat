# SDK plugins

Goal: anyone can add capability modules to the SDK without forking the app. A **plugin** is a
folder containing `plugin.json` and an entry JavaScript module. The manifest declares modules
(typings, docs, permission, methods) exactly like the built-in `CapabilityModuleSpec`s; the entry
module implements them on the host. Once loaded, plugin modules are indistinguishable from
built-ins: they appear in the generated `sdk.d.ts` and prompt docs, every character may use them
unless the user switches the module — or one function of it — off under Settings → Permissions
(the app-wide per-function policy is the only permission control), every call is audited. A plugin's
declared level decides whether a call is confirmed, never whether it is allowed.

Trust model: plugins are ordinary Node code running in the app's main process, with the same
power as the app. The UI says so on install. Contracts: `@rp/shared/plugin.ts`, `IpcApi.plugins`.

## Layout

```
my-plugin/
├── plugin.json
├── main.js                # export function activate(host) { return { handlers: { clock: {...} } } }
└── modules/
    ├── clock.d.ts         # interface ClockApi { ... } with TSDoc on every member
    └── clock.md           # guidance for the model
```

## @rp/sdk — manifest + spec loading

- `pluginManifestSchema` (zod) / `validatePluginManifest(json)`; module ids must match the
  registry id pattern and must not be a built-in id (checked by core at registration, not here).
- `loadPluginModuleSpecs(pluginDir, manifest): Promise<CapabilityModuleSpec[]>` — reads
  `typings`/`docs` files (or inline text), builds specs, runs `validateModuleSpec` on each and
  throws `INVALID_ARGUMENT` with the problems listed.
- `CapabilityRegistry.unregister(id)` (returns boolean) so plugins can be disabled/reloaded.
- Tests: schema, spec loading from a temp dir, unregister + re-register.

## @rp/core — runtime registration

- `engine.capabilities.register(spec, handler)`: rejects ids already registered (built-in or
  plugin) with `PACK_CONFLICT`-style `INVALID_ARGUMENT`; registers the spec and the handler in the
  dispatcher; `engine.capabilities.unregister(id)` removes both (calls the handler's `dispose`).
  Prompt builder, permissions, `capabilities.list()`/`typings()` read the registry live, so nothing
  else changes. Add a test: register a fake module, call it through the dispatcher from an installed
  pack (on by default), switch it off in the policy and see it denied, see it in the prompt,
  unregister, call fails with CAPABILITY_UNKNOWN.
- Packs do not declare capabilities (a legacy `capabilities` key is ignored with a warning), so
  there is nothing to validate against the registry at install; a plugin module is simply on for
  every character once registered, function by function, unless switched off under Settings →
  Permissions — including functions a later version of the plugin adds, since an unmentioned key
  in `functionAllow` is allowed.
- A pack's `character.json` `promptFunctions` can name a plugin module or one of its functions.
  Unknown names are not an error: a pack written against a plugin this machine does not have
  simply selects nothing for it.

## Desktop main — `PluginService` (`src/main/plugins/`)

- Plugins dir `<userData>/plugins/<id>/`; registry `<userData>/data/plugins.json`
  (`{ [id]: { enabled: boolean } }`, default enabled after install).
- Startup: for each folder with `plugin.json`: validate manifest → `loadPluginModuleSpecs` →
  import the entry module (`await import(pathToFileURL(main) + '?t=' + Date.now())` for ESM;
  fall back to `createRequire` for CJS) → `activate(host)` → for each module register spec +
  handler with `engine.capabilities.register` (wrap handler errors into `CAPABILITY_FAILED`).
  Any failure marks the plugin `state: 'error'` with the message; other plugins still load.
- `PluginHost` implementation: `log` prefixed with the plugin id; `storage` = JSON file per plugin
  in `<userData>/plugin-data/<id>/storage.json`; `exec` via `child_process.spawn` (no shell, 30 s
  default timeout, 1 MiB output cap); `fetch` via Node fetch with timeout; `notify` via Electron
  Notification; `emitEvent` → `engine.hostEvents.emit({ name: 'custom:<name>', data: { ...data,
  characterRef? } })`.
- IPC `plugins.*` per `IpcApi`; `install` copies a picked folder (validates manifest first,
  refuses id collisions with built-in modules), `remove` disposes + deletes the folder,
  `setEnabled`, `reload` (dispose → re-import → re-register), `openFolder` (`shell.openPath`).
- Tests: manifest → specs → registration with a fake engine, host `storage` round trip,
  error isolation (a throwing plugin does not block others), reload replaces handlers.

## Renderer

Settings → **Plugins** tab: list (name, version, author, modules with permission badges,
enabled toggle, state pill, error text), "Install from folder…" with a trust warning dialog,
"Reload", "Remove" (confirm), "Open plugins folder". The SDK reference view already renders the
live registry, so plugin modules show up there.

## Example + docs

- `examples/plugins/clock/`: module `clock` (trusted): `now(): { iso, local, weekday }`,
  `countdown(seconds, label?)` which stores the target in `host.storage`, uses `setTimeout` and
  then `host.emitEvent('countdown', { label })`; entry as ESM with JSDoc types referencing
  `@rp/shared`'s `PluginHost` (`/** @param {import('@rp/shared').PluginHost} host */`).
- `docs/plugins.md`: author guide — layout, manifest fields, writing typings/docs the model
  reads well, permission levels, the host API, events, testing with "Reload", distribution
  (zip the folder), trust warning.
