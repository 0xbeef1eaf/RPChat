#!/bin/sh
# electron-builder `deb.afterInstall`: set up the rpchatd daemon, udev rule and policy directory
# (no user-specific steps: --autostart none; the package ships its own menu entry: --menu-entry no).
# No policy file is written (no --policy-template): the policy is write-once and the first member
# of the rpchat group creates it from Settings → System, or an admin runs install.sh
# --policy-template / edits /etc/rpchat/policy.json as root. Tolerant: never fails the package installation.
set -u
APP_DIR="/opt/rpchat"
INSTALLER="$APP_DIR/resources/system/install.sh"
APP_BIN="$APP_DIR/rpchat"
if [ ! -f "$INSTALLER" ]; then
  echo "rpchat: system installer not bundled; skipping daemon setup"
  exit 0
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "rpchat: systemd not found; run $INSTALLER manually to set up the input daemon"
  exit 0
fi
if [ "$(id -u)" != "0" ]; then
  echo "rpchat: not running as root; run: sudo $INSTALLER --app-bin $APP_BIN --autostart none"
  exit 0
fi
sh "$INSTALLER" --app-bin "$APP_BIN" --autostart none --menu-entry no || echo "rpchat: system integration setup reported a problem (see above); the app still works without the daemon"
exit 0
