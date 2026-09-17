//! The input lock: grab every keyboard/pointer, keep draining their events, watch for the
//! emergency chord, release on timer expiry / `unlock` / shutdown, grab devices that appear
//! while locked.
//!
//! All device access goes through [`DeviceSource`] / [`GrabbedDevice`] so the state machine
//! ([`LockEngine`]) is driven by fakes in tests and by evdev in `devices.rs`. The engine has
//! no threads or clocks of its own: the daemon calls [`LockEngine::tick`] every
//! [`TICK_INTERVAL`] with the current time.

use std::collections::HashSet;
use std::fmt;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::policy::LockLimits;
use crate::protocol::{DaemonError, ErrorCode, LockDevices, LockInfo, REASON_MAX_CHARS};

/// How often the daemon drains grabbed devices and checks timers.
pub const TICK_INTERVAL: Duration = Duration::from_millis(50);
/// How often `/dev/input` is rescanned for hot-plugged devices while locked.
pub const HOTPLUG_INTERVAL: Duration = Duration::from_secs(1);

/// An `EV_KEY` event from a grabbed device: scancode and value (0 release, 1 press, 2 repeat).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    pub code: u16,
    pub value: i32,
}

/// What a device can do, as reported by its capability bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    /// Stable identity while the device exists (`/dev/input/eventN`).
    pub path: String,
    pub name: String,
    /// Has typing keys (KEY_A ...).
    pub keyboard: bool,
    /// Pointer: EV_REL motion, or EV_ABS with BTN_LEFT/BTN_TOUCH.
    pub pointer: bool,
}

impl DeviceInfo {
    /// Whether a lock over `devices` should grab this device. A device that is both (keyboard
    /// with a trackpoint) is grabbed whenever either selected class matches.
    pub fn selected_by(&self, devices: LockDevices) -> bool {
        (devices.wants_keyboard() && self.keyboard) || (devices.wants_pointer() && self.pointer)
    }
}

/// An open input device we can grab.
pub trait GrabbedDevice: Send {
    /// `EVIOCGRAB(1)`. `WouldBlock`/`ResourceBusy`-style errors mean another process holds it.
    fn grab(&mut self) -> io::Result<()>;
    /// `EVIOCGRAB(0)`; failures are logged and ignored.
    fn ungrab(&mut self) -> io::Result<()>;
    /// Non-blocking read of pending events, returning only `EV_KEY` ones. An `Err` means the
    /// device is gone (`ENODEV`) or unusable; the engine drops it.
    fn drain(&mut self) -> io::Result<Vec<KeyEvent>>;
}

/// Where devices come from (`/dev/input` in production, a fake in tests).
pub trait DeviceSource: Send {
    /// Every device currently present that reports keys or pointer motion/buttons.
    fn list(&mut self) -> Vec<DeviceInfo>;
    /// Open one of them by path.
    fn open(&mut self, path: &str) -> io::Result<Box<dyn GrabbedDevice>>;
}

/// Why a lock ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockCause {
    Timer,
    Emergency,
    Request,
    Shutdown,
}

impl fmt::Display for UnlockCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            UnlockCause::Timer => "timer expired",
            UnlockCause::Emergency => "emergency chord",
            UnlockCause::Request => "unlock request",
            UnlockCause::Shutdown => "daemon shutdown",
        })
    }
}

/// Result of a successful `lock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOutcome {
    pub until_unix_ms: u64,
    pub duration_ms: u64,
    pub devices: LockDevices,
    /// Devices grabbed (after the call).
    pub grabbed: usize,
    /// Whether at least one grabbed device has keys, i.e. the emergency chord can work.
    pub emergency_available: bool,
}

struct Held {
    info: DeviceInfo,
    device: Box<dyn GrabbedDevice>,
}

impl Held {
    fn path(&self) -> &str {
        &self.info.path
    }
    fn keyboard(&self) -> bool {
        self.info.keyboard
    }
}

