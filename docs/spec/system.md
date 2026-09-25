# System integration (Linux): daemon, policy, udev, autostart, installer

Problem: locking input and injecting keystrokes need `/dev/input/*` and `/dev/uinput`, which an
unprivileged user does not have; and settings that live in the user's own config directory cannot
be locked against the user. Solution: a small root daemon **`rpchatd`** that owns device access
and enforces a root-owned **policy file**; the app talks to it over a unix socket. An installer
script sets everything up (group, udev rule, daemon service, policy template, autostart).
Contracts: `@rp/shared/system.ts` (`PolicyFile`, `DaemonRequest/Response`, `SystemIntegrationStatus`,
`DAEMON_SOCKET_PATH`, `POLICY_FILE_PATH`, `SYSTEM_GROUP`, `CryptoKeyRecord`), `@rp/shared/crypto.ts`
(`CryptoStatus`), `IpcApi.system`, `IpcApi.crypto`, `IpcApi.settings.managed`.

## `native/rpchatd` (Rust, Linux only)

- Binary `rpchatd`, runs as root under `rpchatd.service` (systemd system unit, `Type=simple`,
  `Restart=on-failure`, hardened: `ProtectSystem=strict`, `ReadWritePaths=/run/rpchat`,
  `DeviceAllow=/dev/input/* rw`, `DeviceAllow=/dev/uinput rw`, `NoNewPrivileges=yes`; for the
  system install `ReadWritePaths=-/opt/rpchat` plus the daemon's own file locations —
  `/usr/local/libexec/rpchat`, `/usr/local/bin`, `/etc/systemd/system`, `/etc/udev/rules.d`,
  `/etc/modules-load.d`, `/usr/local/share/{applications,icons}` — so it can refresh them after
  updating itself).
- Listens on `/run/rpchat/daemon.sock` (dir 0750 root:rpchat, socket 0660 root:rpchat) so only
  members of the `rpchat` group can talk to it. JSON lines, one request per line, one response.
- **Policy**: reads `/etc/rpchat/policy.json` at start and on every `policy` request (mtime cache);
  validates shape; refuses `lock` when `inputLock.enabled === false`; clamps `lock` durations to
  `inputLock.maxDurationMs` (default 300 000). Never trusts the app's numbers.
- **The policy seal** (`src/seal.rs`, `src/totp.rs`, `src/runtime.rs`, `src/remote.rs`; user guide
  `native/rpchatd/dist/POLICY.md` "Locking the policy behind a code"): sealing turns the
  write-once policy into one that can be replaced and removed with a TOTP code and nothing else.
  A seal is in one of two mutually exclusive `mode`s — `totp` (a code unlocks it locally) or
  `chain` (no secret exists; only a signed policy chain can change anything). `seal-policy`
  generates a 160-bit secret (`/dev/urandom`) and writes `Seal { version, sealedAt, managedBy,
  mode, totp?, secret?, chain?, policyHash, policy, lastCounter, failures, lockedUntil, tampers }`
  to `/etc/rpchat/policy.seal`
  (`0600`) plus the mirrors `/var/lib/rpchat/policy.seal` and
  `/usr/local/libexec/rpchat/policy.seal`, and a world-readable `policy.sealed` marker (`0644`)
  carrying everything but the secret, and answers **once** with the secret and the `otpauth://`
  URI. A `chain` seal (`create_chain`, reached through `set-remote-link`) generates nothing: it
  holds `ChainState { url, key, keyId?, head, seq, intervalMinutes?, linkedAt, managedBy?,
  rotations }` — a public key and a position — so there is nothing on the machine to steal or to
  mint an unlock with, and `set-policy`/`unseal-policy` are refused with `CODE`. A policy with no `lock` block gets an empty one written into it first,
  so what is in force is readable in the file. `set-policy` with a valid `code` replaces the
  policy and re-pins the seal; `unseal-policy` removes it (`removePolicy` takes the file too);
  `seal-status` reports `SealInfo`/`RuntimeInfo`/`RemoteInfo` without secrets. Codes are RFC 6238
  (SHA-1/256/512, 6–8 digits, 15–300 s, ±`window` steps), spent once (`lastCounter`), and after
  `FREE_ATTEMPTS` (3) failures the lock refuses everything for 30 s doubling to 15 min
  (`lockout_secs`, pure + tested). `--seal-status`, `--unseal <code>` and
  do the same from a root terminal — being root is not enough for the unseal. `totp.rs` is self-contained (SHA-1, HMAC, base32, `otpauth` URI) and tested against
  the RFC 2202/4231/6238 vectors.
- **The runtime policy filesystem** (`src/runtime.rs`): the effective policy is published into
  `/run/rpchat/policy` — a tmpfs the daemon mounts (`MS_NOSUID|MS_NODEV|MS_NOEXEC`,
  `mode=0750,size=1m`), writes `policy.json` (`0640 root:rpchat`) and `state.json` into, then
  remounts read-only. The app reads it from there in preference to `/etc/rpchat/policy.json`, so
  on a sealed machine editing the file changes nothing. Every failure (no `CAP_SYS_ADMIN`, no
  tmpfs, a container) degrades to a plain directory and is reported in `RuntimeInfo.degraded`,
  which surfaces as a residual rather than a silent loss. `mount_state` parses
  `/proc/self/mountinfo` (pure); `MountOps` is a trait so the tests need no privileges. The unit
  gains `MountFlags=shared` (a sandboxed unit's namespace is `slave` by default, which would keep
  the mount invisible to the app), `CAP_SYS_ADMIN` and `CAP_LINUX_IMMUTABLE`.
- **Self-heal and tamper events**: every ~5 s (the tick that already re-engages the guard) a
  sealed daemon restores missing seal copies, compares the policy file against `seal.policyHash`
  and rewrites it from the sealed copy when it differs (`lock.selfHeal`), re-arms the immutable
  attributes (`lock.immutable`, `FS_IOC_SETFLAGS`), rewrites the `RefuseManualStop=yes` drop-in
  (`lock.refuseManualStop`) and republishes the runtime filesystem when what is there has drifted
  or been remounted writable. Each noticed change is kept in the seal (capped at 20) and pushed as
  `policy-tamper`; a changed effective policy is pushed as `policy-changed`.
