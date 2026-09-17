//! Keepalive: relaunching the app when its registered connection drops while the policy says
//! `app.allowQuit: false` (docs/spec/system.md "Keepalive").
//!
//! Everything in this module is pure and unit-tested: registration validation, the gate that
//! decides whether a relaunch may happen (policy, `app.users`, active graphical session, process
//! state), the crash-loop backoff, the parsing of logind session files / `loginctl` output, and
//! the construction of the relaunch command (uid/gid/env/cwd). Only `main.rs` reads `/proc`,
//! `/run/systemd/sessions` and calls `Command::spawn`.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::policy::AppRules;
use crate::protocol::KeepaliveInfo;

/// Environment variables a registration may carry (`KEEPALIVE_ENV_KEYS` in `@rp/shared`).
pub const ENV_KEYS: [&str; 23] = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_ID",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "SWAYSOCK",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XAUTHORITY",
    "APPIMAGE",
    "APPDIR",
    "ELECTRON_OZONE_PLATFORM_HINT",
];
/// Longest env value (bytes).
pub const ENV_VALUE_MAX: usize = 4096;
/// Most `args` entries.
pub const ARGS_MAX: usize = 32;
/// Longest single argument / path (bytes).
pub const ARG_MAX: usize = 4096;

/// Delay before the first relaunch and the ladder for deaths within `RAPID_DEATH_WINDOW` of the
/// previous relaunch: 1.5 s → 3 → 6 → 12 → 30 (cap).
pub const BACKOFF_LADDER_MS: [u64; 5] = [1500, 3000, 6000, 12_000, 30_000];
/// A death this soon after a relaunch climbs the ladder; later deaths start over at 1.5 s.
pub const RAPID_DEATH_WINDOW: Duration = Duration::from_secs(60);
/// Once the app stayed up this long after a relaunch every counter is reset.
pub const STABLE_UPTIME: Duration = Duration::from_secs(5 * 60);
/// Give up after this many relaunches within `GIVE_UP_WINDOW`.
pub const GIVE_UP_COUNT: usize = 10;
pub const GIVE_UP_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Where logind keeps one state file per session.
pub const DEFAULT_SESSIONS_DIR: &str = "/run/systemd/sessions";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/// SO_PEERCRED of the registering connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

/// A validated registration: what to run, as whom, plus how to tell the process is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub exec: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
    /// User name of `uid` (getpwuid), matched against `app.users`.
    pub user: String,
    /// `/proc/<pid>/stat` start time at registration; a pid reused later has a different one.
    pub proc_start: Option<u64>,
}

impl Registration {
    /// `exec args…` for logs.
    pub fn command_line(&self) -> String {
        let mut s = self.exec.clone();
        for a in &self.args {
            s.push(' ');
            s.push_str(a);
        }
        s
    }
}

fn clean_str(what: &str, s: &str, max: usize) -> Result<(), String> {
    if s.contains('\0') {
        return Err(format!("{what} contains a NUL byte"));
    }
    if s.len() > max {
        return Err(format!("{what} is longer than {max} bytes"));
    }
    Ok(())
}

/// The fields of a `register` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterRequest<'a> {
    pub exec: &'a str,
    pub args: &'a [String],
    pub cwd: &'a str,
    pub env: &'a BTreeMap<String, String>,
}

