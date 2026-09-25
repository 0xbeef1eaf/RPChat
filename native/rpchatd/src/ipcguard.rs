//! The IPC guard: a BPF LSM program that mediates `connect()` to the shell's sockets, which is
//! the one check the AppArmor half of the session guard cannot make (`docs/spec/ipc-guard-bpf.md`).
//!
//! The AppArmor guard denies the shell's socket *nodes* as files and the shell as a `unix` peer.
//! On every current kernel the first covers `open()` and not `connect()`, and the second compiles
//! against a mediation class the kernel does not implement — so `awww query` and `noctalia msg
//! wallpaper-set` still reached the daemon, and the wallpaper lock was a wall with a door in it.
//! `lsm/unix_stream_connect` is that door. See `guard.rs`'s module comment for the measurements.
//!
//! Everything in the first half of this file is pure and unit-tested without any privilege:
//! which kernels can run the program, which socket paths it should mediate, and how a record it
//! emits becomes the same `guard-attempt` event an AppArmor denial produces. The second half
//! loads and attaches it with [`aya`], and is exercised by the root-only test at the bottom.
//!
//! Three rules shape the whole thing:
//!
//! - **Key on the inode, never the path.** The program gets a `struct sock *`, not a string;
//!   the daemon stats the paths it knows and puts `(device, inode)` in a map, so nothing in BPF
//!   does string matching. Inodes churn — a shell that restarts unlinks and rebinds — so the
//!   map is refreshed whenever a runtime directory changes, not only at `guard-apply`.
//! - **Allow by cgroup, never by binary.** The character sets the wallpaper by running
//!   `noctalia msg …`, a different binary from the app, so the allow-list has to cover the
//!   app's descendants. A cgroup is the one identity they all inherit.
//! - **Fail open.** A program that will not load, a kernel without BPF LSM, a build without
//!   `clang`: all of them leave the desktop working and say `ipcMediation: "none"`. The
//!   reporting is where this must not fail — claiming a protection that is not there is the
//!   failure this whole layer exists to correct.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::guard::{
    generalise_socket_path, never_guard, normalise_glob, AttemptKind, GuardAttempt, GuardContext,
    Owner,
};
use crate::policy::{GuardMode, GuardRules, IpcGuardMode};

/// The compiled BPF LSM program, built by `build.rs`. **Empty** when `clang` was not available
/// at build time, which [`support`] reports as plainly as a kernel that cannot run it.
pub const PROGRAM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ipc_guard.bpf.o"));

/// The program's entry point, and the LSM hook it attaches to (`bpf_lsm_unix_stream_connect`
/// in the kernel's BTF).
pub const PROGRAM_NAME: &str = "rpchat_unix_stream_connect";
pub const LSM_HOOK: &str = "unix_stream_connect";

/// The active LSMs, in order. `bpf` is here only when the kernel was booted with it.
pub const LSM_LIST: &str = "/sys/kernel/security/lsm";
/// The kernel's own BTF: without it there is no CO-RE, so the program cannot be relocated.
pub const BTF_VMLINUX: &str = "/sys/kernel/btf/vmlinux";
/// Where pins live. The program is pinned so `kill -9 rpchatd` does not drop the mediation.
pub const BPF_FS: &str = "/sys/fs/bpf";
pub const PIN_DIR: &str = "/sys/fs/bpf/rpchat";

/// Map names, as declared in `src/bpf/ipc_guard.bpf.c`.
const MAP_TARGETS: &str = "rpchat_targets";
const MAP_ALLOWED: &str = "rpchat_allowed";
const MAP_MODE: &str = "rpchat_mode";
const MAP_EVENTS: &str = "rpchat_events";

/// `max_entries` of `rpchat_targets`: how many socket nodes can be mediated at once.
pub const MAX_TARGETS: usize = 1024;
/// `max_entries` of `rpchat_allowed`. Slot 0 is the app; the rest are the socket servers.
pub const MAX_ALLOWED_CGROUPS: usize = 8;
/// Slot 0 of `rpchat_allowed`: the rpchat app's cgroup, so everything the character launches
/// keeps working.
pub const APP_CGROUP_SLOT: u32 = 0;

/// The mode values `rpchat_mode` carries; these are the program's `MODE_*` constants.
pub const MODE_OFF: u32 = 0;
pub const MODE_AUDIT: u32 = 1;
pub const MODE_ENFORCE: u32 = 2;

/// `profile` on a [`GuardAttempt`] this layer produces. Not an `rpchat-*` profile name,
/// because it did not come from one: the AppArmor path and this one reach characters as the
/// same event, and this is how a reader tells them apart.
pub const ATTEMPT_PROFILE: &str = "bpf-ipc";

/// How `connect()` to the guarded sockets is mediated right now (`GuardInfo.ipcMediation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IpcMediation {
    /// AppArmor's fine-grained `unix` class is present and the profiles' `unix (connect)` deny
    /// is doing the work.
    Apparmor,
    /// This program is loaded and attached.
    Bpf,
    /// Neither. `connect()` to the shell's sockets is not mediated at all; the residual list
    /// says so.
    #[default]
    None,
}

impl IpcMediation {
    pub fn as_str(self) -> &'static str {
        match self {
            IpcMediation::Apparmor => "apparmor",
            IpcMediation::Bpf => "bpf",
            IpcMediation::None => "none",
        }
    }
}

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/// Can this machine run the program at all? `Ok(())` or the one sentence that says why not.
///
/// The `bpf_lsm_unix_stream_connect` attach point is **not** checked here: it needs the kernel's
/// BTF parsed, which is what loading does anyway, so a kernel that passes everything below and
/// still has no such hook is reported by [`Loaded::engage`] with the loader's own message.
pub fn support(
    program: &[u8],
    read: &dyn Fn(&Path) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    if program.is_empty() {
        return Err(
            "this daemon was built without the BPF program (clang was missing at build time)"
                .to_string(),
        );
    }
    match read(Path::new(LSM_LIST)) {
        None => {
            return Err(format!(
                "{LSM_LIST} is missing: this kernel has no LSM list to read (securityfs unmounted, or CONFIG_SECURITY=n)"
            ))
        }
        Some(list) if !lsm_active(&list, "bpf") => {
            return Err(format!(
                "the bpf LSM is not enabled (lsm={}): boot with `lsm=…,bpf` and CONFIG_BPF_LSM=y",
                list.trim()
            ))
        }
        Some(_) => {}
    }
    if !exists(Path::new(BTF_VMLINUX)) {
        return Err(format!(
            "{BTF_VMLINUX} is missing: the kernel carries no BTF, so the program cannot be relocated (CONFIG_DEBUG_INFO_BTF=y)"
        ));
    }
    if !exists(Path::new(BPF_FS)) {
        return Err(format!(
            "{BPF_FS} is not mounted: the program cannot be pinned, so it would not survive a daemon restart"
        ));
    }
    Ok(())
}

/// Is `name` one of the comma-separated LSMs in `/sys/kernel/security/lsm`?
pub fn lsm_active(list: &str, name: &str) -> bool {
    list.trim().split(',').any(|l| l.trim() == name)
}

// ---------------------------------------------------------------------------
// What is guarded: socket paths → (device, inode)
// ---------------------------------------------------------------------------

/// A socket node the program mediates, as the map key. The kernel's `dev_t` packs the minor
/// number into 20 bits and glibc's packs it differently, so the two sides agree on major and
/// minor rather than on the encoded number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
#[repr(C)]
pub struct TargetKey {
    pub dev_major: u32,
    pub dev_minor: u32,
    pub ino: u64,
}

