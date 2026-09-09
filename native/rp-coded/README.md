# rp-coded

Small root daemon for the rp desktop app on Linux. It owns the two things an unprivileged
desktop process cannot do safely — **grabbing the user's input devices** (`EVIOCGRAB` on
`/dev/input/event*`) for a bounded time and **injecting keystrokes / pointer events** through
one uinput virtual device — and enforces a root-owned **policy file** so the limits cannot be
loosened from the app. The app talks to it over a group-restricted unix socket.

Spec: `docs/spec/system.md`. User guide: `docs/system-integration.md`. Wire contract:
`packages/shared/src/system.ts` (`DaemonRequest` / `DaemonResponse` / `PolicyFile`).

## Build and test

```sh
cargo build --release          # → target/release/rp-coded (no system libraries needed)
cargo test                     # 57 tests, all run without /dev/input or /dev/uinput
cargo clippy --all-targets
pnpm run build:daemon          # same build, from the monorepo root
./target/release/rp-coded --check-devices
```

Rust 1.75+. Dependencies: `evdev` 0.13 (ioctls, uinput), `nix` 0.29 (signals, chown, peer
credentials), `serde`/`serde_json`.

## Install

`install.sh` (run as root) does everything described in `docs/system-integration.md`:

```sh
sudo native/rp-coded/install.sh --user "$USER" --app-bin /path/to/rp-code [--autostart xdg|systemd|none] [--policy-template]
sudo native/rp-coded/install.sh --uninstall --user "$USER"
./install.sh --dry-run ...      # print what would happen, no root needed
```