/// Validate a `register` request. `is_executable` answers whether `exec` is an existing
/// executable file (injected so tests need no real binaries); `user` is the peer uid's name.
pub fn validate_registration(
    req: RegisterRequest<'_>,
    peer: Peer,
    user: Option<&str>,
    proc_start: Option<u64>,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Result<Registration, String> {
    let RegisterRequest {
        exec,
        args,
        cwd,
        env,
    } = req;
    if peer.uid == 0 {
        return Err("root may not register for relaunch".into());
    }
    let user = user.ok_or_else(|| format!("uid {} has no user name", peer.uid))?;
    clean_str("exec", exec, ARG_MAX)?;
    if !exec.starts_with('/') {
        return Err("exec must be an absolute path".into());
    }
    if !is_executable(Path::new(exec)) {
        return Err(format!("exec {exec} is not an existing executable file"));
    }
    if args.len() > ARGS_MAX {
        return Err(format!("args has more than {ARGS_MAX} entries"));
    }
    for (i, a) in args.iter().enumerate() {
        clean_str(&format!("args[{i}]"), a, ARG_MAX)?;
    }
    clean_str("cwd", cwd, ARG_MAX)?;
    if !cwd.starts_with('/') {
        return Err("cwd must be an absolute path".into());
    }
    for (k, v) in env {
        if !ENV_KEYS.contains(&k.as_str()) {
            return Err(format!("env.{k} is not an allowed variable"));
        }
        clean_str(&format!("env.{k}"), v, ENV_VALUE_MAX)?;
    }
    Ok(Registration {
        exec: exec.to_string(),
        args: args.to_vec(),
        cwd: cwd.to_string(),
        env: env.clone(),
        uid: peer.uid,
        gid: peer.gid,
        pid: peer.pid,
        user: user.to_string(),
        proc_start,
    })
}

/// Field 22 (`starttime`) of `/proc/<pid>/stat`; the comm field may contain spaces and
/// parentheses, so parse after the last `)`.
pub fn parse_proc_stat_starttime(text: &str) -> Option<u64> {
    let rest = &text[text.rfind(')')? + 1..];
    // Fields after comm start at field 3 (state), so starttime is the 20th token here.
    rest.split_whitespace().nth(19)?.parse().ok()
}

// ---------------------------------------------------------------------------
// Active graphical session (logind)
// ---------------------------------------------------------------------------

/// One logind session as far as the gate cares.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionInfo {
    pub id: String,
    pub active: bool,
    pub uid: Option<u32>,
    pub user: Option<String>,
    /// `wayland`, `x11`, `tty`, …
    pub kind: String,
    pub seat: String,
}

impl SessionInfo {
    /// An active session on a seat with a graphical type: its owner is "the current user".
    pub fn is_active_graphical(&self) -> bool {
        self.active && matches!(self.kind.as_str(), "wayland" | "x11") && !self.seat.is_empty()
    }
}

/// Parse a `/run/systemd/sessions/<id>` state file (`KEY=value` lines; `USER=` is the name,
/// `UID=` the id; the header comment is ignored). A `USER=` that is numeric is taken as the uid,
/// and `NAME=` as the name, so slightly different writers are accepted.
pub fn parse_session_file(id: &str, text: &str) -> SessionInfo {
    let mut s = SessionInfo {
        id: id.to_string(),
        ..Default::default()
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"');
        match k.trim() {
            "ACTIVE" => s.active = v == "1" || v.eq_ignore_ascii_case("yes"),
            "UID" => s.uid = v.parse().ok(),
            "USER" => match v.parse::<u32>() {
                Ok(uid) if s.uid.is_none() => s.uid = Some(uid),
                Ok(_) => {}
                Err(_) => s.user = Some(v.to_string()),
            },
            "NAME" => s.user = Some(v.to_string()),
            "TYPE" => s.kind = v.to_ascii_lowercase(),
            "SEAT" => s.seat = v.to_string(),
            _ => {}
        }
    }
    s
}

/// Parse `loginctl list-sessions --no-legend`: `SESSION UID USER SEAT …` per line → `(id, uid, user)`.
pub fn parse_loginctl_list(text: &str) -> Vec<(String, Option<u32>, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let id = it.next()?;
            let uid = it.next()?.parse().ok();
            let user = it.next()?;
            Some((id.to_string(), uid, user.to_string()))
        })
        .collect()
}

