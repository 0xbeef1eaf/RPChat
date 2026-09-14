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
  `DeviceAllow=/dev/input/* rw`, `DeviceAllow=/dev/uinput rw`, `NoNewPrivileges=yes`; for the
  system install `ReadWritePaths=-/opt/rp-code` plus the daemon's own file locations —
  `/usr/local/libexec/rp-code`, `/usr/local/bin`, `/etc/systemd/system`, `/etc/udev/rules.d`,
  `/etc/modules-load.d`, `/usr/local/share/{applications,icons}` — so it can refresh them after
  updating itself).
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
- `hello` reports version, protocol 1 and device counts; `status` reports the lock,
  `keepalive: { registered, relaunches, allowQuit }` and `install: { systemInstall, current?,
  previous?, daemonVersion }` (from `<install-root>/versions.json` and the presence of
  `current/rp-code`); errors use the codes in `DaemonResponse` (`REFUSED`, `POLICY`, `NO_DEVICES`,
  `BUSY`, `INVALID`, `INTERNAL`, `EXISTS`).
- **System install / `apply-update`** (`src/sysinstall.rs`, root `--install-root`, default
  `/opt/rp-code`, env `RP_CODED_INSTALL_ROOT`): `{ op: 'apply-update', file, version, sha512 }` →
  `{ ok, op, version, restartDaemon }`. One at a time (`BUSY`), refused while a self-update
  restart is pending. Gate (`REFUSED`): peer uid ≠ 0; `versions.json` and `current/rp-code` exist;
  `version` not older than `versions.json.current.version` (semver, pre-releases below releases;
  an unparsable installed version never blocks) unless the policy has
  `settings.updates.allowDowngrade: true`; `file` absolute without `.`/`..` under the peer's
  passwd home; opened `O_NOFOLLOW|O_CLOEXEC`, `fstat` regular, owned by the peer uid, 1 byte ≤ size
  ≤ 1 GiB. `INVALID`: non-semver `version`, `sha512` not a 64-byte digest (base64 as in
  `latest-linux.yml`, hex accepted), checksum mismatch, tree check failure. Steps: staging dir
  `<root>/.staging-<uid>` (`0700`, chowned to the peer), the file is copied there as root `0755`
  while hashed (the verified bytes are the extracted bytes), then `<copy> --appimage-extract` runs
  **as the peer uid/gid** (`setgid`, `initgroups`/`setgroups`, `setuid`, env cleared, `PATH`,
  `HOME`/`TMPDIR` = staging, 4-minute kill) — untrusted archives are never unpacked as root;
  `check_tree`: `rp-code`, `libffmpeg.so`, `resources/app.asar` present, no setuid/setgid bit, no
  hard link (`nlink > 1`), only files/dirs/symlinks, relative symlinks that resolve inside the
  tree; `normalise_tree`: `lchown root:root`, dirs `0755`, files `0755` when any x bit else `0644`
  (this also drops every setuid bit), verified again (`verify_root_owned`); then `staging/squashfs-root`
  → `<root>/.new`, `swap_in`: remove `previous`, rename `current` → `previous`, `.new` → `current`
  (a failed last rename restores `current`); `versions.json` `{ current: { version, installedAt,
  source: file }, previous }` written via temp + rename `0644`. Failures clean the staging area.
  Then **self-update**: `current/resources/bin/rp-coded --version` parsed (`rp-coded X.Y.Z (protocol N)`);
  when newer than the running `VERSION`, `current/resources/system/install.sh --refresh-daemon-files
  [--prefix <p>]` runs as root (output logged) and the answer carries `restartDaemon: true`; a
  failed refresh keeps the app update and answers `false` (logged). The connection thread then
  calls `restart_when_idle`: 500 ms grace, wait while `LockEngine::is_locked`, then
  `systemctl restart --no-block rp-coded` when `INVOCATION_ID` is set and `/run/systemd/system`
  exists, else `execv` of the executable recorded at startup with the original argv (the
  listening socket is close-on-exec; the new process rebinds and clients reconnect).
  `--no-restart` (env `RP_CODED_NO_RESTART=1`) only logs; `--system-prefix` (env
  `RP_CODED_SYSTEM_PREFIX`) is passed to `install.sh --prefix` (tests). `RP_CODED_VERSION` at
  build time overrides the reported version (test builds that must look newer). Every step is
  logged with the peer. Hooks (`ApplyHooks`: `home_of`, `extract`, `daemon_version_of`,
  `refresh_daemon_files`) are injected so the tests run against a temp root with a fake AppImage
  (a shell script unpacking an embedded tar).
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
- **Session guard** (`src/guard.rs`, pure + tested; OS glue in `main.rs::os`; user guide
  `docs/system-integration.md` "Session guard"): `policy.guard` (`GuardPolicy`, `deny_unknown_fields`;
  `mode` off|audit|enforce, `protectApp`, `wallpaper`, `compositorIpc` allow|shell-only|deny, `shell`
  auto|noctalia|quickshell|hyprpaper|swww|none, `loginHelpers`, `extraDenyPaths`, `extraDenySockets`,
  `allowBinaries`; path entries absolute or `~/`/`@{HOME}/`, no whitespace/quotes; a mode other than
  off requires `app.users`) → `GuardRules` with defaults. A **table** (`NOCTALIA`, `QUICKSHELL`,
  `HYPRPAPER`, `SWWW`, `HYPRLAND`, `SWAY`, `NIRI`: binaries, process names, socket globs, config/state
  globs) plus **discovery** (`parse_proc_net_unix` listening path sockets + `/proc/<pid>/fd` of the
  listed users' shell/compositor processes, `generalise_socket_path`: `/run/user/<uid>` →
  `@{run}/user/[0-9]*`, `/home/<x>` → `@{HOME}`, digit/hex runs → `*`) feed `render(rules, ctx)` →
  five files `/etc/apparmor.d/rp-code-{session,app,shell,compositor,login}` (self-contained: own
  `@{run}`/`@{HOME}`, `abi <abi/4.0>` when present, no includes): `rp-code-session` (every class
  allowed, `/** mrwlk`, `/** ix`, `px -> rp-code-app|shell|compositor` for the known binaries,
  `ux` for `allowBinaries`, guarded socket `rw` / file `wl` / `signal (send)` / `ptrace (trace)
  peer=rp-code-app` rules); `rp-code-app` (attached to `/opt/rp-code/current/rp-code`, `file,`,
  guards `signal (receive)`/`ptrace (tracedby)` from the other three); `rp-code-shell` (`/** px ->
  rp-code-session`, its socket `r` guarded so it can bind (`w`) but not connect (`rw`), compositor
  sockets guarded with `compositorIpc: deny`); `rp-code-compositor` (children `px -> rp-code-session`);
  `rp-code-login` (attached to the login helpers, always complain, `^<user>` hats with `/** px ->
  rp-code-session`, `^DEFAULT` with `/** ux`). Audit mode = `audit <rule>` + `flags=(complain)`,
  enforce = `audit deny <rule>` (explicit deny is enforced even in complain mode). Header line
  `# rp-code-guard <sha256[..16]>` makes re-engages idempotent. `apply(policy, hooks, paths)`:
  off → `apparmor_parser -R` + remove files; else resolve context (existing helpers/binaries,
  cached + fresh discovery), write changed files, `-Q -K` then `-r -K`, state to
  `/etc/rp-code/guard-state.json` (`GuardState { mode, hash, loaded, users, sockets, appliedAt,
  lastError }`); returns `GuardInfo { available (securityfs present), mode, loaded, users, residual,
  pamConfigured (pam_apparmor.so line in system-login/common-session), shell, compositor,
  appliedAt, lastError }`. Runs at daemon start, every ~5 s when the policy file's stamp changed,
  and on `guard-apply`; `rp-coded --guard-apply|--guard-off` do one engage from the CLI (the
  installer calls them). **Audit tail**: once engaged, a thread runs `journalctl -f -o json -n 0
  _TRANSPORT=kernel + _TRANSPORT=audit` (fallback `/dev/kmsg`), `parse_audit_message` keeps
  `apparmor="DENIED|ALLOWED|AUDIT"` records whose `profile` starts with `rp-code-`, classifies
  `kind` (signal/ptrace/exec by operation, `ipc` for connect/bind/… or `.sock`/`/hypr/` names, else
  `config`), `AttemptLimiter` allows one per `kind:target` every 10 s, then `broadcast`s
  `{ "ev": "guard-attempt", "at", kind, target, command, pid, blocked, profile, operation,
  requested? }` to connections that sent `{ op: 'subscribe', events: ['guard-attempt'] }` (per
  connection, replaced by a later `subscribe`, `[]` unsubscribes, dropped on disconnect; the
  connection's writer is shared under a mutex so pushed lines never interleave with responses).
  `status` carries `guard: GuardInfo`; `guard-status` returns it without touching anything
  (the policy's mode with a "guard-apply is pending" residual when it differs from the state).
  The unit adds `CAP_MAC_ADMIN` and `ReadWritePaths` for `/etc/apparmor.d` and
  `/sys/kernel/security/apparmor`. Tests: profile snapshots (Noctalia+Hyprland+SDDM in audit
  and enforce, switches, no shell/compositor), audit-line parsing (kernel and journald forms),
  limiter, path generalisation, `/proc` fixtures, state round trip, `apply` through fake hooks
  (engage, idempotent re-engage with cached sockets, enforce rewrite, parser failure, off, no
  LSM), socket-level `guard-apply`/`guard-status`/policy-change and `subscribe` + pushed events,
  and the generated profiles through `apparmor_parser -Q` when it is installed (CI installs it).
- Layout: `src/main.rs` (socket server, signals, keepalive and update OS glue, self-restart),
  `src/protocol.rs` (serde types + tests), `src/policy.rs` (load/validate/clamp + tests, `app`
  rules, `allow_downgrade`, `guard` rules), `src/guard.rs` (session guard: table, profile
  rendering, audit parsing, discovery parsing, state, `apply` behind `GuardHooks`),
  `src/keepalive.rs` (relaunch decisions, pure), `src/sysinstall.rs`
  (versions.json, semver, checksum, tree checks, swap, `apply_update` behind `ApplyHooks`),
  `src/lock.rs` (grab/emergency/timer behind a `DeviceSource` trait so tests use fakes),
  `src/inject.rs` (keymap + combo parsing, tested purely), `src/devices.rs`. `cargo test` must
  pass here without devices (the chown/swap parts of the update tests need root and are skipped
  otherwise); `--check-devices` flag prints what it can open (used by the installer).
- `native/rp-coded/dist/`: `rp-coded.service`, `70-rp-code.rules`
  (`KERNEL=="uinput", GROUP="rp-code", MODE="0660", OPTIONS+="static_node=uinput"` — lets
  `rp-code` group members use `/dev/uinput` directly; the daemon itself needs no rule), `modules-load.d/rp-code.conf`
  (`uinput`), `policy.example.json` (every field with comments in an adjacent `POLICY.md`),
  `rp-code-autostart.desktop` (XDG autostart, `Exec=rp-code --hidden`), `rp-code.service` (systemd
  **user** unit alternative: `WantedBy=graphical-session.target`).

## Installer (`native/rp-coded/install.sh`, also shipped in the app's resources)

Run as root (`sudo` or `pkexec`). Flags: `--app-bin <path>` (the rp-code executable or AppImage;
auto-detected when run from the app: an existing `/opt/rp-code/current/rp-code` first, then an
AppImage in the usual places), `--user <name>` (default `$SUDO_USER`/`$PKEXEC_UID`),
`--autostart xdg|systemd|none` (default xdg), `--policy-template` (write the example policy if none
exists), `--system-install`/`--no-system-install` (default: yes when `--app-bin` is an AppImage),
`--rollback`, `--remove`, `--refresh-daemon-files`, `--guard`/`--no-guard` (session guard: the
`pam_apparmor.so` line — `session optional pam_apparmor.so order=user,group,default # rp-code
session guard` — inserted as the last session line of `/etc/pam.d/system-login` (Arch; after
`session required pam_env.so`, else after `-session optional pam_systemd.so`, else after the
last session line, else appended) or `common-session` (Debian/Ubuntu), idempotent through the
marker, replaced when stale, removed by `--no-guard`/`--uninstall`; then `rp-coded --guard-apply`
/ `--guard-off` from the installed binary, skipped under `--prefix`. Alone: only that step; with
install flags: forced; without either flag a full install engages when the policy file's
`guard.mode` is not `off`. Warns when `/sys/kernel/security/apparmor` or `pam_apparmor.so` is
missing), `--prefix <dir>` (tests: every system path
under `<dir>`, no groups/services/udev/module/menu-cache commands), `--uninstall`. `install_file`
copies to `<dst>.new` and renames (a running binary is replaced atomically). Steps, idempotent and
printed as `[ok]`/`[skip]` lines:
1. `groupadd -f rp-code`; `usermod -aG rp-code <user>` (prints that a re-login is needed).
2. `install -m 0755 rp-coded /usr/local/libexec/rp-code/rp-coded`, the systemd unit to
   `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now rp-coded`.
3. udev rule to `/etc/udev/rules.d/70-rp-code.rules`, `modules-load.d`, `modprobe uinput`,
   `udevadm control --reload && udevadm trigger --subsystem-match=misc`.
4. `/etc/rp-code/policy.json`: only with `--policy-template`, created from the example if absent,
   `root:root 0644` (an existing file is never touched). `/etc/rp-code` 0755 is created in step 2,
   before the service starts, because the unit's `ReadWritePaths=-/etc/rp-code` needs it to exist.
5. System install (AppImage): `<AppImage> --appimage-extract` into `/opt/rp-code/.staging` (as
   root; the file is the user's own AppImage, the same trust as running the installer from it),
   `check_tree` (same rules as the daemon), `chown -R root:root`, `chmod -R u=rwX,go=rX,a-s`,
   `previous` removed, `current` → `previous`, tree → `current`, `versions.json` (version from the
   tree's `X-AppImage-Version`, else the file name, else `0.0.0`; the old `current` entry becomes
   `previous`, read back with a line-based awk since both writers emit one key per line),
   `/usr/local/bin/rp-code` → `current/rp-code`. Skipped when `versions.json` already names this
   version from this AppImage. `APP_EXEC` for every launcher becomes `/opt/rp-code/current/rp-code`.
6. Menu entry + icon (`--menu-entry`), 7. autostart for the user: XDG `~<user>/.config/autostart/rp-code.desktop`
   with the app path, or the systemd user unit in `~<user>/.config/systemd/user/` (enabled via
   `systemctl --user` when a session bus is available, else printed); files chowned to the user.
   Also print the Hyprland `exec-once = <app> --hidden` line for people who prefer it.
8. Browser policy (`--browser-extension`), 9. session guard (see `--guard`), 10. `rp-coded --check-devices` summary.
`--uninstall` reverses everything (including the system install) except the policy file (prints how
to remove it). `--rollback`: `current` ⇄ `previous` and the two `versions.json` entries. `--remove`:
delete `current`, `previous`, `.new`, `.staging*`, `versions.json`, the symlink, and `/opt/rp-code`
when empty (the `.deb` keeps its files there). `--refresh-daemon-files`: daemon binary, docs, unit,
udev rule, module list, menu entry (if present) + icon, `systemctl daemon-reload`, `udevadm control
--reload` when the rule changed — no group/user/autostart/policy steps and no restart.
`scripts/install-smoke.sh` runs all of this against a `--prefix` with a fake AppImage (CI, as root),
including the PAM edit against the Arch `system-login` layout (placement after `pam_env.so`,
idempotency, stale-line replacement, the `pam_systemd`/last-line/`common-session` fallbacks,
engage from the policy's `guard.mode`, removal by `--no-guard` and `--uninstall`).
The deb package runs `install.sh --autostart none --menu-entry no` in `afterInstall` (electron-builder
`deb.afterInstall`), skipping the user-specific steps and **not** passing `--policy-template` (the
policy is write-once; the user creates it from the app); the app's Settings → System button runs it
with `pkexec` for the current user.

## App (desktop main)

- `src/main/system/daemon-client.ts`: `DaemonClient` (connect on demand, `hello`, request/response
  with 10 s timeout — `apply-update` 5 min (`APPLY_UPDATE_TIMEOUT_MS`, `applyTimeoutMs`) —,
  reconnect, `status()` (with `keepalive`/`install`/`guard` when reported), `setPolicy(policy)` → `{ path }`,
  `guardApply()`/`guardStatus()` → `GuardInfo`,
  `applyUpdate({ file, version, sha512 })` → `{ version, restartDaemon }` (errors mapped like the
  other ops), `waitForHello(timeoutMs)` (fresh handshake retried with a growing delay, 500 ms → 5 s;
  resolves with whether the daemon is back)), unit-tested with a fake socket server. `rpErrorCodeFor`/`toRpError` map daemon codes for every caller: `REFUSED`/`POLICY` →
  `PERMISSION_DENIED`, `INVALID`/`EXISTS` → `INVALID_ARGUMENT` (`details.daemonCode` keeps the
  original), others → `CAPABILITY_FAILED`.
- `src/main/system/policy.ts`: `loadPolicy(path)` → `{ policy, managed: ManagedSettingsPaths, app }`;
  `applyPolicy(settings, policy)` (pure, tested) forces the listed keys; `appPolicy(policy)` →
  `{ allowQuit, users }` with defaults (`app.allowQuit` is not a settings key: it is reported as
  `SystemIntegrationStatus.policy.allowQuit`/`.users`, never in `managed`). `parsePolicy` accepts
  `app.allowQuit` (boolean) and `app.users` (non-empty string array), ignores unknown `app` keys. `SettingsService` results
  and every `settings.get()` go through `applyPolicy`; `settings.update` ignores managed paths and
  the response carries the forced values. Policy file is re-read when its mtime changes
  (`PolicyWatcher.invalidate()` forces the next read). `parseGuard` mirrors the daemon's
  validation of the `guard` block (enums, path lists, `mode` other than off needs `app.users`);
  `guardMode(policy)` → the effective mode.
- `InputHandler` is daemon-only: `lock/unlock/status/type/key/click/moveMouse` go through rp-coded
  (the daemon clamps; the app also clamps to `maxInputLockMs`) and `status()` reports `locked` from
  the daemon. There are no input command templates and no fallback: while the daemon is missing or
  unreachable (including every non-Linux platform) each method throws `CAPABILITY_FAILED` with
  "Input control needs the rp-code system integration (Settings → System → Install); the daemon is
  not connected".
- `src/main/system/integration.ts`: `SystemIntegrationStatus` assembly (daemon hello, policy,
  udev rule present, group membership via `id -Gn`, autostart detection, `install`), `install()`
  runs the bundled `install.sh` through `pkexec` (Linux; refuses elsewhere) with `--app-bin
  process.execPath` (or the AppImage path from `APPIMAGE` env), `--no-system-install` when
  `options.systemInstall === false`, and streams output, `setAutostart()` writes/removes the XDG
  desktop entry for the current user without privileges, `installerPath()`. System install
  detection (pure, tested): `isSystemInstallExec(realpath(execPath), dir)` — `dir` is
  `SYSTEM_INSTALL_DIR` (`/opt/rp-code/current`, env `RP_SYSTEM_INSTALL_DIR` in engine.ts);
  `systemInstallStatus({ execPath, dir, appImage, daemon })` → `SystemInstallStatus { systemInstall:
  execInDir && daemon.connected, dir, execInDir, daemonSupportsUpdates: daemon reports `install`,
  canSystemInstall: launched as an AppImage, current?, previous?, daemonVersion? }`.
  `status().policy.canCreate` = daemon connected and no policy file. `policyTemplate(settings)` (pure):
  pretty JSON of a `PolicyFile` seeded from the current settings (`version: 1`, `managedBy: ""`, every
  managed `settings` key with the current values, `updates.enabled: true`, `inputLock` = `{ enabled,
  maxDurationMs: maxInputLockMs, emergencyKey: 'esc', emergencyHoldMs: 5000 }`). `createPolicy(text)`:
  `JSON.parse` + `parsePolicy` (`INVALID_ARGUMENT` with `details.problems`), sends the object the user
  wrote to `daemon.setPolicy` (so the daemon's stricter unknown-key check applies), `policy.invalidate()`,
  returns `status()`. **Session guard**: `status().guard` = `guardStatusOf({ policy, daemon })`
  (pure): the daemon's `GuardInfo` plus `configured` (policy mode ≠ off) and
  `daemonSupportsGuard`; without a guard-aware daemon `available: false` and a residual saying
  so. `guardApply()` → `daemon.guardApply()` then `status()`. `guardAttempts()` → the last
  `GUARD_ATTEMPT_LOG_SIZE` (50) `GuardAttemptRecord`s from `GuardAttemptLog` (newest first),
  which engine.ts feeds from the keepalive link's events. `install()` adds `--guard` when the
  policy's `guard.mode` is not `off`.
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
  After `register` it sends `subscribe` for every `DaemonEventName` (`guard-attempt`); an older
  daemon's INVALID is logged at debug level and ignored. Lines with an `ev` key are pushed
  events (`DaemonEvent`) dispatched to `onEvent` listeners instead of the pending request queue;
  `subscribed` reports the acknowledged subscription. engine.ts turns each `guard-attempt` into
  a `GuardAttemptRecord` in the log and the `guard-attempt` host event (`emit` into the senses
  provider; data `{ kind, target, command, pid, blocked, profile, operation, requested? }`).
  The single-instance lock (already present) makes a duplicate relaunch exit at once.
- **Updates on a system install** (`src/main/updates/service.ts`, `system-updater.ts`): engine.ts
  wires `UpdateServiceDeps.systemInstall` (`dir`, `available()` → `{ daemonConnected,
  daemonSupportsUpdates, current?, previous? }` from `daemon.status().install`, `applyUpdate`,
  `waitForDaemon`, `relaunch`) only when the executable runs from the install dir; then
  `detectPackaging` → `'system'`, the updater is a `SystemInstallUpdater` (an `AppImageUpdater`
  subclass: `isUpdaterActive` without the `APPIMAGE` check, `doDownloadUpdate` as a full download
  through the provider's file list into the electron-updater cache — no delta, no old AppImage —,
  `doInstall` refused, `autoInstallOnAppQuit` off) instead of `autoUpdater`. `canInstallInPlace`
  = daemon connected and supports updates (never cached); `UpdateStatus.systemInstall` and
  `reason` explain the state. `update-downloaded` records `{ file: downloadedFile, version, sha512 }`
  (`appImageSha512`: the `files` entry ending in `.AppImage`, else the first, else the legacy
  top-level `sha512`). `install()`: state `installing` → `applyUpdate` → when `restartDaemon`,
  `waitForDaemon(30 s)` (relaunch anyway when it does not come back, logged) → `beforeRestart`
  (authorised quit + keepalive `unregister`) → `relaunch()` = `app.relaunch({ execPath:
  '<dir>/rp-code', args })` + `app.quit()`. A daemon error goes back to `ready` with `error` set
  (retryable) and rejects. The AppImage path (`quitAndInstall`) is unchanged.
- Bundling: `resources/bin/rp-coded` (built by `scripts/build-native.mjs` alongside the helper) and
  `resources/system/{install.sh,rp-coded.service,70-rp-code.rules,...}`; electron-builder
  `extraResources` + `deb.afterInstall` script that calls the installer.
- IPC `system.*` (`status`, `install`, `setAutostart`, `installerPath`, `createPolicy(text)`,
  `policyTemplate()` — the latter reads the current settings in main —, `guardApply()`,
  `guardAttempts()`), `settings.managed` and
  `updates.*` (the update service reads `settings.updates` from the same policy state).

### Policy `app` block

| Key | Type | Effect |
|---|---|---|
| `app.allowQuit` | boolean, default `true` | `false`: no Quit in the tray, close hides, Ctrl+Q/`app.quit()`/signals ignored; the daemon relaunches the app for the listed users. |
| `app.users` | non-empty `string[]` of unix user names | Who the daemon relaunches (must also own the active graphical session). Absent/empty → nobody. Shown in Settings → System ("Quitting is disabled by policy … for: alice, bob"). |

### Policy `guard` block

`GuardPolicy` in `@rp/shared/system.ts`; validated identically by `parseGuard` (app) and `validate_guard` (daemon). `mode` `off` (default) \| `audit` \| `enforce`; `protectApp`, `wallpaper` booleans (default true); `compositorIpc` `allow` \| `shell-only` (default) \| `deny`; `shell` `auto` (default) \| `noctalia` \| `quickshell` \| `hyprpaper` \| `swww` \| `none`; `loginHelpers` (non-empty, absolute), `extraDenyPaths`/`extraDenySockets` (absolute, `~/…` or `@{HOME}/…`), `allowBinaries` (absolute) — no whitespace or quotes anywhere (they become AppArmor rules). A `mode` other than `off` without `app.users` is invalid; the listed users are the ones confined. Not a settings key; reported as `SystemIntegrationStatus.guard`.

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
| `updates` | `updates.automatic`, `updates.enabled` (`allowDowngrade` accepted, never managed) | booleans. `enabled: false` switches update checks off entirely (`UpdateStatus.state === 'disabled'`, token field hidden, `automatic` forced off); `automatic` pins the background-check toggle; `allowDowngrade: true` lets the daemon's `apply-update` install an older version (daemon-enforced, default false). |
| `browser` | `browser.allowBlocking`, `browser.allowEval`, `browser.allowHistory`, `browser.homePage` | booleans, a non-negative number (ms; the cap on `sdk.browser.block` durations), an http(s) URL or `""`. What characters may do through the browser extension (docs/browser-extension.md). |

## Renderer

- Settings → **System** tab: daemon status card (connected/version/devices/locked), "App install"
  card (`systemInstallLine()`: "System install: /opt/rp-code/current (v1.2.3), previous v1.2.2" /
  daemon offline / AppImage that the installer can unpack / not a system install; a warning when
  the daemon is too old to apply updates), the install dialog's "Install the app to /opt/rp-code"
  checkbox (shown for an AppImage launch, default on → `system.install({ systemInstall })`), policy card
  (managed-by text, list of forced settings, a warning line "Quitting is disabled by policy
  (managed by …) for: alice, bob" when `policy.allowQuit` is false — `quitDisabledLine()`; without a file and with `policy.canCreate`: **Create
  policy…** → modal with the write-once explanation, a monospace textarea prefilled from
  `system.policyTemplate()`, "Reset to current settings", an "I understand this cannot be undone
  without root" checkbox gating **Write policy**, validation problems in a danger callout; on success
  toast "Policy written", reload status and settings so managed badges appear; without the daemon a
  hint to install the system integration), **Session guard** card (`guardLine()`: "Session guard:
  audit (AppArmor) — 5 profiles loaded — users: work — shell noctalia, compositor hyprland — applied …",
  "unavailable: AppArmor is not active…", or "Off…"; badge off/audit/enforce/pending/unavailable/error;
  `lastError` callout; a warning when `pamConfigured` is false; a collapsible "What it cannot do"
  list from `residual`; **Audit log…** opens `GuardAuditDialog` with the last 50
  `system.guardAttempts()` rows (`guardAttemptLine()`); **Apply now** → `system.guardApply()`),
  udev/group status with the "re-login required" hint,
  "Install system integration…" (explains what it does, runs `system.install`, shows the output),
  "Start on login" toggle (`system.setAutostart`), "Installer script path" with copy button.
- Settings → **Updates**: packaging "System install · applied by the system service", an Install
  line with the directory and versions, `installing` state ("Applying …", spinner), the button
  reads "Apply update and restart", errors are shown whatever the state (an apply failure leaves
  the update ready to retry); the AppImage wording is unchanged for AppImage launches. The
  update-ready dialog in `index.ts` says the system service installs it.
- Managed settings: every settings control whose path is in `settings.managed()` renders disabled with
  a small "managed by policy" badge (Providers, General, Permissions toggles, Integrations
  allowlists, autonomy fields, max input lock).

## Docs

`docs/system-integration.md`: why the daemon, what the installer changes, the policy file reference,
emergency unlock chord, the session guard (what it blocks, the verified AppArmor facts with sources,
the login-helper/hat mechanism, audit → enforce procedure, limits, recovery), uninstall, security
notes (group membership means "may lock input and inject keys", so treat `rp-code` group like `input`).

## Host event `guard-attempt`

`HostEventName` gains `guard-attempt` (`packages/shared/src/senses.ts`; `HOST_EVENT_NAMES` in
`packages/core/src/services/events.ts`, mirrored in the SDK preamble); data is the `GuardAttempt`
(`kind`, `target`, `command`, `pid`, `blocked`, `profile`, `operation`, `requested?`). Filters:
`kind`/`blocked`/`pid` exact (the generic JSON comparison), `target`/`command` case-insensitive
substring. Subject to the usual 2 s debounce of identical events; the daemon already limits one per
target every 10 s. Documented for characters in `packages/sdk/src/modules/events.ts`.
