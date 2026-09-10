#!/usr/bin/env bash
# rp-code system integration installer (Linux).
#
# Installs the rp-coded daemon (input lock + injection), its systemd unit, the rp-code group,
# the udev rule / uinput module for fallback tools, the policy directory, an application menu
# entry + icon for the app (AppImage users get one this way), and an autostart entry for one user. Idempotent: every step prints "[ok] ..." when it changed something and
# "[skip] ..." when it was already done. Run as root (sudo or pkexec; the app runs it with
# pkexec and passes --app-bin). See docs/system-integration.md.
#
# Usage:
#   install.sh [--app-bin <path>] [--user <name>] [--autostart xdg|systemd|none]
#              [--menu-entry yes|no] [--policy-template] [--daemon-bin <path>] [--dry-run]
#   install.sh --uninstall [--user <name>] [--dry-run]
set -euo pipefail

GROUP=rp-code
LIBEXEC=/usr/local/libexec/rp-code
DAEMON_DST="$LIBEXEC/rp-coded"
UNIT_DST=/etc/systemd/system/rp-coded.service
UDEV_DST=/etc/udev/rules.d/70-rp-code.rules
MODULES_DST=/etc/modules-load.d/rp-code.conf
POLICY_DIR=/etc/rp-code
POLICY_DST="$POLICY_DIR/policy.json"
RUN_DIR=/run/rp-code
MENU_DST=/usr/local/share/applications/rp-code.desktop
ICON_DST=/usr/local/share/icons/hicolor/512x512/apps/rp-code.png

APP_BIN=""
TARGET_USER=""
AUTOSTART=xdg
MENU_ENTRY=yes
POLICY_TEMPLATE=false
DAEMON_BIN=""
UNINSTALL=false
DRY_RUN=false
NEED_RELOGIN=false

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-bin) APP_BIN="${2:?--app-bin needs a path}"; shift 2 ;;
    --user) TARGET_USER="${2:?--user needs a name}"; shift 2 ;;
    --autostart) AUTOSTART="${2:?--autostart needs xdg|systemd|none}"; shift 2 ;;
    --menu-entry) MENU_ENTRY="${2:?--menu-entry needs yes|no}"; shift 2 ;;
    --policy-template) POLICY_TEMPLATE=true; shift ;;
    --daemon-bin) DAEMON_BIN="${2:?--daemon-bin needs a path}"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
case "$AUTOSTART" in xdg|systemd|none) ;; *) echo "install.sh: --autostart must be xdg, systemd or none" >&2; exit 64 ;; esac
case "$MENU_ENTRY" in yes|no) ;; *) echo "install.sh: --menu-entry must be yes or no" >&2; exit 64 ;; esac