/// Parse `loginctl show-session <id> -p Active -p Name -p Type -p Seat -p User` output
/// (`Active=yes`, `Name=alice`, `Type=wayland`, `Seat=seat0`, `User=1000`).
pub fn parse_loginctl_show(id: &str, text: &str) -> SessionInfo {
    let mut s = SessionInfo {
        id: id.to_string(),
        ..Default::default()
    };
    for line in text.lines() {
        let Some((k, v)) = line.trim().split_once('=') else {
            continue;
        };
        match k {
            "Active" => s.active = v == "yes",
            "Name" => s.user = Some(v.to_string()),
            "Type" => s.kind = v.to_ascii_lowercase(),
            "Seat" => s.seat = v.to_string(),
            "User" => s.uid = v.parse().ok(),
            _ => {}
        }
    }
    s
}

/// The uids owning an active graphical session (normally zero or one; several with multi-seat).
pub fn active_graphical_uids(sessions: &[SessionInfo]) -> Vec<u32> {
    let mut out: Vec<u32> = sessions
        .iter()
        .filter(|s| s.is_active_graphical())
        .filter_map(|s| s.uid)
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

// ---------------------------------------------------------------------------
// Gate: may this registration be relaunched right now?
// ---------------------------------------------------------------------------

/// Why a relaunch does not happen (also the log line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    QuitAllowed,
    NoUsersListed,
    UserNotListed(String),
    UserNotActive(String),
    ProcessAlive(i32),
}

impl std::fmt::Display for Skip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Skip::QuitAllowed => write!(f, "app.allowQuit is not false"),
            Skip::NoUsersListed => write!(f, "app.users is empty; nobody is relaunched"),
            Skip::UserNotListed(u) => write!(f, "user {u} is not in app.users"),
            Skip::UserNotActive(u) => {
                write!(f, "user {u} does not own the active graphical session")
            }
            Skip::ProcessAlive(pid) => write!(f, "process {pid} is still running"),
        }
    }
}

/// The relaunch gate, evaluated when the connection drops and again when the delay is up:
/// policy (re-read by the caller), user list, active session, and — at fire time — the process.
pub fn relaunch_gate(
    rules: &AppRules,
    reg: &Registration,
    active_uids: &[u32],
    process_alive: Option<bool>,
) -> Result<(), Skip> {
    if rules.allow_quit {
        return Err(Skip::QuitAllowed);
    }
    if rules.users.is_empty() {
        return Err(Skip::NoUsersListed);
    }
    if !rules.users.iter().any(|u| u == &reg.user) {
        return Err(Skip::UserNotListed(reg.user.clone()));
    }
    if !active_uids.contains(&reg.uid) {
        return Err(Skip::UserNotActive(reg.user.clone()));
    }
    if process_alive == Some(true) {
        return Err(Skip::ProcessAlive(reg.pid));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Crash-loop backoff
// ---------------------------------------------------------------------------

/// What to do about a death.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Relaunch { delay: Duration, attempt: usize },
    GiveUp { relaunches_in_window: usize },
}

/// Per-user relaunch history driving the backoff ladder and the give-up rule.
#[derive(Debug, Clone, Default)]
pub struct RelaunchTracker {
    /// Relaunch instants inside `GIVE_UP_WINDOW`.
    history: Vec<Instant>,
    last_relaunch: Option<Instant>,
    /// Index into `BACKOFF_LADDER_MS` used for the last decision.
    step: usize,
    total: u32,
}

impl RelaunchTracker {
    /// The app died at `now`: pick a delay (climbing the ladder for rapid deaths) or give up.
    pub fn on_death(&mut self, now: Instant) -> Decision {
        if let Some(last) = self.last_relaunch {
            if now.duration_since(last) >= STABLE_UPTIME {
                self.history.clear();
                self.step = 0;
                self.last_relaunch = None;
            }
        }
        self.history
            .retain(|t| now.duration_since(*t) < GIVE_UP_WINDOW);
        if self.history.len() >= GIVE_UP_COUNT {
            return Decision::GiveUp {
                relaunches_in_window: self.history.len(),
            };
        }
        let rapid = self
            .last_relaunch
            .map(|last| now.duration_since(last) < RAPID_DEATH_WINDOW)
            .unwrap_or(false);
        self.step = if rapid {
            (self.step + 1).min(BACKOFF_LADDER_MS.len() - 1)
        } else {
            0
        };
        Decision::Relaunch {
            delay: Duration::from_millis(BACKOFF_LADDER_MS[self.step]),
            attempt: self.history.len() + 1,
        }
    }

    /// A relaunch was spawned at `now`.
    pub fn on_relaunched(&mut self, now: Instant) {
        self.history.push(now);
        self.last_relaunch = Some(now);
        self.total += 1;
    }

    #[cfg(test)]
    pub fn total(&self) -> u32 {
        self.total
    }
}

// ---------------------------------------------------------------------------
// Manager state (registrations, pending relaunches)
// ---------------------------------------------------------------------------

/// A relaunch waiting for its delay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub due: Instant,
    pub delay: Duration,
    pub attempt: usize,
    pub registration: Registration,
}

