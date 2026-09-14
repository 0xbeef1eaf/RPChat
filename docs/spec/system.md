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
- **`set-policy` (write once)**: `{ op: 'set-policy', policy: PolicyFile }` → `{ ok, op, path }`.
  Validates `policy` exactly like the file (`deny_unknown_fields` + `validate()`; failures →
  `INVALID` with the message), answers `EXISTS` when anything (file, symlink, directory) is already
  at the policy path, creates the parent directory `0755` when missing, writes the object as pretty
  JSON + newline through `O_CREAT|O_EXCL` (`0644`, fsync) — atomic existence check, never replaces
  anything — logs `policy created at <path> by uid/pid (managedBy)`, drops the store cache. The unit
  has `ReadWritePaths=-/etc/rp-code` for this (the installer creates the directory before the
  service starts); the daemon never modifies or deletes an existing file, so after creation only
  root can. Honours `--policy <path>`.
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
- `hello` reports version, protocol 1 and device counts; `status` reports the lock and
  `keepalive: { registered, relaunches, allowQuit }`; errors use the codes in `DaemonResponse`
  (`REFUSED`, `POLICY`, `NO_DEVICES`, `BUSY`, `INVALID`, `INTERNAL`, `EXISTS`).
- **Keepalive** (`app.allowQuit: false`): `{ op: 'register', exec, args, cwd, env }` →
  `{ ok, op: 'register' }` records on the *connection* how to relaunch the app, together with the
  peer's uid/gid/pid (SO_PEERCRED) and the `/proc/<pid>/stat` start time. Validation (`INVALID`):
  `exec` absolute, existing and executable; `args` ≤ 32 entries; `cwd` absolute; `env` keys from
  `KEEPALIVE_ENV_KEYS` only, values ≤ 4 KiB; a uid without a passwd entry; uid 0 → `REFUSED`. A
  second `register` on the same connection replaces the first. `{ op: 'unregister' }` →
  `{ ok, op: 'unregister' }` forgets it (idempotent). When a registered connection closes without
  `unregister` the daemon re-reads the policy and runs the gate: `app.allowQuit === false`, the
  peer's user name ∈ `app.users` (empty/absent → nobody, warned once), that uid owns an active
  graphical logind session (`/run/systemd/sessions/*` with `ACTIVE=1`, `TYPE=wayland|x11` and a
  `SEAT`; `loginctl list-sessions` + `show-session` as fallback; `--sessions-dir`/`RP_CODED_SESSIONS_DIR`
  for tests). It then schedules a relaunch (1.5 s; ladder 1.5 → 3 → 6 → 12 → 30 s for deaths
  within 60 s of the previous relaunch; give up after 10 relaunches in 10 minutes, logged; reset
  after 5 minutes of uptime). The ticker fires it: gate again (policy re-read, active user, and
  the process must be gone — `/proc/<pid>` missing or a different start time), then
  `Command::spawn` of `exec args…` with `env_clear()` + exactly the registered env, cwd as
  registered (fallback `$HOME`, then `/`), stdio `/dev/null`, `pre_exec`: `setsid`, `setgid`,
  `initgroups`, `setuid` (never root); a reaper thread waits for the child and logs its exit. A new
  registration for the same uid cancels a pending relaunch. `src/keepalive.rs` is pure and
  tested (validation, gate, `RelaunchTracker` backoff, session-file/`loginctl` parsing,
  `command_spec`/`build_command`); `main.rs` holds the OS glue behind `KeepaliveHooks` (injected
  fakes in the daemon-level tests). At registration the daemon warns when `allowQuit` is false
  but the user is not listed. The unit file gives up `ProtectHome`, `PrivateTmp`, the syscall
  filter, `MemoryDenyWriteExecute`, `RestrictNamespaces` and the device policy (a relaunched
  Electron app inherits them) and adds `CAP_SETUID`/`CAP_SETGID`, `AF_INET*`/`AF_NETLINK` and
  `KillMode=process`.
- Layout: `src/main.rs` (socket server, signals, keepalive OS glue), `src/protocol.rs` (serde
  types + tests), `src/policy.rs` (load/validate/clamp + tests, `app` rules), `src/keepalive.rs`
  (relaunch decisions, pure), `src/lock.rs` (grab/emergency/timer behind a `DeviceSource` trait
  so tests use fakes), `src/inject.rs` (keymap + combo parsing, tested purely), `src/devices.rs`.
  `cargo test` must pass here without devices; `--check-devices` flag prints what it can open
  (used by the installer).
