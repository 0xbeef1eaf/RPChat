# Architecture

**rpchat** is a desktop LLM roleplay chat application. Characters are not just
personas: each turn, the character's LLM may *write TypeScript* against a
documented SDK, and the app executes that code in a sandbox to act on the host
PC (show a picture, play a video or sound, schedule a follow-up, remember
something, notify the user, ...). Characters, their behaviours and their media
are distributed as shareable **packs**.

This document is the source of truth for the design. Package-level specs live
in `docs/spec/*.md`. The cross-package TypeScript contracts live in
`packages/shared` and are authoritative where this prose is vague.

---

## 1. Goals and non-goals

Goals

- Chat with LLM-driven characters that can act on the PC by writing code.
- Actions go through one **SDK** whose surface is defined in TypeScript with
  TSDoc, and that same definition is what the LLM is shown. One source of
  truth for humans, the compiler, the sandbox and the model.
- The SDK is **modular and extensible**: a capability module bundles its
  typings, its docs, its permission level and (on the host) its implementation.
  Adding a capability never touches the engine or the sandbox.
- **Shareable packs**: a directory or `.rppack` zip with a manifest, exactly
  one character, media assets, optional pre-written behaviour scripts and the
  character's function library (`lib/*.ts`).
- **Safety by construction**: character code runs in a WebAssembly QuickJS
  isolate with no ambient authority. It can only reach the host through
  capability calls that are permission-checked, logged and resource-limited.
- Provider-agnostic LLM access (Anthropic, OpenAI-compatible incl. local
  servers such as Ollama / LM Studio).

Non-goals (v1)

- Cloud sync, accounts, marketplace backend. Sharing is file-based.
- Mobile. The desktop app is Electron (Windows, macOS, Linux).
- Voice input / TTS (the SDK's `media.playAudio` is enough for packs that ship
  audio; TTS can be a later capability module).

---

## 2. Repository layout

```
.
├── apps/
│   └── desktop/            @rp/desktop   Electron app (main, preload, renderer, media window)
├── packages/
│   ├── shared/             @rp/shared    Cross-package contracts: ids, capability/action protocol,
│   │                                     pack & character types, LLM types, storage, IPC contract
│   ├── sdk/                @rp/sdk       Capability module registry, the standard modules, and the
│   │                                     generator that emits `sdk.d.ts` + markdown docs for the LLM
│   ├── pack/               @rp/pack      Pack manifest schema (zod), loader, validator, .rppack zip
│   ├── llm/                @rp/llm       Provider abstraction (Anthropic, OpenAI-compatible, mock)
│   ├── sandbox/            @rp/sandbox   QuickJS (wasm) code runner, TS transpile, host bridge, limits
│   └── core/               @rp/core      Chat engine: sessions, prompt builder, action loop,
│                                         behaviours/timers, permissions, storage, audit log
├── apps/
│   └── browser-extension/  @rp/browser-extension  Manifest V3 extension (Chromium-based browsers) bridging tabs to the app
├── native/
│   └── overlay-wlr/        rp-overlay-wlr  Rust wlr-layer-shell overlay helper (Hyprland & co.)
├── examples/packs/         Sample packs used by tests and as user documentation
└── docs/                   This document + per-package specs
```

Dependency direction (no cycles):

```
shared  <-  sdk  <-  sandbox
shared  <-  pack
shared  <-  llm
shared, sdk, pack, llm  <-  core          (core depends on the CodeRunner *interface*, not on sandbox)
everything  <-  desktop                   (desktop wires core + sandbox + host capability handlers)
```

Tooling: pnpm workspaces, TypeScript 5.9 (ESM, `NodeNext`), vitest 3, zod 4,
esbuild (transpile only), quickjs-emscripten 0.32, Electron 44 + electron-vite
5 + React 19, fflate for zip, Monaco 0.56 for the app's code boxes (loaded on
demand, its language workers served as `file://` chunks — see
`apps/desktop/src/renderer/lib/monaco.ts`). No native Node modules anywhere
(the sandbox is wasm), so no `electron-rebuild` step is needed.

Every package: `src/index.ts` public entry, `pnpm build` = `tsc -p tsconfig.json`
to `dist/`, `pnpm test` = vitest, `pnpm typecheck` = `tsc --noEmit`.

---

## 3. Runtime topology (Electron)

