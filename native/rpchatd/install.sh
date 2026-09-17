#!/usr/bin/env bash
# rpchat system integration installer (Linux).
#
# Installs the rpchatd daemon (input lock + injection), its systemd unit, the rpchat group,
# the udev rule / uinput module for fallback tools, the policy directory, an application menu
# entry + icon for the app (AppImage users get one this way), an autostart entry for one user,
# and optionally the Chromium browser policy that force-installs the rpchat browser extension
# for one user (docs/browser-extension.md). With an AppImage as --app-bin it also does a "system install":
# the AppImage is unpacked to /opt/rpchat/current (root-owned; /opt/rpchat/previous keeps the
# last version, versions.json describes both, /usr/local/bin/rpchat points at it) so that later
# updates are applied by the daemon without a password prompt. Idempotent: every step prints
# "[ok] ..." when it changed something and "[skip] ..." when it was already done. Run as root
# (sudo or pkexec; the app runs it with pkexec and passes --app-bin). See docs/system-integration.md.
#
# Usage:
#   install.sh [--app-bin <path>] [--user <name>] [--autostart xdg|systemd|none]
#              [--menu-entry yes|no] [--policy-template] [--daemon-bin <path>] [--dry-run]
#              [--system-install | --no-system-install] [--guard | --no-guard]
#              [--browser-extension <id> --browser-update-url <url> [--browser-port <n>]
#               [--browser-policy-dir <dir>]... [--browser-only]]
#   install.sh --rollback [--dry-run]            swap /opt/rpchat/previous back to current
#   install.sh --remove [--dry-run]              remove the system install (daemon stays)
#   install.sh --refresh-daemon-files [--dry-run] reinstall the daemon binary/unit/udev files (no restart)
#   install.sh --remove-browser-policy [--browser-all-users] [--dry-run]
#   install.sh --guard | --no-guard [--dry-run]   session guard: pam_apparmor line + profiles (docs/system-integration.md)
#   install.sh --uninstall [--user <name>] [--dry-run]
# Tests: --prefix <dir> relocates every system path under <dir> and skips groups/services.
set -euo pipefail

# Session guard (policy.guard): the pam_apparmor session line goes into the file that every
# login path includes — Arch: system-login (sddm, login and sshd include it); Debian/Ubuntu:
# common-session. Marked so it can be found, replaced and removed.
PAM_FILES="/etc/pam.d/system-login /etc/pam.d/common-session"
PAM_MARK="# rpchat session guard"
PAM_LINE="session    optional   pam_apparmor.so      order=user,group,default $PAM_MARK"

GROUP=rpchat
LIBEXEC=/usr/local/libexec/rpchat
DAEMON_DST="$LIBEXEC/rpchatd"
UNIT_DST=/etc/systemd/system/rpchatd.service
UDEV_DST=/etc/udev/rules.d/70-rpchat.rules
MODULES_DST=/etc/modules-load.d/rpchat.conf
POLICY_DIR=/etc/rpchat
POLICY_DST="$POLICY_DIR/policy.json"
# Where the policy seal keeps a mirror copy (see POLICY.md "Sealing the policy"): outside /etc,
# so removing one directory does not unseal the machine.
STATE_DIR=/var/lib/rpchat
RUN_DIR=/run/rpchat
MENU_DST=/usr/local/share/applications/rpchat.desktop
ICON_THEME_DIR=/usr/local/share/icons/hicolor
# Sizes to install, largest first. One size is not enough: /usr/local/share/icons/hicolor carries no
# index.theme (the hicolor package owns the one under /usr/share), so a launcher that cannot read the
# Directories list there falls back to probing a hard-coded set of size directories, and several stop
# at 256x256 — a lone 512x512 icon is then invisible even though the .desktop file is found. Every
# size is a downscale of apps/desktop/build/icon-source.png, so each one carries real detail.
ICON_SIZES="512 128 64 48 32"
# System install: the unpacked app (docs/system-integration.md "System install").
INSTALL_ROOT=/opt/rpchat
BIN_LINK=/usr/local/bin/rpchat
# The policy is written for one user: "rpchat-<user>.json" (or "rpchat-uid-<n>.json" when the name
# is not filesystem-friendly), root-owned and readable by that user alone — the extension id and
# the bridge port in it are that user's. "rpchat.json" is the machine-wide file older versions
# wrote; it is deleted wherever a per-user one is installed.
BROWSER_POLICY_LEGACY=rpchat.json
# Chromium-based browsers on Linux read managed policies from these directories (each browser its
# own). Format: "<policy dir>|<config dir whose presence means the browser is installed>|<binaries on PATH>".
BROWSER_POLICY_DIRS="/etc/chromium/policies/managed|/etc/chromium|chromium chromium-browser
/etc/opt/chrome/policies/managed|/etc/opt/chrome|google-chrome google-chrome-stable
/etc/brave/policies/managed|/etc/brave|brave-browser brave
/etc/opt/edge/policies/managed|/etc/opt/edge|microsoft-edge microsoft-edge-stable
/etc/vivaldi/policies/managed|/etc/vivaldi|vivaldi vivaldi-stable
/etc/opera/policies/managed|/etc/opera|opera"
# Chromium and Chrome always get the policy (their policy dirs are created if needed); the others
# only when the browser looks installed (its binary on PATH or its /etc config dir present).
BROWSER_ALWAYS="/etc/chromium/policies/managed /etc/opt/chrome/policies/managed"