ok()   { printf '[ok]   %s\n' "$*"; }
skip() { printf '[skip] %s\n' "$*"; }
note() { printf '       %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die()  { printf '[fail] %s\n' "$*" >&2; exit 1; }
run()  { if $DRY_RUN; then printf '       + %s\n' "$*"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ] && ! $DRY_RUN; then
  die "run as root: sudo $0 $* (or pkexec)"
fi

# --- who is the user -------------------------------------------------------------------------
if [ -z "$TARGET_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    TARGET_USER="$SUDO_USER"
  elif [ -n "${PKEXEC_UID:-}" ]; then
    TARGET_USER="$(getent passwd "$PKEXEC_UID" | cut -d: -f1 || true)"
  fi
fi
USER_HOME=""
USER_UID=""
if [ -n "$TARGET_USER" ]; then
  entry="$(getent passwd "$TARGET_USER" || true)"
  [ -n "$entry" ] || die "user $TARGET_USER does not exist"
  USER_UID="$(echo "$entry" | cut -d: -f3)"
  USER_HOME="$(echo "$entry" | cut -d: -f6)"
fi

# --- where the files come from ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# Source tree: native/rp-coded/{install.sh,dist/,target/release/rp-coded}.
# Packaged app: resources/system/{install.sh,<dist files>} and resources/bin/rp-coded.
if [ -d "$SCRIPT_DIR/dist" ]; then DIST="$SCRIPT_DIR/dist"; else DIST="$SCRIPT_DIR"; fi
if [ -z "$DAEMON_BIN" ]; then
  for c in "$SCRIPT_DIR/rp-coded" "$SCRIPT_DIR/../bin/rp-coded" "$SCRIPT_DIR/target/release/rp-coded"; do
    if [ -x "$c" ]; then DAEMON_BIN="$c"; break; fi
  done
fi
APP_BIN_EXPLICIT=false
[ -n "$APP_BIN" ] && APP_BIN_EXPLICIT=true
if [ -z "$APP_BIN" ]; then
  # An AppImage next to the user's usual places wins over an extracted tree (see below).
  if [ -n "$USER_HOME" ]; then
    for d in "$USER_HOME/Applications" "$USER_HOME/.local/bin" "$USER_HOME/Downloads" "$USER_HOME"; do
      c="$(ls -t "$d"/rp-code*.AppImage 2>/dev/null | head -n 1 || true)"
      if [ -n "$c" ] && [ -x "$c" ]; then APP_BIN="$(readlink -f "$c")"; break; fi
    done
  fi
fi
if [ -z "$APP_BIN" ]; then
  for c in "${APPIMAGE:-}" "$SCRIPT_DIR/../../rp-code" "$SCRIPT_DIR/../../../rp-code" /opt/rp-code/rp-code /usr/lib/rp-code/rp-code /usr/bin/rp-code /usr/local/bin/rp-code; do
    if [ -n "$c" ] && [ -x "$c" ]; then APP_BIN="$(readlink -f "$c")"; break; fi
  done
fi
# Refuse the Electron binary inside an `--appimage-extract` tree: it only runs while the whole
# extraction (libffmpeg.so, resources, ...) stays around, and people delete that after installing.
is_appimage() { case "$1" in *.AppImage|*.appimage) return 0 ;; esac; [ "$(dd if="$1" bs=1 skip=8 count=2 2>/dev/null)" = "AI" ]; }
if [ -n "$APP_BIN" ] && ! is_appimage "$APP_BIN"; then
  case "$APP_BIN" in
    */squashfs-root/*)
      if $APP_BIN_EXPLICIT; then
        warn "$APP_BIN is inside an extracted AppImage tree; launchers will break if that folder is removed. Prefer --app-bin <path to the .AppImage>."
      else
        die "found only $APP_BIN (an extracted AppImage tree). Pass --app-bin with the path to the .AppImage itself, e.g. --app-bin \"\$(readlink -f rp-code-*.AppImage)\""
      fi
      ;;
    *)
      if [ ! -f "$(dirname "$APP_BIN")/libffmpeg.so" ]; then
        warn "$APP_BIN does not look like a complete app install (no libffmpeg.so next to it); if the app fails to start, re-run with --app-bin <path to the .AppImage>"
      fi
      ;;
  esac
fi
APP_EXEC="${APP_BIN:-rp-code}"
ICON_SRC=""
for c in "$SCRIPT_DIR/rp-code.png" "$SCRIPT_DIR/../../apps/desktop/build/icon.png"; do
  if [ -f "$c" ]; then ICON_SRC="$c"; break; fi
done

# install <src> <dst> <mode>: copy only when content differs; prints ok/skip.
install_file() {
  local src="$1" dst="$2" mode="$3"
  [ -f "$src" ] || die "missing $src"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    skip "$dst is up to date"
    return 1
  fi
  run install -D -m "$mode" -o root -g root "$src" "$dst"
  ok "installed $dst"
  return 0
}

# Refresh the desktop menu and icon caches when the tools exist (never fatal).
refresh_menus() {
  if have update-desktop-database; then run update-desktop-database "$(dirname "$MENU_DST")" 2>/dev/null || true; fi
  if have gtk-update-icon-cache; then run gtk-update-icon-cache -q -t /usr/local/share/icons/hicolor 2>/dev/null || true; fi
}

# Run systemctl --user as the target user when a session bus exists; prints otherwise.
user_systemctl() {
  local bus="/run/user/$USER_UID/bus"
  if [ -S "$bus" ] && have runuser; then
    run runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$USER_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=$bus" systemctl --user "$@"
    return 0
  fi
  return 1
}

as_user_write() { # as_user_write <dst> <content...>
  local dst="$1"; shift
  if $DRY_RUN; then note "+ write $dst"; return; fi
  mkdir -p "$(dirname "$dst")"
  printf '%s\n' "$@" > "$dst"
  chown -R "$TARGET_USER" "$(dirname "$dst")" 2>/dev/null || chown "$TARGET_USER" "$dst"
}

# =============================================================================================
# Uninstall
# =============================================================================================
if $UNINSTALL; then
  echo "rp-code system integration: uninstall"
  if have systemctl; then
    if systemctl is-enabled rp-coded >/dev/null 2>&1 || systemctl is-active rp-coded >/dev/null 2>&1; then
      run systemctl disable --now rp-coded; ok "stopped and disabled rp-coded.service"
    else
      skip "rp-coded.service not enabled"
    fi
  fi
  for f in "$UNIT_DST" "$UDEV_DST" "$MODULES_DST"; do
    if [ -e "$f" ]; then run rm -f "$f"; ok "removed $f"; else skip "$f absent"; fi
  done
  if have systemctl; then run systemctl daemon-reload 2>/dev/null || true; fi
  if have udevadm; then run udevadm control --reload || true; fi
  if [ -d "$LIBEXEC" ]; then run rm -rf "$LIBEXEC"; ok "removed $LIBEXEC"; else skip "$LIBEXEC absent"; fi
  for f in "$MENU_DST" "$ICON_DST"; do
    if [ -e "$f" ]; then run rm -f "$f"; ok "removed $f"; else skip "$f absent"; fi
  done
  refresh_menus
  if [ -d "$RUN_DIR" ]; then run rm -rf "$RUN_DIR"; ok "removed $RUN_DIR"; fi
  if [ -n "$TARGET_USER" ]; then
    xdg="$USER_HOME/.config/autostart/rp-code.desktop"
    unit="$USER_HOME/.config/systemd/user/rp-code.service"
    if [ -f "$unit" ]; then
      user_systemctl disable --now rp-code || note "run as $TARGET_USER: systemctl --user disable --now rp-code"
      run rm -f "$unit"; ok "removed $unit"
    else
      skip "$unit absent"
    fi
    if [ -f "$xdg" ]; then run rm -f "$xdg"; ok "removed $xdg"; else skip "$xdg absent"; fi
    if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
      run gpasswd -d "$TARGET_USER" "$GROUP" >/dev/null; ok "removed $TARGET_USER from group $GROUP (takes effect at next login)"
    else
      skip "$TARGET_USER not in group $GROUP"
    fi
  else
    note "no user given (--user); per-user autostart entries and group membership left alone"
  fi
  if getent group "$GROUP" >/dev/null; then
    if run groupdel "$GROUP" 2>/dev/null; then ok "removed group $GROUP"; else warn "could not remove group $GROUP (still someone's primary group?)"; fi
  else
    skip "group $GROUP absent"
  fi
  if [ -e "$POLICY_DST" ] || [ -d "$POLICY_DIR" ]; then
    note "kept $POLICY_DIR (the policy file). Remove it with: sudo rm -r $POLICY_DIR"
  fi
  ok "uninstall complete"
  exit 0
fi

# =============================================================================================
# Install
# =============================================================================================
echo "rp-code system integration: install"
[ -n "$DAEMON_BIN" ] || die "rp-coded binary not found (pass --daemon-bin, or build it: cargo build --release --manifest-path native/rp-coded/Cargo.toml)"
note "daemon binary: $DAEMON_BIN"
note "dist files:    $DIST"
note "app binary:    ${APP_BIN:-not found (autostart entry will use plain 'rp-code'; pass --app-bin)}"
note "user:          ${TARGET_USER:-none (user steps skipped; pass --user)}"

# 1. group ---------------------------------------------------------------------------------------
if getent group "$GROUP" >/dev/null; then
  skip "group $GROUP exists"
else
  run groupadd -f "$GROUP"; ok "created group $GROUP"
fi
if [ -n "$TARGET_USER" ]; then
  if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
    skip "$TARGET_USER is in group $GROUP"
  else
    run usermod -aG "$GROUP" "$TARGET_USER"; ok "added $TARGET_USER to group $GROUP"
    NEED_RELOGIN=true
  fi
fi

# 2. daemon + systemd unit -------------------------------------------------------------------------
daemon_changed=false
install_file "$DAEMON_BIN" "$DAEMON_DST" 0755 && daemon_changed=true || true
for f in README.md POLICY.md policy.example.json; do
  src="$SCRIPT_DIR/$f"; [ -f "$src" ] || src="$DIST/$f"
  [ -f "$src" ] && install_file "$src" "$LIBEXEC/$f" 0644 || true
done
unit_changed=false
install_file "$DIST/rp-coded.service" "$UNIT_DST" 0644 && unit_changed=true || true
# The policy directory must exist before the unit starts: it is the one path under /etc the
# hardened service may write to (write-once policy creation from the app, see POLICY.md).
if [ -d "$POLICY_DIR" ]; then skip "$POLICY_DIR exists"; else run install -d -m 0755 -o root -g root "$POLICY_DIR"; ok "created $POLICY_DIR"; fi
if have systemctl && [ -d /run/systemd/system ]; then
  run systemctl daemon-reload
  if systemctl is-enabled rp-coded >/dev/null 2>&1 && systemctl is-active rp-coded >/dev/null 2>&1; then
    if $daemon_changed || $unit_changed; then
      run systemctl restart rp-coded; ok "restarted rp-coded.service"
    else
      skip "rp-coded.service enabled and running"
    fi
  else
    run systemctl enable --now rp-coded; ok "enabled and started rp-coded.service"
  fi
else
  warn "systemd not running; start $DAEMON_DST as root yourself (or use $UNIT_DST as a reference)"
fi

# 3. udev rule + uinput module ---------------------------------------------------------------------
udev_changed=false
install_file "$DIST/70-rp-code.rules" "$UDEV_DST" 0644 && udev_changed=true || true
install_file "$DIST/rp-code.conf" "$MODULES_DST" 0644 || true
if [ -e /dev/uinput ]; then
  skip "uinput module loaded"
elif have modprobe; then
  if run modprobe uinput; then ok "loaded uinput module"; else warn "modprobe uinput failed (kernel without uinput?)"; fi
fi
if have udevadm; then
  if $udev_changed; then
    run udevadm control --reload && run udevadm trigger --subsystem-match=misc && ok "reloaded udev rules"
  else
    skip "udev rules unchanged"
  fi
fi

# 4. policy (the directory itself was created in step 2, before the service started) -----------------
if [ -e "$POLICY_DST" ]; then
  skip "$POLICY_DST exists (not touched)"
  if ! $DRY_RUN && [ "$(stat -c '%U:%G %a' "$POLICY_DST")" != "root:root 644" ]; then
    run chown root:root "$POLICY_DST"; run chmod 0644 "$POLICY_DST"; ok "fixed ownership of $POLICY_DST (root:root 0644)"
  fi
elif $POLICY_TEMPLATE; then
  run install -m 0644 -o root -g root "$DIST/policy.example.json" "$POLICY_DST"; ok "created $POLICY_DST from the template"
else
  skip "no policy file (defaults apply; create one once from Settings → System, or --policy-template writes the example to $POLICY_DST, see $LIBEXEC/POLICY.md)"
fi

# 5. application menu entry and icon (system-wide, so AppImage users get a launcher) ----------------
if [ "$MENU_ENTRY" = yes ]; then
  content="$(sed "s|^Exec=.*|Exec=$APP_EXEC %U|; s|^TryExec=.*|TryExec=$APP_EXEC|" "$DIST/rp-code.desktop")"
  if [ -f "$MENU_DST" ] && [ "$(cat "$MENU_DST")" = "$content" ]; then
    skip "$MENU_DST is up to date"
    changed=false
  else
    if $DRY_RUN; then note "+ write $MENU_DST"; else install -D -m 0644 -o root -g root /dev/null "$MENU_DST" && printf '%s\n' "$content" > "$MENU_DST"; fi
    ok "wrote $MENU_DST"
    changed=true
  fi
  if [ -n "$ICON_SRC" ]; then
    if install_file "$ICON_SRC" "$ICON_DST" 0644; then changed=true; fi
  else
    warn "app icon not found next to the installer; the menu entry will show a generic icon"
  fi
  if $changed; then refresh_menus; fi
else
  skip "application menu entry (--menu-entry no)"
fi

# 6. autostart for the user ------------------------------------------------------------------------
if [ -n "$TARGET_USER" ]; then
  xdg="$USER_HOME/.config/autostart/rp-code.desktop"
  unit="$USER_HOME/.config/systemd/user/rp-code.service"
  case "$AUTOSTART" in
    xdg)
      content="$(sed "s|^Exec=.*|Exec=$APP_EXEC --hidden|" "$DIST/rp-code-autostart.desktop")"
      if [ -f "$xdg" ] && [ "$(cat "$xdg")" = "$content" ]; then
        skip "$xdg is up to date"
      else
        as_user_write "$xdg" "$content"; ok "wrote $xdg"
      fi
      if [ -f "$unit" ]; then
        user_systemctl disable --now rp-code || note "run as $TARGET_USER: systemctl --user disable --now rp-code"
        run rm -f "$unit"; ok "removed $unit (switched to XDG autostart)"
      fi
      ;;
    systemd)
      content="$(sed "s|^ExecStart=.*|ExecStart=$APP_EXEC --hidden|" "$DIST/rp-code.service")"
      if [ -f "$unit" ] && [ "$(cat "$unit")" = "$content" ]; then
        skip "$unit is up to date"
      else
        as_user_write "$unit" "$content"; ok "wrote $unit"
      fi
      if user_systemctl daemon-reload && user_systemctl enable rp-code; then
        ok "enabled rp-code user unit for $TARGET_USER"
      else
        note "no session bus for $TARGET_USER; run as that user: systemctl --user enable --now rp-code"
      fi
      if [ -f "$xdg" ]; then run rm -f "$xdg"; ok "removed $xdg (switched to systemd user unit)"; fi
      ;;
    none)
      skip "autostart not configured (--autostart none)"
      ;;
  esac
  note "Hyprland users may prefer: exec-once = $APP_EXEC --hidden   (in ~/.config/hypr/hyprland.conf)"
else
  skip "autostart (no user)"
fi

# 7. device check ----------------------------------------------------------------------------------
if [ -x "$DAEMON_DST" ] && ! $DRY_RUN; then
  echo "device check ($DAEMON_DST --check-devices):"
  "$DAEMON_DST" --check-devices 2>&1 | sed 's/^/       /' || true
elif [ -x "$DAEMON_BIN" ]; then
  echo "device check ($DAEMON_BIN --check-devices):"
  "$DAEMON_BIN" --check-devices 2>&1 | sed 's/^/       /' || true
fi

ok "install complete"
if $NEED_RELOGIN; then
  note "$TARGET_USER must log out and back in for the $GROUP group membership to take effect"
  note "(until then the app cannot connect to $RUN_DIR/daemon.sock)."
fi
