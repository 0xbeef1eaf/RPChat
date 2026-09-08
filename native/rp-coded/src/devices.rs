//! Real devices: `/dev/input/event*` through the `evdev` crate (grabbing, draining) and the
//! uinput virtual keyboard+mouse used for injection. Nothing here is exercised by the unit
//! tests except the pure helpers (device classification, DRM mode parsing).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use evdev::{
    AbsInfo, AbsoluteAxisCode, AttributeSet, Device, EventType, InputEvent, KeyCode, PropType,
    RelativeAxisCode, UinputAbsSetup,
};

use crate::inject::{keys, Injector, KeyAction, ScreenSize};
use crate::lock::{DeviceInfo, DeviceSource, GrabbedDevice, KeyEvent};
use crate::protocol::DeviceCounts;

/// Directory scanned for input devices.
pub const INPUT_DIR: &str = "/dev/input";
/// Name of the virtual device created for injection; excluded from grabbing.
pub const VIRTUAL_DEVICE_NAME: &str = "rp-coded virtual input";
/// Where connector modes are read from.
pub const DRM_DIR: &str = "/sys/class/drm";
/// Time a key is held down when injecting (some toolkits drop press+release in the same frame).
pub const KEY_HOLD: Duration = Duration::from_millis(2);
/// Pause between pointer move and button press when clicking.
pub const CLICK_SETTLE: Duration = Duration::from_millis(5);

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/// Capability bits reduced to what the daemon cares about.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub has_letter_keys: bool,
    pub has_esc_or_enter: bool,
    pub has_mouse_button_or_touch: bool,
    pub has_rel_xy: bool,
    pub has_abs_xy: bool,
}

impl Capabilities {
    /// A device we should grab: reports keyboard keys, pointer buttons or motion.
    pub fn is_input(&self) -> bool {
        self.keyboard() || self.pointer()
    }
    /// Keyboard: EV_KEY with a typing key set (KEY_A / KEY_Q / KEY_SPACE). Devices that only
    /// have Esc/Enter (remotes, lid buttons) do not count.
    pub fn keyboard(&self) -> bool {
        self.has_letter_keys
    }
    /// Pointer: EV_REL motion (mice, trackpoints) or EV_ABS with BTN_LEFT/BTN_TOUCH/BTN_TOOL_*
    /// (touchpads, touchscreens, tablets). Joysticks (ABS without those buttons) and
    /// accelerometers are not pointers.
    pub fn pointer(&self) -> bool {
        self.has_rel_xy || (self.has_abs_xy && self.has_mouse_button_or_touch)
    }
}

fn capabilities(dev: &Device) -> Capabilities {
    let mut c = Capabilities::default();
    if let Some(keys) = dev.supported_keys() {
        c.has_letter_keys = keys.contains(KeyCode::KEY_A)
            || keys.contains(KeyCode::KEY_Q)
            || keys.contains(KeyCode::KEY_SPACE);
        c.has_esc_or_enter = keys.contains(KeyCode::KEY_ESC) || keys.contains(KeyCode::KEY_ENTER);
        c.has_mouse_button_or_touch = keys.contains(KeyCode::BTN_LEFT)
            || keys.contains(KeyCode::BTN_RIGHT)
            || keys.contains(KeyCode::BTN_TOUCH)
            || keys.contains(KeyCode::BTN_TOOL_FINGER)
            || keys.contains(KeyCode::BTN_STYLUS);
    }
    if let Some(rel) = dev.supported_relative_axes() {
        c.has_rel_xy =
            rel.contains(RelativeAxisCode::REL_X) || rel.contains(RelativeAxisCode::REL_Y);
    }
    if let Some(abs) = dev.supported_absolute_axes() {
        c.has_abs_xy = abs.contains(AbsoluteAxisCode::ABS_X)
            || abs.contains(AbsoluteAxisCode::ABS_MT_POSITION_X);
    }
    if dev.properties().contains(PropType::ACCELEROMETER) {
        // Accelerometers report ABS_X/Y but are not pointers.
        c.has_abs_xy = false;
    }
    c
}

