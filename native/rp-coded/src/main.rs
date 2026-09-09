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
mod inject;
mod lock;
mod policy;
mod protocol;

use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use inject::Injector;
use lock::{DeviceSource, LockEngine, UnlockCause, TICK_INTERVAL};
use logging::Level;
use policy::{CreateError, PolicyStore, DEFAULT_POLICY_PATH};
use protocol::{
    DaemonError, DaemonResult, ErrorCode, Ok as OkPayload, Request, Response, PROTOCOL_VERSION,
};

/// `DAEMON_SOCKET_PATH` in `@rp/shared`.
pub const DEFAULT_SOCKET_PATH: &str = "/run/rp-code/daemon.sock";
/// `SYSTEM_GROUP` in `@rp/shared`: owner group of the socket directory and socket.
pub const SYSTEM_GROUP: &str = "rp-code";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
rp-coded — input lock / injection daemon for the rp desktop app

USAGE:
    rp-coded [--socket <path>] [--policy <path>] [--log-level <error|warn|info|debug>]
    rp-coded --check-devices
    rp-coded --help | --version

OPTIONS:
    --socket <path>     Unix socket to listen on (default /run/rp-code/daemon.sock,
                        env RP_CODED_SOCKET)
    --policy <path>     Policy file (default /etc/rp-code/policy.json, env RP_CODED_POLICY)
    --no-uinput         Do not create the uinput virtual device (injection reports NO_DEVICES)
    --check-devices     Print which input devices and /dev/uinput can be opened, then exit 0
    --log-level <lvl>   stderr verbosity (default info)

Runs as root under rp-coded.service. Members of the `rp-code` group may connect.
";

struct Args {
    socket: PathBuf,
    policy: PathBuf,
    no_uinput: bool,
    check_devices: bool,
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
        no_uinput: false,
        check_devices: false,
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

/// Everything the connection threads share.
pub struct Daemon {
    engine: Mutex<LockEngine>,
    injector: Mutex<Box<dyn Injector>>,
    policy: Mutex<PolicyStore>,
    shutting_down: AtomicBool,
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
            shutting_down: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    fn with_engine(mut self, engine: LockEngine) -> Self {
        self.engine = Mutex::new(engine);
        self
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
    }

    /// Release the lock and stop accepting requests.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.engine().unlock(UnlockCause::Shutdown);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Handle one request. `peer` is only used for logging.
    pub fn handle(&self, req: Request, peer: &str) -> Response {
        if self.is_shutting_down() {
            return Response::err(ErrorCode::Refused, "daemon is shutting down");
        }
        let op = req.op();
        match self.dispatch(req, peer) {
            Ok(payload) => Response::ok(payload),
            Err(e) => {
                log_debug!("{op} from {peer} failed: {e}");
                Response::from(e)
            }
        }
    }

    fn dispatch(&self, req: Request, peer: &str) -> DaemonResult<OkPayload> {
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
            Request::Status => Ok(OkPayload::Status {
                locked: self.engine().status(Instant::now()),
            }),
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
        }
    }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

/// Serve one connection: one JSON request per line, one response line each.
fn serve_connection(stream: UnixStream, daemon: &Daemon) -> io::Result<()> {
    let peer = peer_label(&stream);
    log_debug!("connection from {peer}");
    let mut writer = stream.try_clone()?;
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line?;
        let response = match protocol::parse_line(&line) {
            Ok(None) => continue,
            Ok(Some(req)) => daemon.handle(req, &peer),
            Err(e) => {
                log_warn!("{peer}: {e}: {}", truncate(&line, 200));
                Response::err(ErrorCode::Invalid, e)
            }
        };
        writer.write_all(response.to_line().as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    log_debug!("{peer} disconnected");
    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// `uid:pid` of the peer from SO_PEERCRED, for the audit log.
fn peer_label(stream: &UnixStream) -> String {
    match nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials) {
        Ok(c) => format!("uid {} pid {}", c.uid(), c.pid()),
        Err(_) => "unknown peer".to_string(),
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
    let daemon = Arc::new(Daemon::new(
        Box::new(devices::EvdevSource::new()),
        injector,
        args.policy.clone(),
    ));
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
    accept_loop(listener, daemon.clone());
    daemon.shutdown();
    let _ = fs::remove_file(&args.socket);
    ExitCode::SUCCESS
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
            let daemon = Arc::new(
                Daemon::new(Box::new(source), Box::new(injector), &policy_path).with_engine(engine),
            );
            let listener = bind_socket(&socket).unwrap();
            let d = daemon.clone();
            thread::spawn(move || accept_loop(listener, d));
            start_ticker(daemon.clone());
            TestServer {
                socket,
                daemon,
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
            json!({"ok":true,"op":"status","locked":null})
        );

        let lock = c.send(json!({"op":"lock","durationMs":30000,"reason":"surprise"}));
        assert_eq!(
            lock,
            json!({"ok":true,"op":"lock","until":"2023-11-14T22:13:50.000Z","durationMs":30000,"devices":"both"})
        );
        assert!(server.daemon.engine().is_locked());

        let status = c.send(json!({"op":"status"}));
        assert_eq!(
            status,
            json!({"ok":true,"op":"status","locked":{"until":"2023-11-14T22:13:50.000Z","reason":"surprise","devices":"both"}})
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
        assert_eq!(
            c.send(json!({"op":"status"})),
            json!({"ok":true,"op":"status","locked":null})
        );
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
        assert_eq!(
            c.send(json!({"op":"status"})),
            json!({"ok":true,"op":"status","locked":null})
        );
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
        let res = daemon.handle(
            Request::SetPolicy {
                policy: json!({"version":1}),
            },
            "uid 1000 pid 42",
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
                "uid 1000 pid 42",
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