/// Shared keepalive state. Connections hold their own `Registration`; this tracks how many
/// are open per uid, the pending relaunches and the per-uid backoff.
#[derive(Debug, Default)]
pub struct Keepalive {
    open: HashMap<u32, usize>,
    pending: HashMap<u32, Pending>,
    trackers: HashMap<u32, RelaunchTracker>,
    relaunches: u32,
    warned_no_users: bool,
}

impl Keepalive {
    /// A connection registered (or replaced its registration when `replacing`). Returns the
    /// pending relaunch for that uid that this cancels, if any (the app came back on its own).
    pub fn register(&mut self, uid: u32, replacing: bool) -> Option<Pending> {
        if !replacing {
            *self.open.entry(uid).or_insert(0) += 1;
        }
        self.pending.remove(&uid)
    }

    /// A connection dropped its registration (`unregister`, or the socket closed).
    pub fn forget(&mut self, uid: u32) {
        if let Some(n) = self.open.get_mut(&uid) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.open.remove(&uid);
            }
        }
    }

    /// Registered connections currently open (any uid).
    pub fn registered(&self) -> bool {
        self.open.values().any(|n| *n > 0)
    }

    /// The gate passed for a dropped registration: decide the delay and queue the relaunch
    /// (replacing an older pending one for the same uid).
    pub fn schedule(&mut self, reg: Registration, now: Instant) -> Decision {
        let decision = self.trackers.entry(reg.uid).or_default().on_death(now);
        if let Decision::Relaunch { delay, attempt } = decision {
            self.pending.insert(
                reg.uid,
                Pending {
                    due: now + delay,
                    delay,
                    attempt,
                    registration: reg,
                },
            );
        }
        decision
    }

    /// Pending relaunches whose delay is up, removed from the queue.
    pub fn due(&mut self, now: Instant) -> Vec<Pending> {
        let ready: Vec<u32> = self
            .pending
            .iter()
            .filter(|(_, p)| p.due <= now)
            .map(|(uid, _)| *uid)
            .collect();
        let mut out: Vec<Pending> = ready
            .into_iter()
            .filter_map(|uid| self.pending.remove(&uid))
            .collect();
        out.sort_by_key(|p| p.registration.uid);
        out
    }

    #[cfg(test)]
    pub fn pending_for(&self, uid: u32) -> Option<&Pending> {
        self.pending.get(&uid)
    }

    /// A relaunch was spawned.
    pub fn relaunched(&mut self, uid: u32, now: Instant) {
        self.trackers.entry(uid).or_default().on_relaunched(now);
        self.relaunches += 1;
    }

    /// True the first time only: the "app.users is empty" warning is logged once.
    pub fn warn_no_users_once(&mut self) -> bool {
        !std::mem::replace(&mut self.warned_no_users, true)
    }

    pub fn info(&self, allow_quit: bool) -> KeepaliveInfo {
        KeepaliveInfo {
            registered: self.registered(),
            relaunches: self.relaunches,
            allow_quit,
        }
    }
}

// ---------------------------------------------------------------------------
// The relaunch command
// ---------------------------------------------------------------------------