- **The policy chain** (`src/chain.rs`, pure + tested): a hash-linked, signed sequence of policies
  and the only way into a `chain`-mode machine. A link is `{ seq, prev, issuedAt?, policy?,
  nextKey?, unseal?, signature }`; `prev` is the SHA-256 of the previous link's canonical bytes
  (the link minus `signature`, compact JSON with sorted keys — what `serde_json` writes and what
  `JSON.stringify` over recursively sorted entries writes). Signing is Ed25519
  (`ed25519-dalek`, `verify_strict`) over `rpchat-chain/v1\n` + those bytes. `apply(text, ctx)`
  finds the link whose `prev` is the machine's head, walks forward verifying `seq`, `prev`,
  `keyId` and the signature of each, and returns `Applied { policy, head, seq, key, unseal,
  applied, rotations }`; links at or before the head are skipped (the head commits to them),
  a file that does not reach the machine is `NoContinuation`, and being already at the tip is
  `applied: 0` rather than an error. `nextKey` rotates the trusted key and is signed by the key it
  replaces, so a successor cannot introduce itself. Replay and reordering are structurally
  impossible: an old link's `prev` no longer matches.
- **Remote Link** (`chain::RemoteLink`): the base64 blob that establishes all of it — `{ version,
  url, key, keyId?, intervalMinutes?, managedBy?, mode?, signature }`, self-signed by the key it
  carries, so a blob mangled in transit is refused. `set-remote-link` applies it: on an unlinked
  machine it seals in the named mode (`chain` by default; `totp` also generates the secret and
  returns it once), on a `totp` machine it needs the code, on a `chain` machine it is refused.
- **Packs the policy pins** (`policy.packs`): pinned by an Ed25519 **signature** over
  `rpchat-pack/v1\n<id>\n<version>\n<sha256>` rather than a bare checksum — on a managed machine
  the policy itself arrived over the network, so a checksum in it proves only that policy and pack
  agree. Validated by the daemon (pack-id shape, https/loopback URLs, 64-hex checksums, 64-byte
  signatures, no duplicates, ≤ 64 entries); the app downloads and hashes and the daemon decides
  (`verify-pack`), which keeps the payload off the socket and the decision with the side holding
  the key. A signature is required where the machine has a Remote Link and `sha256` is the
  fallback where it does not. `src/main/system/remote-config.ts` then installs through
  `PackService`, refuses an archive whose id or version is not the pinned one, and — with
  `removeUnlisted` — uninstalls everything not listed. Independent of `remote`: a local policy can
  pin packs too.
- **`set-policy` (write once)**: `{ op: 'set-policy', policy: PolicyFile }` → `{ ok, op, path }`.
  Validates `policy` exactly like the file (`deny_unknown_fields` + `validate()`; failures →
  `INVALID` with the message), answers `EXISTS` when anything (file, symlink, directory) is already
  at the policy path, creates the parent directory `0755` when missing, writes the object as pretty
  JSON + newline through `O_CREAT|O_EXCL` (`0644`, fsync) — atomic existence check, never replaces
  anything — logs `policy created at <path> by uid/pid (managedBy)`, drops the store cache. The unit
  has `ReadWritePaths=-/etc/rpchat` for this (the installer creates the directory before the
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
  `current/rpchat`); errors use the codes in `DaemonResponse` (`REFUSED`, `POLICY`, `NO_DEVICES`,
  `BUSY`, `INVALID`, `INTERNAL`, `EXISTS`).