APP_BIN=""
TARGET_USER=""
AUTOSTART=xdg
MENU_ENTRY=yes
POLICY_TEMPLATE=false
DAEMON_BIN=""
UNINSTALL=false
DRY_RUN=false
NEED_RELOGIN=false
BROWSER_EXT=""
BROWSER_UPDATE_URL=""
BROWSER_PORT=""
# Extra managed-policy directories (--browser-policy-dir, repeatable): Chromium forks whose policy
# path is not in BROWSER_POLICY_DIRS. Written and removed like the built-in ones. Newline separated.
BROWSER_EXTRA_DIRS=""
BROWSER_ONLY=false
REMOVE_BROWSER_POLICY=false
# --browser-all-users: remove every user's policy file, not just this user's (what --uninstall does).
BROWSER_ALL_USERS=false
# auto: yes when --app-bin is an AppImage and the daemon is being installed.
SYSTEM_INSTALL=auto
# auto: engage when the daemon binary is installed and the policy file has guard.mode != off
# (the app passes --guard when its policy says so); yes/no force it; only: just that step.
GUARD=auto
GUARD_ARG=""
GUARD_ONLY=false
ROLLBACK=false
REMOVE_SYSTEM=false
REFRESH_DAEMON=false
PREFIX=""
# false with --prefix: no groups, services, udev, module loading or menu caches (file layout only).
SYSTEM_CMDS=true

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
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
    --browser-extension) BROWSER_EXT="${2:?--browser-extension needs an id}"; shift 2 ;;
    --browser-update-url) BROWSER_UPDATE_URL="${2:?--browser-update-url needs a URL}"; shift 2 ;;
    --browser-port) BROWSER_PORT="${2:?--browser-port needs a number}"; shift 2 ;;
    --browser-policy-dir)
      case "${2:?--browser-policy-dir needs an absolute directory}" in
        /*/policies/managed) ;;
        *) echo "install.sh: --browser-policy-dir must be an absolute path ending in /policies/managed (got $2)" >&2; exit 64 ;;
      esac
      case "$2" in *[[:space:]]*|*'|'*) echo "install.sh: --browser-policy-dir must not contain spaces or |" >&2; exit 64 ;; esac
      BROWSER_EXTRA_DIRS="$BROWSER_EXTRA_DIRS
$2"; shift 2 ;;
    --browser-only) BROWSER_ONLY=true; shift ;;
    --remove-browser-policy) REMOVE_BROWSER_POLICY=true; shift ;;
    --browser-all-users) BROWSER_ALL_USERS=true; shift ;;
    --system-install) SYSTEM_INSTALL=yes; shift ;;
    --no-system-install) SYSTEM_INSTALL=no; shift ;;
    --guard) GUARD=yes; GUARD_ARG=yes; GUARD_ONLY=true; shift ;;
    --no-guard) GUARD=no; GUARD_ARG=no; GUARD_ONLY=true; shift ;;
    --rollback) ROLLBACK=true; shift ;;
    --remove|--remove-system-install) REMOVE_SYSTEM=true; shift ;;
    --refresh-daemon-files) REFRESH_DAEMON=true; shift ;;
    --prefix)
      PREFIX="${2:?--prefix needs a directory}"
      case "$PREFIX" in /*) ;; *) echo "install.sh: --prefix must be an absolute path" >&2; exit 64 ;; esac
      PREFIX="${PREFIX%/}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
case "$AUTOSTART" in xdg|systemd|none) ;; *) echo "install.sh: --autostart must be xdg, systemd or none" >&2; exit 64 ;; esac
if [ -n "$PREFIX" ]; then
  # Relocate every system path (tests run the real steps against a scratch directory).
  LIBEXEC="$PREFIX$LIBEXEC"; DAEMON_DST="$LIBEXEC/rpchatd"; UNIT_DST="$PREFIX$UNIT_DST"
  UDEV_DST="$PREFIX$UDEV_DST"; MODULES_DST="$PREFIX$MODULES_DST"; POLICY_DIR="$PREFIX$POLICY_DIR"
  POLICY_DST="$POLICY_DIR/policy.json"; STATE_DIR="$PREFIX$STATE_DIR"
  RUN_DIR="$PREFIX$RUN_DIR"; MENU_DST="$PREFIX$MENU_DST"
  ICON_THEME_DIR="$PREFIX$ICON_THEME_DIR"; INSTALL_ROOT="$PREFIX$INSTALL_ROOT"; BIN_LINK="$PREFIX$BIN_LINK"
  PAM_FILES="$PREFIX/etc/pam.d/system-login $PREFIX/etc/pam.d/common-session"
  # The browser policy directories too: a test run must not write to (or delete from) the real /etc.
  BROWSER_POLICY_DIRS="$(printf '%s\n' "$BROWSER_POLICY_DIRS" | awk -v p="$PREFIX" -F'|' 'NF { print p $1 "|" p $2 "|" $3 }')"
  BROWSER_ALWAYS="$(for d in $BROWSER_ALWAYS; do printf '%s ' "$PREFIX$d"; done)"
  BROWSER_EXTRA_DIRS="$(printf '%s\n' "$BROWSER_EXTRA_DIRS" | awk -v p="$PREFIX" 'NF { print p $0 }')"
  SYSTEM_CMDS=false
fi
# --guard/--no-guard together with the normal install flags run the whole install with the guard
# forced; alone they run only the guard step.
if $GUARD_ONLY && { [ -n "$APP_BIN" ] || [ -n "$TARGET_USER" ] || $POLICY_TEMPLATE || [ "$SYSTEM_INSTALL" != auto ] || [ -n "$DAEMON_BIN" ]; }; then GUARD_ONLY=false; fi
case "$MENU_ENTRY" in yes|no) ;; *) echo "install.sh: --menu-entry must be yes or no" >&2; exit 64 ;; esac
if [ -n "$BROWSER_EXT" ] || $BROWSER_ONLY; then
  case "$BROWSER_EXT" in
    [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
    *) echo "install.sh: --browser-extension must be a 32-letter (a-p) extension id" >&2; exit 64 ;;
  esac
  case "$BROWSER_UPDATE_URL" in
    http://127.0.0.1:[0-9]*/extension/update.xml) ;;
    *) echo "install.sh: --browser-update-url must look like http://127.0.0.1:<port>/extension/update.xml" >&2; exit 64 ;;
  esac
  if [ -z "$BROWSER_PORT" ]; then BROWSER_PORT="$(echo "$BROWSER_UPDATE_URL" | sed -E 's|^http://127\.0\.0\.1:([0-9]+)/.*$|\1|')"; fi
  case "$BROWSER_PORT" in
    ''|*[!0-9]*) echo "install.sh: --browser-port must be a number" >&2; exit 64 ;;
  esac
  if [ "$BROWSER_PORT" -lt 1 ] || [ "$BROWSER_PORT" -gt 65535 ]; then echo "install.sh: --browser-port must be 1..65535" >&2; exit 64; fi
fi

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
  USER_HOME="$PREFIX$(echo "$entry" | cut -d: -f6)"
fi

# --- where the files come from ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# Source tree: native/rpchatd/{install.sh,dist/,target/release/rpchatd}.
# Packaged app: resources/system/{install.sh,<dist files>} and resources/bin/rpchatd.
if [ -d "$SCRIPT_DIR/dist" ]; then DIST="$SCRIPT_DIR/dist"; else DIST="$SCRIPT_DIR"; fi
if [ -z "$DAEMON_BIN" ]; then
  for c in "$SCRIPT_DIR/rpchatd" "$SCRIPT_DIR/../bin/rpchatd" "$SCRIPT_DIR/target/release/rpchatd"; do
    if [ -x "$c" ]; then DAEMON_BIN="$c"; break; fi
  done
fi
APP_BIN_EXPLICIT=false
[ -n "$APP_BIN" ] && APP_BIN_EXPLICIT=true
if [ -z "$APP_BIN" ] && [ -x "$INSTALL_ROOT/current/rpchat" ]; then
  # An existing system install is the app: nothing to look for.
  APP_BIN="$INSTALL_ROOT/current/rpchat"
fi
if [ -z "$APP_BIN" ]; then
  # An AppImage next to the user's usual places wins over an extracted tree (see below).
  if [ -n "$USER_HOME" ]; then
    for d in "$USER_HOME/Applications" "$USER_HOME/.local/bin" "$USER_HOME/Downloads" "$USER_HOME"; do
      c="$(ls -t "$d"/rpchat*.AppImage 2>/dev/null | head -n 1 || true)"
      if [ -n "$c" ] && [ -x "$c" ]; then APP_BIN="$(readlink -f "$c")"; break; fi
    done
  fi
fi
if [ -z "$APP_BIN" ]; then
  for c in "${APPIMAGE:-}" "$SCRIPT_DIR/../../rpchat" "$SCRIPT_DIR/../../../rpchat" /opt/rpchat/rpchat /usr/lib/rpchat/rpchat /usr/bin/rpchat /usr/local/bin/rpchat; do
    if [ -n "$c" ] && [ -x "$c" ]; then APP_BIN="$(readlink -f "$c")"; break; fi
  done