/// Enumerate `/dev/input/event*`, classify each device, skip our own virtual device.
pub fn scan(dir: &Path) -> Vec<DeviceInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("event"))
        })
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let Ok(dev) = Device::open(&path) else {
            continue;
        };
        let name = dev.name().unwrap_or("").to_string();
        if name == VIRTUAL_DEVICE_NAME {
            continue;
        }
        let caps = capabilities(&dev);
        if !caps.is_input() {
            continue;
        }
        out.push(DeviceInfo {
            path: path.to_string_lossy().into_owned(),
            name,
            keyboard: caps.keyboard(),
            pointer: caps.pointer(),
        });
    }
    out
}

pub fn counts(devices: &[DeviceInfo], uinput: bool) -> DeviceCounts {
    DeviceCounts {
        keyboards: devices.iter().filter(|d| d.keyboard).count() as u32,
        pointers: devices.iter().filter(|d| d.pointer).count() as u32,
        uinput,
    }
}

// ---------------------------------------------------------------------------
// Grabbing
// ---------------------------------------------------------------------------

pub struct EvdevDevice {
    dev: Device,
    grabbed: bool,
}

impl GrabbedDevice for EvdevDevice {
    fn grab(&mut self) -> io::Result<()> {
        self.dev.grab()?;
        self.grabbed = true;
        Ok(())
    }

    fn ungrab(&mut self) -> io::Result<()> {
        if self.grabbed {
            self.grabbed = false;
            self.dev.ungrab()?;
        }
        Ok(())
    }

