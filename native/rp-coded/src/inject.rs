//! Keystroke synthesis: US keymap, `ctrl+alt+t` combo parsing and the `Injector` trait
//! that the uinput implementation (`devices.rs`) and the test fake implement.
//!
//! Everything in this module is pure: a request is turned into a list of [`KeyAction`]s
//! (Linux `KEY_*` scancodes) which an injector plays back. The scancodes assume the
//! compositor uses a US QWERTY xkb layout; other layouts produce other characters.

#[cfg(test)]
use std::fmt;
use std::io;

use crate::protocol::{Button, DaemonError, ErrorCode, COMBO_MAX_CHARS, TEXT_MAX_CHARS};

// Linux input scancodes (linux/input-event-codes.h). Kept as plain u16 so this module and its
// tests do not depend on the evdev crate's types.
#[allow(dead_code)]
pub mod keys {
    pub const KEY_ESC: u16 = 1;
    pub const KEY_1: u16 = 2;
    pub const KEY_2: u16 = 3;
    pub const KEY_3: u16 = 4;
    pub const KEY_4: u16 = 5;
    pub const KEY_5: u16 = 6;
    pub const KEY_6: u16 = 7;
    pub const KEY_7: u16 = 8;
    pub const KEY_8: u16 = 9;
    pub const KEY_9: u16 = 10;
    pub const KEY_0: u16 = 11;
    pub const KEY_MINUS: u16 = 12;
    pub const KEY_EQUAL: u16 = 13;
    pub const KEY_BACKSPACE: u16 = 14;
    pub const KEY_TAB: u16 = 15;
    pub const KEY_Q: u16 = 16;
    pub const KEY_W: u16 = 17;
    pub const KEY_E: u16 = 18;
    pub const KEY_R: u16 = 19;
    pub const KEY_T: u16 = 20;
    pub const KEY_Y: u16 = 21;
    pub const KEY_U: u16 = 22;
    pub const KEY_I: u16 = 23;
    pub const KEY_O: u16 = 24;
    pub const KEY_P: u16 = 25;
    pub const KEY_LEFTBRACE: u16 = 26;
    pub const KEY_RIGHTBRACE: u16 = 27;
    pub const KEY_ENTER: u16 = 28;
    pub const KEY_LEFTCTRL: u16 = 29;
    pub const KEY_A: u16 = 30;
    pub const KEY_S: u16 = 31;
    pub const KEY_D: u16 = 32;
    pub const KEY_F: u16 = 33;
    pub const KEY_G: u16 = 34;
    pub const KEY_H: u16 = 35;
    pub const KEY_J: u16 = 36;
    pub const KEY_K: u16 = 37;
    pub const KEY_L: u16 = 38;
    pub const KEY_SEMICOLON: u16 = 39;
    pub const KEY_APOSTROPHE: u16 = 40;
    pub const KEY_GRAVE: u16 = 41;
    pub const KEY_LEFTSHIFT: u16 = 42;
    pub const KEY_BACKSLASH: u16 = 43;
    pub const KEY_Z: u16 = 44;
    pub const KEY_X: u16 = 45;
    pub const KEY_C: u16 = 46;
    pub const KEY_V: u16 = 47;
    pub const KEY_B: u16 = 48;
    pub const KEY_N: u16 = 49;
    pub const KEY_M: u16 = 50;
    pub const KEY_COMMA: u16 = 51;
    pub const KEY_DOT: u16 = 52;
    pub const KEY_SLASH: u16 = 53;
    pub const KEY_RIGHTSHIFT: u16 = 54;
    pub const KEY_LEFTALT: u16 = 56;
    pub const KEY_SPACE: u16 = 57;
    pub const KEY_CAPSLOCK: u16 = 58;
    pub const KEY_F1: u16 = 59;
    pub const KEY_F10: u16 = 68;
    pub const KEY_NUMLOCK: u16 = 69;
    pub const KEY_SCROLLLOCK: u16 = 70;
    pub const KEY_F11: u16 = 87;
    pub const KEY_F12: u16 = 88;
    pub const KEY_RIGHTCTRL: u16 = 97;
    pub const KEY_SYSRQ: u16 = 99;
    pub const KEY_RIGHTALT: u16 = 100;
    pub const KEY_HOME: u16 = 102;
    pub const KEY_UP: u16 = 103;
    pub const KEY_PAGEUP: u16 = 104;
    pub const KEY_LEFT: u16 = 105;
    pub const KEY_RIGHT: u16 = 106;
    pub const KEY_END: u16 = 107;
    pub const KEY_DOWN: u16 = 108;
    pub const KEY_PAGEDOWN: u16 = 109;
    pub const KEY_INSERT: u16 = 110;
    pub const KEY_DELETE: u16 = 111;
    pub const KEY_MUTE: u16 = 113;
    pub const KEY_VOLUMEDOWN: u16 = 114;
    pub const KEY_VOLUMEUP: u16 = 115;
    pub const KEY_PAUSE: u16 = 119;
    pub const KEY_LEFTMETA: u16 = 125;
    pub const KEY_RIGHTMETA: u16 = 126;
    pub const KEY_COMPOSE: u16 = 127;
    pub const KEY_NEXTSONG: u16 = 163;
    pub const KEY_PLAYPAUSE: u16 = 164;
    pub const KEY_PREVIOUSSONG: u16 = 165;
    pub const KEY_F13: u16 = 183;
    pub const KEY_F24: u16 = 194;
    pub const KEY_BRIGHTNESSDOWN: u16 = 224;
    pub const KEY_BRIGHTNESSUP: u16 = 225;
    pub const BTN_LEFT: u16 = 0x110;
    pub const BTN_RIGHT: u16 = 0x111;
    pub const BTN_MIDDLE: u16 = 0x112;