```
┌──────────────────────── Electron main process ────────────────────────┐
│  @rp/core Engine                                                      │
│    ├─ SessionManager / PromptBuilder / ActionLoop / BehaviourRunner   │
│    ├─ PermissionService  ── asks renderer via IPC for 'prompt' caps   │
│    ├─ FileStorage (userData/…json)                                    │
│    └─ CapabilityDispatcher ── routes sdk.<module>.<method> calls to   │
│                                host CapabilityHandlers (apps/desktop) │
│  @rp/sandbox QuickJsRunner  (wasm isolate per action run)             │
│  @rp/llm providers                                                    │
│  Host handlers: media (opens MediaWindow), ui (notifications), timers,│
│                 system (shell/fs)                                      │
│  rp-asset:// protocol: serves files from installed pack roots only    │
└───────────┬──────────────────────────────┬────────────────────────────┘
            │ contextBridge IPC (IpcApi)   │ IPC media commands
┌───────────▼──────────────┐   ┌───────────▼───────────────────┐
│ Renderer (React)         │   │ MediaWindow(s) (React, small) │
│ chat, packs, settings,   │   │ image / video / audio player  │
│ permissions, action log  │   │ frameless, optional on-top    │
└──────────────────────────┘   └───────────────────────────────┘
```

All model calls, code execution and host actions happen in the **main**
process. The renderer is a thin UI over the typed `IpcApi` in
`@rp/shared/ipc`. The preload script exposes `window.rp: IpcApi` via
`contextBridge` with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`.

---

## 4. The SDK

### 4.1 What character code looks like

The LLM writes the **body of an async function**. A global `sdk` object is in
scope, plus `console` and `lib` (the character's own function library, which is
also `sdk.lib`). `return` sends a JSON value back to the model.

```ts
// Luna decides to show a picture and set a reminder
const pic = sdk.pack.asset("images/luna-smile.png");
await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right" });
await sdk.timers.schedule(15 * 60 * 1000, { reason: "check whether they took a break" });
await sdk.state.set("lastShownImage", "images/luna-smile.png");
return { shown: true };
```

### 4.2 Capability modules

The SDK is the union of **capability modules**. A module is a
`CapabilityModuleSpec` (see `@rp/shared/capability`):

| field        | purpose                                                                     |
|--------------|-----------------------------------------------------------------------------|
| `id`         | property name on `sdk` (`media`, `chat`, ...)                                |
| `version`    | semver of the module surface                                                 |
| `permission` | `trusted` \| `pack` \| `prompt` (see §7)                                     |
| `typings`    | TypeScript source of `interface <Name>Api { ... }` with full TSDoc            |
| `apiTypeName`| the interface name declared in `typings`                                     |
| `docs`       | markdown guidance for the LLM (when to use it, examples, pitfalls)            |
| `methods`    | `{ [name]: { description, permission?: override, dangerous?: boolean } }`    |

`@rp/sdk` owns a `CapabilityRegistry`. `generateSdkTypings(registry)` emits:

```ts
declare const sdk: Sdk;
interface Sdk {
  /** ... */ chat: ChatApi;
  /** ... */ media: MediaApi;
  // one property per registered module
}
interface ChatApi { ... }   // verbatim module typings
...
```

`generateSdkDocs(registry)` emits the markdown that the prompt builder injects.
`describeSurface(registry)` returns the `SdkSurface` (module → method names)
the sandbox uses to build the `sdk` proxy inside the isolate. Because all three
derive from the same specs, they cannot drift.

Standard modules (v1), all in `@rp/sdk/modules`:

| module   | permission | methods (summary)                                                                  |
|----------|------------|------------------------------------------------------------------------------------|
| `chat`   | trusted    | `say(text)`, `emote(text)`, `history(limit)`, `setStatus(text)`                    |
| `log`    | trusted    | `debug/info/warn/error(...args)` → captured into the action result & audit log      |
| `state`  | trusted    | `get/set/delete/keys` (character-scoped, persistent), `session.get/set/delete/keys` |
| `pack`   | trusted    | `asset(path)`, `listAssets(prefix?)`, `readText(path)`, `info()`                    |
| `timers` | trusted    | `schedule(delayMs, payload, opts?)`, `runLater(delayMs, code, opts?)` (setTimeout-style stored code, optionally repeating), `cancel(id)`, `list()` |
| `lib`    | trusted    | not a namespace of its own: `sdk.lib` **is** the `lib` global (the character's own function library, one file per function in the pack — `characters/<id>/lib/<name>.ts`; authors can ship them), so `sdk.lib.<name>(...)` and `lib.<name>(...)` are the same call. Only `register(name, fn, opts?)` and `unregister(name)` cross to the host; the rest is the prelude (`CodeRunRequest.prelude`) |
| `llm`    | trusted    | `ask(prompt, opts?)` (private side completion), `wake(prompt, { delayMs? })` (self-triggered turn now or later; rate-limited by autonomy settings) |
| `memory` | trusted    | `remember(text, opts?)`, `recall(query, limit?)`, `recent(limit?)`, `update(id, patch)`, `forget(id)` — long-term memory, also consolidated automatically (see `docs/spec/memory.md`) |
| `display`| trusted    | `monitors()`, `backend()` — read-only screen/backend info for placement decisions   |
| `media`  | pack       | `showImage(asset, opts?)`, `playVideo(asset, opts?)`, `playAudio(asset, opts?)`, `overlay(asset, opts?)` (image/video washed over whole screens, always click-through), `update(id, changes)`, `close(id)`, `closeAll()`, `list()`; overlay options: monitor, position or x/y, layer (background/bottom/top/overlay), opacity, clickThrough, width/height. `asset` is a pack asset or a file in the character's own home directory (`home:<path>`, or a `source: 'home'` AssetRef such as an `sdk.webcam` capture) |
| `ui`     | pack       | `notify(title, body?, opts?)` (urgency low/normal/critical), `confirm(question)`, `choose(question, options[])`, `ask(question, opts?)` (free text), `pickFile(opts?)`, `pickFolder(opts?)` (native pickers) |
| `wallpaper` | pack    | `set(asset, { monitor? })`, `restore()`, `current()` — via the user's wallpaper command template |
| `browser`| pack       | `open(url, { newWindow? })` via the user's browser command; with the browser extension connected also `status`, `tabs`, `openTab`, `activate`, `close`, `navigate`, `back/forward/reload`, `read`, `query`, `click`, `type`, `scroll`, `screenshot`, `find` (docs/browser-extension.md) |
| `input`  | pack       | `lock(durationMs, { reason?, devices? })`, `unlock()`, `status()`, `type`, `key`, `click`, `moveMouse` — daemon-only (`rpchatd`, Linux), duration capped; `CAPABILITY_FAILED` without the daemon |
| `webcam` | pack       | `takeImage()`, `takeVideo(seconds)` — via the user's camera command templates; the capture is saved under `webcam/` in the character home and returned as a `source: 'home'` AssetRef, which `sdk.media` can show |
| `crypto` | pack       | `encrypt(path)`, `decrypt(path)` — one of the user's own files, in place, under an app-managed AES-256-GCM key; refuses anything outside the home directory or that looks like a system/session file, and logs every encryption so it stays recoverable (docs/spec/system.md) |
| `system` | pack       | `openExternal(url)`, `exec(command, args?)`, `readFile(path)`, `writeFile(path, text)`, `clipboardWrite(text)`, `clipboardRead()` |

Adding a module = write a spec (typings+docs+methods) and a host handler,
register both. Third-party modules can later be shipped by packs or plugins;
the registry already supports registering at runtime.

### 4.3 Wire protocol between sandbox and host

Inside the isolate, `sdk.media.showImage(a, b)` becomes
`__rp_host_call("media", "showImage", JSON.stringify([a, b]))`, an
**asyncified** host function. The host side receives a `CapabilityCall`:

```ts
{ callId, module, method, args: unknown[], context: ActionContext }
```

and returns `CapabilityResult = { ok: true, value } | { ok: false, error }`.
Args and results must be JSON-serialisable. Handles (media item ids, timer ids)
are plain strings. The dispatcher (in core) checks permissions, enforces
per-run call budgets, writes the audit log, then invokes the host handler.

---

## 5. Action protocol (LLM ⇄ engine)

1. The prompt builder assembles the system prompt (§6).
2. The engine calls the provider with the tool `run_action`:
   ```json
   { "name": "run_action",
     "input_schema": { "type": "object",
        "properties": { "purpose": {"type":"string"}, "code": {"type":"string"} },
        "required": ["purpose","code"] } }
   ```
   If the provider/model cannot do tool calls, the fallback is a fenced block
   whose info string is `action` (```` ```action ````). The engine extracts
   these from assistant text and treats them identically.