/// Everything `Command::spawn` needs, decided purely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Exactly the registered environment — nothing from the daemon's own.
    pub env: BTreeMap<String, String>,
    pub uid: u32,
    pub gid: u32,
    pub user: String,
}

/// Build the spec: cwd as registered when `cwd_exists`, else `$HOME` from the registered env,
/// else `/`.
pub fn command_spec(reg: &Registration, cwd_exists: bool) -> CommandSpec {
    let cwd = if cwd_exists {
        reg.cwd.clone()
    } else {
        reg.env
            .get("HOME")
            .filter(|h| h.starts_with('/'))
            .cloned()
            .unwrap_or_else(|| "/".to_string())
    };
    CommandSpec {
        program: reg.exec.clone(),
        args: reg.args.clone(),
        cwd,
        env: reg.env.clone(),
        uid: reg.uid,
        gid: reg.gid,
        user: reg.user.clone(),
    }
}

/// A `Command` for the spec: empty environment plus the registered one, stdio to `/dev/null`,
/// and a `pre_exec` that detaches into a new session and drops root in the right order —
/// `setsid`, `setgid`, `initgroups` (supplementary groups of the user), `setuid`. Nothing runs
/// until the caller calls `spawn()`.
pub fn build_command(spec: &CommandSpec) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .env_clear()
        .envs(&spec.env)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let uid = spec.uid;
    let gid = spec.gid;
    let user = std::ffi::CString::new(spec.user.as_str()).unwrap_or_default();
    // SAFETY: the closure only calls async-signal-safe libc wrappers (setsid/setgid/initgroups/setuid)
    // and allocates nothing after fork.
    unsafe {
        cmd.pre_exec(move || {
            use nix::unistd::{initgroups, setgid, setsid, setuid, Gid, Uid};
            setsid().map_err(io_err)?;
            setgid(Gid::from_raw(gid)).map_err(io_err)?;
            initgroups(&user, Gid::from_raw(gid)).map_err(io_err)?;
            setuid(Uid::from_raw(uid)).map_err(io_err)?;
            Ok(())
        });
    }
    cmd
}

