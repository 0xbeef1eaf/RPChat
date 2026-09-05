# Display backends, overlays and external commands (desktop main process)

This spec extends `docs/spec/desktop.md`. It covers how media overlays honour
`OverlayOptions` (`layer`, `monitor`, `position`/`x`/`y`, `opacity`,
`clickThrough`), how the app runs on **Hyprland** (Wayland), and how the
`wallpaper`, `browser` and `input` modules execute user-configured command
templates. Contracts: `@rp/shared/media.ts` (`OverlayOptions`, `OverlayUpdate`,
`MonitorInfo`, `DisplayBackendInfo`, `MediaCommand`), `@rp/shared/settings.ts`
(`displayBackend`, `commandTemplates`, `maxInputLockMs`, `wallpaperRestoreFile`).

## 1. Display backend abstraction

```ts
// apps/desktop/src/main/display/backend.ts
export interface OverlayWindowLike {           // what a backend manipulates (BrowserWindow behind an interface for tests)
  id: string; title: string;
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void;
  setOpacity(v: number): void;                 // Electron: Windows/macOS only; no-op on Linux
  setFocusable(flag: boolean): void;
  show(): void; hide(): void; isDestroyed(): boolean;
}
export interface DisplayBackend {
  info(): DisplayBackendInfo;
  monitors(): Promise<MonitorInfo[]>;
  /** Called once after the window is created and shown; applies every option. */
  apply(win: OverlayWindowLike, opts: ResolvedOverlayOptions): Promise<void>;
  /** Live change (subset). */
  update(win: OverlayWindowLike, patch: OverlayUpdate): Promise<void>;
  dispose(): Promise<void>;
}
export interface ResolvedOverlayOptions {      // after defaults + monitor resolution + fallbacks
  monitor: MonitorInfo; layer: OverlayLayer; opacity: number; clickThrough: boolean;
  bounds: { x: number; y: number; width: number; height: number };   // absolute logical px
}
export function selectBackend(setting: AppSettings['displayBackend'], env = process.env): DisplayBackend;
export function resolvePlacement(opts: OverlayPlacement & { width?: number; height?: number }, monitors: MonitorInfo[], size: { width: number; height: number }): { monitor: MonitorInfo; bounds: {...} };  // pure; unit-tested
```

`resolvePlacement` rules: pick monitor by selector (`primary` default, `cursor` = `hasCursor`, number = index, string = id or name, unknown → primary). Size = requested `width`/`height` or the content size reported by the media window (`content-size` event, see §4) with defaults 480×(auto). Presets anchor with `marginPx` (default 24) inside the monitor work area; `x`/`y` in 0..1 are fractions of the work area, > 1 are px offsets; the result is clamped so the window stays fully on the monitor.

