//! Virtual terminals: which one is in the foreground, switching back to the one the app's
//! session owns, and the bounded switch lock (`VT_LOCKSWITCH`).
//!
//! All three need `CAP_SYS_TTY_CONFIG` on a VT file descriptor, which is why they live here
//! rather than in the app: `/dev/tty0` is root-only, and a lock that the app could take
//! without a time limit would be a way to strand the user on one screen for good.
//!
//! The kernel side is behind [`VtConsole`] so the state machine ([`VtEngine`]) is driven by a
//! fake in tests and by the ioctls in [`RealConsole`] in production. Like [`crate::lock`], the
//! engine owns no threads and no clock: the daemon calls [`VtEngine::tick`] with the current
//! time, and the lock is released by the timer, by `vt-unlock`, when the connection that took
//! it goes away, when the input lock's emergency chord fires, and at shutdown.

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::policy::VtLimits;
use crate::protocol::{DaemonError, ErrorCode, VtInfo, VtLockInfo, REASON_MAX_CHARS};

/// The VT device the daemon drives. `/dev/tty0` is "whichever VT is in the foreground", which
/// is the one the kernel accepts these ioctls on.
pub const DEFAULT_CONSOLE_PATH: &str = "/dev/tty0";

/// Why a switch lock ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VtUnlockCause {
    Timer,
    Request,
    /// The connection that took the lock went away (the app crashed or was killed).
    PeerGone,
    /// The input lock's emergency chord: whoever is at the keyboard gets everything back at once.
    Emergency,
    Shutdown,
}

impl fmt::Display for VtUnlockCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            VtUnlockCause::Timer => "timer expired",
            VtUnlockCause::Request => "unlock request",
            VtUnlockCause::PeerGone => "the app that locked it went away",
            VtUnlockCause::Emergency => "emergency chord",
            VtUnlockCause::Shutdown => "daemon shutdown",
        })
    }
}

/// The kernel operations on a VT (`/dev/tty0` in production, a fake in tests).
pub trait VtConsole: Send {
    /// The VT currently in the foreground (`VT_GETSTATE.v_active`).
    fn active(&mut self) -> io::Result<u16>;
    /// Bring `vt` to the foreground (`VT_ACTIVATE`). Fails while switching is locked, which is
    /// why [`VtEngine::activate`] lifts its own lock around the call.
    fn activate(&mut self, vt: u16) -> io::Result<()>;
    /// `VT_LOCKSWITCH` / `VT_UNLOCKSWITCH`: refuse (or allow) every console switch, including
    /// the kernel's own answer to ctrl+alt+F<n> and the ones logind and the compositor ask for.
    fn set_switch_locked(&mut self, locked: bool) -> io::Result<()>;
}

/// Result of a successful `vt-lock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtLockOutcome {
    pub until_unix_ms: u64,
    pub duration_ms: u64,
}

struct ActiveLock {
    until: Instant,
    until_unix_ms: u64,
    reason: Option<String>,
    /// The connection that took it, so it can be released when that connection drops.
    conn_id: u64,
}

