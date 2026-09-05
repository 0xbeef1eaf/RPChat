#!/usr/bin/env bash
# Headful smoke test: runs the desktop app on an Xvfb display with a file-backed framebuffer,
# drives one mock-LLM turn (RP_MOCK_LLM=1 RP_SMOKE=1), captures every Electron window via
# capturePage and the whole framebuffer via xwd, and fails if the main process raised an
# uncaught exception (Electron shows those as an "Error" dialog window).
#
# Requires: Xvfb, xwd, xdotool, ImageMagick `convert`, and a built app (`pnpm --filter @rp/desktop build`).
# Usage: scripts/headful-smoke.sh [output-dir]   (default: /tmp/rp-headful-shots)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/rp-headful-shots}"
DISPLAY_NUM="${RP_DISPLAY:-:97}"
USERDATA="$(mktemp -d /tmp/rp-headful-data.XXXX)"
FBDIR="$(mktemp -d /tmp/rp-headful-fb.XXXX)"
rm -rf "$OUT"; mkdir -p "$OUT"

Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -fbdir "$FBDIR" -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
trap 'kill $XVFB_PID 2>/dev/null; rm -rf "$USERDATA" "$FBDIR"' EXIT
sleep 1.5

cd "$ROOT/apps/desktop"
DISPLAY="$DISPLAY_NUM" RP_MOCK_LLM=1 RP_SMOKE=1 RP_USER_DATA="$USERDATA" RP_SCREENSHOT_DIR="$OUT" \
  timeout "${RP_SMOKE_SECONDS:-45}" ./node_modules/.bin/electron --no-sandbox out/main/index.js >"$OUT/app.log" 2>&1 &
APP_PID=$!

# Wait for the smoke turn to finish (screenshots are its last step), max ~40 s.
for _ in $(seq 1 80); do
  grep -q "\[smoke\] screenshots done" "$OUT/app.log" 2>/dev/null && break
  sleep 0.5
done
sleep 1
DISPLAY="$DISPLAY_NUM" xwd -root -silent -out "$OUT/desktop.xwd" && convert "$OUT/desktop.xwd" "$OUT/00-desktop.png" && rm -f "$OUT/desktop.xwd"
WINDOWS="$(DISPLAY="$DISPLAY_NUM" xdotool search --onlyvisible --name "" 2>/dev/null | while read -r w; do DISPLAY="$DISPLAY_NUM" xdotool getwindowname "$w"; done | sed '/^$/d' | sort | uniq)"
kill "$APP_PID" 2>/dev/null

echo "--- windows"; echo "$WINDOWS"
echo "--- smoke log"; grep -E "\[(smoke|error)\]" "$OUT/app.log" | cut -c1-160
STATUS=0
if echo "$WINDOWS" | grep -qx "Error"; then echo "FAIL: Electron error dialog was shown (uncaught main-process exception)"; STATUS=1; fi
if ! grep -q "\[smoke\] action ok" "$OUT/app.log"; then echo "FAIL: the mock action did not run"; STATUS=1; fi
if ! ls "$OUT"/*-main-chat-session.png >/dev/null 2>&1; then echo "FAIL: no main-window screenshot"; STATUS=1; fi
if grep -qiE "typeerror|unhandled" "$OUT/app.log"; then echo "FAIL: TypeError/unhandled in app log"; STATUS=1; fi
echo "--- screenshots in $OUT"; ls -1 "$OUT"/*.png
exit $STATUS
