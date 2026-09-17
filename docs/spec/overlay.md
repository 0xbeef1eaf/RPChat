# Display backends, overlays and external commands (desktop main process)

This spec extends `docs/spec/desktop.md`. It covers how media overlays honour
`OverlayOptions` (`layer`, `monitor` — default `random` for media overlays (avatar and widgets default to `primary`), one of the connected monitors drawn per window —, `position`/`x`/`y` — default position `random`: a spot drawn once per overlay so the whole window stays on the monitor, re-clamped when the content size arrives; the helper receives `randomX`/`randomY` and applies the same formula —, `width`/`height` — media overlays with neither are drawn a random box, one fraction in [5%, 50%] of the monitor's width and height (`RANDOM_SIZE_MIN_FRACTION`/`RANDOM_SIZE_MAX_FRACTION`, `randomSizeFraction`/`randomSizeBox` in placement.ts, `randomSize: true` passed by the media capability only): `width` is the box width and `maxHeight` its height; the page (`fitMedia`, media/fit.ts) scales the image/video up or down to fill the width and shrinks it if the cap bites, keeping the aspect ratio, and reports the fitted size so the window ends content-sized; backends open the window at the full box height first so the page is never squeezed; an update that sets `width` or `height` drops the cap —, `opacity`,
`clickThrough`), how the app runs on **Hyprland** (Wayland), and how the
`wallpaper`, `browser` and `input` modules execute user-configured command
templates. Contracts: `@rp/shared/media.ts` (`OverlayOptions`, `OverlayUpdate`,
`MonitorInfo`, `DisplayBackendInfo`, `MediaCommand`), `@rp/shared/settings.ts`
(`displayBackend`, `commandTemplates`, `maxInputLockMs`, `wallpaperRestoreFile`).

## 1. Display backend abstraction (revised: the backend owns overlay lifecycle)

```ts
// apps/desktop/src/main/display/backend.ts
export interface OverlaySpec {
  id: string;
  kind: 'image' | 'video';
  /** Absolute file path of the asset (for backends that read files themselves). */
  file: string;
  /** rp-asset:// URL (Electron windows) — backends that need http get one from LoopbackServer. */
  assetUrl: string;
  packId: string; asset: string;
  options: ResolvedOverlayOptions;
  /** Page-level options forwarded to media.html (caption, durationMs, volume, loop, muted, closeOnEnd). */
  page: ShowImageOptions | PlayVideoOptions;
}
export interface ResolvedOverlayOptions {
  monitor: MonitorInfo; layer: OverlayLayer; opacity: number; clickThrough: boolean;
  anchor: MediaPosition; marginPx: number; x?: number; y?: number;   // x/y resolved to logical px on the monitor
  randomSeed?: { x: number; y: number };                              // anchor 'random': fractions of the free space, drawn once per overlay
  width: number; height?: number;
  maxHeight?: number;                                                 // media with no size: the random box's height; the page fits the content into width×maxHeight, the window stays content-sized
}
export interface OverlayHandle {
  readonly id: string;
  update(patch: OverlayUpdate): Promise<void>;         // placement/layer/opacity/clickThrough/size; also forwards the visual subset to the page
  close(): Promise<void>;
  on(event: 'ended' | 'closed' | 'error' | 'content-size', listener: (detail?: unknown) => void): () => void;
}
export interface DisplayBackend {
  readonly name: string;
  info(): DisplayBackendInfo;
  monitors(): Promise<MonitorInfo[]>;
  createOverlay(spec: OverlaySpec): Promise<OverlayHandle>;
  closeAll(): Promise<void>;
  dispose(): Promise<void>;
}
export function resolveOverlayOptions(opts: OverlayOptions, monitors: MonitorInfo[], defaults: { layer: OverlayLayer }): ResolvedOverlayOptions;  // pure, unit-tested
export async function selectBackend(setting: AppSettings['displayBackend'], ctx: { env, findHelper(): string | undefined, logger }): Promise<DisplayBackend>;
```

