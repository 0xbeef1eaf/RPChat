# Writing SDK plugins

A plugin adds one or more capability modules to the SDK that characters program against. Once
installed, a plugin module is indistinguishable from a built-in one: it appears in the generated
`sdk.d.ts` and in the prompt docs, packs request it by id, the user's global permission policy and
per-pack grants apply, and every call is audited.

**Trust warning.** A plugin is ordinary JavaScript that runs inside the app's main process with
the same power as the app itself (files, network, processes). Install only plugins you trust; the
app repeats this warning in the install dialog. The example in `examples/plugins/clock` is a good
starting point.

## Layout

```
my-plugin/
├── plugin.json            # manifest: id, version, modules (typings, docs, methods)
├── main.js                # entry module: export function activate(host) { … }
└── modules/
    ├── clock.d.ts         # interface ClockApi { … } — TSDoc on every member
    └── clock.md           # short guidance the model reads
```

Only `plugin.json` and the entry module are required; put typings and docs in files (recommended)
or inline them with `typingsText` / `docsText`.

## `plugin.json`

| field | meaning |
|---|---|
| `id` | reverse-DNS id, e.g. `com.me.clock` (also the folder name once installed) |
| `name`, `version`, `description`, `author { name, url }`, `homepage` | shown in Settings → Plugins |
| `main` | entry module relative to the folder, default `main.js` (ESM or CommonJS) |
| `minAppVersion` | optional |
| `modules[]` | one entry per SDK module the plugin provides (below) |

Each module entry mirrors the app's own `CapabilityModuleSpec`:

| field | meaning |
|---|---|
| `id` | property name on `sdk` — `/^[a-z][a-zA-Z0-9]*$/`, must not be a built-in id (`chat`, `media`, `files`, …) |
| `version` | semver of the module surface |
| `title`, `summary` | one line each; the summary becomes the TSDoc of `sdk.<id>` and is shown in permission dialogs |
| `permission` | `trusted` \| `pack` \| `prompt` (see below) |
| `apiTypeName` | the interface name declared in the typings, e.g. `ClockApi` |
| `typings` / `typingsText` | TypeScript declaring `interface <apiTypeName> { … }` |
| `docs` / `docsText` | markdown guidance for the model (≤ 20 lines, one example) |
| `methods` | `{ [name]: { description, permission?, dangerous? } }` — every method must exist in the typings |

## Writing typings and docs the model reads well

The typings are shown to the model verbatim, so they double as its documentation:

- Declare exactly one `interface <apiTypeName>`; every member returns a `Promise`.
- Put a TSDoc block on the interface (when to use the module) and on every method: what it does,
  `@param` for each argument with ranges and defaults, `@returns` describing the shape, and a
  one-line `@example` using `sdk.<id>.<method>(…)`.
- Arguments and results must be JSON-serialisable. Prefer small objects over positional tuples.
- Do not use `import`/`export`; shared helper types (`Json`, `AssetRef`, `MonitorSelector`,
  `HostEventName`, …) are already declared in the SDK preamble.
- The markdown docs are for judgement, not reference: when to call the module, pitfalls, one short
  example. Keep it under 20 lines.

`methods` must list every method in the typings (and nothing else); the app validates this when the
plugin loads and shows the problems in Settings → Plugins.

## Permission levels and how packs get access

- `trusted` — always available to every character, no dialog. Use only for modules with no effect
  outside the app (reading the time, formatting, …).
- `pack` — a pack must request the module in `pack.json` (`"capabilities": ["clock"]`) and the user
  grants it once per pack (also subject to the global policy in Settings → Permissions).
- `prompt` — like `pack`, plus a confirmation dialog for every call (the user may allow it for the
  session). Use for anything that touches the system or the network. A handler can skip the dialog
  for pre-approved calls by implementing `preauthorize(method, args, ctx)`.

Mark methods with effects outside the app as `dangerous: true`; a method-level `permission` overrides
the module level.

## The entry module and the host API

```js
/** @param {import('@rp/shared').PluginHost} host */
export async function activate(host) {
  return {
    handlers: {
      clock: {
        async invoke(method, args, context) {
          if (method === 'now') return { iso: new Date().toISOString() };
          throw new Error(`unknown method ${method}`);
        },
      },
    },
    dispose() { /* stop timers, close handles */ },
  };
}
```

`activate(host)` (also accepted as `export default`) returns one handler per module id. `invoke`
receives the method name, the JSON arguments and an `ActionContext` (`packId`, `characterId`,
`sessionId`, `packRoot`, `trigger`). Thrown errors reach the character as `CAPABILITY_FAILED` with
your message; throw an `RpError` from `@rp/shared` to pick another code.

`host` gives you:

| member | purpose |
|---|---|
| `pluginId`, `pluginDir`, `dataDir`, `appVersion` | identity and a writable per-plugin directory |
| `log.debug/info/warn/error` | the app log, prefixed with the plugin id |
| `storage.get/set/delete/keys` | JSON key/value store persisted in `dataDir/storage.json` |
| `exec(command, args, { cwd, timeoutMs, env })` | run a program without a shell (30 s default timeout, 1 MiB output cap) |
| `fetch(url, { method, headers, body, timeoutMs })` | HTTP(S) through the app, no allowlist |
| `notify(title, body)` | OS notification |
| `emitEvent(name, data, { characterRef })` | raise `custom:<name>` for `sdk.events.on` subscribers |

## Events

Characters subscribe with `sdk.events.on("custom:<name>", code, opts)`. `host.emitEvent('countdown',
{ label })` reaches every subscriber of `custom:countdown` (or only one character when you pass
`characterRef`). The event `data` always includes `plugin: <your id>`. Document the events your
module raises in the module docs and typings, as the clock example does.

## Developing

1. Put the folder anywhere and use **Settings → Plugins → Install from folder…** (the app copies it
   into `<userData>/plugins/<id>/`), or drop it there directly and restart.
2. Edit the copy in the plugins folder ("Open plugins folder"), then press **Reload**: the app
   disposes the old activation, re-imports `main.js` (cache-busted, so ESM changes are picked up)
   and re-registers the modules. Manifest and typings changes are picked up too.
3. Check **SDK reference** in the app to see exactly what the model sees, and the action log for
   audited calls. Errors show as a red state pill with the message.

A plugin that fails to load never blocks the others: it is listed with state `error`.

## Distributing

Zip the plugin folder (with `plugin.json` at the top level of the folder). Users unzip it and install
it from the folder. Bump `version` on every release; the app replaces a plugin with the same id on
install, keeping its storage.