- **System install / `apply-update`** (`src/sysinstall.rs`, root `--install-root`, default
  `/opt/rpchat`, env `RPCHATD_INSTALL_ROOT`): `{ op: 'apply-update', file, version, sha512 }` →
  `{ ok, op, version, restartDaemon }`. One at a time (`BUSY`), refused while a self-update
  restart is pending. Gate (`REFUSED`): peer uid ≠ 0; `versions.json` and `current/rpchat` exist;
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
  `check_tree`: `rpchat`, `libffmpeg.so`, `resources/app.asar` present, no setuid/setgid bit, no
  hard link (`nlink > 1`), only files/dirs/symlinks, relative symlinks that resolve inside the
  tree; `normalise_tree`: `lchown root:root`, dirs `0755`, files `0755` when any x bit else `0644`
  (this also drops every setuid bit), verified again (`verify_root_owned`); then `staging/squashfs-root`
  → `<root>/.new`, `swap_in`: remove `previous`, rename `current` → `previous`, `.new` → `current`
  (a failed last rename restores `current`); `versions.json` `{ current: { version, installedAt,
  source: file }, previous }` written via temp + rename `0644`. Failures clean the staging area.
  Then **self-update**: `current/resources/bin/rpchatd --version` parsed (`rpchatd X.Y.Z (protocol N)`);
  when newer than the running `VERSION` — **or the same version but a different build**, compared
  by hashing the bundled binary against `/proc/self/exe` — `current/resources/system/install.sh --refresh-daemon-files
  [--prefix <p>]` runs as root (output logged) and the answer carries `restartDaemon: true`; a
  failed refresh keeps the app update and answers `false` (logged). The connection thread then
  calls `restart_when_idle`: 500 ms grace, wait while `LockEngine::is_locked`, then
  `systemctl restart --no-block rpchatd` when `INVOCATION_ID` is set and `/run/systemd/system`
  exists, else `execv` of the executable recorded at startup with the original argv (the
  listening socket is close-on-exec; the new process rebinds and clients reconnect).
  `--no-restart` (env `RPCHATD_NO_RESTART=1`) only logs; `--system-prefix` (env
  `RPCHATD_SYSTEM_PREFIX`) is passed to `install.sh --prefix` (tests). `RPCHATD_VERSION` at
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
  `SEAT`; `loginctl list-sessions` + `show-session` as fallback; `--sessions-dir`/`RPCHATD_SESSIONS_DIR`
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
  five files `/etc/apparmor.d/rpchat-{session,app,shell,compositor,login}` (self-contained: own
  `@{run}`/`@{HOME}`, `abi <abi/4.0>` when present, no includes): `rpchat-session` (every class
  allowed, `/** mrwlk`, `/** ix`, `px -> rpchat-app|shell|compositor` for the known binaries,
  `ux` for `allowBinaries`, guarded socket `rw` / file `wl` / `signal (send)` / `ptrace (trace)
  peer=rpchat-app` rules); `rpchat-app` (attached to `/opt/rpchat/current/rpchat`, `file,`,
  guards `signal (receive)`/`ptrace (tracedby)` from the other three); `rpchat-shell` (`/** px ->
  rpchat-session`, its socket `r` guarded so it can bind (`w`) but not connect (`rw`), compositor
  sockets guarded with `compositorIpc: deny`); `rpchat-compositor` (children `px -> rpchat-session`);
  `rpchat-login` (attached to the login helpers, always complain, `^<user>` hats with `/** px ->
  rpchat-session`, `^DEFAULT` with `/** ux`). Audit mode = `audit <rule>` + `flags=(complain)`,
  enforce = `audit deny <rule>` (explicit deny is enforced even in complain mode). A rule whose
  permissions include exec goes through `guarded_exec` instead: an *allow* rule has to say how the
  exec transitions, so a bare `x` is a parse error — audit mode emits `ix` (allowed, logged) and
  enforce mode the bare `x` that a deny rule needs. Header line
  `# rpchat-guard <sha256[..16]>` makes re-engages idempotent. `apply(policy, hooks, paths)`:
  off → `apparmor_parser -R` + remove files; else resolve context (existing helpers/binaries,
  cached + fresh discovery), write changed files, `-Q -K` then `-r -K`, state to
  `/etc/rpchat/guard-state.json` (`GuardState { mode, hash, loaded, users, sockets, appliedAt,
  lastError }`); returns `GuardInfo { available (securityfs present), mode, loaded, users, residual,
  pamConfigured (pam_apparmor.so line in system-login/common-session), warnings, shell, compositor,
  appliedAt, lastError }`; `warnings` carries unconfined login helpers and a **second
  `pam_apparmor.so` line** (`pam_duplicate_warning`), which hangs every login. Discovery drops
  the globs in `NEVER_GUARD` (Wayland/X11 display sockets, the session and system bus, PipeWire
  and PulseAudio) before they reach a profile or the cache: a compositor listens on more than its
  control socket, and guarding the display socket would cut the session off under `enforce`. Runs at daemon start, every ~5 s when the policy file's stamp changed,
  and on `guard-apply`; `rpchatd --guard-apply|--guard-off` do one engage from the CLI (the
  installer calls them). **Audit tail**: once engaged, a thread runs `journalctl -f -o json -n 0
  _TRANSPORT=kernel + _TRANSPORT=audit` (fallback `/dev/kmsg`), `parse_audit_message` keeps
  `apparmor="DENIED|ALLOWED|AUDIT"` records whose `profile` starts with `rpchat-`, classifies
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
- **`sdk.crypto` key storage** (`src/crypto_keys.rs`): one JSON file per uid,
  `/etc/rpchat/crypto-keys/<uid>.json` (dir `0700`, file `0600`, both `root:root` — nobody but
  root/the daemon can open it directly, unlike everything else under `/etc/rpchat`). `crypto-keys`
  returns the requesting peer's key history (`CryptoKeyRecord[]`, oldest first) and
  `activeKeyId`, creating a first 32-byte AES-256 key (`/dev/urandom`, via `totp::random_bytes`)
  the first time a uid is seen; `crypto-rotate-key` generates and appends a new one and makes it
  active. Both are scoped by `SO_PEERCRED` (`ctx.peer.uid`) — the request carries no uid, so a
  user can only ever reach their own history. The app falls back to keeping this history in its
  own config (weaker: anything that can read the user's files can read that one too) when the
  daemon is not installed — see `@rp/core`'s `CryptoManager`/`LocalKeyStore`/`DaemonKeyStore` and
  `packages/sdk/src/modules/crypto.ts`. The encryption log (path, before/after md5, key id) and
  the actual file encryption/decryption are entirely the app's doing, running as the user; the
  daemon never sees a file path or touches a file, only key material.
- Layout: `src/chain.rs` (the policy chain and the Remote Link: canonical bytes, Ed25519
  verification, the walk, rotation — all pure),
  `src/seal.rs` (the seal, its modes, its mirrors, the lockout ladder, the immutable attribute),
  `src/totp.rs` (SHA-1/HMAC/base32/RFC 6238, pure), `src/runtime.rs` (the published policy
  filesystem behind `MountOps`), `src/remote.rs` (the `remote`/`packs` blocks and
  pack-signature verification — pure), `src/crypto_keys.rs` (per-uid key history, pure file I/O),
  `src/main.rs` (socket server, signals, keepalive and update OS glue, self-restart),
  `src/protocol.rs` (serde types + tests), `src/policy.rs` (load/validate/clamp + tests, `app`
  rules, `allow_downgrade`, `guard` rules), `src/guard.rs` (session guard: table, profile
  rendering, audit parsing, discovery parsing, state, `apply` behind `GuardHooks`),
  `src/keepalive.rs` (relaunch decisions, pure), `src/sysinstall.rs`
  (versions.json, semver, checksum, tree checks, swap, `apply_update` behind `ApplyHooks`),
  `src/lock.rs` (grab/emergency/timer behind a `DeviceSource` trait so tests use fakes),
  `src/inject.rs` (keymap + combo parsing, tested purely), `src/devices.rs`. `cargo test` must
  pass here without devices (the chown/swap parts of the update tests need root and are skipped
  otherwise); `--check-devices` flag prints what it can open (used by the installer).
- `native/rpchatd/dist/`: `rpchatd.service`, `70-rpchat.rules`
  (`KERNEL=="uinput", GROUP="rpchat", MODE="0660", OPTIONS+="static_node=uinput"` — lets
  `rpchat` group members use `/dev/uinput` directly; the daemon itself needs no rule), `modules-load.d/rpchat.conf`
  (`uinput`), `policy.example.json` (every field with comments in an adjacent `POLICY.md`),
  `rpchat-autostart.desktop` (XDG autostart, `Exec=rpchat --hidden`), `rpchat.service` (systemd
  **user** unit alternative: `WantedBy=graphical-session.target`).

## Installer (`native/rpchatd/install.sh`, also shipped in the app's resources)

Run as root (`sudo` or `pkexec`). Flags: `--app-bin <path>` (the rpchat executable or AppImage;
auto-detected when run from the app: an existing `/opt/rpchat/current/rpchat` first, then an
AppImage in the usual places), `--user <name>` (default `$SUDO_USER`/`$PKEXEC_UID`),
`--autostart xdg|systemd|none` (default xdg), `--policy-template` (write the example policy if none
exists), `--system-install`/`--no-system-install` (default: yes when `--app-bin` is an AppImage),
`--rollback`, `--remove`, `--refresh-daemon-files`, `--guard`/`--no-guard` (session guard: the
`pam_apparmor.so` line — `session optional pam_apparmor.so order=user,group,default # rpchat
session guard` — inserted as the last session line of `/etc/pam.d/system-login` (Arch; after
`session required pam_env.so`, else after `-session optional pam_systemd.so`, else after the
last session line, else appended) or `common-session` (Debian/Ubuntu), idempotent through the
marker, replaced when stale, and **every other `pam_apparmor.so` session line is collapsed into
it** (two lines make PAM call `change_hat()` twice with different magic tokens; the kernel refuses
the second and leaves the login process with no permissions, so every login hangs silently),
removed by `--no-guard`/`--uninstall` — which warns when a line it did not add is left behind; then `rpchatd --guard-apply`
/ `--guard-off` from the installed binary, skipped under `--prefix`. Alone: only that step; with
install flags: forced; without either flag a full install engages when the policy file's
`guard.mode` is not `off`. Warns when `/sys/kernel/security/apparmor` or `pam_apparmor.so` is
missing), `--prefix <dir>` (tests: every system path
under `<dir>`, no groups/services/udev/module/menu-cache commands), `--uninstall`. `install_file`
copies to `<dst>.new` and renames (a running binary is replaced atomically). Steps, idempotent and
printed as `[ok]`/`[skip]` lines:
1. `groupadd -f rpchat`; `usermod -aG rpchat <user>` (prints that a re-login is needed).
2. `install -m 0755 rpchatd /usr/local/libexec/rpchat/rpchatd`, the systemd unit to
   `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now rpchatd`.
3. udev rule to `/etc/udev/rules.d/70-rpchat.rules`, `modules-load.d`, `modprobe uinput`,
   `udevadm control --reload && udevadm trigger --subsystem-match=misc`.
4. `/etc/rpchat/policy.json`: only with `--policy-template`, created from the example if absent,
   `root:root 0644` (an existing file is never touched). `/etc/rpchat` 0755 is created in step 2,
   before the service starts, because the unit's `ReadWritePaths=-/etc/rpchat` needs it to exist.
5. System install (AppImage): `<AppImage> --appimage-extract` into `/opt/rpchat/.staging` (as
   root; the file is the user's own AppImage, the same trust as running the installer from it),
   `check_tree` (same rules as the daemon), `chown -R root:root`, `chmod -R u=rwX,go=rX,a-s`,
   `previous` removed, `current` → `previous`, tree → `current`, `versions.json` (version from the
   tree's `X-AppImage-Version`, else the file name, else `0.0.0`; the old `current` entry becomes
   `previous`, read back with a line-based awk since both writers emit one key per line),
   `/usr/local/bin/rpchat` → `current/rpchat`. Skipped when `versions.json` already names this
   version from this AppImage. `APP_EXEC` for every launcher becomes `/opt/rpchat/current/rpchat`.
6. Menu entry + icon (`--menu-entry`), 7. autostart for the user: XDG `~<user>/.config/autostart/rpchat.desktop`
   with the app path, or the systemd user unit in `~<user>/.config/systemd/user/` (enabled via
   `systemctl --user` when a session bus is available, else printed); files chowned to the user.
   Also print the Hyprland `exec-once = <app> --hidden` line for people who prefer it.
8. Browser policy (`--browser-extension`), 9. session guard (see `--guard`), 10. `rpchatd --check-devices` summary.
`--uninstall` reverses everything (including the system install) except the policy file (prints how
to remove it). `--rollback`: `current` ⇄ `previous` and the two `versions.json` entries. `--remove`:
delete `current`, `previous`, `.new`, `.staging*`, `versions.json`, the symlink, and `/opt/rpchat`
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
- `src/main/system/policy.ts`: `loadPolicy(path, sources)` reads, in order, the daemon's runtime
  filesystem (`/run/rpchat/policy/policy.json`), the policy file, the seal's world-readable
  marker (`/etc/rpchat/policy.sealed`) and the app's own cache of a sealed policy, reporting
  which through `PolicyState.source` (`runtime`/`file`/`seal`/`cache`/`none`) plus `sealed`,
  `policyHash` and `fromCache`. `PolicyWatcher` stamps all three files, so a republished runtime
  copy is noticed although the file did not change. → `{ policy, managed: ManagedSettingsPaths, app }`;
  `applyPolicy(settings, policy)` (pure, tested) forces the listed keys; `appPolicy(policy)` →
  `{ allowQuit, users }` with defaults (`app.allowQuit` is not a settings key: it is reported as
  `SystemIntegrationStatus.policy.allowQuit`/`.users`, never in `managed`). `parsePolicy` accepts
  `app.allowQuit` (boolean), `app.users` (non-empty string array) and the boolean restriction keys
  below, ignores unknown `app` keys. `SettingsService` results
  and every `settings.get()` go through `applyPolicy`; `settings.update` ignores managed paths and
  the response carries the forced values. Policy file is re-read when its mtime changes
  (`PolicyWatcher.invalidate()` forces the next read). `PolicyWatcher.start()` (called by
  `createEngine`, stopped with it) re-stats the sources every `POLICY_POLL_INTERVAL_MS` (2 s) so a
  policy written outside the app is noticed with nothing calling `current()`, and `onChange(fn)`
  reports every load whose `restrictions`/`managed`/`managedBy`/`app`/`policyHash`/`present` differ
  from the last one a subscriber was told about — the first load is not a change. `parseGuard` mirrors the daemon's
  validation of the `guard` block (enums, path lists, `mode` other than off needs `app.users`);
  `guardMode(policy)` → the effective mode.
- `InputHandler` is daemon-only: `lock/unlock/status/type/key/click/moveMouse` go through rpchatd
  (the daemon clamps; the app also clamps to `maxInputLockMs`) and `status()` reports `locked` from
  the daemon. There are no input command templates and no fallback: while the daemon is missing or
  unreachable (including every non-Linux platform) each method throws `CAPABILITY_FAILED` with
  "Input control needs the rpchat system integration (Settings → System → Install); the daemon is
  not connected".
- `src/main/system/integration.ts`: `SystemIntegrationStatus` assembly (daemon hello, policy,
  udev rule present, group membership via `id -Gn`, autostart detection, `install`), `install()`
  runs the bundled `install.sh` through `pkexec` (Linux; refuses elsewhere) with `--app-bin
  process.execPath` (or the AppImage path from `APPIMAGE` env), `--no-system-install` when
  `options.systemInstall === false`, and streams output, `setAutostart()` writes/removes the XDG
  desktop entry for the current user without privileges, `installerPath()`. System install
  detection (pure, tested): `isSystemInstallExec(realpath(execPath), dir)` — `dir` is
  `SYSTEM_INSTALL_DIR` (`/opt/rpchat/current`, env `RP_SYSTEM_INSTALL_DIR` in engine.ts);
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
- **`dev.allow: false`** (`src/main/dev-guard.ts`, pure + injectable + tested; the first statement
  of `index.ts`): the development switches are refused on a machine whose policy forbids them.
  `readDevRules({ path, readFile })` reads **only** `POLICY_FILE_PATH` — never `env.RP_POLICY_FILE`,
  which is one of the switches — and only the `dev` block of it, so a problem elsewhere in the file
  is the watcher's to report; it fails closed (a file that exists but cannot be read or parsed
  locks). `devRules(policy)` applies the defaults (`allow` true, `devTools` follows `allow`).
  `applyDevGuard({ env, argv, logger })` then, while locked, deletes every development switch from
  `process.env` (`devEnvKeys`/`scrubDevEnv`: the whole `DEV_ENV_PREFIX` = `RP_`, plus
  `DEV_ENV_KEYS` = `ELECTRON_RENDERER_URL`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`) before the
  logger, the window manager or the engine has read any of them — so `dev-mode.ts`, `engine.ts`,
  `logger.ts` and `helper-process.ts` need no checks of their own and a switch added later is
  covered by the prefix — and reports `refusedDevFlags(argv)` (`DEV_ARGV_FLAGS`: `--inspect*`,
  `--remote-debugging-port`/`-pipe`, `--remote-allow-origins`, `--js-flags`; `--no-sandbox`
  deliberately not), on which `index.ts` prints `refusalMessage()` and `app.exit(1)`.
  `WindowManagerOptions.devTools` (`false` → `webPreferences.devTools: false` in every window it
  makes) carries `rules.devTools`; `CreateAppOptions.dev` carries the decision to
  `SystemIntegrationDeps.dev`, which `status().policy.dev` reports — the boot decision, not the
  file as it stands now, because the lock is applied once.
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
  '<dir>/rpchat', args })` + `app.quit()`. A daemon error goes back to `ready` with `error` set
  (retryable) and rejects. The AppImage path (`quitAndInstall`) is unchanged.
- Bundling: `resources/bin/rpchatd` (built by `scripts/build-native.mjs` alongside the helper) and
  `resources/system/{install.sh,rpchatd.service,70-rpchat.rules,...}`; electron-builder
  `extraResources` + `deb.afterInstall` script that calls the installer.
- `src/main/system/seal-cache.ts`: the app's own copy of a sealed policy (`<userData>/sealed-policy.json`,
  `{ version, seenAt, sealedAt?, managedBy?, policyHash, policy }`), written by `status()` whenever a
  sealed machine is seen and dropped **only** when a connected daemon reports an unsealed one — so
  wiping `/etc/rpchat` with the daemon stopped leaves the app managed and reports `policy.fromCache`
  rather than quietly freeing it. `canonicalJson`/`policyHash` match the daemon's hash.
- `src/main/system/remote-config.ts`: `RemoteConfigService` (`start`/`check`/`syncPacks`/`status`,
  `FIRST_CHECK_DELAY_MS` 20 s then `remote.intervalMinutes`, rescheduled whatever the outcome):
  fetches the document (≤ 1 MiB, 30 s), `daemon.remoteApply(text)` with the body untouched, and
  brings `policy.packs` into line — download (≤ 512 MiB, 30 min), check `sha256`, install, refuse a
  mismatched id or version, uninstall the unlisted ones. `packNeedsInstall`, `packsToRemove` and
  `nextCheckDelayMs` are pure. Reported as `RemoteConfigStatus`.
- IPC `system.*` (`status`, `install`, `setAutostart`, `installerPath`, `createPolicy(text)`,
  `sealPolicy(text?)` — the only place the secret, the `otpauth://` URI and the remote key exist —,
  `replacePolicy(text, code)`, `unsealPolicy(code, removePolicy?)`, `remoteRefresh()`,
  `policyTemplate()` — the current policy when there is one, else a template from the current
  settings —, `guardApply()`, `guardAttempts()`), `settings.managed` and
  `updates.*` (the update service reads `settings.updates` from the same policy state).

### Policy `app` block

| Key | Type | Effect |
|---|---|---|
| `app.allowQuit` | boolean, default `true` | `false`: no Quit in the tray, close hides, Ctrl+Q/`app.quit()`/signals ignored; the daemon relaunches the app for the listed users. |
| `app.users` | non-empty `string[]` of unix user names | Who the daemon relaunches (must also own the active graphical session). Absent/empty → nobody. Shown in Settings → System ("Quitting is disabled by policy … for: alice, bob"). |

### Policy `app` restrictions

`AppRestrictions` in `@rp/shared/system.ts` (`DEFAULT_APP_RESTRICTIONS`: every `allow*` `true`,
every `require*` `false`, so a policy that omits them changes nothing). `parsePolicy` accepts each
as a boolean and rejects anything else; `appRestrictions(policy)` applies the defaults and lands on
`PolicyState.restrictions`, reported as `SystemIntegrationStatus.policy.restrictions` and read by
the renderer through `app.restrictions()`. Not settings keys: never in `managed`.

Enforcement is `src/main/system/restrictions.ts` (pure + tested): `RESTRICTED_CHANNELS` maps an
IPC channel — or a whole namespace as `"<ns>:*"` — to the restriction that forbids it, and
`registerIpc`'s dispatch loop calls `refusalFor(channel, restrictions, managedBy)` before the
handler, throwing `PERMISSION_DENIED` with the reason. A channel may match both a namespace rule
and its own and is refused when either forbids it. `isRestrictable` resolves the guarded set once
at registration so unguarded channels never read the policy. The renderer hides the matching
controls (nav entries, Uninstall, Clear history, Forget, Remove, Delete session) — cosmetic only.

A policy that changes under a running app takes effect at once, without a restart. Enforcement
always did (the dispatch loop re-reads the policy per call); the UI now follows: `registerIpc`
subscribes to `PolicyWatcher.onChange` and pushes a `PolicySnapshot`
(`{ restrictions, managed, managedBy? }`) to the main window on `app:policyChanged`, delivered as
`app.onPolicyChange(fn)`. The renderer's `applyPolicySnapshot` adopts the restrictions and managed
paths, re-reads `settings.get()` (main resolves the forced values into it), leaves a view the
policy just withdrew (`ROUTE_NEEDS`: editor, sandbox → back to the chat), runs
`enterRequiredSession()` and toasts once when the restrictions actually changed. Settings → System
re-reads `system.status()` on the same event.

`allowStopGeneration` needs one thing a channel table cannot express: whether a turn is in flight.
`TURN_STOPPING_CHANNELS` names the channels that abort the running turn on their way to what they
actually do, and the dispatch loop checks `engine.chat.isRunning(sessionId)` (every one of them
takes the session id first) before asking `refusalForStoppingTurn` — so the policy is read only
when a reply is genuinely being cut short, and retry/reset/delete keep working otherwise.

| Key | Default | Effect | Channels refused |
|---|---|---|---|
| `allowPackEditor` | `true` | Pack editor closed; nav entry hidden, `navigate('editor')` is a no-op. | `editor:*` |
| `allowPackRemove` | `true` | No *Uninstall* on a pack card. | `packs:uninstall` |
| `allowPackInstall` | `true` | Installed packs frozen on disk — nothing added, replaced or rewritten. The editor still opens and still exports. | `packs:install`, `editor:installToApp` |
| `allowStopGeneration` | `true` | *Stop* in the composer is disabled: a reply runs to the end. | `chat:abort`, plus `chat:retry`, `sessions:resetState`, `sessions:removeMessage`, `sessions:clearMessages` **only while a turn is running** (each aborts it first) |
| `allowDeleteSession` | `true` | No *Delete session* in the session panel. | `sessions:remove` |
| `allowDeleteHistory` | `true` | No *Clear history*, no per-message delete. | `sessions:clearMessages`, `sessions:removeMessage` |
| `allowDeleteMemories` | `true` | No *Forget* in the memories panel; add/edit still work. | `memories:remove` |
| `allowRemoveEvents` | `true` | No *Remove* in the events drawer. | `events:remove` |
| `allowCloseMedia` | `true` | No *Close media* in the chat header. Characters' own `sdk.media.close`/`closeAll` still work — they never cross this channel. | `media:closeAll` |
| `allowSandbox` | `true` | Sandbox tab closed; nav entry hidden. Characters' own scripts unaffected. | `sandbox:run`, `sandbox:cancel` |
| `requireCharacterSession` | `false` | `enterRequiredSession()` opens the newest session at boot, or creates one with the first installed character, and pins the route to `chat`. The **last** session cannot be deleted — checked in the `sessions.remove` handler (conditional, so not in the table) and mirrored in `ChatView`. | — |

`AppPolicy` (`{ allowQuit, users }`) stays the daemon's half; the restrictions travel separately so
`QuitGuard` is unaffected. The daemon's `AppPolicy` struct declares the same keys only because it
sets `deny_unknown_fields` — it does not act on them.

### Policy `guard` block

`GuardPolicy` in `@rp/shared/system.ts`; validated identically by `parseGuard` (app) and `validate_guard` (daemon). `mode` `off` (default) \| `audit` \| `enforce`; `protectApp`, `wallpaper` booleans (default true); `compositorIpc` `allow` \| `shell-only` (default) \| `deny`; `shell` `auto` (default) \| `noctalia` \| `quickshell` \| `hyprpaper` \| `swww` \| `none`; `loginHelpers` (non-empty, absolute), `extraDenyPaths`/`extraDenySockets` (absolute, `~/…` or `@{HOME}/…`), `allowBinaries` (absolute) — no whitespace or quotes anywhere (they become AppArmor rules). A `mode` other than `off` without `app.users` is invalid; the listed users are the ones confined. Not a settings key; reported as `SystemIntegrationStatus.guard`.

### Policy `dev` block

`DevPolicy` in `@rp/shared/system.ts`, accepted by `parsePolicy` (both keys boolean, unknown keys
ignored, `dev` itself must be an object) and by the daemon's `DevPolicy` (`deny_unknown_fields`;
the daemon does not act on it, it keeps it and hands it back like the `app` restrictions).
`allow` (default `true`) is the development switches; `devTools` (default: follows `allow`) is the
inspector. Not a settings key: reported as `SystemIntegrationStatus.policy.dev`, never in
`managed`. What enforces it, and why it is read the way it is, is the `dev.allow` bullet under
*App (desktop main)*.