/// The switch-lock state machine.
pub struct VtEngine {
    console: Box<dyn VtConsole>,
    active: Option<ActiveLock>,
    /// Set once the console could not be used at all, so `status` can say so without retrying
    /// every call (a container or a kernel built without VT support has no `/dev/tty0`).
    unavailable: Option<String>,
    /// Wall clock behind `until` (injectable for tests).
    wall: Box<dyn Fn() -> u64 + Send>,
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl VtEngine {
    pub fn new(console: Box<dyn VtConsole>) -> Self {
        VtEngine {
            console,
            active: None,
            unavailable: None,
            wall: Box::new(unix_ms_now),
        }
    }

    /// Use a fixed wall clock (tests).
    #[cfg(test)]
    pub fn with_wall_clock(mut self, wall: impl Fn() -> u64 + Send + 'static) -> Self {
        self.wall = Box::new(wall);
        self
    }

    #[cfg(test)]
    pub fn is_locked(&self) -> bool {
        self.active.is_some()
    }

    /// `vt-status` / `status.vt`: the foreground VT, the one `session_vt` resolved for the
    /// caller, and the lock. Never fails: a machine without VTs reports `available: false` and
    /// the reason, which is what the app shows instead of an error.
    pub fn status(&mut self, now: Instant, session: Option<u16>) -> VtInfo {
        let active = match self.console.active() {
            Ok(vt) => Some(vt),
            Err(e) => {
                self.unavailable = Some(e.to_string());
                None
            }
        };
        VtInfo {
            available: active.is_some(),
            active,
            session,
            locked: self.lock_info(now),
            unavailable: if active.is_some() {
                None
            } else {
                self.unavailable.clone()
            },
        }
    }

    fn lock_info(&self, now: Instant) -> Option<VtLockInfo> {
        let a = self.active.as_ref()?;
        if now >= a.until {
            return None; // expired but not yet ticked
        }
        Some(VtLockInfo {
            until: crate::protocol::iso_millis(a.until_unix_ms),
            reason: a.reason.clone(),
        })
    }

    /// Bring `vt` to the foreground. Returns whether the switch happened — `false` when it was
    /// already there, so a character can tell "I pulled them back" from "they never left".
    ///
    /// A lock of our own is lifted for the call and put back afterwards: the kernel refuses
    /// `VT_ACTIVATE` while `VT_LOCKSWITCH` is set, even for root, so locking the user in place
    /// would otherwise take away our own way of bringing them home.
    pub fn activate(&mut self, vt: u16, now: Instant) -> Result<bool, DaemonError> {
        let current = self.console.active().map_err(|e| self.io_err("read", e))?;
        if current == vt {
            return Ok(false);
        }
        // A lock whose time is up but which the ticker has not reached yet still holds the
        // kernel flag: let it go now rather than trying to switch against it (`VT_ACTIVATE`
        // would fail with EINVAL for the few milliseconds until the next tick).
        if self.active.as_ref().is_some_and(|a| now >= a.until) {
            self.unlock(VtUnlockCause::Timer);
        }
        let relock = self.active.is_some();
        if relock {
            // A failure here means the lock is still on and the switch cannot work; say so
            // rather than reporting a switch that did not happen.
            self.console
                .set_switch_locked(false)
                .map_err(|e| self.io_err("unlock for a switch", e))?;
        }
        let result = self
            .console
            .activate(vt)
            .map_err(|e| self.io_err(&format!("switch to VT {vt}"), e));
        if relock {
            if let Err(e) = self.console.set_switch_locked(true) {
                // The switch may well have worked; losing the lock is the lesser problem, but
                // it must not be reported as still being in place.
                log_warn!("could not re-apply the VT switch lock after switching to {vt}: {e}");
                self.active = None;
            }
        }
        result.map(|()| true)
    }

    /// Take (or extend) the switch lock. `duration_ms` must already be clamped by the policy.
    pub fn lock(
        &mut self,
        now: Instant,
        duration_ms: u64,
        reason: Option<String>,
        conn_id: u64,
    ) -> Result<VtLockOutcome, DaemonError> {
        let reason = reason
            .map(|r| r.chars().take(REASON_MAX_CHARS).collect::<String>())
            .filter(|r| !r.is_empty());
        if self.active.is_none() {
            self.console
                .set_switch_locked(true)
                .map_err(|e| self.io_err("lock VT switching", e))?;
        }
        let until_unix_ms = (self.wall)() + duration_ms;
        self.active = Some(ActiveLock {
            until: now + Duration::from_millis(duration_ms),
            until_unix_ms,
            reason,
            conn_id,
        });
        Ok(VtLockOutcome {
            until_unix_ms,
            duration_ms,
        })
    }

    /// Allow switching again. Returns whether a lock was in place.
    pub fn unlock(&mut self, cause: VtUnlockCause) -> bool {
        let was_locked = self.active.take().is_some();
        // Cleared unconditionally: a lock left behind by a crashed daemon is exactly the state
        // this must get out of, and `VT_UNLOCKSWITCH` on an unlocked console is a no-op.
        if let Err(e) = self.console.set_switch_locked(false) {
            if was_locked {
                log_error!("could not unlock VT switching ({cause}): {e}");
            }
            return was_locked;
        }
        if was_locked {
            log_info!("VT switching unlocked ({cause})");
        }
        was_locked
    }

    /// Expire the timer. Returns the cause when this tick ended the lock.
    pub fn tick(&mut self, now: Instant) -> Option<VtUnlockCause> {
        let active = self.active.as_ref()?;
        if now < active.until {
            return None;
        }
        self.unlock(VtUnlockCause::Timer);
        Some(VtUnlockCause::Timer)
    }

    /// Release a lock held by a connection that went away. Returns whether one was released.
    pub fn release_for_conn(&mut self, conn_id: u64) -> bool {
        if self.active.as_ref().is_some_and(|a| a.conn_id == conn_id) {
            return self.unlock(VtUnlockCause::PeerGone);
        }
        false
    }

    /// A `vt-lock` the policy refuses, as the error the caller gets.
    pub fn disabled_error(limits: &VtLimits) -> Option<DaemonError> {
        if limits.enabled {
            return None;
        }
        Some(DaemonError::new(
            ErrorCode::Policy,
            "virtual-terminal control is disabled by policy (vtLock.enabled: false)",
        ))
    }

    fn io_err(&mut self, what: &str, e: io::Error) -> DaemonError {
        let msg = format!("could not {what} on the console: {e}");
        if e.kind() == io::ErrorKind::NotFound || e.kind() == io::ErrorKind::PermissionDenied {
            self.unavailable = Some(e.to_string());
        }
        DaemonError::new(ErrorCode::Internal, msg)
    }
}

// ---------------------------------------------------------------------------
// The real console: VT ioctls on /dev/tty0
// ---------------------------------------------------------------------------

mod ioctls {
    use nix::libc;