    /// `KEY_F<n>` for 1..=24.
    pub fn function_key(n: u32) -> Option<u16> {
        match n {
            1..=10 => Some(KEY_F1 + (n as u16 - 1)),
            11 => Some(KEY_F11),
            12 => Some(KEY_F12),
            13..=24 => Some(KEY_F13 + (n as u16 - 13)),
            _ => None,
        }
    }
}

use keys::*;

/// One key transition for the injector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Press(u16),
    Release(u16),
}

/// A key with the shift state needed to produce a character on a US layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keystroke {
    pub code: u16,
    pub shift: bool,
}

/// Map one character to a US-QWERTY keystroke. `None` for characters the layout cannot type.
pub fn char_to_keystroke(c: char) -> Option<Keystroke> {
    let plain = |code| Some(Keystroke { code, shift: false });
    let shifted = |code| Some(Keystroke { code, shift: true });
    match c {
        'a'..='z' => plain(letter(c)),
        'A'..='Z' => shifted(letter(c.to_ascii_lowercase())),
        '0' => plain(KEY_0),
        '1'..='9' => plain(KEY_1 + (c as u16 - '1' as u16)),
        ' ' => plain(KEY_SPACE),
        '\n' => plain(KEY_ENTER),
        '\t' => plain(KEY_TAB),
        '-' => plain(KEY_MINUS),
        '=' => plain(KEY_EQUAL),
        '[' => plain(KEY_LEFTBRACE),
        ']' => plain(KEY_RIGHTBRACE),
        ';' => plain(KEY_SEMICOLON),
        '\'' => plain(KEY_APOSTROPHE),
        '`' => plain(KEY_GRAVE),
        '\\' => plain(KEY_BACKSLASH),
        ',' => plain(KEY_COMMA),
        '.' => plain(KEY_DOT),
        '/' => plain(KEY_SLASH),
        '!' => shifted(KEY_1),
        '@' => shifted(KEY_2),
        '#' => shifted(KEY_3),
        '$' => shifted(KEY_4),
        '%' => shifted(KEY_5),
        '^' => shifted(KEY_6),
        '&' => shifted(KEY_7),
        '*' => shifted(KEY_8),
        '(' => shifted(KEY_9),
        ')' => shifted(KEY_0),
        '_' => shifted(KEY_MINUS),
        '+' => shifted(KEY_EQUAL),
        '{' => shifted(KEY_LEFTBRACE),
        '}' => shifted(KEY_RIGHTBRACE),
        ':' => shifted(KEY_SEMICOLON),
        '"' => shifted(KEY_APOSTROPHE),
        '~' => shifted(KEY_GRAVE),
        '|' => shifted(KEY_BACKSLASH),
        '<' => shifted(KEY_COMMA),
        '>' => shifted(KEY_DOT),
        '?' => shifted(KEY_SLASH),
        _ => None,
    }
}

fn letter(c: char) -> u16 {
    match c {
        'a' => KEY_A,
        'b' => KEY_B,
        'c' => KEY_C,
        'd' => KEY_D,
        'e' => KEY_E,
        'f' => KEY_F,
        'g' => KEY_G,
        'h' => KEY_H,
        'i' => KEY_I,
        'j' => KEY_J,
        'k' => KEY_K,
        'l' => KEY_L,
        'm' => KEY_M,
        'n' => KEY_N,
        'o' => KEY_O,
        'p' => KEY_P,
        'q' => KEY_Q,
        'r' => KEY_R,
        's' => KEY_S,
        't' => KEY_T,
        'u' => KEY_U,
        'v' => KEY_V,
        'w' => KEY_W,
        'x' => KEY_X,
        'y' => KEY_Y,
        'z' => KEY_Z,
        _ => unreachable!("letter() is only called with a-z"),
    }
}