### Remote Link, the chain and the authoring side (app)

- `src/main/system/chain-author.ts`: the **publishing** half, on every platform — writing a policy
  for a fleet is not something you should have to do on a managed machine. `ChainAuthor` holds the
  Ed25519 private key in `<userData>/policy-chain/key.bin` (OS keyring via `safeStorage`, else a
  `0600` file with a header naming which) and the chain being built in `chain.json`, so a new
  version is one button rather than bookkeeping. `createKey`/`importKey`/`exportKey`/`forget`,
  `configure` (url, keyId, interval, managedBy, mode), `remoteLink()` → the base64 blob
  self-signed with the key, `appendLink({ policy?, unseal?, rotateTo? })` → the next link,
  hash-linked and signed, `dropLastLink()`, `publishedChain()`, `signPack({ id, version?, sha256 })`.
  `linkMessage`/`linkHash`/`packMessage` are pure and pinned against the daemon by a shared test
  vector (`a_link_signed_by_the_app_verifies_here` in `chain.rs`).
- `scripts/rp-policy-chain.mjs` (`keygen`, `link`, `sign`, `pack`) does the same from a terminal
  for an administrator who keeps the key on a build server, and doubles as the written
  specification; it is held to the same vector.
- IPC: `system.setRemoteLink(blob, code?)` and `system.author*` (`authorStatus`, `authorCreateKey`,
  `authorImportKey`, `authorExportKey`, `authorForget`, `authorConfigure`, `authorRemoteLink`,
  `authorAppendLink`, `authorDropLastLink`, `authorChain`, `authorSignPack`).