3. For each action the engine runs the code in the sandbox and produces an
   `ActionResult` (`ok`, `returnValue`, `error`, `logs[]`, `calls[]`,
   `durationMs`). Actions from one assistant message run sequentially.
4. The result is fed back as a tool result (or, in fallback mode, as a user
   message wrapped in `<action_result>`), and the model is called again. Every
   failure goes back with a `fix` line saying how to correct that kind of
   failure, and an sdk call that failed without ending the run — one the code
   caught, or never awaited — is listed under `failedCalls`, so catching a
   failure cannot hide it from the character.
5. The loop ends when the model produces a message with no actions, or after
   `maxActionRounds` (default 4), or on abort. A round that ends in a failure a
   rewrite could fix buys up to `maxActionRepairs` (default 2) more rounds, so
   the character gets to act on the `fix` it was just handed instead of being
   told to stop acting; failures a rewrite cannot fix (a permission the user
   switched off, a command they have not configured) buy nothing.
   `sdk.chat.emote()` output is appended to the transcript as assistant text
   immediately, so a character can speak while acting.

The actions of one message run in order, but a turn does not own the runtime.
The character's **background code** — event handlers, `code` timers, `onTimer`
behaviours — runs off the session's turn queue and alongside it, so an event
does not have to wait for the reply it arrived in the middle of (`@rp/sandbox`
holds up to `maxConcurrentRuns` isolates open at once; `ChatService` keeps a
background queue next to the turn queue). Two runs can therefore interleave
their `sdk.state` writes: a read-modify-write split across a handler and a turn
can lose an update. Assistant text a background run wrote carries no `turnId`,
which is how a retry replaces the reply without taking back what a timer said
in the middle of it.

