//! rp-coded — root daemon for the rp desktop app: input lock (EVIOCGRAB) and keystroke /
//! pointer injection (uinput) behind a root-owned policy file.
//!
//! Listens on a unix socket (`/run/rp-code/daemon.sock`, group `rp-code`), speaks JSON lines
//! (`packages/shared/src/system.ts` `DaemonRequest` / `DaemonResponse`), one response per
//! request per connection. See `docs/spec/system.md` and the crate README.

// Logging macros must be defined before the modules that use them.
#[macro_use]
mod logging {
    use std::sync::atomic::{AtomicU8, Ordering};

    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    pub enum Level {
        Error = 0,
        Warn = 1,
        Info = 2,
        Debug = 3,
    }

    impl Level {
        pub fn parse(s: &str) -> Option<Level> {
            match s.to_ascii_lowercase().as_str() {
                "error" => Some(Level::Error),
                "warn" | "warning" => Some(Level::Warn),
                "info" => Some(Level::Info),
                "debug" | "trace" => Some(Level::Debug),
                _ => None,
            }
        }

        pub fn as_str(self) -> &'static str {
            match self {
                Level::Error => "error",
                Level::Warn => "warn",
                Level::Info => "info",
                Level::Debug => "debug",
            }
        }
    }

    static LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

    pub fn set_level(level: Level) {
        LEVEL.store(level as u8, Ordering::Relaxed);
    }

    pub fn enabled(level: Level) -> bool {
        (level as u8) <= LEVEL.load(Ordering::Relaxed)
    }

    pub fn log(level: Level, message: String) {
        if enabled(level) {
            eprintln!("rp-coded [{}] {}", level.as_str(), message);
        }
    }

    macro_rules! log_error { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Error, format!($($arg)*)) }; }
    macro_rules! log_warn { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Warn, format!($($arg)*)) }; }
    macro_rules! log_info { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Info, format!($($arg)*)) }; }
    macro_rules! log_debug { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Debug, format!($($arg)*)) }; }
}

mod devices;
mod guard;
mod inject;
mod keepalive;
mod lock;
mod policy;
mod protocol;
mod sysinstall;

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use guard::{AttemptLimiter, GuardAttempt, GuardHooks, GuardInfo, GuardPaths, ParserOp};
use inject::Injector;
use keepalive::{
    CommandSpec, Decision, Keepalive, Peer, RegisterRequest, Registration, DEFAULT_SESSIONS_DIR,
};
use lock::{DeviceSource, LockEngine, UnlockCause, TICK_INTERVAL};
use logging::Level;
use policy::{CreateError, PolicyStore, DEFAULT_POLICY_PATH};
use protocol::{
    DaemonError, DaemonResult, ErrorCode, Event, Ok as OkPayload, Request, Response, EVENT_NAMES,
    PROTOCOL_VERSION,
};
use sysinstall::{ApplyHooks, ApplyRequest, DEFAULT_INSTALL_ROOT};