/// What a `stat()` of a candidate socket tells the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SocketStat {
    pub uid: u32,
    pub key: TargetKey,
    /// The node is a unix socket. Anything else a glob happened to match is dropped.
    pub is_socket: bool,
}

/// One mediated socket: the path it was resolved from (for the event) and its map key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Target {
    pub path: String,
    pub key: TargetKey,
}

/// The sockets the program should mediate, from two sources that cover each other's gaps:
///
/// - **Discovery** ([`GuardContext::served`]): every listening filesystem socket owned by a
///   process whose `comm` is in the shell table. Precise, but blind to a shell running under a
///   name the table does not know.
/// - **The table's globs**, expanded against the real runtime directories. Blind to a socket
///   whose name the table does not predict, which is exactly what discovery is good at.
///
/// Both are then filtered the same way: a node must be a socket, must be owned by one of the
/// guarded users, and must not be in `NEVER_GUARD`. The last is the one that matters — the
/// Wayland display, X11, the session bus and the audio sockets are in `/run/user/<uid>` beside
/// the shell's, and mediating one of them takes the desktop down.
pub fn resolve_targets(
    rules: &GuardRules,
    ctx: &GuardContext,
    list_dir: &dyn Fn(&Path) -> Vec<String>,
    stat: &dyn Fn(&Path) -> Option<SocketStat>,
) -> Vec<Target> {
    let mut paths: BTreeSet<String> = BTreeSet::new();
    if rules.wallpaper {
        let guarded: BTreeSet<&str> = ctx.shells.iter().map(|s| s.id).collect();
        for s in &ctx.served {
            if s.owner == Owner::Shell && guarded.contains(s.entry.as_str()) {
                paths.insert(s.path.clone());
            }
        }
        for glob in ctx.shells.iter().flat_map(|s| s.sockets.iter()) {
            paths.extend(expand_glob(glob, list_dir));
        }
    }
    // `guard.extraDenySockets` is the admin naming something the table does not know, so it is
    // mediated whatever `guard.wallpaper` says — the same as in the AppArmor profiles.
    for extra in &rules.extra_deny_sockets {
        paths.extend(expand_glob(&normalise_glob(extra), list_dir));
    }

    let uids: BTreeSet<u32> = ctx.user_uids.iter().map(|(_, uid)| *uid).collect();
    let mut out = BTreeSet::new();
    for path in paths {
        if never_guard(&generalise_socket_path(&path)) {
            continue;
        }
        let Some(st) = stat(Path::new(&path)) else {
            continue;
        };
        // Only the guarded users' sockets. This program mediates every process on the machine,
        // not just a confined session, so another user's shell must stay out of the map.
        if !st.is_socket || !uids.contains(&st.uid) {
            continue;
        }
        out.insert(Target { path, key: st.key });
    }
    out.into_iter().take(MAX_TARGETS).collect()
}