- `renderer/lib/qr.ts` + `components/common/QrCode.tsx`: the enrolment QR. `qrMatrix` wraps
  `qrcode-generator` into a boolean matrix and `qrPath` merges each row's dark runs into one SVG
  path (a version-7 code is ~2000 modules; one node per module makes a dialog feel slow). Drawn as
  React elements, never `dangerouslySetInnerHTML`, and always black on white whatever the theme —
  a theme-tinted code photographed off a screen is the kind of thing that scans on one phone only.
  Tested by rasterising the matrix and decoding it with `jsqr`, so the assertion is that a scanner
  reads the right URI back rather than that a matrix exists.
- Renderer: `components/settings/RemoteLinkSection.tsx` — the *Remote Link* card (paste box,
  gated by the code on a `totp` machine and refused on a `chain` one, with the enrolment dialog
  when a `totp` blob seals the machine) and the *Publish a chain* dialog (key, Remote Link,
  sign-a-version, sign-a-release, the chain file). `lib/seal.ts` gains `keyLine` and `sealLine`
  reads differently per mode.

### Policy `remote`, `packs` and `lock` blocks

`RemotePolicy`, `PacksPolicy`/`PackSource` and `PolicyLock` in `@rp/shared/system.ts`, validated
identically by `parseRemote`/`parsePacks`/`parseLock` (app, `src/main/system/policy.ts`) and
`validate_remote`/`validate_packs`/`validate_lock` (daemon) — the form would otherwise let someone
build a file the daemon refuses.