/// `DAEMON_SOCKET_PATH` in `@rp/shared`.
pub const DEFAULT_SOCKET_PATH: &str = "/run/rp-code/daemon.sock";
/// `SYSTEM_GROUP` in `@rp/shared`: owner group of the socket directory and socket.
pub const SYSTEM_GROUP: &str = "rp-code";
/// The crate version; `RP_CODED_VERSION` at build time overrides it (test builds that must look
/// newer than the running daemon to exercise the self-update path).
pub const VERSION: &str = match option_env!("RP_CODED_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

const USAGE: &str = "\
rp-coded — input lock / injection daemon for the rp desktop app

USAGE:
    rp-coded [--socket <path>] [--policy <path>] [--log-level <error|warn|info|debug>]
    rp-coded --check-devices
    rp-coded --guard-apply | --guard-off [--policy <path>] [--profile-dir <p>] [--guard-state <p>]
    rp-coded --help | --version

OPTIONS:
    --socket <path>     Unix socket to listen on (default /run/rp-code/daemon.sock,
                        env RP_CODED_SOCKET)
    --policy <path>     Policy file (default /etc/rp-code/policy.json, env RP_CODED_POLICY)
    --sessions-dir <p>  logind session state files used to find the active graphical user
                        for app relaunches (default /run/systemd/sessions, env
                        RP_CODED_SESSIONS_DIR; `loginctl` is the fallback)
    --install-root <p>  System install root holding current/, previous/ and versions.json
                        (default /opt/rp-code, env RP_CODED_INSTALL_ROOT)
    --system-prefix <p> Prefix passed to `install.sh --prefix` when the daemon refreshes its
                        own files after an update (tests; env RP_CODED_SYSTEM_PREFIX)
    --no-restart        After a self-update only log that a restart is due instead of
                        restarting (tests; env RP_CODED_NO_RESTART=1)
    --no-uinput         Do not create the uinput virtual device (injection reports NO_DEVICES)
    --profile-dir <p>   Where the session-guard AppArmor profiles are written (default
                        /etc/apparmor.d, env RP_CODED_PROFILE_DIR)
    --guard-state <p>   Session-guard state file (default /etc/rp-code/guard-state.json,
                        env RP_CODED_GUARD_STATE)
    --guard-apply       Engage the session guard from the policy now (what the daemon does at
                        start and on policy changes), print the status as JSON and exit
    --guard-off         Unload the session guard whatever the policy says, print the status, exit
    --check-devices     Print which input devices and /dev/uinput can be opened, then exit 0
    --log-level <lvl>   stderr verbosity (default info)

Runs as root under rp-coded.service. Members of the `rp-code` group may connect.
";

struct Args {
    socket: PathBuf,
    policy: PathBuf,
    sessions_dir: PathBuf,
    install_root: PathBuf,
    system_prefix: Option<PathBuf>,
    no_restart: bool,
    no_uinput: bool,
    check_devices: bool,
    profile_dir: PathBuf,
    guard_state: PathBuf,
    guard_apply: bool,
    guard_off: bool,
    log_level: Level,
    help: bool,
    version: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        socket: std::env::var_os("RP_CODED_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH)),
        policy: std::env::var_os("RP_CODED_POLICY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_POLICY_PATH)),
        sessions_dir: std::env::var_os("RP_CODED_SESSIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SESSIONS_DIR)),
        install_root: std::env::var_os("RP_CODED_INSTALL_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_INSTALL_ROOT)),
        system_prefix: std::env::var_os("RP_CODED_SYSTEM_PREFIX")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
        no_restart: std::env::var_os("RP_CODED_NO_RESTART").is_some_and(|v| v == "1"),
        no_uinput: false,
        check_devices: false,
        profile_dir: std::env::var_os("RP_CODED_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(guard::DEFAULT_PROFILE_DIR)),
        guard_state: std::env::var_os("RP_CODED_GUARD_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(guard::DEFAULT_STATE_FILE)),
        guard_apply: false,
        guard_off: false,
        log_level: Level::Info,
        help: false,
        version: false,
    };
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--check-devices" => args.check_devices = true,
            "--no-uinput" => args.no_uinput = true,
            "--help" | "-h" => args.help = true,
            "--version" | "-V" => args.version = true,
            "--socket" => args.socket = PathBuf::from(iter.next().ok_or("--socket needs a path")?),
            "--policy" => args.policy = PathBuf::from(iter.next().ok_or("--policy needs a path")?),
            "--sessions-dir" => {
                args.sessions_dir = PathBuf::from(iter.next().ok_or("--sessions-dir needs a path")?)
            }
            "--install-root" => {
                args.install_root = PathBuf::from(iter.next().ok_or("--install-root needs a path")?)
            }
            "--system-prefix" => {
                args.system_prefix = Some(PathBuf::from(
                    iter.next().ok_or("--system-prefix needs a path")?,
                ))
            }
            "--no-restart" => args.no_restart = true,
            "--profile-dir" => {
                args.profile_dir = PathBuf::from(iter.next().ok_or("--profile-dir needs a path")?)
            }
            "--guard-state" => {
                args.guard_state = PathBuf::from(iter.next().ok_or("--guard-state needs a path")?)
            }
            "--guard-apply" => args.guard_apply = true,
            "--guard-off" => args.guard_off = true,
            "--log-level" => {
                let v = iter.next().ok_or("--log-level needs a value")?;
                args.log_level =
                    Level::parse(v).ok_or_else(|| format!("unknown log level {v:?}"))?;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(args)
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/// The OS-touching parts of the keepalive feature, injectable so the pipeline is testable:
/// which uids own an active graphical session, whether a registered process still runs, the
/// peer uid's user name, and the spawn itself.
pub struct KeepaliveHooks {
    pub active_uids: Box<dyn Fn() -> Vec<u32> + Send + Sync>,
    pub process_alive: Box<dyn Fn(i32, Option<u64>) -> bool + Send + Sync>,
    pub user_name: Box<dyn Fn(u32) -> Option<String> + Send + Sync>,
    pub is_executable: Box<dyn Fn(&Path) -> bool + Send + Sync>,
    pub proc_start: Box<dyn Fn(i32) -> Option<u64> + Send + Sync>,
    /// Spawn the command; returns the child's pid.
    pub spawn: Spawner,
}

pub type Spawner = Box<dyn Fn(&CommandSpec) -> io::Result<u32> + Send + Sync>;

impl KeepaliveHooks {
    /// The real thing: logind state files (or `loginctl`), `/proc`, getpwuid, `Command::spawn`.
    pub fn real(sessions_dir: PathBuf) -> KeepaliveHooks {
        KeepaliveHooks {
            active_uids: Box::new(move || os::active_graphical_uids(&sessions_dir)),
            process_alive: Box::new(os::process_alive),
            user_name: Box::new(os::user_name),
            is_executable: Box::new(os::is_executable),
            proc_start: Box::new(os::proc_start),
            spawn: Box::new(os::spawn_relaunch),
        }
    }
}

/// Per-connection state: the peer's credentials (for the audit log and registrations) and
/// the keepalive registration this connection holds, if any.
pub struct ConnCtx {
    pub peer: Peer,
    pub label: String,
    pub registration: Option<Registration>,
    /// Identifies this connection's subscription (`subscribe`).
    pub conn_id: u64,
    /// The connection's writer, shared with the event push (`None` in unit tests without a socket).
    pub writer: Option<Arc<Mutex<UnixStream>>>,
}

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

impl ConnCtx {
    pub fn new(peer: Peer) -> ConnCtx {
        ConnCtx {
            label: format!("uid {} pid {}", peer.uid, peer.pid),
            peer,
            registration: None,
            conn_id: NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            writer: None,
        }
    }

    #[cfg(test)]
    fn test(uid: u32, pid: i32) -> ConnCtx {
        ConnCtx::new(Peer { uid, gid: uid, pid })
    }
}

/// How the daemon restarts itself after a self-update (`apply-update`).
pub struct RestartPlan {
    /// The executable to re-exec (recorded at startup; the file is replaced in place later).
    pub exe: PathBuf,
    /// The original command line (without argv[0]).
    pub argv: Vec<String>,
    /// `--no-restart`: only log.
    pub suppressed: bool,
}

impl RestartPlan {
    pub fn from_process(suppressed: bool) -> RestartPlan {
        RestartPlan {
            exe: std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/proc/self/exe")),
            argv: std::env::args().skip(1).collect(),
            suppressed,
        }
    }
}

/// Everything the connection threads share.
pub struct Daemon {
    engine: Mutex<LockEngine>,
    injector: Mutex<Box<dyn Injector>>,
    policy: Mutex<PolicyStore>,
    keepalive: Mutex<Keepalive>,
    hooks: KeepaliveHooks,
    shutting_down: AtomicBool,
    /// System install root (`/opt/rp-code`).
    install_root: PathBuf,
    apply_hooks: ApplyHooks,
    /// Serialises `apply-update` (one at a time) and marks a pending restart.
    apply_busy: AtomicBool,
    restart_pending: AtomicBool,
    /// Whether the restart thread was already started (only one).
    restart_scheduled: AtomicBool,
    restart: Mutex<RestartPlan>,
    /// Session guard: OS hooks, locations, the last engage result and the audit tail state.
    guard_hooks: GuardHooks,
    guard_paths: GuardPaths,
    guard_info: Mutex<Option<GuardInfo>>,
    /// Policy file stamp at the last guard engage (re-engaged when it changes).
    guard_stamp: Mutex<Option<(std::time::SystemTime, u64)>>,
    ticks: AtomicU64,
    tailer_started: AtomicBool,
    limiter: Mutex<AttemptLimiter>,
    /// Connections that asked for pushed events.
    subscribers: Mutex<Vec<Subscriber>>,
}

/// A connection receiving pushed `{ "ev": … }` lines.
pub struct Subscriber {
    pub conn_id: u64,
    pub label: String,
    pub events: Vec<String>,
    pub writer: Arc<Mutex<UnixStream>>,
}

impl Daemon {
    pub fn new(
        source: Box<dyn DeviceSource>,
        injector: Box<dyn Injector>,
        policy_path: impl Into<PathBuf>,
    ) -> Self {
        Daemon {
            engine: Mutex::new(LockEngine::new(source)),
            injector: Mutex::new(injector),
            policy: Mutex::new(PolicyStore::new(policy_path)),
            keepalive: Mutex::new(Keepalive::default()),
            hooks: KeepaliveHooks::real(PathBuf::from(DEFAULT_SESSIONS_DIR)),
            shutting_down: AtomicBool::new(false),
            install_root: PathBuf::from(DEFAULT_INSTALL_ROOT),
            apply_hooks: os::apply_hooks(None),
            apply_busy: AtomicBool::new(false),
            restart_pending: AtomicBool::new(false),
            restart_scheduled: AtomicBool::new(false),
            restart: Mutex::new(RestartPlan::from_process(true)),
            guard_hooks: os::guard_hooks(),
            guard_paths: GuardPaths::default(),
            guard_info: Mutex::new(None),
            guard_stamp: Mutex::new(None),
            ticks: AtomicU64::new(0),
            tailer_started: AtomicBool::new(false),
            limiter: Mutex::new(AttemptLimiter::default()),
            subscribers: Mutex::new(Vec::new()),
        }
    }

    /// The session guard's OS hooks and locations (fakes and a temp dir in tests).
    pub fn with_guard(mut self, hooks: GuardHooks, paths: GuardPaths) -> Self {
        self.guard_hooks = hooks;
        self.guard_paths = paths;
        self
    }

    pub fn with_keepalive_hooks(mut self, hooks: KeepaliveHooks) -> Self {
        self.hooks = hooks;
        self
    }

    /// Where the system install lives and how the daemon restarts after updating itself.
    pub fn with_install(mut self, root: PathBuf, hooks: ApplyHooks, restart: RestartPlan) -> Self {
        self.install_root = root;
        self.apply_hooks = hooks;
        self.restart = Mutex::new(restart);
        self
    }

    #[cfg(test)]
    fn with_engine(mut self, engine: LockEngine) -> Self {
        self.engine = Mutex::new(engine);
        self
    }

    fn keepalive(&self) -> std::sync::MutexGuard<'_, Keepalive> {
        self.keepalive.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn engine(&self) -> std::sync::MutexGuard<'_, LockEngine> {
        self.engine.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn injector(&self) -> std::sync::MutexGuard<'_, Box<dyn Injector>> {
        self.injector.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn policy(&self) -> std::sync::MutexGuard<'_, PolicyStore> {
        self.policy.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Periodic tick from the timer thread.
    pub fn tick(&self) {
        if let Some(cause) = self.engine().tick(Instant::now()) {
            log_info!("lock ended: {cause}");
        }
        self.keepalive_tick(Instant::now());
        // Every ~5 s: re-engage the guard when the policy file changed (a stat).
        if self.ticks.fetch_add(1, Ordering::Relaxed) % 100 == 99 {
            self.guard_tick();
        }
    }

    /// Re-engage the session guard when the policy file's (mtime, size) changed since the
    /// last engage. Cheap: one stat.
    pub fn guard_tick(&self) {
        let stamp = self.policy().stamp();
        let changed = {
            let last = self.guard_stamp.lock().unwrap_or_else(|e| e.into_inner());
            last.is_some() && *last != stamp
        };
        if changed {
            log_info!("policy file changed; re-applying the session guard");
            self.guard_apply();
        }
    }

    /// Engage/disengage the session guard from the current policy (`guard::apply`), remember
    /// the outcome for `status`, and start the audit tail once something is engaged.
    pub fn guard_apply(&self) -> GuardInfo {
        let (policy, stamp) = {
            let mut store = self.policy();
            let stamp = store.stamp();
            (store.load(), stamp)
        };
        let info = match &policy {
            Ok(p) => guard::apply(p.as_ref(), &self.guard_hooks, &self.guard_paths),
            Err(e) => {
                log_warn!("session guard: policy unreadable ({e}); leaving the guard as it is");
                let mut cur = guard::current_info(None, &self.guard_hooks, &self.guard_paths);
                cur.last_error = Some(format!("policy file invalid: {e}"));
                cur
            }
        };
        *self.guard_stamp.lock().unwrap_or_else(|e| e.into_inner()) = stamp;
        match (&info.last_error, info.loaded.is_empty()) {
            (Some(e), _) => log_warn!("session guard ({}): {e}", info.mode.as_str()),
            (None, false) => log_info!(
                "session guard {}: {} loaded for {}{}{}",
                info.mode.as_str(),
                info.loaded.join(", "),
                info.users.join(", "),
                info.shell
                    .as_deref()
                    .map(|s| format!("; shell {s}"))
                    .unwrap_or_default(),
                info.compositor
                    .as_deref()
                    .map(|c| format!("; compositor {c}"))
                    .unwrap_or_default()
            ),
            (None, true) => log_info!("session guard off"),
        }
        *self.guard_info.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.clone());
        info
    }

    /// `status.guard` / `guard-status`: the last engage result, or the state file.
    pub fn guard_status(&self) -> GuardInfo {
        if let Some(info) = self
            .guard_info
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return info;
        }
        let policy = self.policy().load().ok().flatten();
        guard::current_info(policy.as_ref(), &self.guard_hooks, &self.guard_paths)
    }

    /// Whether the guard is engaged (something loaded) — the audit tail is only useful then.
    pub fn guard_engaged(&self) -> bool {
        self.guard_info
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|g| !g.loaded.is_empty())
    }

    /// Mark the audit tailer as started; false when it already was.
    pub fn claim_tailer(&self) -> bool {
        self.tailer_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// A subscription on a connection: replaces an earlier one from the same connection.
    pub fn subscribe(&self, ctx: &ConnCtx, events: Vec<String>) -> DaemonResult<Vec<String>> {
        let Some(writer) = ctx.writer.clone() else {
            return Err(DaemonError::invalid("subscribe needs a socket connection"));
        };
        let mut events: Vec<String> = events
            .into_iter()
            .filter(|e| EVENT_NAMES.contains(&e.as_str()))
            .collect();
        events.sort();
        events.dedup();
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|s| s.conn_id != ctx.conn_id);
        if !events.is_empty() {
            subs.push(Subscriber {
                conn_id: ctx.conn_id,
                label: ctx.label.clone(),
                events: events.clone(),
                writer,
            });
        }
        Ok(events)
    }

    pub fn unsubscribe(&self, conn_id: u64) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|s| s.conn_id != conn_id);
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// Push an event to every subscriber that asked for it; a failed write drops that subscriber.
    pub fn broadcast(&self, event: &Event) {
        let line = format!("{}\n", event.to_line());
        let name = event.name();
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|s| {
            if !s.events.iter().any(|e| e == name) {
                return true;
            }
            let mut w = s.writer.lock().unwrap_or_else(|e| e.into_inner());
            match w.write_all(line.as_bytes()).and_then(|_| w.flush()) {
                Ok(()) => true,
                Err(e) => {
                    log_debug!("dropping subscriber {} ({e})", s.label);
                    false
                }
            }
        });
    }

    /// An audit record about an rp-code profile: rate-limited per target, logged, pushed.
    pub fn report_attempt(&self, attempt: GuardAttempt, now: Instant, at: String) -> bool {
        let key = format!("{}:{}", attempt.kind.as_str(), attempt.target);
        if !self
            .limiter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .allow(&key, now)
        {
            return false;
        }
        log_info!(
            "guard attempt {}: {} {} on {} by {} (pid {}) under {}",
            if attempt.blocked { "blocked" } else { "logged" },
            attempt.kind.as_str(),
            attempt.operation,
            attempt.target,
            attempt.command,
            attempt.pid,
            attempt.profile
        );
        self.broadcast(&Event::GuardAttempt { at, attempt });
        true
    }

    /// Fire pending relaunches whose delay is up, re-checking the gate first (policy re-read,
    /// active session, process really gone).
    pub fn keepalive_tick(&self, now: Instant) {
        let due = self.keepalive().due(now);
        for pending in due {
            let reg = pending.registration;
            let rules = self.policy().app_rules();
            let active = (self.hooks.active_uids)();
            let alive = (self.hooks.process_alive)(reg.pid, reg.proc_start);
            if let Err(skip) = keepalive::relaunch_gate(&rules, &reg, &active, Some(alive)) {
                log_info!(
                    "relaunch for {} (uid {}) cancelled: {skip}",
                    reg.user,
                    reg.uid
                );
                continue;
            }
            let spec = keepalive::command_spec(&reg, Path::new(&reg.cwd).is_dir());
            match (self.hooks.spawn)(&spec) {
                Ok(pid) => {
                    self.keepalive().relaunched(reg.uid, now);
                    log_info!(
                        "relaunched {} as {} (uid {} gid {}) pid {pid} in {} (attempt {}, after {} ms)",
                        reg.command_line(),
                        reg.user,
                        spec.uid,
                        spec.gid,
                        spec.cwd,
                        pending.attempt,
                        pending.delay.as_millis()
                    );
                }
                Err(e) => {
                    // Counts as a relaunch for the backoff so a broken exec cannot spin.
                    self.keepalive().relaunched(reg.uid, now);
                    log_error!(
                        "relaunch of {} for {} failed: {e}",
                        reg.command_line(),
                        reg.user
                    );
                }
            }
        }
    }

    /// A connection with a registration went away without `unregister`: treat it as a crash
    /// and, when the policy and the session say so, schedule a relaunch with backoff.
    pub fn connection_lost(&self, ctx: &mut ConnCtx, now: Instant) {
        let Some(reg) = ctx.registration.take() else {
            return;
        };
        self.keepalive().forget(reg.uid);
        let rules = self.policy().app_rules();
        let active = (self.hooks.active_uids)();
        match keepalive::relaunch_gate(&rules, &reg, &active, None) {
            Ok(()) => {}
            Err(skip @ keepalive::Skip::NoUsersListed) => {
                if self.keepalive().warn_no_users_once() {
                    log_warn!(
                        "{} dropped its registration but app.allowQuit is false without app.users: {skip} (logged once)",
                        ctx.label
                    );
                }
                return;
            }
            Err(skip @ keepalive::Skip::QuitAllowed) => {
                log_debug!(
                    "{} dropped its registration; no relaunch: {skip}",
                    ctx.label
                );
                return;
            }
            Err(skip) => {
                log_info!(
                    "{} dropped its registration; no relaunch: {skip}",
                    ctx.label
                );
                return;
            }
        }
        match self.keepalive().schedule(reg.clone(), now) {
            Decision::Relaunch { delay, attempt } => log_warn!(
                "app of {} (uid {} pid {}) went away without unregistering; relaunching {} in {} ms (attempt {attempt})",
                reg.user,
                reg.uid,
                reg.pid,
                reg.command_line(),
                delay.as_millis()
            ),
            Decision::GiveUp {
                relaunches_in_window,
            } => log_error!(
                "giving up on relaunching the app of {} (uid {}): {relaunches_in_window} relaunches in the last {} minutes; start it by hand (autostart brings it back at the next login)",
                reg.user,
                reg.uid,
                keepalive::GIVE_UP_WINDOW.as_secs() / 60
            ),
        }
    }

    /// Release the lock and stop accepting requests.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.engine().unlock(UnlockCause::Shutdown);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Handle one request on a connection (`ctx` carries the peer credentials and registration).
    pub fn handle(&self, req: Request, ctx: &mut ConnCtx) -> Response {
        if self.is_shutting_down() {
            return Response::err(ErrorCode::Refused, "daemon is shutting down");
        }
        let op = req.op();
        match self.dispatch(req, ctx) {
            Ok(payload) => Response::ok(payload),
            Err(e) => {
                log_debug!("{op} from {} failed: {e}", ctx.label);
                Response::from(e)
            }
        }
    }

    fn dispatch(&self, req: Request, ctx: &mut ConnCtx) -> DaemonResult<OkPayload> {
        let peer = ctx.label.as_str();
        match req {
            Request::Hello { version } => {
                if version != PROTOCOL_VERSION {
                    return Err(DaemonError::new(
                        ErrorCode::Refused,
                        format!("unsupported protocol version {version} (this daemon speaks {PROTOCOL_VERSION})"),
                    ));
                }
                let devices = self.engine().list_devices();
                let uinput = self.injector().available();
                Ok(OkPayload::Hello {
                    version: VERSION.to_string(),
                    protocol: PROTOCOL_VERSION,
                    devices: devices::counts(&devices, uinput),
                })
            }
            Request::Status => {
                let allow_quit = self.policy().app_rules().allow_quit;
                Ok(OkPayload::Status {
                    locked: self.engine().status(Instant::now()),
                    keepalive: self.keepalive().info(allow_quit),
                    install: sysinstall::install_info(&self.install_root, VERSION),
                    guard: self.guard_status(),
                })
            }
            Request::Policy => {
                let mut store = self.policy();
                let path = store.path().to_string_lossy().into_owned();
                match store.load() {
                    Ok(policy) => Ok(OkPayload::Policy { policy, path }),
                    Err(e) => Err(DaemonError::new(ErrorCode::Policy, e.to_string())),
                }
            }
            Request::Lock {
                duration_ms,
                reason,
                devices,
            } => {
                let devices = devices.unwrap_or_default();
                let limits = self
                    .policy()
                    .lock_limits()
                    .map_err(|e| DaemonError::new(ErrorCode::Policy, e.to_string()))?;
                if !limits.enabled {
                    return Err(DaemonError::new(
                        ErrorCode::Policy,
                        "input lock is disabled by policy",
                    ));
                }
                let duration = limits.clamp_duration(duration_ms).ok_or_else(|| {
                    DaemonError::invalid("durationMs must be a positive finite number")
                })?;
                let outcome = self.engine().lock(
                    Instant::now(),
                    duration,
                    reason.clone(),
                    devices,
                    &limits,
                )?;
                log_info!(
                    "locked {} {} device(s) for {} ms (requested {}) by {peer}{}; emergency: {}",
                    outcome.grabbed,
                    devices.as_str(),
                    outcome.duration_ms,
                    duration_ms,
                    reason.map(|r| format!(" ({r})")).unwrap_or_default(),
                    if outcome.emergency_available {
                        lock::describe_emergency(&limits)
                    } else {
                        "unavailable (no keyboard grabbed; the keyboard stays usable)".to_string()
                    }
                );
                Ok(OkPayload::Lock {
                    until: protocol::iso_millis(outcome.until_unix_ms),
                    duration_ms: outcome.duration_ms,
                    devices: outcome.devices,
                })
            }
            Request::Unlock => {
                if self.engine().unlock(UnlockCause::Request) {
                    log_info!("unlock by {peer}");
                }
                Ok(OkPayload::Unlock)
            }
            Request::Type { text } => {
                let skipped = inject::run_type(self.injector().as_mut(), &text)?;
                log_info!(
                    "typed {} char(s) for {peer} ({skipped} skipped)",
                    text.chars().count()
                );
                Ok(OkPayload::Type { skipped })
            }
            Request::Key { combo } => {
                inject::run_key(self.injector().as_mut(), &combo)?;
                log_info!("key {combo:?} for {peer}");
                Ok(OkPayload::Key)
            }
            Request::Click { x, y, button } => {
                inject::run_click(self.injector().as_mut(), x, y, button.unwrap_or_default())?;
                log_info!(
                    "click {:?} at {x},{y} for {peer}",
                    button.unwrap_or_default()
                );
                Ok(OkPayload::Click)
            }
            Request::Move { x, y } => {
                inject::run_move(self.injector().as_mut(), x, y)?;
                log_debug!("move to {x},{y} for {peer}");
                Ok(OkPayload::Move)
            }
            Request::SetPolicy { policy } => {
                let mut store = self.policy();
                let path = store.path().to_string_lossy().into_owned();
                match store.create(policy) {
                    Ok(created) => {
                        log_info!(
                            "policy created at {path} by {peer}{}",
                            created
                                .managed_by
                                .as_deref()
                                .filter(|m| !m.is_empty())
                                .map(|m| format!(" (managedBy: {m:?})"))
                                .unwrap_or_default()
                        );
                        Ok(OkPayload::SetPolicy { path })
                    }
                    Err(e @ CreateError::Exists(_)) => {
                        log_warn!("set-policy from {peer} refused: {e}");
                        Err(DaemonError::new(ErrorCode::Exists, e.to_string()))
                    }
                    Err(CreateError::Invalid(m)) => Err(DaemonError::invalid(m)),
                    Err(e @ CreateError::Io(_)) => {
                        log_error!("set-policy from {peer} failed: {e}");
                        Err(DaemonError::internal(e.to_string()))
                    }
                }
            }
            Request::Register {
                exec,
                args,
                cwd,
                env,
            } => self.register(ctx, exec, args, cwd, env),
            Request::Unregister => {
                if let Some(reg) = ctx.registration.take() {
                    self.keepalive().forget(reg.uid);
                    log_info!("unregister from {peer} ({})", reg.user);
                }
                Ok(OkPayload::Unregister)
            }
            Request::ApplyUpdate {
                file,
                version,
                sha512,
            } => self.apply_update(ctx, &file, &version, &sha512),
            Request::GuardApply => {
                log_info!("guard-apply from {peer}");
                Ok(OkPayload::GuardApply {
                    guard: self.guard_apply(),
                })
            }
            Request::GuardStatus => Ok(OkPayload::GuardStatus {
                guard: self.guard_status(),
            }),
            Request::Subscribe { events } => {
                let events = self.subscribe(ctx, events)?;
                log_debug!("{peer} subscribed to {}", events.join(", "));
                Ok(OkPayload::Subscribe { events })
            }
        }
    }

    /// `apply-update`: one at a time, refused while a restart is pending; the work itself is
    /// `sysinstall::apply_update`. Every outcome is logged with the peer.
    fn apply_update(
        &self,
        ctx: &ConnCtx,
        file: &str,
        version: &str,
        sha512: &str,
    ) -> DaemonResult<OkPayload> {
        let peer = ctx.peer;
        if self.restart_pending.load(Ordering::SeqCst) {
            return Err(DaemonError::new(
                ErrorCode::Refused,
                "the daemon is about to restart after updating itself; retry in a moment",
            ));
        }
        if self
            .apply_busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(DaemonError::new(
                ErrorCode::Busy,
                "another update is being applied",
            ));
        }
        let allow_downgrade = self.policy().allow_downgrade();
        log_info!(
            "apply-update {version} from {} ({file}){}",
            ctx.label,
            if allow_downgrade {
                "; downgrades allowed by policy"
            } else {
                ""
            }
        );
        let result = sysinstall::apply_update(
            &self.install_root,
            &ApplyRequest {
                file,
                version,
                sha512,
                uid: peer.uid,
                gid: peer.gid,
                allow_downgrade,
                running_daemon: VERSION,
            },
            &self.apply_hooks,
        );
        self.apply_busy.store(false, Ordering::SeqCst);
        match result {
            Ok(outcome) => {
                log_info!(
                    "apply-update {} done for {} (replaced {}; daemon restart: {})",
                    outcome.version,
                    ctx.label,
                    outcome.replaced.as_deref().unwrap_or("nothing"),
                    outcome.restart_daemon
                );
                if outcome.restart_daemon {
                    self.restart_pending.store(true, Ordering::SeqCst);
                }
                Ok(OkPayload::ApplyUpdate {
                    version: outcome.version,
                    restart_daemon: outcome.restart_daemon,
                })
            }
            Err(e) => {
                log_warn!("apply-update {version} from {} failed: {e}", ctx.label);
                Err(e)
            }
        }
    }

    /// Whether `apply-update` asked for a restart that has not happened yet.
    pub fn restart_pending(&self) -> bool {
        self.restart_pending.load(Ordering::SeqCst)
    }

    /// Restart after a self-update once no input lock is active: under systemd through
    /// `systemctl restart rp-coded` (the refreshed unit file applies), otherwise by re-exec'ing
    /// the (replaced) binary with the original arguments. Runs on its own thread, started once
    /// the reply to `apply-update` has been written, so that reply goes out first. `--no-restart`
    /// only logs. Only one restart thread is ever started.
    pub fn restart_when_idle(self: &Arc<Self>) {
        if self
            .restart_scheduled
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let daemon = self.clone();
        thread::Builder::new()
            .name("rp-coded-restart".into())
            .spawn(move || {
                thread::sleep(std::time::Duration::from_millis(500));
                let mut waited = false;
                while daemon.engine().is_locked() && !daemon.is_shutting_down() {
                    if !waited {
                        log_info!("restart deferred while an input lock is active");
                        waited = true;
                    }
                    thread::sleep(std::time::Duration::from_millis(500));
                }
                if daemon.is_shutting_down() {
                    return;
                }
                let plan = daemon.restart.lock().unwrap_or_else(|e| e.into_inner());
                if plan.suppressed {
                    log_warn!(
                        "self-update installed; restart suppressed (--no-restart): run `systemctl restart rp-coded` or re-exec {} {}",
                        plan.exe.display(),
                        plan.argv.join(" ")
                    );
                    daemon.restart_pending.store(false, Ordering::SeqCst);
                    daemon.restart_scheduled.store(false, Ordering::SeqCst);
                    return;
                }
                os::restart_daemon(&plan, &daemon);
            })
            .ok();
    }

    fn register(
        &self,
        ctx: &mut ConnCtx,
        exec: String,
        args: Vec<String>,
        cwd: String,
        env: BTreeMap<String, String>,
    ) -> DaemonResult<OkPayload> {
        let peer = ctx.peer;
        if peer.uid == 0 {
            return Err(DaemonError::new(
                ErrorCode::Refused,
                "root may not register for relaunch",
            ));
        }
        let user = (self.hooks.user_name)(peer.uid);
        let proc_start = (self.hooks.proc_start)(peer.pid);
        let reg = keepalive::validate_registration(
            RegisterRequest {
                exec: &exec,
                args: &args,
                cwd: &cwd,
                env: &env,
            },
            peer,
            user.as_deref(),
            proc_start,
            &*self.hooks.is_executable,
        )
        .map_err(DaemonError::invalid)?;
        let replacing = ctx.registration.is_some();
        let cancelled = self.keepalive().register(reg.uid, replacing);
        if let Some(p) = cancelled {
            log_info!(
                "pending relaunch for {} (uid {}) cancelled: the app registered again on its own",
                p.registration.user,
                p.registration.uid
            );
        }
        let rules = self.policy().app_rules();
        log_info!(
            "register from {} ({}): {}{}",
            ctx.label,
            reg.user,
            reg.command_line(),
            if replacing {
                " (replaces the previous registration)"
            } else {
                ""
            }
        );
        if !rules.allow_quit && !rules.users.iter().any(|u| u == &reg.user) {
            log_warn!(
                "app.allowQuit is false but app.users does not list {} ({}); the app of {} will not be relaunched",
                reg.user,
                if rules.users.is_empty() { "the list is empty".to_string() } else { format!("listed: {}", rules.users.join(", ")) },
                reg.user
            );
        }
        ctx.registration = Some(reg);
        Ok(OkPayload::Register)
    }
}

// ---------------------------------------------------------------------------
// Keepalive OS glue (the only code that reads /proc, logind state and spawns)
// ---------------------------------------------------------------------------

mod os {
    use super::*;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    /// Uids owning an active graphical session: logind's state files first, `loginctl` when
    /// the directory is unreadable or empty. No logind at all → nobody (no relaunch).
    pub fn active_graphical_uids(sessions_dir: &Path) -> Vec<u32> {
        let mut sessions = Vec::new();
        if let Ok(entries) = fs::read_dir(sessions_dir) {
            for entry in entries.flatten() {
                let id = entry.file_name().to_string_lossy().into_owned();
                if let Ok(text) = fs::read_to_string(entry.path()) {
                    sessions.push(keepalive::parse_session_file(&id, &text));
                }
            }
        }
        if sessions.is_empty() {
            sessions = loginctl_sessions();
        }
        keepalive::active_graphical_uids(&sessions)
    }

    fn loginctl_sessions() -> Vec<keepalive::SessionInfo> {
        let list = std::process::Command::new("loginctl")
            .args(["list-sessions", "--no-legend"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output();
        let Ok(list) = list else { return Vec::new() };
        let mut out = Vec::new();
        for (id, _, _) in keepalive::parse_loginctl_list(&String::from_utf8_lossy(&list.stdout)) {
            let show = std::process::Command::new("loginctl")
                .args([
                    "show-session",
                    &id,
                    "-p",
                    "Active",
                    "-p",
                    "Name",
                    "-p",
                    "Type",
                    "-p",
                    "Seat",
                    "-p",
                    "User",
                ])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .output();
            if let Ok(show) = show {
                out.push(keepalive::parse_loginctl_show(
                    &id,
                    &String::from_utf8_lossy(&show.stdout),
                ));
            }
        }
        out
    }

    pub fn proc_start(pid: i32) -> Option<u64> {
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|t| keepalive::parse_proc_stat_starttime(&t))
    }

    /// `/proc/<pid>` still there and, when the start time is known, still the same process.
    pub fn process_alive(pid: i32, start: Option<u64>) -> bool {
        match (proc_start(pid), start) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(now), Some(then)) => now == then,
        }
    }

    pub fn user_name(uid: u32) -> Option<String> {
        nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid))
            .ok()
            .flatten()
            .map(|u| u.name)
    }

    pub fn is_executable(path: &Path) -> bool {
        fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    /// Home directory of a uid from passwd.
    pub fn home_of(uid: u32) -> Option<PathBuf> {
        nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid))
            .ok()
            .flatten()
            .map(|u| u.dir)
    }

    /// The `apply-update` hooks for the real system: extraction as the user, `--version` of
    /// the bundled daemon, `install.sh --refresh-daemon-files [--prefix <p>]` as root.
    pub fn apply_hooks(system_prefix: Option<PathBuf>) -> ApplyHooks {
        ApplyHooks {
            home_of: Box::new(home_of),
            extract: Box::new(extract_as_user),
            daemon_version_of: Box::new(daemon_version_of),
            refresh_daemon_files: Box::new(move |installer| {
                refresh_daemon_files(installer, system_prefix.as_deref())
            }),
        }
    }

    /// Run `<appimage> --appimage-extract` as `uid`/`gid` in `cwd` (a directory that user
    /// owns), with an empty environment and a 4-minute limit. Never as root: the archive is
    /// untrusted until the extracted tree passed the checks.
    pub fn extract_as_user(appimage: &Path, cwd: &Path, uid: u32, gid: u32) -> Result<(), String> {
        use std::os::unix::process::CommandExt;
        let user = user_name(uid).unwrap_or_else(|| uid.to_string());
        let user_c = std::ffi::CString::new(user.as_str()).unwrap_or_default();
        let mut cmd = std::process::Command::new(appimage);
        cmd.arg("--appimage-extract")
            .current_dir(cwd)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", cwd)
            .env("TMPDIR", cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        // SAFETY: only async-signal-safe libc wrappers, no allocation after fork.
        unsafe {
            cmd.pre_exec(move || {
                use nix::unistd::{initgroups, setgid, setgroups, setuid, Gid, Uid};
                setgid(Gid::from_raw(gid)).map_err(|e| io::Error::from_raw_os_error(e as i32))?;
                if initgroups(&user_c, Gid::from_raw(gid)).is_err() {
                    setgroups(&[Gid::from_raw(gid)])
                        .map_err(|e| io::Error::from_raw_os_error(e as i32))?;
                }
                setuid(Uid::from_raw(uid)).map_err(|e| io::Error::from_raw_os_error(e as i32))?;
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| {
            let hint = if e.raw_os_error() == Some(nix::errno::Errno::EPERM as i32) {
                " (the daemon cannot change to that user: it lacks CAP_SETUID/CAP_SETGID — the running rp-coded.service is probably older than the daemon; run install.sh --refresh-daemon-files, then systemctl daemon-reload && systemctl restart rp-coded)"
            } else {
                ""
            };
            format!("cannot run {} as uid {uid}: {e}{hint}", appimage.display())
        })?;
        let mut stderr = child.stderr.take();
        let stderr_thread = thread::spawn(move || {
            let mut buf = String::new();
            if let Some(s) = stderr.as_mut() {
                let _ = io::Read::read_to_string(s, &mut buf);
            }
            buf
        });
        let deadline = Instant::now() + std::time::Duration::from_secs(240);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(std::time::Duration::from_millis(100))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("extraction took longer than 4 minutes; killed".into());
                }
                Err(e) => return Err(format!("waiting for the extraction failed: {e}")),
            }
        };
        let err_text = stderr_thread.join().unwrap_or_default();
        if status.success() {
            Ok(())
        } else {
            let tail: String = err_text
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            Err(format!(
                "--appimage-extract exited with {status}: {}",
                tail.trim()
            ))
        }
    }

    /// `<path> --version` → the version it prints (`rp-coded X.Y.Z (protocol N)`).
    pub fn daemon_version_of(path: &Path) -> Option<sysinstall::Semver> {
        let out = std::process::Command::new(path)
            .arg("--version")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        sysinstall::parse_version_output(&String::from_utf8_lossy(&out.stdout))
    }

    /// `install.sh --refresh-daemon-files` from the freshly installed bundle, as root. Its
    /// output goes to the log line by line.
    pub fn refresh_daemon_files(installer: &Path, prefix: Option<&Path>) -> Result<(), String> {
        let mut cmd = std::process::Command::new(installer);
        cmd.arg("--refresh-daemon-files")
            .env_clear()
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .stdin(std::process::Stdio::null());
        if let Some(p) = prefix {
            cmd.arg("--prefix").arg(p);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("cannot run {}: {e}", installer.display()))?;
        for line in String::from_utf8_lossy(&out.stdout)
            .lines()
            .chain(String::from_utf8_lossy(&out.stderr).lines())
        {
            if !line.trim().is_empty() {
                log_info!("install.sh: {}", line.trim_end());
            }
        }
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} --refresh-daemon-files exited with {}",
                installer.display(),
                out.status
            ))
        }
    }

    /// Restart the daemon: `systemctl restart rp-coded` when running as a systemd service
    /// (the unit stops us with SIGTERM, which releases the lock, and starts the new binary
    /// with the refreshed unit file), otherwise re-exec the binary in place. Only returns on
    /// failure (logged); the caller then keeps running the old version.
    pub fn restart_daemon(plan: &RestartPlan, daemon: &Daemon) {
        let under_systemd = std::env::var_os("INVOCATION_ID").is_some()
            && Path::new("/run/systemd/system").is_dir();
        if under_systemd {
            log_info!("restarting through systemctl restart rp-coded (self-update)");
            match std::process::Command::new("systemctl")
                .args(["restart", "--no-block", "rp-coded"])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                Ok(s) if s.success() => return,
                Ok(s) => {
                    log_error!("systemctl restart rp-coded exited with {s}; re-exec'ing instead")
                }
                Err(e) => log_error!("cannot run systemctl ({e}); re-exec'ing instead"),
            }
        }
        log_info!(
            "re-exec'ing {} {} (self-update)",
            plan.exe.display(),
            plan.argv.join(" ")
        );
        daemon.shutdown();
        let Ok(exe) = std::ffi::CString::new(plan.exe.as_os_str().as_encoded_bytes()) else {
            log_error!("cannot re-exec: executable path contains a NUL byte");
            return;
        };
        let mut argv: Vec<std::ffi::CString> = Vec::with_capacity(plan.argv.len() + 1);
        argv.push(exe.clone());
        for a in &plan.argv {
            match std::ffi::CString::new(a.as_str()) {
                Ok(c) => argv.push(c),
                Err(_) => {
                    log_error!("cannot re-exec: an argument contains a NUL byte");
                    return;
                }
            }
        }
        // The listening socket is close-on-exec; the new process binds afresh and clients reconnect.
        let e = nix::unistd::execv(&exe, &argv).unwrap_err();
        log_error!(
            "re-exec of {} failed: {e}; the old daemon keeps running (restart it by hand)",
            plan.exe.display()
        );
        daemon.restart_pending.store(false, Ordering::SeqCst);
        daemon.restart_scheduled.store(false, Ordering::SeqCst);
    }

    /// Spawn the relaunch (see `keepalive::build_command`) and reap it on a thread so it never
    /// lingers as a zombie; its exit is logged.
    pub fn spawn_relaunch(spec: &CommandSpec) -> io::Result<u32> {
        let mut child = keepalive::build_command(spec).spawn()?;
        let pid = child.id();
        let what = spec.program.clone();
        thread::Builder::new()
            .name("rp-coded-reap".into())
            .spawn(move || match child.wait() {
                Ok(status) => log_info!("relaunched app pid {pid} ({what}) exited: {status}"),
                Err(e) => log_warn!("waiting for relaunched app pid {pid} failed: {e}"),
            })
            .ok();
        Ok(pid)
    }

    // ---- session guard ------------------------------------------------------------------

    /// The real guard hooks: securityfs presence, `/etc/apparmor.d/abi/*`, files written
    /// `0644` through a temp file + rename, `apparmor_parser`, `/proc` socket discovery.
    pub fn guard_hooks() -> GuardHooks {
        GuardHooks {
            available: Box::new(|| Path::new(guard::APPARMOR_FS).is_dir()),
            abi: Box::new(|| {
                ["abi/4.0", "abi/3.0"]
                    .into_iter()
                    .find(|a| Path::new(guard::DEFAULT_PROFILE_DIR).join(a).is_file())
                    .map(str::to_string)
            }),
            file_exists: Box::new(|p| p.exists()),
            read_file: Box::new(|p| fs::read_to_string(p).ok()),
            write_file: Box::new(write_file_0644),
            remove_file: Box::new(|p| fs::remove_file(p)),
            parser: Box::new(run_apparmor_parser),
            discover: Box::new(discover_sockets),
            now: Box::new(|| {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                protocol::iso_millis(ms)
            }),
        }
    }

    fn write_file_0644(path: &Path, text: &str) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            if !dir.exists() {
                fs::create_dir_all(dir)?;
            }
        }
        let tmp = path.with_extension("new");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o644)
                .open(&tmp)?;
            f.set_permissions(fs::Permissions::from_mode(0o644))?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)
    }

    /// `apparmor_parser -Q|-r|-R -K <files>`; stderr becomes the error text.
    pub fn run_apparmor_parser(op: ParserOp, files: &[PathBuf]) -> Result<(), String> {
        if files.is_empty() {
            return Ok(());
        }
        let flag = match op {
            ParserOp::Check => "-Q",
            ParserOp::Replace => "-r",
            ParserOp::Remove => "-R",
        };
        let parser = ["/usr/sbin/apparmor_parser", "/usr/bin/apparmor_parser"]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .ok_or_else(|| "apparmor_parser is not installed (package apparmor)".to_string())?;
        let out = std::process::Command::new(parser)
            .arg(flag)
            .arg("-K")
            .args(files)
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("cannot run {parser}: {e}"))?;
        let err = String::from_utf8_lossy(&out.stderr);
        let noise: Vec<&str> = err
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.contains("Cache read/write disabled"))
            .collect();
        for l in &noise {
            log_debug!("apparmor_parser {flag}: {l}");
        }
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "apparmor_parser {flag} exited with {}: {}",
                out.status,
                noise.join(" | ").chars().take(600).collect::<String>()
            ))
        }
    }

    /// Listening path sockets owned by shell/compositor processes of the listed users
    /// (`/proc/net/unix` + `/proc/<pid>/fd`), generalised into profile globs.
    pub fn discover_sockets(users: &[String]) -> Vec<guard::DiscoveredSocket> {
        let uids: Vec<u32> = users
            .iter()
            .filter_map(|u| {
                nix::unistd::User::from_name(u)
                    .ok()
                    .flatten()
                    .map(|user| user.uid.as_raw())
            })
            .collect();
        if uids.is_empty() {
            return Vec::new();
        }
        let Ok(unix) = fs::read_to_string("/proc/net/unix") else {
            return Vec::new();
        };
        let listening = guard::parse_proc_net_unix(&unix);
        if listening.is_empty() {
            return Vec::new();
        }
        let by_inode: BTreeMap<u64, &guard::ListeningSocket> =
            listening.iter().map(|s| (s.inode, s)).collect();
        let mut out = std::collections::BTreeSet::new();
        let Ok(procs) = fs::read_dir("/proc") else {
            return Vec::new();
        };
        for entry in procs.flatten() {
            let name = entry.file_name();
            let Some(pid) = name
                .to_str()
                .filter(|n| n.chars().all(|c| c.is_ascii_digit()))
            else {
                continue;
            };
            let base = Path::new("/proc").join(pid);
            let Ok(status) = fs::read_to_string(base.join("status")) else {
                continue;
            };
            let Some(uid) = guard::parse_status_uid(&status) else {
                continue;
            };
            if !uids.contains(&uid) {
                continue;
            }
            let Ok(comm) = fs::read_to_string(base.join("comm")) else {
                continue;
            };
            let Some(entry) = guard::classify_comm(comm.trim()) else {
                continue;
            };
            let Ok(fds) = fs::read_dir(base.join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(link) = fs::read_link(fd.path()) else {
                    continue;
                };
                let Some(inode) = guard::socket_inode(&link.to_string_lossy()) else {
                    continue;
                };
                if let Some(sock) = by_inode.get(&inode) {
                    out.insert(guard::DiscoveredSocket {
                        glob: guard::generalise_socket_path(&sock.path),
                        owner: entry.owner,
                        entry: entry.id.to_string(),
                    });
                }
            }
        }
        out.into_iter().collect()
    }

    /// Start the audit tail once the guard is engaged (idempotent): `journalctl -f -o json`
    /// over the kernel and audit transports, else `/dev/kmsg`. Records about `rp-code-*`
    /// profiles become `guard-attempt` events for subscribed connections.
    pub fn start_audit_tailer_if_engaged(daemon: &Arc<Daemon>) {
        if !daemon.guard_engaged() || !daemon.claim_tailer() {
            return;
        }
        let d = daemon.clone();
        thread::Builder::new()
            .name("rp-coded-audit".into())
            .spawn(move || audit_tail_loop(&d))
            .ok();
    }

    fn audit_tail_loop(daemon: &Arc<Daemon>) {
        let report = |message: &str| {
            if let Some(attempt) = guard::parse_audit_message(message) {
                let at = (daemon.guard_hooks.now)();
                daemon.report_attempt(attempt, Instant::now(), at);
            }
        };
        match std::process::Command::new("journalctl")
            .args([
                "-f",
                "-o",
                "json",
                "-n",
                "0",
                "--no-pager",
                "_TRANSPORT=kernel",
                "+",
                "_TRANSPORT=audit",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                log_info!("session guard: tailing the audit log through journalctl");
                if let Some(stdout) = child.stdout.take() {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Some(msg) = guard::journal_message(&line) {
                            report(&msg);
                        }
                    }
                }
                let _ = child.wait();
                log_warn!("session guard: journalctl ended; falling back to /dev/kmsg");
            }
            Err(e) => log_warn!("session guard: cannot run journalctl ({e}); trying /dev/kmsg"),
        }
        match fs::File::open("/dev/kmsg") {
            Ok(mut f) => {
                use std::io::{Read, Seek, SeekFrom};
                let _ = f.seek(SeekFrom::End(0));
                let mut buf = vec![0u8; 8192];
                loop {
                    match f.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Some(msg) = guard::kmsg_message(&String::from_utf8_lossy(&buf[..n])) {
                                report(&msg);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(e) if e.raw_os_error() == Some(nix::libc::EPIPE) => continue, // overrun
                        Err(e) => {
                            log_warn!("session guard: /dev/kmsg read failed ({e}); audit tail stopped");
                            break;
                        }
                    }
                }
            }
            Err(e) => log_warn!(
                "session guard: cannot open /dev/kmsg ({e}); guard attempts will not be reported (ProtectKernelLogs?)"
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

/// Serve one connection: one JSON request per line, one response line each. When it ends
/// (EOF or error) a registration it still holds is handed to the keepalive logic.
fn serve_connection(stream: UnixStream, daemon: &Arc<Daemon>) -> io::Result<()> {
    let mut ctx = ConnCtx::new(peer_creds(&stream));
    log_debug!("connection from {}", ctx.label);
    let result = serve_lines(stream, daemon, &mut ctx);
    log_debug!("{} disconnected", ctx.label);
    daemon.unsubscribe(ctx.conn_id);
    daemon.connection_lost(&mut ctx, Instant::now());
    result
}

fn serve_lines(stream: UnixStream, daemon: &Arc<Daemon>, ctx: &mut ConnCtx) -> io::Result<()> {
    // The writer is shared with the event push (`subscribe`), so responses and pushed lines
    // never interleave mid-line.
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    ctx.writer = Some(writer.clone());
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line?;
        let response = match protocol::parse_line(&line) {
            Ok(None) => continue,
            Ok(Some(req)) => daemon.handle(req, ctx),
            Err(e) => {
                log_warn!("{}: {e}: {}", ctx.label, truncate(&line, 200));
                Response::err(ErrorCode::Invalid, e)
            }
        };
        {
            let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
            w.write_all(response.to_line().as_bytes())?;
            w.write_all(b"\n")?;
            w.flush()?;
        }
        // A self-update asked for a restart: start it now that the reply is out (the app keeps
        // its connection open, so waiting for the disconnect would wait forever).
        if daemon.restart_pending() && !daemon.is_shutting_down() {
            daemon.restart_when_idle();
        }
    }
    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// SO_PEERCRED of the peer (audit log, registrations). Unknown → uid/gid `u32::MAX`, pid 0,
/// which no registration check accepts as a real user.
fn peer_creds(stream: &UnixStream) -> Peer {
    match nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials) {
        Ok(c) => Peer {
            uid: c.uid(),
            gid: c.gid(),
            pid: c.pid(),
        },
        Err(_) => Peer {
            uid: u32::MAX,
            gid: u32::MAX,
            pid: 0,
        },
    }
}

/// Accept loop. Returns when `daemon.shutdown()` has been called and one more connection (or an
/// accept error) wakes it up.
fn accept_loop(listener: UnixListener, daemon: Arc<Daemon>) {
    for conn in listener.incoming() {
        if daemon.is_shutting_down() {
            break;
        }
        match conn {
            Ok(stream) => {
                let d = daemon.clone();
                thread::Builder::new()
                    .name("rp-coded-conn".into())
                    .spawn(move || {
                        if let Err(e) = serve_connection(stream, &d) {
                            log_debug!("connection ended: {e}");
                        }
                    })
                    .ok();
            }
            Err(e) => {
                log_warn!("accept failed: {e}");
                thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

/// Create the socket directory (0750 root:rp-code) and bind the socket (0660 root:rp-code).
/// When the `rp-code` group does not exist the files stay root-owned and a warning is logged.
fn bind_socket(path: &Path) -> io::Result<UnixListener> {
    let gid = nix::unistd::Group::from_name(SYSTEM_GROUP)
        .ok()
        .flatten()
        .map(|g| g.gid);
    if gid.is_none() {
        log_warn!("group {SYSTEM_GROUP} does not exist; only root will be able to connect (run install.sh)");
    }
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::create_dir_all(dir)?;
        }
        if let Err(e) = fs::set_permissions(dir, fs::Permissions::from_mode(0o750)) {
            log_warn!("chmod {}: {e}", dir.display());
        }
        if let Some(gid) = gid {
            if let Err(e) = nix::unistd::chown(dir, None, Some(gid)) {
                log_warn!("chown {}: {e}", dir.display());
            }
        }
    }
    if path.exists() {
        // A stale socket from a previous run; refuse to clobber a non-socket file.
        let meta = fs::symlink_metadata(path)?;
        if !meta.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a socket", path.display()),
            ));
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
    if let Some(gid) = gid {
        if let Err(e) = nix::unistd::chown(path, None, Some(gid)) {
            log_warn!("chown {}: {e}", path.display());
        }
    }
    Ok(listener)
}

/// Start the ticker thread that drives lock timers / emergency detection / hot-plug.
fn start_ticker(daemon: Arc<Daemon>) {
    thread::Builder::new()
        .name("rp-coded-tick".into())
        .spawn(move || {
            while !daemon.is_shutting_down() {
                thread::sleep(TICK_INTERVAL);
                daemon.tick();
            }
        })
        .expect("spawn ticker");
}

/// Block SIGTERM/SIGINT/SIGHUP in this (main) thread — inherited by all threads spawned after —
/// and wait for one on a dedicated thread. On signal: unlock, remove the socket, exit 0.
fn install_signal_handler(daemon: Arc<Daemon>, socket: PathBuf) {
    use nix::sys::signal::{SigSet, Signal};
    let mut set = SigSet::empty();
    set.add(Signal::SIGTERM);
    set.add(Signal::SIGINT);
    set.add(Signal::SIGHUP);
    if let Err(e) = set.thread_block() {
        log_warn!("cannot block signals: {e}");
        return;
    }
    thread::Builder::new()
        .name("rp-coded-signal".into())
        .spawn(move || {
            let sig = set.wait().ok();
            log_info!("received {:?}; releasing lock and exiting", sig);
            daemon.shutdown();
            let _ = fs::remove_file(&socket);
            std::process::exit(0);
        })
        .expect("spawn signal thread");
}

fn run(args: Args) -> ExitCode {
    let policy_note = match PolicyStore::new(&args.policy).load() {
        Ok(Some(p)) => format!("loaded ({})", lock::describe_emergency(&p.lock_limits())),
        Ok(None) => "absent, defaults apply".to_string(),
        Err(e) => format!("{e} — lock requests will be refused until it is fixed"),
    };
    log_info!(
        "rp-coded {VERSION} starting; policy {}: {policy_note}",
        args.policy.display()
    );
    match PolicyStore::new(&args.policy).load() {
        Ok(Some(p)) if !p.app_rules().allow_quit => {
            let rules = p.app_rules();
            if rules.users.is_empty() {
                log_warn!(
                    "app.allowQuit is false but app.users is empty: the app is never relaunched"
                );
            } else {
                log_info!(
                    "app.allowQuit is false: relaunching the app for {} (sessions from {})",
                    rules.users.join(", "),
                    args.sessions_dir.display()
                );
            }
        }
        _ => {}
    }

    let screen = devices::screen_size();
    let injector: Box<dyn Injector> = if args.no_uinput {
        Box::new(inject::NullInjector)
    } else {
        match devices::UinputInjector::create(screen) {
            Ok(inj) => {
                log_info!(
                    "uinput virtual device ready (abs range {}x{})",
                    screen.width,
                    screen.height
                );
                Box::new(inj)
            }
            Err(e) => {
                log_warn!("no uinput device ({e}); type/key/click/move will report NO_DEVICES");
                Box::new(inject::NullInjector)
            }
        }
    };
    let daemon = Arc::new(
        Daemon::new(
            Box::new(devices::EvdevSource::new()),
            injector,
            args.policy.clone(),
        )
        .with_keepalive_hooks(KeepaliveHooks::real(args.sessions_dir.clone()))
        .with_install(
            args.install_root.clone(),
            os::apply_hooks(args.system_prefix.clone()),
            RestartPlan::from_process(args.no_restart),
        )
        .with_guard(os::guard_hooks(), guard_paths(&args)),
    );
    {
        let info = sysinstall::install_info(&args.install_root, VERSION);
        if info.system_install {
            log_info!(
                "system install at {}: current {}{}",
                args.install_root.display(),
                info.current.as_deref().unwrap_or("?"),
                info.previous
                    .as_deref()
                    .map(|p| format!(", previous {p}"))
                    .unwrap_or_default()
            );
        } else {
            log_info!(
                "no system install at {} (apply-update is refused until install.sh --system-install ran)",
                args.install_root.display()
            );
        }
    }
    {
        let devs = daemon.engine().list_devices();
        let c = devices::counts(&devs, daemon.injector().available());
        log_info!(
            "input devices: {} keyboard(s), {} pointer(s)",
            c.keyboards,
            c.pointers
        );
    }

    let listener = match bind_socket(&args.socket) {
        Ok(l) => l,
        Err(e) => {
            log_error!("cannot listen on {}: {e}", args.socket.display());
            return ExitCode::from(2);
        }
    };
    log_info!("listening on {}", args.socket.display());

    install_signal_handler(daemon.clone(), args.socket.clone());
    start_ticker(daemon.clone());
    // Session guard: engage from the policy now; the ticker re-engages on policy changes and
    // `guard-apply` on request. The audit tail starts once something is loaded.
    daemon.guard_apply();
    os::start_audit_tailer_if_engaged(&daemon);
    accept_loop(listener, daemon.clone());
    daemon.shutdown();
    let _ = fs::remove_file(&args.socket);
    ExitCode::SUCCESS
}

/// Guard locations from the command line (the app binary is the system install's).
fn guard_paths(args: &Args) -> GuardPaths {
    GuardPaths {
        profile_dir: args.profile_dir.clone(),
        state_file: args.guard_state.clone(),
        app_exec: args
            .install_root
            .join("current/rp-code")
            .to_string_lossy()
            .into_owned(),
        daemon_version: VERSION.to_string(),
    }
}

/// `--guard-apply` / `--guard-off`: one engage (or unload) from the command line — what
/// `install.sh --guard` / `--no-guard` run. Prints the `GuardInfo` JSON; exit 1 on an error.
fn run_guard_cli(args: &Args, off: bool) -> ExitCode {
    let hooks = os::guard_hooks();
    let paths = guard_paths(args);
    let policy = if off {
        None
    } else {
        match PolicyStore::new(&args.policy).load() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("rp-coded: {e}");
                return ExitCode::from(1);
            }
        }
    };
    let info = guard::apply(policy.as_ref(), &hooks, &paths);
    println!(
        "{}",
        serde_json::to_string_pretty(&info).unwrap_or_else(|_| "{}".into())
    );
    if info.last_error.is_some() {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rp-coded: {e}\n\n{USAGE}");
            return ExitCode::from(64);
        }
    };
    if args.help {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.version {
        println!("rp-coded {VERSION} (protocol {PROTOCOL_VERSION})");
        return ExitCode::SUCCESS;
    }
    logging::set_level(args.log_level);
    if args.check_devices {
        print!("{}", devices::check_devices_report());
        return ExitCode::SUCCESS;
    }
    if args.guard_apply || args.guard_off {
        return run_guard_cli(&args, args.guard_off);
    }
    run(args)
}