/// Expand one AppArmor-style socket glob into the concrete paths that exist right now.
///
/// `@{run}` and `@{HOME}` are the variables every generated profile defines, so the table's
/// globs can be used as written. Within a component `*`, `?` and `[…]` work as in a shell;
/// `**` does **not** — a glob containing one is skipped rather than silently treated as `*`,
/// because a wrong expansion here puts a socket the session needs into the map.
pub fn expand_glob(glob: &str, list_dir: &dyn Fn(&Path) -> Vec<String>) -> Vec<String> {
    if glob.split('/').any(|c| c == "**") || !glob.contains('/') {
        return Vec::new();
    }
    let (mut current, rest): (Vec<PathBuf>, &str) = if let Some(r) = glob.strip_prefix("@{run}/") {
        (vec![PathBuf::from("/run"), PathBuf::from("/var/run")], r)
    } else if let Some(r) = glob.strip_prefix("@{HOME}/") {
        (home_dirs(list_dir), r)
    } else if let Some(r) = glob.strip_prefix('/') {
        (vec![PathBuf::from("/")], r)
    } else {
        return Vec::new();
    };
    for comp in rest.split('/').filter(|c| !c.is_empty()) {
        let mut next = Vec::new();
        for dir in &current {
            if is_literal(comp) {
                next.push(dir.join(comp));
            } else {
                for name in list_dir(dir) {
                    if fnmatch(comp, &name) {
                        next.push(dir.join(&name));
                    }
                }
            }
        }
        if next.is_empty() {
            return Vec::new();
        }
        current = next;
    }
    let mut out: Vec<String> = current
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `@{HOME}` is `/home/*/ /root/` in every generated profile; here that is the directories that
/// exist.
fn home_dirs(list_dir: &dyn Fn(&Path) -> Vec<String>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = list_dir(Path::new("/home"))
        .into_iter()
        .map(|n| Path::new("/home").join(n))
        .collect();
    out.push(PathBuf::from("/root"));
    out
}

fn is_literal(comp: &str) -> bool {
    !comp.contains(['*', '?', '['])
}

/// Shell-style matching of one path component: `*`, `?` and `[abc]` / `[a-z]` / `[!abc]`.
/// Nothing here crosses a `/` — [`expand_glob`] matches one component at a time.
pub fn fnmatch(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
}

fn go(p: &[char], n: &[char]) -> bool {
    match p.first() {
        None => n.is_empty(),
        Some('*') => {
            for i in 0..=n.len() {
                if go(&p[1..], &n[i..]) {
                    return true;
                }
            }
            false
        }
        Some('?') => !n.is_empty() && go(&p[1..], &n[1..]),
        Some('[') => {
            let Some(close) = p.iter().position(|c| *c == ']').filter(|i| *i > 1) else {
                // An unterminated `[` is a literal one, as in fnmatch(3).
                return !n.is_empty() && n[0] == '[' && go(&p[1..], &n[1..]);
            };
            if n.is_empty() {
                return false;
            }
            let (negated, set) = match p[1] {
                '!' | '^' => (true, &p[2..close]),
                _ => (false, &p[1..close]),
            };
            let hit = class_hit(set, n[0]);
            hit != negated && go(&p[close + 1..], &n[1..])
        }
        Some(&ch) => !n.is_empty() && n[0] == ch && go(&p[1..], &n[1..]),
    }
}

fn class_hit(set: &[char], c: char) -> bool {
    let mut i = 0;
    while i < set.len() {
        if i + 2 < set.len() && set[i + 1] == '-' {
            if set[i] <= c && c <= set[i + 2] {
                return true;
            }
            i += 3;
        } else {
            if set[i] == c {
                return true;
            }
            i += 1;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Who is allowed: cgroups
// ---------------------------------------------------------------------------

/// The unified-hierarchy cgroup directory of a process, from its `/proc/<pid>/cgroup`.
///
/// Only cgroup v2 (`0::/…`) is handled: `bpf_current_task_under_cgroup` tests the v2 hierarchy,
/// so on a v1-only machine there is nothing to open and the guard reports that it cannot
/// engage rather than engaging with an empty allow-list — which would deny the app itself.
pub fn cgroup_dir(proc_cgroup: &str) -> Option<PathBuf> {
    let rel = proc_cgroup
        .lines()
        .find_map(|l| l.strip_prefix("0::"))?
        .trim();
    if !rel.starts_with('/') {
        return None;
    }
    Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
}

/// The cgroups allowed to reach a mediated socket, in slot order.
///
/// Slot 0 is the app's, so the character's `noctalia msg wallpaper-set …` — a different binary,
/// spawned as a child — keeps working. The rest are the cgroups of the processes *serving* the
/// mediated sockets, which keeps a bar able to drive a wallpaper daemon: on a desktop where
/// noctalia sets the wallpaper through swww, mediating that connection would break the shell's
/// own wallpaper setting, and a guard that breaks the desktop gets turned off.
///
/// A user's terminal is in neither, which is the whole point: it is a different scope under
/// `user@<uid>.service` from both the app and the shell.
pub fn allowed_cgroups(app: Option<PathBuf>, servers: &[PathBuf]) -> Vec<Option<PathBuf>> {
    let mut out: Vec<Option<PathBuf>> = vec![None; MAX_ALLOWED_CGROUPS];
    out[APP_CGROUP_SLOT as usize] = app;
    let mut seen: BTreeSet<PathBuf> = out.iter().flatten().cloned().collect();
    let mut slot = APP_CGROUP_SLOT as usize + 1;
    for s in servers {
        if slot >= MAX_ALLOWED_CGROUPS {
            break;
        }
        if !seen.insert(s.clone()) {
            continue;
        }
        out[slot] = Some(s.clone());
        slot += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Reporting: a ring buffer record → the same guard-attempt event AppArmor denials produce
// ---------------------------------------------------------------------------

/// One `rpchat_events` record. Mirrors `struct rpchat_event` in `ipc_guard.bpf.c`: `repr(C)`,
/// explicit widths, no padding on either side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(C)]
pub struct Event {
    pub dev_major: u32,
    pub dev_minor: u32,
    pub ino: u64,
    pub pid: u32,
    pub blocked: u32,
    pub comm: [u8; 16],
}

impl Event {
    /// Decode a record straight out of the ring buffer. `None` when the slice is the wrong
    /// size, which would mean the loaded program is not the one this daemon was built with.
    pub fn parse(bytes: &[u8]) -> Option<Event> {
        if bytes.len() != std::mem::size_of::<Event>() {
            return None;
        }
        let u32_at = |o: usize| u32::from_ne_bytes(bytes[o..o + 4].try_into().unwrap());
        let mut comm = [0u8; 16];
        comm.copy_from_slice(&bytes[24..40]);
        Some(Event {
            dev_major: u32_at(0),
            dev_minor: u32_at(4),
            ino: u64::from_ne_bytes(bytes[8..16].try_into().unwrap()),
            pid: u32_at(16),
            blocked: u32_at(20),
            comm,
        })
    }

    pub fn key(&self) -> TargetKey {
        TargetKey {
            dev_major: self.dev_major,
            dev_minor: self.dev_minor,
            ino: self.ino,
        }
    }

    /// The NUL-terminated `comm` as a string.
    pub fn command(&self) -> String {
        let end = self.comm.iter().position(|b| *b == 0).unwrap_or(16);
        String::from_utf8_lossy(&self.comm[..end]).into_owned()
    }
}

/// Turn a record into the `guard-attempt` an AppArmor denial on the same socket would have
/// produced, so characters see one kind of event however it was mediated.
///
/// `paths` maps each mediated inode back to the path the daemon stat'd — the program never
/// carries a string. An inode that is no longer in the table (the shell rebound between the
/// attempt and the read) is reported by its numbers rather than dropped.
pub fn attempt(event: &Event, paths: &BTreeMap<TargetKey, String>) -> GuardAttempt {
    let key = event.key();
    let target = paths.get(&key).cloned().unwrap_or_else(|| {
        format!(
            "unix socket {}:{} inode {}",
            key.dev_major, key.dev_minor, key.ino
        )
    });
    GuardAttempt {
        kind: AttemptKind::Ipc,
        target,
        command: event.command(),
        pid: event.pid,
        blocked: event.blocked != 0,
        profile: ATTEMPT_PROFILE.to_string(),
        operation: "connect".to_string(),
        requested: Some("connect".to_string()),
    }
}

// ---------------------------------------------------------------------------
// What `guard::apply` asks for, and what it gets back
// ---------------------------------------------------------------------------

/// What the guard wants mediated on this pass.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IpcRequest {
    /// `Off` unloads and unpins.
    pub mode: GuardMode,
    /// `guard.ipcGuard`: `auto` uses the program when the kernel allows it, `off` never does.
    pub setting: IpcGuardMode,
    pub targets: Vec<Target>,
    /// The cgroup of the app, if it has registered for keepalive yet.
    pub app_cgroup: Option<PathBuf>,
    /// The cgroups of the processes serving the mediated sockets.
    pub server_cgroups: Vec<PathBuf>,
}

/// What actually happened.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IpcOutcome {
    pub mediation: IpcMediation,
    /// Why it is not `bpf`, when it is not. Reported in the guard's residual list, never as
    /// `lastError`: this layer failing must not make `guard-apply` fail.
    pub reason: Option<String>,
    /// How many socket nodes are mediated.
    pub targets: usize,
}

impl IpcOutcome {
    pub fn unavailable(reason: impl Into<String>) -> IpcOutcome {
        IpcOutcome {
            mediation: IpcMediation::None,
            reason: Some(reason.into()),
            targets: 0,
        }
    }
}

/// What actually mediates `connect()`, given what this layer managed and whether the kernel has
/// AppArmor's fine-grained `unix` class.
///
/// The two are alternatives, and the AppArmor one needs no help: a kernel that implements the
/// `unix` class already enforces the profiles' `unix (connect) peer=(label=rpchat-shell)` deny,
/// so `auto` not loading the program there is the expected outcome, not a failure.
pub fn effective_mediation(outcome: &IpcOutcome, unix_class: bool) -> IpcMediation {
    match outcome.mediation {
        IpcMediation::Bpf => IpcMediation::Bpf,
        _ if unix_class => IpcMediation::Apparmor,
        _ => IpcMediation::None,
    }
}

/// The residual lines the IPC guard is responsible for: who mediates `connect()` to the shell's
/// sockets, and what that leaves open. Kept here rather than in `render` because it describes
/// this mechanism, not the profiles — and because the two mechanisms are alternatives, so one
/// function has to answer for both or the list contradicts itself.
pub fn residual(outcome: &IpcOutcome, unix_class: bool, shell_guarded: bool) -> Vec<String> {
    if !shell_guarded {
        return Vec::new();
    }
    match effective_mediation(outcome, unix_class) {
        // The profiles' `unix (connect) peer=(label=rpchat-shell)` deny is doing the work and
        // there is nothing extra to disclose; `guard.rs` already documents that rule.
        IpcMediation::Apparmor => Vec::new(),
        IpcMediation::Bpf => vec![
            format!(
                "connect() to the shell's sockets is mediated by a BPF LSM program ({} socket(s) right now), not by AppArmor — this kernel has no AppArmor unix mediation class. It is a loaded program and a handful of maps rather than a profile a reviewer can read at /etc/apparmor.d; guard-status prints what is in them",
                outcome.targets
            ),
            "the BPF layer mediates every process on the machine, not only the confined users' sessions, so root and system services are denied the guarded sockets too. Only the guarded users' own sockets go into the map, so another user's shell is untouched".to_string(),
            "the allow-list is a cgroup, so anything sharing the app's cgroup is allowed: an app started from a terminal shares that terminal's scope, and the wallpaper lock is then open to everything in it. A packaged install started from autostart or the desktop entry gets its own scope and does not have that gap".to_string(),
            "the processes serving the guarded sockets may reach each other, so a bar can still drive a wallpaper daemon (which is how noctalia sets a wallpaper through swww). A session that moves itself into the shell's cgroup — cgroup delegation makes that the user's own tree — reaches them the same way".to_string(),
            "a socket bound since the last refresh is unmediated until the next one: the runtime directories are watched with inotify and rescanned, but there is a window between bind() and the refresh".to_string(),
        ],
        IpcMediation::None => vec![format!(
            "this kernel has no AppArmor unix mediation class (only the coarse network_v9/af_unix), so connect() to a filesystem socket cannot be denied by a profile at all, and the BPF LSM program that would do it is not loaded{}: the wallpaper IPC is NOT guarded. What holds is the config files — a wallpaper set through the shell's socket does not persist — and the client binaries being denied. Measured, not assumed: with `deny /run/rpchat/** rwklx` loaded, open() on a socket there is EACCES and connect() to it succeeds",
            outcome
                .reason
                .as_deref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        )],
    }
}

/// `MODE_*` for a guard mode.
pub fn mode_value(mode: GuardMode) -> u32 {
    match mode {
        GuardMode::Off => MODE_OFF,
        GuardMode::Audit => MODE_AUDIT,
        GuardMode::Enforce => MODE_ENFORCE,
    }
}

/// A short, stable identifier for the compiled program. Pins live under
/// `/sys/fs/bpf/rpchat/<build>/`, so a daemon that was upgraded finds no pin for its own build,
/// tears the old one down and attaches the new one — rather than reusing maps whose layout it
/// no longer agrees with.
pub fn build_id(program: &[u8]) -> String {
    let digest = Sha256::digest(program);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `/sys/fs/bpf/rpchat/<build>`.
pub fn build_dir(program: &[u8]) -> PathBuf {
    Path::new(PIN_DIR).join(build_id(program))
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

use std::io;
use std::os::fd::AsFd;

use aya::maps::{Array, CgroupArray, Map, MapData, RingBuf};
use aya::programs::links::FdLink;
use aya::programs::Lsm;
use aya::{Btf, Ebpf, EbpfLoader, Pod};

// `TargetKey` is `repr(C)` with three explicit-width integers and no padding, which is the whole
// contract: the same bytes are the key on the BPF side.
unsafe impl Pod for TargetKey {}

/// The engaged program: the maps the daemon keeps writing to as sockets come and go, and the
/// paths behind the keys so a record can name what was reached.
///
/// The *link* is not held here — it is pinned, and the pin is what keeps the program attached.
/// Nothing in this struct has to stay alive for the mediation to hold; dropping it (a daemon
/// that exits, or is killed) leaves the program in place, which is the point of pinning.
pub struct Engaged {
    targets: aya::maps::HashMap<MapData, TargetKey, u8>,
    allowed: CgroupArray<MapData>,
    mode: Array<MapData, u32>,
    /// Taken by the reporting thread on the first call to [`Engaged::take_events`].
    events: Option<RingBuf<MapData>>,
    /// Every mediated inode → the path it was stat'd from.
    pub paths: BTreeMap<TargetKey, String>,
    /// The cgroups of the processes serving the mediated sockets, remembered so a refresh that
    /// only learned the app's cgroup does not drop them.
    pub server_cgroups: Vec<PathBuf>,
}

impl Engaged {
    /// Hand the ring buffer to the reporting thread. Only the first caller gets it.
    pub fn take_events(&mut self) -> Option<RingBuf<MapData>> {
        self.events.take()
    }

    /// Replace the mediated set. Keys that are gone are removed first, so a socket the shell
    /// unlinked stops being mediated rather than lingering until the map fills up.
    pub fn set_targets(&mut self, targets: &[Target]) -> Result<(), String> {
        let wanted: BTreeMap<TargetKey, String> =
            targets.iter().map(|t| (t.key, t.path.clone())).collect();
        let present: Vec<TargetKey> = self.targets.keys().filter_map(Result::ok).collect();
        for key in present {
            if !wanted.contains_key(&key) {
                self.targets
                    .remove(&key)
                    .map_err(|e| format!("cannot drop a stale socket from the map: {e}"))?;
            }
        }
        for key in wanted.keys() {
            self.targets
                .insert(key, 1u8, 0)
                .map_err(|e| format!("cannot add a socket to the map: {e}"))?;
        }
        self.paths = wanted;
        Ok(())
    }

    /// Replace the allow-list.
    ///
    /// An empty slot is **unset**, never left holding what was there before: a cgroup the app has
    /// left is an allow rule nobody asked for, and systemd reuses scope names, so the stale entry
    /// would eventually name somebody else's processes.
    ///
    /// Every slot is attempted even after one fails, and a slot that cannot be opened is cleared
    /// rather than skipped. Stopping at the first error would leave the slots after it holding
    /// the previous pass's cgroups — the failure would spread from one entry to the rest of the
    /// list, and the ones that quietly kept working are the dangerous half.
    pub fn set_allowed(&mut self, cgroups: &[Option<PathBuf>]) -> Result<(), String> {
        let mut failure: Option<String> = None;
        for (i, dir) in cgroups.iter().enumerate().take(MAX_ALLOWED_CGROUPS) {
            let slot = i as u32;
            // A directory fd is what `BPF_MAP_TYPE_CGROUP_ARRAY` holds; the kernel keeps its own
            // reference, so closing this one at the end of the iteration is fine.
            let opened = dir.as_ref().map(|path| {
                std::fs::File::open(path)
                    .map_err(|e| format!("cannot open the cgroup {}: {e}", path.display()))
            });
            match opened {
                Some(Ok(file)) => {
                    if let Err(e) = self.allowed.set(slot, file, 0) {
                        failure.get_or_insert(format!("cannot fill allow-list slot {slot}: {e}"));
                        let _ = self.allowed.unset(slot);
                    }
                }
                Some(Err(e)) => {
                    failure.get_or_insert(e);
                    let _ = self.allowed.unset(slot);
                }
                // Unsetting a slot that was never set fails with ENOENT, which is the state
                // this wanted anyway.
                None => {
                    let _ = self.allowed.unset(slot);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub fn set_mode(&mut self, mode: GuardMode) -> Result<(), String> {
        self.mode
            .set(0, mode_value(mode), 0)
            .map_err(|e| format!("cannot set the mode: {e}"))
    }

    pub fn targets(&self) -> usize {
        self.paths.len()
    }
}

/// Load, attach, pin and populate the program for `req`. Never returns an error: everything that
/// can go wrong here is reported as `IpcMediation::None` plus the sentence that says why, because
/// the guard's other half must still engage and the desktop must still work.
pub fn engage(req: &IpcRequest) -> (IpcOutcome, Option<Engaged>) {
    if req.setting == IpcGuardMode::Off {
        teardown();
        return (
            IpcOutcome::unavailable("guard.ipcGuard is off in the policy"),
            None,
        );
    }
    if req.mode == GuardMode::Off {
        teardown();
        return (IpcOutcome::unavailable("the session guard is off"), None);
    }
    let read = |p: &Path| std::fs::read_to_string(p).ok();
    let exists = |p: &Path| p.exists();
    if let Err(e) = support(PROGRAM, &read, &exists) {
        // A machine that could run it yesterday and cannot today (a kernel downgrade, a daemon
        // rebuilt without clang) would otherwise keep a pinned program mediating a target set
        // nothing refreshes any more, while reporting `none`. Reporting less protection than is
        // in force is the safer direction to be wrong in, but it is still wrong.
        teardown();
        return (IpcOutcome::unavailable(e), None);
    }
    match load_and_attach(req) {
        Ok(engaged) => (
            IpcOutcome {
                mediation: IpcMediation::Bpf,
                reason: None,
                targets: engaged.targets(),
            },
            Some(engaged),
        ),
        Err(e) => (IpcOutcome::unavailable(e), None),
    }
}

/// Attach the new program **before** unpinning the old one.
///
/// The other order has a window where nothing mediates `connect()`, and this runs on every
/// `guard-apply` — including the one at boot. Two copies attached for the length of a pin call
/// is harmless: each sees the other's verdict as the hook's incoming `ret` and passes a denial
/// straight through, so the pair behaves exactly like one.
fn load_and_attach(req: &IpcRequest) -> Result<Engaged, String> {
    let (engaged, link) = load(req)?;
    teardown();
    let dir = build_dir(PROGRAM);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {} on bpffs: {e}", dir.display()))?;
    link.pin(dir.join("link"))
        .map_err(|e| format!("cannot pin the link under {}: {e}", dir.display()))?;
    Ok(engaged)
}

/// Load, attach and populate, without touching any pin. The caller owns the link: dropping it
/// detaches the program, which is what the integration test wants and what `load_and_attach`
/// prevents by pinning instead.
fn load(req: &IpcRequest) -> Result<(Engaged, FdLink), String> {
    let btf =
        Btf::from_sys_fs().map_err(|e| format!("cannot read the kernel's BTF: {}", chain(&e)))?;
    let mut bpf = EbpfLoader::new()
        .btf(Some(&btf))
        .load(PROGRAM)
        .map_err(|e| format!("the BPF program did not load: {}", chain(&e)))?;

    let program: &mut Lsm = bpf
        .program_mut(PROGRAM_NAME)
        .ok_or_else(|| format!("{PROGRAM_NAME} is missing from the compiled object"))?
        .try_into()
        .map_err(|e| format!("{PROGRAM_NAME} is not an LSM program: {e}"))?;
    program.load(LSM_HOOK, &btf).map_err(|e| {
        format!(
            "bpf_lsm_{LSM_HOOK} is not an attach point on this kernel: {}",
            chain(&e)
        )
    })?;
    let link_id = program
        .attach()
        .map_err(|e| format!("cannot attach to lsm/{LSM_HOOK}: {}", chain(&e)))?;
    let link: FdLink = program
        .take_link(link_id)
        .map_err(|e| format!("cannot take the link: {e}"))?
        .into();

    let mut engaged = Engaged {
        targets: typed_map(&mut bpf, MAP_TARGETS, |m| {
            aya::maps::HashMap::try_from(m).map_err(|e| e.to_string())
        })?,
        allowed: typed_map(&mut bpf, MAP_ALLOWED, |m| {
            CgroupArray::try_from(m).map_err(|e| e.to_string())
        })?,
        mode: typed_map(&mut bpf, MAP_MODE, |m| {
            Array::try_from(m).map_err(|e| e.to_string())
        })?,
        events: Some(typed_map(&mut bpf, MAP_EVENTS, |m| {
            RingBuf::try_from(m).map_err(|e| e.to_string())
        })?),
        paths: BTreeMap::new(),
        server_cgroups: req.server_cgroups.clone(),
    };
    // Fill the maps before the program is authoritative. It is already attached at this point,
    // but with an empty target map it mediates nothing, so there is no moment where it denies
    // something the allow-list has not caught up with yet.
    engaged.set_allowed(&allowed_cgroups(
        req.app_cgroup.clone(),
        &req.server_cgroups,
    ))?;
    engaged.set_targets(&req.targets)?;
    engaged.set_mode(req.mode)?;
    Ok((engaged, link))
}

/// The whole error chain on one line.
///
/// aya nests the useful part: the top-level message is "failed to create map `rpchat_targets`"
/// and the errno that says *why* — usually `EPERM`, meaning no `CAP_BPF` — is two `source()`
/// hops down. Without this, every failure reads the same and the residual line says nothing.
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(next) = source {
        out.push_str(": ");
        out.push_str(&next.to_string());
        source = next.source();
    }
    out
}

fn typed_map<T>(
    bpf: &mut Ebpf,
    name: &str,
    wrap: impl FnOnce(Map) -> Result<T, String>,
) -> Result<T, String> {
    let map = bpf
        .take_map(name)
        .ok_or_else(|| format!("{name} is missing from the compiled object"))?;
    wrap(map).map_err(|e| format!("{name} is not the map type this daemon expects: {e}"))
}

/// Remove every pin under [`PIN_DIR`], whatever build wrote it, and the directory itself.
///
/// Unlinking a pinned link detaches the program once nothing else holds it, so this is how the
/// guard is turned off — and how a daemon that was upgraded gets rid of the previous build's
/// program instead of running both.
pub fn teardown() {
    let root = Path::new(PIN_DIR);
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(pins) = std::fs::read_dir(&path) {
                for pin in pins.flatten() {
                    let _ = std::fs::remove_file(pin.path());
                }
            }
            let _ = std::fs::remove_dir(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    let _ = std::fs::remove_dir(root);
}

/// Wait up to `timeout_ms` for records and drain everything queued.
///
/// A malformed record — the wrong size for this daemon's [`Event`] — is dropped rather than
/// guessed at: it would mean the attached program is not the one this binary was built with,
/// which [`teardown`] before every attach is there to prevent.
pub fn read_events(ring: &mut RingBuf<MapData>, timeout_ms: u16) -> io::Result<Vec<Event>> {
    use nix::poll::{poll, PollFd, PollFlags, PollTimeout};

    let mut fds = [PollFd::new(ring.as_fd(), PollFlags::POLLIN)];
    match poll(&mut fds, PollTimeout::from(timeout_ms)) {
        Ok(0) => return Ok(Vec::new()),
        Ok(_) => {}
        Err(nix::errno::Errno::EINTR) => return Ok(Vec::new()),
        Err(e) => return Err(io::Error::from(e)),
    }
    let mut out = Vec::new();
    while let Some(item) = ring.next() {
        if let Some(event) = Event::parse(&item) {
            out.push(event);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::tests::noctalia_hyprland_ctx;
    use crate::guard::{ServedSocket, NOCTALIA, SWWW};
    use std::collections::HashMap;

    /// The C source, so the constants both sides share are checked rather than trusted.
    const SOURCE: &str = include_str!("bpf/ipc_guard.bpf.c");

    fn reader(files: &[(&str, &str)]) -> impl Fn(&Path) -> Option<String> {
        let map: HashMap<String, String> = files
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |p: &Path| map.get(&p.to_string_lossy().into_owned()).cloned()
    }

    fn lister(dirs: &[(&str, &[&str])]) -> impl Fn(&Path) -> Vec<String> {
        let map: HashMap<String, Vec<String>> = dirs
            .iter()
            .map(|(k, v)| {
                (
                    (*k).to_string(),
                    v.iter().map(|s| (*s).to_string()).collect(),
                )
            })
            .collect();
        move |p: &Path| {
            map.get(&p.to_string_lossy().into_owned())
                .cloned()
                .unwrap_or_default()
        }
    }

    fn rules(json: serde_json::Value) -> GuardRules {
        crate::policy::parse_policy(&json.to_string())
            .unwrap()
            .guard_rules()
    }

    #[test]
    fn the_program_and_the_loader_agree_on_every_shared_constant() {
        assert!(
            SOURCE.contains(&format!("#define MAX_TARGETS {MAX_TARGETS}")),
            "MAX_TARGETS drifted from the program"
        );
        assert!(
            SOURCE.contains(&format!(
                "#define MAX_ALLOWED_CGROUPS {MAX_ALLOWED_CGROUPS}"
            )),
            "MAX_ALLOWED_CGROUPS drifted from the program"
        );
        for (name, value) in [
            ("MODE_OFF", MODE_OFF),
            ("MODE_AUDIT", MODE_AUDIT),
            ("MODE_ENFORCE", MODE_ENFORCE),
        ] {
            assert!(
                SOURCE.contains(&format!("#define {name} {value}")),
                "{name}"
            );
        }
        for map in [MAP_TARGETS, MAP_ALLOWED, MAP_MODE, MAP_EVENTS] {
            assert!(
                SOURCE.contains(&format!("}} {map} SEC(\".maps\")")),
                "{map}"
            );
        }
        assert!(SOURCE.contains(&format!("SEC(\"lsm/{LSM_HOOK}\")")));
        assert!(SOURCE.contains(&format!("int BPF_PROG({PROGRAM_NAME},")));
        // The kernel refuses `bpf_probe_read_kernel` to a program that is not GPL-compatible,
        // and every field read goes through one.
        assert!(SOURCE.contains("SEC(\"license\") = \"Dual MIT/GPL\""));
    }

    /// `struct rpchat_event` and [`Event`] are two declarations of one wire format, and nothing
    /// but this test notices when one of them moves.
    #[test]
    fn the_event_layout_matches_the_program() {
        assert_eq!(std::mem::size_of::<Event>(), 40);
        let raw: Vec<u8> = [
            &7u32.to_ne_bytes()[..],
            &3u32.to_ne_bytes()[..],
            &4242u64.to_ne_bytes()[..],
            &991u32.to_ne_bytes()[..],
            &1u32.to_ne_bytes()[..],
            b"awww\0\0\0\0\0\0\0\0\0\0\0\0",
        ]
        .concat();
        let event = Event::parse(&raw).expect("a 40-byte record parses");
        assert_eq!(
            event.key(),
            TargetKey {
                dev_major: 7,
                dev_minor: 3,
                ino: 4242
            }
        );
        assert_eq!(event.pid, 991);
        assert_eq!(event.command(), "awww");
        assert!(event.blocked != 0);
        // A record of any other size is from a program this daemon did not build.
        assert!(Event::parse(&raw[..39]).is_none());
        assert!(Event::parse(&[]).is_none());
    }

    #[test]
    fn a_record_becomes_the_same_guard_attempt_an_apparmor_denial_would() {
        let key = TargetKey {
            dev_major: 0,
            dev_minor: 26,
            ino: 91,
        };
        let mut paths = BTreeMap::new();
        paths.insert(key, "/run/user/1000/noctalia-wayland-1.sock".to_string());
        let event = Event {
            dev_major: 0,
            dev_minor: 26,
            ino: 91,
            pid: 5150,
            blocked: 1,
            comm: *b"noctalia\0\0\0\0\0\0\0\0",
        };
        let a = attempt(&event, &paths);
        assert_eq!(a.kind, AttemptKind::Ipc);
        assert_eq!(a.target, "/run/user/1000/noctalia-wayland-1.sock");
        assert_eq!(a.command, "noctalia");
        assert_eq!(a.pid, 5150);
        assert!(a.blocked);
        assert_eq!(a.operation, "connect");
        // Not an `rpchat-*` profile name: it did not come from a profile, and a reader that
        // treats every attempt as AppArmor's would be wrong about this one.
        assert_eq!(a.profile, ATTEMPT_PROFILE);

        // An inode the table no longer knows (the shell rebound in between) is still reported.
        let unknown = attempt(&event, &BTreeMap::new());
        assert_eq!(unknown.target, "unix socket 0:26 inode 91");

        // Audit mode: reported, not blocked.
        let audited = Event {
            blocked: 0,
            ..event
        };
        assert!(!attempt(&audited, &paths).blocked);
    }

    #[test]
    fn support_names_the_one_thing_that_is_missing() {
        let ok = reader(&[("/sys/kernel/security/lsm", "capability,apparmor,bpf\n")]);
        let present = |_: &Path| true;
        assert_eq!(support(b"\x7fELF", &ok, &present), Ok(()));

        // A build without clang is as honest a failure as a kernel that cannot run it.
        let e = support(&[], &ok, &present).unwrap_err();
        assert!(e.contains("built without the BPF program"), "{e}");

        let no_bpf = reader(&[(
            "/sys/kernel/security/lsm",
            "capability,landlock,lockdown,yama,apparmor\n",
        )]);
        let e = support(b"\x7fELF", &no_bpf, &present).unwrap_err();
        assert!(e.contains("bpf LSM is not enabled"), "{e}");
        assert!(e.contains("lsm=…,bpf"), "{e}");

        let e = support(b"\x7fELF", &|_| None, &present).unwrap_err();
        assert!(e.contains("/sys/kernel/security/lsm is missing"), "{e}");

        let no_btf = |p: &Path| p != Path::new(BTF_VMLINUX);
        let e = support(b"\x7fELF", &ok, &no_btf).unwrap_err();
        assert!(e.contains("carries no BTF"), "{e}");

        let no_bpffs = |p: &Path| p != Path::new(BPF_FS);
        let e = support(b"\x7fELF", &ok, &no_bpffs).unwrap_err();
        assert!(e.contains("not mounted"), "{e}");

        assert!(lsm_active("capability,apparmor,bpf", "bpf"));
        assert!(!lsm_active("capability,apparmor,bpfilter", "bpf"));
        assert!(!lsm_active("", "bpf"));
    }

    #[test]
    fn matches_one_path_component_the_way_a_shell_does() {
        assert!(fnmatch("noctalia-*.sock", "noctalia-wayland-1.sock"));
        assert!(!fnmatch("noctalia-*.sock", "noctalia-wayland-1.sockx"));
        assert!(fnmatch("[0-9]*", "1000"));
        assert!(!fnmatch("[0-9]*", "root"));
        assert!(fnmatch("[!0-9]*", "root"));
        assert!(!fnmatch("[!0-9]*", "1000"));
        assert!(fnmatch("wayland-?", "wayland-1"));
        assert!(!fnmatch("wayland-?", "wayland-10"));
        assert!(fnmatch("*", "anything"));
        assert!(fnmatch("bus", "bus"));
        // An unterminated class is a literal bracket, as in fnmatch(3).
        assert!(fnmatch("[abc", "[abc"));
    }

    #[test]
    fn expands_the_tables_globs_against_the_directories_that_exist() {
        let ls = lister(&[
            ("/run/user", &["1000", "1001", "lost+found"]),
            (
                "/run/user/1000",
                &["noctalia-wayland-1.sock", "wayland-1", "bus"],
            ),
            ("/run/user/1001", &["noctalia-wayland-2.sock"]),
            ("/home", &["work"]),
            ("/home/work", &[".swww.sock"]),
        ]);
        assert_eq!(
            expand_glob("@{run}/user/[0-9]*/noctalia-*.sock", &ls),
            vec![
                "/run/user/1000/noctalia-wayland-1.sock".to_string(),
                "/run/user/1001/noctalia-wayland-2.sock".to_string(),
            ]
        );
        // `@{HOME}` is `/home/*/ /root/`, exactly as the profiles define it. `/root` is offered
        // whether or not it has the file; the stat that follows is what decides.
        assert_eq!(
            expand_glob("@{HOME}/.swww.sock", &ls),
            vec![
                "/home/work/.swww.sock".to_string(),
                "/root/.swww.sock".to_string()
            ]
        );
        // A literal path needs no listing at all, and is filtered later by the stat.
        assert_eq!(
            expand_glob("/run/extra.sock", &ls),
            vec!["/run/extra.sock".to_string()]
        );
        // Nothing matched is nothing mediated, not everything.
        assert!(expand_glob("@{run}/user/[0-9]*/hyprpaper*", &ls).is_empty());
        // `**` is refused rather than guessed at: expanding it wrongly puts a socket the
        // session needs into the map.
        assert!(expand_glob("@{run}/**/x.sock", &ls).is_empty());
        assert!(expand_glob("relative/path.sock", &ls).is_empty());
    }

    /// The test that matters most, mirroring `discovery_never_puts_a_display_socket_into_the_
    /// profiles`: the Wayland display, X11, the bus and the audio sockets live in the same
    /// directory as the shell's, and mediating one of them takes the desktop down under enforce.
    #[test]
    fn the_sessions_lifelines_never_reach_the_map() {
        let mut ctx = noctalia_hyprland_ctx(&["work"]);
        ctx.served = [
            "/run/user/1000/wayland-1",
            "/run/user/1000/bus",
            "/run/user/1000/pipewire-0",
            "/run/user/1000/pulse/native",
            "/run/user/1000/systemd/private",
            "/tmp/.X11-unix/X0",
            "/run/user/1000/noctalia-wayland-1.sock",
        ]
        .iter()
        .map(|p| ServedSocket {
            path: (*p).to_string(),
            owner: Owner::Shell,
            entry: "noctalia".into(),
            pid: 7,
        })
        .collect();
        let stat = |p: &Path| {
            Some(SocketStat {
                uid: 1000,
                key: TargetKey {
                    dev_major: 0,
                    dev_minor: 26,
                    ino: p.to_string_lossy().len() as u64,
                },
                is_socket: true,
            })
        };
        let targets = resolve_targets(
            &rules(
                serde_json::json!({"version":1,"app":{"users":["work"]},"guard":{"mode":"enforce"}}),
            ),
            &ctx,
            &lister(&[]),
            &stat,
        );
        assert_eq!(
            targets.iter().map(|t| t.path.as_str()).collect::<Vec<_>>(),
            vec!["/run/user/1000/noctalia-wayland-1.sock"]
        );
    }

    #[test]
    fn mediates_the_guarded_users_shell_sockets_and_nothing_else() {
        let mut ctx = noctalia_hyprland_ctx(&["work"]);
        ctx.shells = vec![&NOCTALIA, &SWWW];
        ctx.served = vec![
            // The shell's own socket: mediated.
            ServedSocket {
                path: "/run/user/1000/noctalia-wayland-1.sock".into(),
                owner: Owner::Shell,
                entry: "noctalia".into(),
                pid: 7,
            },
            // The compositor's control socket: out of scope here (see the spec).
            ServedSocket {
                path: "/run/user/1000/hypr/abc/.socket.sock".into(),
                owner: Owner::Compositor,
                entry: "hyprland".into(),
                pid: 8,
            },
            // Another user's shell. The program mediates every process on the machine, so
            // putting this in the map would deny that user their own desktop.
            ServedSocket {
                path: "/run/user/1001/noctalia-wayland-2.sock".into(),
                owner: Owner::Shell,
                entry: "noctalia".into(),
                pid: 9,
            },
        ];
        let stat = |p: &Path| {
            let path = p.to_string_lossy().into_owned();
            Some(SocketStat {
                uid: if path.contains("/1001/") { 1001 } else { 1000 },
                key: TargetKey {
                    dev_major: 0,
                    dev_minor: 26,
                    ino: path.len() as u64,
                },
                // A regular file a glob happened to match is not a socket and is dropped.
                is_socket: !path.ends_with("settings.toml"),
            })
        };
        let ls = lister(&[
            ("/run/user", &["1000"]),
            (
                "/run/user/1000",
                &["noctalia-wayland-1.sock", "settings.toml"],
            ),
            ("/home", &["work"]),
        ]);
        let r = rules(
            serde_json::json!({"version":1,"app":{"users":["work"]},"guard":{"mode":"enforce"}}),
        );
        let targets = resolve_targets(&r, &ctx, &ls, &stat);
        assert_eq!(
            targets.iter().map(|t| t.path.as_str()).collect::<Vec<_>>(),
            vec!["/run/user/1000/noctalia-wayland-1.sock"]
        );

        // `guard.wallpaper: false` means the shell's sockets are not guarded at all.
        let off = rules(serde_json::json!({"version":1,"app":{"users":["work"]},
            "guard":{"mode":"enforce","wallpaper":false}}));
        assert!(resolve_targets(&off, &ctx, &ls, &stat).is_empty());

        // `extraDenySockets` is the admin naming one the table does not know.
        let extra = rules(serde_json::json!({"version":1,"app":{"users":["work"]},
            "guard":{"mode":"enforce","wallpaper":false,"extraDenySockets":["/run/user/1000/noctalia-*.sock"]}}));
        assert_eq!(
            resolve_targets(&extra, &ctx, &ls, &stat)
                .iter()
                .map(|t| t.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/run/user/1000/noctalia-wayland-1.sock"]
        );
    }

    #[test]
    fn reads_the_cgroup_v2_path_and_declines_a_v1_only_machine() {
        assert_eq!(
            cgroup_dir("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-rpchat.scope\n"),
            Some(PathBuf::from(
                "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/app-rpchat.scope"
            ))
        );
        assert_eq!(cgroup_dir("0::/\n"), Some(PathBuf::from("/sys/fs/cgroup")));
        // v1 only: nothing `bpf_current_task_under_cgroup` can test against.
        assert_eq!(
            cgroup_dir("7:devices:/user.slice\n1:name=systemd:/\n"),
            None
        );
        assert_eq!(cgroup_dir(""), None);
    }

    #[test]
    fn the_app_takes_slot_zero_and_the_servers_what_is_left() {
        let app = PathBuf::from("/sys/fs/cgroup/app");
        let bar = PathBuf::from("/sys/fs/cgroup/bar");
        let paper = PathBuf::from("/sys/fs/cgroup/paper");
        let slots = allowed_cgroups(
            Some(app.clone()),
            &[bar.clone(), paper.clone(), bar.clone()],
        );
        assert_eq!(slots.len(), MAX_ALLOWED_CGROUPS);
        assert_eq!(slots[APP_CGROUP_SLOT as usize], Some(app.clone()));
        assert_eq!(slots[1], Some(bar.clone()));
        assert_eq!(slots[2], Some(paper));
        // A duplicate does not consume a second slot.
        assert_eq!(slots[3], None);

        // The app has not registered yet: slot 0 is empty and everything else still holds. This
        // is the window `register_app_cgroup` closes.
        let none = allowed_cgroups(None, std::slice::from_ref(&bar));
        assert_eq!(none[APP_CGROUP_SLOT as usize], None);
        assert_eq!(none[1], Some(bar.clone()));

        // More servers than slots: the extras are dropped, not wrapped around onto the app's.
        let many: Vec<PathBuf> = (0..20)
            .map(|n| PathBuf::from(format!("/sys/fs/cgroup/s{n}")))
            .collect();
        let full = allowed_cgroups(Some(app.clone()), &many);
        assert_eq!(full[APP_CGROUP_SLOT as usize], Some(app));
        assert!(full.iter().all(Option::is_some));
    }

    #[test]
    fn the_modes_line_up_with_the_programs() {
        assert_eq!(mode_value(GuardMode::Off), MODE_OFF);
        assert_eq!(mode_value(GuardMode::Audit), MODE_AUDIT);
        assert_eq!(mode_value(GuardMode::Enforce), MODE_ENFORCE);
    }

    #[test]
    fn the_residual_says_which_mechanism_is_live_and_never_two_at_once() {
        let bpf = IpcOutcome {
            mediation: IpcMediation::Bpf,
            reason: None,
            targets: 2,
        };
        // A kernel that can do both: the program is what is actually mediating, so that is what
        // is reported — not the profile rule, which is loaded but inert here.
        assert_eq!(effective_mediation(&bpf, true), IpcMediation::Bpf);
        let lines = residual(&bpf, false, true).join("\n");
        assert!(lines.contains("BPF LSM program (2 socket(s)"), "{lines}");
        assert!(
            lines.contains("root and system services are denied"),
            "{lines}"
        );
        assert!(lines.contains("cgroup"), "{lines}");
        assert!(!lines.contains("NOT guarded"), "{lines}");

        // Nothing loaded on a kernel whose AppArmor can mediate: the profiles cover it and
        // there is nothing extra to disclose.
        let nothing = IpcOutcome::unavailable("guard.ipcGuard is off in the policy");
        assert_eq!(effective_mediation(&nothing, true), IpcMediation::Apparmor);
        assert!(residual(&nothing, true, true).is_empty());

        // Nothing loaded on a kernel whose AppArmor cannot: say so, and say why.
        assert_eq!(effective_mediation(&nothing, false), IpcMediation::None);
        let lines = residual(&nothing, false, true).join("\n");
        assert!(lines.contains("wallpaper IPC is NOT guarded"), "{lines}");
        assert!(
            lines.contains("guard.ipcGuard is off in the policy"),
            "{lines}"
        );

        // Nothing is being guarded at all: no lines about how it is guarded.
        assert!(residual(&bpf, false, false).is_empty());
        assert!(residual(&nothing, false, false).is_empty());

        assert_eq!(IpcMediation::Bpf.as_str(), "bpf");
        assert_eq!(IpcMediation::Apparmor.as_str(), "apparmor");
        assert_eq!(IpcMediation::None.as_str(), "none");
    }

    #[test]
    fn the_build_id_follows_the_program() {
        assert_eq!(build_id(b"one").len(), 16);
        assert_ne!(build_id(b"one"), build_id(b"two"));
        assert_eq!(build_id(b"one"), build_id(b"one"));
        assert!(build_dir(b"one").starts_with(PIN_DIR));
    }

    // -----------------------------------------------------------------------
    // The one test that runs the program
    // -----------------------------------------------------------------------

    /// Bind a socket, mediate it, and connect to it — the only test that proves the thing works.
    ///
    /// **Skipped** when the kernel cannot run the program or the process lacks `CAP_BPF`,
    /// following `generated_profiles_pass_apparmor_parser_when_available`: a developer box
    /// running this very guard should get a skip, not a red test that looks like a real failure.
    ///
    /// It never calls [`engage`], so it cannot disturb a daemon that has the guard engaged on
    /// this machine: no pin is written and no existing one is removed. The link it holds is
    /// dropped at the end, which detaches the program.
    #[test]
    fn the_program_denies_a_mediated_socket_and_nothing_else() {
        use std::io::ErrorKind;
        use std::os::unix::net::{UnixListener, UnixStream};

        if PROGRAM.is_empty() {
            eprintln!("skipped: this build has no BPF object (clang was missing)");
            return;
        }
        let read = |p: &Path| std::fs::read_to_string(p).ok();
        let exists = |p: &Path| p.exists();
        if let Err(e) = support(PROGRAM, &read, &exists) {
            eprintln!("skipped: {e}");
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let guarded_path = dir.path().join("guarded.sock");
        let open_path = dir.path().join("open.sock");
        let guarded = UnixListener::bind(&guarded_path).expect("bind");
        let open = UnixListener::bind(&open_path).expect("bind");
        let stat = |p: &Path| {
            use std::os::unix::fs::MetadataExt;
            let md = std::fs::symlink_metadata(p).unwrap();
            TargetKey {
                dev_major: nix::sys::stat::major(md.dev()) as u32,
                dev_minor: nix::sys::stat::minor(md.dev()) as u32,
                ino: md.ino(),
            }
        };
        let target = Target {
            path: guarded_path.to_string_lossy().into_owned(),
            key: stat(&guarded_path),
        };

        // Enforce, with an empty allow-list: this process is in no allowed cgroup.
        let request = IpcRequest {
            mode: GuardMode::Enforce,
            setting: IpcGuardMode::Auto,
            targets: vec![target.clone()],
            app_cgroup: None,
            server_cgroups: Vec::new(),
        };
        let (mut engaged, link) = match load(&request) {
            Ok(pair) => pair,
            Err(e)
                if [
                    "Operation not permitted",
                    "Permission denied",
                    "not supported",
                ]
                .iter()
                .any(|m| e.contains(m)) =>
            {
                eprintln!("skipped: this process may not load BPF programs ({e})");
                return;
            }
            Err(e) => {
                panic!("the program must load on a kernel that passes the support check: {e}")
            }
        };

        let err = UnixStream::connect(&guarded_path)
            .expect_err("enforce must deny a mediated socket")
            .kind();
        assert_eq!(
            err,
            ErrorKind::PermissionDenied,
            "must be EACCES, not {err:?}"
        );
        // Keyed on the inode, so a socket beside it in the same directory is untouched. This is
        // the property the session's lifelines depend on.
        UnixStream::connect(&open_path).expect("an unmediated socket is not affected");

        // The attempt was reported, named by its path and marked blocked.
        let mut ring = engaged.take_events().expect("the ring buffer");
        let events = read_events(&mut ring, 500).expect("read");
        let reported = events
            .iter()
            .find(|e| e.key() == target.key)
            .expect("the denial reaches the ring buffer");
        assert!(reported.blocked != 0);
        assert_eq!(reported.pid, std::process::id());
        let attempt = attempt(reported, &engaged.paths);
        assert_eq!(attempt.target, target.path);
        assert!(attempt.blocked);

        // Audit mode reports and does not block — the one thing that makes audit mode mean
        // anything at all.
        engaged.set_mode(GuardMode::Audit).expect("set audit");
        UnixStream::connect(&guarded_path).expect("audit mode must never block");
        let audited = read_events(&mut ring, 500).expect("read");
        assert!(
            audited
                .iter()
                .any(|e| e.key() == target.key && e.blocked == 0),
            "audit mode must still report"
        );

        // Back to enforce, and this time the caller is inside the allow-list: the app's own
        // cgroup, which is what lets the character set a wallpaper the session may not.
        engaged.set_mode(GuardMode::Enforce).expect("set enforce");
        let own = std::fs::read_to_string("/proc/self/cgroup")
            .ok()
            .and_then(|t| cgroup_dir(&t))
            .filter(|d| d.is_dir());
        match own {
            Some(cgroup) => {
                engaged
                    .set_allowed(&allowed_cgroups(Some(cgroup), &[]))
                    .expect("allow this process's cgroup");
                UnixStream::connect(&guarded_path)
                    .expect("a caller in the allowed cgroup must get through");
                // And taking it away again denies once more, so the map is really what decides.
                engaged
                    .set_allowed(&allowed_cgroups(None, &[]))
                    .expect("clear the allow-list");
                assert!(UnixStream::connect(&guarded_path).is_err());
            }
            None => eprintln!("no cgroup v2 path for this process; the allow-list half is skipped"),
        }

        // An empty target map mediates nothing, which is what `guard-off` leaves behind.
        engaged.set_targets(&[]).expect("clear the targets");
        UnixStream::connect(&guarded_path).expect("nothing is mediated once the map is empty");

        drop(link);
        drop((guarded, open));
    }

    /// The object this daemon carries has to be the real thing, or every check above is
    /// checking a placeholder. Skipped on a build without clang, which `build.rs` allows on
    /// purpose — CI and the release build set `RP_REQUIRE_BPF` so they cannot skip it.
    #[test]
    fn the_compiled_program_is_embedded() {
        if PROGRAM.is_empty() {
            eprintln!("skipped: this build has no BPF object (clang was missing)");
            return;
        }
        assert_eq!(&PROGRAM[..4], b"\x7fELF");
        assert!(PROGRAM.len() > 1024, "{} bytes", PROGRAM.len());
    }
}
