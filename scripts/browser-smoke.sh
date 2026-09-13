#!/usr/bin/env bash
# Browser-extension smoke test: runs the desktop app on Xvfb in browser smoke mode
# (RP_MOCK_LLM=1 RP_SMOKE=1 RP_SMOKE_BROWSER=1), launches Chromium through playwright-core, and
# lets a mock-LLM turn drive `sdk.browser` end to end: open the loopback smoke page, read it,
# query/find/type/scroll, screenshot, click a link, and check that the `browser-navigated` host
# event reached a host subscriber and the character's own handler. A second turn exercises the
# 2.1 capabilities (block/unblock a pattern, image effect with a pack-asset replacement, home page
# + the new-tab override, bookmarks, eval in both worlds, history); `[smoke] verify browser
# capabilities: PASS` reports each one.
#
# Phase "unpacked" loads the extension with --load-extension (always). Phase "policy" writes the
# Chromium managed policy with the installer (root or passwordless sudo needed) and lets the
# browser force-install the app-signed CRX from the loopback update URL — proving the packaged
# path. RP_SMOKE_POLICY=auto (default: run it when root/sudo -n works) | 1 (required) | 0 (skip).
#
# Requires: Xvfb, a built app and extension (`pnpm build`), and a Chromium for playwright-core
# (RP_CHROMIUM_BIN, /opt/pw-browsers, or `pnpm --filter @rp/desktop exec playwright-core install chromium`).
# Usage: scripts/browser-smoke.sh [output-dir]   (default: /tmp/rp-browser-smoke)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/rp-browser-smoke}"
DISPLAY_NUM="${RP_DISPLAY:-:96}"
EXT_DIR="$ROOT/apps/desktop/resources/extension"
INSTALLER="$ROOT/native/rp-coded/install.sh"
POLICY_MODE="${RP_SMOKE_POLICY:-auto}"
rm -rf "$OUT"; mkdir -p "$OUT"

if [ ! -f "$EXT_DIR/manifest.json" ]; then echo "FAIL: $EXT_DIR/manifest.json missing (run pnpm build)"; exit 1; fi
if [ ! -f "$ROOT/apps/desktop/out/main/index.js" ]; then echo "FAIL: app not built (pnpm --filter @rp/desktop build)"; exit 1; fi

# Root, or passwordless sudo, is what the policy phase needs (it writes /etc/chromium/policies/managed).
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else SUDO="none"; fi
fi
case "$POLICY_MODE" in
  0|no|false) RUN_POLICY=false ;;
  1|yes|true) RUN_POLICY=true; [ "$SUDO" = none ] && { echo "FAIL: RP_SMOKE_POLICY=1 needs root or passwordless sudo"; exit 1; } ;;
  *) if [ "$SUDO" = none ]; then RUN_POLICY=false; else RUN_POLICY=true; fi ;;
esac
[ "$SUDO" = none ] && SUDO=""