struct Active {
    until: Instant,
    until_unix_ms: u64,
    reason: Option<String>,
    devices: LockDevices,
    emergency_code: u16,
    emergency_hold: Duration,
    /// When the emergency key went down (from any grabbed device).
    hold_since: Option<Instant>,
    last_scan: Instant,
}

/// The lock state machine.
pub struct LockEngine {
    source: Box<dyn DeviceSource>,
    held: Vec<Held>,
    active: Option<Active>,
    /// Wall clock used to derive `until` timestamps (injectable for tests).
    wall: Box<dyn Fn() -> u64 + Send>,
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl LockEngine {
    pub fn new(source: Box<dyn DeviceSource>) -> Self {
        LockEngine {
            source,
            held: Vec::new(),
            active: None,
            wall: Box::new(unix_ms_now),
        }
    }

    /// Use a fixed wall clock (tests).
    #[cfg(test)]
    pub fn with_wall_clock(mut self, wall: impl Fn() -> u64 + Send + 'static) -> Self {
        self.wall = Box::new(wall);
        self
    }

    /// Whether a lock is active (regardless of expiry; the ticker releases expired ones).
    pub fn is_locked(&self) -> bool {
        self.active.is_some()
    }

    #[cfg(test)]
    pub fn grabbed_count(&self) -> usize {
        self.held.len()
    }

    /// Lock state for `status`, `None` when unlocked. Expired locks that have not been ticked
    /// yet are reported as unlocked too.
    pub fn status(&self, now: Instant) -> Option<LockInfo> {
        let a = self.active.as_ref()?;
        if now >= a.until {
            return None;
        }
        Some(LockInfo {
            until: crate::protocol::iso_millis(a.until_unix_ms),
            reason: a.reason.clone(),
            devices: a.devices,
        })
    }

    /// Devices available to grab right now (for `hello` and `--check-devices`).
    pub fn list_devices(&mut self) -> Vec<DeviceInfo> {
        self.source.list()
    }

    /// Start (or extend/replace) a lock over the selected device class. `duration_ms` must
    /// already be clamped by the policy. Fails with `NO_DEVICES` when nothing matching could be
    /// grabbed, `BUSY` when every matching device is held by another process. Re-locking with a
    /// different `devices` releases what no longer matches and grabs what now does.
    pub fn lock(
        &mut self,
        now: Instant,
        duration_ms: u64,
        reason: Option<String>,
        devices: LockDevices,
        limits: &LockLimits,
    ) -> Result<LockOutcome, DaemonError> {
        let reason = reason
            .map(|r| r.chars().take(REASON_MAX_CHARS).collect::<String>())
            .filter(|r| !r.is_empty());
        self.release_unselected(devices);
        let (_, busy, failed) = self.grab_new_devices(devices);
        if self.held.is_empty() {
            let what = match devices {
                LockDevices::Keyboard => "keyboard",
                LockDevices::Mouse => "pointer",
                LockDevices::Both => "input",
            };
            let msg = if busy > 0 {
                format!("all {busy} {what} device(s) are grabbed by another process")
            } else if failed > 0 {
                format!("could not open {failed} {what} device(s)")
            } else {
                format!("no {what} devices found (is /dev/input present and readable?)")
            };
            let code = if busy > 0 {
                ErrorCode::Busy
            } else {
                ErrorCode::NoDevices
            };
            if self.active.is_some() {
                // A re-lock that grabbed nothing ends the previous lock rather than leaving it
                // half-applied.
                self.unlock(UnlockCause::Request);
            }
            return Err(DaemonError::new(code, msg));
        }
        let until_unix_ms = (self.wall)() + duration_ms;
        let hold_since = self.active.as_ref().and_then(|a| a.hold_since);
        self.active = Some(Active {
            until: now + Duration::from_millis(duration_ms),
            until_unix_ms,
            reason,
            devices,
            emergency_code: limits.emergency_key.code(),
            emergency_hold: Duration::from_millis(limits.emergency_hold_ms),
            hold_since,
            last_scan: now,
        });
        Ok(LockOutcome {
            until_unix_ms,
            duration_ms,
            devices,
            grabbed: self.held.len(),
            emergency_available: self.held.iter().any(|h| h.keyboard()),
        })
    }

    /// Ungrab held devices that the new selection does not cover.
    fn release_unselected(&mut self, devices: LockDevices) {
        let mut i = 0;
        while i < self.held.len() {
            if self.held[i].info.selected_by(devices) {
                i += 1;
            } else {
                let mut h = self.held.remove(i);
                if let Err(e) = h.device.ungrab() {
                    log_warn!("ungrab {} failed: {e}", h.path());
                }
            }
        }
    }

    /// Release everything. Returns whether a lock was active.
    pub fn unlock(&mut self, cause: UnlockCause) -> bool {
        let was_locked = self.active.take().is_some();
        for mut h in self.held.drain(..) {
            if let Err(e) = h.device.ungrab() {
                log_warn!("ungrab {} failed: {e}", h.path());
            }
        }
        if was_locked {
            log_info!("unlocked ({cause})");
        }
        was_locked
    }

    /// Periodic work: drain grabbed devices (so the kernel buffers never fill), detect the
    /// emergency chord, expire the timer, rescan for hot-plugged devices. Returns the cause
    /// when this tick ended the lock.
    pub fn tick(&mut self, now: Instant) -> Option<UnlockCause> {
        let Some(active) = self.active.as_mut() else {
            // Nothing should be held while unlocked; be defensive.
            if !self.held.is_empty() {
                self.unlock(UnlockCause::Request);
            }
            return None;
        };
        if now >= active.until {
            self.unlock(UnlockCause::Timer);
            return Some(UnlockCause::Timer);
        }

        // Drain events and watch the emergency key.
        let code = active.emergency_code;
        let mut hold_since = active.hold_since;
        let mut gone: Vec<usize> = Vec::new();
        for (i, h) in self.held.iter_mut().enumerate() {
            match h.device.drain() {
                Ok(events) => {
                    for ev in events {
                        if ev.code != code {
                            continue;
                        }
                        match ev.value {
                            1 => hold_since.get_or_insert(now),
                            0 => {
                                hold_since = None;
                                continue;
                            }
                            _ => continue,
                        };
                    }
                }
                Err(e) => {
                    log_info!("device {} went away: {e}", h.path());
                    gone.push(i);
                }
            }
        }
        for i in gone.into_iter().rev() {
            self.held.remove(i);
        }
        let active = self.active.as_mut().expect("still locked");
        active.hold_since = hold_since;
        if let Some(since) = hold_since {
            if now.duration_since(since) >= active.emergency_hold {
                self.unlock(UnlockCause::Emergency);
                return Some(UnlockCause::Emergency);
            }
        }

        // Hot-plug.
        if now.duration_since(active.last_scan) >= HOTPLUG_INTERVAL {
            active.last_scan = now;
            let devices = active.devices;
            let (grabbed, _, _) = self.grab_new_devices(devices);
            if grabbed > 0 {
                log_info!("grabbed {grabbed} hot-plugged device(s)");
            }
        }
        None
    }

    /// Grab every listed device of the selected class we do not hold yet.
    /// Returns (grabbed, busy, failed).
    fn grab_new_devices(&mut self, devices: LockDevices) -> (usize, usize, usize) {
        let known: HashSet<String> = self.held.iter().map(|h| h.path().to_string()).collect();
        let (mut grabbed, mut busy, mut failed) = (0, 0, 0);
        for info in self.source.list() {
            if known.contains(&info.path) || !info.selected_by(devices) {
                continue;
            }
            match self.source.open(&info.path) {
                Ok(mut device) => match device.grab() {
                    Ok(()) => {
                        log_debug!("grabbed {} ({})", info.path, info.name);
                        self.held.push(Held { info, device });
                        grabbed += 1;
                    }
                    Err(e) => {
                        if is_busy(&e) {
                            busy += 1;
                            log_warn!(
                                "{} ({}) is grabbed by another process",
                                info.path,
                                info.name
                            );
                        } else {
                            failed += 1;
                            log_warn!("grab {} ({}) failed: {e}", info.path, info.name);
                        }
                    }
                },
                Err(e) => {
                    failed += 1;
                    log_warn!("open {} failed: {e}", info.path);
                }
            }
        }
        (grabbed, busy, failed)
    }
}

fn is_busy(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock) || e.raw_os_error() == Some(16 /* EBUSY */)
}