/// Turn text into key actions. `\r\n` and `\r` count as one Enter. Returns the actions and
/// how many characters were skipped because the US keymap cannot produce them.
pub fn plan_text(text: &str) -> (Vec<KeyAction>, u32) {
    let mut actions = Vec::with_capacity(text.len() * 2);
    let mut skipped = 0u32;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let c = if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            '\n'
        } else {
            c
        };
        match char_to_keystroke(c) {
            Some(k) => {
                if k.shift {
                    actions.push(KeyAction::Press(KEY_LEFTSHIFT));
                }
                actions.push(KeyAction::Press(k.code));
                actions.push(KeyAction::Release(k.code));
                if k.shift {
                    actions.push(KeyAction::Release(KEY_LEFTSHIFT));
                }
            }
            None => skipped += 1,
        }
    }
    (actions, skipped)
}

/// A parsed `ctrl+alt+t` style combination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    /// Modifier scancodes in the order given (pressed first, released last).
    pub modifiers: Vec<u16>,
    /// The final key; `shift` means the key itself needs shift (e.g. `ctrl+!`).
    pub key: Keystroke,
}

impl Combo {
    pub fn actions(&self) -> Vec<KeyAction> {
        let mut out = Vec::with_capacity(self.modifiers.len() * 2 + 4);
        for &m in &self.modifiers {
            out.push(KeyAction::Press(m));
        }
        if self.key.shift {
            out.push(KeyAction::Press(KEY_LEFTSHIFT));
        }
        out.push(KeyAction::Press(self.key.code));
        out.push(KeyAction::Release(self.key.code));
        if self.key.shift {
            out.push(KeyAction::Release(KEY_LEFTSHIFT));
        }
        for &m in self.modifiers.iter().rev() {
            out.push(KeyAction::Release(m));
        }
        out
    }
}

/// Modifier names accepted in combos (case-insensitive).
fn modifier_code(name: &str) -> Option<u16> {
    Some(match name {
        "ctrl" | "control" | "lctrl" | "leftctrl" => KEY_LEFTCTRL,
        "rctrl" | "rightctrl" => KEY_RIGHTCTRL,
        "alt" | "lalt" | "leftalt" | "mod1" => KEY_LEFTALT,
        "ralt" | "rightalt" | "altgr" => KEY_RIGHTALT,
        "shift" | "lshift" | "leftshift" => KEY_LEFTSHIFT,
        "rshift" | "rightshift" => KEY_RIGHTSHIFT,
        "super" | "meta" | "win" | "cmd" | "mod4" | "lsuper" | "lmeta" => KEY_LEFTMETA,
        "rsuper" | "rmeta" => KEY_RIGHTMETA,
        _ => return None,
    })
}

/// Named keys accepted as the last combo element (case-insensitive; xdotool spellings too).
fn named_key(name: &str) -> Option<u16> {
    Some(match name {
        "enter" | "return" | "ret" | "kp_enter" => KEY_ENTER,
        "tab" => KEY_TAB,
        "esc" | "escape" => KEY_ESC,
        "space" => KEY_SPACE,
        "backspace" | "bs" => KEY_BACKSPACE,
        "delete" | "del" => KEY_DELETE,
        "insert" | "ins" => KEY_INSERT,
        "home" => KEY_HOME,
        "end" => KEY_END,
        "pageup" | "pgup" | "prior" => KEY_PAGEUP,
        "pagedown" | "pgdn" | "next" => KEY_PAGEDOWN,
        "up" => KEY_UP,
        "down" => KEY_DOWN,
        "left" => KEY_LEFT,
        "right" => KEY_RIGHT,
        "capslock" | "caps_lock" => KEY_CAPSLOCK,
        "numlock" | "num_lock" => KEY_NUMLOCK,
        "scrolllock" | "scroll_lock" => KEY_SCROLLLOCK,
        "print" | "printscreen" | "sysrq" => KEY_SYSRQ,
        "pause" | "break" => KEY_PAUSE,
        "menu" | "compose" => KEY_COMPOSE,
        "minus" => KEY_MINUS,
        "equal" | "equals" => KEY_EQUAL,
        "plus" => return None, // handled as the shifted char '+'
        "comma" => KEY_COMMA,
        "period" | "dot" => KEY_DOT,
        "slash" => KEY_SLASH,
        "backslash" => KEY_BACKSLASH,
        "semicolon" => KEY_SEMICOLON,
        "apostrophe" | "quote" => KEY_APOSTROPHE,
        "grave" => KEY_GRAVE,
        "bracketleft" => KEY_LEFTBRACE,
        "bracketright" => KEY_RIGHTBRACE,
        "mute" | "audiomute" | "xf86audiomute" => KEY_MUTE,
        "volumeup" | "audioraisevolume" | "xf86audioraisevolume" => KEY_VOLUMEUP,
        "volumedown" | "audiolowervolume" | "xf86audiolowervolume" => KEY_VOLUMEDOWN,
        "playpause" | "audioplay" | "xf86audioplay" => KEY_PLAYPAUSE,
        "nextsong" | "audionext" | "xf86audionext" => KEY_NEXTSONG,
        "previoussong" | "prevsong" | "audioprev" | "xf86audioprev" => KEY_PREVIOUSSONG,
        "brightnessup" | "xf86monbrightnessup" => KEY_BRIGHTNESSUP,
        "brightnessdown" | "xf86monbrightnessdown" => KEY_BRIGHTNESSDOWN,
        _ => return None,
    })
}

