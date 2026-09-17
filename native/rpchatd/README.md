# rpchatd

Small root daemon for the rp desktop app on Linux. It owns the two things an unprivileged
desktop process cannot do safely — **grabbing the user's input devices** (`EVIOCGRAB` on
`/dev/input/event*`) for a bounded time and **injecting keystrokes / pointer events** through
one uinput virtual device — and enforces a root-owned **policy file** so the limits cannot be
loosened from the app. When that policy says the app may not be quit (`app.allowQuit: false`)
it also **relaunches the app** in the user's session after a kill or crash, and for a **system
install** (`/opt/rpchat`) it **applies app updates** the user downloaded — verified, extracted
as the user, swapped in as root — and updates itself from the same bundle. The app talks to it
over a group-restricted unix socket. With a `guard` block in the policy it also runs the
**session guard**: AppArmor profiles, generated from the policy, that confine the listed users'
login sessions so their own terminals and scripts cannot reach the compositor/shell IPC, edit
the wallpaper config or kill rpchat — and it reports every attempt to the app.

Spec: `docs/spec/system.md`. User guide: `docs/system-integration.md`. Wire contract:
`packages/shared/src/system.ts` (`DaemonRequest` / `DaemonResponse` / `PolicyFile`).

## Build and test

```sh
cargo build --release          # → target/release/rpchatd (no system libraries needed)
cargo test                     # 89 tests, all run without /dev/input or /dev/uinput (the chown/swap
                               # parts of the update tests need root and are skipped otherwise; the
                               # generated AppArmor profiles go through apparmor_parser -Q when installed)
cargo clippy --all-targets
pnpm run build:daemon          # same build, from the monorepo root
./target/release/rpchatd --check-devices
```

Rust 1.75+. Dependencies: `evdev` 0.13 (ioctls, uinput), `nix` 0.29 (signals, chown, peer
credentials), `serde`/`serde_json`, `sha2`/`base64` (update checksums). `RPCHATD_VERSION=<semver>`
at build time overrides the version the binary reports (test builds that must look newer than the
running daemon).

## Install

`install.sh` (run as root) does everything described in `docs/system-integration.md`:

```sh
sudo native/rpchatd/install.sh --user "$USER" --app-bin /path/to/rpchat.AppImage [--autostart xdg|systemd|none] [--policy-template] [--no-system-install]
sudo native/rpchatd/install.sh --rollback        # system install: previous ⇄ current
sudo native/rpchatd/install.sh --remove          # system install: delete /opt/rpchat/{current,previous,versions.json}
sudo native/rpchatd/install.sh --guard           # session guard: pam_apparmor line + rpchatd --guard-apply
sudo native/rpchatd/install.sh --no-guard        # remove the PAM line, unload the profiles
sudo native/rpchatd/install.sh --uninstall --user "$USER"
./install.sh --dry-run ...      # print what would happen, no root needed
sudo scripts/install-smoke.sh   # the whole thing against a scratch --prefix with a fake AppImage
```