The media capability handler no longer touches windows: it resolves the asset, builds an `OverlaySpec`,
calls `backend.createOverlay`, tracks `MediaItem`s and handles `durationMs`/`closeOnEnd`. Audio never
creates an overlay: it plays in one hidden Electron window regardless of backend.

Backends in v1: `electron` (generic, base for every platform) and `hyprland` (composed of the
`wlr-layer-shell` helper with an `hyprland-ipc` emulation fallback). Future backends (`kde`, `gnome`,
`windows`, `macos`) implement the same interface; they are NOT built now. `selectBackend('auto')`:
`HYPRLAND_INSTANCE_SIGNATURE` set → `hyprland`, else `electron`.

### 1.0 Loopback media server (`apps/desktop/src/main/loopback.ts`)

Native backends render `media.html` in their own web view, which cannot use `rp-asset://`. `LoopbackServer`
(Node `http`, bound to `127.0.0.1`, random port, random 32-byte token in every path) serves:
`/t/<token>/media.html` (+ its built JS/CSS from `out/renderer`, or proxies `ELECTRON_RENDERER_URL` in dev),
and `/t/<token>/asset/<packId>/<path>` with the same pack-root guard and Range support as the protocol
handler (share the code). Started lazily by the first native backend; `MediaCommand` URLs for native
backends are rewritten from `rp-asset://` to the loopback URL. Unit-test the path guard and range logic
(already required) plus the URL rewrite.

`media.html` runs in two transports (renderer agent implements): Electron (`window.rp`) or helper mode,
detected by `window.__rpHelper === true` / absence of `window.rp`: the initial `MediaCommand` is read from
`location.hash` (`#cmd=<base64url JSON>`), later commands arrive through `window.__rpMediaCommand(cmdJson)`
(the helper runs it via the `js` op), and reports are posted with
`window.webkit.messageHandlers.rp.postMessage(JSON.stringify(event))`.

### 1.1 `electron` backend (default: Windows, macOS, X11, generic Wayland)

- monitors: `screen.getAllDisplays()` (`workArea`, `scaleFactor`, `label` as name, `screen.getPrimaryDisplay()`, `screen.getCursorScreenPoint()` → `hasCursor`).
- layer: `top`/`overlay` → `setAlwaysOnTop(true, 'screen-saver')` (macOS: `'floating'` for `top`, `'screen-saver'` for `overlay`); `bottom`/`background` → `setAlwaysOnTop(false)` + on Windows/X11 attempt to lower the window (`win.blur()` + `setFocusable(false)`); report `supports.layers = ['top','overlay']` on Wayland-without-Hyprland, `['bottom','top','overlay']` elsewhere.
- clickThrough: `setIgnoreMouseEvents(true, { forward: true })` + `setFocusable(false)`.
- exactPosition: `true` except when `windowSystem === 'wayland'` (compositors ignore `setBounds` position) → `false`; in that case still set size and let the compositor place it.

### 1.2 `hyprland` backend (Linux, Hyprland ≥ 0.40)

Two tiers, chosen at startup:

1. **`wlr-layer-shell` tier** (preferred): the Rust helper described in `docs/spec/overlay-helper.md`
   is spawned once (`HelperProcess`: spawn, `hello`, JSON-lines reader, request/response by `seq`,
   restart with backoff on crash, `quit` on dispose). `createOverlay` → `show` with the loopback URL,
   `OverlayHandle.update` → `update` (+ `js` for the visual subset), `close` → `close`. Every later command
   passes through `pageCommand` first, which rewrites the asset URL it carries — `avatar-set`'s next
   expression frame above all, since the helper's WebKit views cannot fetch `rp-asset://`. Helper `message`
   events map to `content-size` / `ended` / `error` / `closed`. `info()` reports all four layers,
   opacity, clickThrough, exactPosition, monitorSelection true. Monitors come from the helper
   (`monitors` op) merged with Hyprland IPC names where the helper lacks connector names (match by geometry).