Everything the user sees is a `ChatMessage`. Action runs are attached to the
assistant message (`message.actions[]`) and shown collapsed in the UI.

### Behaviours (pre-written pack code)

A character may ship scripts bound to hooks: `onInstall`, `onSessionStart`,
`onUserMessage`, `onTimer`, `onSessionEnd`. They run in the same sandbox with
the same permissions, before/after the LLM turn. `onUserMessage` may return
`{ skipLlm: true }` to fully script a reply. `onTimer` runs when a scheduled
timer fires; if no `onTimer` script exists the engine instead wakes the LLM
with a system-authored message describing the timer payload.

---

## 6. Prompt construction

System prompt sections, in order (each a stable `<section>` block):

1. **Engine rules** – you are `<name>`, stay in character, how and when to act,
   one action per intention, keep code short, never loop forever, results come
   back to you, do not narrate what code you are running unless asked.
2. **Character persona** – `persona.md` verbatim, plus example dialogue.
3. **SDK reference** – the abridged SDK index (`generateSdkIndex`): general
   rules, then per available module one entry per method (signature, TSDoc summary,
   every @param, @returns and the first @example, generated from the typings),
   its helper types on one line each and one example, then only the shared
   types those modules reference. Functions the user switched off under
   Settings → Permissions are not mentioned, and neither are the ones the pack
   author left out of `character.json`'s `promptFunctions` — that key trims the
   reference without trimming what the code may call (§8). The full `sdk.d.ts` +
   docs of one module are available on demand through `sdk.help.module(id)`,
   which lists the same selection. With every module on the section is
   about 8k tokens (the full reference is about 23k, which used to crowd the
   transcript out of the default budget).
4. **Memory** – current character `state` (JSON, truncated), active timers.
5. **Session notes** – time, locale, user display name, any user-configured
   scenario text.

Messages: the transcript, windowed by token budget (approximate 4 chars/token
estimator in `@rp/llm`). Tool use/result pairs are kept intact when windowing.
Replayed action code is stripped of its comments first (`stripCodeComments`):
they are notes the model wrote to itself in the moment, they are never read
back, and the window would otherwise pay for them on every later turn. The
stored `ActionRecord.code` — what the user sees and what ran — keeps them.

---

## 7. Security model

Threat model: pack authors and the LLM are **untrusted**. The user is trusted.

- **Isolation**: QuickJS in WebAssembly. No `require`, no `fetch`, no
  filesystem, no network, no timers except via `sdk`. Each action run gets a
  fresh context; the runtime is reused for speed.
- **Limits** (`RunLimits`): wall-clock timeout (default 10 s), interrupt-based
  CPU budget, memory limit (default 64 MB), max host calls per run (default
  50), max log bytes, max result bytes.
