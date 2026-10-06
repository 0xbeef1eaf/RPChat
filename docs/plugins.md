# Writing SDK plugins

A plugin adds capability modules to the SDK that characters program against, remote media sources
characters can search and show pictures, video and sound from, or both. Once installed, a plugin
module is indistinguishable from a built-in one: it appears in the generated `sdk.d.ts` and in the
prompt docs, every character may use it unless the user switches it off under Settings →
Permissions, and every call is audited. A media source is reached through the built-in
`sdk.mediaSources` module instead (see [Remote media sources](#remote-media-sources)).

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
| `modules[]` | one entry per SDK module the plugin provides (below); may be omitted when the plugin has `mediaSources` |
| `mediaSources[]` | one entry per remote media source the plugin provides (see [Remote media sources](#remote-media-sources)) |

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

## Permission levels

Permissions are app-wide and per function: packs do not declare or request modules (a `capabilities`
key in an old `pack.json` is ignored with a warning). The user switches your module — or any single
function of it — on or off for every character under Settings → Permissions. Your module's level
says how much ceremony a call needs, not whether it is allowed; every function of it is on until the
user says otherwise, including new ones you add in a later version.

- `trusted` — no dialog. Use only for modules with no effect outside the app (reading the time,
  formatting, …).
- `pack` — used without asking, unless the user switches the module or the function off under
  Settings → Permissions.
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

## Remote media sources

A media source is somewhere characters can find media that is not in their pack: a photo library on
the user's NAS, an image board, a stock-media API. Declare each one in `plugin.json`:

```json
"mediaSources": [
  { "id": "albums", "title": "Family photos", "description": "The user's photo albums, 2009 to now; search by place, person or event.", "kinds": ["image", "video"] }
]
```

| field | meaning |
|---|---|
| `id` | `/^[a-z][a-z0-9-]{0,39}$/`, unique in the plugin; characters see `<plugin id>/<id>`, e.g. `com.me.photos/albums` |
| `title` | short name, shown to the user and the model |
| `description` | one line for the model: what is in there and when it is the place to look |
| `kinds` | which of `image`, `video`, `audio` it serves |

and return a provider for it from `activate` under `mediaSources` (a plugin with no modules can
return `handlers: {}` or leave `handlers` out):

```js
export async function activate(host) {
  return {
    mediaSources: {
      albums: {
        async search(query, context) {
          // query: { text?, tags?, kind?, limit (1..50, default 20), page? } — already checked
          const hits = await myApi.search(query.text, query.limit);
          return hits.map((h) => ({ id: h.uuid, kind: 'image', mime: 'image/jpeg', description: h.caption, tags: h.labels }));
        },
        async fetch(itemId, context) {
          return { url: `https://nas.local/api/assets/${itemId}/original`, headers: { 'x-api-key': await host.storage.get('key') } };
          // or, when the plugin downloaded it itself: return { file: '/absolute/path.jpg' };
        },
      },
    },
  };
}
```

- `search` returns items `{ id, kind, mime?, description?, tags?, bytes? }`. `id` is yours — up to
  512 characters, no control characters, slashes allowed — and comes back to `fetch` verbatim.
  Items that are malformed or of a kind the source does not declare are dropped (and logged), and
  the list is cut to the `limit` the character asked for.
- The character gets `AssetRef`s with `source: 'remote'` and `path` `<plugin id>/<id>/<item id>`,
  and passes them to `sdk.media.showImage/playVideo/playAudio/overlay` like a pack asset.
  `sdk.wallpaper` does not take them.
- `fetch` is called when an item is shown, not when it is found, so URLs that expire are fine.
  The app downloads the bytes (only `http`/`https`, up to 1 GB, 5 min) into
  `<userData>/remote-media` and serves them from there; later shows of the item hit that cache
  (2 GB, least recently shown evicted first) without asking you again. The file type comes from
  the item's `mime`, else the response's `Content-Type`, else the URL's extension, and must be a
  picture, video or sound format the app knows.
- Both calls time out after 30 s, and a thrown error reaches the character as
  `CAPABILITY_FAILED` naming your source. Keep credentials in `host.storage`, never in the item id.
- `sdk.mediaSources` exists only while at least one source is registered, and its typings list
  every source with its title, kinds and description, so the model knows where to look without a
  call. Users switch it off (or just `search`) under Settings → Permissions like any module.

`examples/plugins/wikimedia` is a complete source over Wikimedia Commons in about 70 lines.

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