- `native/rp-coded/dist/`: `rp-coded.service`, `70-rp-code.rules`
  (`KERNEL=="uinput", GROUP="rp-code", MODE="0660", OPTIONS+="static_node=uinput"` — lets
  `rp-code` group members use `/dev/uinput` directly; the daemon itself needs no rule), `modules-load.d/rp-code.conf`
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
4. `/etc/rp-code/policy.json`: only with `--policy-template`, created from the example if absent,
   `root:root 0644` (an existing file is never touched). `/etc/rp-code` 0755 is created in step 2,
   before the service starts, because the unit's `ReadWritePaths=-/etc/rp-code` needs it to exist.
5. Autostart for the user: XDG `~<user>/.config/autostart/rp-code.desktop` with the app path, or the
   systemd user unit in `~<user>/.config/systemd/user/` (enabled via `systemctl --user` when a
   session bus is available, else printed); files chowned to the user. Also print the Hyprland
   `exec-once = <app> --hidden` line for people who prefer it.
6. `rp-coded --check-devices` summary.
`--uninstall` reverses everything except the policy file (prints how to remove it).
The deb package runs `install.sh --autostart none --menu-entry no` in `afterInstall` (electron-builder
`deb.afterInstall`), skipping the user-specific steps and **not** passing `--policy-template` (the
policy is write-once; the user creates it from the app); the app's Settings → System button runs it
with `pkexec` for the current user.

## App (desktop main)

- `src/main/system/daemon-client.ts`: `DaemonClient` (connect on demand, `hello`, request/response
  with 10 s timeout, reconnect, `status()`, `setPolicy(policy)` → `{ path }`), unit-tested with a fake
  socket server. `rpErrorCodeFor`/`toRpError` map daemon codes for every caller: `REFUSED`/`POLICY` →
  `PERMISSION_DENIED`, `INVALID`/`EXISTS` → `INVALID_ARGUMENT` (`details.daemonCode` keeps the
  original), others → `CAPABILITY_FAILED`.
- `src/main/system/policy.ts`: `loadPolicy(path)` → `{ policy, managed: ManagedSettingsPaths, app }`;
  `applyPolicy(settings, policy)` (pure, tested) forces the listed keys; `appPolicy(policy)` →
  `{ allowQuit, users }` with defaults (`app.allowQuit` is not a settings key: it is reported as
  `SystemIntegrationStatus.policy.allowQuit`/`.users`, never in `managed`). `parsePolicy` accepts
  `app.allowQuit` (boolean) and `app.users` (non-empty string array), ignores unknown `app` keys. `SettingsService` results
  and every `settings.get()` go through `applyPolicy`; `settings.update` ignores managed paths and
  the response carries the forced values. Policy file is re-read when its mtime changes
  (`PolicyWatcher.invalidate()` forces the next read).
- `InputHandler` is daemon-only: `lock/unlock/status/type/key/click/moveMouse` go through rp-coded
  (the daemon clamps; the app also clamps to `maxInputLockMs`) and `status()` reports `locked` from
  the daemon. There are no input command templates and no fallback: while the daemon is missing or
  unreachable (including every non-Linux platform) each method throws `CAPABILITY_FAILED` with
  "Input control needs the rp-code system integration (Settings → System → Install); the daemon is
  not connected".