2. **`hyprland-ipc` tier** (fallback when the helper binary is missing or fails `hello`): Electron
   windows manipulated through Hyprland IPC as below; `info().supports.layers = ['top','overlay']` and
   `bottom`/`background` are emulated with `alterzorder bottom` (still above tiled windows — say so in
   the log and in `DisplayBackendInfo.name = 'hyprland-ipc'`).

Detect with `HYPRLAND_INSTANCE_SIGNATURE`. Talk to Hyprland over its IPC socket `${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket.sock` (request/response, same syntax as `hyprctl`, prefix `j/` for JSON) with a fallback to spawning `hyprctl` when the socket is unavailable. Implement `hyprctl(cmd: string): Promise<string>` and `hyprctlJson<T>(cmd)`. Subscribe to the event socket `.socket2.sock` for `openwindow`/`closewindow`/`monitoradded`/`monitorremoved` (best effort; ignore errors).

Window identification: each overlay `BrowserWindow` gets a unique title `rp-overlay:<uuid>`; look up its address with `j/clients` (match `title`), retrying briefly after creation. All manipulation uses `dispatch … ,address:0x…`:

| option | Hyprland command(s) |
|---|---|
| float + placement | `dispatch setfloating address:0x…`; `dispatch movewindowpixel exact X Y,address:0x…`; `dispatch resizewindowpixel exact W H,address:0x…` (X/Y are global logical coordinates from `j/monitors`) |
| layer `overlay`/`top` | `dispatch pin address:0x…` (visible on all workspaces) + `dispatch alterzorder top,address:0x…` |
| layer `bottom`/`background` | `dispatch alterzorder bottom,address:0x…` (below other floating windows; tiled windows still cover it — document this limitation; `pin` only for `background` so it follows workspaces like a wallpaper) |
| opacity | `dispatch setprop address:0x… alpha <v>` and `alphaoverride 1`, then `alphainactive <v>` and `alphainactiveoverride 1` — an overlay is shown `nofocus`, so without the inactive pair `decoration:inactive_opacity` (or an `opacity <active> <inactive>` rule) dims it (fall back to legacy `setprop address:0x… alpha <v> lock` and `alphainactive <v> lock` when the dispatcher form returns an error); plus CSS opacity |
| click-through | `dispatch setprop address:0x… nofocus 1` (never takes focus) + Electron `setIgnoreMouseEvents(true)`; report `supports.clickThrough = true` |
| chrome | `setprop noborder 1`, `noshadow 1`, `noblur 1`, `nodim 1`, `norounding 1`, `noanim 1` |
| monitor | `dispatch movewindow mon:<name>,address:…` before placement when the target monitor differs |

Also register once at startup permanent window rules so Hyprland never tiles or animates overlays even before the address lookup lands: `keyword windowrule float,title:^(rp-overlay:.*)$`, then `noinitialfocus`, `pin`, `noborder`, `noshadow`, `norounding`, `noblur`, `nodim`, `noanim`, `nomaxsize` for the same matcher, plus `keyword layerrule noanim,^(rp-overlay.*)$` for the helper's surfaces. Batch with `[[BATCH]]` where supported. The keyword is `windowrule` from Hyprland 0.45 on and `windowrulev2` below it (`j/version` → `tag`; an unreadable version is assumed current). Everything is set over IPC — the app never writes to the user's Hyprland config. Dynamic rules are dropped by `hyprctl reload`, so the `configreloaded` event re-registers them.

#### 1.2.2 Lua-config sessions (`display/hypr-lua.ts`)