fn io_err(e: nix::Error) -> std::io::Error {
    std::io::Error::from_raw_os_error(e as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> Peer {
        Peer {
            uid: 1000,
            gid: 1000,
            pid: 4242,
        }
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn reg() -> Registration {
        validate_registration(
            RegisterRequest {
                exec: "/usr/bin/rpchat",
                args: &["--hidden".to_string()],
                cwd: "/home/alice",
                env: &env(&[("HOME", "/home/alice"), ("DISPLAY", ":0")]),
            },
            peer(),
            Some("alice"),
            Some(777),
            &|_| true,
        )
        .unwrap()
    }

    fn rules(allow_quit: bool, users: &[&str]) -> AppRules {
        AppRules {
            allow_quit,
            users: users.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn registration_validation() {
        let r = reg();
        assert_eq!(r.user, "alice");
        assert_eq!(r.uid, 1000);
        assert_eq!(r.proc_start, Some(777));
        assert_eq!(r.command_line(), "/usr/bin/rpchat --hidden");
        let ok = |exec: &str, args: Vec<&str>, cwd: &str, e: &[(&str, &str)]| {
            validate_registration(
                RegisterRequest {
                    exec,
                    args: &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                    cwd,
                    env: &env(e),
                },
                peer(),
                Some("alice"),
                None,
                &|p| p.to_str() != Some("/missing"),
            )
        };
        assert!(ok("/usr/bin/rpchat", vec![], "/", &[]).is_ok());
        assert!(ok("rpchat", vec![], "/", &[])
            .unwrap_err()
            .contains("absolute"));
        assert!(ok("/missing", vec![], "/", &[])
            .unwrap_err()
            .contains("executable"));
        assert!(ok("/x", vec![], "relative", &[])
            .unwrap_err()
            .contains("cwd"));
        assert!(ok("/x", vec![], "/", &[("LD_PRELOAD", "/evil.so")])
            .unwrap_err()
            .contains("LD_PRELOAD"));
        let long = "v".repeat(ENV_VALUE_MAX + 1);
        assert!(ok("/x", vec![], "/", &[("HOME", long.as_str())])
            .unwrap_err()
            .contains("4096"));
        let many: Vec<&str> = std::iter::repeat("a").take(ARGS_MAX + 1).collect();
        assert!(ok("/x", many, "/", &[]).unwrap_err().contains("32"));
        assert!(ok("/x\0y", vec![], "/", &[]).unwrap_err().contains("NUL"));
        for k in ENV_KEYS {
            assert!(ok("/x", vec![], "/", &[(k, "1")]).is_ok(), "{k} allowed");
        }
        let empty = env(&[]);
        let plain = RegisterRequest {
            exec: "/x",
            args: &[],
            cwd: "/",
            env: &empty,
        };
        let root = validate_registration(
            plain.clone(),
            Peer {
                uid: 0,
                gid: 0,
                pid: 1,
            },
            Some("root"),
            None,
            &|_| true,
        );
        assert!(root.unwrap_err().contains("root"));
        let nameless = validate_registration(plain, peer(), None, None, &|_| true);
        assert!(nameless.unwrap_err().contains("no user name"));
    }

    #[test]
    fn proc_stat_starttime() {
        let stat = "4242 (rpchat (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 30 0 123456 1000000 2000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        assert_eq!(parse_proc_stat_starttime(stat), Some(123_456));
        assert_eq!(parse_proc_stat_starttime("garbage"), None);
        assert_eq!(parse_proc_stat_starttime("1 (a) S 1"), None);
    }

    #[test]
    fn logind_session_files_and_loginctl_output() {
        let wayland = parse_session_file(
            "2",
            "# This is private data. Do not parse.\nUID=1000\nUSER=alice\nACTIVE=1\nIS_DISPLAY=1\nSTATE=active\nTYPE=wayland\nCLASS=user\nSEAT=seat0\nDESKTOP=Hyprland\n",
        );
        assert_eq!(
            wayland,
            SessionInfo {
                id: "2".into(),
                active: true,
                uid: Some(1000),
                user: Some("alice".into()),
                kind: "wayland".into(),
                seat: "seat0".into(),
            }
        );
        assert!(wayland.is_active_graphical());
        let tty = parse_session_file(
            "3",
            "UID=1000\nUSER=alice\nACTIVE=1\nTYPE=tty\nSEAT=seat0\n",
        );
        assert!(!tty.is_active_graphical(), "tty sessions do not count");
        let inactive =
            parse_session_file("4", "UID=1001\nUSER=bob\nACTIVE=0\nTYPE=x11\nSEAT=seat0\n");
        assert!(!inactive.is_active_graphical());
        let ssh = parse_session_file("5", "UID=1001\nUSER=bob\nACTIVE=1\nTYPE=tty\n");
        assert!(!ssh.is_active_graphical(), "no seat");
        let remote_x = parse_session_file("6", "UID=1002\nUSER=carol\nACTIVE=1\nTYPE=x11\n");
        assert!(
            !remote_x.is_active_graphical(),
            "seatless x11 (e.g. xrdp) does not count"
        );
        // Alternative spellings: USER=<uid> and NAME=, ACTIVE=yes, quoted values.
        let alt = parse_session_file(
            "7",
            "USER=1003\nNAME=\"dave\"\nACTIVE=yes\nTYPE=X11\nSEAT=seat1\n",
        );
        assert_eq!(alt.uid, Some(1003));
        assert_eq!(alt.user.as_deref(), Some("dave"));
        assert!(alt.is_active_graphical());
        assert_eq!(
            active_graphical_uids(&[wayland.clone(), tty, inactive, ssh, remote_x, alt, wayland]),
            vec![1000, 1003]
        );
        assert_eq!(active_graphical_uids(&[]), Vec::<u32>::new());

        let list =
            parse_loginctl_list("     2 1000 alice seat0 tty2\n     5 1001 bob   -     pts/0\n\n");
        assert_eq!(
            list,
            vec![
                ("2".to_string(), Some(1000), "alice".to_string()),
                ("5".to_string(), Some(1001), "bob".to_string())
            ]
        );
        assert!(parse_loginctl_list("No sessions.").is_empty());
        let show = parse_loginctl_show(
            "2",
            "Active=yes\nName=alice\nType=wayland\nSeat=seat0\nUser=1000\n",
        );
        assert_eq!(show.uid, Some(1000));
        assert_eq!(show.user.as_deref(), Some("alice"));
        assert!(show.is_active_graphical());
        let show_no = parse_loginctl_show("5", "Active=no\nName=bob\nType=tty\nSeat=\nUser=1001\n");
        assert!(!show_no.is_active_graphical());
    }

    #[test]
    fn gate_checks_policy_users_session_and_process_in_order() {
        let r = reg();
        assert_eq!(
            relaunch_gate(&rules(true, &["alice"]), &r, &[1000], None),
            Err(Skip::QuitAllowed)
        );
        assert_eq!(
            relaunch_gate(&rules(false, &[]), &r, &[1000], None),
            Err(Skip::NoUsersListed)
        );
        assert_eq!(
            relaunch_gate(&rules(false, &["bob"]), &r, &[1000], None),
            Err(Skip::UserNotListed("alice".into()))
        );
        assert_eq!(
            relaunch_gate(&rules(false, &["alice"]), &r, &[1001], None),
            Err(Skip::UserNotActive("alice".into()))
        );
        assert_eq!(
            relaunch_gate(&rules(false, &["alice"]), &r, &[], None),
            Err(Skip::UserNotActive("alice".into()))
        );
        assert_eq!(
            relaunch_gate(&rules(false, &["alice"]), &r, &[1000], Some(true)),
            Err(Skip::ProcessAlive(4242))
        );
        assert_eq!(
            relaunch_gate(
                &rules(false, &["bob", "alice"]),
                &r,
                &[1001, 1000],
                Some(false)
            ),
            Ok(())
        );
        assert_eq!(
            relaunch_gate(&rules(false, &["alice"]), &r, &[1000], None),
            Ok(())
        );
        assert_eq!(
            Skip::NoUsersListed.to_string(),
            "app.users is empty; nobody is relaunched"
        );
    }

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn backoff_ladder_for_rapid_deaths_and_reset_after_a_quiet_hour() {
        let t0 = Instant::now();
        let mut tr = RelaunchTracker::default();
        let mut now = t0;
        let mut delays = Vec::new();
        // The app dies right after every relaunch: 1.5 → 3 → 6 → 12 → 30 → 30.
        for _ in 0..6 {
            match tr.on_death(now) {
                Decision::Relaunch { delay, .. } => {
                    delays.push(delay.as_millis() as u64);
                    now += delay;
                    tr.on_relaunched(now);
                    now += secs(1);
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(delays, vec![1500, 3000, 6000, 12_000, 30_000, 30_000]);
        assert_eq!(tr.total(), 6);
        // A death more than 60 s after the relaunch starts the ladder over.
        now += secs(61);
        assert_eq!(
            tr.on_death(now),
            Decision::Relaunch {
                delay: Duration::from_millis(1500),
                attempt: 7
            }
        );
        now += secs(2);
        tr.on_relaunched(now);
        // Stayed up 5 minutes: counters reset, the next death is attempt 1 again.
        now += STABLE_UPTIME;
        assert_eq!(
            tr.on_death(now),
            Decision::Relaunch {
                delay: Duration::from_millis(1500),
                attempt: 1
            }
        );
    }

    #[test]
    fn gives_up_after_ten_relaunches_in_ten_minutes() {
        let mut tr = RelaunchTracker::default();
        let mut now = Instant::now();
        for i in 1..=GIVE_UP_COUNT {
            match tr.on_death(now) {
                Decision::Relaunch { attempt, .. } => assert_eq!(attempt, i),
                other => panic!("{other:?}"),
            }
            now += secs(40);
            tr.on_relaunched(now);
            now += secs(5);
        }
        assert_eq!(
            tr.on_death(now),
            Decision::GiveUp {
                relaunches_in_window: GIVE_UP_COUNT
            }
        );
        // The window slides: once the oldest relaunches are older than 10 minutes it tries again.
        now += GIVE_UP_WINDOW;
        assert!(matches!(tr.on_death(now), Decision::Relaunch { .. }));
    }

    #[test]
    fn manager_tracks_open_registrations_pending_relaunches_and_cancellation() {
        let mut k = Keepalive::default();
        let t0 = Instant::now();
        assert!(!k.registered());
        assert_eq!(k.register(1000, false), None);
        assert!(k.registered());
        assert_eq!(
            k.register(1000, true),
            None,
            "replacing does not double count"
        );
        k.forget(1000);
        assert!(!k.registered());
        assert_eq!(
            k.info(true),
            KeepaliveInfo {
                registered: false,
                relaunches: 0,
                allow_quit: true
            }
        );

        // Dropped: scheduled 1.5 s later; nothing due before that.
        let d = k.schedule(reg(), t0);
        assert_eq!(
            d,
            Decision::Relaunch {
                delay: Duration::from_millis(1500),
                attempt: 1
            }
        );
        assert!(k.pending_for(1000).is_some());
        assert!(k.due(t0 + Duration::from_millis(1499)).is_empty());
        // The app came back on its own (updater): a new registration cancels the pending relaunch.
        let cancelled = k.register(1000, false).expect("pending cancelled");
        assert_eq!(cancelled.registration.uid, 1000);
        assert!(k.due(t0 + secs(5)).is_empty());
        k.forget(1000);

        // Dropped again and not back: due after the delay, then relaunched.
        k.schedule(reg(), t0 + secs(10));
        let due = k.due(t0 + secs(12));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].attempt, 1);
        assert!(k.pending_for(1000).is_none(), "removed once due");
        k.relaunched(1000, t0 + secs(12));
        assert_eq!(k.info(false).relaunches, 1);
        assert!(!k.info(false).allow_quit);
        // A second uid is independent.
        let mut other = reg();
        other.uid = 1001;
        other.user = "bob".into();
        k.schedule(other, t0 + secs(12));
        assert!(k.pending_for(1001).is_some());
        assert!(k.pending_for(1000).is_none());
        assert!(k.warn_no_users_once());
        assert!(!k.warn_no_users_once());
    }

    #[test]
    fn command_spec_uses_registered_cwd_or_home_and_exactly_the_registered_env() {
        let r = reg();
        let spec = command_spec(&r, true);
        assert_eq!(spec.program, "/usr/bin/rpchat");
        assert_eq!(spec.args, vec!["--hidden"]);
        assert_eq!(spec.cwd, "/home/alice");
        assert_eq!(spec.env, r.env);
        assert_eq!(
            (spec.uid, spec.gid, spec.user.as_str()),
            (1000, 1000, "alice")
        );
        assert_eq!(command_spec(&r, false).cwd, "/home/alice", "HOME fallback");
        let mut no_home = r.clone();
        no_home.env.remove("HOME");
        assert_eq!(command_spec(&no_home, false).cwd, "/");
        // build_command does not run anything; it carries the spec verbatim.
        let cmd = build_command(&spec);
        assert_eq!(cmd.get_program(), "/usr/bin/rpchat");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), vec!["--hidden"]);
        assert_eq!(
            cmd.get_current_dir().map(|p| p.to_str()),
            Some(Some("/home/alice"))
        );
        let envs: BTreeMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_str().unwrap().to_string(),
                    v.map(|v| v.to_str().unwrap().to_string()),
                )
            })
            .collect();
        assert_eq!(envs.get("HOME"), Some(&Some("/home/alice".to_string())));
        assert_eq!(envs.get("DISPLAY"), Some(&Some(":0".to_string())));
        assert_eq!(
            envs.len(),
            2,
            "nothing from the daemon's environment: {envs:?}"
        );
    }
}