With an AppImage as `--app-bin` the installer unpacks it to `/opt/rpchat/current` (the "system
install"; `--no-system-install` keeps the AppImage as the launcher). From then on the app's
updater hands downloaded releases to the daemon (`apply-update`) instead of asking for a password.

The desktop app ships the script and `dist/` under `resources/system/` and runs it through
`pkexec` from Settings → System, after copying everything to `~/.cache/rpchat/system-install/`
(root cannot read inside an AppImage's FUSE mount). From an AppImage by hand, extract first:
`./rpchat-*.AppImage --appimage-extract 'resources/system/*' 'resources/bin/rpchatd'`, then
run `sudo squashfs-root/resources/system/install.sh --app-bin "$(readlink -f rpchat-*.AppImage)"`.

## CLI

```
rpchatd [--socket <path>] [--policy <path>] [--sessions-dir <path>] [--install-root <path>]
         [--system-prefix <path>] [--profile-dir <path>] [--guard-state <path>]
         [--no-restart] [--no-uinput] [--log-level error|warn|info|debug]
rpchatd --check-devices
rpchatd --guard-apply | --guard-off [--policy <path>] [--profile-dir <path>] [--guard-state <path>]
rpchatd --seal-status | --unseal <code> [--policy <path>]
rpchatd --help | --version
```

- `--socket` (env `RPCHATD_SOCKET`): default `/run/rpchat/daemon.sock`. The parent directory
  is created `0750 root:rpchat`, the socket `0660 root:rpchat`; without the group only root
  can connect (a warning is logged).
- `--policy` (env `RPCHATD_POLICY`): default `/etc/rpchat/policy.json`.
- `--sessions-dir` (env `RPCHATD_SESSIONS_DIR`): logind session state files used to find the
  active graphical user before relaunching the app; default `/run/systemd/sessions`, with
  `loginctl` as the fallback. Meant for tests (point it at a directory with a fake session file).
- `--install-root` (env `RPCHATD_INSTALL_ROOT`): the system install (`current/`, `previous/`,
  `versions.json`); default `/opt/rpchat`. `--system-prefix` (env `RPCHATD_SYSTEM_PREFIX`) is
  handed to `install.sh --prefix` when the daemon refreshes its own files after an update, and
  `--no-restart` (env `RPCHATD_NO_RESTART=1`) makes it log instead of restarting — both for tests.
- `--profile-dir` (env `RPCHATD_PROFILE_DIR`): where the session-guard AppArmor profiles are
  written, default `/etc/apparmor.d`; `--guard-state` (env `RPCHATD_GUARD_STATE`): the guard
  state file, default `/etc/rpchat/guard-state.json`.
- `--guard-apply` / `--guard-off`: one engage (from the policy) or unload of the session guard
  from the command line — what `install.sh --guard`/`--no-guard` run. Prints the `GuardInfo`
  JSON; exit 1 when it reports an error.
- `--seal-status`: the policy seal, the runtime policy filesystem and the last remote
  configuration, as JSON. Never prints the secret or the signing key.
- `--unseal <code>`: remove the policy lock with a code from the enrolled authenticator app —
  the way back in when the app cannot be started. Being root is not enough; a wrong code exits 1
  and counts towards the lockout, exactly as over the socket.
- `--check-devices`: lists the keyboards/pointers it can open, whether `/dev/uinput` is
  writable, and the screen size it would use. Exit 0 even with no devices.
- Logs go to stderr (`rpchatd [level] message`), i.e. the journal under systemd. Every lock
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
| `{ "op": "set-policy", "policy": PolicyFile, "code"? }` | `{ "ok": true, "op": "set-policy", "path", "replaced" }` — creates the policy file **once**, or replaces it on a sealed machine with a valid `code` (see below) |
| `{ "op": "seal-policy", "policy"?, "totp"? }` | `{ "ok": true, "op": "seal-policy", "path", "secret", "otpauth", "seal": SealInfo, "runtime": RuntimeInfo }` — lock the policy behind a TOTP code; the secret is readable **once**. A *chain* seal is `set-remote-link`, not this |
| `{ "op": "unseal-policy", "code", "removePolicy"? }` | `{ "ok": true, "op": "unseal-policy", "path", "removed" }` — remove the lock (and the policy, if asked) |
| `{ "op": "seal-status" }` | `{ "ok": true, "op": "seal-status", "seal": SealInfo, "runtime": RuntimeInfo, "remote": RemoteInfo }` — no secrets |
| `{ "op": "remote-apply", "document" }` | `{ "ok": true, "op": "remote-apply", "changed", "applied", "seq", "unsealed", "policyHash", "runtime", "remote" }` — walk the policy chain the app fetched; `document` must be the body verbatim |
| `{ "op": "set-remote-link", "blob", "code"? }` | `{ "ok": true, "op": "set-remote-link", "mode", "url", "secret"?, "otpauth"?, "seal", "runtime", "remote" }` — point the machine at a chain and seal it in the blob's mode; `code` when already linked with one |
| `{ "op": "verify-pack", "id", "sha256" }` | `{ "ok": true, "op": "verify-pack", "signed" }` — whether a download the app hashed may be installed |
| `{ "op": "register", "exec", "args", "cwd", "env" }` | `{ "ok": true, "op": "register" }` — keepalive registration on this connection (see below) |
| `{ "op": "unregister" }` | `{ "ok": true, "op": "unregister" }` — forget it (also when nothing was registered) |
| `{ "op": "apply-update", "file", "version", "sha512" }` | `{ "ok": true, "op": "apply-update", "version", "restartDaemon" }` — system install: verify, extract as the user, swap in, self-update (see below; may take a minute) |
| `{ "op": "guard-apply" }` | `{ "ok": true, "op": "guard-apply", "guard": GuardInfo }` — session guard: (re)generate and load the profiles from the policy now (see below) |
| `{ "op": "guard-status" }` | `{ "ok": true, "op": "guard-status", "guard": GuardInfo }` — what is engaged, without touching anything |
| `{ "op": "subscribe", "events": ["guard-attempt", "policy-tamper", "policy-changed"] }` | `{ "ok": true, "op": "subscribe", "events": [...] }` — receive pushed `{ "ev": … }` lines on this connection (see below); `[]` unsubscribes |

`status` also carries `"keepalive": { "registered", "relaunches", "allowQuit" }`,
`"install": { "systemInstall", "current"?, "previous"?, "daemonVersion" }` and
`"guard": GuardInfo` = `{ "available", "mode", "loaded", "users", "residual", "pamConfigured"?,
"shell"?, "compositor"?, "appliedAt"?, "lastError"? }`.

**Pushed events** (the only lines the daemon writes without a request): after `subscribe`, a
connection receives `{ "ev": "guard-attempt", "at", "kind": "ipc"|"config"|"signal"|"ptrace"|"exec",
"target", "command", "pid", "blocked", "profile", "operation", "requested"? }` for every AppArmor
audit record about an `rpchat-*` profile (one per target every 10 s). Clients tell them apart
from responses by the `ev` key; they may arrive between a request and its response but never
inside a line.

`until` is RFC 3339 UTC with milliseconds (`2026-01-02T03:04:05.678Z`), the same shape as
`Date.prototype.toISOString()`. `devices` is `"keyboard"`, `"mouse"` or `"both"` (default).

Errors: `{ "ok": false, "error": "<message>", "code": <code> }`

| Code | When |
|---|---|
| `REFUSED` | `hello` with a version other than 1; any request while the daemon shuts down; `register` from uid 0; `apply-update` from uid 0, without a system install, for a downgrade the policy does not allow, for a file that is not a regular file owned by the peer under their home (or not readable), or while a self-update restart is pending |
| `POLICY` | `lock` while `inputLock.enabled` is `false`; `policy`/`lock` while the policy file is unreadable or invalid (fail closed) |
| `NO_DEVICES` | `lock` found no device of the requested class; injection without a uinput device |
| `BUSY` | every matching device is `EVIOCGRAB`bed by another process (EBUSY); uinput write would block; a second `apply-update` while one is running |
| `INVALID` | malformed JSON / unknown op / wrong field types; `durationMs` ≤ 0 or non-finite; empty or > 2000-char `text`; unparsable `combo`; non-finite coordinates; a `register` whose `exec` is not an absolute existing executable, with > 32 `args`, a relative `cwd`, an env key outside the whitelist or a value > 4 KiB, or from a uid without a passwd entry; an `apply-update` whose `version` is not semver, whose `sha512` is not a digest or does not match the file, or whose extracted tree fails the checks |
| `INTERNAL` | unexpected I/O failure (details in `error` and the journal); `apply-update` extraction, ownership or swap failure (the old version is kept) |
| `EXISTS` | `set-policy` while something (file, symlink, directory) already exists at the policy path; only root can change it |

### Semantics the app relies on

- **Session guard** (`policy.guard`, `docs/system-integration.md` "Session guard"): at start,
  whenever the policy file changes (checked every ~5 s) and on `guard-apply`, the daemon renders
  `/etc/apparmor.d/rpchat-{session,app,shell,compositor,login}` from the policy, the shell/
  compositor table, the login helpers and binaries present, and the sockets discovered from
  `/proc/net/unix` + `/proc/<pid>/fd` of the listed users' shell/compositor processes (cached in
  `/etc/rpchat/guard-state.json`), validates them with `apparmor_parser -Q -K`, loads them with
  `-r -K` and records the result; `mode: off` unloads (`-R`) and removes the files. `available`
  is false without `/sys/kernel/security/apparmor`, in which case nothing is written and
  `lastError` says so. `pamConfigured` reports the `pam_apparmor.so` line in
  `/etc/pam.d/system-login` or `common-session` (the installer's `--guard` adds it; the daemon
  never edits PAM). `residual` lists the documented gaps for this configuration. Once something
  is loaded, the audit tail (`journalctl -f -o json _TRANSPORT=kernel + _TRANSPORT=audit`, else
  `/dev/kmsg`) turns `apparmor="DENIED|ALLOWED|AUDIT"` records with `profile="rpchat-…"` into
  `guard-attempt` events (`blocked` only for `DENIED`, i.e. enforce mode).

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
  request reads the new file. Any member of `rpchat` can do this once for the whole machine;
  afterwards only root can edit or delete the file (`ProtectSystem=strict` leaves
  `/etc/rpchat` writable for exactly this).
- **`register` / `unregister`** (keepalive, `app.allowQuit: false`): the registration belongs
  to the connection that sent it (a second `register` replaces it) and is remembered together
  with the peer's uid/gid/pid from `SO_PEERCRED` and the process start time from
  `/proc/<pid>/stat`. `env` may only contain `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`,
  `XDG_SESSION_TYPE`, `XDG_SESSION_ID`, `XDG_CURRENT_DESKTOP`, `DBUS_SESSION_BUS_ADDRESS`,
  `HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`,
  `LC_ALL`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XAUTHORITY`, `APPIMAGE`,
  `APPDIR`, `ELECTRON_OZONE_PLATFORM_HINT`. When the connection closes without `unregister` the
  daemon re-reads the policy and relaunches only if `app.allowQuit` is `false`, the peer's user
  name is in `app.users` (an empty list relaunches nobody; warned once), that uid owns the active
  graphical logind session (`/run/systemd/sessions/*`: `ACTIVE=1`, `TYPE=wayland|x11`, a
  `SEAT`; `loginctl` fallback) and — after the delay — the process is gone. Delay 1.5 s;
  deaths within 60 s of the previous relaunch climb 3 → 6 → 12 → 30 s; 10 relaunches in 10
  minutes → give up (logged); 5 minutes of uptime reset everything; a new registration for the
  same uid cancels a pending relaunch; a changed active user drops it. The relaunch is
  `exec args…` with exactly the registered environment, cwd as registered (else `$HOME`),
  stdio to `/dev/null`, in a new session (`setsid`), as the user (`setgid`, `initgroups`,
  `setuid`; never root); its exit status is logged. Every register/unregister/relaunch/give-up
  line carries the uid and pid.
- **`apply-update`** (system install, `docs/system-integration.md` "System install"): the peer
  must be a non-root user; `<install-root>/versions.json` and `current/rpchat` must exist;
  `version` must be semver and not older than `versions.json.current.version` unless the policy
  has `settings.updates.allowDowngrade: true` (equal is fine: a reinstall); `file` must be an
  absolute path without `.`/`..` under the peer's home, opened `O_NOFOLLOW`, a regular file the
  peer owns, 1 byte to 1 GiB. The file is copied into `<root>/.staging-<uid>` (`0700`, the peer's)
  while hashed — the hashed bytes are the extracted bytes — and `sha512` (base64 as in
  `latest-linux.yml`; hex accepted) must match. `<copy> --appimage-extract` then runs **as the
  peer** (uid/gid, empty environment, 4-minute limit). The tree must contain `rpchat`,
  `libffmpeg.so` and `resources/app.asar`, no setuid/setgid bit, no hard link, no device/fifo/socket
  and no symlink leaving the tree; it is chowned `root:root` (`0755` dirs, `0755`/`0644` files) and
  verified again. Swap: `previous` removed, `current` → `previous`, tree → `current` (a failed last
  rename restores `current`); `versions.json` rewritten (`current: { version, installedAt, source:
  file }`, `previous`: the old entry). Then, when the bundled
  `current/resources/bin/rpchatd` is newer than the running daemon — or is the *same version but a
  different build*, which is the ordinary case since the version is not bumped for every build, and
  is decided by hashing it against `/proc/self/exe` — `current/resources/system/install.sh --refresh-daemon-files` runs
  as root and the answer says `restartDaemon: true`; once the reply is out and no input lock is
  active the daemon restarts (`systemctl restart rpchatd` under systemd, else a re-exec of the
  replaced binary with the same arguments). A failed refresh keeps the app update and answers
  `false`. Everything is logged with the peer's uid/pid. The app relaunches from
  `/opt/rpchat/current/rpchat` afterwards (waiting for the daemon first when it restarts).
- **`click` / `move`**: absolute coordinates in the primary screen's pixel space. The virtual
  device's ABS_X/ABS_Y range is `0..W-1` / `0..H-1` where `W×H` is the first connected DRM
  connector's preferred mode (`/sys/class/drm/*/modes`), fallback 1920×1080; coordinates are
  rounded and clamped into that range. The compositor maps the range onto the output the device
  is assigned to (the whole layout on wlroots/Hyprland by default), so on a single-monitor setup
  `x`/`y` are global logical pixels. Multi-monitor or scaled layouts need a per-compositor device
  mapping (e.g. Hyprland `device { name = rpchatd-virtual-input; output = DP-1 }`).
  `click` moves, waits 5 ms, then presses and releases `BTN_LEFT`/`BTN_RIGHT`/`BTN_MIDDLE`.

## Layout

| File | Contents |
|---|---|
| `src/main.rs` | CLI, socket server (one thread per connection, `ConnCtx` with peer credentials and registration), ticker thread (lock timers + due relaunches), signal thread, keepalive OS glue behind `KeepaliveHooks` (`/proc`, logind, getpwuid, `Command::spawn` + reaper), socket-level and pipeline tests with fakes |
| `src/protocol.rs` | serde types mirroring `DaemonRequest`/`DaemonResponse`, `iso_millis`, round-trip tests for every op and error code |
| `src/policy.rs` | `PolicyFile` parsing/validation, `LockLimits` defaults and clamping, `AppRules` (`app.allowQuit`/`users`), `GuardRules` (`guard`, plus the seal's denials), `RemoteRules`/`PackRules`/`LockRules`, mtime/size-cached `PolicyStore`, `write_policy_file` (the replace path) |
| `src/seal.rs` | The policy seal: its two modes (`totp`, `chain`), the seal file and its mirrors, the world-readable marker, the lockout ladder, the tamper log, the immutable attribute (`FS_IOC_SETFLAGS`), `LockPolicy`/`LockRules`; pure parts tested |
| `src/chain.rs` | The policy chain and the Remote Link: canonical bytes, link hashing, Ed25519 verification (`verify_strict`), the walk from the machine's head to the tip, key rotation; pure, with a test vector shared with the app and `scripts/rp-policy-chain.mjs` |
| `src/totp.rs` | RFC 6238 codes: SHA-1, HMAC, base32, `otpauth://` URIs, replay-checked verification; tested against the RFC 2202/4231/6238 vectors |
| `src/runtime.rs` | The runtime policy filesystem (`/run/rpchat/policy`): tmpfs mount, read-only remount, published policy and state, `mountinfo` parsing; `MountOps` is injectable so the tests need no privileges |
| `src/remote.rs` | The `remote`/`packs` policy blocks and pack-signature verification (Ed25519 over id + version + hash); pure |
| `src/guard.rs` | Session guard: shell/compositor table, profile rendering (`render`), audit-line parsing, per-target rate limiting, `/proc` discovery parsing and socket-path generalisation, `GuardState` file, `apply`/`current_info` behind `GuardHooks` (fakes in tests, `apparmor_parser -Q` when installed) |
| `src/keepalive.rs` | Pure relaunch logic: registration validation, the gate (policy, users, active session, process), `RelaunchTracker` backoff/give-up, logind session-file and `loginctl` parsing, `command_spec`/`build_command`; all tested |
| `src/sysinstall.rs` | System install: `versions.json`, semver + downgrade rule, SHA-512 decoding, tree checks/normalisation, atomic swap, `apply_update` behind injectable `ApplyHooks` (home lookup, extraction as the user, bundled daemon version, `install.sh --refresh-daemon-files`); tested on a temp root with a fake AppImage |
| `src/lock.rs` | `LockEngine` state machine (grab, timer, emergency chord, hot-plug, device classes) behind `DeviceSource`/`GrabbedDevice`; fakes and tests |
| `src/inject.rs` | US keymap, `plan_text`, `parse_combo`, `ScreenSize` clamping, `Injector` trait, `NullInjector`, `FakeInjector` |
| `src/devices.rs` | evdev `DeviceSource`, capability classification, DRM screen size, uinput `Injector`, `--check-devices` report |
| `dist/` | `rpchatd.service`, `70-rpchat.rules`, `rpchat.conf`, `policy.example.json`, `POLICY.md`, `rpchat-autostart.desktop`, `rpchat.service` (user unit) |
| `install.sh` | Idempotent installer / uninstaller, system install (`--system-install`, `--rollback`, `--remove`), `--refresh-daemon-files`, session guard (`--guard`/`--no-guard`: PAM line + `--guard-apply`/`--guard-off`), `--prefix` for tests (see the docs; `scripts/install-smoke.sh`) |

## Security model

- Only root and members of `rpchat` can reach the socket; being in that group means "may lock
  this machine's input and inject keystrokes into whatever is focused" — treat it like `input`.
- The daemon never trusts the app's numbers: the policy clamps durations and can disable locking
  entirely; the policy file must be root-owned and lives outside the user's reach.
- No request can read input: grabbed events are drained and discarded, only the emergency key is
  inspected. On an unsealed machine no request can change an existing policy: `set-policy` only
  ever creates the file when none exists (write once), so the first member of the group to do it
  seeds the policy for everyone; edits and removal need root.
- **Sealing** trades that for a lock. In `totp` mode (`seal-policy`) the policy can be replaced
  and removed again, but only with a code from the enrolled authenticator app. In `chain` mode
  (`set-remote-link`) the daemon holds **no secret at all** — only an Ed25519 public key and the
  hash of the last policy it applied — and nothing local can authorise a change. Either way the
  daemon then defends the policy actively: it publishes the effective copy into a read-only tmpfs
  it mounts, restores an edited file, keeps mirrors of the seal, sets the immutable attribute,
  writes a `RefuseManualStop` drop-in, and (with the guard enforcing) denies the confined sessions
  `/etc/rpchat` and the binaries that would escape the profile. It is layered, not absolute: in
  code mode an unconfined root shell can read the secret, and in either mode another boot medium
  bypasses the daemon entirely. `seal-status` returns exactly that list.
- **The chain is verified, not trusted.** The app fetches; the daemon verifies an Ed25519
  signature over every link between where the machine is and where the chain ends, each committing
  to the one before it by hash. A replayed or reordered version cannot match the head the machine
  holds. Key rotation is signed by the key it replaces, so a successor cannot introduce itself.
  The daemon holds no private key of any kind, so nothing on the machine — the app included —
  can produce something it would accept.
- Updates (`apply-update`) install only files that match the release manifest's SHA-512, are
  extracted with the requesting user's privileges (never root), pass the tree checks, and only
  then become root-owned; the previous version is kept for `install.sh --rollback`. Release
  signing is not implemented yet: the manifest fetched over HTTPS with the user's token is the
  root of trust, and any `rpchat` member can install a genuine release (an older one only when
  the policy allows downgrades).
- Relaunching (`app.allowQuit: false`) only ever runs what a non-root client registered, as
  that client's uid/gid with its own whitelisted environment; the daemon never keeps root in
  the child and only relaunches users listed in `app.users` who own the active session.
- The session guard confines the listed users, never root: root (or the user with `sudo`) can
  unload the profiles or change the policy at any time, and the guarded session keeps
  `capability mac_admin` so a TTY login plus `sudo` is always a way out. The daemon writes only
  its own `rpchat-*` profiles and never edits PAM (the installer does, with a marker line).
- The systemd unit runs with `NoNewPrivileges`, read-only `/usr` and `/etc` (except
  `/etc/rpchat`, `/etc/apparmor.d`, `/opt/rpchat` and the daemon's own file locations it
  refreshes after a self-update), kernel/cgroup protection and a capability bounding set of chown +
  setuid/setgid + `mac_admin` (loading AppArmor policy). Because a relaunched app is a child of the service and inherits its sandbox,
  the unit does **not** use `ProtectHome`, `PrivateTmp`, a system-call filter,
  `MemoryDenyWriteExecute`, `RestrictNamespaces` or a closed device policy (a desktop app needs
  `$HOME`, `/tmp/.X11-unix`, JIT, Chromium's namespace sandbox, GPU and audio devices), and it
  uses `KillMode=process` so stopping the daemon leaves a relaunched app running.
