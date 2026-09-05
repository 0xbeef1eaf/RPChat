# @rp/desktop — Electron application

Depends on: every package. Built with electron-vite 5 (three entries: `src/main`, `src/preload`, `src/renderer`). React 19, TypeScript. No UI library (hand-written CSS with CSS variables; light/dark via `prefers-color-scheme` and the `theme` setting). No native modules.

## Main process (`src/main/`)

- `index.ts`: app lifecycle; single instance lock; creates `MainWindow`; registers `rp-asset://` protocol (`protocol.handle`) that serves files **only** from installed pack roots (look up pack root via engine.packs; resolve with `@rp/pack` `resolveAssetPath`; correct `Content-Type`; support `Range` requests for video/audio — implement a range-aware response using `fs.createReadStream` → `Response` with `206`).
- `engine.ts`: builds `Engine` with `FileStorage(app.getPath('userData')/data)`, `packsDir`, `createStandardRegistry()`, `QuickJsRunner`, `createProvider`, host handlers below, a `permissionPrompter` that sends `permissions:request` to the main window and awaits `permissions:respond`, `appVersion`.
- `ipc.ts`: implements every `IpcApi` method as `ipcMain.handle('<ns>:<method>', …)`; forwards `engine.events` `chat` → `webContents.send('chat:event', ev)` to the main window; validates `sender` (only our windows).
- `capabilities/media.ts`: `CapabilityHandler` for `media`: manages `MediaWindow` instances (one frameless, transparent, `alwaysOnTop` per settings, positioned per `MediaPosition` on the primary display's work area; reuse one window per position; audio uses a hidden window). Sends `MediaCommand` over IPC with `assetUrl(packId, path)`; tracks `MediaItem`s; `close`, `closeAll`, `list`; auto-close on `ended`/`durationMs`; window close → item removed.
- `capabilities/ui.ts`: `notify` via `Notification`; `confirm`/`choose` → sends a request to the main window's renderer (`ui:prompt` channel, add to IpcApi? — yes: add `ui.onPrompt(listener)` and `ui.respondPrompt(id, answer)` to `@rp/shared/ipc` `IpcApi` and to `IPC_EVENT_CHANNELS` (`uiPrompt: 'ui:prompt'`); extend the shared package accordingly).
- `capabilities/system.ts`: `openExternal` (http/https only via `shell.openExternal`), `exec` (`child_process.spawn`, no shell, timeout default 30 s, output capped 64 KiB), `readFile`/`writeFile` (absolute path required; cap 1 MiB), `clipboardWrite`. All permission gating is done by core's dispatcher (level `prompt`); these handlers just execute.
- `windows.ts`: `createMainWindow`, `createMediaWindow(position)`; `webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }`; CSP header via `session.defaultSession.webRequest.onHeadersReceived` (`default-src 'self' rp-asset:; media-src rp-asset:; img-src rp-asset: data:; style-src 'self' 'unsafe-inline'`).
- `dev-mode`: if env `RP_MOCK_LLM=1`, `providerFactory` returns a `MockProvider` that answers with a scripted `run_action` showing an image then text, so the app can be exercised without an API key.

## Preload (`src/preload/index.ts`)

Builds the `IpcApi` object generically: for each namespace/method a `ipcRenderer.invoke('<ns>:<method>', ...args)`; the `on*` subscriptions use `ipcRenderer.on(channel, (_, payload) => listener(payload))` returning an unsubscribe. Expose with `contextBridge.exposeInMainWorld('rp', api)`.

## Renderer (`src/renderer/`)

Two HTML entries: `index.html` (main UI) and `media.html` (media overlay; picks by `window.rp.app.windowKind()` or by entry).

Main UI (React, one small store with `useSyncExternalStore` or plain context; no Redux):
- Layout: left sidebar (characters + sessions), centre chat, right/inline panels via routes: Chat, Packs, Settings, Action Log, SDK Reference (renders typings in `<pre>`).
- Chat: message list with streaming text (markdown rendering via a tiny safe renderer — use `marked` + `DOMPurify`? Keep deps small: use `marked` with `sanitize` via `dompurify`; both are on cdnjs but we bundle from npm), action cards (purpose, collapsible code, result/logs/error, duration), emote styling, status line, composer (Enter to send, Shift+Enter newline), abort button while a turn runs, "new session" for a character, scenario editor in session settings.
- Packs: list with capability toggles (pack-level grants), install button → `pickInstallSource`, uninstall confirm, README view, characters list with "Start chat".
- Settings: provider list (add/edit/remove; kind select; base URL; API key masked; model text + "fetch models" button; "test" button), default provider, maxActionRounds, contextTokenBudget, run limits, useToolCalling, userDisplayName, theme, mediaAlwaysOnTop.
- Permission modal: driven by `permissions.onRequest`; shows module.method, args JSON, dangerous warning; buttons allow once / allow for session / deny.
- UI prompt modal for `ui.confirm` / `ui.choose`.
- Action log: table of audit entries with filter by session.

Media window: full-viewport React page listening to `media.onCommand`; renders items (image with caption + fade; `<video>`/`<audio>` with autoplay, volume, loop; reports `ended`/`error` via `media.report`); `close`/`close-all` remove items; when no items remain the page reports `closed` for each and main hides the window. Click on an image closes it.

## Packaging

`electron-builder` config in `package.json` (`build` key) for win (nsis), mac (dmg), linux (AppImage). `pnpm build` must succeed in CI without signing. Do not run electron-builder in tests.

## Tests

- vitest for pure helpers: preload api builder (with a fake ipcRenderer), asset protocol path guard, range parsing, media window placement math, renderer store reducers.
- `pnpm build` (electron-vite build) must pass.
