#!/usr/bin/env bash
# Headful smoke test: runs the desktop app on an Xvfb display with a file-backed framebuffer,
# drives two mock-LLM turns (RP_MOCK_LLM=1 RP_SMOKE=1) — one showing media (an image, a video, audio and a
# widget embedding the image through an asset placeholder), one asking a
# question in a prompt window — captures every Electron window via
# capturePage and the whole framebuffer via xwd, and fails if the main process raised an
# uncaught exception (Electron shows those as an "Error" dialog window).
#
# Requires: Xvfb, xwd, xdotool, ImageMagick `convert`, and a built app (`pnpm --filter @rp/desktop build`).
# Usage: scripts/headful-smoke.sh [output-dir]   (default: /tmp/rp-headful-shots)
# Set RP_APP_BIN=<path to a packaged executable> to smoke a packaged build (electron-builder output)
# instead of the development entry point.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/rp-headful-shots}"
# Resolve a packaged binary relative to the caller's directory before we cd anywhere.
if [ -n "${RP_APP_BIN:-}" ]; then RP_APP_BIN="$(cd "$(dirname "$RP_APP_BIN")" && pwd)/$(basename "$RP_APP_BIN")"; fi
DISPLAY_NUM="${RP_DISPLAY:-:97}"
USERDATA="$(mktemp -d /tmp/rp-headful-data.XXXX)"
FBDIR="$(mktemp -d /tmp/rp-headful-fb.XXXX)"
rm -rf "$OUT"; mkdir -p "$OUT"

Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -fbdir "$FBDIR" -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
trap 'kill $XVFB_PID 2>/dev/null; rm -rf "$USERDATA" "$FBDIR"' EXIT
sleep 1.5

cd "$ROOT/apps/desktop"
if [ -n "${RP_APP_BIN:-}" ]; then
  APP_CMD=("$RP_APP_BIN" --no-sandbox)
else
  APP_CMD=(./node_modules/.bin/electron --no-sandbox out/main/index.js)
fi
DISPLAY="$DISPLAY_NUM" RP_MOCK_LLM=1 RP_SMOKE=1 RP_USER_DATA="$USERDATA" RP_SCREENSHOT_DIR="$OUT" \
  timeout "${RP_SMOKE_SECONDS:-90}" "${APP_CMD[@]}" >"$OUT/app.log" 2>&1 &
APP_PID=$!

# Wait for the window captures, max ~65 s. The mock turn's image closes itself 20 s after it is
# shown, so the framebuffer grab has to happen here rather than after the checks that follow.
for _ in $(seq 1 130); do
  grep -q "\[smoke\] screenshots done" "$OUT/app.log" 2>/dev/null && break
  sleep 0.5
done
sleep 1
DISPLAY="$DISPLAY_NUM" xwd -root -silent -out "$OUT/desktop.xwd" && convert "$OUT/desktop.xwd" "$OUT/00-desktop.png" && rm -f "$OUT/desktop.xwd"
# Then let the prompt-window check (a second turn, answered in its own window) finish, max ~20 s.
for _ in $(seq 1 40); do
  grep -q "\[smoke\] smoke done" "$OUT/app.log" 2>/dev/null && break
  sleep 0.5
done
WINDOWS="$(DISPLAY="$DISPLAY_NUM" xdotool search --onlyvisible --name "" 2>/dev/null | while read -r w; do DISPLAY="$DISPLAY_NUM" xdotool getwindowname "$w"; done | sed '/^$/d' | sort | uniq)"
kill "$APP_PID" 2>/dev/null

echo "--- windows"; echo "$WINDOWS"
echo "--- smoke log"; grep -E "\[(smoke|error)\]" "$OUT/app.log" | cut -c1-160
STATUS=0
if echo "$WINDOWS" | grep -qx "Error"; then echo "FAIL: Electron error dialog was shown (uncaught main-process exception)"; STATUS=1; fi
if ! grep -q "\[smoke\] action ok" "$OUT/app.log"; then echo "FAIL: the mock action did not run"; STATUS=1; fi
if ! ls "$OUT"/*-main-chat-session.png >/dev/null 2>&1; then echo "FAIL: no main-window screenshot"; STATUS=1; fi
if grep -qiE "typeerror|unhandled" "$OUT/app.log"; then echo "FAIL: TypeError/unhandled in app log"; STATUS=1; fi
if grep -qE "\[smoke\] verify [a-z]+: FAIL" "$OUT/app.log"; then echo "FAIL: media verification failed (see verify lines above)"; STATUS=1; fi
# `widget` proves a sandboxed widget iframe can load a pack image through an `{{asset:…}}` placeholder (pixel check).
for kind in image video audio widget; do grep -qE "\[smoke\] verify $kind: PASS" "$OUT/app.log" || { echo "FAIL: no PASS line for $kind"; STATUS=1; }; done
# A character's question must open a window of its own and its answer must reach the action.
if ! grep -q "\[smoke\] verify prompt: PASS" "$OUT/app.log"; then echo "FAIL: the prompt window did not open or its answer did not come back"; STATUS=1; fi
echo "--- screenshots in $OUT"; ls -1 "$OUT"/*.png
exit $STATUS
