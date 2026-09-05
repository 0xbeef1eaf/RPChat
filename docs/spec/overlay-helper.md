# rp-overlay-wlr — native wlr-layer-shell overlay helper (Rust)

Location: `native/overlay-wlr/` (Cargo crate `rp-overlay-wlr`, binary of the same name).
Purpose: give the desktop app **real** layer-shell overlays on Wayland compositors that
implement `wlr-layer-shell-unstable-v1` (Hyprland first; also Sway, river, KDE Plasma).
Electron cannot create layer surfaces, so the app spawns this helper and drives it over
stdin/stdout. The helper renders the app's own `media.html` in a WebKitGTK web view inside
a GTK3 window that gtk-layer-shell turns into a layer surface. One helper process hosts
many overlays.

Stack: Rust 2021, crates `gtk` 0.18, `gdk` 0.18, `gtk-layer-shell` 0.8, `webkit2gtk` 2.0
(feature `v2_40`), `serde`/`serde_json`, `glib`. System libs: gtk+-3.0, gtk-layer-shell-0,
webkit2gtk-4.1 (Arch: `gtk3 gtk-layer-shell webkit2gtk-4.1`; Debian/Ubuntu:
`libgtk-3-0 libgtk-layer-shell0 libwebkit2gtk-4.1-0`). All are installed in this build
environment (pkg-config finds them), so the crate must compile here with `cargo build --release`.
No display is available here, so runtime is verified only through the protocol layer
(pure Rust, unit-tested) and a `--self-test` flag that exercises parsing/planning without GTK.

## Process protocol (JSON Lines, UTF-8, one object per line)

stdin → helper (requests). Every request may carry `"seq": n`; responses echo it.

| op | fields | reply |
|---|---|---|
| `hello` | `version: 1` | `{ ev: "ready", version, features: { layers: [...4], opacity, clickThrough, exactPosition: true, video: true } }` |
| `monitors` | – | `{ ev: "monitors", monitors: [MonitorInfo] }` — GDK monitors: `id` = `"<index>"`, `name` = model or connector when available, geometry = **work area** in logical px, `scale`, `primary` (index 0 or GDK primary), `hasCursor` from the pointer device position |
| `show` | `id, url, layer, anchor, marginPx, x?, y?, monitor?, width, height?, opacity, clickThrough, namespace?` | `{ ev: "shown", id }` after the window is mapped; the page size is fixed to `width`×`height` (height default 320 until the page reports `content-size`, see below) |
| `update` | `id, patch: { layer?, anchor?, marginPx?, x?, y?, monitor?, width?, height?, opacity?, clickThrough? }` | `{ ev: "updated", id }` |
| `js` | `id, script` | `{ ev: "js-done", id }` — runs the script in that overlay's web view (used to forward `MediaCommand`s to the page) |
| `close` | `id` | `{ ev: "closed", id }` |
| `closeAll` | – | one `closed` per overlay |
| `quit` | – | exits 0 |

helper → app (events): `ready`, `monitors`, `shown`, `updated`, `js-done`, `closed`,
`{ ev: "message", id, payload }` (a JSON value posted by the page through
`window.webkit.messageHandlers.rp.postMessage(JSON.stringify(payload))`), `{ ev: "error", id?, message }`,
`{ ev: "log", level, message }`.

Field semantics
- `layer`: `background | bottom | top | overlay` → `gtk_layer_set_layer`.
- `anchor`: `center | top-left | top-right | bottom-left | bottom-right`; with `x`/`y` present the
  anchor is forced to top-left and `margin_left = x`, `margin_top = y` (fractions 0..1 are resolved
  against the monitor work area in the helper); presets set the two matching edges and `marginPx` on both.
  `center` anchors nothing (compositor centres it).
- `monitor`: `{ index?: number, name?: string, x?: number, y?: number }` → `gtk_layer_set_monitor` with the
  GDK monitor matching index, else name, else the one whose geometry contains `(x, y)`, else default.
- `opacity`: `gtk_widget_set_opacity` on the window.
- `clickThrough`: empty input shape on the window (`gtk_widget_input_shape_combine_region` with an empty
  `cairo::Region`) and `gtk_layer_set_keyboard_mode(None)`; false restores the full shape. Keyboard mode is
  always `None` (overlays never take keyboard focus).
- `namespace` (default `rp-overlay`) → `gtk_layer_set_namespace`, so users can target it with Hyprland
  `layerrule`s. Exclusive zone is always 0.
- Window: `set_app_paintable(true)`, RGBA visual when available, decorated false, web view background
  transparent (`WebView::set_background_color` with alpha 0), `WebSettings`: media playback without user
  gesture, no developer extras, `enable_javascript`. The `UserContentManager` registers script message
  handler `rp` and injects a user script at document start defining `window.__rpHelper = true`.
- Page events: when a `message` payload is `{ type: "content-size", width, height }` and no explicit height
  was given, the helper resizes the window to that size (clamped to the monitor) and re-applies margins.

## Code layout

```
native/overlay-wlr/
├── Cargo.toml
├── src/main.rs        // arg parsing (--self-test, --log-level), GTK init, stdin reader thread → glib channel, dispatcher
├── src/protocol.rs    // serde types for requests/events; unit tests for parsing every op and rejecting bad ones
├── src/plan.rs        // pure: OverlayPlan (anchors, margins, size, monitor selection given a monitor list) from a Show/Update — unit-tested, no GTK
├── src/overlay.rs     // GTK window + layer-shell + webview management (one struct per overlay), applies OverlayPlan
└── src/monitors.rs    // GDK → MonitorInfo (behind a trait so plan tests use fixtures)
```

Build: `cargo build --release` produces `target/release/rp-overlay-wlr`. Add a root pnpm script
`"build:native": "cargo build --release --manifest-path native/overlay-wlr/Cargo.toml"`. The desktop app
looks for the binary at `process.env.RP_OVERLAY_HELPER`, then `resources/bin/rp-overlay-wlr` next to the
app (`process.resourcesPath` when packaged, `apps/desktop/resources/bin` in dev), then `PATH`.
Not found → the app falls back to the `hyprland-ipc` emulation and logs why.

Tests: `cargo test` (protocol + plan), and `cargo run -- --self-test` which parses a sample conversation
from stdin and prints the plans without touching GTK; exits 0.