    pub const VT_GETSTATE: libc::c_ulong = 0x5603;
    pub const VT_ACTIVATE: libc::c_ulong = 0x5606;
    pub const VT_LOCKSWITCH: libc::c_ulong = 0x560B;
    pub const VT_UNLOCKSWITCH: libc::c_ulong = 0x560C;

    /// `struct vt_stat` from `<linux/vt.h>`.
    #[repr(C)]
    #[derive(Default)]
    pub struct VtStat {
        pub v_active: libc::c_ushort,
        pub v_signal: libc::c_ushort,
        pub v_state: libc::c_ushort,
    }
}

/// `/dev/tty0` and the VT ioctls on it. The file is opened per call: holding a root-only
/// console file descriptor open for the daemon's whole life buys nothing, and an open VT is
/// one more thing to get wrong.
pub struct RealConsole {
    path: PathBuf,
}

impl RealConsole {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        RealConsole { path: path.into() }
    }

    /// `/dev/tty0`.
    pub fn default_path() -> Self {
        RealConsole::new(DEFAULT_CONSOLE_PATH)
    }

    fn open(&self) -> io::Result<std::fs::File> {
        // Write access is what the kernel checks for `VT_ACTIVATE` on a VT that is not ours.
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
    }
}

impl VtConsole for RealConsole {
    fn active(&mut self) -> io::Result<u16> {
        use std::os::unix::io::AsRawFd;
        let file = self.open()?;
        let mut stat = ioctls::VtStat::default();
        // SAFETY: `file` is an open VT and `stat` is a live `vt_stat`, which is what
        // VT_GETSTATE writes through the pointer.
        let rc = unsafe { nix::libc::ioctl(file.as_raw_fd(), ioctls::VT_GETSTATE, &mut stat) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(stat.v_active)
    }

    fn activate(&mut self, vt: u16) -> io::Result<()> {
        use std::os::unix::io::AsRawFd;
        let file = self.open()?;
        // SAFETY: VT_ACTIVATE takes the VT number by value, not a pointer.
        let rc = unsafe {
            nix::libc::ioctl(
                file.as_raw_fd(),
                ioctls::VT_ACTIVATE,
                vt as nix::libc::c_int,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn set_switch_locked(&mut self, locked: bool) -> io::Result<()> {
        use std::os::unix::io::AsRawFd;
        let file = self.open()?;
        let op = if locked {
            ioctls::VT_LOCKSWITCH
        } else {
            ioctls::VT_UNLOCKSWITCH
        };
        // SAFETY: both take no argument at all; the third parameter is ignored.
        let rc = unsafe { nix::libc::ioctl(file.as_raw_fd(), op, 0) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// A fake console for the tests here and in `main.rs`
// ---------------------------------------------------------------------------

/// A [`VtConsole`] that records what it was asked to do, so the engine and the request
/// handlers are exercised without `/dev/tty0` (which only root can open).
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct FakeState {
        pub active: u16,
        pub locked: bool,
        /// Errors to return, in order: `(op, error)`.
        pub fail: Vec<(&'static str, io::ErrorKind)>,
        pub calls: Vec<String>,
    }

    #[derive(Clone)]
    pub struct FakeConsole(Arc<Mutex<FakeState>>);

    impl FakeConsole {
        pub fn new(active: u16) -> (FakeConsole, Arc<Mutex<FakeState>>) {
            let state = Arc::new(Mutex::new(FakeState {
                active,
                ..Default::default()
            }));
            (FakeConsole(state.clone()), state)
        }

        fn take_failure(&mut self, op: &str) -> Option<io::Error> {
            let mut s = self.0.lock().unwrap();
            let idx = s.fail.iter().position(|(o, _)| *o == op)?;
            let (_, kind) = s.fail.remove(idx);
            Some(io::Error::new(kind, format!("fake {op} failure")))
        }
    }

    impl VtConsole for FakeConsole {
        fn active(&mut self) -> io::Result<u16> {
            if let Some(e) = self.take_failure("active") {
                return Err(e);
            }
            let s = self.0.lock().unwrap();
            Ok(s.active)
        }

        fn activate(&mut self, vt: u16) -> io::Result<()> {
            if let Some(e) = self.take_failure("activate") {
                return Err(e);
            }
            let mut s = self.0.lock().unwrap();
            if s.locked {
                // What the kernel does: `set_console` refuses while `vt_dont_switch` is set.
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            s.calls.push(format!("activate {vt}"));
            s.active = vt;
            Ok(())
        }

        fn set_switch_locked(&mut self, locked: bool) -> io::Result<()> {
            if let Some(e) = self.take_failure("set_switch_locked") {
                return Err(e);
            }
            let mut s = self.0.lock().unwrap();
            s.locked = locked;
            s.calls.push(format!("lock {locked}"));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{FakeConsole, FakeState};
    use super::*;
    use std::sync::{Arc, Mutex};

    fn engine(active: u16) -> (VtEngine, Arc<Mutex<FakeState>>) {
        let (console, state) = FakeConsole::new(active);
        (
            VtEngine::new(Box::new(console)).with_wall_clock(|| 1_000_000),
            state,
        )
    }

    #[test]
    fn status_reports_the_foreground_vt_and_the_session() {
        let (mut vt, _state) = engine(2);
        let info = vt.status(Instant::now(), Some(2));
        assert_eq!(info.active, Some(2));
        assert_eq!(info.session, Some(2));
        assert!(info.available && info.locked.is_none());
        assert_eq!(info.unavailable, None);
    }

    #[test]
    fn status_without_a_console_says_so_instead_of_failing() {
        let (console, state) = FakeConsole::new(1);
        state
            .lock()
            .unwrap()
            .fail
            .push(("active", io::ErrorKind::NotFound));
        let mut vt = VtEngine::new(Box::new(console));
        let info = vt.status(Instant::now(), None);
        assert!(!info.available);
        assert_eq!(info.active, None);
        assert!(info.unavailable.is_some());
    }

    #[test]
    fn activate_switches_back_and_reports_whether_it_had_to() {
        let (mut vt, state) = engine(3);
        assert_eq!(vt.activate(2, Instant::now()), Ok(true));
        assert_eq!(state.lock().unwrap().active, 2);
        assert_eq!(
            vt.activate(2, Instant::now()),
            Ok(false),
            "already there: nothing to do"
        );
        assert_eq!(state.lock().unwrap().calls, vec!["activate 2".to_string()]);
    }

    #[test]
    fn activate_lifts_its_own_lock_for_the_switch_and_puts_it_back() {
        let now = Instant::now();
        let (mut vt, state) = engine(2);
        vt.lock(now, 60_000, None, 7).unwrap();
        assert!(state.lock().unwrap().locked);
        // The user got to VT 3 some other way (or was there before the lock): we can still
        // bring them back, because the lock is lifted around the switch.
        state.lock().unwrap().active = 3;
        assert_eq!(vt.activate(2, now), Ok(true));
        let s = state.lock().unwrap();
        assert_eq!(s.active, 2);
        assert!(s.locked, "the lock is back on afterwards");
        assert_eq!(
            s.calls,
            vec!["lock true", "lock false", "activate 2", "lock true"]
        );
        drop(s);
        assert!(vt.is_locked());
    }

    #[test]
    fn a_switch_in_the_moment_between_expiry_and_the_tick_still_works() {
        let t0 = Instant::now();
        let (mut vt, state) = engine(2);
        vt.lock(t0, 1_000, None, 7).unwrap();
        state.lock().unwrap().active = 3;
        // The deadline has passed but `tick` has not run yet, so the kernel flag is still set.
        let after = t0 + Duration::from_millis(1_500);
        assert_eq!(vt.activate(2, after), Ok(true));
        let s = state.lock().unwrap();
        assert_eq!(s.active, 2);
        assert!(
            !s.locked,
            "the expired lock was let go rather than re-applied"
        );
        drop(s);
        assert!(!vt.is_locked());
        assert_eq!(vt.tick(after), None, "nothing left for the ticker to do");
    }

    #[test]
    fn lock_expires_on_the_timer_and_unlocks_the_console() {
        let t0 = Instant::now();
        let (mut vt, state) = engine(2);
        let out = vt
            .lock(t0, 5_000, Some("reading to you".into()), 7)
            .unwrap();
        assert_eq!(out.duration_ms, 5_000);
        assert_eq!(out.until_unix_ms, 1_005_000);
        assert_eq!(
            vt.status(t0, Some(2)).locked,
            Some(VtLockInfo {
                until: crate::protocol::iso_millis(1_005_000),
                reason: Some("reading to you".into()),
            })
        );
        assert_eq!(vt.tick(t0 + Duration::from_millis(4_999)), None);
        assert_eq!(
            vt.tick(t0 + Duration::from_millis(5_000)),
            Some(VtUnlockCause::Timer)
        );
        assert!(!state.lock().unwrap().locked);
        assert!(!vt.is_locked());
        assert_eq!(vt.tick(t0 + Duration::from_millis(9_000)), None);
    }

    #[test]
    fn a_lock_is_released_when_its_connection_goes_away() {
        let t0 = Instant::now();
        let (mut vt, state) = engine(2);
        vt.lock(t0, 60_000, None, 7).unwrap();
        assert!(
            !vt.release_for_conn(8),
            "another connection's loss is not ours"
        );
        assert!(state.lock().unwrap().locked);
        assert!(vt.release_for_conn(7));
        assert!(!state.lock().unwrap().locked);
        assert!(!vt.release_for_conn(7), "already released");
    }

    #[test]
    fn unlock_clears_the_console_even_with_no_lock_recorded() {
        // A daemon that restarted while the kernel flag was set must be able to clear it.
        let (mut vt, state) = engine(2);
        state.lock().unwrap().locked = true;
        assert!(!vt.unlock(VtUnlockCause::Shutdown), "nothing was recorded");
        assert!(!state.lock().unwrap().locked, "but the console is unlocked");
    }

    #[test]
    fn a_failed_lock_is_an_error_and_leaves_nothing_behind() {
        let (console, state) = FakeConsole::new(2);
        state
            .lock()
            .unwrap()
            .fail
            .push(("set_switch_locked", io::ErrorKind::PermissionDenied));
        let mut vt = VtEngine::new(Box::new(console));
        let err = vt.lock(Instant::now(), 5_000, None, 7).unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(!vt.is_locked());
    }

    #[test]
    fn the_policy_switch_turns_every_vt_call_into_a_policy_error() {
        let on = VtLimits {
            enabled: true,
            ..VtLimits::default()
        };
        assert!(VtEngine::disabled_error(&on).is_none());
        let off = VtLimits {
            enabled: false,
            ..VtLimits::default()
        };
        assert_eq!(
            VtEngine::disabled_error(&off).map(|e| e.code),
            Some(ErrorCode::Policy)
        );
    }
}