    fn drain(&mut self) -> io::Result<Vec<KeyEvent>> {
        let mut out = Vec::new();
        loop {
            match self.dev.fetch_events() {
                Ok(events) => {
                    let mut any = false;
                    for ev in events {
                        any = true;
                        if ev.event_type() == EventType::KEY {
                            out.push(KeyEvent {
                                code: ev.code(),
                                value: ev.value(),
                            });
                        }
                    }
                    if !any {
                        return Ok(out);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(out),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

/// `DeviceSource` over `/dev/input`.
#[derive(Debug)]
pub struct EvdevSource {
    dir: PathBuf,
}

impl EvdevSource {
    pub fn new() -> Self {
        EvdevSource {
            dir: PathBuf::from(INPUT_DIR),
        }
    }
}

impl Default for EvdevSource {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceSource for EvdevSource {
    fn list(&mut self) -> Vec<DeviceInfo> {
        scan(&self.dir)
    }

    fn open(&mut self, path: &str) -> io::Result<Box<dyn GrabbedDevice>> {
        let dev = Device::open(path)?;
        dev.set_nonblocking(true)?;
        Ok(Box::new(EvdevDevice {
            dev,
            grabbed: false,
        }))
    }
}

// ---------------------------------------------------------------------------
// Screen size from DRM
// ---------------------------------------------------------------------------

/// Parse the first `WIDTHxHEIGHT` line of a `modes` file.
pub fn parse_mode(text: &str) -> Option<(u32, u32)> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let (w, h) = line.trim().split_once('x')?;
    let h: String = h.chars().take_while(|c| c.is_ascii_digit()).collect();
    let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// Primary screen size: the preferred mode of the first connected DRM connector (sorted by
/// name, so `card0-eDP-1` / `card0-DP-1` win over later cards), else 1920x1080.
pub fn screen_size_from(drm_dir: &Path) -> ScreenSize {
    let Ok(entries) = fs::read_dir(drm_dir) else {
        return ScreenSize::default();
    };
    let mut connectors: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("modes").is_file())
        .collect();
    connectors.sort();
    for c in connectors {
        let connected = fs::read_to_string(c.join("status"))
            .map(|s| s.trim() == "connected")
            .unwrap_or(true);
        if !connected {
            continue;
        }
        if let Some((w, h)) = fs::read_to_string(c.join("modes"))
            .ok()
            .and_then(|t| parse_mode(&t))
        {
            return ScreenSize {
                width: w,
                height: h,
            };
        }
    }
    ScreenSize::default()
}

pub fn screen_size() -> ScreenSize {
    screen_size_from(Path::new(DRM_DIR))
}

// ---------------------------------------------------------------------------
// uinput injection
// ---------------------------------------------------------------------------

/// The one virtual keyboard+mouse. ABS_X/ABS_Y span `0..width-1` / `0..height-1` of the
/// screen size so `click`/`move` take global logical pixels; the compositor maps the absolute
/// range onto the output (the whole layout on wlroots/Hyprland when no mapping is configured).
pub struct UinputInjector {
    dev: evdev::uinput::VirtualDevice,
    screen: ScreenSize,
}

impl UinputInjector {
    pub fn create(screen: ScreenSize) -> io::Result<Self> {
        let mut keys: AttributeSet<KeyCode> = AttributeSet::new();
        for code in 1u16..=keys::KEY_F24.max(keys::KEY_BRIGHTNESSUP) {
            keys.insert(KeyCode(code));
        }
        for code in [keys::BTN_LEFT, keys::BTN_RIGHT, keys::BTN_MIDDLE] {
            keys.insert(KeyCode(code));
        }
        let mut rel: AttributeSet<RelativeAxisCode> = AttributeSet::new();
        rel.insert(RelativeAxisCode::REL_X);
        rel.insert(RelativeAxisCode::REL_Y);
        rel.insert(RelativeAxisCode::REL_WHEEL);
        let abs_x = UinputAbsSetup::new(
            AbsoluteAxisCode::ABS_X,
            AbsInfo::new(0, 0, screen.width.max(2) as i32 - 1, 0, 0, 0),
        );
        let abs_y = UinputAbsSetup::new(
            AbsoluteAxisCode::ABS_Y,
            AbsInfo::new(0, 0, screen.height.max(2) as i32 - 1, 0, 0, 0),
        );
        let mut props: AttributeSet<PropType> = AttributeSet::new();
        props.insert(PropType::POINTER);
        let dev = evdev::uinput::VirtualDevice::builder()?
            .name(VIRTUAL_DEVICE_NAME)
            .with_keys(&keys)?
            .with_relative_axes(&rel)?
            .with_absolute_axis(&abs_x)?
            .with_absolute_axis(&abs_y)?
            .with_properties(&props)?
            .build()?;
        // Give udev/libinput a moment to pick the new node up before the first injection.
        thread::sleep(Duration::from_millis(200));
        Ok(UinputInjector { dev, screen })
    }

    fn key(&mut self, code: u16, value: i32) -> io::Result<()> {
        self.dev
            .emit(&[InputEvent::new(EventType::KEY.0, code, value)])
    }
}

impl Injector for UinputInjector {
    fn available(&self) -> bool {
        true
    }

    fn screen(&self) -> ScreenSize {
        self.screen
    }

    fn play(&mut self, actions: &[KeyAction]) -> io::Result<()> {
        for a in actions {
            match *a {
                KeyAction::Press(code) => self.key(code, 1)?,
                KeyAction::Release(code) => self.key(code, 0)?,
            }
            thread::sleep(KEY_HOLD);
        }
        Ok(())
    }

    fn move_abs(&mut self, x: i32, y: i32) -> io::Result<()> {
        self.dev.emit(&[
            InputEvent::new(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_X.0, x),
            InputEvent::new(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_Y.0, y),
        ])
    }

    fn button(&mut self, code: u16) -> io::Result<()> {
        thread::sleep(CLICK_SETTLE);
        self.key(code, 1)?;
        thread::sleep(KEY_HOLD);
        self.key(code, 0)
    }
}

/// Whether `/dev/uinput` exists and is writable by us.
pub fn uinput_writable() -> bool {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/uinput")
        .is_ok()
}

/// Human-readable report for `--check-devices`. Exit code is always 0; missing devices are a
/// finding, not a failure.
pub fn check_devices_report() -> String {
    let mut out = String::new();
    let devices = scan(Path::new(INPUT_DIR));
    let uinput = uinput_writable();
    let c = counts(&devices, uinput);
    if !Path::new(INPUT_DIR).is_dir() {
        out.push_str(
            "input: /dev/input does not exist — no devices (container or no input subsystem)\n",
        );
    } else if devices.is_empty() {
        out.push_str("input: no keyboard or pointer devices found in /dev/input (or not readable — run as root)\n");
    } else {
        out.push_str(&format!(
            "input: {} keyboard(s), {} pointer(s)\n",
            c.keyboards, c.pointers
        ));
        for d in &devices {
            let kind = match (d.keyboard, d.pointer) {
                (true, true) => "keyboard+pointer",
                (true, false) => "keyboard",
                _ => "pointer",
            };
            out.push_str(&format!("  {:<22} {:<16} {}\n", d.path, kind, d.name));
        }
    }
    if uinput {
        out.push_str("uinput: /dev/uinput is writable (injection available)\n");
    } else if Path::new("/dev/uinput").exists() {
        out.push_str(
            "uinput: /dev/uinput exists but is not writable (need root or the rp-code udev rule)\n",
        );
    } else {
        out.push_str("uinput: /dev/uinput missing — `modprobe uinput` (the installer adds modules-load.d/rp-code.conf)\n");
    }
    let s = screen_size();
    out.push_str(&format!(
        "screen: {}x{} (from {DRM_DIR}, fallback 1920x1080)\n",
        s.width, s.height
    ));
    out.push_str(&format!(
        "summary: keyboards={} pointers={} uinput={} → lock {}, inject {}\n",
        c.keyboards,
        c.pointers,
        uinput,
        if c.keyboards + c.pointers > 0 {
            "available"
        } else {
            "unavailable (no devices)"
        },
        if uinput { "available" } else { "unavailable" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn parse_drm_modes() {
        assert_eq!(parse_mode("2560x1440\n1920x1080\n"), Some((2560, 1440)));
        assert_eq!(parse_mode("\n1920x1080i\n"), Some((1920, 1080)));
        assert_eq!(parse_mode(""), None);
        assert_eq!(parse_mode("garbage"), None);
        assert_eq!(parse_mode("0x0"), None);
    }

    #[test]
    fn screen_size_prefers_first_connected_connector() {
        let dir = tempfile::tempdir().unwrap();
        for (name, status, modes) in [
            ("card0-DP-1", "disconnected", ""),
            ("card0-eDP-1", "connected", "1600x900\n"),
            ("card1-HDMI-A-1", "connected", "3840x2160\n"),
        ] {
            let c = dir.path().join(name);
            fs::create_dir_all(&c).unwrap();
            File::create(c.join("status"))
                .unwrap()
                .write_all(status.as_bytes())
                .unwrap();
            File::create(c.join("modes"))
                .unwrap()
                .write_all(modes.as_bytes())
                .unwrap();
        }
        assert_eq!(
            screen_size_from(dir.path()),
            ScreenSize {
                width: 1600,
                height: 900
            }
        );
        assert_eq!(
            screen_size_from(&dir.path().join("missing")),
            ScreenSize::default()
        );
    }

    #[test]
    fn scan_without_input_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(&dir.path().join("nope")).is_empty());
        // Non-device files named event* are skipped (open fails).
        File::create(dir.path().join("event0")).unwrap();
        assert!(scan(dir.path()).is_empty());
        assert_eq!(counts(&[], false), DeviceCounts::default());
        let mut src = EvdevSource {
            dir: dir.path().to_path_buf(),
        };
        assert!(src.list().is_empty());
        assert!(src.open("/nonexistent/event9").is_err());
    }

    #[test]
    fn capability_classification() {
        let kb = Capabilities {
            has_letter_keys: true,
            ..Default::default()
        };
        assert!(kb.keyboard() && !kb.pointer() && kb.is_input());
        let mouse = Capabilities {
            has_rel_xy: true,
            has_mouse_button_or_touch: true,
            ..Default::default()
        };
        assert!(!mouse.keyboard() && mouse.pointer());
        let touchpad = Capabilities {
            has_abs_xy: true,
            has_mouse_button_or_touch: true,
            ..Default::default()
        };
        assert!(touchpad.pointer());
        let joystick = Capabilities {
            has_abs_xy: true,
            ..Default::default()
        };
        assert!(!joystick.is_input());
        let remote = Capabilities {
            has_esc_or_enter: true,
            ..Default::default()
        };
        assert!(!remote.is_input());
        let thinkpad = Capabilities {
            has_letter_keys: true,
            has_rel_xy: true,
            has_mouse_button_or_touch: true,
            ..Default::default()
        };
        assert!(thinkpad.keyboard() && thinkpad.pointer());
        let power_button = Capabilities::default();
        assert!(!power_button.is_input());
        let counted = counts(
            &[
                DeviceInfo {
                    path: "a".into(),
                    name: "a".into(),
                    keyboard: true,
                    pointer: false,
                },
                DeviceInfo {
                    path: "b".into(),
                    name: "b".into(),
                    keyboard: true,
                    pointer: true,
                },
            ],
            true,
        );
        assert_eq!(
            counted,
            DeviceCounts {
                keyboards: 2,
                pointers: 1,
                uinput: true
            }
        );
    }

    #[test]
    fn check_devices_report_runs_without_devices() {
        let report = check_devices_report();
        assert!(report.contains("summary:"));
        assert!(report.contains("screen:"));
    }
}