- `src/main/system/integration.ts`: `SystemIntegrationStatus` assembly (daemon hello, policy,
  udev rule present, group membership via `id -Gn`, autostart detection), `install()` runs the
  bundled `install.sh` through `pkexec` (Linux; refuses elsewhere) with `--app-bin process.execPath`
  (or the AppImage path from `APPIMAGE` env) and streams output, `setAutostart()` writes/removes the
  XDG desktop entry for the current user without privileges, `installerPath()`.
  `status().policy.canCreate` = daemon connected and no policy file. `policyTemplate(settings)` (pure):
  pretty JSON of a `PolicyFile` seeded from the current settings (`version: 1`, `managedBy: ""`, every
  managed `settings` key with the current values, `updates.enabled: true`, `inputLock` = `{ enabled,
  maxDurationMs: maxInputLockMs, emergencyKey: 'esc', emergencyHoldMs: 5000 }`). `createPolicy(text)`:
  `JSON.parse` + `parsePolicy` (`INVALID_ARGUMENT` with `details.problems`), sends the object the user
  wrote to `daemon.setPolicy` (so the daemon's stricter unknown-key check applies), `policy.invalidate()`,
  returns `status()`.
- App flag `--hidden`: start minimized to tray (add a tray icon with Show/Quit) so autostart is quiet.
- **`app.allowQuit: false`** (`src/main/quit-guard.ts`, pure + tested; wired in `index.ts`):
  `trayMenuTemplate(allowQuit)` omits Quit; the window `close` handler always hides (tray or
  not); `window-all-closed` does not quit; `before-quit` is cancelled unless `QuitGuard.allowQuitOnce()`
  was called (the update restart does, through `UpdateServiceDeps.beforeRestart`); SIGINT/SIGTERM/SIGHUP
  handlers are installed only while forbidden (no-op with a log line; removed again when allowed).
  The guard is applied from the policy watcher at startup, on every window show/close and every
  60 s. `launchSpec()` builds the registration (`APPIMAGE` as exec with no args, else `execPath` +
  `argv.slice(1)`; env from `keepaliveEnv()` = the `KEEPALIVE_ENV_KEYS` whitelist);
  `src/main/system/keepalive-link.ts` (`KeepaliveLink`, tested with a fake socket) keeps a dedicated
  connection open: `hello` → `register`, reconnect with backoff (1 s doubling to 30 s) whenever it
  drops, `unregister()` before an intended exit (update restart, `stop()`). Started on Linux only.
  The single-instance lock (already present) makes a duplicate relaunch exit at once.
- Bundling: `resources/bin/rp-coded` (built by `scripts/build-native.mjs` alongside the helper) and
  `resources/system/{install.sh,rp-coded.service,70-rp-code.rules,...}`; electron-builder
  `extraResources` + `deb.afterInstall` script that calls the installer.
- IPC `system.*` (`status`, `install`, `setAutostart`, `installerPath`, `createPolicy(text)`,
  `policyTemplate()` — the latter reads the current settings in main), `settings.managed` and
  `updates.*` (the update service reads `settings.updates` from the same policy state).

### Policy `app` block

| Key | Type | Effect |
|---|---|---|
| `app.allowQuit` | boolean, default `true` | `false`: no Quit in the tray, close hides, Ctrl+Q/`app.quit()`/signals ignored; the daemon relaunches the app for the listed users. |
| `app.users` | non-empty `string[]` of unix user names | Who the daemon relaunches (must also own the active graphical session). Absent/empty → nobody. Shown in Settings → System ("Quitting is disabled by policy … for: alice, bob"). |

### Policy `settings` keys

Dotted paths as shown by `settings.managed()`; both the app (`parsePolicy`) and the daemon (`SETTINGS_KEYS` + `validate()` in `policy.rs`) must know every key, so extend both together.

| Key | Managed paths | Notes |
|---|---|---|
| `autonomy` | `autonomy.maxSelfWakesPerHour`, `autonomy.maxConsecutiveSelfWakes`, `autonomy.maxTimersPerSession`, `autonomy.minRepeatIntervalMs`, `autonomy.minDelayMs` | non-negative numbers |
| `maxInputLockMs` | `maxInputLockMs` | ≥ 1000; also capped by `inputLock.maxDurationMs` |
| `permissions` | `permissions.moduleAllow.<module>` | booleans per module |
| `web` | `web.allowlist` | string[] |
| `desktop` | `desktop.launchAllowlist` | string[] |
| `memory` | `memory.enabled`, `memory.consolidateEveryTurns`, `memory.maxEntriesPerCharacter`, `memory.promptBudgetTokens` | |
| `senses` | `senses.includeInPrompt`, `senses.watchDirs`, `senses.calendarSources` | |
| `displayBackend` | `displayBackend` | `auto` \| `electron` \| `hyprland` |
| `updates` | `updates.automatic`, `updates.enabled` | booleans. `enabled: false` switches update checks off entirely (`UpdateStatus.state === 'disabled'`, token field hidden, `automatic` forced off); `automatic` pins the background-check toggle. |
| `browser` | `browser.allowBlocking`, `browser.allowEval`, `browser.allowHistory`, `browser.homePage` | booleans, a non-negative number (ms; the cap on `sdk.browser.block` durations), an http(s) URL or `""`. What characters may do through the browser extension (docs/browser-extension.md). |

## Renderer

- Settings → **System** tab: daemon status card (connected/version/devices/locked), policy card
  (managed-by text, list of forced settings, a warning line "Quitting is disabled by policy
  (managed by …) for: alice, bob" when `policy.allowQuit` is false — `quitDisabledLine()`; without a file and with `policy.canCreate`: **Create
  policy…** → modal with the write-once explanation, a monospace textarea prefilled from
  `system.policyTemplate()`, "Reset to current settings", an "I understand this cannot be undone
  without root" checkbox gating **Write policy**, validation problems in a danger callout; on success
  toast "Policy written", reload status and settings so managed badges appear; without the daemon a
  hint to install the system integration), udev/group status with the "re-login required" hint,
  "Install system integration…" (explains what it does, runs `system.install`, shows the output),
  "Start on login" toggle (`system.setAutostart`), "Installer script path" with copy button.
- Managed settings: every settings control whose path is in `settings.managed()` renders disabled with
  a small "managed by policy" badge (Providers, General, Permissions toggles, Integrations
  allowlists, autonomy fields, max input lock).

## Docs

`docs/system-integration.md`: why the daemon, what the installer changes, the policy file reference,
emergency unlock chord, uninstall, security notes (group membership means "may lock input and inject
keys", so treat `rp-code` group like `input`).