Opacity is always ALSO applied in the media window as CSS `opacity` on the item container (via the command's `options.opacity`), because Electron's `setOpacity` is a no-op on Linux; the backend calls `setOpacity` where it works. Windows are created `transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, focusable: false, resizable: false`.

### 1.1 `electron` backend (default: Windows, macOS, X11, generic Wayland)

- monitors: `screen.getAllDisplays()` (`workArea`, `scaleFactor`, `label` as name, `screen.getPrimaryDisplay()`, `screen.getCursorScreenPoint()` → `hasCursor`).
- layer: `top`/`overlay` → `setAlwaysOnTop(true, 'screen-saver')` (macOS: `'floating'` for `top`, `'screen-saver'` for `overlay`); `bottom`/`background` → `setAlwaysOnTop(false)` + on Windows/X11 attempt to lower the window (`win.blur()` + `setFocusable(false)`); report `supports.layers = ['top','overlay']` on Wayland-without-Hyprland, `['bottom','top','overlay']` elsewhere.
- clickThrough: `setIgnoreMouseEvents(true, { forward: true })` + `setFocusable(false)`.
- exactPosition: `true` except when `windowSystem === 'wayland'` (compositors ignore `setBounds` position) → `false`; in that case still set size and let the compositor place it.

### 1.2 `hyprland` backend (Linux, Hyprland ≥ 0.40)

Detect with `HYPRLAND_INSTANCE_SIGNATURE`. Talk to Hyprland over its IPC socket `${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket.sock` (request/response, same syntax as `hyprctl`, prefix `j/` for JSON) with a fallback to spawning `hyprctl` when the socket is unavailable. Implement `hyprctl(cmd: string): Promise<string>` and `hyprctlJson<T>(cmd)`. Subscribe to the event socket `.socket2.sock` for `openwindow`/`closewindow`/`monitoradded`/`monitorremoved` (best effort; ignore errors).

Window identification: each overlay `BrowserWindow` gets a unique title `rp-overlay:<uuid>`; look up its address with `j/clients` (match `title`), retrying briefly after creation. All manipulation uses `dispatch … ,address:0x…`:

| option | Hyprland command(s) |
|---|---|
| float + placement | `dispatch setfloating address:0x…`; `dispatch movewindowpixel exact X Y,address:0x…`; `dispatch resizewindowpixel exact W H,address:0x…` (X/Y are global logical coordinates from `j/monitors`) |
| layer `overlay`/`top` | `dispatch pin address:0x…` (visible on all workspaces) + `dispatch alterzorder top,address:0x…` |
| layer `bottom`/`background` | `dispatch alterzorder bottom,address:0x…` (below other floating windows; tiled windows still cover it — document this limitation; `pin` only for `background` so it follows workspaces like a wallpaper) |
| opacity | `dispatch setprop address:0x… alpha <v>` and `alphaoverride 1` (fall back to legacy `setprop address:0x… alpha <v> lock` when the dispatcher form returns an error); plus CSS opacity |
| click-through | `dispatch setprop address:0x… nofocus 1` (never takes focus) + Electron `setIgnoreMouseEvents(true)`; report `supports.clickThrough = true` |
| chrome | `setprop noborder 1`, `noshadow 1`, `noblur 1`, `nodim 1`, `norounding 1`, `noanim 1` |
| monitor | `dispatch movewindow mon:<name>,address:…` before placement when the target monitor differs |

Also register once at startup a permanent window rule so Hyprland never tiles or animates overlays even before the address lookup lands: `keyword windowrulev2 float,title:^(rp-overlay:.*)$`, `keyword windowrulev2 noinitialfocus,title:^(rp-overlay:.*)$`, `keyword windowrulev2 noborder,title:^(rp-overlay:.*)$`, `keyword windowrulev2 noshadow,...`, `keyword windowrulev2 noblur,...`, `keyword windowrulev2 noanim,...`. Batch with `[[BATCH]]` where supported.

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
| inputLock | empty (document `hyprctl`-free options in the Settings help: e.g. a user script using `evsieve`/`xinput`, or `hyprlock` for a screen lock) | `xinput` based example in help; default empty | empty | empty |
| inputUnlock | empty | empty | empty | empty |

"Not configured" (empty after defaults) → handler throws `RpError('CAPABILITY_FAILED', 'No <x> command configured; set one in Settings → Commands')`.

Handlers (`apps/desktop/src/main/capabilities/{wallpaper,browser,input}.ts`):
- `wallpaper.set(asset, { monitor? })`: arg 0 is a pack-root-relative asset path already validated by core; resolve to an absolute file via `resolveAssetPath(packRoot, path)`; `{file}` = absolute path, `{monitor}` = resolved monitor name or ''. Remember `current` in memory. `restore()` runs the template with `settings.wallpaperRestoreFile` (must exist) → true; empty → false.
- `browser.open(url, { newWindow? })`: validate `^https?://` via `new URL`; `{url}` substitution; when `newWindow` and the template contains `{newWindow}` substitute `--new-window` else ''. Never fall back to `shell.openExternal` silently — if no template, use `shell.openExternal` only when the platform default is empty (it never is).
- `input.lock(durationMs, { reason })`: clamp to `[1000, settings.maxInputLockMs]`; run `inputLock` with `{seconds}`,`{durationMs}`; arm a timer that runs `inputUnlock` (if configured) at the end and clears state; `unlock()` runs `inputUnlock` now (if configured) and clears the timer; `status()`. If `inputLock` exits non-zero → `CAPABILITY_FAILED` with stderr. Log every run to the audit trail via core (core already audits the capability call; the handler adds a `logger.info`).

All three templates are editable in **Settings → Commands** (renderer): command, `shell` toggle, timeout, a "Test" button that runs the template with sample values (`{file}` = the app's bundled sample image, `{url}` = `https://example.com`, `{seconds}` = 3), showing exit code/stdout/stderr. Add to `IpcApi.settings`: `testCommand(name: keyof CommandTemplates, tpl: CommandTemplate): Promise<{ code: number; stdout: string; stderr: string }>`.

## 3. Sandbox ↔ core notes

- Core normalises the asset argument (arg 0) for `media.showImage/playVideo/playAudio` **and** `wallpaper.set` to a validated pack-root-relative path before dispatching to host handlers.
- `media.update(handle, changes)` reaches the host handler with `(id: string, changes: OverlayUpdate)` (core unwraps a `MediaHandle` object to its `id`, as it does for `close`).
- `display.monitors()` / `display.backend()` are host handlers backed by the active `DisplayBackend`.

## 4. Media window additions

- Renderer applies `options.opacity` as CSS opacity on the item and stops treating clicks as "close" when `options.clickThrough` is true.
- After rendering an item the media window reports its content size: `MediaWindowEvent` gains `{ type: 'content-size'; id; width; height }` (added to `@rp/shared/media.ts`); main uses it to size the window when no explicit `width`/`height` was given, then re-applies placement.
- `update` command: `{ type: 'update'; id; options: OverlayUpdate }` — the renderer applies only `opacity`/`width`/`height`/`clickThrough` visually; everything else is handled by the backend.
