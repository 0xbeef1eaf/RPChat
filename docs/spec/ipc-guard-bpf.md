# IPC guard (BPF LSM): mediating `connect()` where AppArmor cannot

Status: **implemented.** The code is `native/rpchatd/src/ipcguard.rs` and
`native/rpchatd/src/bpf/ipc_guard.bpf.c`; the user-facing description is
`docs/system-integration.md` → *IPC guard (BPF LSM)*. This document is kept as the design record —
the measurements that motivated it, the alternatives that were rejected and why, and the
decisions the "Consequences" section called for. Where it and the code disagree, the code is
right; the notes below say where the implementation deliberately went another way. Read
`docs/system-integration.md` → *Session guard* and `native/rpchatd/src/guard.rs` first — this is
an addition to that guard, not a replacement.

## What was decided

The spec left three things open. They were settled like this:

1. **Shell→shell is allowed, not denied.** Consequence 1 below asks whether noctalia driving
   swww should break. It should not: that is how a real desktop sets a wallpaper, and a guard
   that takes the wallpaper away from the shell gets switched off. So each socket *server's*
   cgroup goes into the allow-list alongside the app's, and the residual list says that a session
   which moves itself into the shell's cgroup gets through the same way. The AppArmor profiles'
   `unix (connect) peer=(label=rpchat-shell)` rule still reads as shell→shell denial, and on the
   kernel where it would bite the BPF layer is not what is mediating.
2. **`unix_may_send` is not hooked.** Both guarded daemons are stream, as the spec expected.
3. **`vmlinux.h` is hand-written, not generated.** Vendoring `bpftool btf dump`'s output means
   160,000 lines and five megabytes in the repository. The program reads five structs and one
   field in each, so those are written out by hand in `src/bpf/vmlinux.h` — CO-RE relocates them
   against the running kernel either way, which is the property that mattered.

Two smaller departures: the pins live under `/sys/fs/bpf/rpchat/<build>/` rather than a flat
directory, so an upgraded daemon replaces the previous build's program instead of reusing maps
whose layout it may no longer agree with; and rather than reusing an existing pin, `engage`
attaches the new program *before* unpinning the old, which has no gap and no double-attach
(each program passes the other's verdict through as the hook's incoming `ret`).

## The problem

The session guard's wallpaper lock is supposed to stop a user's own terminal from reaching the
desktop shell's IPC socket, so the user cannot undo a wallpaper the character set. The AppArmor
rules that were meant to do this **do not work on a kernel without AppArmor's fine-grained `unix`
mediation class**, and that class is absent from mainstream kernels today.

Measured on 7.2.6-cachyos, from a shell in `rpchat-session (enforce)`, with `noctalia` and
`awww-daemon` both running as `rpchat-shell (enforce)` and owning the listening sockets:

| rule in force in the loaded profile | `open()` the socket node | `connect()` to it |
| --- | --- | --- |
| `audit deny @{run}/user/[0-9]*/*-awww-daemon*.sock rw,` | `EACCES` | **allowed** |
| `audit deny /run/rpchat/** rwklx,` (strongest rule in the profile) | `EACCES` | **allowed** |
| `audit deny unix (connect) peer=(label=rpchat-shell),` | — | **allowed** |

Why: the kernel's feature set (`/sys/kernel/security/apparmor/features/`) contains no `unix`
entry. It advertises `network_v9/af_unix`, which is the *coarse* AF_UNIX mediation — "may use
unix sockets at all", with no address and no peer conditionals. AppArmor's `unix` rules therefore
compile against `abi/4.0`, load without error, and mediate nothing. The older file-based AF_UNIX
mediation, which `guard.rs` originally relied on, is not present either. `addr=` cannot name a
filesystem socket in any case — the parser rejects it:
`unix rule: invalid value for addr='/run/user/1000/extra.sock'`.