impl Drop for LockEngine {
    fn drop(&mut self) {
        self.unlock(UnlockCause::Shutdown);
    }
}

/// Emergency key description for logs and `--check-devices`.
pub fn describe_emergency(limits: &LockLimits) -> String {
    format!(
        "hold {} for {} ms",
        limits.emergency_key.as_str(),
        limits.emergency_hold_ms
    )
}

// ---------------------------------------------------------------------------
// Fakes (shared by the lock tests and the server tests)
// ---------------------------------------------------------------------------

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Default)]
    pub struct FakeDeviceState {
        pub grabbed: bool,
        pub grab_count: u32,
        pub ungrab_count: u32,
        pub pending: VecDeque<KeyEvent>,
        /// Grabbing fails with EBUSY.
        pub busy: bool,
        /// Reads fail with ENODEV (device unplugged after being grabbed).
        pub gone: bool,
    }

    type SharedState = Arc<Mutex<FakeDeviceState>>;
    type DeviceTable = HashMap<String, (DeviceInfo, SharedState)>;

    /// The fake source: a shared table of devices the test mutates while the engine runs.
    #[derive(Clone, Default)]
    pub struct FakeSource {
        pub devices: Arc<Mutex<DeviceTable>>,
    }

    impl FakeSource {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn with_devices(names: &[(&str, bool, bool)]) -> Self {
            let s = Self::new();
            for (name, kb, ptr) in names {
                s.add(name, *kb, *ptr);
            }
            s
        }

        pub fn add(
            &self,
            name: &str,
            keyboard: bool,
            pointer: bool,
        ) -> Arc<Mutex<FakeDeviceState>> {
            let path = format!("/dev/input/{name}");
            let state = Arc::new(Mutex::new(FakeDeviceState::default()));
            let info = DeviceInfo {
                path: path.clone(),
                name: name.to_string(),
                keyboard,
                pointer,
            };
            self.devices
                .lock()
                .unwrap()
                .insert(path, (info, state.clone()));
            state
        }

        pub fn remove(&self, name: &str) {
            let path = format!("/dev/input/{name}");
            if let Some((_, state)) = self.devices.lock().unwrap().remove(&path) {
                state.lock().unwrap().gone = true;
            }
        }

        pub fn state(&self, name: &str) -> Arc<Mutex<FakeDeviceState>> {
            self.devices.lock().unwrap()[&format!("/dev/input/{name}")]
                .1
                .clone()
        }

        pub fn press(&self, name: &str, code: u16) {
            self.state(name)
                .lock()
                .unwrap()
                .pending
                .push_back(KeyEvent { code, value: 1 });
        }

        pub fn release(&self, name: &str, code: u16) {
            self.state(name)
                .lock()
                .unwrap()
                .pending
                .push_back(KeyEvent { code, value: 0 });
        }
    }

    pub struct FakeDevice {
        state: Arc<Mutex<FakeDeviceState>>,
    }

    impl GrabbedDevice for FakeDevice {
        fn grab(&mut self) -> io::Result<()> {
            let mut s = self.state.lock().unwrap();
            if s.busy {
                return Err(io::Error::from_raw_os_error(16));
            }
            s.grabbed = true;
            s.grab_count += 1;
            Ok(())
        }
        fn ungrab(&mut self) -> io::Result<()> {
            let mut s = self.state.lock().unwrap();
            s.grabbed = false;
            s.ungrab_count += 1;
            Ok(())
        }
        fn drain(&mut self) -> io::Result<Vec<KeyEvent>> {
            let mut s = self.state.lock().unwrap();
            if s.gone {
                return Err(io::Error::from_raw_os_error(19)); // ENODEV
            }
            Ok(s.pending.drain(..).collect())
        }
    }

    impl DeviceSource for FakeSource {
        fn list(&mut self) -> Vec<DeviceInfo> {
            let mut v: Vec<DeviceInfo> = self
                .devices
                .lock()
                .unwrap()
                .values()
                .map(|(i, _)| i.clone())
                .collect();
            v.sort_by(|a, b| a.path.cmp(&b.path));
            v
        }
        fn open(&mut self, path: &str) -> io::Result<Box<dyn GrabbedDevice>> {
            let devices = self.devices.lock().unwrap();
            let (_, state) = devices
                .get(path)
                .ok_or_else(|| io::Error::from_raw_os_error(2))?;
            Ok(Box::new(FakeDevice {
                state: state.clone(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;
    use crate::inject::keys::{KEY_A, KEY_ESC, KEY_F12};
    use crate::policy::EmergencyKey;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn engine(source: &FakeSource) -> LockEngine {
        LockEngine::new(Box::new(source.clone())).with_wall_clock(|| 1_700_000_000_000)
    }

    #[test]
    fn lock_grabs_every_device_and_reports_until() {
        let src = FakeSource::with_devices(&[("event0", true, false), ("event1", false, true)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        assert!(eng.status(t0).is_none());
        let out = eng
            .lock(
                t0,
                30_000,
                Some("surprise".into()),
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(
            out,
            LockOutcome {
                until_unix_ms: 1_700_000_030_000,
                duration_ms: 30_000,
                devices: LockDevices::Both,
                grabbed: 2,
                emergency_available: true
            }
        );
        assert!(src.state("event0").lock().unwrap().grabbed);
        assert!(src.state("event1").lock().unwrap().grabbed);
        let st = eng.status(t0 + ms(10)).unwrap();
        assert_eq!(
            st,
            LockInfo {
                until: "2023-11-14T22:13:50.000Z".into(),
                reason: Some("surprise".into()),
                devices: LockDevices::Both
            }
        );
        assert!(eng.is_locked());
        assert_eq!(eng.grabbed_count(), 2);

        assert!(eng.unlock(UnlockCause::Request));
        assert!(
            !eng.unlock(UnlockCause::Request),
            "second unlock is a no-op"
        );
        assert!(!src.state("event0").lock().unwrap().grabbed);
        assert_eq!(src.state("event1").lock().unwrap().ungrab_count, 1);
        assert!(eng.status(t0).is_none());
        assert_eq!(eng.grabbed_count(), 0);
    }

    #[test]
    fn lock_without_devices_is_no_devices_and_busy_is_busy() {
        let src = FakeSource::new();
        let mut eng = engine(&src);
        let err = eng
            .lock(
                Instant::now(),
                5000,
                None,
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NoDevices);
        assert!(!eng.is_locked());

        src.add("event0", true, false).lock().unwrap().busy = true;
        let err = eng
            .lock(
                Instant::now(),
                5000,
                None,
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Busy);
        assert!(!eng.is_locked());

        // One busy, one fine → lock succeeds with the one we could grab.
        src.add("event1", true, false);
        let out = eng
            .lock(
                Instant::now(),
                5000,
                None,
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(out.grabbed, 1);
    }

    #[test]
    fn timer_expiry_unlocks_on_tick() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(t0, 2000, None, LockDevices::Both, &LockLimits::default())
            .unwrap();
        assert_eq!(eng.tick(t0 + ms(1999)), None);
        assert!(eng.is_locked());
        assert!(
            eng.status(t0 + ms(2000)).is_none(),
            "status never reports an expired lock"
        );
        assert_eq!(eng.tick(t0 + ms(2000)), Some(UnlockCause::Timer));
        assert!(!eng.is_locked());
        assert!(!src.state("event0").lock().unwrap().grabbed);
        assert_eq!(eng.tick(t0 + ms(3000)), None);
    }

    #[test]
    fn relock_extends_and_keeps_devices() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(t0, 2000, None, LockDevices::Both, &LockLimits::default())
            .unwrap();
        let out = eng
            .lock(
                t0 + ms(1000),
                5000,
                Some("more".into()),
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(out.grabbed, 1);
        assert_eq!(
            src.state("event0").lock().unwrap().grab_count,
            1,
            "already-held devices are not re-grabbed"
        );
        assert_eq!(
            eng.tick(t0 + ms(2500)),
            None,
            "old deadline no longer applies"
        );
        assert_eq!(eng.tick(t0 + ms(6000)), Some(UnlockCause::Timer));
    }

    #[test]
    fn emergency_hold_unlocks_and_short_taps_do_not() {
        let src = FakeSource::with_devices(&[("event0", true, false), ("event1", false, true)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(t0, 60_000, None, LockDevices::Both, &LockLimits::default())
            .unwrap();

        // Tap: press, release quickly.
        src.press("event0", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(50)), None);
        src.release("event0", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(100)), None);
        assert_eq!(
            eng.tick(t0 + ms(6000)),
            None,
            "released before the hold time"
        );
        assert!(eng.is_locked());

        // Other keys are ignored (and drained).
        src.press("event0", KEY_A);
        assert_eq!(eng.tick(t0 + ms(6050)), None);
        assert!(
            src.state("event0").lock().unwrap().pending.is_empty(),
            "events are drained"
        );

        // Hold: press and keep it down (repeats are ignored).
        src.press("event0", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(7000)), None);
        src.state("event0")
            .lock()
            .unwrap()
            .pending
            .push_back(KeyEvent {
                code: KEY_ESC,
                value: 2,
            });
        assert_eq!(eng.tick(t0 + ms(9000)), None);
        assert_eq!(eng.tick(t0 + ms(11_999)), None);
        assert_eq!(eng.tick(t0 + ms(12_000)), Some(UnlockCause::Emergency));
        assert!(!eng.is_locked());
        assert!(eng.status(t0 + ms(12_000)).is_none());
        assert!(!src.state("event1").lock().unwrap().grabbed);
    }

    #[test]
    fn emergency_key_and_hold_come_from_policy() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        let limits = LockLimits {
            emergency_key: EmergencyKey::F12,
            emergency_hold_ms: 1000,
            ..LockLimits::default()
        };
        eng.lock(t0, 60_000, None, LockDevices::Both, &limits)
            .unwrap();
        src.press("event0", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(50)), None);
        assert_eq!(
            eng.tick(t0 + ms(5000)),
            None,
            "esc is not the emergency key here"
        );
        src.press("event0", KEY_F12);
        assert_eq!(eng.tick(t0 + ms(5100)), None);
        assert_eq!(eng.tick(t0 + ms(6100)), Some(UnlockCause::Emergency));
        assert_eq!(describe_emergency(&limits), "hold f12 for 1000 ms");
    }

    #[test]
    fn hotplug_grabs_new_devices_and_drops_unplugged_ones() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(t0, 60_000, None, LockDevices::Both, &LockLimits::default())
            .unwrap();
        assert_eq!(eng.grabbed_count(), 1);

        src.add("event5", true, true);
        assert_eq!(eng.tick(t0 + ms(500)), None);
        assert_eq!(
            eng.grabbed_count(),
            1,
            "not rescanned before HOTPLUG_INTERVAL"
        );
        assert_eq!(eng.tick(t0 + ms(1000)), None);
        assert_eq!(eng.grabbed_count(), 2);
        assert!(src.state("event5").lock().unwrap().grabbed);

        // The new device can trigger the emergency chord too.
        src.press("event5", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(1100)), None);
        assert_eq!(eng.tick(t0 + ms(6100)), Some(UnlockCause::Emergency));

        // Unplugging while locked drops the device without ending the lock.
        eng.lock(
            t0 + ms(7000),
            60_000,
            None,
            LockDevices::Both,
            &LockLimits::default(),
        )
        .unwrap();
        assert_eq!(eng.grabbed_count(), 2);
        src.remove("event5");
        assert_eq!(eng.tick(t0 + ms(7100)), None);
        assert_eq!(eng.grabbed_count(), 1);
        assert!(eng.is_locked());
        // ...and re-plugging it (same path) grabs it again on the next scan.
        src.add("event5", true, true);
        assert_eq!(eng.tick(t0 + ms(8100)), None);
        assert_eq!(eng.grabbed_count(), 2);
    }

    #[test]
    fn reason_is_truncated_and_empty_reason_dropped() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(
            t0,
            5000,
            Some("".into()),
            LockDevices::Both,
            &LockLimits::default(),
        )
        .unwrap();
        assert_eq!(eng.status(t0).unwrap().reason, None);
        let long = "r".repeat(REASON_MAX_CHARS + 50);
        eng.lock(
            t0,
            5000,
            Some(long),
            LockDevices::Both,
            &LockLimits::default(),
        )
        .unwrap();
        assert_eq!(
            eng.status(t0).unwrap().reason.unwrap().len(),
            REASON_MAX_CHARS
        );
    }

    #[test]
    fn drop_releases_grabs() {
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        {
            let mut eng = engine(&src);
            eng.lock(
                Instant::now(),
                5000,
                None,
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap();
            assert!(src.state("event0").lock().unwrap().grabbed);
        }
        assert!(!src.state("event0").lock().unwrap().grabbed);
    }

    #[test]
    fn keyboard_mode_grabs_keyboards_and_combo_devices_only() {
        let src = FakeSource::with_devices(&[
            ("event0", true, false),
            ("event1", false, true),
            ("event2", true, true),
        ]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        let out = eng
            .lock(
                t0,
                60_000,
                None,
                LockDevices::Keyboard,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(out.devices, LockDevices::Keyboard);
        assert_eq!(out.grabbed, 2);
        assert!(out.emergency_available);
        assert!(src.state("event0").lock().unwrap().grabbed);
        assert!(
            !src.state("event1").lock().unwrap().grabbed,
            "mouse stays free"
        );
        assert!(
            src.state("event2").lock().unwrap().grabbed,
            "keyboard with trackpoint is grabbed"
        );
        assert_eq!(eng.status(t0).unwrap().devices, LockDevices::Keyboard);

        // Hot-plugging a mouse while in keyboard mode must not grab it; a keyboard is grabbed.
        src.add("event7", false, true);
        src.add("event8", true, false);
        assert_eq!(eng.tick(t0 + ms(1000)), None);
        assert_eq!(eng.grabbed_count(), 3);
        assert!(!src.state("event7").lock().unwrap().grabbed);
        assert!(src.state("event8").lock().unwrap().grabbed);

        // Emergency chord works (keyboards are grabbed).
        src.press("event8", KEY_ESC);
        assert_eq!(eng.tick(t0 + ms(1100)), None);
        assert_eq!(eng.tick(t0 + ms(6100)), Some(UnlockCause::Emergency));
        for d in ["event0", "event2", "event8"] {
            assert!(!src.state(d).lock().unwrap().grabbed, "{d} released");
        }
    }

    #[test]
    fn mouse_mode_grabs_pointers_only_and_has_no_emergency_chord() {
        let src = FakeSource::with_devices(&[
            ("event0", true, false),
            ("event1", false, true),
            ("event2", true, true),
        ]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        let out = eng
            .lock(t0, 60_000, None, LockDevices::Mouse, &LockLimits::default())
            .unwrap();
        assert_eq!(out.devices, LockDevices::Mouse);
        assert_eq!(out.grabbed, 2);
        assert!(
            out.emergency_available,
            "the combo device has keys, so the chord still works there"
        );
        assert!(
            !src.state("event0").lock().unwrap().grabbed,
            "keyboard stays free"
        );
        assert!(src.state("event1").lock().unwrap().grabbed);
        assert!(src.state("event2").lock().unwrap().grabbed);

        // A hot-plugged keyboard is not grabbed; a hot-plugged touchpad is.
        src.add("event7", true, false);
        src.add("event8", false, true);
        assert_eq!(eng.tick(t0 + ms(1000)), None);
        assert!(!src.state("event7").lock().unwrap().grabbed);
        assert!(src.state("event8").lock().unwrap().grabbed);
        assert_eq!(eng.grabbed_count(), 3);

        // Pure-pointer lock: no keyboard grabbed → the chord cannot fire (the keyboard is free anyway).
        let src2 = FakeSource::with_devices(&[("event0", true, false), ("event1", false, true)]);
        let mut eng2 = engine(&src2);
        let out2 = eng2
            .lock(t0, 60_000, None, LockDevices::Mouse, &LockLimits::default())
            .unwrap();
        assert!(!out2.emergency_available);
        assert_eq!(out2.grabbed, 1);
        src2.press("event0", KEY_ESC);
        assert_eq!(eng2.tick(t0 + ms(100)), None);
        assert_eq!(
            eng2.tick(t0 + ms(6000)),
            None,
            "ungrabbed keyboard events are not seen"
        );
        assert!(eng2.is_locked());
        assert!(eng2.unlock(UnlockCause::Request));
        assert!(!src2.state("event1").lock().unwrap().grabbed);
    }

    #[test]
    fn both_mode_grabs_everything_and_no_matching_device_is_no_devices() {
        let src = FakeSource::with_devices(&[
            ("event0", true, false),
            ("event1", false, true),
            ("event2", true, true),
        ]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        let out = eng
            .lock(t0, 60_000, None, LockDevices::Both, &LockLimits::default())
            .unwrap();
        assert_eq!((out.devices, out.grabbed), (LockDevices::Both, 3));
        src.add("event9", false, true);
        assert_eq!(eng.tick(t0 + ms(1000)), None);
        assert_eq!(eng.grabbed_count(), 4);
        eng.unlock(UnlockCause::Request);
        assert_eq!(eng.grabbed_count(), 0);

        // Only a keyboard present: a mouse lock has nothing to grab.
        let src = FakeSource::with_devices(&[("event0", true, false)]);
        let mut eng = engine(&src);
        let err = eng
            .lock(t0, 5000, None, LockDevices::Mouse, &LockLimits::default())
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NoDevices);
        assert!(err.message.contains("pointer"));
        assert!(!eng.is_locked());
        assert!(eng
            .lock(
                t0,
                5000,
                None,
                LockDevices::Keyboard,
                &LockLimits::default()
            )
            .is_ok());
    }

    #[test]
    fn relock_with_a_different_class_swaps_the_grabs() {
        let src = FakeSource::with_devices(&[("event0", true, false), ("event1", false, true)]);
        let mut eng = engine(&src);
        let t0 = Instant::now();
        eng.lock(
            t0,
            60_000,
            None,
            LockDevices::Keyboard,
            &LockLimits::default(),
        )
        .unwrap();
        assert!(
            src.state("event0").lock().unwrap().grabbed
                && !src.state("event1").lock().unwrap().grabbed
        );
        let out = eng
            .lock(
                t0 + ms(10),
                60_000,
                None,
                LockDevices::Mouse,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(out.grabbed, 1);
        assert!(
            !src.state("event0").lock().unwrap().grabbed
                && src.state("event1").lock().unwrap().grabbed
        );
        assert_eq!(eng.status(t0 + ms(20)).unwrap().devices, LockDevices::Mouse);
        let out = eng
            .lock(
                t0 + ms(20),
                60_000,
                None,
                LockDevices::Both,
                &LockLimits::default(),
            )
            .unwrap();
        assert_eq!(out.grabbed, 2);
        assert_eq!(
            src.state("event1").lock().unwrap().grab_count,
            1,
            "still-selected devices are kept, not re-grabbed"
        );

        // Re-locking a class with no devices ends the lock instead of leaving it half-applied.
        src.remove("event0");
        assert_eq!(
            eng.tick(t0 + ms(25)),
            None,
            "the unplugged keyboard is dropped on the next tick"
        );
        assert_eq!(eng.grabbed_count(), 1);
        let err = eng
            .lock(
                t0 + ms(30),
                60_000,
                None,
                LockDevices::Keyboard,
                &LockLimits::default(),
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NoDevices);
        assert!(!eng.is_locked());
        assert!(!src.state("event1").lock().unwrap().grabbed);
    }
}