| Key | Type | Effect |
|---|---|---|
| `remote.url` | https:// (or http:// on 127.0.0.1) | Where the policy chain is fetched from. The key that signs it is pinned by the Remote Link, never named here: a policy must not name the key that authorises it. |
| `remote.enabled` | boolean, default `true` | `false` stops the fetching without forgetting the address. |
| `remote.intervalMinutes` | 5..1440, default 60 | How often the app fetches. |
| `packs.sources[]` | `{ id, url, signature?, sha256?, version? }`, ≤ 64 | Packs the machine gets, installed without the user choosing a file. `signature` is required where the machine has a Remote Link. |
| `packs.removeUnlisted` | boolean, default `false` | Uninstall everything not listed. |
| `packs.refreshMinutes` | 5..1440, default 360 | How often the pinned packs are re-checked. |
| `lock.algorithm`/`digits`/`period`/`window` | SHA1\|SHA256\|SHA512, 6..8, 15..300, 0..10 | TOTP parameters to enrol with (`totp` mode only). |
| `lock.selfHeal` | boolean, default `true` | Rewrite the policy file from the seal when it changes. |
| `lock.immutable` | boolean, default `true` | `FS_IMMUTABLE_FL` on the policy, the seal and its mirrors. |
| `lock.refuseManualStop` | boolean, default `true` | The `RefuseManualStop=yes` drop-in for the unit. |
| `lock.denyEscapes` | boolean, default `true` | With the guard enforcing, deny `run0`, `machinectl`, `pkexec`, `chattr`, `apparmor_parser`, `aa-teardown`, and confine `systemd-run` in `rpchat-systemd-run` (no system bus, so `--user` and `--scope` work and the system manager is out of reach). `sudo` stays: its children stay confined. A path in `guard.allowBinaries` overrides all of this for that path. |

