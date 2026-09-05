//! rp-overlay-wlr — wlr-layer-shell overlay helper for the rp desktop app.
//!
//! Reads JSON-lines requests from stdin, drives GTK3 + gtk-layer-shell + WebKitGTK
//! windows on the main loop, and writes JSON-lines events to stdout. See
//! `docs/spec/overlay-helper.md` and the crate README.

// Logging macros must be defined before the modules that use them.
#[macro_use]
mod logging {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::OnceLock;

    use crate::events::EventSink;
    use crate::protocol::Event;

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
    static SINK: OnceLock<EventSink> = OnceLock::new();

    pub fn set_level(level: Level) {
        LEVEL.store(level as u8, Ordering::Relaxed);
    }

    pub fn enabled(level: Level) -> bool {
        (level as u8) <= LEVEL.load(Ordering::Relaxed)
    }

    /// Route `warn`/`error` lines to the app as `log` events as well as to stderr.
    pub fn set_event_sink(sink: EventSink) {
        let _ = SINK.set(sink);
    }

    pub fn log(level: Level, message: String) {
        if !enabled(level) {
            return;
        }
        eprintln!("rp-overlay-wlr [{}] {}", level.as_str(), message);
        if level <= Level::Warn {
            if let Some(sink) = SINK.get() {
                sink.emit(Event::Log { level: level.as_str().to_owned(), message }, None);
            }
        }
    }

    macro_rules! log_error { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Error, format!($($arg)*)) }; }
    macro_rules! log_warn { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Warn, format!($($arg)*)) }; }
    macro_rules! log_info { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Info, format!($($arg)*)) }; }
    macro_rules! log_debug { ($($arg:tt)*) => { $crate::logging::log($crate::logging::Level::Debug, format!($($arg)*)) }; }
}

mod events;
mod monitors;
mod overlay;
mod plan;
mod protocol;

use std::io::BufRead;
use std::process::ExitCode;
use std::rc::Rc;

use events::EventSink;
use logging::Level;
use protocol::{Event, Op, Request, PROTOCOL_VERSION};

const USAGE: &str = "\
rp-overlay-wlr — wlr-layer-shell overlay helper for the rp desktop app

USAGE:
    rp-overlay-wlr [--log-level <error|warn|info|debug>]
    rp-overlay-wlr --self-test [--log-level ...] < conversation.jsonl

Reads JSON-lines requests on stdin and writes JSON-lines events on stdout.
--self-test parses the requests, prints the placement plans it would apply
(against a fixed two-monitor fixture) and exits without initialising GTK.
";

struct Args {
    self_test: bool,
    log_level: Level,
    help: bool,
    version: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args { self_test: false, log_level: Level::Info, help: false, version: false };
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--self-test" => args.self_test = true,
            "--help" | "-h" => args.help = true,
            "--version" | "-V" => args.version = true,
            "--log-level" => {
                let value = iter.next().ok_or("--log-level requires a value")?;
                args.log_level = Level::parse(value).ok_or_else(|| format!("unknown log level '{value}'"))?;
            }
            other => {
                if let Some(value) = other.strip_prefix("--log-level=") {
                    args.log_level = Level::parse(value).ok_or_else(|| format!("unknown log level '{value}'"))?;
                } else {
                    return Err(format!("unknown argument '{other}'"));
                }
            }
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rp-overlay-wlr: {e}\n\n{USAGE}");
            return ExitCode::from(64);
        }
    };
    if args.help {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.version {
        println!("rp-overlay-wlr {} (protocol {})", env!("CARGO_PKG_VERSION"), PROTOCOL_VERSION);
        return ExitCode::SUCCESS;
    }
    logging::set_level(args.log_level);

    if args.self_test {
        return self_test::run();
    }
    runtime::run()
}

// ---------------------------------------------------------------------------
// --self-test: protocol + planning without GTK
// ---------------------------------------------------------------------------

mod self_test {
    use std::collections::BTreeMap;
    use std::io::BufRead;
    use std::process::ExitCode;

    use serde::Serialize;

    use crate::events::EventSink;
    use crate::monitors::{fixture_monitors, FixtureMonitors, MonitorSource};
    use crate::plan::{plan, OverlayPlan, OverlaySettings};
    use crate::protocol::{parse_line, Event, Op, PROTOCOL_VERSION};

    #[derive(Serialize)]
    struct PlanLine<'a> {
        ev: &'static str,
        id: &'a str,
        url: &'a str,
        plan: &'a OverlayPlan,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    }