/// Parse the final element of a combo: a named key, `F1`..`F24`, or a single character.
fn parse_key_token(token: &str, original: &str) -> Result<Keystroke, String> {
    let lower = token.to_ascii_lowercase();
    if let Some(code) = named_key(&lower) {
        return Ok(Keystroke { code, shift: false });
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if let Some(code) = function_key(n) {
            return Ok(Keystroke { code, shift: false });
        }
        return Err(format!("unknown function key {original:?} (F1..F24)"));
    }
    if lower == "plus" {
        return Ok(Keystroke {
            code: KEY_EQUAL,
            shift: true,
        });
    }
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c != '\n' && c != '\t' && c != ' ' {
            if let Some(k) = char_to_keystroke(c) {
                // A bare letter in a combo is the key itself; `ctrl+S` means ctrl+s, not ctrl+shift+s.
                return Ok(Keystroke {
                    code: k.code,
                    shift: k.shift && !c.is_ascii_alphabetic(),
                });
            }
        }
    }
    Err(format!("unknown key {original:?}"))
}

/// Parse `ctrl+alt+t`, `Return`, `super+2`, `ctrl+shift+F5`, `shift+plus`, `ctrl++` ...
pub fn parse_combo(combo: &str) -> Result<Combo, String> {
    let trimmed = combo.trim();
    if trimmed.is_empty() {
        return Err("combo is empty".into());
    }
    if trimmed.chars().count() > COMBO_MAX_CHARS {
        return Err(format!("combo is longer than {COMBO_MAX_CHARS} characters"));
    }
    // Split on '+' and '-' (xdotool accepts both). A trailing separator is the key itself:
    // "ctrl++" → ctrl, "+"; "ctrl+-" → ctrl, "-"; a lone "+" or "-" is that key.
    let is_sep = |c: char| c == '+' || c == '-';
    let mut tokens: Vec<&str> = Vec::new();
    if trimmed.ends_with(is_sep) {
        let (head, key) = trimmed.split_at(trimmed.len() - 1);
        let head = match head.strip_suffix(is_sep) {
            Some(h) => h,
            None if head.is_empty() => head,
            None => return Err(format!("combo {combo:?} has no key")),
        };
        if !head.is_empty() {
            tokens.extend(head.split(is_sep));
        }
        tokens.push(key);
    } else {
        tokens.extend(trimmed.split(is_sep));
    }
    if tokens.iter().any(|t| t.is_empty()) {
        return Err(format!("combo {combo:?} has an empty element"));
    }
    let (last, mods) = tokens.split_last().expect("non-empty");
    let mut modifiers = Vec::with_capacity(mods.len());
    for m in mods {
        let code = modifier_code(&m.to_ascii_lowercase())
            .ok_or_else(|| format!("unknown modifier {m:?} in {combo:?}"))?;
        if !modifiers.contains(&code) {
            modifiers.push(code);
        }
    }
    let key = parse_key_token(last, combo)?;
    Ok(Combo { modifiers, key })
}

/// Validate a `type` request and plan its actions.
pub fn plan_type(text: &str) -> Result<(Vec<KeyAction>, u32), DaemonError> {
    if text.is_empty() {
        return Err(DaemonError::invalid("text must be a non-empty string"));
    }
    if text.chars().count() > TEXT_MAX_CHARS {
        return Err(DaemonError::invalid(format!(
            "text is longer than {TEXT_MAX_CHARS} characters"
        )));
    }
    Ok(plan_text(text))
}

