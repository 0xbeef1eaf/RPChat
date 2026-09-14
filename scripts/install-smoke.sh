#!/usr/bin/env bash
# Exercises native/rp-coded/install.sh against a scratch prefix (--prefix): a system install
# from a fake AppImage (a shell script whose --appimage-extract unpacks an embedded tar), a second
# version (previous/ + versions.json), --rollback, --refresh-daemon-files, --remove and
# --uninstall. Needs root only for the chown steps (the script refuses to run otherwise), so CI
# runs it with sudo. No groups, services or udev rules are touched (--prefix skips them).
#
# Usage: scripts/install-smoke.sh [work-dir]   (default: a mktemp directory, removed afterwards)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$ROOT/native/rp-coded/install.sh"
WORK="${1:-}"
if [ -z "$WORK" ]; then WORK="$(mktemp -d /tmp/rp-install-smoke.XXXX)"; CLEAN=true; else mkdir -p "$WORK"; CLEAN=false; fi
PREFIX="$WORK/prefix"
rm -rf "$PREFIX"; mkdir -p "$PREFIX" "$WORK/src"
USER_NAME="$(id -un)"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
if [ "$(id -u)" -ne 0 ]; then echo "install-smoke: run as root (sudo); install.sh takes ownership of the tree" >&2; exit 2; fi

fail() { echo "FAIL: $*" >&2; exit 1; }
check() { # check <description> <command...>
  local what="$1"; shift
  if "$@"; then echo "  ok   $what"; else fail "$what"; fi
}

# A fake daemon binary that answers --version (what --refresh-daemon-files copies).
fake_daemon() { # fake_daemon <path> <version>
  printf '#!/bin/sh\ncase "$1" in --version) echo "rp-coded %s (protocol 1)";; --check-devices) echo "fake";; esac\n' "$2" > "$1"
  chmod 0755 "$1"
}