So on such a kernel there is **no AppArmor rule that denies `connect()` to a filesystem unix
socket**. The current mitigation (PR #64) denies the *client binaries* (`swww`, `awww`) instead,
which stops the ordinary `awww img <path>` and nothing more; it cannot touch `noctalia msg`,
because that is the same binary as the shell itself.

## The proposal

Load a **BPF LSM** program that mediates `connect()` on the guarded sockets, and let the existing
AppArmor guard keep doing everything else. BPF LSM has the hook AppArmor lacks.

### Capability check (do this first)

All four must hold. The daemon must detect them at runtime and degrade honestly if any is missing.

```
/sys/kernel/security/lsm          contains "bpf"      # e.g. capability,landlock,lockdown,yama,apparmor,bpf
CONFIG_BPF_LSM=y
/sys/kernel/btf/vmlinux           exists              # CO-RE
bpf_lsm_unix_stream_connect       present in BTF      # the attach point
```

Verified present on the reference box (Arch/cachyos). **Not** present on stock Debian or Ubuntu,
whose `CONFIG_LSM` typically omits `bpf` — so this is a second optional capability, not a
replacement for the AppArmor path. Expect to ship both.

### Hooks

- `lsm/unix_stream_connect` — `int(struct sock *sock, struct sock *other, struct sock *newsk)`.
  `other` is the **server** socket being connected to. This is the primary hook.
- `lsm/unix_may_send` — `int(struct socket *sock, struct socket *other)`, for `SOCK_DGRAM`
  senders. Needed only if a guarded daemon uses datagram sockets; check each one before deciding.
  `awww-daemon` and `noctalia` are both stream, so this can be deferred.

Returning a negative errno from the program denies the operation. Return `-EACCES` so the failure
is indistinguishable from the AppArmor path and existing error handling in clients still applies.

### What is guarded: identifying the target socket

Key the decision on the **socket file's inode**, not its path. In the hook, the bound filesystem
path of `other` is reachable as `unix_sk(other)->path` (a `struct path`), so
`path.dentry->d_inode->i_ino` and the superblock's `s_dev` give a `(dev, ino)` pair with no string
matching in BPF.

- Map: `BPF_MAP_TYPE_HASH`, key `struct { u64 dev; u64 ino; }`, value `u8` (row id, for the event).
- The daemon populates it by `stat()`ing the sockets it already knows about. `guard.rs` has the
  table (`TableEntry::sockets`, the `@{run}/user/[0-9]*/…` globs) and a discovery pass
  (`discover_sockets`) that walks `/proc/net/unix` for the listed users' shell processes. Reuse
  both; expand the globs against the real runtime dirs and stat the results.
- **Inodes churn.** Every time the shell restarts it unlinks and rebinds, producing a new inode,
  and the map goes stale — a real gap, not a theoretical one, because that is exactly when a user
  would retry. Watch the runtime directories with inotify (`IN_CREATE | IN_MOVED_TO`) and refresh
  on each event, in addition to the periodic discovery the daemon already runs.
- Do **not** guard anything in `guard.rs`'s `NEVER_GUARD` set. The Wayland display socket, X11,
  the session bus and the audio sockets must never enter this map; the session cannot run without
  them and denying one bricks the desktop. Add a test that asserts this, mirroring
  `discovery_never_puts_a_display_socket_into_the_profiles`.

Rejected alternative: matching `sun_path` bytes in the program with a bounded loop. It works, but
it re-implements globbing in BPF for no gain over an inode the daemon can stat.

### Who is allowed: identifying the caller

Everything the app does must still work, including children it spawns — the character sets the
wallpaper by running `noctalia msg wallpaper-set …`, which is a *different binary* from the app.
So the allow-list must cover the app's descendants, not just the app.

Use the **cgroup**, which descendants inherit:

- Map: `BPF_MAP_TYPE_CGROUP_ARRAY` with one entry, holding an fd to the app's cgroup directory.
- Program: `bpf_current_task_under_cgroup(&app_cgroup, 0)` → allow.
- The daemon learns the app's pid from the existing keepalive registration
  (`native/rpchatd/src/keepalive.rs`, `Registration::pid`). Read `/proc/<pid>/cgroup`, open
  `/sys/fs/cgroup/<path>`, put the fd in the map. Refresh on every registration — the cgroup
  changes each time the app restarts.

Rejected alternatives, with reasons, so they are not re-litigated:

- **Exe inode** (`task->mm->exe_file`): does not cover `noctalia msg` spawned by the app.
- **AppArmor label** (`task->cred->security`): the app already runs as `rpchat-app`, which would
  be the ideal key, but decoding an AppArmor label from BPF means walking internal structs with no
  stable BTF contract. Fragile; revisit only if cgroups prove unworkable.
- **uid**: the user and the app are the same uid. Useless here.

### Modes

The guard has three modes (`off` / `audit` / `enforce`) and this must match them, or `audit` stops
meaning "see what enforce would do" — which is the one thing it exists for.

- Map: `BPF_MAP_TYPE_ARRAY`, one `u32`, the current mode.
- `audit`: emit an event, return `0`.
- `enforce`: emit an event, return `-EACCES`.
- `off`: unload; do not leave the program attached returning 0.

### Reporting

Emit to a `BPF_MAP_TYPE_RINGBUF`: target `(dev, ino)`, the resolved path (the daemon can map the
inode back to the path it stat'd), `comm`, pid, and whether it was blocked. The daemon's reader
turns each into the **existing** `GuardAttempt` (`guard.rs`) and feeds `report_attempt`, so these
reach characters as the same `guard-attempt` host event as AppArmor denials, already rate-limited
per target (`ATTEMPT_RATE_LIMIT`). Set `profile` to something that says where it came from —
`"bpf-ipc"` rather than an `rpchat-*` profile name — and check `parse_audit_message`'s callers do
not assume the prefix.

`GuardInfo` (`packages/shared/src/system.ts`) needs a field saying which mechanism is live, so
Settings → System can stop guessing:

```ts
/** How connect() to the guarded sockets is mediated: the AppArmor unix class, the BPF LSM
 *  program, or nothing (reported in `residual`). */
ipcMediation?: 'apparmor' | 'bpf' | 'none';
```

When it is `none`, keep the residual line PR #64 added. When it is `bpf`, drop that line and add
one naming the new residuals below.

### Policy surface

One new optional field on `GuardPolicy` (`packages/shared/src/system.ts` and `policy.rs`, parsed
in `parseGuard`):

```ts
/** Mediate connect() to the shell's sockets with a BPF LSM program when the kernel allows it.
 *  `auto` (default) uses it when available, `off` never does. */
ipcGuard?: 'auto' | 'off';
```

Keep it to two values. A `require` variant that refuses to engage the guard at all on an
unsupported kernel sounds appealing and would brick the desktop of anyone who takes a kernel
update; if that behaviour is ever wanted, it belongs in the app's warnings, not here.

### Lifecycle

- Load and attach during `guard::apply` when `mode != off`, `ipcGuard != off` and the capability
  check passes. Unload in `guard-off` and on `mode: off`.
- **Pin** the link under `/sys/fs/bpf/rpchat/`. Holding the fd in the daemon is simpler but means
  `kill -9 rpchatd` drops the mediation; the unit has `RefuseManualStop=yes` and
  `Restart=always`, but there is a window. Pinning survives it. Unpin explicitly on `guard-off`,
  and reuse an existing pin on daemon restart rather than attaching twice.
- **Fail open on function, closed on reporting.** If the program does not load, the desktop must
  still work and `guard-apply` must still succeed — but `ipcMediation` must say `none` and the
  residual must say so. A guard that silently claims a protection it does not have is the failure
  mode this whole spec exists to correct.
- Add `/usr/bin/bpftool` and `/usr/sbin/bpftool` to `ESCAPE_BINARIES` in `guard.rs`, for the same
  reason `apparmor_parser` is there: it undoes this layer.

## Build and dependencies

The loader goes in the daemon (`native/rpchatd`). The constraint worth deciding up front:

- **Recommended:** write the BPF program in C, compile with `clang -target bpf` at build time,
  embed the object with `include_bytes!`, and load it with **`aya`** (pure-Rust loader, no libbpf
  at runtime). This keeps `rpchatd` on stable Rust.
- `aya-ebpf` (BPF programs written in Rust) requires **nightly** for the BPF target. Do not adopt
  it unless the project is willing to pin a nightly toolchain.
- `libbpf-rs` needs libbpf and clang as build dependencies of the daemon. Heavier than aya for
  what this needs.

Vendor `vmlinux.h` (generated by `bpftool btf dump file /sys/kernel/btf/vmlinux format c`) rather
than generating it at build time, so the build does not depend on the building machine's kernel.
CI does **not** install `clang` today — add it to the `Install system packages` step in
`.github/workflows/ci.yml` (line ~59), the same one that installs `apparmor`.

## Testing

- **Unit (no privileges):** glob expansion → socket paths, the `(dev, ino)` map contents, the
  `NEVER_GUARD` exclusion, mode mapping, the ringbuf record → `GuardAttempt` conversion.
- **Integration (root + BPF):** load the program, bind a socket in a temp dir, add its inode to
  the map, connect from inside and outside the allowed cgroup, assert `EACCES` and `0`
  respectively, and assert `audit` mode never blocks. **Skip when the capability check fails or
  the process lacks `CAP_BPF`** — follow the pattern in
  `generated_profiles_pass_apparmor_parser_when_available`, which skips on both "not installed"
  and `PermissionDenied`, so a developer box running this very guard gets a skip rather than a
  red test that looks like a real failure.
- **On a live box:** the check that matters, and the one that caught two wrong fixes already:

  ```sh
  awww query                    # expect: cannot reach the daemon
  noctalia msg wallpaper-get    # expect: the same
  ```

  Run it from a terminal in a guarded session, in `enforce`, and confirm first that the mechanism
  is actually live (`guard-status` → `ipcMediation: "bpf"`). A measurement taken before the new
  daemon is installed and `--guard-apply` has run says nothing.

## Consequences to decide before building

1. **This enforces shell→shell denial for the first time.** The AppArmor design always intended
   that a bar cannot drive a wallpaper daemon ("two shells share one `rpchat-shell` profile"), but
   it has never actually bitten, because `connect()` was never mediated. If `noctalia` uses
   `awww` as its wallpaper backend, **noctalia's own wallpaper setting will stop working** once
   this lands. Decide whether that is wanted; if not, the two daemons need to be distinguishable
   in the allow-list rather than sharing one identity.
2. **Portability shrinks.** AppArmor is on by default on Ubuntu and Debian; `lsm=…,bpf` usually is
   not. This makes the strongest form of the guard available on fewer machines than the weakest.
3. **It sits outside the policy model.** Everything else the guard does is a generated AppArmor
   profile that a reviewer can read at `/etc/apparmor.d/rpchat-*`. This is a binary blob and a
   handful of maps. Consider dumping the effective state (guarded inodes → paths, allowed cgroup,
   mode) through `guard-status` so it stays inspectable.

## Out of scope

Compositor IPC. The same hook would mediate it, but the allow-list question is different: the
compositor serves the Wayland display and X11 alongside its control socket, and the session must
keep reaching the first two. Guarding `.socket.sock` by inode while leaving `wayland-1` alone is
expressible here — unlike in AppArmor, where the peer label covers both — so this is worth a
follow-up once the shell case is proven. Do not bundle it into the first change.