From 0.5x a Hyprland whose config is Lua (`hyprland.lua`) refuses the legacy command set: `keyword …` answers `keyword can't work with non-legacy parsers. Use eval.` and a legacy `dispatch setfloating address:0x…` comes back as a Lua syntax error (`return hl.dispatch(setfloating address:0x…)`). Both answers mean the same thing, so `isLuaParserResponse` treats either as the signal to speak Lua from then on — the dialect is never guessed from the version or from files on disk. Everything then goes through `eval <lua>`:

| purpose | legacy | Lua |
| --- | --- | --- |
| rules | `keyword windowrule float,title:…` | `hl.window_rule({ name = "rpchat-overlays", match = { title = "^(rp-overlay:.*)$" }, float = true, … })`, `hl.layer_rule({ match = { namespace = … }, no_anim = true })` |
| float / pin | `dispatch setfloating`, `dispatch pin` (set) | `hl.dsp.window.float/pin` are **toggles**: guard with `if not w.floating`, `if w.pinned ~= <wanted>` |
| geometry | `resizewindowpixel exact`, `movewindowpixel exact`, `movewindow mon:` | `hl.dsp.window.resize({ x, y, window })` then `move({ x, y, monitor, window })` — absolute layout coordinates |
| chrome | `setprop noborder/norounding/nodim 1` | rule fields `border_size = 0`, `rounding = 0`, `decorate = false`, `no_anim`, `no_blur`, `no_dim`, `no_shadow`, `no_max_size`, `no_initial_focus`, `suppress_event = "maximize"` |
| opacity | `setprop alpha <v>` + `alphaoverride 1`, and the same pair for `alphainactive` | `set_prop({ window = w, prop = "opacity", value = <v> })` + `opacity_override`, and the same for `opacity_inactive` |
| click-through | `setprop nofocus 1` | `set_prop({ window = w, prop = "no_focus", value = 1 })` — `value` takes a number or string, **never** a Lua boolean |

One `eval` carries the whole placement (window lookup by `x.address`, then the dispatches), so a placement is one round trip and Lua reports each failed line in the answer. Rule handles are kept in the Lua global `__rp_overlay_rules`: re-registering disables the previous ones (no duplicates after a reload) and `dispose()` disables them, so an IPC-only session leaves nothing behind. Z-order among overlays follows `pin` (a pinned window draws above unpinned floating ones); `bring_to_top` is sent for `top`/`overlay` as a best effort and `bottom`/`background` stay emulated, as `info()` already reports.

monitors: `j/monitors` → `MonitorInfo` (name, id, `x`,`y`,`width/scale`,`height/scale` minus `reserved`, `focused` → `hasCursor`, primary = index 0 / `focused` if none is marked), `j/cursorpos` for the cursor.

`info()`: `{ name: 'hyprland', platform: 'linux', windowSystem: 'wayland', supports: { layers: ['background','bottom','top','overlay'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true } }`.

Electron under Wayland: in `main/index.ts` before `app.ready`: `app.commandLine.appendSwitch('ozone-platform-hint', 'auto')`, `app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')`, and when `HYPRLAND_INSTANCE_SIGNATURE` or `WAYLAND_DISPLAY` is set, prefer `ozone-platform=wayland`; keep the main window with `frame: true`. `windowSystem` detection: `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE`.

Because no Hyprland session exists in CI, the backend must be built so that all command construction is pure and unit-tested (`buildCommands(opts, address) → string[]`), with the IPC transport injected (fake transport in tests that records commands and answers `j/clients`, `j/monitors`, `j/cursorpos` from fixtures). Include a fixture from real `hyprctl -j monitors`/`clients` output shapes.

## 2. Command templates (`wallpaper`, `browser`, `input`)

`apps/desktop/src/main/commands.ts`:

```ts
export function tokenize(commandLine: string): string[];                  // POSIX-ish: whitespace split, '…' and "…" quoting, backslash escapes; pure, tested
export function substitute(tokens: string[], vars: Record<string, string>): string[];   // replaces {name} inside tokens; unknown placeholders → ''; never re-tokenises
export function shellQuote(value: string, platform: NodeJS.Platform): string;
export function runTemplate(tpl: CommandTemplate, vars: Record<string,string>, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  // shell:false → spawn(argv[0], argv.slice(1)); shell:true → spawn(sh -c line | cmd.exe /d /s /c line) with values shell-quoted before substitution
export function defaultTemplates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CommandTemplates;
```