- **Permissions** — app-wide and **per function**. The single control is
  Settings → Permissions (`settings.permissions.functionAllow`): a map whose keys
  are a module id (`avatar`) or one function of it (`avatar.show`), and whose
  values say whether every installed character may call it. A function entry wins
  over its module's; anything the map does not mention is allowed, so a function
  added by a later version or by a plugin arrives switched on. A switched-off
  function is not on the sandbox `sdk` at all and is not mentioned in the prompt.
  `sdk.lib` — the character's own saved functions — is the one module outside all
  of this: always available, never listed (`@rp/shared/permissions.ts`). Packs
  neither request nor are granted anything; a `capabilities` key in an old
  `pack.json` / `character.json` is accepted, ignored and reported as a loader
  warning.
- **Permission levels** — how much ceremony a call needs, not whether it is
  allowed:
  - `trusted` – effects stay inside the app's own data; never confirmed.
  - `pack` – reaches outside the app; used without asking.
  - `prompt` – as `pack`, and additionally requires a per-call confirmation
    dialog. Supported by the engine for third-party modules, but **no built-in
    module uses it**: the product decision is that a character acts without
    interruptions, so the user's control is the app-wide policy, optional
    allowlists (web hosts, launchable apps) and the audit log.
- **Paths**: pack assets are addressed by relative path, validated against the
  pack root (normalised, no `..`, no absolute, no symlink escape). Served to the
  renderer over `rp-asset://<packId>/<relative>` only. `sdk.media` also takes a
  file from the character's own home directory (`home:<relative>`), validated
  against that home with the same guard and served under a host of its own,
  `rp-asset://home-<12 hex>/<relative>`, which the dispatcher registers when a
  call names it (`HomeAssetRoots`). No other path reaches a media window.
- **Audit**: every capability call (allowed or denied) is an `AuditEntry` in
  storage, visible in the UI's action log.
- **Renderer**: context isolation, sandboxed preload, strict CSP, no remote
  content. The media window only receives commands with `rp-asset://` URLs.
- Packs are never executed on install except the optional `onInstall` hook,
  which runs once, right after the install.

---

## 8. Packs

A pack has **exactly one character**. Directory layout (also the layout inside
an `.rppack`, which is a zip):

```
my-pack/
├── pack.json
├── README.md                     (optional)
├── characters/
│   └── luna/
│       ├── character.json
│       ├── persona.md
│       ├── avatar.png
│       ├── lib/                  (optional) the character's `lib` functions, one per file
│       │   └── cheer.ts          `// <description>` + one function expression (or a module exporting one)
│       └── scripts/
│           ├── on-session-start.ts
│           └── on-timer.ts
└── media/
    ├── images/…  video/…  audio/…