/// Validate a `key` request and plan its actions.
pub fn plan_key(combo: &str) -> Result<Vec<KeyAction>, DaemonError> {
    parse_combo(combo)
        .map(|c| c.actions())
        .map_err(DaemonError::invalid)
}

/// Screen geometry the absolute pointer axes are mapped onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

impl Default for ScreenSize {
    fn default() -> Self {
        ScreenSize {
            width: 1920,
            height: 1080,
        }
    }
}

impl ScreenSize {
    /// Clamp a requested point to the axis ranges (`0..width-1`, `0..height-1`).
    pub fn clamp_point(&self, x: f64, y: f64) -> Result<(i32, i32), DaemonError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(DaemonError::invalid("x and y must be finite numbers"));
        }
        let cx = x.round().clamp(0.0, (self.width.max(1) - 1) as f64) as i32;
        let cy = y.round().clamp(0.0, (self.height.max(1) - 1) as f64) as i32;
        Ok((cx, cy))
    }
}

pub fn button_code(button: Button) -> u16 {
    match button {
        Button::Left => BTN_LEFT,
        Button::Right => BTN_RIGHT,
        Button::Middle => BTN_MIDDLE,
    }
}

/// Something that can play key actions and move/click an absolute pointer.
pub trait Injector: Send {
    /// Whether injection is possible at all (a uinput device exists).
    fn available(&self) -> bool;
    fn screen(&self) -> ScreenSize;
    /// Play the actions in order; each press/release is its own SYN_REPORT frame.
    fn play(&mut self, actions: &[KeyAction]) -> io::Result<()>;
    /// Move the pointer to an absolute position (already clamped to `screen()`).
    fn move_abs(&mut self, x: i32, y: i32) -> io::Result<()>;
    /// Press and release a mouse button at the current position.
    fn button(&mut self, code: u16) -> io::Result<()>;
}

/// An injector that has no uinput device; every action fails with `NO_DEVICES`.
#[derive(Debug, Default)]
pub struct NullInjector;

impl Injector for NullInjector {
    fn available(&self) -> bool {
        false
    }
    fn screen(&self) -> ScreenSize {
        ScreenSize::default()
    }
    fn play(&mut self, _: &[KeyAction]) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::NotFound, "no uinput device"))
    }
    fn move_abs(&mut self, _: i32, _: i32) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::NotFound, "no uinput device"))
    }
    fn button(&mut self, _: u16) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::NotFound, "no uinput device"))
    }
}

/// Recorded action of a [`FakeInjector`] (used by the server tests).
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    Key(KeyAction),
    Move(i32, i32),
    Button(u16),
}

#[cfg(test)]
impl fmt::Display for Recorded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Recorded::Key(KeyAction::Press(c)) => write!(f, "press {c}"),
            Recorded::Key(KeyAction::Release(c)) => write!(f, "release {c}"),
            Recorded::Move(x, y) => write!(f, "move {x},{y}"),
            Recorded::Button(c) => write!(f, "button {c:#x}"),
        }
    }
}

/// In-memory injector that records what it was asked to do.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct FakeInjector {
    pub screen: Option<ScreenSize>,
    pub recorded: Vec<Recorded>,
}

#[cfg(test)]
impl Injector for FakeInjector {
    fn available(&self) -> bool {
        true
    }
    fn screen(&self) -> ScreenSize {
        self.screen.unwrap_or_default()
    }
    fn play(&mut self, actions: &[KeyAction]) -> io::Result<()> {
        self.recorded
            .extend(actions.iter().map(|a| Recorded::Key(*a)));
        Ok(())
    }
    fn move_abs(&mut self, x: i32, y: i32) -> io::Result<()> {
        self.recorded.push(Recorded::Move(x, y));
        Ok(())
    }
    fn button(&mut self, code: u16) -> io::Result<()> {
        self.recorded.push(Recorded::Button(code));
        Ok(())
    }
}

/// Run a `type` / `key` / `click` / `move` request against an injector, mapping failures to
/// protocol errors. Returns the number of skipped characters for `type` (0 otherwise).
pub fn run_type(inj: &mut dyn Injector, text: &str) -> Result<u32, DaemonError> {
    let (actions, skipped) = plan_type(text)?;
    require(inj)?;
    inj.play(&actions).map_err(io_err)?;
    Ok(skipped)
}

pub fn run_key(inj: &mut dyn Injector, combo: &str) -> Result<(), DaemonError> {
    let actions = plan_key(combo)?;
    require(inj)?;
    inj.play(&actions).map_err(io_err)
}