A `lock` block also makes `PolicyFile::guard_rules()` set `protectPolicy` (every path the seal
lives in is denied to the guarded sessions, read as well as write) and `denyEscapes`. None of the
three are settings keys, so none appear in `managed`; `remote` and `packs` are reported through
`SystemIntegrationStatus.remote`, `lock` through `.policy.seal`.

### Policy `settings` keys

Dotted paths as shown by `settings.managed()`; both the app (`parsePolicy`) and the daemon (`SETTINGS_KEYS` + `validate()` in `policy.rs`) must know every key, so extend both together.

| Key | Managed paths | Notes |
|---|---|---|
| `autonomy` | `autonomy.maxSelfWakesPerHour`, `autonomy.maxConsecutiveSelfWakes`, `autonomy.maxTimersPerSession`, `autonomy.minRepeatIntervalMs`, `autonomy.minDelayMs` | non-negative numbers, or `-1` (`UNLIMITED`): no cap on a `max*`, no floor on a `min*` (`parsePolicy` writes `0` for those) |
| `maxInputLockMs` | `maxInputLockMs` | ≥ 1000, or `-1` for no app-side cap; also capped by `inputLock.maxDurationMs` (itself `-1` = unlimited, which the daemon holds to `UNLIMITED_LOCK_MS`, a hundred years) |
| `permissions` | `permissions.functionAllow.<module>`, `permissions.functionAllow.<module>.<function>` | booleans per module or per function; a function entry wins over its module's, an unlisted key stays the user's choice. `moduleAllow` is the pre-function name of the same map and is still read (module keys only), folded into `functionAllow` by `parsePolicy`. Pinning a module takes its functions with it: `applyPolicy` drops the user's `<module>.<function>` entries under a pinned module, which a function entry would otherwise outrank. |
| `web` | `web.allowlist` | string[] |
| `desktop` | `desktop.launchAllowlist` | string[] |
| `memory` | `memory.enabled`, `memory.semanticRanking`, `memory.consolidateEveryTurns`, `memory.maxEntriesPerCharacter`, `memory.promptBudgetTokens` | the last two take `-1` for no limit; `consolidateEveryTurns` is a cadence and does not |
| `senses` | `senses.includeInPrompt`, `senses.watchDirs`, `senses.calendarSources` | |
| `displayBackend` | `displayBackend` | `auto` \| `electron` \| `hyprland` |
| `updates` | `updates.automatic`, `updates.enabled` (`allowDowngrade` accepted, never managed) | booleans. `enabled: false` switches update checks off entirely (`UpdateStatus.state === 'disabled'`, token field hidden, `automatic` forced off); `automatic` pins the background-check toggle; `allowDowngrade: true` lets the daemon's `apply-update` install an older version (daemon-enforced, default false). |
| `browser` | `browser.allowBlocking`, `browser.allowEval`, `browser.allowHistory`, `browser.autoLaunch` | booleans. What characters may do through the browser extension (docs/browser-extension.md), `autoLaunch` whether the app may start a closed browser to reach it. The home page is not managed: only a character sets it, with `sdk.browser.setHomePage`. |
| `media` | `media.maxConcurrent.image`, `media.maxConcurrent.video`, `media.maxConcurrent.audio`, `media.maxQueued.image`, `media.maxQueued.video`, `media.maxQueued.audio` | non-negative numbers or `-1`, each pinned on its own. How many `sdk.media` items of a kind may run at once (`0` or `-1` = no cap) and how many more may wait behind them (`0` = an over-cap call is refused rather than queued, `-1` = no limit on the queue). Enforced by `MediaManager` (docs/spec/desktop.md "Media limits and the queue"); each kind is counted separately. |