# A fake AppImage: unpacks an embedded tar of squashfs-root/ on --appimage-extract.
fake_appimage() { # fake_appimage <path> <version> <daemon-version>
  local out="$1" version="$2" dv="$3" src
  src="$(mktemp -d "$WORK/src/tree.XXXX")"
  mkdir -p "$src/squashfs-root/resources/system" "$src/squashfs-root/resources/bin" "$src/squashfs-root/usr/share/icons"
  printf '#!/bin/sh\necho "rp-code %s"\n' "$version" > "$src/squashfs-root/rp-code"; chmod 0755 "$src/squashfs-root/rp-code"
  echo ffmpeg > "$src/squashfs-root/libffmpeg.so"
  echo "asar $version" > "$src/squashfs-root/resources/app.asar"
  printf '[Desktop Entry]\nName=rp-code\nX-AppImage-Version=%s\n' "$version" > "$src/squashfs-root/rp-code.desktop"
  echo png > "$src/squashfs-root/usr/share/icons/rp-code.png"
  ln -s usr/share/icons/rp-code.png "$src/squashfs-root/.DirIcon"
  cp "$INSTALL" "$src/squashfs-root/resources/system/install.sh"
  cp "$ROOT"/native/rp-coded/dist/* "$src/squashfs-root/resources/system/"
  fake_daemon "$src/squashfs-root/resources/bin/rp-coded" "$dv"
  chmod -R go-rwx "$src/squashfs-root/resources"   # like --appimage-extract: 0700 dirs to normalise
  {
    printf '#!/bin/sh\n# fake AppImage (install smoke)\nif [ "$1" = --appimage-extract ]; then\n  sed -e '"'"'1,/^__TAR__$/d'"'"' "$0" | tar -xf -\n  exit $?\nfi\necho "fake rp-code $*"\nexit 0\n__TAR__\n'
    tar -C "$src" -cf - squashfs-root
  } > "$out"
  chmod 0755 "$out"
}

json_field() { # json_field <file> <section> <key>  (same reader as install.sh)
  awk -v section="\"$2\":" -v key="\"$3\":" '
    $1 == section { inside = 1; next }
    inside && $1 ~ /^\}/ { inside = 0 }
    inside && $1 == key { v = $0; sub(/^[^:]*:[ \t]*"/, "", v); sub(/",?[ \t]*$/, "", v); print v; exit }
  ' "$1"
}

OPT="$PREFIX/opt/rp-code"
DAEMON="$WORK/rp-coded"
fake_daemon "$DAEMON" 0.1.0
fake_appimage "$WORK/rp-code-0.1.0-linux-x86_64.AppImage" 0.1.0 0.1.0
fake_appimage "$WORK/rp-code-0.2.0-linux-x86_64.AppImage" 0.2.0 0.2.0

echo "--- 1. system install from the 0.1.0 AppImage"
"$INSTALL" --prefix "$PREFIX" --app-bin "$WORK/rp-code-0.1.0-linux-x86_64.AppImage" --daemon-bin "$DAEMON" --user "$USER_NAME" --autostart xdg > "$WORK/install-1.log" 2>&1 || { cat "$WORK/install-1.log"; fail "install 1"; }
grep -q "installed .*0.1.0) to $OPT/current" "$WORK/install-1.log" || { cat "$WORK/install-1.log"; fail "no install line"; }
check "current/rp-code present" test -x "$OPT/current/rp-code"
check "current/resources/app.asar is 0.1.0" grep -q "asar 0.1.0" "$OPT/current/resources/app.asar"
check "no previous yet" test ! -e "$OPT/previous"
check "versions.json current = 0.1.0" test "$(json_field "$OPT/versions.json" current version)" = 0.1.0
check "versions.json has no previous" test -z "$(json_field "$OPT/versions.json" previous version)"
check "tree is root-owned" test -z "$(find "$OPT/current" ! -user root -print -quit)"
check "directories are 0755 (extraction left 0700)" test "$(stat -c %a "$OPT/current/resources")" = 755
check "no group/world-writable entries" test -z "$(find "$OPT/current" -perm /022 ! -type l -print -quit)"
check "symlink kept" test -L "$OPT/current/.DirIcon"
check "bin link" test "$(readlink "$PREFIX/usr/local/bin/rp-code")" = "$OPT/current/rp-code"
check "daemon installed" test -x "$PREFIX/usr/local/libexec/rp-code/rp-coded"
check "unit installed" test -f "$PREFIX/etc/systemd/system/rp-coded.service"
check "udev rule installed" test -f "$PREFIX/etc/udev/rules.d/70-rp-code.rules"
check "menu entry points at the system install" grep -q "^Exec=$OPT/current/rp-code %U" "$PREFIX/usr/local/share/applications/rp-code.desktop"
check "autostart entry points at the system install" grep -q "^Exec=$OPT/current/rp-code --hidden" "$PREFIX$USER_HOME/.config/autostart/rp-code.desktop"
check "no staging left" test ! -e "$OPT/.staging"
check "no groups/services touched" grep -q "group rp-code (--prefix)" "$WORK/install-1.log"

echo "--- 2. re-run with the same AppImage is a no-op"
"$INSTALL" --prefix "$PREFIX" --app-bin "$WORK/rp-code-0.1.0-linux-x86_64.AppImage" --daemon-bin "$DAEMON" --autostart none > "$WORK/install-2.log" 2>&1 || { cat "$WORK/install-2.log"; fail "install 2"; }
check "skipped as already installed" grep -q "already 0.1.0 from" "$WORK/install-2.log"
check "still no previous" test ! -e "$OPT/previous"

echo "--- 3. 0.2.0 on top: the old version becomes previous"
"$INSTALL" --prefix "$PREFIX" --app-bin "$WORK/rp-code-0.2.0-linux-x86_64.AppImage" --daemon-bin "$DAEMON" --autostart none > "$WORK/install-3.log" 2>&1 || { cat "$WORK/install-3.log"; fail "install 3"; }
check "current is 0.2.0" grep -q "asar 0.2.0" "$OPT/current/resources/app.asar"
check "previous is 0.1.0" grep -q "asar 0.1.0" "$OPT/previous/resources/app.asar"
check "versions.json current = 0.2.0" test "$(json_field "$OPT/versions.json" current version)" = 0.2.0
check "versions.json previous = 0.1.0" test "$(json_field "$OPT/versions.json" previous version)" = 0.1.0
check "previous source kept" test "$(json_field "$OPT/versions.json" previous source)" = "$WORK/rp-code-0.1.0-linux-x86_64.AppImage"

echo "--- 4. app-bin auto-detection prefers the system install"
"$INSTALL" --prefix "$PREFIX" --daemon-bin "$DAEMON" --autostart none --dry-run > "$WORK/install-4.log" 2>&1 || { cat "$WORK/install-4.log"; fail "install 4"; }
check "detected $OPT/current/rp-code" grep -q "app binary:    $OPT/current/rp-code" "$WORK/install-4.log"
check "no re-extraction" grep -q "system install: no" "$WORK/install-4.log"

echo "--- 5. rollback"
"$INSTALL" --prefix "$PREFIX" --rollback > "$WORK/rollback.log" 2>&1 || { cat "$WORK/rollback.log"; fail "rollback"; }
check "current is 0.1.0 again" grep -q "asar 0.1.0" "$OPT/current/resources/app.asar"
check "previous is 0.2.0" grep -q "asar 0.2.0" "$OPT/previous/resources/app.asar"
check "versions.json swapped" test "$(json_field "$OPT/versions.json" current version)" = 0.1.0 -a "$(json_field "$OPT/versions.json" previous version)" = 0.2.0
check "bin link still valid" test -x "$PREFIX/usr/local/bin/rp-code"

echo "--- 6. refresh-daemon-files from the installed bundle (what the daemon runs after a self-update)"
"$OPT/previous/resources/system/install.sh" --prefix "$PREFIX" --refresh-daemon-files > "$WORK/refresh.log" 2>&1 || { cat "$WORK/refresh.log"; fail "refresh"; }
check "daemon binary replaced with the bundled 0.2.0" test "$("$PREFIX/usr/local/libexec/rp-code/rp-coded" --version)" = "rp-coded 0.2.0 (protocol 1)"
check "no .new leftovers" test ! -e "$PREFIX/usr/local/libexec/rp-code/rp-coded.new"
check "unit refreshed or up to date" grep -Eq "rp-coded.service (is up to date|)" "$WORK/refresh.log"
check "menu entry kept" grep -q "^Exec=$OPT/current/rp-code %U" "$PREFIX/usr/local/share/applications/rp-code.desktop"
check "no user/group steps" bash -c "! grep -q 'group rp-code exists\|autostart' '$WORK/refresh.log'"

echo "--- 7. a bad tree is refused and the install untouched"
BAD="$WORK/bad.AppImage"
{
  printf '#!/bin/sh\nif [ "$1" = --appimage-extract ]; then mkdir -p squashfs-root && echo x > squashfs-root/rp-code && ln -s /etc/passwd squashfs-root/evil; exit 0; fi\n'
} > "$BAD"; chmod 0755 "$BAD"
if "$INSTALL" --prefix "$PREFIX" --app-bin "$BAD" --daemon-bin "$DAEMON" --autostart none > "$WORK/bad.log" 2>&1; then fail "bad tree accepted"; fi
check "refused with a reason" grep -q "libffmpeg.so is missing" "$WORK/bad.log"
check "current still 0.1.0" grep -q "asar 0.1.0" "$OPT/current/resources/app.asar"
check "staging cleaned" test ! -e "$OPT/.staging"

echo "--- 8. --no-system-install keeps the AppImage as the launcher"
"$INSTALL" --prefix "$PREFIX" --no-system-install --app-bin "$WORK/rp-code-0.2.0-linux-x86_64.AppImage" --daemon-bin "$DAEMON" --autostart none > "$WORK/install-8.log" 2>&1 || { cat "$WORK/install-8.log"; fail "install 8"; }
check "menu entry uses the AppImage" grep -q "^Exec=$WORK/rp-code-0.2.0-linux-x86_64.AppImage %U" "$PREFIX/usr/local/share/applications/rp-code.desktop"
check "system install untouched" grep -q "asar 0.1.0" "$OPT/current/resources/app.asar"

echo "--- 9. remove, then uninstall"
"$INSTALL" --prefix "$PREFIX" --remove > "$WORK/remove.log" 2>&1 || { cat "$WORK/remove.log"; fail "remove"; }
check "trees gone" test ! -e "$OPT/current" -a ! -e "$OPT/previous" -a ! -e "$OPT/versions.json"
check "bin link gone" test ! -e "$PREFIX/usr/local/bin/rp-code" -a ! -L "$PREFIX/usr/local/bin/rp-code"
check "empty root removed" test ! -e "$OPT"
"$INSTALL" --prefix "$PREFIX" --uninstall --user "$USER_NAME" > "$WORK/uninstall.log" 2>&1 || { cat "$WORK/uninstall.log"; fail "uninstall"; }
check "daemon dir gone" test ! -e "$PREFIX/usr/local/libexec/rp-code"
check "unit gone" test ! -e "$PREFIX/etc/systemd/system/rp-coded.service"
check "autostart gone" test ! -e "$PREFIX$USER_HOME/.config/autostart/rp-code.desktop"
check "policy dir kept" test -d "$PREFIX/etc/rp-code"

echo "install-smoke: all checks passed"
if $CLEAN; then rm -rf "$WORK"; fi
