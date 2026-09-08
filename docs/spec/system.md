# System integration (Linux): daemon, policy, udev, autostart, installer

Problem: locking input and injecting keystrokes need `/dev/input/*` and `/dev/uinput`, which an
unprivileged user does not have; and settings that live in the user's own config directory cannot
be locked against the user. Solution: a small root daemon **`rp-coded`** that owns device access
and enforces a root-owned **policy file**; the app talks to it over a unix socket. An installer
script sets everything up (group, udev rule, daemon service, policy template, autostart).
Contracts: `@rp/shared/system.ts` (`PolicyFile`, `DaemonRequest/Response`, `SystemIntegrationStatus`,
`DAEMON_SOCKET_PATH`, `POLICY_FILE_PATH`, `SYSTEM_GROUP`), `IpcApi.system`, `IpcApi.settings.managed`.

## `native/rp-coded` (Rust, Linux only)

- Binary `rp-coded`, runs as root under `rp-coded.service` (systemd system unit, `Type=simple`,
  `Restart=on-failure`, hardened: `ProtectSystem=strict`, `ReadWritePaths=/run/rp-code`,
  `DeviceAllow=/dev/input/* rw`, `DeviceAllow=/dev/uinput rw`, `NoNewPrivileges=yes`).
- Listens on `/run/rp-code/daemon.sock` (dir 0750 root:rp-code, socket 0660 root:rp-code) so only
  members of the `rp-code` group can talk to it. JSON lines, one request per line, one response.
- **Policy**: reads `/etc/rp-code/policy.json` at start and on every `policy` request (mtime cache);
  validates shape; refuses `lock` when `inputLock.enabled === false`; clamps `lock` durations to
  `inputLock.maxDurationMs` (default 300 000). Never trusts the app's numbers.
- **Lock**: `devices` selects the set (`keyboard`: devices with EV_KEY and a typing key set such as
  KEY_A; `mouse`: devices with EV_REL or EV_ABS and BTN_LEFT/BTN_TOUCH; `both`, the default: all of
  them); opens every matching `/dev/input/event*`, `EVIOCGRAB`s
  them (compositor stops receiving input), keeps reading their events so the grab does not fill
  the kernel buffer, and watches for the emergency chord: `inputLock.emergencyKey` (default Esc)
  held for `emergencyHoldMs` (default 5000) → unlock immediately and respond to the next
  `status` with `locked: null`. Auto-unlock timer; `unlock` op; unlock on daemon shutdown (SIGTERM).
  Hot-plug: devices appearing during a lock are grabbed too (poll `/dev/input` every second).
  While locked, `type/key/click/move` still work (they go through uinput, which is not grabbed).