Xvfb "$DISPLAY_NUM" -screen 0 1400x900x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
APP_PID=""
CHROME_PID=""
TMPDIRS=()
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  kill "$XVFB_PID" 2>/dev/null
  if $RUN_POLICY; then $SUDO "$INSTALLER" --remove-browser-policy >/dev/null 2>&1 || true; fi
  rm -rf "${TMPDIRS[@]}"
}
trap cleanup EXIT
for _ in $(seq 1 20); do [ -e "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break; sleep 0.25; done

STATUS=0
# run_phase <unpacked|policy>: start the app on a free port, hand Chromium the extension, wait for the verdict.
run_phase() {
  local MODE="$1"
  local LOG="$OUT/app-$MODE.log" CLOG="$OUT/chromium-$MODE.log" USERDATA CHROME_DATA PORT ID
  USERDATA="$(mktemp -d /tmp/rp-browser-data.XXXX)"; CHROME_DATA="$(mktemp -d /tmp/rp-browser-chrome.XXXX)"
  TMPDIRS+=("$USERDATA" "$CHROME_DATA")
  # A free port for the bridge so a developer's running app (47821) does not collide with the test.
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  echo "=== phase $MODE (bridge port $PORT)"
  (cd "$ROOT/apps/desktop" && DISPLAY="$DISPLAY_NUM" RP_MOCK_LLM=1 RP_SMOKE=1 RP_SMOKE_BROWSER=1 RP_BROWSER_BRIDGE_PORT="$PORT" RP_USER_DATA="$USERDATA" \
    exec timeout "${RP_SMOKE_SECONDS:-150}" ./node_modules/.bin/electron --no-sandbox out/main/index.js) >"$LOG" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 120); do
    grep -q "\[smoke\] browser bridge listening" "$LOG" 2>/dev/null && break
    sleep 0.5
  done
  if ! grep -q "\[smoke\] browser bridge listening" "$LOG"; then
    echo "FAIL: the app did not start its bridge"; grep -E "\[(smoke|error|main)\]" "$LOG" | cut -c1-200; STATUS=1; kill "$APP_PID" 2>/dev/null; APP_PID=""; return
  fi
  local LAUNCH=(node "$ROOT/scripts/browser-smoke-chromium.mjs" --port "$PORT" --extension "$EXT_DIR" --user-data "$CHROME_DATA")
  if [ "$MODE" = policy ]; then
    ID="$(curl -s "http://127.0.0.1:$PORT/extension/id")"
    echo "--- installer ($MODE): extension $ID"
    $SUDO "$INSTALLER" --browser-only --browser-extension "$ID" --browser-update-url "http://127.0.0.1:$PORT/extension/update.xml" | grep -E "^\[(ok|fail|warn)\]" | cut -c1-160
    LAUNCH+=(--mode policy --expect-id "$ID")
  fi
  (cd "$ROOT/apps/desktop" && DISPLAY="$DISPLAY_NUM" exec timeout "${RP_SMOKE_SECONDS:-150}" "${LAUNCH[@]}") >"$CLOG" 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 240); do
    grep -q "\[smoke\] browser smoke done" "$LOG" 2>/dev/null && break
    if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
    sleep 0.5
  done
  # The launcher's new-tab check runs alongside the app's last verification; let it report before we kill it.
  for _ in $(seq 1 16); do grep -q "\[chromium\] newtab →" "$CLOG" 2>/dev/null && break; sleep 0.5; done
  echo "--- chromium ($MODE)"; grep -E "^\[chromium\]" "$CLOG" | cut -c1-200
  echo "--- smoke log ($MODE)"; grep -E "\[(smoke|error|browser)\]" "$LOG" | cut -c1-240
  if ! grep -q "\[smoke\] browser extension connected" "$LOG"; then echo "FAIL ($MODE): the extension never connected to the bridge"; STATUS=1; fi
  if ! grep -q "\[smoke\] browser action ok" "$LOG"; then echo "FAIL ($MODE): the browser action did not succeed"; STATUS=1; fi
  if ! grep -q "\[smoke\] verify browser: PASS" "$LOG"; then echo "FAIL ($MODE): browser verification failed (see verify line above)"; STATUS=1; fi
  if ! grep -q "\[smoke\] verify browser capabilities: PASS" "$LOG"; then echo "FAIL ($MODE): browser capabilities verification failed (see the capabilities line above)"; STATUS=1; fi
  if ! grep -q "\[chromium\] newtab → http" "$CLOG"; then echo "FAIL ($MODE): the new-tab override did not open the home page (see the chromium lines above)"; STATUS=1; fi
  if grep -qiE "typeerror|unhandled" "$LOG"; then echo "FAIL ($MODE): TypeError/unhandled in app log"; STATUS=1; fi
  if [ "$MODE" = policy ] && ! grep -q "force-installed by policy" "$CLOG"; then echo "FAIL (policy): the browser did not force-install the extension from the policy"; STATUS=1; fi
  kill "$APP_PID" "$CHROME_PID" 2>/dev/null; wait "$APP_PID" "$CHROME_PID" 2>/dev/null; APP_PID=""; CHROME_PID=""
  if [ "$MODE" = policy ]; then $SUDO "$INSTALLER" --remove-browser-policy | grep -c "^\[ok\]   removed" | sed 's/^/--- policy files removed: /'; fi
}

run_phase unpacked
if $RUN_POLICY; then run_phase policy; else echo "=== phase policy skipped (no root/passwordless sudo; set RP_SMOKE_POLICY=1 to require it)"; fi
if [ $STATUS -eq 0 ]; then echo "browser smoke: PASS"; else echo "browser smoke: FAIL (logs in $OUT)"; fi
exit $STATUS