```

`pack.json` (`PackManifest`):

```jsonc
{
  "formatVersion": 1,
  "id": "com.example.luna",          // reverse-DNS, [a-z0-9.-]
  "name": "Luna",
  "version": "1.0.0",
  "description": "…",
  "author": { "name": "…", "url": "…" },
  "license": "CC-BY-4.0",
  "tags": ["companion"],
  "characters": ["characters/luna"],  // the one directory containing character.json (exactly one entry)
  "mediaRoot": "media",
  "minAppVersion": "0.1.0"
}
```

`character.json` (`CharacterDefinition`):

```jsonc
{
  "id": "luna",
  "name": "Luna",
  "tagline": "…",
  "avatar": "avatar.png",
  "persona": "persona.md",
  "greeting": "…",                   // first assistant message in a new session
  "exampleDialogue": [{ "user": "…", "character": "…" }],
  "behaviours": { "onSessionStart": "scripts/on-session-start.ts" },
  "modelHints": { "temperature": 0.9 }
}
```

Neither file declares permissions: what a character may do on the PC is set
app-wide under Settings → Permissions (§7). A `capabilities` key from older
packs is ignored with the warning `pack.json: "capabilities" is ignored;
permissions are set in the app under Settings → Permissions`.

`character.json` may carry `promptFunctions`: the module ids and `module.function`
names the character's **prompt** describes (Pack editor → Character → "SDK in the
prompt"). It is an editorial choice about prompt size and focus, never a
permission — the code keeps every function the user allows, so a pack can leave
`sdk.wallpaper` out of the character's reference and still set the wallpaper from
one of its own `lib` functions. The prompt shows this selection intersected with
the user's permissions, and `sdk.lib` is always in it. Omit the key for
"everything the user allows"; an empty array means "nothing but `sdk.lib`".

Installed packs live in `<userData>/packs/<packId>/<version>/`. The pack store
(`InstalledPackRecord`) keeps id, version, root path and install time. The app owns that folder: `lib.register` writes the character's own
functions into `characters/<id>/lib/` of the installed copy (and `unregister`
deletes them), so they persist across sessions and restarts; reinstalling or
upgrading the pack replaces the folder and therefore those functions, unless
the author shipped them. `@rp/pack` exposes `loadPack(dir)`, `validatePack`, `packDirectory(dir)
→ .rppack`, `extractPack(file, destDir)`, and `indexAssets(pack)` (kind by
extension: image/video/audio/text/other).

---

## 9. Storage

Plain JSON files under `<userData>/data/`, one file per aggregate, written
atomically (write temp + rename). Interface `Storage` in `@rp/shared/storage`;
`@rp/core` provides `FileStorage` and `MemoryStorage`. Aggregates: settings
(including the app-wide permission policy), installed packs, sessions (index +
one file of messages per session), character state (per pack+character),
timers, audit log (append-only JSONL, size-capped). A `grants.json` left by a
version with per-pack grants is ignored and deleted on start.

---

## 10. Renderer UI (v1 scope)

- **Chat view**: session list sidebar, message stream with streaming text,
  collapsible action cards (purpose, code, result/logs), abort button, retry
  (discard the newest reply and generate another from the same history),
  character status line, and a text size the user can zoom (`settings.chatZoom`;
  the reading column widens with the text).
- **Packs view**: installed packs, install from `.rppack`/folder, uninstall,
  pack README, and a link to Settings → Permissions (nothing is set per pack).
- **Settings**: LLM providers (add/edit: type, base URL, API key, model),
  default model, action limits, appearance, and **Permissions** — the one place
  where capability modules are switched on or off for every character.
- **Prompt window**: every pending question — a `prompt`-level permission request
  (allow once / allow for session / deny) and a character's `sdk.ui` question —
  opens its own small window, centred, above other windows and focused, so it is
  answered where the user is looking rather than in a chat window they may not
  have open. Closing the window dismisses the question (deny / no answer). The
  in-app modals remain as the fallback when no window can be opened.
- **Action log** view (audit entries).
- **Sandbox** view: type a script and run it as an installed character, exactly
  as that character's own actions run (same sandbox, surface, permissions,
  limits and session); shows the value, error, console and SDK calls.
- **Pack editor**: projects are pack folders (workspace or any folder); forms for
  manifest, the pack's character, its function library (Scripts), media tags and
  README with live validation, export and install-to-app. See `docs/spec/editor.md`.
- **Media window**: separate frameless BrowserWindow that renders one or many
  media items (image, video, audio) driven by IPC commands.

---

## 10a. Display backends and external commands

Overlays are created and controlled by a `DisplayBackend` that owns their
lifecycle. `electron` is the generic backend (BrowserWindows). `hyprland` uses
a native Rust helper (`native/overlay-wlr`, GTK3 + gtk-layer-shell + WebKitGTK)
that renders the same media page as a real wlr-layer-shell surface, with a
Hyprland-IPC emulation fallback when the helper is unavailable. Future
backends (KDE, GNOME, Windows, macOS) implement the same interface. The app
shell stays Electron: a native layer-shell client is required either way, and
this keeps the TypeScript engine in-process. Wallpaper and browser run
user-editable **command templates** (argv-tokenised, placeholder substituted,
no shell by default); input locking and injection go through the `rpchatd`
system daemon only (`docs/system-integration.md`). See `docs/spec/overlay.md`.

## 11. Extending the system

- New capability: add a `CapabilityModuleSpec` in `@rp/sdk/modules`, a host
  `CapabilityHandler` in `apps/desktop/src/main/capabilities`, register both.
  Types, docs and sandbox proxy update automatically.
- New LLM provider: implement `LlmProvider` in `@rp/llm/providers`.
- New behaviour hook: add to `BehaviourHook` union in shared, call from engine.
- New storage backend: implement `Storage`.

---

## 12. Build order for implementation

Wave 1 (parallel): `@rp/sdk`, `@rp/pack`, `@rp/llm`
Wave 2 (parallel): `@rp/sandbox` (needs sdk), `@rp/core` (needs sdk, pack, llm; uses a fake `CodeRunner` in tests)
Wave 3 (parallel): desktop main+preload+host capabilities, desktop renderer
Wave 4: integration, end-to-end run, sample packs, README.