## Renderer

- Settings → **System** tab: daemon status card (connected/version/devices/locked), "App install"
  card (`systemInstallLine()`: "System install: /opt/rpchat/current (v1.2.3), previous v1.2.2" /
  daemon offline / AppImage that the installer can unpack / not a system install; a warning when
  the daemon is too old to apply updates), the install dialog's "Install the app to /opt/rpchat"
  checkbox (shown for an AppImage launch, default on → `system.install({ systemInstall })`), policy card
  (managed-by text, list of forced settings, a warning line "Quitting is disabled by policy
  (managed by …) for: alice, bob" when `policy.allowQuit` is false — `quitDisabledLine()`; without a file and with `policy.canCreate`: **Create
  policy…** → `CreatePolicyDialog` (`components/settings/PolicyEditor.tsx`): the write-once
  explanation, a "Managed by" field and five tabs over a `PolicyDraft` (`renderer/lib/policy.ts`)
  seeded from `system.policyTemplate()` — **The app** (`allowQuit`, the `users` list, a switch per
  `AppRestrictions` key), **Forced settings** (a switch per forcible settings key beside its value,
  grouped by `POLICY_GROUPS`, with *Force all* / *Force none* and a count on the tab; an off key is
  omitted from the file, which is what leaves it to the user; `permissions.functionAllow` is a
  three-way per capability module, with the module's functions behind an expander for a
  three-way each), **Session guard** (mode, protection switches, `compositorIpc`,
  the exclusive-`auto`/`none` shell picker, the path lists under *Extra rules*), **Input lock**
  (the daemon's `inputLock` limits) and **Review** (the exact JSON with Copy, plus *Load a policy
  from JSON* → `policyDraftFrom`). A footer shows `policyEffects()` as badges and
  `policyDraftProblems()` — the rules `parsePolicy` would refuse, checked before the write since
  the file cannot be rewritten — in a warning callout; **Write policy** is gated on both an "I
  understand this cannot be undone without root" checkbox and an empty problem list, and sends
  `policyDraftToFile()` as pretty JSON. A daemon refusal is split by `policyRefusals()` into a
  danger callout; on success toast "Policy written", reload status and settings so managed badges
  appear; without the daemon a hint to install the system integration), **Session guard** card (`guardLine()`: "Session guard:
  audit (AppArmor) — 5 profiles loaded — users: work — shell noctalia, compositor hyprland — applied …",
  "unavailable: AppArmor is not active…", or "Off…"; badge off/audit/enforce/pending/unavailable/error;
  `lastError` callout; a warning when `pamConfigured` is false; a collapsible "What it cannot do"
  list from `residual`; **Audit log…** opens `GuardAuditDialog` with the last 50
  `system.guardAttempts()` rows (`guardAttemptLine()`); **Apply now** → `system.guardApply()`),
  a **Development** row in the policy card (`devLine(policy.dev)`: "switches available" (muted),
  "DevTools disabled", "switches locked off, DevTools left open" or "switches and DevTools locked
  off"), the Create-policy form's **Development** section on the App tab (`POLICY_DEV`, the two
  switches; turning `allow` off turns `devTools` off with it, and keeping DevTools on a locked
  machine shows a warning callout), udev/group status with the "re-login required" hint,
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
emergency unlock chord, locking down development mode (`dev.allow`, what it removes and what it is
not), the session guard (what it blocks, the verified AppArmor facts with sources,
the login-helper/hat mechanism, audit → enforce procedure, limits, recovery), uninstall, security
notes (group membership means "may lock input and inject keys", so treat `rpchat` group like `input`).

## Host events and pushed daemon events

`DaemonEventName` is `guard-attempt`, `policy-tamper` and `policy-changed`. The keepalive link
subscribes to all three: `policy-tamper` goes into `SystemIntegration.noteTamper` (Settings →
System → *Tamper log*), `policy-changed` invalidates the policy watcher and re-reads settings, so a
remote configuration or a restore from the seal reaches the managed badges at once.

## Host event `guard-attempt`

`HostEventName` gains `guard-attempt` (`packages/shared/src/senses.ts`; `HOST_EVENT_NAMES` in
`packages/core/src/services/events.ts`, mirrored in the SDK preamble); data is the `GuardAttempt`
(`kind`, `target`, `command`, `pid`, `blocked`, `profile`, `operation`, `requested?`). Filters:
`kind`/`blocked`/`pid` exact (the generic JSON comparison), `target`/`command` case-insensitive
substring. Subject to the usual 2 s debounce of identical events; the daemon already limits one per
target every 10 s. Documented for characters in `packages/sdk/src/modules/events.ts`.
