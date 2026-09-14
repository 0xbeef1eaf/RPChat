#!/usr/bin/env bash
# Layer-shell smoke test: verifies the rp-overlay-wlr helper end to end against a nested
# wlr-layer-shell compositor (Sway, headless, software rendered).
#
#  1. Starts Sway headless on its own WAYLAND_DISPLAY and an Xvfb display for the app itself
#     (Chromium's Wayland path needs a DRM render node, which CI containers lack), handing the
#     compositor to the helper only, through RP_OVERLAY_WAYLAND_DISPLAY / RP_OVERLAY_XDG_RUNTIME_DIR.
#  2. Runs the app on X11 with displayBackend=hyprland and RP_OVERLAY_HELPER pointing at the
#     built helper; the app spawns the helper, which connects to Sway and renders media.html
#     from the app's loopback server as real layer surfaces.
#  3. Drives one mock-LLM turn (image + video + audio), captures the compositor with grim, and
#     verifies from pixels: the teal image bottom-right, the test-card video top-right and playing.
#
# Requires: sway, grim, Xvfb, ImageMagick, a built app and helper
# (`pnpm --filter @rp/desktop build`, `pnpm build:native`).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/rp-wlr-shots}"
HELPER="${RP_OVERLAY_HELPER:-$ROOT/native/overlay-wlr/target/release/rp-overlay-wlr}"
XDISPLAY="${RP_DISPLAY:-:96}"
RUNTIME="$(mktemp -d /tmp/rp-wlr-runtime.XXXX)"; chmod 700 "$RUNTIME"
USERDATA="$(mktemp -d /tmp/rp-wlr-data.XXXX)"
rm -rf "$OUT"; mkdir -p "$OUT"
[ -x "$HELPER" ] || { echo "helper binary not found: $HELPER (run pnpm build:native)"; exit 2; }

cat >"$RUNTIME/sway.conf" <<CFG
output HEADLESS-1 resolution 1600x1000 position 0,0 bg #203040 solid_color
default_border none
CFG
XDG_RUNTIME_DIR="$RUNTIME" WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
  sway -c "$RUNTIME/sway.conf" --unsupported-gpu >"$OUT/sway.log" 2>&1 &
SWAY_PID=$!
Xvfb "$XDISPLAY" -screen 0 1600x1000x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
trap 'pkill -P $SWAY_PID 2>/dev/null; kill $SWAY_PID $XVFB_PID 2>/dev/null; rm -rf "$RUNTIME" "$USERDATA"' EXIT
for _ in $(seq 1 40); do [ -S "$RUNTIME/wayland-1" ] && break; sleep 0.25; done
WL="$(basename "$(ls "$RUNTIME"/wayland-* 2>/dev/null | grep -v lock | head -1)")"
[ -n "$WL" ] || { echo "sway did not start"; cat "$OUT/sway.log"; exit 2; }

mkdir -p "$USERDATA/data"
echo '{"displayBackend":"hyprland"}' >"$USERDATA/data/settings.json"

cd "$ROOT/apps/desktop"
# Electron itself stays a plain X11 client (a WAYLAND_DISPLAY in its environment makes Chromium's GPU
# process probe Wayland/DRM and the window never paints); the helper gets the compositor via RP_OVERLAY_*.
env -u WAYLAND_DISPLAY DISPLAY="$XDISPLAY" RP_OVERLAY_WAYLAND_DISPLAY="$WL" RP_OVERLAY_XDG_RUNTIME_DIR="$RUNTIME" \
RP_OVERLAY_HELPER="$HELPER" RP_MOCK_LLM=1 RP_SMOKE=1 RP_USER_DATA="$USERDATA" RP_SCREENSHOT_DIR="$OUT" \
  timeout "${RP_SMOKE_SECONDS:-90}" ./node_modules/.bin/electron --no-sandbox --ozone-platform=x11 out/main/index.js >"$OUT/app.log" 2>&1 &
APP_PID=$!
# The mock turn's image closes itself 20 s after it is shown, so the compositor captures happen
# as soon as the window captures are done — before the prompt-window check, which follows them.
for _ in $(seq 1 100); do grep -q "\[smoke\] screenshots done" "$OUT/app.log" 2>/dev/null && break; sleep 0.5; done

G() { XDG_RUNTIME_DIR="$RUNTIME" WAYLAND_DISPLAY="$WL" grim "$@"; }
G "$OUT/00-compositor-a.png"; sleep 0.5; G "$OUT/00-compositor-b.png"
for _ in $(seq 1 40); do grep -q "\[smoke\] smoke done" "$OUT/app.log" 2>/dev/null && break; sleep 0.5; done
kill "$APP_PID" 2>/dev/null

echo "--- app log"; grep -E "\[(smoke|display|error)\]" "$OUT/app.log" | cut -c1-170
STATUS=0
grep -q "layer-shell helper ready" "$OUT/app.log" || { echo "FAIL: helper tier was not selected"; STATUS=1; }
grep -q "\[smoke\] action ok" "$OUT/app.log" || { echo "FAIL: mock action did not run"; STATUS=1; }
grep -qiE "typeerror|unhandled" "$OUT/app.log" && { echo "FAIL: TypeError/unhandled in app log"; STATUS=1; }
grep -qE "\[smoke\] verify [a-z]+: FAIL" "$OUT/app.log" && { echo "FAIL: in-app verification failed"; STATUS=1; }

# Pixel checks on the compositor capture. Widget: top-left, anchored 24 px from the edges, 300 wide,
# a 280x200 teal image inside a white page through a {{asset:…}} placeholder (loopback URL on the helper).
wteal="$(convert "$OUT/00-compositor-a.png" -crop 300x270+24+24 +repage -fuzz 18% -fill white -opaque '#2a9d8f' -fill black +opaque white -format '%[fx:mean]' info:)"
echo "widget: teal fraction in top-left region = $wteal"
awk -v t="$wteal" 'BEGIN{exit !(t>0.25)}' || { echo "FAIL: widget did not render the pack image top-left (fraction $wteal)"; STATUS=1; }

# Image: bottom-right, anchored 24 px from the edges, 320 wide.
teal="$(convert "$OUT/00-compositor-a.png" -crop 320x300+1256+676 +repage -fuzz 18% -fill white -opaque '#2a9d8f' -fill black +opaque white -format '%[fx:mean]' info:)"
echo "image: teal fraction in bottom-right region = $teal"
awk -v t="$teal" 'BEGIN{exit !(t>0.25)}' || { echo "FAIL: teal image not visible bottom-right (fraction $teal)"; STATUS=1; }
# Video: top-right 320x246; the test card has many colours and must change between the two captures.
colours="$(convert "$OUT/00-compositor-a.png" -crop 320x246+1256+24 +repage -format '%k' info:)"
rmse="$(compare -metric RMSE <(convert "$OUT/00-compositor-a.png" -crop 320x246+1256+24 +repage png:-) <(convert "$OUT/00-compositor-b.png" -crop 320x246+1256+24 +repage png:-) null: 2>&1 | sed 's/.*(\(.*\))/\1/')"
echo "video: unique colours top-right = $colours, frame change RMSE = $rmse"
[ "${colours:-0}" -ge 40 ] || { echo "FAIL: video overlay not rendering (only $colours colours)"; STATUS=1; }
awk -v r="$rmse" 'BEGIN{exit !(r>0.001)}' || { echo "FAIL: video frames did not advance (RMSE $rmse)"; STATUS=1; }
echo "--- captures in $OUT"; ls -1 "$OUT"/*.png
exit $STATUS