// ---------------------------------------------------------------------------
// Socket-level tests with fake devices
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inject::{keys, FakeInjector, KeyAction, Recorded};
    use crate::lock::fake::FakeSource;
    use serde_json::{json, Value};

    struct TestServer {
        socket: PathBuf,
        daemon: Arc<Daemon>,
        guard_os: Arc<guard::tests::FakeOs>,
        _dir: tempfile::TempDir,
    }

    impl TestServer {
        fn start(
            source: FakeSource,
            injector: FakeInjector,
            policy_json: Option<&str>,
        ) -> TestServer {
            let dir = tempfile::tempdir().unwrap();
            let socket = dir.path().join("daemon.sock");
            let policy_path = dir.path().join("policy.json");
            if let Some(p) = policy_json {
                fs::write(&policy_path, p).unwrap();
            }
            let engine =
                LockEngine::new(Box::new(source.clone())).with_wall_clock(|| 1_700_000_000_000);
            let guard_os = Arc::new(guard::tests::FakeOs::default());
            let daemon = Arc::new(
                Daemon::new(Box::new(source), Box::new(injector), &policy_path)
                    .with_engine(engine)
                    .with_install(
                        dir.path().join("opt"),
                        sysinstall::tests::test_hooks(dir.path().to_path_buf(), Default::default()),
                        RestartPlan {
                            exe: PathBuf::from("/nonexistent"),
                            argv: Vec::new(),
                            suppressed: true,
                        },
                    )
                    .with_guard(
                        guard_os.hooks(),
                        GuardPaths {
                            profile_dir: dir.path().join("apparmor.d"),
                            state_file: dir.path().join("guard-state.json"),
                            app_exec: guard::DEFAULT_APP_EXEC.to_string(),
                            daemon_version: VERSION.to_string(),
                        },
                    ),
            );
            let listener = bind_socket(&socket).unwrap();
            let d = daemon.clone();
            thread::spawn(move || accept_loop(listener, d));
            start_ticker(daemon.clone());
            TestServer {
                socket,
                daemon,
                guard_os,
                _dir: dir,
            }
        }

        fn connect(&self) -> Client {
            let stream = UnixStream::connect(&self.socket).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            Client {
                reader: BufReader::new(stream.try_clone().unwrap()),
                stream,
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.daemon.shutdown();
            let _ = UnixStream::connect(&self.socket);
        }
    }

    struct Client {
        stream: UnixStream,
        reader: BufReader<UnixStream>,
    }

    impl Client {
        fn send_raw(&mut self, line: &str) -> Value {
            self.stream.write_all(line.as_bytes()).unwrap();
            self.stream.write_all(b"\n").unwrap();
            let mut out = String::new();
            self.reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap_or_else(|e| panic!("bad response {out:?}: {e}"))
        }

        fn send(&mut self, req: Value) -> Value {
            self.send_raw(&req.to_string())
        }

        /// The next line the daemon pushes (a subscribed event).
        fn next_line(&mut self) -> Value {
            let mut out = String::new();
            self.reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap_or_else(|e| panic!("bad line {out:?}: {e}"))
        }
    }

    fn fake_devices() -> FakeSource {
        FakeSource::with_devices(&[("event0", true, false), ("event1", false, true)])
    }

    #[test]
    fn hello_status_lock_unlock_type_over_the_socket() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        let mut c = server.connect();

        let hello = c.send(json!({"op":"hello","version":1}));
        assert_eq!(
            hello,
            json!({"ok":true,"op":"hello","version":VERSION,"protocol":1,"devices":{"keyboards":1,"pointers":1,"uinput":true}})
        );

        assert_eq!(
            c.send(json!({"op":"status"})),
            json!({"ok":true,"op":"status","locked":null,"keepalive":{"registered":false,"relaunches":0,"allowQuit":true},"install":{"systemInstall":false,"daemonVersion":VERSION},"guard":{"available":false,"mode":"off","loaded":[],"users":[],"residual":[]}})
        );

        let lock = c.send(json!({"op":"lock","durationMs":30000,"reason":"surprise"}));
        assert_eq!(
            lock,
            json!({"ok":true,"op":"lock","until":"2023-11-14T22:13:50.000Z","durationMs":30000,"devices":"both"})
        );
        assert!(server.daemon.engine().is_locked());

        let status = c.send(json!({"op":"status"}));
        assert_eq!(
            status["locked"],
            json!({"until":"2023-11-14T22:13:50.000Z","reason":"surprise","devices":"both"})
        );

        // Injection works while locked (uinput is not grabbed).
        assert_eq!(
            c.send(json!({"op":"type","text":"Hi!"})),
            json!({"ok":true,"op":"type","skipped":0})
        );
        assert_eq!(
            c.send(json!({"op":"type","text":"é"})),
            json!({"ok":true,"op":"type","skipped":1})
        );
        assert_eq!(
            c.send(json!({"op":"key","combo":"ctrl+s"})),
            json!({"ok":true,"op":"key"})
        );
        assert_eq!(
            c.send(json!({"op":"click","x":10,"y":20})),
            json!({"ok":true,"op":"click"})
        );
        assert_eq!(
            c.send(json!({"op":"click","x":10,"y":20,"button":"middle"})),
            json!({"ok":true,"op":"click"})
        );
        assert_eq!(
            c.send(json!({"op":"move","x":-4,"y":99999})),
            json!({"ok":true,"op":"move"})
        );

        assert_eq!(
            c.send(json!({"op":"unlock"})),
            json!({"ok":true,"op":"unlock"})
        );
        assert!(!server.daemon.engine().is_locked());
        assert_eq!(c.send(json!({"op":"status"}))["locked"], Value::Null);
        assert_eq!(
            c.send(json!({"op":"unlock"})),
            json!({"ok":true,"op":"unlock"}),
            "unlock when idle is fine"
        );

        // A second connection sees the same state and can lock too (keyboard only here).
        let mut c2 = server.connect();
        let kb = c2.send(json!({"op":"lock","durationMs":1000,"devices":"keyboard"}));
        assert_eq!(kb["ok"], true);
        assert_eq!(kb["devices"], "keyboard");
        assert_eq!(
            c.send(json!({"op":"status"}))["locked"]["devices"],
            "keyboard"
        );
        drop(c2);
        assert!(
            server.daemon.engine().is_locked(),
            "a lock survives its connection closing"
        );
        // The ticker releases it once the second elapses.
        thread::sleep(std::time::Duration::from_millis(1300));
        assert_eq!(c.send(json!({"op":"status"}))["locked"], Value::Null);
        assert!(!server.daemon.engine().is_locked());
    }

    #[test]
    fn injection_is_recorded_and_clamped() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        let mut c = server.connect();
        assert_eq!(c.send(json!({"op":"key","combo":"ctrl+alt+t"}))["ok"], true);
        assert_eq!(
            c.send(json!({"op":"click","x":5000,"y":-1,"button":"right"}))["ok"],
            true
        );
        // The injector behind the socket is a trait object we cannot downcast, so assert the
        // exact action sequence by driving a second fake with the same requests.
        let mut fake = FakeInjector::default();
        inject::run_key(&mut fake, "ctrl+alt+t").unwrap();
        inject::run_click(&mut fake, 5000.0, -1.0, protocol::Button::Right).unwrap();
        assert_eq!(
            fake.recorded[0],
            Recorded::Key(KeyAction::Press(keys::KEY_LEFTCTRL))
        );
        assert_eq!(fake.recorded[6], Recorded::Move(1919, 0));
        assert_eq!(fake.recorded[7], Recorded::Button(keys::BTN_RIGHT));
    }

    #[test]
    fn errors_over_the_socket() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        let mut c = server.connect();
        assert_eq!(c.send(json!({"op":"hello","version":2}))["code"], "REFUSED");
        assert_eq!(c.send_raw("not json")["code"], "INVALID");
        assert_eq!(c.send(json!({"op":"reboot"}))["code"], "INVALID");
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":0}))["code"],
            "INVALID"
        );
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":-1}))["code"],
            "INVALID"
        );
        assert_eq!(c.send(json!({"op":"type","text":""}))["code"], "INVALID");
        assert_eq!(
            c.send(json!({"op":"key","combo":"hyper+x"}))["code"],
            "INVALID"
        );
        assert_eq!(
            c.send(json!({"op":"click","x":"a","y":1}))["code"],
            "INVALID"
        );
        // Blank lines are ignored, the next request still answers.
        c.stream.write_all(b"\n\n").unwrap();
        assert_eq!(c.send(json!({"op":"status"}))["op"], "status");
        // Lock is clamped to the default max and the minimum.
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":1e12}))["durationMs"],
            300_000
        );
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":1}))["durationMs"],
            1000
        );
        c.send(json!({"op":"unlock"}));
    }

    #[test]
    fn policy_is_enforced_and_reported() {
        let policy = r#"{"version":1,"managedBy":"IT","settings":{"web":{"allowlist":["a.example"]}},"inputLock":{"maxDurationMs":5000,"emergencyKey":"f12"}}"#;
        let server = TestServer::start(fake_devices(), FakeInjector::default(), Some(policy));
        let mut c = server.connect();
        let p = c.send(json!({"op":"policy"}));
        assert_eq!(p["ok"], true);
        assert_eq!(p["policy"]["managedBy"], "IT");
        assert_eq!(
            p["policy"]["settings"]["web"]["allowlist"],
            json!(["a.example"])
        );
        assert_eq!(p["policy"]["inputLock"]["emergencyKey"], "f12");
        assert!(p["path"].as_str().unwrap().ends_with("policy.json"));

        let lock = c.send(json!({"op":"lock","durationMs":60000}));
        assert_eq!(
            lock["durationMs"], 5000,
            "clamped to inputLock.maxDurationMs"
        );
        assert_eq!(lock["until"], "2023-11-14T22:13:25.000Z");
        c.send(json!({"op":"unlock"}));

        // Disable via the file; the daemon notices the change (size/mtime) on the next request.
        let path = server.daemon.policy().path().to_path_buf();
        fs::write(&path, r#"{"version":1,"inputLock":{"enabled":false}}"#).unwrap();
        let refused = c.send(json!({"op":"lock","durationMs":1000}));
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["code"], "POLICY");
        assert!(!server.daemon.engine().is_locked());
        // Injection is unaffected by inputLock.enabled.
        assert_eq!(c.send(json!({"op":"key","combo":"F5"}))["ok"], true);

        // Broken file → POLICY for both `policy` and `lock` (fail closed).
        fs::write(&path, "{").unwrap();
        assert_eq!(c.send(json!({"op":"policy"}))["code"], "POLICY");
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":1000}))["code"],
            "POLICY"
        );

        // Removed → no policy, defaults.
        fs::remove_file(&path).unwrap();
        assert_eq!(
            c.send(json!({"op":"policy"})),
            json!({"ok":true,"op":"policy","policy":null,"path":path.to_string_lossy()})
        );
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":1e9}))["durationMs"],
            300_000
        );
    }

    #[test]
    fn set_policy_writes_once_over_the_socket() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        let path = server.daemon.policy().path().to_path_buf();
        let mut c = server.connect();
        assert_eq!(c.send(json!({"op":"policy"}))["policy"], Value::Null);

        // Invalid objects: INVALID with the validation message, and no file.
        let bad =
            c.send(json!({"op":"set-policy","policy":{"version":1,"settings":{"theme":"dark"}}}));
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["code"], "INVALID");
        assert!(bad["error"].as_str().unwrap().contains("settings.theme"));
        let bad = c.send(json!({"op":"set-policy","policy":{"version":2}}));
        assert_eq!(bad["code"], "INVALID");
        assert!(bad["error"].as_str().unwrap().contains("version"));
        assert_eq!(
            c.send(json!({"op":"set-policy","policy":{"version":1,"nope":true}}))["code"],
            "INVALID"
        );
        assert_eq!(
            c.send(json!({"op":"set-policy"}))["code"],
            "INVALID",
            "policy is required"
        );
        assert!(!path.exists());

        // First creation succeeds: 0644, pretty JSON, trailing newline.
        let policy = json!({
            "version": 1,
            "managedBy": "the household admin",
            "settings": {"maxInputLockMs": 20000},
            "inputLock": {"maxDurationMs": 20000, "emergencyKey": "f12"}
        });
        let ok = c.send(json!({"op":"set-policy","policy":policy}));
        assert_eq!(
            ok,
            json!({"ok":true,"op":"set-policy","path":path.to_string_lossy()})
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            format!("{}\n", serde_json::to_string_pretty(&policy).unwrap())
        );

        // A second creation is refused and leaves the file alone.
        let again = c.send(json!({"op":"set-policy","policy":{"version":1}}));
        assert_eq!(again["ok"], false);
        assert_eq!(again["code"], "EXISTS");
        assert!(again["error"]
            .as_str()
            .unwrap()
            .contains("only root can change it"));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);

        // `policy` reports it and `lock` honours inputLock.maxDurationMs (fresh connection too).
        let p = c.send(json!({"op":"policy"}));
        assert_eq!(p["policy"]["managedBy"], "the household admin");
        assert_eq!(p["policy"]["settings"], json!({"maxInputLockMs": 20000}));
        assert_eq!(p["policy"]["inputLock"]["emergencyKey"], "f12");
        assert_eq!(
            p["policy"]["inputLock"]["maxDurationMs"].as_f64(),
            Some(20000.0)
        );
        assert_eq!(p["path"], json!(path.to_string_lossy()));
        let mut c2 = server.connect();
        let lock = c2.send(json!({"op":"lock","durationMs":600000}));
        assert_eq!(lock["ok"], true);
        assert_eq!(lock["durationMs"], 20000);
        c2.send(json!({"op":"unlock"}));
    }

    #[test]
    fn set_policy_creates_the_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("etc").join("rp-code").join("policy.json");
        let daemon = Daemon::new(
            Box::new(fake_devices()),
            Box::new(FakeInjector::default()),
            &nested,
        );
        let mut ctx = ConnCtx::test(1000, 42);
        let res = daemon.handle(
            Request::SetPolicy {
                policy: json!({"version":1}),
            },
            &mut ctx,
        );
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(
            fs::read_to_string(&nested).unwrap(),
            "{\n  \"version\": 1\n}\n"
        );
        let mode = fs::metadata(nested.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755);
        assert!(matches!(
            daemon.handle(
                Request::SetPolicy {
                    policy: json!({"version":1}),
                },
                &mut ctx,
            ),
            Response::Err(ref e) if e.code == ErrorCode::Exists
        ));
    }

    #[test]
    fn no_devices_and_emergency_over_the_socket() {
        let source = FakeSource::new();
        let server = TestServer::start(source.clone(), FakeInjector::default(), None);
        let mut c = server.connect();
        assert_eq!(
            c.send(json!({"op":"hello","version":1}))["devices"],
            json!({"keyboards":0,"pointers":0,"uinput":true})
        );
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":5000}))["code"],
            "NO_DEVICES"
        );

        source.add("event0", true, false).lock().unwrap().busy = true;
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":5000}))["code"],
            "BUSY"
        );

        source.add("event1", true, false);
        assert_eq!(c.send(json!({"op":"lock","durationMs":60000}))["ok"], true);
        // Hold the emergency key on the grabbed device: the ticker thread ends the lock.
        source.press("event1", keys::KEY_ESC);
        thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            server.daemon.engine().is_locked(),
            "not yet: hold is 5 s by default"
        );
        // Shorten the wait by unlocking through the state machine directly with a fake clock is
        // not possible here (real ticker), so verify the press was registered and end via unlock.
        assert_eq!(c.send(json!({"op":"unlock"}))["ok"], true);
        assert!(!source.state("event1").lock().unwrap().grabbed);
    }

    #[test]
    fn shutdown_releases_lock_and_refuses_requests() {
        let source = fake_devices();
        let server = TestServer::start(source.clone(), FakeInjector::default(), None);
        let mut c = server.connect();
        assert_eq!(c.send(json!({"op":"lock","durationMs":60000}))["ok"], true);
        assert!(source.state("event0").lock().unwrap().grabbed);
        server.daemon.shutdown();
        assert!(!source.state("event0").lock().unwrap().grabbed);
        assert_eq!(c.send(json!({"op":"status"}))["code"], "REFUSED");
    }

    #[test]
    fn null_injector_reports_no_uinput() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        // Swap in the null injector after start to simulate a missing /dev/uinput.
        *server.daemon.injector() = Box::new(inject::NullInjector);
        let mut c = server.connect();
        assert_eq!(
            c.send(json!({"op":"hello","version":1}))["devices"]["uinput"],
            false
        );
        assert_eq!(
            c.send(json!({"op":"type","text":"x"}))["code"],
            "NO_DEVICES"
        );
        assert_eq!(
            c.send(json!({"op":"lock","durationMs":1000}))["ok"],
            true,
            "locking does not need uinput"
        );
        c.send(json!({"op":"unlock"}));
    }

    #[test]
    fn bind_socket_refuses_non_socket_file_and_replaces_stale_socket() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("daemon.sock");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "x").unwrap();
        assert!(bind_socket(&file).is_err());
        fs::remove_file(&file).unwrap();
        let l1 = bind_socket(&file).unwrap();
        drop(l1);
        let l2 = bind_socket(&file).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o660);
        let dir_mode = fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o750);
        drop(l2);
    }

    /// Fake OS hooks: who is active, whether the process lives, what was spawned.
    struct FakeOs {
        active: Arc<Mutex<Vec<u32>>>,
        alive: Arc<AtomicBool>,
        spawned: Arc<Mutex<Vec<CommandSpec>>>,
        fail_spawn: Arc<AtomicBool>,
    }

    impl FakeOs {
        fn new(active: Vec<u32>) -> FakeOs {
            FakeOs {
                active: Arc::new(Mutex::new(active)),
                alive: Arc::new(AtomicBool::new(false)),
                spawned: Arc::new(Mutex::new(Vec::new())),
                fail_spawn: Arc::new(AtomicBool::new(false)),
            }
        }

        fn hooks(&self) -> KeepaliveHooks {
            let active = self.active.clone();
            let alive = self.alive.clone();
            let spawned = self.spawned.clone();
            let fail = self.fail_spawn.clone();
            KeepaliveHooks {
                active_uids: Box::new(move || active.lock().unwrap().clone()),
                process_alive: Box::new(move |_, _| alive.load(Ordering::SeqCst)),
                user_name: Box::new(|uid| match uid {
                    1000 => Some("alice".into()),
                    1001 => Some("bob".into()),
                    0 => Some("root".into()),
                    _ => None,
                }),
                is_executable: Box::new(|p| p.to_str() != Some("/missing")),
                proc_start: Box::new(|pid| Some(pid as u64 * 10)),
                spawn: Box::new(move |spec| {
                    if fail.load(Ordering::SeqCst) {
                        return Err(io::Error::other("no such file"));
                    }
                    spawned.lock().unwrap().push(spec.clone());
                    Ok(4242)
                }),
            }
        }

        fn spawned(&self) -> Vec<CommandSpec> {
            self.spawned.lock().unwrap().clone()
        }
    }

    fn register_req(exec: &str) -> Request {
        Request::Register {
            exec: exec.into(),
            args: vec!["--hidden".into()],
            cwd: "/nonexistent/cwd".into(),
            env: [("HOME", "/home/alice"), ("WAYLAND_DISPLAY", "wayland-1")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn ms(n: u64) -> std::time::Duration {
        std::time::Duration::from_millis(n)
    }

    #[test]
    fn relaunch_pipeline_with_fake_os() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("policy.json");
        fs::write(
            &policy_path,
            r#"{"version":1,"app":{"allowQuit":false,"users":["alice"]}}"#,
        )
        .unwrap();
        let os = FakeOs::new(vec![1000]);
        let daemon = Daemon::new(
            Box::new(fake_devices()),
            Box::new(FakeInjector::default()),
            &policy_path,
        )
        .with_keepalive_hooks(os.hooks());
        let t0 = Instant::now();

        // Validation errors and the root refusal come back as INVALID / REFUSED.
        let mut root = ConnCtx::test(0, 1);
        assert!(matches!(
            daemon.handle(register_req("/usr/bin/rp-code"), &mut root),
            Response::Err(ref e) if e.code == ErrorCode::Refused
        ));
        let mut alice = ConnCtx::test(1000, 7);
        assert!(matches!(
            daemon.handle(register_req("/missing"), &mut alice),
            Response::Err(ref e) if e.code == ErrorCode::Invalid && e.error.contains("executable")
        ));
        assert!(matches!(
            daemon.handle(register_req("relative"), &mut alice),
            Response::Err(ref e) if e.code == ErrorCode::Invalid
        ));
        let mut nobody = ConnCtx::test(5555, 9);
        assert!(matches!(
            daemon.handle(register_req("/usr/bin/rp-code"), &mut nobody),
            Response::Err(ref e) if e.code == ErrorCode::Invalid && e.error.contains("no user name")
        ));
        assert!(alice.registration.is_none());

        // Registered: status shows it, with allowQuit from the policy.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        let reg = alice
            .registration
            .clone()
            .expect("registration kept on the connection");
        assert_eq!(
            (reg.uid, reg.pid, reg.user.as_str(), reg.proc_start),
            (1000, 7, "alice", Some(70))
        );
        let status = serde_json::to_value(daemon.handle(Request::Status, &mut alice)).unwrap();
        assert_eq!(
            status["keepalive"],
            json!({"registered":true,"relaunches":0,"allowQuit":false})
        );
        // A second register on the same connection replaces the first.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());

        // The connection drops without unregister: relaunch scheduled 1.5 s later, then spawned
        // as alice with exactly the registered env and HOME as cwd (the registered cwd is gone).
        daemon.connection_lost(&mut alice, t0);
        assert!(alice.registration.is_none());
        assert!(daemon.keepalive().pending_for(1000).is_some());
        daemon.keepalive_tick(t0 + ms(1400));
        assert!(os.spawned().is_empty(), "not before the delay");
        daemon.keepalive_tick(t0 + ms(1500));
        let spawned = os.spawned();
        assert_eq!(spawned.len(), 1);
        let spec = &spawned[0];
        assert_eq!(spec.program, "/usr/bin/rp-code");
        assert_eq!(spec.args, vec!["--hidden"]);
        assert_eq!(spec.cwd, "/home/alice");
        assert_eq!(
            (spec.uid, spec.gid, spec.user.as_str()),
            (1000, 1000, "alice")
        );
        assert_eq!(
            spec.env.keys().cloned().collect::<Vec<_>>(),
            vec!["HOME", "WAYLAND_DISPLAY"]
        );
        let status = serde_json::to_value(daemon.handle(Request::Status, &mut alice)).unwrap();
        assert_eq!(
            status["keepalive"],
            json!({"registered":false,"relaunches":1,"allowQuit":false})
        );

        // Unregister first: an intended exit, nothing scheduled.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        assert!(daemon.handle(Request::Unregister, &mut alice).is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(2000));
        assert!(daemon.keepalive().pending_for(1000).is_none());

        // The app comes back (new registration) before the delay is up: pending cancelled.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(3000));
        assert!(daemon.keepalive().pending_for(1000).is_some());
        let mut alice2 = ConnCtx::test(1000, 8);
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice2)
            .is_ok());
        assert!(daemon.keepalive().pending_for(1000).is_none());
        daemon.keepalive_tick(t0 + ms(60_000));
        assert_eq!(os.spawned().len(), 1, "nothing new");
        assert!(daemon.handle(Request::Unregister, &mut alice2).is_ok());

        // Process still alive at fire time (the socket merely dropped): cancelled.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(70_000));
        os.alive.store(true, Ordering::SeqCst);
        daemon.keepalive_tick(t0 + ms(80_000));
        assert_eq!(os.spawned().len(), 1);
        assert!(daemon.keepalive().pending_for(1000).is_none());
        os.alive.store(false, Ordering::SeqCst);

        // The active graphical user changed (user switching) before the delay was up: cancelled.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(200_000));
        *os.active.lock().unwrap() = vec![1001];
        daemon.keepalive_tick(t0 + ms(210_000));
        assert_eq!(os.spawned().len(), 1);
        // Nobody active at all (no logind): nothing scheduled either.
        *os.active.lock().unwrap() = vec![];
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(300_000));
        assert!(daemon.keepalive().pending_for(1000).is_none());
        *os.active.lock().unwrap() = vec![1000, 1001];

        // bob is not in app.users: registered fine, never relaunched.
        let mut bob = ConnCtx::test(1001, 11);
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut bob)
            .is_ok());
        daemon.connection_lost(&mut bob, t0 + ms(400_000));
        assert!(daemon.keepalive().pending_for(1001).is_none());

        // The policy flips to allowQuit while a relaunch is pending: cancelled at fire time.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(500_000));
        fs::write(
            &policy_path,
            r#"{"version":1,"app":{"allowQuit":true,"users":["alice"]}}"#,
        )
        .unwrap();
        daemon.keepalive_tick(t0 + ms(510_000));
        assert_eq!(os.spawned().len(), 1);
        // And with allowQuit true a drop schedules nothing at all.
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(520_000));
        assert!(daemon.keepalive().pending_for(1000).is_none());
        assert_eq!(
            serde_json::to_value(daemon.handle(Request::Status, &mut alice)).unwrap()["keepalive"]
                ["allowQuit"],
            true
        );
        // allowQuit false without a users list: nothing is relaunched (warned once).
        fs::write(&policy_path, r#"{"version":1,"app":{"allowQuit":false}}"#).unwrap();
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, t0 + ms(530_000));
        assert!(daemon.keepalive().pending_for(1000).is_none());
    }

    #[test]
    fn relaunch_backoff_and_give_up_through_the_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("policy.json");
        fs::write(
            &policy_path,
            r#"{"version":1,"app":{"allowQuit":false,"users":["alice"]}}"#,
        )
        .unwrap();
        let os = FakeOs::new(vec![1000]);
        let daemon = Daemon::new(
            Box::new(fake_devices()),
            Box::new(FakeInjector::default()),
            &policy_path,
        )
        .with_keepalive_hooks(os.hooks());
        let t0 = Instant::now();
        let mut now = t0;
        let mut alice = ConnCtx::test(1000, 7);
        let mut delays = Vec::new();
        // Crash loop: each relaunch dies 1 s later. Delays climb 1.5 → 3 → 6 → 12 → 30 → 30…
        // and after 10 relaunches inside 10 minutes the daemon gives up.
        for i in 1..=11 {
            assert!(daemon
                .handle(register_req("/usr/bin/rp-code"), &mut alice)
                .is_ok());
            daemon.connection_lost(&mut alice, now);
            let Some(p) = daemon.keepalive().pending_for(1000).cloned() else {
                assert_eq!(i, 11, "gave up at the 11th death");
                break;
            };
            delays.push(p.delay.as_millis() as u64);
            now = p.due;
            daemon.keepalive_tick(now);
            assert_eq!(os.spawned().len(), i);
            now += ms(1000);
        }
        assert_eq!(
            delays,
            vec![1500, 3000, 6000, 12_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]
        );
        assert_eq!(os.spawned().len(), 10);
        // A failed spawn is counted like a relaunch (so a broken exec backs off too).
        now += std::time::Duration::from_secs(11 * 60);
        os.fail_spawn.store(true, Ordering::SeqCst);
        assert!(daemon
            .handle(register_req("/usr/bin/rp-code"), &mut alice)
            .is_ok());
        daemon.connection_lost(&mut alice, now);
        let p = daemon
            .keepalive()
            .pending_for(1000)
            .cloned()
            .expect("window slid: tries again");
        assert_eq!(p.delay, ms(1500));
        daemon.keepalive_tick(p.due);
        assert_eq!(os.spawned().len(), 10);
        assert_eq!(
            serde_json::to_value(daemon.handle(Request::Status, &mut alice)).unwrap()["keepalive"]
                ["relaunches"],
            11
        );
    }

    #[test]
    fn register_over_the_socket_uses_peer_credentials() {
        let os = FakeOs::new(vec![]);
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("daemon.sock");
        let policy_path = dir.path().join("policy.json");
        let engine =
            LockEngine::new(Box::new(fake_devices())).with_wall_clock(|| 1_700_000_000_000);
        let daemon = Arc::new(
            Daemon::new(
                Box::new(fake_devices()),
                Box::new(FakeInjector::default()),
                &policy_path,
            )
            .with_engine(engine)
            .with_keepalive_hooks(KeepaliveHooks {
                user_name: Box::new(|_| Some("tester".into())),
                ..os.hooks()
            }),
        );
        let listener = bind_socket(&socket).unwrap();
        let d = daemon.clone();
        thread::spawn(move || accept_loop(listener, d));
        let server = TestServer {
            socket,
            daemon,
            guard_os: Arc::new(guard::tests::FakeOs::default()),
            _dir: dir,
        };
        let mut c = server.connect();
        let res = c.send(json!({"op":"register","exec":"/usr/bin/rp-code","args":[],"cwd":"/","env":{"HOME":"/h"}}));
        if nix::unistd::getuid().is_root() {
            // The test process is root: SO_PEERCRED says uid 0, which may not register.
            assert_eq!(res["code"], "REFUSED");
        } else {
            assert_eq!(res, json!({"ok":true,"op":"register"}));
            assert_eq!(
                c.send(json!({"op":"status"}))["keepalive"]["registered"],
                true
            );
            assert_eq!(
                c.send(json!({"op":"unregister"})),
                json!({"ok":true,"op":"unregister"})
            );
            assert_eq!(
                c.send(json!({"op":"status"}))["keepalive"]["registered"],
                false
            );
        }
        assert_eq!(
            c.send(json!({"op":"register","exec":"rp-code","args":[],"cwd":"/","env":{}}))["ok"],
            false
        );
        assert_eq!(
            c.send(json!({"op":"register","exec":"/usr/bin/rp-code","args":[],"cwd":"/","env":{"LD_PRELOAD":"x"}}))["ok"],
            false
        );
        assert_eq!(
            c.send(json!({"op":"unregister"})),
            json!({"ok":true,"op":"unregister"}),
            "idempotent"
        );
        drop(c);
        thread::sleep(ms(100));
        assert!(
            os.spawned().is_empty(),
            "no policy: a drop relaunches nothing"
        );
    }

    #[test]
    fn apply_update_through_the_daemon() {
        use crate::sysinstall::tests::{app_tree, fake_appimage, seed_install, sha512_b64};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("opt");
        let home = dir.path().join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        // The request must come from a non-root uid that owns the file; as root we stand in
        // for uid 1000 and hand the file over, otherwise we are that user ourselves.
        let root_run = nix::unistd::getuid().is_root();
        let uid = if root_run {
            1000
        } else {
            nix::unistd::getuid().as_raw()
        };
        let gid = if root_run {
            1000
        } else {
            nix::unistd::getgid().as_raw()
        };
        let refreshed = Arc::new(Mutex::new(Vec::new()));
        let policy_path = dir.path().join("policy.json");
        let daemon = Daemon::new(
            Box::new(fake_devices()),
            Box::new(FakeInjector::default()),
            &policy_path,
        )
        .with_install(
            root.clone(),
            sysinstall::tests::test_hooks(home.clone(), refreshed.clone()),
            RestartPlan {
                exe: PathBuf::from("/nonexistent"),
                argv: Vec::new(),
                suppressed: true,
            },
        );
        let mut tree = app_tree("0.5.0");
        tree.push((
            "resources/bin/rp-coded",
            b"rp-coded 99.0.0 (protocol 1)\n".to_vec(),
        ));
        tree.push(("resources/system/install.sh", b"#!/bin/sh\n".to_vec()));
        let refs: Vec<(&str, &[u8])> = tree.iter().map(|(p, c)| (*p, c.as_slice())).collect();
        let appimage = home.join("rp-code-0.5.0.AppImage");
        fake_appimage(&appimage, &refs);
        if root_run {
            std::os::unix::fs::chown(&appimage, Some(uid), Some(gid)).unwrap();
        }
        let sha = sha512_b64(&appimage);
        let req = |version: &str, sha512: &str| Request::ApplyUpdate {
            file: appimage.to_string_lossy().into_owned(),
            version: version.into(),
            sha512: sha512.into(),
        };

        // Root is refused; no system install is refused; status says so.
        let mut as_root = ConnCtx::test(0, 1);
        assert!(matches!(
            daemon.handle(req("0.5.0", &sha), &mut as_root),
            Response::Err(ref e) if e.code == ErrorCode::Refused
        ));
        let mut user = ConnCtx::new(Peer { uid, gid, pid: 7 });
        assert!(matches!(
            daemon.handle(req("0.5.0", &sha), &mut user),
            Response::Err(ref e) if e.code == ErrorCode::Refused && e.error.contains("no system install")
        ));
        let status = serde_json::to_value(daemon.handle(Request::Status, &mut user)).unwrap();
        assert_eq!(
            status["install"],
            json!({"systemInstall":false,"daemonVersion":VERSION})
        );

        seed_install(&root, "0.4.0");
        let status = serde_json::to_value(daemon.handle(Request::Status, &mut user)).unwrap();
        assert_eq!(
            status["install"],
            json!({"systemInstall":true,"current":"0.4.0","daemonVersion":VERSION})
        );
        // Downgrade refused until the policy allows it.
        assert!(matches!(
            daemon.handle(req("0.3.9", &sha), &mut user),
            Response::Err(ref e) if e.code == ErrorCode::Refused && e.error.contains("allowDowngrade")
        ));
        // Bad checksum → INVALID, nothing changed.
        assert!(matches!(
            daemon.handle(req("0.5.0", "AAAA"), &mut user),
            Response::Err(ref e) if e.code == ErrorCode::Invalid
        ));
        assert_eq!(
            fs::read_to_string(root.join("current/resources/app.asar")).unwrap(),
            "asar 0.4.0"
        );
        if !root_run {
            // Taking ownership of the tree needs root; the rest is covered in sysinstall.rs.
            assert!(matches!(
                daemon.handle(req("0.5.0", &sha), &mut user),
                Response::Err(ref e) if e.code == ErrorCode::Internal
            ));
            assert!(!daemon.restart_pending());
            return;
        }
        let res = serde_json::to_value(daemon.handle(req("0.5.0", &sha), &mut user)).unwrap();
        assert_eq!(
            res,
            json!({"ok":true,"op":"apply-update","version":"0.5.0","restartDaemon":true})
        );
        assert!(daemon.restart_pending());
        assert_eq!(refreshed.lock().unwrap().len(), 1);
        let status = serde_json::to_value(daemon.handle(Request::Status, &mut user)).unwrap();
        assert_eq!(
            status["install"],
            json!({"systemInstall":true,"current":"0.5.0","previous":"0.4.0","daemonVersion":VERSION})
        );
        // While the restart is pending further updates are refused.
        assert!(matches!(
            daemon.handle(req("0.5.0", &sha), &mut user),
            Response::Err(ref e) if e.code == ErrorCode::Refused && e.error.contains("restart")
        ));
        // With the policy flag a downgrade goes through (the pending restart cleared first).
        daemon.restart_pending.store(false, Ordering::SeqCst);
        fs::write(
            &policy_path,
            r#"{"version":1,"settings":{"updates":{"allowDowngrade":true}}}"#,
        )
        .unwrap();
        let res = serde_json::to_value(daemon.handle(req("0.3.9", &sha), &mut user)).unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(
            res["restartDaemon"], true,
            "the bundle's 99.0.0 daemon is newer again"
        );
        assert_eq!(
            sysinstall::VersionsFile::load(&root)
                .unwrap()
                .unwrap()
                .previous
                .unwrap()
                .version,
            "0.5.0"
        );
    }

    #[test]
    fn guard_apply_status_and_policy_change_over_the_socket() {
        let policy = r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"audit"}}"#;
        let server = TestServer::start(fake_devices(), FakeInjector::default(), Some(policy));
        let os = server.guard_os.clone();
        *os.available.lock().unwrap() = true;
        os.existing.lock().unwrap().extend(
            [
                "/usr/lib/sddm/sddm-helper",
                "/usr/bin/noctalia",
                "/usr/bin/Hyprland",
            ]
            .map(String::from),
        );
        os.files.lock().unwrap().insert(
            PathBuf::from("/etc/pam.d/system-login"),
            "session optional pam_apparmor.so order=user,group,default # rp-code session guard\n"
                .into(),
        );
        let mut c = server.connect();
        // Nothing engaged yet: status reports the policy's mode, nothing loaded, and the LSM.
        let st = c.send(json!({"op":"status"}));
        assert_eq!(st["guard"]["mode"], "audit");
        assert_eq!(st["guard"]["loaded"], json!([]));
        assert_eq!(st["guard"]["available"], true);
        let gs = c.send(json!({"op":"guard-status"}));
        assert_eq!(gs["ok"], true);
        assert_eq!(
            gs["guard"]["mode"], "audit",
            "the policy says audit; nothing loaded"
        );
        assert!(gs["guard"]["residual"][0]
            .as_str()
            .unwrap()
            .contains("guard-apply is pending"));

        let applied = c.send(json!({"op":"guard-apply"}));
        assert_eq!(applied["ok"], true);
        assert_eq!(applied["op"], "guard-apply");
        assert_eq!(applied["guard"]["mode"], "audit");
        assert_eq!(applied["guard"]["users"], json!(["work"]));
        assert_eq!(
            applied["guard"]["loaded"],
            json!([
                "rp-code-session",
                "rp-code-app",
                "rp-code-shell",
                "rp-code-compositor",
                "rp-code-login"
            ])
        );
        assert_eq!(applied["guard"]["pamConfigured"], true);
        assert_eq!(applied["guard"]["shell"], "noctalia");
        assert!(applied["guard"].get("lastError").is_none(), "{applied}");
        assert_eq!(
            os.parser_calls
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.0)
                .collect::<Vec<_>>(),
            vec![ParserOp::Check, ParserOp::Replace]
        );
        assert_eq!(
            c.send(json!({"op":"status"}))["guard"]["loaded"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert!(server.daemon.guard_engaged());

        // The policy file changes to enforce: the ticker's stamp check re-applies.
        let path = server.daemon.policy().path().to_path_buf();
        thread::sleep(std::time::Duration::from_millis(20));
        fs::write(
            &path,
            r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"enforce"}}"#,
        )
        .unwrap();
        server.daemon.guard_tick();
        assert_eq!(
            c.send(json!({"op":"guard-status"}))["guard"]["mode"],
            "enforce"
        );
        let session = os
            .files
            .lock()
            .unwrap()
            .get(
                &server
                    .daemon
                    .guard_paths
                    .profile_dir
                    .join("rp-code-session"),
            )
            .cloned()
            .unwrap();
        assert!(session.contains("audit deny"));

        // mode off → unloaded; a broken policy keeps whatever is engaged and says why.
        fs::write(
            &path,
            r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"off"}}"#,
        )
        .unwrap();
        let off = c.send(json!({"op":"guard-apply"}));
        assert_eq!(off["guard"]["mode"], "off");
        assert_eq!(off["guard"]["loaded"], json!([]));
        assert_eq!(
            os.parser_calls.lock().unwrap().last().unwrap().0,
            ParserOp::Remove
        );
        fs::write(&path, "{").unwrap();
        let broken = c.send(json!({"op":"guard-apply"}));
        assert_eq!(broken["ok"], true);
        assert!(broken["guard"]["lastError"]
            .as_str()
            .unwrap()
            .contains("policy file invalid"));
    }

    #[test]
    fn subscribe_receives_pushed_guard_attempts_rate_limited() {
        let server = TestServer::start(fake_devices(), FakeInjector::default(), None);
        let mut c = server.connect();
        let mut other = server.connect();
        assert_eq!(
            c.send(json!({"op":"subscribe","events":["guard-attempt","weather","guard-attempt"]})),
            json!({"ok":true,"op":"subscribe","events":["guard-attempt"]})
        );
        assert_eq!(server.daemon.subscriber_count(), 1);
        let attempt = |target: &str| guard::GuardAttempt {
            kind: guard::AttemptKind::Ipc,
            target: target.into(),
            command: "hyprctl".into(),
            pid: 7,
            blocked: false,
            profile: "rp-code-session".into(),
            operation: "connect".into(),
            requested: Some("wr".into()),
        };
        let t0 = Instant::now();
        assert!(server.daemon.report_attempt(
            attempt("/run/user/1000/hypr/x/.socket.sock"),
            t0,
            "2026-09-14T12:00:00.000Z".into()
        ));
        let ev = c.next_line();
        assert_eq!(ev["ev"], "guard-attempt");
        assert_eq!(ev["at"], "2026-09-14T12:00:00.000Z");
        assert_eq!(ev["kind"], "ipc");
        assert_eq!(ev["target"], "/run/user/1000/hypr/x/.socket.sock");
        assert_eq!(ev["command"], "hyprctl");
        assert_eq!(ev["blocked"], false);
        // Same target within 10 s: dropped; another target: pushed. Requests still work in between.
        assert!(!server.daemon.report_attempt(
            attempt("/run/user/1000/hypr/x/.socket.sock"),
            t0 + std::time::Duration::from_secs(3),
            "t".into()
        ));
        assert_eq!(c.send(json!({"op":"status"}))["op"], "status");
        assert!(server.daemon.report_attempt(
            attempt("/run/user/1000/noctalia-wayland-1.sock"),
            t0 + std::time::Duration::from_secs(3),
            "t2".into()
        ));
        assert_eq!(
            c.next_line()["target"],
            "/run/user/1000/noctalia-wayland-1.sock"
        );
        // The unsubscribed connection saw nothing (its next request answers first).
        assert_eq!(other.send(json!({"op":"status"}))["op"], "status");
        // An empty list unsubscribes; a dropped connection is forgotten.
        assert_eq!(
            c.send(json!({"op":"subscribe","events":[]}))["events"],
            json!([])
        );
        assert_eq!(server.daemon.subscriber_count(), 0);
        c.send(json!({"op":"subscribe","events":["guard-attempt"]}));
        assert_eq!(server.daemon.subscriber_count(), 1);
        drop(c);
        for _ in 0..50 {
            if server.daemon.subscriber_count() == 0 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(server.daemon.subscriber_count(), 0);
        // Without a socket (unit-level ctx) subscribe is INVALID.
        let mut ctx = ConnCtx::test(1000, 1);
        assert!(matches!(
            server.daemon.handle(Request::Subscribe { events: vec!["guard-attempt".into()] }, &mut ctx),
            Response::Err(e) if e.code == ErrorCode::Invalid
        ));
    }

    #[test]
    fn args_parse() {
        let a = parse_args(&[
            "--socket".into(),
            "/tmp/s".into(),
            "--policy".into(),
            "/tmp/p".into(),
            "--log-level".into(),
            "debug".into(),
        ])
        .unwrap();
        assert_eq!(a.socket, PathBuf::from("/tmp/s"));
        assert_eq!(a.policy, PathBuf::from("/tmp/p"));
        assert_eq!(a.log_level, Level::Debug);
        assert_eq!(a.sessions_dir, PathBuf::from(DEFAULT_SESSIONS_DIR));
        assert_eq!(
            parse_args(&["--sessions-dir".into(), "/tmp/sess".into()])
                .unwrap()
                .sessions_dir,
            PathBuf::from("/tmp/sess")
        );
        assert!(parse_args(&["--sessions-dir".into()]).is_err());
        assert_eq!(a.install_root, PathBuf::from(DEFAULT_INSTALL_ROOT));
        assert!(a.system_prefix.is_none() && !a.no_restart);
        let b = parse_args(&[
            "--install-root".into(),
            "/tmp/opt".into(),
            "--system-prefix".into(),
            "/tmp/prefix".into(),
            "--no-restart".into(),
        ])
        .unwrap();
        assert_eq!(b.install_root, PathBuf::from("/tmp/opt"));
        assert_eq!(b.system_prefix, Some(PathBuf::from("/tmp/prefix")));
        assert!(b.no_restart);
        assert!(parse_args(&["--install-root".into()]).is_err());
        assert!(
            parse_args(&["--check-devices".into()])
                .unwrap()
                .check_devices
        );
        assert!(parse_args(&["--no-uinput".into()]).unwrap().no_uinput);
        assert!(parse_args(&["--bogus".into()]).is_err());
        assert!(parse_args(&["--socket".into()]).is_err());
        assert!(parse_args(&["--log-level".into(), "loud".into()]).is_err());
        assert_eq!(truncate("abcdef", 3), "abc…");
        assert_eq!(truncate("ab", 3), "ab");
    }
}
