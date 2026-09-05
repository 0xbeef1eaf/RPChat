# rp-overlay-wlr

Native helper that gives the rp desktop app real **wlr-layer-shell** overlays on Wayland
compositors that implement `zwlr_layer_shell_v1` (Hyprland, Sway, river, KDE Plasma, ...).
Electron cannot create layer surfaces, so the app spawns this binary and drives it over
stdin/stdout. Each overlay is a GTK3 window turned into a layer surface by
[gtk-layer-shell](https://github.com/wmww/gtk-layer-shell) that hosts a WebKitGTK web view
rendering the app's own `media.html`. One process hosts any number of overlays.

Spec: `docs/spec/overlay-helper.md` (this crate) and `docs/spec/overlay.md` §1.2 (how the
`hyprland` display backend uses it).

## Build

```sh
cargo build --release                 # → target/release/rp-overlay-wlr
pnpm run build:native                 # same, from the monorepo root
cargo test                            # protocol parsing + pure placement planning
cargo run -- --self-test < examples/sample.jsonl   # scripted conversation, no GTK needed
```

### System dependencies

| Distro | Build | Runtime |
|---|---|---|
| Arch / Manjaro | `gtk3 gtk-layer-shell webkit2gtk-4.1 pkgconf` | `gtk3 gtk-layer-shell webkit2gtk-4.1` |
| Debian / Ubuntu | `libgtk-3-dev libgtk-layer-shell-dev libwebkit2gtk-4.1-dev pkg-config` | `libgtk-3-0 libgtk-layer-shell0 libwebkit2gtk-4.1-0` |
| Fedora | `gtk3-devel gtk-layer-shell-devel webkit2gtk4.1-devel pkgconf-pkg-config` | `gtk3 gtk-layer-shell webkit2gtk4.1` |
| Alpine | `gtk+3.0-dev gtk-layer-shell-dev webkit2gtk-4.1-dev pkgconf` | `gtk+3.0 gtk-layer-shell webkit2gtk-4.1` |
| NixOS | `gtk3 gtk-layer-shell webkitgtk_4_1 pkg-config` in the dev shell | same |

Minimum versions: gtk+-3.0 3.24, gtk-layer-shell 0.6, webkit2gtk-4.1 2.40 (the crate is
built with the `v2_40` API feature). Rust 1.75+.

For video playback WebKitGTK needs the usual GStreamer plugins (`gst-plugins-good`,
`gst-plugins-bad`, `gst-libav` / distro equivalents).

## How the app finds the binary

The desktop app (`apps/desktop/src/main/display/`) looks, in order, at:

1. `process.env.RP_OVERLAY_HELPER` (absolute path to the binary),
2. `resources/bin/rp-overlay-wlr` next to the app (`process.resourcesPath` when packaged,
   `apps/desktop/resources/bin/` in development),
3. `rp-overlay-wlr` on `PATH`.

If none is found, or the helper exits before answering `hello`, the app logs why and falls
back to the `hyprland-ipc` emulation (Electron windows manipulated through Hyprland IPC).

## CLI

```
rp-overlay-wlr [--log-level error|warn|info|debug]
rp-overlay-wlr --self-test [--log-level ...] < conversation.jsonl
rp-overlay-wlr --help | --version
```

Logs go to stderr (`rp-overlay-wlr [level] message`), filtered by `--log-level`
(default `info`). `warn` and `error` lines are additionally sent to the app as
`{ "ev": "log" }` events.

Exit codes: `0` normal (after `quit`, or when stdin/stdout close), `2` GTK could not be
initialised or the compositor has no layer-shell support (an `error` event is written
first), `64` bad command line, `1` `--self-test` failure.

## Protocol (JSON Lines, UTF-8, one object per line)

Requests are read from **stdin**, events are written to **stdout** (flushed after every
line). Every request may carry `"seq": <number>`; the reply it produces echoes it. Requests
that fail produce `{ "ev": "error", "id"?, "message", "seq"? }` and never crash the helper.
Unknown request fields are ignored.

### Requests (app → helper)

| `op` | fields | reply |
|---|---|---|
| `hello` | `version: 1` | `ready` (or `error` for another version) |
| `monitors` | – | `monitors` |
| `show` | `id, url, layer?, anchor?, marginPx?, x?, y?, monitor?, width?, height?, opacity?, clickThrough?, namespace?` | `shown` once the window is mapped |
| `update` | `id, patch: { layer?, anchor?, marginPx?, x?, y?, monitor?, width?, height?, opacity?, clickThrough? }` | `updated` |
| `js` | `id, script` | `js-done` when the script finished (or `error`) |
| `close` | `id` | `closed` |
| `closeAll` | – | one `closed` per overlay (the first echoes `seq`) |
| `quit` | – | closes everything, exits 0 |

Defaults for `show`: `layer: "top"`, `anchor: "center"`, `marginPx: 24`, `width: 480`,
`opacity: 1`, `clickThrough: false`, `namespace: "rp-overlay"`; no `height` means the page's
`content-size` report decides (320 until it arrives).

Field semantics:

- `layer`: `background | bottom | top | overlay`.
- `anchor`: `center | top-left | top-right | bottom-left | bottom-right`. Presets anchor the two
  matching edges with `marginPx` on both; `center` anchors nothing (the compositor centres it).
- `x` / `y`: explicit offsets from the monitor's top-left work-area corner. Values in `0..=1`
  are fractions of the monitor work area, anything else is logical px. When either is given
  the surface is anchored top-left and positioned by margins (the other axis comes from
  `anchor`), clamped so the surface stays inside the monitor.
- `monitor`: `{ index?, name?, x?, y? }` resolved in that order (index → name, case-insensitive,
  then id → the monitor whose work area contains `(x, y)`); nothing matching → compositor
  default. A bare number (index) or string (name) is accepted too.
- `width` / `height`: logical px, clamped to `[16, monitor]`. `width` is always applied;
  `height` is fixed only when given explicitly.
- `opacity`: `0..1`, applied to the whole window.
- `clickThrough`: `true` gives the window an empty input region so pointer events fall
  through. Overlays never take keyboard focus in either mode.
- `namespace`: layer-shell namespace (Hyprland `layerrule` target). Not patchable.
- `update.patch`: absent or `null` fields keep their value. `anchor` without `x`/`y` returns
  to preset positioning; `x`/`y` switch to explicit positioning.

### Events (helper → app)

| `ev` | fields |
|---|---|
| `ready` | `version: 1, features: { layers: ["background","bottom","top","overlay"], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true, video: true }` |
| `monitors` | `monitors: MonitorInfo[]` — `{ id, name, index, primary, x, y, width, height, scale, hasCursor }`; geometry is the **work area** in logical px, `id` is the GDK index as a string, `name` the monitor model when GDK knows it (else `monitor-<i>`), `primary` the GDK primary or index 0 |
| `shown` | `id` — the window is mapped (the page may still be loading) |
| `updated` | `id` |
| `js-done` | `id` |
| `closed` | `id` — also sent when the compositor or the page closes the surface |
| `message` | `id, payload` — whatever the page posted through `window.webkit.messageHandlers.rp.postMessage(JSON.stringify(payload))`; strings that are valid JSON are parsed, other values are converted with JSC's JSON serialiser |
| `error` | `id?, message` |
| `log` | `level, message` |

### The page

Every web view gets a user script at document start that sets `window.__rpHelper = true`
so `media.html` switches to helper mode: it reads the initial command from
`location.hash` (`#cmd=<base64url JSON>`), receives later commands via
`window.__rpMediaCommand(json)` (the app sends them with the `js` op) and reports through
`window.webkit.messageHandlers.rp.postMessage(...)`.

When a `message` payload is `{ "type": "content-size", "width", "height" }` and the overlay
has no explicit `height`, the helper resizes the surface to the reported height (width stays
at `width`, both clamped to the monitor) and re-applies anchors and margins. Explicit
positions therefore keep their top-left corner; bottom-anchored presets grow upwards.

## Example conversation

`examples/sample.jsonl` is what the self-test replays:

```jsonl
{"op":"hello","version":1,"seq":1}
{"op":"monitors","seq":2}
{"op":"show","seq":3,"id":"img-1","url":"http://127.0.0.1:41234/t/<token>/media.html#cmd=...","layer":"overlay","anchor":"bottom-right","width":480,"clickThrough":true}
{"op":"js","seq":6,"id":"img-1","script":"window.__rpMediaCommand('{\"type\":\"update\",...}')"}
{"op":"update","seq":7,"id":"img-1","patch":{"opacity":0.5,"monitor":{"index":1}}}
{"op":"close","seq":11,"id":"img-1"}
{"op":"quit","seq":13}
```

## Layout

```
src/main.rs        CLI, logging, --self-test, GTK main loop + stdin reader thread, dispatcher
src/protocol.rs    serde types for requests/events (+ parsing tests)
src/plan.rs        pure placement planning: settings + monitors → OverlayPlan (+ tests)
src/overlay.rs     GTK window + layer-shell + WebKitGTK web view per overlay, OverlayManager
src/monitors.rs    MonitorSource trait: GDK implementation and test fixtures
src/events.rs      mutex-guarded, line-flushed stdout event writer
examples/sample.jsonl   scripted conversation for --self-test
```
