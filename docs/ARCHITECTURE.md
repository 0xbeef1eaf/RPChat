# Architecture

**rp-code** is a desktop LLM roleplay chat application. Characters are not just
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
- **Shareable packs**: a directory or `.rppack` zip with a manifest, one or
  more characters, media assets and optional pre-written behaviour scripts.
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
5 + React 19, fflate for zip. No native Node modules anywhere (the sandbox is
wasm), so no `electron-rebuild` step is needed.

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
│                 system (shell/fs, pack-level grant)                    │
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
scope, plus `console`. `return` sends a JSON value back to the model.

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
| `llm`    | trusted    | `ask(prompt, opts?)` (private side completion), `wake(prompt, { delayMs? })` (self-triggered turn now or later; rate-limited by autonomy settings) |
| `memory` | trusted    | `remember(text, opts?)`, `recall(query, limit?)`, `recent(limit?)`, `update(id, patch)`, `forget(id)` — long-term memory, also consolidated automatically (see `docs/spec/memory.md`) |
| `display`| trusted    | `monitors()`, `backend()` — read-only screen/backend info for placement decisions   |
| `media`  | pack       | `showImage(asset, opts?)`, `playVideo(asset, opts?)`, `playAudio(asset, opts?)`, `update(id, changes)`, `close(id)`, `closeAll()`, `list()`; overlay options: monitor, position or x/y, layer (background/bottom/top/overlay), opacity, clickThrough, width/height |
| `ui`     | pack       | `notify(title, body?)`, `confirm(question)`, `choose(question, options[])`, `ask(question, opts?)` (free text), `pickFile(opts?)`, `pickFolder(opts?)` (native pickers) |
| `wallpaper` | pack    | `set(asset, { monitor? })`, `restore()`, `current()` — via the user's wallpaper command template |
| `browser`| pack       | `open(url, { newWindow? })` — via the user's browser command template               |
| `input`  | pack       | `lock(durationMs, { reason? })`, `unlock()`, `status()`, `type`, `key`, `click`, `moveMouse` — via the user's command templates, duration capped |
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
   message wrapped in `<action_result>`), and the model is called again.
5. The loop ends when the model produces a message with no actions, or after
   `maxActionRounds` (default 4), or on abort. `sdk.chat.say()` output is
   appended to the transcript as assistant text immediately, so a character can
   speak while acting.

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
3. **Pack context** – pack name/description, list of assets grouped by kind
   (so the model knows which files exist), granted capabilities, denied ones.
4. **SDK reference** – generated `sdk.d.ts` + module docs, filtered to granted
   modules (denied modules are listed by name with "not available").
5. **Memory** – current character `state` (JSON, truncated), active timers.
6. **Session notes** – time, locale, user display name, any user-configured
   scenario text.

Messages: the transcript, windowed by token budget (approximate 4 chars/token
estimator in `@rp/llm`). Tool use/result pairs are kept intact when windowing.

---

## 7. Security model

Threat model: pack authors and the LLM are **untrusted**. The user is trusted.

- **Isolation**: QuickJS in WebAssembly. No `require`, no `fetch`, no
  filesystem, no network, no timers except via `sdk`. Each action run gets a
  fresh context; the runtime is reused for speed.
- **Limits** (`RunLimits`): wall-clock timeout (default 10 s), interrupt-based
  CPU budget, memory limit (default 64 MB), max host calls per run (default
  50), max log bytes, max result bytes.
- **Permission levels**
  - `trusted` – always available (no side effects outside the app's own data).
  - `pack` – requested in `pack.json` `capabilities`; the user grants per pack at
    install time and can revoke in settings.
  - `prompt` – additionally requires a per-call confirmation dialog. Supported by
    the engine for third-party modules, but **no built-in module uses it**: the
    product decision is that a granted character acts without interruptions, so
    the user's control is the grant itself, the global policy, optional allowlists
    (web hosts, launchable apps) and the audit log.
- **Paths**: pack assets are addressed by relative path, validated against the
  pack root (normalised, no `..`, no absolute, no symlink escape). Served to the
  renderer over `rp-asset://<packId>/<relative>` only.
- **Audit**: every capability call (allowed or denied) is an `AuditEntry` in
  storage, visible in the UI's action log.
- **Renderer**: context isolation, sandboxed preload, strict CSP, no remote
  content. The media window only receives commands with `rp-asset://` URLs.
- Packs are never executed on install except the optional `onInstall` hook,
  which runs only after the user accepted the capability grants.

---

## 8. Packs

Directory layout (also the layout inside an `.rppack`, which is a zip):

```
my-pack/
├── pack.json
├── README.md                     (optional)
├── characters/
│   └── luna/
│       ├── character.json
│       ├── persona.md
│       ├── avatar.png
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
  "characters": ["characters/luna"],  // directories containing character.json
  "capabilities": ["media", "ui"],     // pack-level requests; trusted ones are implicit
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
  "capabilities": ["system"],          // extra per-character requests (optional)
  "modelHints": { "temperature": 0.9 }
}
```

Installed packs live in `<userData>/packs/<packId>/<version>/`. The pack store
(`InstalledPackRecord`) keeps id, version, root path, grant state and install
time. `@rp/pack` exposes `loadPack(dir)`, `validatePack`, `packDirectory(dir)
→ .rppack`, `extractPack(file, destDir)`, and `indexAssets(pack)` (kind by
extension: image/video/audio/text/other).

---

## 9. Storage

Plain JSON files under `<userData>/data/`, one file per aggregate, written
atomically (write temp + rename). Interface `Storage` in `@rp/shared/storage`;
`@rp/core` provides `FileStorage` and `MemoryStorage`. Aggregates: settings,
installed packs, permission grants, sessions (index + one file of messages per
session), character state (per pack+character), timers, audit log (append-only
JSONL, size-capped).

---

## 10. Renderer UI (v1 scope)

- **Chat view**: session list sidebar, message stream with streaming text,
  collapsible action cards (purpose, code, result/logs), abort button,
  character status line.
- **Packs view**: installed packs, install from `.rppack`/folder, capability
  grants with toggles, uninstall, pack README.
- **Settings**: LLM providers (add/edit: type, base URL, API key, model),
  default model, action limits, appearance.
- **Permission prompt** modal for `prompt`-level calls (allow once / allow for
  session / deny).
- **Action log** view (audit entries).
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
this keeps the TypeScript engine in-process. Wallpaper, browser and input
lock run user-editable **command templates** (argv-tokenised, placeholder
substituted, no shell by default). See `docs/spec/overlay.md`.

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