- **Injection**: one uinput virtual keyboard+mouse created at start (`evdev` crate's `VirtualDevice`).
  `type` maps ASCII/Latin text via a US keymap (shift for capitals/symbols; non-mappable chars are
  skipped and counted in the response `skipped`), `key` parses `ctrl+alt+t`-style combos (modifiers
  ctrl/alt/shift/super/meta, keys by name or single char, F1..F24, arrows, enter/tab/esc/space/
  backspace/delete/home/end/pageup/pagedown), `click` moves absolutely (REL moves from a tracked
  position are unreliable on Wayland; use an ABS-capable virtual device with the primary screen size
  read from `/sys/class/drm/*/modes` or fallback 1920x1080, documented) then presses BTN_LEFT/RIGHT/
  MIDDLE, `move` only moves.
- `hello` reports version, protocol 1 and device counts; `status` reports the lock; errors use the
  codes in `DaemonResponse`.
- Layout: `src/main.rs` (socket server, signals), `src/protocol.rs` (serde types + tests),
  `src/policy.rs` (load/validate/clamp + tests), `src/lock.rs` (grab/emergency/timer behind a
  `DeviceSource` trait so tests use fakes), `src/inject.rs` (keymap + combo parsing, tested purely),
  `src/devices.rs`. `cargo test` must pass here without devices; `--check-devices` flag prints what it
  can open (used by the installer).
- `native/rp-coded/dist/`: `rp-coded.service`, `70-rp-code.rules`
  (`KERNEL=="uinput", GROUP="rp-code", MODE="0660", OPTIONS+="static_node=uinput"` — for the
  fallback tools such as ydotool; the daemon itself needs no rule), `modules-load.d/rp-code.conf`
  (`uinput`), `policy.example.json` (every field with comments in an adjacent `POLICY.md`),
  `rp-code-autostart.desktop` (XDG autostart, `Exec=rp-code --hidden`), `rp-code.service` (systemd
  **user** unit alternative: `WantedBy=graphical-session.target`).

## Installer (`native/rp-coded/install.sh`, also shipped in the app's resources)

Run as root (`sudo` or `pkexec`). Flags: `--app-bin <path>` (the rp-code executable or AppImage;
auto-detected when run from the app), `--user <name>` (default `$SUDO_USER`/`$PKEXEC_UID`),
`--autostart xdg|systemd|none` (default xdg), `--policy-template` (write the example policy if none
exists), `--uninstall`. Steps, idempotent and printed as `[ok]`/`[skip]` lines:
1. `groupadd -f rp-code`; `usermod -aG rp-code <user>` (prints that a re-login is needed).
2. `install -m 0755 rp-coded /usr/local/libexec/rp-code/rp-coded`, the systemd unit to
   `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now rp-coded`.
3. udev rule to `/etc/udev/rules.d/70-rp-code.rules`, `modules-load.d`, `modprobe uinput`,
   `udevadm control --reload && udevadm trigger --subsystem-match=misc`.
4. `/etc/rp-code/policy.json`: created from the template only if absent, `root:root 0644`;
   `/etc/rp-code` 0755.
5. Autostart for the user: XDG `~<user>/.config/autostart/rp-code.desktop` with the app path, or the
   systemd user unit in `~<user>/.config/systemd/user/` (enabled via `systemctl --user` when a
   session bus is available, else printed); files chowned to the user. Also print the Hyprland
   `exec-once = <app> --hidden` line for people who prefer it.
6. `rp-coded --check-devices` summary.
`--uninstall` reverses everything except the policy file (prints how to remove it).
The deb package runs `install.sh --autostart none` in `afterInstall` (electron-builder `deb.afterInstall`),
skipping the user-specific steps; the app's Settings → System button runs it with `pkexec` for the
current user.

## App (desktop main)

- `src/main/system/daemon-client.ts`: `DaemonClient` (connect on demand, `hello`, request/response
  with 10 s timeout, reconnect, `status()`), unit-tested with a fake socket server.
- `src/main/system/policy.ts`: `loadPolicy(path)` → `{ policy, managed: ManagedSettingsPaths }`;
  `applyPolicy(settings, policy)` (pure, tested) forces the listed keys. `SettingsService` results
  and every `settings.get()` go through `applyPolicy`; `settings.update` ignores managed paths and
  the response carries the forced values. Policy file is re-read when its mtime changes.
- `InputHandler` (Linux): when the daemon is connected, `lock/unlock/status/type/key/click/moveMouse`
  go through it (the daemon clamps; the app also clamps to `maxInputLockMs`); otherwise the existing
  command templates. `status()` reports `locked` from the daemon.
- `src/main/system/integration.ts`: `SystemIntegrationStatus` assembly (daemon hello, policy,
  udev rule present, group membership via `id -Gn`, autostart detection), `install()` runs the
  bundled `install.sh` through `pkexec` (Linux; refuses elsewhere) with `--app-bin process.execPath`
  (or the AppImage path from `APPIMAGE` env) and streams output, `setAutostart()` writes/removes the
  XDG desktop entry for the current user without privileges, `installerPath()`.
- App flag `--hidden`: start minimized to tray (add a tray icon with Show/Quit) so autostart is quiet.
- Bundling: `resources/bin/rp-coded` (built by `scripts/build-native.mjs` alongside the helper) and
  `resources/system/{install.sh,rp-coded.service,70-rp-code.rules,...}`; electron-builder
  `extraResources` + `deb.afterInstall` script that calls the installer.
- IPC `system.*` and `settings.managed`.

## Renderer

- Settings → **System** tab: daemon status card (connected/version/devices/locked), policy card
  (managed-by text, list of forced settings), udev/group status with the "re-login required" hint,
  "Install system integration…" (explains what it does, runs `system.install`, shows the output),
  "Start on login" toggle (`system.setAutostart`), "Installer script path" with copy button.
- Managed settings: every settings control whose path is in `settings.managed()` renders disabled with
  a small "managed by policy" badge (Providers, General, Permissions toggles, Integrations
  allowlists, autonomy fields, max input lock).

## Docs

`docs/system-integration.md`: why the daemon, what the installer changes, the policy file reference,
emergency unlock chord, uninstall, security notes (group membership means "may lock input and inject
keys", so treat `rp-code` group like `input`).