Platform defaults (used when a template's `command` is empty):

| template | linux (Hyprland detected) | linux (other) | win32 | darwin |
|---|---|---|---|---|
| wallpaper | `swww img {file}` if `swww` on PATH, else `hyprctl hyprpaper wallpaper "{monitor},{file}"` if `hyprpaper` on PATH, else empty | `gsettings set org.gnome.desktop.background picture-uri "file://{file}"` if `gsettings` on PATH, else `feh --bg-fill {file}` if `feh`, else empty | PowerShell one-liner via `shell:true` setting `SystemParametersInfo` (write the standard `Add-Type` snippet) | `osascript -e 'tell application "System Events" to set picture of every desktop to "{file}"'` |
| browser | `xdg-open {url}` | `xdg-open {url}` | `cmd /c start "" {url}` (shell) | `open {url}` |

"Not configured" (empty after defaults) → handler throws `RpError('CAPABILITY_FAILED', 'No <label> command is configured for sdk.<module>.<method>; set one in Settings → Commands → <label> (platform default: …)')` — built by `notConfigured(name)` from `COMMAND_TEMPLATE_INFO` in `@rp/shared`, which the Settings page uses for the same "used by" text. A configured command whose executable is missing (spawn `ENOENT`) fails with `The <name> command needs "<file>", which is not installed or not on PATH; install it or set another command in Settings → Commands → <label>`; a non-zero exit with `<label> command ("<command>") exited with <code>: <stderr>; check it in Settings → Commands → <label>` (`commandFailed`). Never return an empty/`null` result where the docs of the method do not say so.

Handlers (`apps/desktop/src/main/capabilities/{wallpaper,browser,input}.ts`):
- `wallpaper.set(asset, { monitor? })`: arg 0 is a pack-root-relative asset path already validated by core; resolve to an absolute file via `resolveAssetPath(packRoot, path)`; `{file}` = absolute path, `{monitor}` = resolved monitor name or ''. Remember `current` in memory. `restore()` runs the template with `settings.wallpaperRestoreFile` (must exist) → true; empty → false.
- `browser.open(url, { newWindow? })`: validate `^https?://` via `new URL`; `{url}` substitution; when `newWindow` and the template contains `{newWindow}` substitute `--new-window` else ''. Never fall back to `shell.openExternal` silently — if no template, use `shell.openExternal` only when the platform default is empty (it never is).
- `input.lock(durationMs, { reason, devices })`: clamp to `[1000, settings.maxInputLockMs]` and forward to the `rpchatd` daemon, which clamps again against the root-owned policy and unlocks by itself; `unlock()` and `status()` likewise. No command templates are involved (superseded by `docs/spec/system.md`): without a connected daemon every `sdk.input` method throws `CAPABILITY_FAILED`. Core audits the capability call; the handler adds a `logger.info`.

All three templates are editable in **Settings → Commands** (renderer): command, `shell` toggle, timeout, a "Test" button that runs the template with sample values (`{file}` = the app's bundled sample image, `{url}` = `https://example.com`, `{seconds}` = 3), showing exit code/stdout/stderr. Add to `IpcApi.settings`: `testCommand(name: keyof CommandTemplates, tpl: CommandTemplate): Promise<{ code: number; stdout: string; stderr: string }>`.

## 3. Sandbox ↔ core notes

- Core normalises the asset argument (arg 0) for `media.showImage/playVideo/playAudio` **and** `wallpaper.set` to a validated pack-root-relative path before dispatching to host handlers.
- `media.update(handle, changes)` reaches the host handler with `(id: string, changes: OverlayUpdate)` (core unwraps a `MediaHandle` object to its `id`, as it does for `close`).
- `display.monitors()` / `display.backend()` are host handlers backed by the active `DisplayBackend`.

## 4. Media window additions

- Renderer applies `options.opacity` as CSS opacity on the item and stops treating clicks as "close" when `options.clickThrough` is true, or when an image has a `durationMs` — it closes itself, and a click on it is more likely the user carrying on with their work (`closesOnClick`). An explicit `ShowImageOptions.closeOnClick` overrides both defaults: `false` keeps an image up after a click (a target the character reacts to), `true` lets a timed image go on a hit (whack-a-mole).
- Clicks and closes are reported with their cause: every click on an image/video item (not click-through, not audio) is a `MediaWindowEvent` `{ type: 'clicked'; id }` whether or not it also closes the item, and `{ type: 'closed'; id; reason }` carries a `MediaCloseReason` — `click` (the user dismissed it: click, Escape, the audio stop button), `timeout` (`durationMs`), `ended` (playback finished and `closeOnEnd`), `api` (a `close`/`close-all` command), `error`. Backends forward both as `OverlayHandle` events (`clicked`, and `closed` with detail `{ reason }`; a backend's own close is `api`), and the media capability turns them into the host events `media-clicked` / `media-closed` (`docs/spec/living.md` §3.3).
- After rendering an item the media window reports its content size: `MediaWindowEvent` gains `{ type: 'content-size'; id; width; height }` (added to `@rp/shared/media.ts`); main uses it to size the window when no explicit `width`/`height` was given, then re-applies placement.
- `update` command: `{ type: 'update'; id; options: OverlayUpdate }` — the renderer applies only `opacity`/`width`/`height`/`clickThrough` visually; everything else is handled by the backend.

## 5. Widgets and pack images (`{{asset:…}}` placeholders)

A widget's HTML runs in a `sandbox="allow-scripts"` srcdoc iframe with a null origin and no network, so it cannot name a pack file itself. Instead the HTML may contain **asset placeholders**, `{{asset:<pack-relative path>}}` (whitespace around the path tolerated), wherever a URL goes — `<img src="{{asset:media/images/a.png}}">`, `url({{asset:…}})` in CSS. The widgets capability (`apps/desktop/src/main/capabilities/widgets.ts`) substitutes them on `show` and on `update` with `html` (`renderHtml`, built on the pure `substituteAssetPlaceholders(html, resolve)`):

- every path goes through core's `resolvePackAsset` (pack-root-relative first, then `<mediaRoot>/<path>`; no `..`, no absolute paths, no symlink escape) — a path that is not an asset of the character's pack fails the whole call with `INVALID_ARGUMENT` naming the placeholder (`Widget placeholder {{asset:media/x.png}} is not a pack asset: …`), and nothing is shown or changed;
- the URL is `assetUrl(packId, path)` (`rp-asset://<packId>/<path>`) for Electron windows; a backend that renders `media.html` in its own web view rewrites it through `DisplayBackend.pageAssetUrl(url)` — the `hyprland` helper backend maps it to the loopback server's `/t/<token>/asset/<packId>/<path>` route (`LoopbackServer.rewriteAssetUrl`), exactly as it does for image overlays;
- the substituted HTML is what reaches the page (`WidgetSpec.html`); `{{…}}` that is not an asset placeholder is left alone, so widget scripts can use their own braces.

The headful smoke (`scripts/headful-smoke.sh`, `verify widget`) shows a widget whose `<img>` is the teal card through a placeholder and checks the captured pixels of the widget window, proving the sandboxed iframe loads `rp-asset://` images in the Electron media window (the custom scheme is registered `standard` + `secure`, and the media window's CSP allows `img-src rp-asset:`). Should a platform refuse the scheme from a null-origin frame, `pageAssetUrl` is the switch: return the loopback URL there and nothing else changes.