fi
# Refuse the Electron binary inside an `--appimage-extract` tree: it only runs while the whole
# extraction (libffmpeg.so, resources, ...) stays around, and people delete that after installing.
is_appimage() { case "$1" in *.AppImage|*.appimage) return 0 ;; esac; [ "$(dd if="$1" bs=1 skip=8 count=2 2>/dev/null)" = "AI" ]; }
if [ "$SYSTEM_INSTALL" = auto ]; then
  if [ -n "$APP_BIN" ] && is_appimage "$APP_BIN"; then SYSTEM_INSTALL=yes; else SYSTEM_INSTALL=no; fi
elif [ "$SYSTEM_INSTALL" = yes ] && { [ -z "$APP_BIN" ] || ! is_appimage "$APP_BIN"; }; then
  if ! $UNINSTALL && ! $REMOVE_SYSTEM && ! $ROLLBACK && ! $REFRESH_DAEMON && ! $BROWSER_ONLY && ! $REMOVE_BROWSER_POLICY; then
    die "--system-install needs --app-bin <path to the .AppImage> (got ${APP_BIN:-nothing})"
  fi
fi
if [ -n "$APP_BIN" ] && ! is_appimage "$APP_BIN"; then
  case "$APP_BIN" in
    */squashfs-root/*)
      if $APP_BIN_EXPLICIT; then
        warn "$APP_BIN is inside an extracted AppImage tree; launchers will break if that folder is removed. Prefer --app-bin <path to the .AppImage>."
      else
        die "found only $APP_BIN (an extracted AppImage tree). Pass --app-bin with the path to the .AppImage itself, e.g. --app-bin \"\$(readlink -f rpchat-*.AppImage)\""
      fi
      ;;
    *)
      if [ ! -f "$(dirname "$APP_BIN")/libffmpeg.so" ]; then
        warn "$APP_BIN does not look like a complete app install (no libffmpeg.so next to it); if the app fails to start, re-run with --app-bin <path to the .AppImage>"
      fi
      ;;
  esac
fi
APP_EXEC="${APP_BIN:-rpchat}"
# With a system install every launcher points at the stable root-owned copy, never at the AppImage.
if [ "$SYSTEM_INSTALL" = yes ]; then APP_EXEC="$INSTALL_ROOT/current/rpchat"; fi
# icon_src <size>: the artwork to install for one size, from the payload next to the installer first
# and the checked-out repo second, or empty when neither ships it. 512 keeps the historical names so
# an older payload still installs its one icon.
icon_src() {
  local size="$1" c
  if [ "$size" = 512 ]; then
    for c in "$SCRIPT_DIR/rpchat.png" "$SCRIPT_DIR/../../apps/desktop/build/icon.png"; do
      if [ -f "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
  else
    for c in "$SCRIPT_DIR/rpchat-$size.png" "$SCRIPT_DIR/../../apps/desktop/build/icon-$size.png"; do
      if [ -f "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
  fi
  return 0
}

# icon_dst <size>: where that size belongs in the hicolor theme.
icon_dst() { printf '%s/%sx%s/apps/rpchat.png\n' "$ICON_THEME_DIR" "$1" "$1"; }

# install_icons: every size the payload ships. Succeeds when at least one landed or was already
# current, so a partial payload still gets the menu entry an icon.
install_icons() {
  local size src found=false
  for size in $ICON_SIZES; do
    src="$(icon_src "$size")"
    [ -n "$src" ] || continue
    found=true
    if install_file "$src" "$(icon_dst "$size")" 0644; then icons_changed=true; fi
  done
  $found || return 1
  return 0
}

# install <src> <dst> <mode>: copy only when content differs; prints ok/skip. The copy lands
# next to the destination first and is renamed over it, so a running binary (the daemon
# replacing itself) or a reader never sees a half-written file.
install_file() {
  local src="$1" dst="$2" mode="$3"
  [ -f "$src" ] || die "missing $src"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    skip "$dst is up to date"
    return 1
  fi
  run install -D -m "$mode" -o root -g root "$src" "$dst.new"
  run mv -f "$dst.new" "$dst"
  ok "installed $dst"
  return 0
}

# Refresh the desktop menu and icon caches when the tools exist (never fatal).
refresh_menus() {
  $SYSTEM_CMDS || return 0
  if have update-desktop-database; then run update-desktop-database "$(dirname "$MENU_DST")" 2>/dev/null || true; fi
  if have gtk-update-icon-cache; then run gtk-update-icon-cache -q -t "$ICON_THEME_DIR" 2>/dev/null || true; fi
}

# Run systemctl --user as the target user when a session bus exists; prints otherwise.
user_systemctl() {
  local bus="/run/user/$USER_UID/bus"
  $SYSTEM_CMDS || return 1
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

# --- system install helpers (/opt/rpchat) --------------------------------------------------
# versions.json is written by this script and by the daemon (serde, pretty JSON, one key per
# line), so a line-based reader is enough: json_field <file> <current|previous> <key>.
json_field() {
  [ -f "$1" ] || return 0
  awk -v section="\"$2\":" -v key="\"$3\":" '
    $1 == section { inside = 1; next }
    inside && $1 ~ /^\}/ { inside = 0 }
    inside && $1 == key { v = $0; sub(/^[^:]*:[ \t]*"/, "", v); sub(/",?[ \t]*$/, "", v); print v; exit }
  ' "$1"
}

# write_versions <cur-version> <cur-at> <cur-source> [<prev-version> <prev-at> <prev-source>]
write_versions() {
  local f="$INSTALL_ROOT/versions.json"
  if $DRY_RUN; then note "+ write $f (current $1${4:+, previous $4})"; return; fi
  {
    printf '{\n  "current": {\n    "version": "%s",\n    "installedAt": "%s",\n    "source": "%s"\n  }' "$1" "$2" "$3"
    if [ -n "${4:-}" ]; then
      printf ',\n  "previous": {\n    "version": "%s",\n    "installedAt": "%s",\n    "source": "%s"\n  }' "$4" "$5" "$6"
    fi
    printf '\n}\n'
  } > "$f.tmp"
  chmod 0644 "$f.tmp" && mv -f "$f.tmp" "$f"
}

# The version an unpacked tree carries (electron-builder writes X-AppImage-Version into the
# desktop entry); falls back to the AppImage file name, then 0.0.0.
tree_version() { # tree_version <tree> [<appimage path>]
  local v=""
  v="$(grep -h -m1 '^X-AppImage-Version=' "$1"/*.desktop 2>/dev/null | head -n 1 | cut -d= -f2- || true)"
  if [ -z "$v" ] && [ -n "${2:-}" ]; then
    v="$(basename "$2" | sed -nE 's/^rpchat-([0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.-]*)-.*$/\1/p')"
  fi
  printf '%s' "${v:-0.0.0}"
}

# Refuse a tree that must not become root-owned under /opt: required files present, no
# setuid/setgid bits, no hard links, no symlinks leaving the tree, only files/dirs/symlinks.
check_tree() { # check_tree <tree>
  local t="$1" f target
  for f in rpchat libffmpeg.so resources/app.asar; do
    [ -f "$t/$f" ] || die "not an rpchat app tree: $f is missing in $t"
  done
  f="$(find "$t" -perm /6000 -print -quit)"; [ -z "$f" ] || die "refusing $t: $f has a setuid/setgid bit"
  f="$(find "$t" -type f -links +1 -print -quit)"; [ -z "$f" ] || die "refusing $t: $f is a hard link"
  f="$(find "$t" ! -type f ! -type d ! -type l -print -quit)"; [ -z "$f" ] || die "refusing $t: $f is not a file, directory or symlink"
  while IFS= read -r f; do
    target="$(readlink -f "$f" || true)"
    case "$target" in "$t"/*) ;; *) die "refusing $t: symlink $f points outside the tree ($(readlink "$f"))" ;; esac
  done < <(find "$t" -type l)
}

# The system install: unpack the AppImage into a staging directory, check it, take ownership,
# swap it into current/ (the old one becomes previous/), record versions.json, link the binary.
system_install_app() {
  local staging="$INSTALL_ROOT/.staging" tree version prev_version prev_at prev_source now
  local versions="$INSTALL_ROOT/versions.json"
  if $DRY_RUN; then
    note "+ $APP_BIN --appimage-extract  (in $staging)"
    note "+ check, chown -R root:root, chmod 0755/0644, mv current previous, mv squashfs-root current"
    note "+ write $versions; ln -s $INSTALL_ROOT/current/rpchat $BIN_LINK"
    ok "would install $APP_BIN to $INSTALL_ROOT/current"
    return
  fi
  [ -r "$APP_BIN" ] || die "cannot read $APP_BIN (an AppImage inside a running AppImage's mount is not readable by root; copy it out first)"
  rm -rf "$staging"
  install -d -m 0700 -o root -g root "$INSTALL_ROOT" 2>/dev/null || true
  chmod 0755 "$INSTALL_ROOT"
  install -d -m 0700 -o root -g root "$staging"
  (cd "$staging" && "$APP_BIN" --appimage-extract >/dev/null) || { rm -rf "$staging"; die "$APP_BIN --appimage-extract failed"; }
  tree="$staging/squashfs-root"
  [ -d "$tree" ] || { rm -rf "$staging"; die "$APP_BIN did not produce squashfs-root"; }
  # (subshell: check_tree dies with the reason; the staging area must still go)
  ( check_tree "$tree" ) || { rm -rf "$staging"; exit 1; }
  version="$(tree_version "$tree" "$APP_BIN")"
  if [ -f "$INSTALL_ROOT/current/rpchat" ] && [ "$(json_field "$versions" current version)" = "$version" ] && [ "$(json_field "$versions" current source)" = "$APP_BIN" ]; then
    rm -rf "$staging"
    skip "$INSTALL_ROOT/current is already $version from $APP_BIN"
  else
    chown -R root:root "$tree"
    chmod -R u=rwX,go=rX,a-s "$tree"
    prev_version="$(json_field "$versions" current version)"
    prev_at="$(json_field "$versions" current installedAt)"
    prev_source="$(json_field "$versions" current source)"
    rm -rf "$INSTALL_ROOT/previous" "$INSTALL_ROOT/.new"
    mv "$tree" "$INSTALL_ROOT/.new"
    rm -rf "$staging"
    if [ -d "$INSTALL_ROOT/current" ]; then mv "$INSTALL_ROOT/current" "$INSTALL_ROOT/previous"; fi
    mv "$INSTALL_ROOT/.new" "$INSTALL_ROOT/current"
    now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    if [ -n "$prev_version" ] && [ -d "$INSTALL_ROOT/previous" ]; then
      write_versions "$version" "$now" "$APP_BIN" "$prev_version" "${prev_at:-$now}" "${prev_source:-unknown}"
    else
      rm -rf "$INSTALL_ROOT/previous"
      write_versions "$version" "$now" "$APP_BIN"
    fi
    ok "installed $APP_BIN ($version) to $INSTALL_ROOT/current${prev_version:+ (previous: $prev_version)}"
  fi
  if [ "$(readlink "$BIN_LINK" 2>/dev/null || true)" = "$INSTALL_ROOT/current/rpchat" ]; then
    skip "$BIN_LINK → $INSTALL_ROOT/current/rpchat"
  else
    install -d -m 0755 "$(dirname "$BIN_LINK")"
    ln -sfn "$INSTALL_ROOT/current/rpchat" "$BIN_LINK"
    ok "linked $BIN_LINK → $INSTALL_ROOT/current/rpchat"
  fi
  note "the AppImage can be deleted now; launch rpchat from the menu or as $BIN_LINK"
}

remove_system_install() {
  local d
  if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$INSTALL_ROOT/current/rpchat" ]; then
    run rm -f "$BIN_LINK"; ok "removed $BIN_LINK"
  else
    skip "$BIN_LINK absent"
  fi
  if [ -d "$INSTALL_ROOT" ]; then
    for d in "$INSTALL_ROOT"/current "$INSTALL_ROOT"/previous "$INSTALL_ROOT"/.new "$INSTALL_ROOT"/.staging*; do
      if [ -e "$d" ]; then run rm -rf "$d"; ok "removed $d"; fi
    done
    if [ -e "$INSTALL_ROOT/versions.json" ]; then run rm -f "$INSTALL_ROOT/versions.json"; ok "removed $INSTALL_ROOT/versions.json"; fi
    # The .deb keeps its own files in /opt/rpchat; only an empty directory goes.
    if ! $DRY_RUN && [ -z "$(ls -A "$INSTALL_ROOT" 2>/dev/null)" ]; then rmdir "$INSTALL_ROOT" && ok "removed $INSTALL_ROOT"; fi
  else
    skip "$INSTALL_ROOT absent"
  fi
}

rollback_system_install() {
  local versions="$INSTALL_ROOT/versions.json" cv ca cs pv pa ps
  [ -f "$INSTALL_ROOT/previous/rpchat" ] || die "nothing to roll back to: $INSTALL_ROOT/previous is missing"
  [ -f "$INSTALL_ROOT/current/rpchat" ] || die "$INSTALL_ROOT/current is not an rpchat install"
  cv="$(json_field "$versions" current version)"; ca="$(json_field "$versions" current installedAt)"; cs="$(json_field "$versions" current source)"
  pv="$(json_field "$versions" previous version)"; pa="$(json_field "$versions" previous installedAt)"; ps="$(json_field "$versions" previous source)"
  if $DRY_RUN; then
    note "+ swap $INSTALL_ROOT/previous (${pv:-?}) and $INSTALL_ROOT/current (${cv:-?})"
    ok "would roll back to ${pv:-the previous version}"
    return
  fi
  rm -rf "$INSTALL_ROOT/.rollback"
  mv "$INSTALL_ROOT/current" "$INSTALL_ROOT/.rollback"
  mv "$INSTALL_ROOT/previous" "$INSTALL_ROOT/current"
  mv "$INSTALL_ROOT/.rollback" "$INSTALL_ROOT/previous"
  write_versions "${pv:-unknown}" "${pa:-unknown}" "${ps:-unknown}" "${cv:-unknown}" "${ca:-unknown}" "${cs:-unknown}"
  ok "rolled back $INSTALL_ROOT/current to ${pv:-the previous version} (${cv:-the replaced version} is now previous)"
  note "restart rpchat to run it; the next update goes forward again"
}

# --- session guard helpers ----------------------------------------------------------------
# The PAM file to edit: the first of PAM_FILES that exists.
pam_file() { local f; for f in $PAM_FILES; do if [ -f "$f" ]; then echo "$f"; return 0; fi; done; return 1; }

# pam_apparmor must run after pam_systemd_home (via the system-auth include) and pam_systemd:
# insert the marked line as the LAST session line — after `session required pam_env.so` when
# present, else after `-session optional pam_systemd.so`, else after the last session line,
# else at the end. Idempotent, and it collapses every other pam_apparmor session line into this
# one: with two lines PAM calls change_hat twice, the second call fails the magic-token check
# and the kernel leaves the login process in a profile that permits nothing — the login hangs
# with no message (docs/system-integration.md "Session guard", recovery).
pam_insert() { # pam_insert <file>
  local f="$1" tmp count
  count="$(grep -E '^[[:space:]]*-?session[[:space:]]' "$f" | grep -c 'pam_apparmor\.so' || true)"
  if [ "$count" = 1 ] && grep -qxF -- "$PAM_LINE" "$f"; then skip "$f already has the pam_apparmor line"; return 0; fi
  if $DRY_RUN; then
    if [ "$count" -gt 0 ]; then note "+ replace the $count pam_apparmor session line(s) in $f with: $PAM_LINE"
    else note "+ add to $f: $PAM_LINE"; fi
    ok "would update the pam_apparmor line in $f"; return 0
  fi
  tmp="$(mktemp "$f.XXXX")"
  awk -v line="$PAM_LINE" '
    /^[[:space:]]*-?session[[:space:]]/ && /pam_apparmor\.so/ { next }
    { lines[++n] = $0 }
    $1 == "session" && $2 == "required" && $3 == "pam_env.so" { env = n }
    ($1 == "-session" || $1 == "session") && $3 == "pam_systemd.so" { systemd = n }
    $1 == "session" || $1 == "-session" { last = n }
    END {
      at = env ? env : (systemd ? systemd : (last ? last : n))
      for (i = 1; i <= n; i++) { print lines[i]; if (i == at) print line }
      if (n == 0) print line
    }' "$f" > "$tmp" && chmod --reference="$f" "$tmp" && mv -f "$tmp" "$f"
  if [ "$count" -gt 1 ]; then warn "$f had $count pam_apparmor session lines, which hangs every login; collapsed them into one"
  elif [ "$count" = 1 ]; then ok "updated the pam_apparmor line in $f"
  else ok "added the pam_apparmor line to $f (last session line)"; fi
}

pam_remove() { # pam_remove <file>
  local f="$1" tmp
  if ! grep -qF -- "$PAM_MARK" "$f"; then skip "$f has no pam_apparmor line from rpchat"; return 0; fi
  if $DRY_RUN; then note "+ remove the marked line from $f"; ok "would remove the pam_apparmor line from $f"; return 0; fi
  tmp="$(mktemp "$f.XXXX")"
  awk -v mark="$PAM_MARK" 'index($0, mark) { next } { print }' "$f" > "$tmp" && chmod --reference="$f" "$tmp" && mv -f "$tmp" "$f"
  ok "removed the pam_apparmor line from $f"
  # Only rpchat's own line goes; say so if another one is left, since one alone is harmless
  # but a second one alongside a future --guard hangs every login.
  local left; left="$(grep -E '^[[:space:]]*-?session[[:space:]]' "$f" | grep -c 'pam_apparmor\.so' || true)"
  if [ "$left" -gt 0 ]; then warn "$f still has $left pam_apparmor session line(s) rpchat did not add; remove them by hand unless you put them there deliberately"; fi
  return 0
}

# Where the pam_apparmor module would be (Arch: the apparmor package; Debian/Ubuntu: libpam-apparmor).
have_pam_apparmor() {
  local d
  for d in /usr/lib/security /lib/security /usr/lib64/security /usr/lib/x86_64-linux-gnu/security /lib/x86_64-linux-gnu/security /usr/lib/aarch64-linux-gnu/security; do
    [ -f "$d/pam_apparmor.so" ] && return 0
  done
  return 1
}

# guard.mode in the policy file, "off" when absent (a line-based read is enough: the file is
# pretty JSON from the daemon or the template, one key per line).
policy_guard_mode() {
  [ -f "$POLICY_DST" ] || { echo off; return; }
  awk '/"guard"[[:space:]]*:/ { inside = 1 } inside && /"mode"[[:space:]]*:/ { v = $0; sub(/^[^:]*:[[:space:]]*"/, "", v); sub(/".*$/, "", v); print v; exit }' "$POLICY_DST" | grep -E '^(off|audit|enforce)$' || echo off
}

# Engage: PAM line + `rpchatd --guard-apply` (writes and loads the profiles from the policy).
guard_engage() {
  local f
  if [ ! -d /sys/kernel/security/apparmor ] && $SYSTEM_CMDS; then
    warn "AppArmor is not active (/sys/kernel/security/apparmor missing): boot with lsm=...,apparmor and the apparmor package installed; the guard stays unavailable"
  fi
  if $SYSTEM_CMDS && ! have_pam_apparmor; then
    warn "pam_apparmor.so not found: install it (Arch: part of the apparmor package; Debian/Ubuntu: libpam-apparmor) or sessions will not be confined"
  fi
  if f="$(pam_file)"; then pam_insert "$f"; else warn "no PAM file to edit (${PAM_FILES}); add manually: $PAM_LINE"; fi
  if $SYSTEM_CMDS && [ -x "$DAEMON_DST" ]; then
    if $DRY_RUN; then note "+ $DAEMON_DST --guard-apply"; else
      if "$DAEMON_DST" --guard-apply | sed 's/^/       /'; then ok "session guard applied from $POLICY_DST"; else warn "rpchatd --guard-apply reported a problem (see above and journalctl -u rpchatd)"; fi
    fi
  else
    skip "profile load (no daemon binary, or --prefix); the daemon applies the guard when it starts"
  fi
  note "the guard confines sessions opened after this point: log out and back in"
}

guard_disengage() {
  local f
  if f="$(pam_file)"; then pam_remove "$f"; else skip "no PAM file (${PAM_FILES})"; fi
  if $SYSTEM_CMDS && [ -x "$DAEMON_DST" ]; then
    if $DRY_RUN; then note "+ $DAEMON_DST --guard-off"; else
      if "$DAEMON_DST" --guard-off | sed 's/^/       /'; then ok "session guard profiles unloaded"; else warn "rpchatd --guard-off reported a problem"; fi
    fi
  else
    skip "profile unload (no daemon binary, or --prefix)"
  fi
}

# --- browser policy helpers -----------------------------------------------------------------
# Policy directories that should get (or lose) the file: the always-on ones plus every browser
# that looks installed. Prints one directory per line.
browser_policy_targets() {
  local line dir cfg bins b
  {
    echo "$BROWSER_POLICY_DIRS" | while IFS='|' read -r dir cfg bins; do
      [ -n "$dir" ] || continue
      case " $BROWSER_ALWAYS " in *" $dir "*) echo "$dir"; continue ;; esac
      if [ -d "$cfg" ] || [ -d "$dir" ]; then echo "$dir"; continue; fi
      for b in $bins; do if have "$b"; then echo "$dir"; break; fi; done
    done
    # Extra directories from --browser-policy-dir always get the file (the user named them on purpose).
    echo "$BROWSER_EXTRA_DIRS" | while read -r dir; do if [ -n "$dir" ]; then echo "$dir"; fi; done
  } | awk '!seen[$0]++'
}

browser_policy_json() { # browser_policy_json <id> <update-url> <port>
  # The same JSON as apps/desktop/src/main/browser/policy.ts. The home page is not in here: only a
  # character sets one, through sdk.browser.setHomePage and the extension's new-tab override.
  printf '{\n  "ExtensionInstallForcelist": ["%s;%s"],\n  "ExtensionInstallSources": ["http://127.0.0.1:%s/*"],\n  "3rdparty": { "extensions": { "%s": { "policy": { "port": %s } } } }\n}\n' "$1" "$2" "$3" "$1" "$3"
}

# The user the policy is for: --user, else whoever called sudo/pkexec, else root (who is running it).
browser_policy_user() { if [ -n "$TARGET_USER" ]; then printf '%s' "$TARGET_USER"; else printf 'root'; fi; }
browser_policy_uid()  { if [ -n "$USER_UID" ]; then printf '%s' "$USER_UID"; else printf '0'; fi; }
# One file per user. A name with anything but [A-Za-z0-9._-] in it (rare, but "DOMAIN\\user" happens
# with winbind/sssd) would be awkward in a policy directory, so those get the uid instead.
browser_policy_file() { # browser_policy_file <user> <uid>
  case "$1" in
    *[!A-Za-z0-9._-]*) printf 'rpchat-uid-%s.json' "$2" ;;
    *) printf 'rpchat-%s.json' "$1" ;;
  esac
}

# Only the one user may read the file, and nobody but root may write it: Chromium skips a policy
# file it cannot read, which is what keeps one user's extension id and bridge port out of another
# user's browser, while root ownership keeps the user from editing their own policy.
BROWSER_ACL_NOTE=""
browser_policy_restrict() { # browser_policy_restrict <path> <user> <uid>
  local path="$1" user="$2" uid="$3" gid
  if $DRY_RUN; then
    note "+ chown root:root $path && chmod 0600 $path"
    if [ "$uid" != 0 ]; then note "+ setfacl -m u:$user:r $path"; fi
    return 0
  fi
  chown root:root "$path"
  chmod 0600 "$path"
  # root reads it whatever the mode says; no ACL needed (and none possible for a file it owns anyway).
  if [ "$uid" = 0 ]; then return 0; fi
  if have setfacl && setfacl -m "u:$user:r" "$path" 2>/dev/null; then return 0; fi
  # No ACLs (no setfacl, or a filesystem without them): the group bit is the next best thing.
  gid="$(getent passwd "$user" | cut -d: -f4)"
  if [ -n "$gid" ] && chgrp "$gid" "$path" 2>/dev/null; then
    chmod 0640 "$path"
    BROWSER_ACL_NOTE="no POSIX ACLs here (setfacl missing or unsupported): the file is group-readable (gid $gid) instead, so everyone in that group gets this policy"
    return 0
  fi
  chmod 0644 "$path"
  BROWSER_ACL_NOTE="neither ACLs nor the user's group could be used: the file is world-readable, so other users' browsers get this policy too"
}

install_browser_policy() {
  local content dir dst legacy user uid file
  user="$(browser_policy_user)"; uid="$(browser_policy_uid)"; file="$(browser_policy_file "$user" "$uid")"
  content="$(browser_policy_json "$BROWSER_EXT" "$BROWSER_UPDATE_URL" "$BROWSER_PORT")"
  note "browser extension $BROWSER_EXT from $BROWSER_UPDATE_URL (port $BROWSER_PORT)"
  note "for $user alone: $file, owned by root and readable only by $user (the id and the port are that user's)"
  for dir in $(browser_policy_targets); do
    dst="$dir/$file"
    # The machine-wide file older versions wrote applied to whoever used that browser: drop it.
    legacy="$dir/$BROWSER_POLICY_LEGACY"
    if [ -e "$legacy" ]; then run rm -f "$legacy"; ok "removed the machine-wide $legacy"; fi
    if ! $DRY_RUN && [ -f "$dst" ] && [ "$(cat "$dst")" = "$content" ]; then
      browser_policy_restrict "$dst" "$user" "$uid"   # the content is right; make sure the access still is
      skip "$dst is up to date"
      continue
    fi
    if $DRY_RUN; then
      note "+ install -d -m 0755 $dir"
      note "+ write $dst"
      browser_policy_restrict "$dst" "$user" "$uid"
    else
      install -d -m 0755 -o root -g root "$dir"
      # 0600 from the start (umask), restricted while still private, then renamed into place:
      # no moment in which another user could read it.
      ( umask 077; printf '%s' "$content" > "$dst.tmp" )
      browser_policy_restrict "$dst.tmp" "$user" "$uid"
      mv -f "$dst.tmp" "$dst"
    fi
    ok "wrote $dst"
  done
  if [ -n "$BROWSER_ACL_NOTE" ]; then warn "$BROWSER_ACL_NOTE"; fi
  note "Chromium-based browsers pick the policy up within minutes or at their next start (chrome://policy → Reload policies)."
  note "Google Chrome on Windows/macOS only force-installs Web Store extensions; this policy works with Linux Chrome and every Chromium build."
}

# remove_browser_policy [all]: this user's policy file (and the old machine-wide one), or with
# "all" every user's — what --uninstall does, since it tears the machine down for everybody.
remove_browser_policy() {
  local dir cfg bins dst user uid file
  user="$(browser_policy_user)"; uid="$(browser_policy_uid)"; file="$(browser_policy_file "$user" "$uid")"
  {
    # (`if`, not `&&`: with an empty list the last `[ -n ]` would make the loop, the group and —
    # with pipefail — the whole pipeline exit 1, which `set -e` turned into a silent early exit)
    echo "$BROWSER_POLICY_DIRS" | while IFS='|' read -r dir cfg bins; do if [ -n "$dir" ]; then echo "$dir"; fi; done
    echo "$BROWSER_EXTRA_DIRS" | while read -r dir; do if [ -n "$dir" ]; then echo "$dir"; fi; done
  } | awk '!seen[$0]++' | while read -r dir; do
    if [ "${1:-}" = all ]; then
      # An unmatched glob stays literal, so every candidate is checked before it is removed.
      for dst in "$dir/$BROWSER_POLICY_LEGACY" "$dir"/rpchat-*.json; do
        if [ -e "$dst" ]; then run rm -f "$dst"; ok "removed $dst"; fi
      done
    else
      for dst in "$dir/$file" "$dir/$BROWSER_POLICY_LEGACY"; do
        if [ -e "$dst" ]; then run rm -f "$dst"; ok "removed $dst"; else skip "$dst absent"; fi
      done
    fi
  done
}

if $REMOVE_BROWSER_POLICY; then
  echo "rpchat browser policy: remove"
  if $BROWSER_ALL_USERS; then remove_browser_policy all; else remove_browser_policy; fi
  ok "browser policy removed"
  exit 0
fi

if $BROWSER_ONLY; then
  echo "rpchat browser policy: install"
  install_browser_policy
  ok "browser policy installed"
  exit 0
fi

if $GUARD_ONLY; then
  if [ "$GUARD" = yes ]; then
    echo "rpchat session guard: engage"
    guard_engage
    ok "session guard engaged"
  else
    echo "rpchat session guard: disengage"
    guard_disengage
    ok "session guard disengaged"
  fi
  exit 0
fi

if $ROLLBACK; then
  echo "rpchat system install: rollback"
  rollback_system_install
  exit 0
fi

if $REMOVE_SYSTEM; then
  echo "rpchat system install: remove"
  remove_system_install
  ok "system install removed"
  exit 0
fi

# =============================================================================================
# Refresh the daemon's own files (run by rpchatd after an update whose bundle ships a newer
# daemon): binary, unit, udev rule, module list, docs, menu entry and icon — the same list as the
# install below, no group/user/autostart/policy steps and no service restart (the daemon
# restarts itself once the input lock is free).
# =============================================================================================
if $REFRESH_DAEMON; then
  echo "rpchat system integration: refresh daemon files"
  [ -n "$DAEMON_BIN" ] || die "rpchatd binary not found next to $SCRIPT_DIR"
  note "daemon binary: $DAEMON_BIN"
  install_file "$DAEMON_BIN" "$DAEMON_DST" 0755 || true
  for f in README.md POLICY.md policy.example.json policy.all-on.json; do
    src="$SCRIPT_DIR/$f"; [ -f "$src" ] || src="$DIST/$f"
    [ -f "$src" ] && install_file "$src" "$LIBEXEC/$f" 0644 || true
  done
  install_file "$DIST/rpchatd.service" "$UNIT_DST" 0644 || true
  udev_changed=false
  install_file "$DIST/70-rpchat.rules" "$UDEV_DST" 0644 && udev_changed=true || true
  install_file "$DIST/rpchat.conf" "$MODULES_DST" 0644 || true
  if [ -f "$MENU_DST" ]; then
    content="$(sed "s|^Exec=.*|Exec=$APP_EXEC %U|; s|^TryExec=.*|TryExec=$APP_EXEC|" "$DIST/rpchat.desktop")"
    if [ "$(cat "$MENU_DST")" = "$content" ]; then skip "$MENU_DST is up to date"; else
      if $DRY_RUN; then note "+ write $MENU_DST"; else printf '%s\n' "$content" > "$MENU_DST.new" && chmod 0644 "$MENU_DST.new" && mv -f "$MENU_DST.new" "$MENU_DST"; fi
      ok "wrote $MENU_DST"
    fi
    icons_changed=false
    install_icons || true
    refresh_menus
  fi
  if $SYSTEM_CMDS && have systemctl && [ -d /run/systemd/system ]; then run systemctl daemon-reload; fi
  if $SYSTEM_CMDS && $udev_changed && have udevadm; then run udevadm control --reload || true; fi
  ok "daemon files refreshed ($DAEMON_DST); restart rpchatd to run the new binary"
  exit 0
fi

# =============================================================================================
# Uninstall
# =============================================================================================
if $UNINSTALL; then
  echo "rpchat system integration: uninstall"
  guard_disengage
  if $SYSTEM_CMDS && have systemctl; then
    if systemctl is-enabled rpchatd >/dev/null 2>&1 || systemctl is-active rpchatd >/dev/null 2>&1; then
      run systemctl disable --now rpchatd; ok "stopped and disabled rpchatd.service"
    else
      skip "rpchatd.service not enabled"
    fi
  fi
  for f in "$UNIT_DST" "$UDEV_DST" "$MODULES_DST"; do
    if [ -e "$f" ]; then run rm -f "$f"; ok "removed $f"; else skip "$f absent"; fi
  done
  if $SYSTEM_CMDS && have systemctl; then run systemctl daemon-reload 2>/dev/null || true; fi
  if $SYSTEM_CMDS && have udevadm; then run udevadm control --reload || true; fi
  if [ -d "$LIBEXEC" ]; then run rm -rf "$LIBEXEC"; ok "removed $LIBEXEC"; else skip "$LIBEXEC absent"; fi
  remove_system_install
  icon_files=""
  for size in $ICON_SIZES; do icon_files="$icon_files $(icon_dst "$size")"; done
  for f in "$MENU_DST" $icon_files; do
    if [ -e "$f" ]; then run rm -f "$f"; ok "removed $f"; else skip "$f absent"; fi
  done
  refresh_menus
  if [ -d "$RUN_DIR" ]; then run rm -rf "$RUN_DIR"; ok "removed $RUN_DIR"; fi
  if [ -n "$TARGET_USER" ]; then
    xdg="$USER_HOME/.config/autostart/rpchat.desktop"
    unit="$USER_HOME/.config/systemd/user/rpchat.service"
    if [ -f "$unit" ]; then
      user_systemctl disable --now rpchat || note "run as $TARGET_USER: systemctl --user disable --now rpchat"
      run rm -f "$unit"; ok "removed $unit"
    else
      skip "$unit absent"
    fi
    if [ -f "$xdg" ]; then run rm -f "$xdg"; ok "removed $xdg"; else skip "$xdg absent"; fi
    if ! $SYSTEM_CMDS; then
      skip "group membership (--prefix)"
    elif id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
      run gpasswd -d "$TARGET_USER" "$GROUP" >/dev/null; ok "removed $TARGET_USER from group $GROUP (takes effect at next login)"
    else
      skip "$TARGET_USER not in group $GROUP"
    fi
  else
    note "no user given (--user); per-user autostart entries and group membership left alone"
  fi
  if ! $SYSTEM_CMDS; then
    skip "group $GROUP (--prefix)"
  elif getent group "$GROUP" >/dev/null; then
    if run groupdel "$GROUP" 2>/dev/null; then ok "removed group $GROUP"; else warn "could not remove group $GROUP (still someone's primary group?)"; fi
  else
    skip "group $GROUP absent"
  fi
  remove_browser_policy all
  if [ -e "$POLICY_DST" ] || [ -d "$POLICY_DIR" ]; then
    note "kept $POLICY_DIR (the policy file). Remove it with: sudo rm -r $POLICY_DIR"
  fi
  ok "uninstall complete"
  exit 0
fi

# =============================================================================================
# Install
# =============================================================================================
echo "rpchat system integration: install"
[ -n "$DAEMON_BIN" ] || die "rpchatd binary not found (pass --daemon-bin, or build it: cargo build --release --manifest-path native/rpchatd/Cargo.toml)"
note "daemon binary: $DAEMON_BIN"
note "dist files:    $DIST"
note "app binary:    ${APP_BIN:-not found (autostart entry will use plain 'rpchat'; pass --app-bin)}"
if [ "$SYSTEM_INSTALL" = yes ]; then note "system install: $INSTALL_ROOT/current (from the AppImage; launchers use $APP_EXEC)"; else note "system install: no (--no-system-install, or --app-bin is not an AppImage)"; fi
note "user:          ${TARGET_USER:-none (user steps skipped; pass --user)}"
[ -z "$PREFIX" ] || note "prefix:        $PREFIX (files only; no groups, services or udev)"

# 1. group ---------------------------------------------------------------------------------------
if ! $SYSTEM_CMDS; then
  skip "group $GROUP (--prefix)"
elif getent group "$GROUP" >/dev/null; then
  skip "group $GROUP exists"
else
  run groupadd -f "$GROUP"; ok "created group $GROUP"
fi
if [ -n "$TARGET_USER" ] && $SYSTEM_CMDS; then
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
for f in README.md POLICY.md policy.example.json policy.all-on.json; do
  src="$SCRIPT_DIR/$f"; [ -f "$src" ] || src="$DIST/$f"
  [ -f "$src" ] && install_file "$src" "$LIBEXEC/$f" 0644 || true
done
unit_changed=false
install_file "$DIST/rpchatd.service" "$UNIT_DST" 0644 && unit_changed=true || true
# The policy directory must exist before the unit starts: it is the one path under /etc the
# hardened service may write to (write-once policy creation from the app, see POLICY.md).
if [ -d "$POLICY_DIR" ]; then skip "$POLICY_DIR exists"; else run install -d -m 0755 -o root -g root "$POLICY_DIR"; ok "created $POLICY_DIR"; fi
# The seal's mirror directory, for the same reason: it must exist before the daemon writes one.
if [ -d "$STATE_DIR" ]; then skip "$STATE_DIR exists"; else run install -d -m 0750 -o root -g root "$STATE_DIR"; ok "created $STATE_DIR"; fi
if ! $SYSTEM_CMDS; then
  skip "systemd service (--prefix)"
elif have systemctl && [ -d /run/systemd/system ]; then
  run systemctl daemon-reload
  if systemctl is-enabled rpchatd >/dev/null 2>&1 && systemctl is-active rpchatd >/dev/null 2>&1; then
    if $daemon_changed || $unit_changed; then
      run systemctl restart rpchatd; ok "restarted rpchatd.service"
    else
      skip "rpchatd.service enabled and running"
    fi
  else
    run systemctl enable --now rpchatd; ok "enabled and started rpchatd.service"
  fi
else
  warn "systemd not running; start $DAEMON_DST as root yourself (or use $UNIT_DST as a reference)"
fi

# 3. udev rule + uinput module ---------------------------------------------------------------------
udev_changed=false
install_file "$DIST/70-rpchat.rules" "$UDEV_DST" 0644 && udev_changed=true || true
install_file "$DIST/rpchat.conf" "$MODULES_DST" 0644 || true
if ! $SYSTEM_CMDS; then
  skip "uinput module / udev reload (--prefix)"
elif [ -e /dev/uinput ]; then
  skip "uinput module loaded"
elif have modprobe; then
  if run modprobe uinput; then ok "loaded uinput module"; else warn "modprobe uinput failed (kernel without uinput?)"; fi
fi
if $SYSTEM_CMDS && have udevadm; then
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

# 5. system install: the unpacked app under /opt/rpchat (AppImage only) ------------------------------
if [ "$SYSTEM_INSTALL" = yes ]; then
  system_install_app
else
  skip "system install (pass --app-bin <AppImage> to unpack the app to $INSTALL_ROOT/current; updates are then applied by the daemon)"
fi

# 6. application menu entry and icon (system-wide, so AppImage users get a launcher) ----------------
if [ "$MENU_ENTRY" = yes ]; then
  content="$(sed "s|^Exec=.*|Exec=$APP_EXEC %U|; s|^TryExec=.*|TryExec=$APP_EXEC|" "$DIST/rpchat.desktop")"
  if [ -f "$MENU_DST" ] && [ "$(cat "$MENU_DST")" = "$content" ]; then
    skip "$MENU_DST is up to date"
    changed=false
  else
    if $DRY_RUN; then note "+ write $MENU_DST"; else install -D -m 0644 -o root -g root /dev/null "$MENU_DST.new" && printf '%s\n' "$content" > "$MENU_DST.new" && mv -f "$MENU_DST.new" "$MENU_DST"; fi
    ok "wrote $MENU_DST"
    changed=true
  fi
  icons_changed=false
  if install_icons; then
    if $icons_changed; then changed=true; fi
  else
    warn "app icon not found next to the installer; the menu entry will show a generic icon"
  fi
  if $changed; then refresh_menus; fi
else
  skip "application menu entry (--menu-entry no)"
fi

# 7. autostart for the user ------------------------------------------------------------------------
if [ -n "$TARGET_USER" ]; then
  xdg="$USER_HOME/.config/autostart/rpchat.desktop"
  unit="$USER_HOME/.config/systemd/user/rpchat.service"
  case "$AUTOSTART" in
    xdg)
      content="$(sed "s|^Exec=.*|Exec=$APP_EXEC --hidden|" "$DIST/rpchat-autostart.desktop")"
      if [ -f "$xdg" ] && [ "$(cat "$xdg")" = "$content" ]; then
        skip "$xdg is up to date"
      else
        as_user_write "$xdg" "$content"; ok "wrote $xdg"
      fi
      if [ -f "$unit" ]; then
        user_systemctl disable --now rpchat || note "run as $TARGET_USER: systemctl --user disable --now rpchat"
        run rm -f "$unit"; ok "removed $unit (switched to XDG autostart)"
      fi
      ;;
    systemd)
      content="$(sed "s|^ExecStart=.*|ExecStart=$APP_EXEC --hidden|" "$DIST/rpchat.service")"
      if [ -f "$unit" ] && [ "$(cat "$unit")" = "$content" ]; then
        skip "$unit is up to date"
      else
        as_user_write "$unit" "$content"; ok "wrote $unit"
      fi
      if user_systemctl daemon-reload && user_systemctl enable rpchat; then
        ok "enabled rpchat user unit for $TARGET_USER"
      else
        note "no session bus for $TARGET_USER; run as that user: systemctl --user enable --now rpchat"
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

# 8. browser extension policy (only with --browser-extension; the id is per user, so never from the deb) -----
if [ -n "$BROWSER_EXT" ]; then
  install_browser_policy
else
  skip "browser extension policy (pass --browser-extension/--browser-update-url, or use Settings → Browser in the app)"
fi

# 9. session guard (policy.guard; docs/system-integration.md "Session guard") ---------------------
if [ "$GUARD" = auto ]; then
  if [ "$(policy_guard_mode)" != off ]; then GUARD=yes; else GUARD=no; fi
fi
if [ "$GUARD" = yes ]; then
  guard_engage
elif [ "$GUARD_ARG" = no ]; then
  guard_disengage
else
  # Not asked for and not in the policy: a PAM line from an earlier run is left alone (a policy
  # edited to mode: off unloads the profiles by itself); --no-guard removes it explicitly.
  skip "session guard (policy guard.mode is off; set it to audit or pass --guard)"
fi

# 10. device check ---------------------------------------------------------------------------------
if [ -x "$DAEMON_DST" ] && ! $DRY_RUN && $SYSTEM_CMDS; then
  echo "device check ($DAEMON_DST --check-devices):"
  "$DAEMON_DST" --check-devices 2>&1 | sed 's/^/       /' || true
elif [ -x "$DAEMON_BIN" ]; then
  echo "device check ($DAEMON_BIN --check-devices):"
  "$DAEMON_BIN" --check-devices 2>&1 | sed 's/^/       /' || true
fi

ok "install complete"
if [ "$SYSTEM_INSTALL" = yes ] && [ -n "${APPIMAGE:-}" ]; then
  note "the running app is still the AppImage; start $APP_EXEC (menu entry) to run the installed copy"
fi
if $NEED_RELOGIN; then
  note "$TARGET_USER must log out and back in for the $GROUP group membership to take effect"
  note "(until then the app cannot connect to $RUN_DIR/daemon.sock)."
fi