pub fn run_move(inj: &mut dyn Injector, x: f64, y: f64) -> Result<(), DaemonError> {
    let (cx, cy) = inj.screen().clamp_point(x, y)?;
    require(inj)?;
    inj.move_abs(cx, cy).map_err(io_err)
}

pub fn run_click(
    inj: &mut dyn Injector,
    x: f64,
    y: f64,
    button: Button,
) -> Result<(), DaemonError> {
    run_move(inj, x, y)?;
    inj.button(button_code(button)).map_err(io_err)
}

fn require(inj: &dyn Injector) -> Result<(), DaemonError> {
    if inj.available() {
        Ok(())
    } else {
        Err(DaemonError::new(
            ErrorCode::NoDevices,
            "no uinput device (is the uinput module loaded and /dev/uinput writable?)",
        ))
    }
}

fn io_err(e: io::Error) -> DaemonError {
    match e.kind() {
        io::ErrorKind::NotFound => {
            DaemonError::new(ErrorCode::NoDevices, format!("uinput device gone: {e}"))
        }
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => {
            DaemonError::new(ErrorCode::Busy, format!("uinput busy: {e}"))
        }
        _ => DaemonError::internal(format!("uinput write failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyAction::{Press, Release};

    #[test]
    fn keymap_covers_printable_ascii() {
        for b in 0x20u8..0x7f {
            let c = b as char;
            let k = char_to_keystroke(c).unwrap_or_else(|| panic!("no mapping for {c:?}"));
            assert!(k.code > 0 && k.code < 0x100);
        }
        assert_eq!(
            char_to_keystroke('a'),
            Some(Keystroke {
                code: KEY_A,
                shift: false
            })
        );
        assert_eq!(
            char_to_keystroke('A'),
            Some(Keystroke {
                code: KEY_A,
                shift: true
            })
        );
        assert_eq!(
            char_to_keystroke('z'),
            Some(Keystroke {
                code: KEY_Z,
                shift: false
            })
        );
        assert_eq!(
            char_to_keystroke('0'),
            Some(Keystroke {
                code: KEY_0,
                shift: false
            })
        );
        assert_eq!(
            char_to_keystroke('9'),
            Some(Keystroke {
                code: KEY_9,
                shift: false
            })
        );
        assert_eq!(
            char_to_keystroke('!'),
            Some(Keystroke {
                code: KEY_1,
                shift: true
            })
        );
        assert_eq!(
            char_to_keystroke(')'),
            Some(Keystroke {
                code: KEY_0,
                shift: true
            })
        );
        assert_eq!(
            char_to_keystroke('?'),
            Some(Keystroke {
                code: KEY_SLASH,
                shift: true
            })
        );
        assert_eq!(
            char_to_keystroke('~'),
            Some(Keystroke {
                code: KEY_GRAVE,
                shift: true
            })
        );
        assert_eq!(
            char_to_keystroke('\n'),
            Some(Keystroke {
                code: KEY_ENTER,
                shift: false
            })
        );
        assert_eq!(
            char_to_keystroke('\t'),
            Some(Keystroke {
                code: KEY_TAB,
                shift: false
            })
        );
        assert_eq!(char_to_keystroke('é'), None);
        assert_eq!(char_to_keystroke('€'), None);
        assert_eq!(char_to_keystroke('\u{7f}'), None);
    }

    #[test]
    fn unshifted_and_shifted_keys_share_scancodes() {
        let pairs = [
            ('1', '!'),
            ('-', '_'),
            ('=', '+'),
            ('[', '{'),
            (';', ':'),
            ('\'', '"'),
            (',', '<'),
            ('/', '?'),
            ('\\', '|'),
        ];
        for (plain, shifted) in pairs {
            let p = char_to_keystroke(plain).unwrap();
            let s = char_to_keystroke(shifted).unwrap();
            assert_eq!(p.code, s.code, "{plain} / {shifted}");
            assert!(!p.shift && s.shift);
        }
    }

    #[test]
    fn plan_text_presses_and_releases_with_shift() {
        let (actions, skipped) = plan_text("aB");
        assert_eq!(skipped, 0);
        assert_eq!(
            actions,
            vec![
                Press(KEY_A),
                Release(KEY_A),
                Press(KEY_LEFTSHIFT),
                Press(KEY_B),
                Release(KEY_B),
                Release(KEY_LEFTSHIFT)
            ]
        );
    }

    #[test]
    fn plan_text_counts_skipped_and_normalises_newlines() {
        let (actions, skipped) = plan_text("é\r\nx\r");
        assert_eq!(skipped, 1);
        assert_eq!(
            actions,
            vec![
                Press(KEY_ENTER),
                Release(KEY_ENTER),
                Press(KEY_X),
                Release(KEY_X),
                Press(KEY_ENTER),
                Release(KEY_ENTER)
            ]
        );
        let (_, skipped) = plan_text("日本語");
        assert_eq!(skipped, 3);
    }

    #[test]
    fn plan_type_validates_length() {
        assert_eq!(plan_type("").unwrap_err().code, ErrorCode::Invalid);
        let long = "a".repeat(TEXT_MAX_CHARS + 1);
        assert_eq!(plan_type(&long).unwrap_err().code, ErrorCode::Invalid);
        let max = "a".repeat(TEXT_MAX_CHARS);
        assert_eq!(plan_type(&max).unwrap().0.len(), TEXT_MAX_CHARS * 2);
    }

    #[test]
    fn combo_parsing() {
        let c = parse_combo("ctrl+alt+t").unwrap();
        assert_eq!(c.modifiers, vec![KEY_LEFTCTRL, KEY_LEFTALT]);
        assert_eq!(
            c.key,
            Keystroke {
                code: KEY_T,
                shift: false
            }
        );
        assert_eq!(
            c.actions(),
            vec![
                Press(KEY_LEFTCTRL),
                Press(KEY_LEFTALT),
                Press(KEY_T),
                Release(KEY_T),
                Release(KEY_LEFTALT),
                Release(KEY_LEFTCTRL)
            ]
        );

        assert_eq!(
            parse_combo("Return").unwrap(),
            Combo {
                modifiers: vec![],
                key: Keystroke {
                    code: KEY_ENTER,
                    shift: false
                }
            }
        );
        assert_eq!(parse_combo("enter").unwrap().key.code, KEY_ENTER);
        assert_eq!(
            parse_combo("super+2").unwrap(),
            Combo {
                modifiers: vec![KEY_LEFTMETA],
                key: Keystroke {
                    code: KEY_2,
                    shift: false
                }
            }
        );
        assert_eq!(
            parse_combo("Meta+Shift+F5").unwrap().modifiers,
            vec![KEY_LEFTMETA, KEY_LEFTSHIFT]
        );
        assert_eq!(
            parse_combo("CTRL+S").unwrap().key,
            Keystroke {
                code: KEY_S,
                shift: false
            },
            "uppercase letter is not shifted"
        );
        assert_eq!(parse_combo("ctrl+shift+s").unwrap().actions().len(), 6);
        assert_eq!(parse_combo("F1").unwrap().key.code, KEY_F1);
        assert_eq!(parse_combo("f10").unwrap().key.code, KEY_F10);
        assert_eq!(parse_combo("F11").unwrap().key.code, KEY_F11);
        assert_eq!(parse_combo("F12").unwrap().key.code, KEY_F12);
        assert_eq!(parse_combo("F13").unwrap().key.code, KEY_F13);
        assert_eq!(parse_combo("F24").unwrap().key.code, KEY_F24);
        assert_eq!(parse_combo("Up").unwrap().key.code, KEY_UP);
        assert_eq!(parse_combo("alt+Tab").unwrap().key.code, KEY_TAB);
        assert_eq!(parse_combo("esc").unwrap().key.code, KEY_ESC);
        assert_eq!(parse_combo("Escape").unwrap().key.code, KEY_ESC);
        assert_eq!(parse_combo("space").unwrap().key.code, KEY_SPACE);
        assert_eq!(parse_combo("BackSpace").unwrap().key.code, KEY_BACKSPACE);
        assert_eq!(parse_combo("Delete").unwrap().key.code, KEY_DELETE);
        assert_eq!(parse_combo("Home").unwrap().key.code, KEY_HOME);
        assert_eq!(parse_combo("End").unwrap().key.code, KEY_END);
        assert_eq!(
            parse_combo("Page_Up".replace('_', "").as_str())
                .unwrap()
                .key
                .code,
            KEY_PAGEUP
        );
        assert_eq!(parse_combo("pagedown").unwrap().key.code, KEY_PAGEDOWN);
        assert_eq!(parse_combo("XF86AudioMute").unwrap().key.code, KEY_MUTE);
        // Symbols and separators.
        assert_eq!(
            parse_combo("ctrl+-").unwrap().key,
            Keystroke {
                code: KEY_MINUS,
                shift: false
            }
        );
        assert_eq!(
            parse_combo("ctrl++").unwrap().key,
            Keystroke {
                code: KEY_EQUAL,
                shift: true
            }
        );
        assert_eq!(
            parse_combo("ctrl+plus").unwrap().key,
            Keystroke {
                code: KEY_EQUAL,
                shift: true
            }
        );
        assert_eq!(parse_combo("ctrl+minus").unwrap().key.code, KEY_MINUS);
        assert_eq!(parse_combo("-").unwrap().key.code, KEY_MINUS);
        assert_eq!(
            parse_combo("+").unwrap().key,
            Keystroke {
                code: KEY_EQUAL,
                shift: true
            }
        );
        assert_eq!(
            parse_combo("ctrl-shift-t").unwrap().modifiers,
            vec![KEY_LEFTCTRL, KEY_LEFTSHIFT]
        );
        assert_eq!(
            parse_combo("ctrl+!").unwrap().key,
            Keystroke {
                code: KEY_1,
                shift: true
            }
        );
        // Duplicate modifiers collapse.
        assert_eq!(
            parse_combo("ctrl+control+c").unwrap().modifiers,
            vec![KEY_LEFTCTRL]
        );
    }

    #[test]
    fn combo_errors() {
        for bad in [
            "",
            "   ",
            "ctrl+",
            "ctrl+alt",
            "hyper+x",
            "ctrl+F25",
            "F0",
            "ctrl+é",
            "ctrl+ab",
            "nosuchkey",
            "+",
            "ctrl+space+x",
        ] {
            let res = parse_combo(bad);
            if bad == "+" {
                assert!(res.is_ok(), "a lone '+' is the plus key");
            } else {
                assert!(res.is_err(), "should reject {bad:?}: {res:?}");
            }
        }
        let long = format!("ctrl+{}", "a".repeat(COMBO_MAX_CHARS));
        assert!(parse_combo(&long).unwrap_err().contains("longer"));
        assert_eq!(plan_key("bogus+x").unwrap_err().code, ErrorCode::Invalid);
    }

    #[test]
    fn function_keys_map() {
        assert_eq!(function_key(0), None);
        assert_eq!(function_key(25), None);
        assert_eq!(function_key(10), Some(KEY_F10));
        assert_eq!(function_key(20), Some(KEY_F13 + 7));
    }

    #[test]
    fn screen_clamping() {
        let s = ScreenSize {
            width: 1920,
            height: 1080,
        };
        assert_eq!(s.clamp_point(10.4, 20.6).unwrap(), (10, 21));
        assert_eq!(s.clamp_point(-5.0, 5000.0).unwrap(), (0, 1079));
        assert_eq!(s.clamp_point(1920.0, 1080.0).unwrap(), (1919, 1079));
        assert_eq!(
            s.clamp_point(f64::NAN, 0.0).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(
            s.clamp_point(0.0, f64::INFINITY).unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn runners_drive_the_injector() {
        let mut inj = FakeInjector {
            screen: Some(ScreenSize {
                width: 800,
                height: 600,
            }),
            recorded: vec![],
        };
        assert_eq!(run_type(&mut inj, "Hi").unwrap(), 0);
        assert_eq!(
            run_type(&mut inj, "é").unwrap(),
            1,
            "all-skipped text still succeeds"
        );
        run_key(&mut inj, "ctrl+s").unwrap();
        run_click(&mut inj, 1000.0, -3.0, Button::Right).unwrap();
        run_move(&mut inj, 1.0, 2.0).unwrap();
        let tail: Vec<String> = inj
            .recorded
            .iter()
            .rev()
            .take(3)
            .map(|r| r.to_string())
            .collect();
        assert_eq!(tail, vec!["move 1,2", "button 0x111", "move 799,0"]);
        assert!(matches!(
            inj.recorded[0],
            Recorded::Key(Press(KEY_LEFTSHIFT))
        ));
        assert_eq!(run_type(&mut inj, "").unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(run_key(&mut inj, "").unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(
            run_move(&mut inj, f64::NAN, 0.0).unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn null_injector_reports_no_devices() {
        let mut inj = NullInjector;
        assert_eq!(
            run_type(&mut inj, "x").unwrap_err().code,
            ErrorCode::NoDevices
        );
        assert_eq!(
            run_key(&mut inj, "ctrl+c").unwrap_err().code,
            ErrorCode::NoDevices
        );
        assert_eq!(
            run_click(&mut inj, 1.0, 1.0, Button::Left)
                .unwrap_err()
                .code,
            ErrorCode::NoDevices
        );
        assert_eq!(
            run_move(&mut inj, 1.0, 1.0).unwrap_err().code,
            ErrorCode::NoDevices
        );
        // Validation errors still win over device availability.
        assert_eq!(run_type(&mut inj, "").unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(button_code(Button::Middle), BTN_MIDDLE);
    }
}
