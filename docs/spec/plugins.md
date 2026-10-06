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

## Remote media sources

A plugin may also (or only) provide **media sources**: places outside the pack where characters find
pictures, video and sound. Contracts: `PluginMediaSourceManifest`, `MediaSourceProvider`,
`MediaSourceQuery`, `RemoteMediaItem`, `RemoteMediaLocation`, `MediaSourceInfo` in
`@rp/shared/plugin.ts`; `REMOTE_ASSET_PREFIX`, `parseRemoteAssetPath` in `@rp/shared/media.ts`.

- Manifest: `mediaSources: [{ id, title, description, kinds }]` (`id` matches
  `MEDIA_SOURCE_ID_PATTERN`, unique per plugin; `kinds` ⊆ image/video/audio, non-empty).
  `modules` defaults to `[]`; a plugin must declare at least one module or source.
- `activate(host)` returns `mediaSources: { [id]: { search(query, ctx), fetch(itemId, ctx) } }`;
  `handlers` is required only when the plugin declares modules. A declared source without a
  provider puts the plugin in `error`.
- Core `MediaSourceService` (`engine.mediaSources`): `register(info, provider)` with
  `info.id = <pluginId>/<id>`, `unregister(id)`, `list()`, `search(source, query, ctx)`,
  `locate(path, ctx)`. It normalises the query (text ≤ 500 chars, ≤ 20 lower-cased tags, `kind`
  among the source's kinds, `limit` 1..50 default 20, `page` ≥ 1), bounds both provider calls to
  30 s (`CAPABILITY_FAILED`), drops malformed items, and turns the rest into `AssetRef`s
  `{ source: 'remote', path: '<sourceId>/<itemId>', kind, mime (or '<kind>/*'), bytes (or 0), tags,
  description? }`. The last 2000 results are remembered so the dispatcher can type a
  `remote:<path>` string; a whole `source: 'remote'` ref is taken at its own `kind` after that.
  `locate` accepts only `{ url: http(s), headers?: Record<string, string> }` or
  `{ file: <absolute path> }`.
- `sdk.mediaSources` (`list()`, `search(source, query?)`, permission `pack`) is not a standard
  module: core puts `mediaSourcesModule(sources)` in the registry while at least one source is
  registered and re-registers it on every change, since its typings name the sources. The handler
  is always attached; the registry is what gates calls. `mediaSources` is reserved — a plugin
  module may not use the id.
- Dispatcher: `media.showImage/playVideo/playAudio/overlay` take remote refs (or `remote:<path>`)
  and hand them to the host as `remote:<path>`; the kind check uses the kind the search reported.
  `wallpaper.set` refuses them. A ref of a source that is gone is `NOT_FOUND`.
- Desktop `RemoteMediaCache` (`capabilities/remote-media.ts`): `MediaManager.locate` asks it for
  `remote:` assets. It calls `engine.mediaSources.locate`, downloads (≤ 1 GB, 5 min, one download
  per item at a time) or copies the file into `<userData>/remote-media/<sha256(path)[:32]>.<ext>`,
  served as the root of `REMOTE_MEDIA_PACK_ID` (`app.rpchat.remote`). The extension comes from the
  item's MIME, the response's `Content-Type` or the URL, and must be a known image/video/audio
  type; a download of another kind than the search reported is refused. The cache keeps 2 GB,
  least recently shown first out. `overlay()` reads its kind off the located file.
- `PluginInfo.mediaSources` lists them; Settings → Plugins shows them under the plugin.
- Example: `examples/plugins/wikimedia` (Wikimedia Commons, images, no key).

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