The desktop app ships the script and `dist/` under `resources/system/` and runs it through
`pkexec` from Settings → System, after copying everything to `~/.cache/rp-code/system-install/`
(root cannot read inside an AppImage's FUSE mount). From an AppImage by hand, extract first:
`./rp-code-*.AppImage --appimage-extract 'resources/system/*' 'resources/bin/rp-coded'`, then
run `sudo squashfs-root/resources/system/install.sh --app-bin "$(readlink -f rp-code-*.AppImage)"`.

## CLI

```
rp-coded [--socket <path>] [--policy <path>] [--no-uinput] [--log-level error|warn|info|debug]
rp-coded --check-devices
rp-coded --help | --version
```

- `--socket` (env `RP_CODED_SOCKET`): default `/run/rp-code/daemon.sock`. The parent directory
  is created `0750 root:rp-code`, the socket `0660 root:rp-code`; without the group only root
  can connect (a warning is logged).
- `--policy` (env `RP_CODED_POLICY`): default `/etc/rp-code/policy.json`.
- `--check-devices`: lists the keyboards/pointers it can open, whether `/dev/uinput` is
  writable, and the screen size it would use. Exit 0 even with no devices.
- Logs go to stderr (`rp-coded [level] message`), i.e. the journal under systemd. Every lock
  is logged with the requester's uid/pid (`SO_PEERCRED`).

Exit codes: `0` (SIGTERM/SIGINT/SIGHUP → lock released, socket removed), `2` cannot bind the
socket, `64` bad command line.

## Protocol (JSON Lines over the unix socket)

One request object per line, one response line per request, answered in order on that
connection. Connections are independent; the lock is global and survives the connection that
created it. Unknown fields in requests are ignored; a malformed line gets
`{ "ok": false, "code": "INVALID" }` and the connection stays open.

| Request | Response |
|---|---|
| `{ "op": "hello", "version": 1 }` | `{ "ok": true, "op": "hello", "version": "0.1.0", "protocol": 1, "devices": { "keyboards", "pointers", "uinput" } }` |
| `{ "op": "status" }` | `{ "ok": true, "op": "status", "locked": null \| { "until", "reason"?, "devices" } }` |
| `{ "op": "policy" }` | `{ "ok": true, "op": "policy", "policy": PolicyFile \| null, "path" }` |
| `{ "op": "lock", "durationMs", "reason"?, "devices"? }` | `{ "ok": true, "op": "lock", "until", "durationMs", "devices" }` — `durationMs` is the clamped value actually applied |
| `{ "op": "unlock" }` | `{ "ok": true, "op": "unlock" }` (also when nothing was locked) |
| `{ "op": "type", "text" }` | `{ "ok": true, "op": "type", "skipped": n }` — `n` characters the US keymap could not produce |
| `{ "op": "key", "combo" }` | `{ "ok": true, "op": "key" }` |
| `{ "op": "click", "x", "y", "button"? }` | `{ "ok": true, "op": "click" }` |
| `{ "op": "move", "x", "y" }` | `{ "ok": true, "op": "move" }` |
| `{ "op": "set-policy", "policy": PolicyFile }` | `{ "ok": true, "op": "set-policy", "path" }` — creates the policy file **once** (see below) |

`until` is RFC 3339 UTC with milliseconds (`2026-01-02T03:04:05.678Z`), the same shape as
`Date.prototype.toISOString()`. `devices` is `"keyboard"`, `"mouse"` or `"both"` (default).

Errors: `{ "ok": false, "error": "<message>", "code": <code> }`

| Code | When |
|---|---|
| `REFUSED` | `hello` with a version other than 1; any request while the daemon shuts down |
| `POLICY` | `lock` while `inputLock.enabled` is `false`; `policy`/`lock` while the policy file is unreadable or invalid (fail closed) |
| `NO_DEVICES` | `lock` found no device of the requested class; injection without a uinput device |
| `BUSY` | every matching device is `EVIOCGRAB`bed by another process (EBUSY); uinput write would block |
| `INVALID` | malformed JSON / unknown op / wrong field types; `durationMs` ≤ 0 or non-finite; empty or > 2000-char `text`; unparsable `combo`; non-finite coordinates |
| `INTERNAL` | unexpected I/O failure (details in `error` and the journal) |
| `EXISTS` | `set-policy` while something (file, symlink, directory) already exists at the policy path; only root can change it |

### Semantics the app relies on

- **Lock**: `durationMs` is rounded and clamped to `[1000, inputLock.maxDurationMs]` (default max
  300 000). A `lock` while locked replaces the deadline and device class (devices no longer
  selected are released, newly selected ones grabbed). `reason` is kept (≤ 200 chars) and
  echoed by `status`. Every device of the selected class is grabbed: keyboards (EV_KEY with
  typing keys), pointers (EV_REL, or EV_ABS with BTN_LEFT/BTN_TOUCH); a device that is both
  (keyboard with trackpoint) is grabbed by either class. Devices plugged in during the lock are
  grabbed within a second. The lock ends on timer expiry (checked every 50 ms), `unlock`, the
  emergency chord (`inputLock.emergencyKey` held `emergencyHoldMs`, default Esc for 5 s, read
  from the grabbed keyboards — so not available for `devices: "mouse"`), or daemon shutdown.
- **Injection while locked works**: the uinput device is never grabbed.
- **`type`**: US-QWERTY scancodes; Shift for capitals and symbols; `\n` → Enter, `\t` → Tab,
  `\r\n` → one Enter. Each press/release is its own event frame; presses are held 1 ms, so the
  2000-character maximum takes about 2–4 s (well inside the app's 10 s request timeout). The
  compositor's xkb layout must be US for the characters to match.
- **`key`**: modifiers `ctrl`/`alt`/`shift`/`super`|`meta`|`win` (and `r*`/`l*` variants),
  separated by `+` or `-`; final key by name (`Return`/`enter`, `Tab`, `esc`, `space`,
  `BackSpace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `Up`/`Down`/`Left`/`Right`,
  `F1`..`F24`, `XF86AudioMute`, ...) or a single character (`ctrl+s`, `super+2`, `ctrl++`).
  A capital letter does not add Shift (`ctrl+S` = `ctrl+s`); write `ctrl+shift+s`.
- **`set-policy`** (write once): validates `policy` exactly like the file (unknown keys →
  `INVALID` with the validation message), refuses with `EXISTS` when anything is already at the
  policy path, creates the parent directory (`0755`) when missing and writes the object as
  pretty JSON with a trailing newline, `0644`. The file is opened with `O_CREAT|O_EXCL` and
  written in place: the kernel makes the existence check and the creation one atomic step, so
  two callers cannot both succeed and nothing existing is ever replaced (a crash mid-write
  leaves a truncated file the loader rejects, i.e. locks are refused until root fixes it). The
  creation is logged with the requester's uid/pid and `managedBy`; the next `policy`/`lock`
  request reads the new file. Any member of `rp-code` can do this once for the whole machine;
  afterwards only root can edit or delete the file (`ProtectSystem=strict` leaves
  `/etc/rp-code` writable for exactly this).
- **`click` / `move`**: absolute coordinates in the primary screen's pixel space. The virtual
  device's ABS_X/ABS_Y range is `0..W-1` / `0..H-1` where `W×H` is the first connected DRM
  connector's preferred mode (`/sys/class/drm/*/modes`), fallback 1920×1080; coordinates are
  rounded and clamped into that range. The compositor maps the range onto the output the device
  is assigned to (the whole layout on wlroots/Hyprland by default), so on a single-monitor setup
  `x`/`y` are global logical pixels. Multi-monitor or scaled layouts need a per-compositor device
  mapping (e.g. Hyprland `device { name = rp-coded-virtual-input; output = DP-1 }`).
  `click` moves, waits 5 ms, then presses and releases `BTN_LEFT`/`BTN_RIGHT`/`BTN_MIDDLE`.

## Layout

| File | Contents |
|---|---|
| `src/main.rs` | CLI, socket server (one thread per connection), ticker thread, signal thread, socket-level tests with fakes |
| `src/protocol.rs` | serde types mirroring `DaemonRequest`/`DaemonResponse`, `iso_millis`, round-trip tests for every op and error code |
| `src/policy.rs` | `PolicyFile` parsing/validation, `LockLimits` defaults and clamping, mtime/size-cached `PolicyStore` |
| `src/lock.rs` | `LockEngine` state machine (grab, timer, emergency chord, hot-plug, device classes) behind `DeviceSource`/`GrabbedDevice`; fakes and tests |
| `src/inject.rs` | US keymap, `plan_text`, `parse_combo`, `ScreenSize` clamping, `Injector` trait, `NullInjector`, `FakeInjector` |
| `src/devices.rs` | evdev `DeviceSource`, capability classification, DRM screen size, uinput `Injector`, `--check-devices` report |
| `dist/` | `rp-coded.service`, `70-rp-code.rules`, `rp-code.conf`, `policy.example.json`, `POLICY.md`, `rp-code-autostart.desktop`, `rp-code.service` (user unit) |
| `install.sh` | Idempotent installer / uninstaller (see the docs) |

## Security model

- Only root and members of `rp-code` can reach the socket; being in that group means "may lock
  this machine's input and inject keystrokes into whatever is focused" — treat it like `input`.
- The daemon never trusts the app's numbers: the policy clamps durations and can disable locking
  entirely; the policy file must be root-owned and lives outside the user's reach.
- No request can read input: grabbed events are drained and discarded, only the emergency key is
  inspected. No request can change an existing policy: `set-policy` only ever creates the file
  when none exists (write once), so the first member of the group to do it seeds the policy for
  everyone; edits and removal need root.
- The systemd unit runs with a closed device policy (only `char-input` and `/dev/uinput`),
  `ProtectSystem=strict`, `NoNewPrivileges`, a system-call allow-list and only the capabilities
  needed to chown the socket.