    pub fn run() -> ExitCode {
        let sink = EventSink::stdout();
        let monitors = FixtureMonitors(fixture_monitors());
        let monitor_list = monitors.monitors();
        let mut overlays: BTreeMap<String, (String, OverlaySettings)> = BTreeMap::new();
        let mut failures = 0usize;
        let mut lines = 0usize;

        let stdin = std::io::stdin();
        for (n, line) in stdin.lock().lines().enumerate() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    log_error!("failed to read stdin: {e}");
                    return ExitCode::from(1);
                }
            };
            let request = match parse_line(&line) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(e) => {
                    failures += 1;
                    log_error!("line {}: {}", n + 1, e);
                    sink.emit(Event::error(None, format!("line {}: {e}", n + 1)), None);
                    continue;
                }
            };
            lines += 1;
            let seq = request.seq;
            match request.op {
                Op::Hello { version } => {
                    if version != PROTOCOL_VERSION {
                        sink.emit(Event::error(None, format!("unsupported protocol version {version}")), seq);
                    }
                    sink.emit(Event::ready(), seq);
                }
                Op::Monitors => sink.emit(Event::Monitors { monitors: monitor_list.clone() }, seq),
                Op::Show(show) => {
                    let settings = OverlaySettings::from_show(&show);
                    let p = plan(&settings, &monitor_list);
                    print_plan(&show.id, &show.url, &p, seq);
                    overlays.insert(show.id.clone(), (show.url.clone(), settings));
                    sink.emit(Event::Shown { id: show.id }, seq);
                }
                Op::Update { id, patch } => match overlays.get_mut(&id) {
                    Some((url, settings)) => {
                        settings.apply(&patch);
                        let p = plan(settings, &monitor_list);
                        print_plan(&id, url, &p, seq);
                        sink.emit(Event::Updated { id }, seq);
                    }
                    None => sink.emit(Event::error(Some(&id), format!("unknown overlay id '{id}'")), seq),
                },
                Op::Js { id, script } => {
                    if overlays.contains_key(&id) {
                        log_info!("[{id}] would run {} bytes of script", script.len());
                        sink.emit(Event::JsDone { id }, seq);
                    } else {
                        sink.emit(Event::error(Some(&id), format!("unknown overlay id '{id}'")), seq);
                    }
                }
                Op::Close { id } => {
                    if overlays.remove(&id).is_some() {
                        sink.emit(Event::Closed { id }, seq);
                    } else {
                        sink.emit(Event::error(Some(&id), format!("unknown overlay id '{id}'")), seq);
                    }
                }
                Op::CloseAll => {
                    let mut seq = seq;
                    for id in std::mem::take(&mut overlays).into_keys() {
                        sink.emit(Event::Closed { id }, seq.take());
                    }
                }
                Op::Quit => {
                    log_info!("quit requested");
                    break;
                }
            }
        }

        log_info!("self-test: {lines} requests, {failures} parse failures, {} overlays left open", overlays.len());
        if failures > 0 || sink.is_broken() {
            ExitCode::from(1)
        } else {
            ExitCode::SUCCESS
        }
    }

    fn print_plan(id: &str, url: &str, plan: &OverlayPlan, seq: Option<u64>) {
        let line = PlanLine { ev: "plan", id, url, plan, seq };
        println!("{}", serde_json::to_string(&line).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------
// Real runtime: GTK main loop + stdin reader thread
// ---------------------------------------------------------------------------

mod runtime {
    use super::*;
    use std::cell::RefCell;

    use crate::monitors::{GdkMonitors, MonitorSource};
    use crate::overlay::OverlayManager;

    enum Incoming {
        Line(String),
        Eof,
    }

    pub fn run() -> ExitCode {
        let sink = EventSink::stdout();
        logging::set_event_sink(sink.clone());

        if let Err(err) = gtk::init() {
            let message = format!("GTK initialisation failed: {err} (is WAYLAND_DISPLAY set?)");
            log_error!("{message}");
            sink.emit(Event::error(None, message), None);
            return ExitCode::from(2);
        }
        if !gtk_layer_shell::is_supported() {
            let message = "wlr-layer-shell is not supported by this compositor / display backend".to_owned();
            log_error!("{message}");
            sink.emit(Event::error(None, message), None);
            return ExitCode::from(2);
        }
        log_info!(
            "GTK {}.{}.{}, gtk-layer-shell {}.{}.{} (protocol v{})",
            gtk::major_version(),
            gtk::minor_version(),
            gtk::micro_version(),
            gtk_layer_shell::major_version(),
            gtk_layer_shell::minor_version(),
            gtk_layer_shell::micro_version(),
            gtk_layer_shell::protocol_version()
        );

        let monitors: Rc<dyn MonitorSource> = Rc::new(GdkMonitors);
        let manager = Rc::new(RefCell::new(OverlayManager::new(sink.clone(), monitors.clone())));

        // stdin reader thread → glib channel → main loop.
        // `MainContext::channel` is deprecated in glib 0.18 but remains the simplest
        // thread-safe hand-off into the GTK main context without an async runtime.
        #[allow(deprecated)]
        let (tx, rx) = glib::MainContext::channel::<Incoming>(glib::Priority::DEFAULT);
        std::thread::Builder::new()
            .name("stdin-reader".into())
            .spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    match line {
                        Ok(l) => {
                            if tx.send(Incoming::Line(l)).is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            eprintln!("rp-overlay-wlr [error] stdin read failed: {e}");
                            break;
                        }
                    }
                }
                let _ = tx.send(Incoming::Eof);
            })
            .expect("spawn stdin reader");

        {
            let manager = manager.clone();
            let sink = sink.clone();
            let monitors = monitors.clone();
            #[allow(deprecated)]
            rx.attach(None, move |msg| {
                let quit = match msg {
                    Incoming::Eof => {
                        log_info!("stdin closed; quitting");
                        true
                    }
                    Incoming::Line(line) => dispatch(&line, &manager, &sink, monitors.as_ref()),
                };
                if quit || sink.is_broken() {
                    let mut m = manager.borrow_mut();
                    log_info!("closing {} overlay(s) and exiting", m.len());
                    m.close_all(None);
                    gtk::main_quit();
                    return glib::ControlFlow::Break;
                }
                glib::ControlFlow::Continue
            });
        }

        gtk::main();
        log_info!("exiting");
        ExitCode::SUCCESS
    }

    /// Handle one stdin line. Returns true when the helper should exit.
    fn dispatch(
        line: &str,
        manager: &Rc<RefCell<OverlayManager>>,
        sink: &EventSink,
        monitors: &dyn MonitorSource,
    ) -> bool {
        let request: Request = match protocol::parse_line(line) {
            Ok(Some(r)) => r,
            Ok(None) => return false,
            Err(e) => {
                log_warn!("{e}: {}", truncate(line, 200));
                sink.emit(Event::error(None, e), None);
                return false;
            }
        };
        let seq = request.seq;
        log_debug!("request {:?}", truncate(line, 300));
        match request.op {
            Op::Hello { version } => {
                if version != PROTOCOL_VERSION {
                    log_warn!("app speaks protocol {version}, helper speaks {PROTOCOL_VERSION}");
                    sink.emit(
                        Event::error(None, format!("unsupported protocol version {version} (helper: {PROTOCOL_VERSION})")),
                        seq,
                    );
                    return false;
                }
                sink.emit(Event::ready(), seq);
            }
            Op::Monitors => {
                let list = monitors.monitors();
                sink.emit(Event::Monitors { monitors: list }, seq);
            }
            Op::Show(show) => manager.borrow_mut().show(&show, seq),
            Op::Update { id, patch } => manager.borrow_mut().update(&id, &patch, seq),
            Op::Js { id, script } => manager.borrow_mut().js(&id, &script, seq),
            Op::Close { id } => manager.borrow_mut().close(&id, seq),
            Op::CloseAll => manager.borrow_mut().close_all(seq),
            Op::Quit => {
                log_info!("quit requested");
                return true;
            }
        }
        false
    }

    fn truncate(s: &str, max: usize) -> String {
        if s.len() <= max {
            s.to_owned()
        } else {
            let mut end = max;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}…", &s[..end])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse_args(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_flags() {
        let a = args(&[]).unwrap();
        assert!(!a.self_test);
        assert_eq!(a.log_level, Level::Info);
        let a = args(&["--self-test", "--log-level", "debug"]).unwrap();
        assert!(a.self_test);
        assert_eq!(a.log_level, Level::Debug);
        let a = args(&["--log-level=warn"]).unwrap();
        assert_eq!(a.log_level, Level::Warn);
        assert!(args(&["--help"]).unwrap().help);
        assert!(args(&["-V"]).unwrap().version);
    }

    #[test]
    fn rejects_bad_flags() {
        assert!(args(&["--log-level"]).is_err());
        assert!(args(&["--log-level", "loud"]).is_err());
        assert!(args(&["--bogus"]).is_err());
    }

    #[test]
    fn level_filtering() {
        logging::set_level(Level::Warn);
        assert!(logging::enabled(Level::Error));
        assert!(logging::enabled(Level::Warn));
        assert!(!logging::enabled(Level::Info));
        logging::set_level(Level::Info);
    }
}
