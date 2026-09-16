//! The root-owned policy file (`/etc/rp-code/policy.json`).
//!
//! The daemon only interprets `inputLock`; the `settings` block is validated for shape and
//! handed to the app verbatim through the `policy` request. Loading is cached on the file's
//! mtime so re-reading on every `policy`/`lock` request is cheap.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::remote::{PackRules, PacksPolicy, RemotePolicy, RemoteRules};
use crate::seal::{LockPolicy, LockRules};

/// Default policy file location (`POLICY_FILE_PATH` in `@rp/shared`).
pub const DEFAULT_POLICY_PATH: &str = "/etc/rp-code/policy.json";

/// Shortest lock the daemon will hold (matches the app's `INPUT_LOCK_MIN_MS`).
pub const MIN_LOCK_MS: u64 = 1000;
/// `inputLock.maxDurationMs` default.
pub const DEFAULT_MAX_LOCK_MS: u64 = 300_000;
/// `inputLock.emergencyHoldMs` default and bounds.
pub const DEFAULT_EMERGENCY_HOLD_MS: u64 = 5000;
pub const MIN_EMERGENCY_HOLD_MS: u64 = 500;
pub const MAX_EMERGENCY_HOLD_MS: u64 = 60_000;
/// Refuse absurd policy files instead of parsing them.
pub const MAX_POLICY_BYTES: u64 = 256 * 1024;

/// Key that ends a lock when held (`inputLock.emergencyKey`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmergencyKey {
    #[default]
    Esc,
    F1,
    F12,
    Pause,
}

impl EmergencyKey {
    /// Linux `KEY_*` scancode of this key.
    pub fn code(self) -> u16 {
        match self {
            EmergencyKey::Esc => 1,
            EmergencyKey::F1 => 59,
            EmergencyKey::F12 => 88,
            EmergencyKey::Pause => 119,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EmergencyKey::Esc => "esc",
            EmergencyKey::F1 => "f1",
            EmergencyKey::F12 => "f12",
            EmergencyKey::Pause => "pause",
        }
    }
}

/// `PolicyFile.inputLock`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputLockPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emergency_key: Option<EmergencyKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emergency_hold_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// `PolicyFile.app`: how the app itself may behave. `allowQuit: false` makes the app hide every
/// way to quit and makes this daemon relaunch it when its process dies — for the unix users in
/// `users` only, and only while one of them owns the active graphical session.
///
/// The `allow*`/`require*` keys below are the app-enforced restrictions (the pack editor, pack
/// installs and removals, deleting sessions/history/memories, event handlers, the sandbox, and
/// keeping a conversation open). The daemon does not act on them — the app refuses those
/// operations on its own IPC boundary — but this struct denies unknown fields, so they are
/// declared here to keep a policy that uses them loadable, and round-trip through `policy`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_quit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_pack_editor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_pack_remove: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_pack_install: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_delete_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_delete_history: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_delete_memories: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_remove_events: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_sandbox: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_character_session: Option<bool>,
}

/// `PolicyFile.dev`: whether the app honours its own development switches. Like the `allow*` keys
/// above this is the app's to enforce, not the daemon's — the app reads it synchronously at
/// startup, from this file's canonical path only, and drops the `RP_*` environment overrides
/// before anything has read them. It is declared here so a policy that uses it loads, survives a
/// round trip through `policy`, and is refused with a type error rather than an unknown field.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_tools: Option<bool>,
}

/// Effective `app` rules with defaults: quitting allowed, nobody listed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppRules {
    pub allow_quit: bool,
    pub users: Vec<String>,
}

impl AppRules {
    pub fn from_policy(app: Option<&AppPolicy>) -> AppRules {
        let Some(app) = app else {
            return AppRules {
                allow_quit: true,
                users: Vec::new(),
            };
        };
        AppRules {
            allow_quit: app.allow_quit.unwrap_or(true),
            users: app.users.clone().unwrap_or_default(),
        }
    }

    /// Whether the daemon should keep the app alive for `user` (by name).
    pub fn keeps_alive(&self, user: &str) -> bool {
        !self.allow_quit && self.users.iter().any(|u| u == user)
    }
}

/// `guard.mode`: whether the session guard (AppArmor confinement of the listed users'
/// login sessions, `src/guard.rs`) is off, only logging (`audit`) or blocking (`enforce`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardMode {
    #[default]
    Off,
    Audit,
    Enforce,
}

impl GuardMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GuardMode::Off => "off",
            GuardMode::Audit => "audit",
            GuardMode::Enforce => "enforce",
        }
    }
}

/// `guard.compositorIpc`: who may talk to the compositor's control socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompositorIpc {
    Allow,
    #[default]
    ShellOnly,
    Deny,
}

impl CompositorIpc {
    pub fn as_str(self) -> &'static str {
        match self {
            CompositorIpc::Allow => "allow",
            CompositorIpc::ShellOnly => "shell-only",
            CompositorIpc::Deny => "deny",
        }
    }
}

/// `guard.shell` as written in the policy: one name or a list of them. A machine often has
/// more than one — a bar/shell that owns its own IPC socket and a separate wallpaper daemon —
/// and guarding only the first leaves the other's socket open to everyone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GuardShells {
    One(GuardShell),
    Many(Vec<GuardShell>),
}

impl GuardShells {
    pub fn into_vec(self) -> Vec<GuardShell> {
        match self {
            GuardShells::One(s) => vec![s],
            GuardShells::Many(v) => v,
        }
    }
}

/// `guard.shell`: the desktop shell / wallpaper daemon whose IPC and files are guarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardShell {
    #[default]
    Auto,
    Noctalia,
    Quickshell,
    Hyprpaper,
    Swww,
    /// The same daemon as `swww`, after the rename; both spellings select the one row.
    Awww,
    None,
}

impl GuardShell {
    pub fn as_str(self) -> &'static str {
        match self {
            GuardShell::Auto => "auto",
            GuardShell::Noctalia => "noctalia",
            GuardShell::Quickshell => "quickshell",
            GuardShell::Hyprpaper => "hyprpaper",
            GuardShell::Swww => "swww",
            GuardShell::Awww => "awww",
            GuardShell::None => "none",
        }
    }
}

/// `PolicyFile.guard`: the session guard (docs/system-integration.md "Session guard"). Applies
/// to the users in `app.users`; every field is optional and defaults as in [`GuardRules`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GuardMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protect_app: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallpaper: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor_ipc: Option<CompositorIpc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<GuardShells>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_helpers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_deny_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_deny_sockets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_binaries: Option<Vec<String>>,
}

/// Effective `guard` block with defaults: off, app protected, wallpaper guarded, compositor
/// IPC for the shell only, shell auto-detected, login helpers auto-detected, no extras.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardRules {
    pub mode: GuardMode,
    pub protect_app: bool,
    pub wallpaper: bool,
    pub compositor_ipc: CompositorIpc,
    /// Every shell row the policy asks for. `[Auto]` means "every one whose binary is present".
    pub shells: Vec<GuardShell>,
    /// `None`: auto-detect the login helpers present on the box.
    pub login_helpers: Option<Vec<String>>,
    pub extra_deny_paths: Vec<String>,
    pub extra_deny_sockets: Vec<String>,
    pub allow_binaries: Vec<String>,
    /// The policy is locked (`lock` block, `seal.rs`): the guarded sessions lose every path the
    /// seal lives in, so a terminal inside one — including one under `sudo`, which stays in the
    /// profile — cannot read the TOTP secret or delete the policy.
    pub protect_policy: bool,
    /// Also take away the binaries that would leave the profile behind (`run0`, `systemd-run`,
    /// `machinectl`, `pkexec`) and the ones that would undo the lock (`chattr`,
    /// `apparmor_parser`). `lock.denyEscapes`, on by default with a `lock` block.
    pub deny_escapes: bool,
}

impl Default for GuardRules {
    fn default() -> Self {
        GuardRules {
            mode: GuardMode::Off,
            protect_app: true,
            wallpaper: true,
            compositor_ipc: CompositorIpc::ShellOnly,
            shells: vec![GuardShell::Auto],
            login_helpers: None,
            extra_deny_paths: Vec::new(),
            extra_deny_sockets: Vec::new(),
            allow_binaries: Vec::new(),
            protect_policy: false,
            deny_escapes: false,
        }
    }
}

impl GuardRules {
    pub fn from_policy(guard: Option<&GuardPolicy>) -> GuardRules {
        let d = GuardRules::default();
        let Some(g) = guard else { return d };
        GuardRules {
            mode: g.mode.unwrap_or(d.mode),
            protect_app: g.protect_app.unwrap_or(d.protect_app),
            wallpaper: g.wallpaper.unwrap_or(d.wallpaper),
            compositor_ipc: g.compositor_ipc.unwrap_or(d.compositor_ipc),
            shells: g
                .shell
                .clone()
                .map(GuardShells::into_vec)
                .filter(|v| !v.is_empty())
                .unwrap_or(d.shells),
            login_helpers: g.login_helpers.clone(),
            extra_deny_paths: g.extra_deny_paths.clone().unwrap_or_default(),
            extra_deny_sockets: g.extra_deny_sockets.clone().unwrap_or_default(),
            allow_binaries: g.allow_binaries.clone().unwrap_or_default(),
            // Set by `PolicyFile::guard_rules`, which is the only place that can see the `lock`
            // block these two come from.
            protect_policy: d.protect_policy,
            deny_escapes: d.deny_escapes,
        }
    }

    pub fn enabled(&self) -> bool {
        self.mode != GuardMode::Off
    }
}

/// `PolicyFile` from `@rp/shared/system.ts`. `settings` is passed through as JSON; only its
/// top-level shape (an object with known keys) is validated here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyFile {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_lock: Option<InputLockPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<AppPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard: Option<GuardPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<DevPolicy>,
    /// Where this machine's policy comes from (`remote.rs`). A policy that names a `remote.url`
    /// is refreshed from it; the daemon verifies what comes back before it replaces anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemotePolicy>,
    /// The packs this machine is meant to have, and where to download them (`remote.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packs: Option<PacksPolicy>,
    /// How the policy is locked down once it is sealed (`seal.rs`). The TOTP secret is never
    /// here — this file is world-readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<LockPolicy>,
}

/// Keys allowed under `settings` (documented in `docs/spec/system.md`).
pub const SETTINGS_KEYS: [&str; 10] = [
    "autonomy",
    "maxInputLockMs",
    "permissions",
    "web",
    "desktop",
    "memory",
    "senses",
    "displayBackend",
    "updates",
    "browser",
];

impl PolicyFile {
    /// Structural validation beyond what serde enforces.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!(
                "unsupported policy version {} (expected 1)",
                self.version
            ));
        }
        if let Some(settings) = &self.settings {
            let map = settings.as_object().ok_or("settings must be an object")?;
            for key in map.keys() {
                if !SETTINGS_KEYS.contains(&key.as_str()) {
                    return Err(format!("settings.{key} is not a managed setting"));
                }
            }
            if let Some(v) = map.get("maxInputLockMs") {
                match v.as_f64() {
                    Some(n) if n.is_finite() && n >= 0.0 => {}
                    _ => return Err("settings.maxInputLockMs must be a non-negative number".into()),
                }
            }
            for key in [
                "autonomy",
                "permissions",
                "web",
                "desktop",
                "memory",
                "senses",
                "updates",
                "browser",
            ] {
                if let Some(v) = map.get(key) {
                    if !v.is_object() {
                        return Err(format!("settings.{key} must be an object"));
                    }
                }
            }
            if let Some(updates) = map.get("updates").and_then(Value::as_object) {
                for (key, value) in updates {
                    if !matches!(key.as_str(), "automatic" | "enabled" | "allowDowngrade") {
                        return Err(format!("settings.updates.{key} is not a managed setting"));
                    }
                    if !value.is_boolean() {
                        return Err(format!("settings.updates.{key} must be a boolean"));
                    }
                }
            }
            if let Some(browser) = map.get("browser").and_then(Value::as_object) {
                for (key, value) in browser {
                    match key.as_str() {
                        "allowBlocking" | "allowEval" | "allowHistory" => {
                            if !value.is_boolean() {
                                return Err(format!("settings.browser.{key} must be a boolean"));
                            }
                        }
                        "homePage" => match value.as_str() {
                            Some(s)
                                if s.is_empty()
                                    || s.starts_with("http://")
                                    || s.starts_with("https://") => {}
                            _ => {
                                return Err(
                                    "settings.browser.homePage must be an http(s) URL or \"\""
                                        .into(),
                                )
                            }
                        },
                        _ => {
                            return Err(format!("settings.browser.{key} is not a managed setting"))
                        }
                    }
                }
            }
            if let Some(v) = map.get("displayBackend") {
                match v.as_str() {
                    Some("auto" | "electron" | "hyprland") => {}
                    _ => {
                        return Err(
                            "settings.displayBackend must be auto, electron or hyprland".into()
                        )
                    }
                }
            }
        }
        if let Some(lock) = &self.input_lock {
            for (name, value) in [
                ("maxDurationMs", lock.max_duration_ms),
                ("emergencyHoldMs", lock.emergency_hold_ms),
            ] {
                if let Some(n) = value {
                    if !n.is_finite() || n < 0.0 {
                        return Err(format!("inputLock.{name} must be a non-negative number"));
                    }
                }
            }
        }
        if let Some(m) = &self.managed_by {
            if m.chars().count() > 500 {
                return Err("managedBy is longer than 500 characters".into());
            }
        }
        if let Some(app) = &self.app {
            if let Some(users) = &app.users {
                if users.is_empty() {
                    return Err("app.users must be a non-empty array of user names".into());
                }
                for u in users {
                    if u.trim().is_empty() || u.chars().count() > 256 {
                        return Err("app.users must be a non-empty array of user names".into());
                    }
                }
            }
        }
        if let Some(remote) = &self.remote {
            crate::remote::validate_remote(remote)?;
        }
        if let Some(packs) = &self.packs {
            crate::remote::validate_packs(packs)?;
        }
        if let Some(lock) = &self.lock {
            crate::seal::validate_lock(lock)?;
        }
        if let Some(guard) = &self.guard {
            validate_guard(guard)?;
            let listed = self
                .app
                .as_ref()
                .and_then(|a| a.users.as_ref())
                .is_some_and(|u| !u.is_empty());
            if guard.mode.unwrap_or_default() != GuardMode::Off && !listed {
                return Err(
                    "guard.mode needs app.users: the guard confines the listed users' sessions"
                        .into(),
                );
            }
        }
        Ok(())
    }

    /// The `inputLock` limits with defaults and clamping applied.
    pub fn lock_limits(&self) -> LockLimits {
        LockLimits::from_policy(self.input_lock.as_ref())
    }

    /// `settings.updates.allowDowngrade`: whether `apply-update` may install a version older
    /// than the current one (default false).
    pub fn allow_downgrade(&self) -> bool {
        self.settings
            .as_ref()
            .and_then(|s| s.get("updates"))
            .and_then(|u| u.get("allowDowngrade"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// The `app` rules with defaults applied (user names trimmed).
    pub fn app_rules(&self) -> AppRules {
        let mut rules = AppRules::from_policy(self.app.as_ref());
        for u in &mut rules.users {
            *u = u.trim().to_string();
        }
        rules
    }

    /// The `guard` rules with defaults applied (off without a `guard` block). A policy with a
    /// `lock` block also guards the seal's own files, and — unless `lock.denyEscapes` says
    /// otherwise — the binaries a confined session would use to get out of the profile.
    pub fn guard_rules(&self) -> GuardRules {
        let mut rules = GuardRules::from_policy(self.guard.as_ref());
        if self.lock.is_some() {
            rules.protect_policy = true;
            rules.deny_escapes = self.lock_rules().deny_escapes;
        }
        rules
    }

    /// The `remote` rules, or `None` when the policy names no address of its own.
    pub fn remote_rules(&self) -> Option<RemoteRules> {
        RemoteRules::from_policy(self.remote.as_ref())
    }

    /// The `packs` rules with defaults applied (nothing pinned without a `packs` block).
    pub fn pack_rules(&self) -> PackRules {
        PackRules::from_policy(self.packs.as_ref())
    }

    /// The `lock` rules with defaults applied (every protection on once the machine is sealed).
    pub fn lock_rules(&self) -> LockRules {
        LockRules::from_policy(self.lock.as_ref())
    }
}

/// Every path list entry must be absolute (or `@{HOME}`/`~/` for the deny globs), non-empty
/// and free of whitespace and quotes — they are written into AppArmor rules verbatim.
fn validate_guard(guard: &GuardPolicy) -> Result<(), String> {
    fn check(list: Option<&Vec<String>>, what: &str, allow_home: bool) -> Result<(), String> {
        let Some(list) = list else { return Ok(()) };
        for p in list {
            let ok_prefix = p.starts_with('/')
                || (allow_home && (p.starts_with("@{HOME}/") || p.starts_with("~/")));
            if p.is_empty()
                || !ok_prefix
                || p.chars()
                    .any(|c| c.is_whitespace() || c == '"' || c == '\\')
                || p.chars().count() > 1024
            {
                return Err(format!(
                    "guard.{what} entries must be absolute paths{} without spaces or quotes (got {p:?})",
                    if allow_home { " (or start with ~/ or @{HOME}/)" } else { "" }
                ));
            }
        }
        Ok(())
    }
    check(guard.login_helpers.as_ref(), "loginHelpers", false)?;
    check(guard.extra_deny_paths.as_ref(), "extraDenyPaths", true)?;
    check(guard.extra_deny_sockets.as_ref(), "extraDenySockets", true)?;
    check(guard.allow_binaries.as_ref(), "allowBinaries", false)?;
    if let Some(list) = &guard.login_helpers {
        if list.is_empty() {
            return Err("guard.loginHelpers must not be empty (omit it to auto-detect)".into());
        }
    }
    Ok(())
}

/// Effective input-lock limits (defaults filled in, values clamped to sane ranges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockLimits {
    pub enabled: bool,
    pub max_duration_ms: u64,
    pub emergency_key: EmergencyKey,
    pub emergency_hold_ms: u64,
}

impl Default for LockLimits {
    fn default() -> Self {
        LockLimits {
            enabled: true,
            max_duration_ms: DEFAULT_MAX_LOCK_MS,
            emergency_key: EmergencyKey::Esc,
            emergency_hold_ms: DEFAULT_EMERGENCY_HOLD_MS,
        }
    }
}

impl LockLimits {
    pub fn from_policy(lock: Option<&InputLockPolicy>) -> LockLimits {
        let d = LockLimits::default();
        let Some(lock) = lock else { return d };
        LockLimits {
            enabled: lock.enabled.unwrap_or(d.enabled),
            max_duration_ms: lock
                .max_duration_ms
                .map(|n| (n.round() as u64).max(MIN_LOCK_MS))
                .unwrap_or(d.max_duration_ms),
            emergency_key: lock.emergency_key.unwrap_or(d.emergency_key),
            emergency_hold_ms: lock
                .emergency_hold_ms
                .map(|n| (n.round() as u64).clamp(MIN_EMERGENCY_HOLD_MS, MAX_EMERGENCY_HOLD_MS))
                .unwrap_or(d.emergency_hold_ms),
        }
    }

    /// Clamp a requested duration into `[MIN_LOCK_MS, max_duration_ms]`. Non-finite or
    /// non-positive requests are rejected (the caller maps that to `INVALID`).
    pub fn clamp_duration(&self, requested_ms: f64) -> Option<u64> {
        if !requested_ms.is_finite() || requested_ms <= 0.0 {
            return None;
        }
        let rounded = requested_ms.round().min(u64::MAX as f64) as u64;
        Some(rounded.clamp(MIN_LOCK_MS, self.max_duration_ms.max(MIN_LOCK_MS)))
    }
}

/// Why a policy file could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// The file exists but cannot be read (permissions, I/O).
    Unreadable(String),
    /// The file is not valid JSON or fails validation.
    Invalid(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::Unreadable(m) => write!(f, "policy file unreadable: {m}"),
            PolicyError::Invalid(m) => write!(f, "policy file invalid: {m}"),
        }
    }
}

/// Result of a policy load: `Ok(None)` when the file is absent (defaults apply).
pub type PolicyLoad = Result<Option<PolicyFile>, PolicyError>;

/// Why a write-once creation (`set-policy`) failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateError {
    /// Something (file, symlink, directory) already exists at the policy path.
    Exists(PathBuf),
    /// The object is not a valid policy.
    Invalid(String),
    /// Directory or file could not be created/written.
    Io(String),
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateError::Exists(p) => write!(
                f,
                "a policy already exists at {}; only root can change it",
                p.display()
            ),
            CreateError::Invalid(m) => write!(f, "policy invalid: {m}"),
            CreateError::Io(m) => write!(f, "cannot write policy: {m}"),
        }
    }
}

/// Validate a policy object the way the file is validated (unknown keys are rejected).
pub fn policy_from_value(value: Value) -> Result<PolicyFile, CreateError> {
    let policy: PolicyFile =
        serde_json::from_value(value).map_err(|e| CreateError::Invalid(e.to_string()))?;
    policy.validate().map_err(CreateError::Invalid)?;
    Ok(policy)
}

/// Create the policy file at `path` **once**: pretty JSON plus a trailing newline, mode 0644,
/// parent directory created 0755 when missing. `policy` must already have passed
/// [`policy_from_value`]; the object is written as given (key order and integer formatting
/// preserved) rather than re-serialised from the struct. Anything already at `path` — a file,
/// a symlink (dangling or not) or a directory — is left alone and reported as `Exists`.
///
/// The file is opened with `O_CREAT|O_EXCL`, which the kernel evaluates atomically, so two
/// concurrent callers cannot both succeed and nothing existing is ever replaced. The content
/// is written straight into that file (no temp-file-and-rename dance): a crash between the
/// create and the fsync leaves a truncated file, which the loader rejects as invalid, i.e.
/// the daemon fails closed until root fixes it. `renameat2(RENAME_NOREPLACE)` would avoid
/// that window but is not available on every libc/kernel this daemon is built for.
pub fn create_policy_file(path: &Path, policy: &Value) -> Result<(), CreateError> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(CreateError::Exists(path.to_path_buf()));
    }
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o755)
                .create(dir)
                .map_err(|e| CreateError::Io(format!("mkdir {}: {e}", dir.display())))?;
        }
    }
    let mut text = serde_json::to_string_pretty(policy)
        .map_err(|e| CreateError::Invalid(format!("cannot serialise policy: {e}")))?;
    text.push('\n');
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(CreateError::Exists(path.to_path_buf()))
        }
        Err(e) => return Err(CreateError::Io(format!("create {}: {e}", path.display()))),
    };
    let io_err = |e: io::Error| CreateError::Io(format!("write {}: {e}", path.display()));
    // `mode` above is subject to the umask; make the world-readable mode explicit.
    file.set_permissions(fs::Permissions::from_mode(0o644))
        .map_err(io_err)?;
    file.write_all(text.as_bytes()).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    Ok(())
}

/// Replace the policy file at `path` with `policy`, atomically (temp file + rename) and with the
/// immutable attribute cleared first. This is the sealed machine's write path: unlike
/// [`create_policy_file`] it *does* replace what is there, which is why it is only reachable
/// behind a verified TOTP code, a verified remote configuration, or the seal's own self-heal.
pub fn write_policy_file(path: &Path, policy: &Value) -> Result<(), CreateError> {
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o755)
                .create(dir)
                .map_err(|e| CreateError::Io(format!("mkdir {}: {e}", dir.display())))?;
        }
    }
    let mut text = serde_json::to_string_pretty(policy)
        .map_err(|e| CreateError::Invalid(format!("cannot serialise policy: {e}")))?;
    text.push('\n');
    let tmp = path.with_extension("json.tmp");
    let _ = crate::seal::set_immutable(path, false);
    let _ = crate::seal::set_immutable(&tmp, false);
    let _ = fs::remove_file(&tmp);
    let io_err = |e: io::Error| CreateError::Io(format!("write {}: {e}", tmp.display()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(&tmp)
        .map_err(io_err)?;
    file.set_permissions(fs::Permissions::from_mode(0o644))
        .map_err(io_err)?;
    file.write_all(text.as_bytes()).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    drop(file);
    fs::rename(&tmp, path)
        .map_err(|e| CreateError::Io(format!("rename onto {}: {e}", path.display())))?;
    Ok(())
}

/// Parse and validate policy JSON text.
pub fn parse_policy(text: &str) -> Result<PolicyFile, PolicyError> {
    let policy: PolicyFile =
        serde_json::from_str(text).map_err(|e| PolicyError::Invalid(e.to_string()))?;
    policy.validate().map_err(PolicyError::Invalid)?;
    Ok(policy)
}

/// Read, parse and validate the policy at `path` (no caching).
pub fn load_policy(path: &Path) -> PolicyLoad {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(PolicyError::Unreadable(e.to_string())),
    };
    if !meta.is_file() {
        return Err(PolicyError::Unreadable("not a regular file".into()));
    }
    if meta.len() > MAX_POLICY_BYTES {
        return Err(PolicyError::Invalid(format!(
            "larger than {MAX_POLICY_BYTES} bytes"
        )));
    }
    let text = fs::read_to_string(path).map_err(|e| PolicyError::Unreadable(e.to_string()))?;
    parse_policy(&text).map(Some)
}

/// Cached policy loader keyed on the file's (mtime, size).
#[derive(Debug)]
pub struct PolicyStore {
    path: PathBuf,
    cache: Option<(Option<(SystemTime, u64)>, PolicyLoad)>,
}

impl PolicyStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        PolicyStore {
            path: path.into(),
            cache: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The file's (mtime, size), `None` when it is missing — what the cache is keyed on.
    pub fn stamp(&self) -> Option<(SystemTime, u64)> {
        let meta = fs::metadata(&self.path).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    }

    /// Current policy, re-read only when the file's mtime or size changed. Returns a clone;
    /// policies are small.
    pub fn load(&mut self) -> PolicyLoad {
        let stamp = self.stamp();
        if let Some((cached_stamp, result)) = &self.cache {
            if *cached_stamp == stamp && stamp.is_some() {
                return result.clone();
            }
        }
        let result = load_policy(&self.path);
        self.cache = Some((stamp, result.clone()));
        result
    }

    /// Effective lock limits: defaults when there is no file. An unreadable or invalid file
    /// fails closed (`Err`) so a broken policy never grants more than the administrator wrote.
    pub fn lock_limits(&mut self) -> Result<LockLimits, PolicyError> {
        Ok(self.load()?.map(|p| p.lock_limits()).unwrap_or_default())
    }

    /// Effective `app` rules: defaults (quit allowed) without a file; a broken file also means
    /// "quit allowed" — the daemon must not relaunch on the strength of a policy it cannot read.
    pub fn app_rules(&mut self) -> AppRules {
        match self.load() {
            Ok(Some(p)) => p.app_rules(),
            _ => AppRules::from_policy(None),
        }
    }

    /// `settings.updates.allowDowngrade`; false without a (readable) file.
    pub fn allow_downgrade(&mut self) -> bool {
        matches!(self.load(), Ok(Some(p)) if p.allow_downgrade())
    }

    /// Drop the cache so the next `load` re-reads the file (used after a write that went around
    /// this store: a sealed replacement, a remote configuration or the self-heal).
    pub fn invalidate(&mut self) {
        self.cache = None;
    }

    /// Validate `value` and create the policy file once (see [`create_policy_file`]). The
    /// cache is dropped so the next `load` reads the new file.
    pub fn create(&mut self, value: Value) -> Result<PolicyFile, CreateError> {
        let policy = policy_from_value(value.clone())?;
        create_policy_file(&self.path, &value)?;
        self.cache = None;
        Ok(policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;

    fn policy(v: serde_json::Value) -> Result<PolicyFile, PolicyError> {
        parse_policy(&v.to_string())
    }

    #[test]
    fn defaults_when_file_absent_or_empty_policy() {
        let p = policy(json!({"version":1})).unwrap();
        assert_eq!(p.lock_limits(), LockLimits::default());
        let d = LockLimits::default();
        assert!(d.enabled);
        assert_eq!(d.max_duration_ms, 300_000);
        assert_eq!(d.emergency_key, EmergencyKey::Esc);
        assert_eq!(d.emergency_hold_ms, 5000);
        let mut store = PolicyStore::new("/nonexistent/rp-code/policy.json");
        assert_eq!(store.load(), Ok(None));
        assert_eq!(store.lock_limits(), Ok(LockLimits::default()));
    }

    #[test]
    fn parses_full_example_shape() {
        let p = policy(json!({
            "version": 1,
            "managedBy": "IT department",
            "settings": {
                "autonomy": {"maxSelfWakesPerHour": 5},
                "maxInputLockMs": 60000,
                "permissions": {"moduleAllow": {"input": false}},
                "web": {"allowlist": ["example.com"]},
                "desktop": {"launchAllowlist": []},
                "memory": {},
                "senses": {"includeInPrompt": false},
                "displayBackend": "electron",
                "updates": {"automatic": false, "enabled": true, "allowDowngrade": true},
                "browser": {"allowBlocking": false, "allowEval": true, "allowHistory": false, "homePage": "https://example.com/"}
            },
            "inputLock": {"maxDurationMs": 60000, "emergencyKey": "f12", "emergencyHoldMs": 2000, "enabled": true}
        }))
        .unwrap();
        assert_eq!(p.managed_by.as_deref(), Some("IT department"));
        assert!(p.allow_downgrade());
        assert!(!policy(json!({"version": 1})).unwrap().allow_downgrade());
        assert!(
            !policy(json!({"version": 1, "settings": {"updates": {"enabled": false}}}))
                .unwrap()
                .allow_downgrade()
        );
        assert_eq!(
            p.lock_limits(),
            LockLimits {
                enabled: true,
                max_duration_ms: 60000,
                emergency_key: EmergencyKey::F12,
                emergency_hold_ms: 2000
            }
        );
        // Round trip keeps the settings block verbatim.
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["settings"]["web"]["allowlist"], json!(["example.com"]));
        assert_eq!(back["inputLock"]["emergencyKey"], json!("f12"));
    }

    #[test]
    fn rejects_bad_shapes() {
        let bad = [
            json!({}),
            json!({"version": 2}),
            json!({"version": 1, "extra": true}),
            json!({"version": 1, "settings": []}),
            json!({"version": 1, "settings": {"theme": "dark"}}),
            json!({"version": 1, "settings": {"maxInputLockMs": -1}}),
            json!({"version": 1, "settings": {"web": "x"}}),
            json!({"version": 1, "settings": {"displayBackend": "wayland"}}),
            json!({"version": 1, "settings": {"updates": true}}),
            json!({"version": 1, "settings": {"updates": {"enabled": "no"}}}),
            json!({"version": 1, "settings": {"updates": {"checkIntervalHours": 1}}}),
            json!({"version": 1, "settings": {"browser": "x"}}),
            json!({"version": 1, "settings": {"browser": {"allowEval": "no"}}}),
            json!({"version": 1, "settings": {"browser": {"allowEval": "yes"}}}),
            json!({"version": 1, "settings": {"browser": {"homePage": "ftp://x"}}}),
            json!({"version": 1, "settings": {"browser": {"bridgePort": 1}}}),
            json!({"version": 1, "inputLock": {"emergencyKey": "space"}}),
            json!({"version": 1, "inputLock": {"maxDurationMs": -5}}),
            json!({"version": 1, "inputLock": {"foo": 1}}),
            json!({"version": 1, "inputLock": {"enabled": "no"}}),
            json!({"version": 1, "app": "no"}),
            json!({"version": 1, "app": {"allowQuit": "no"}}),
            json!({"version": 1, "app": {"allowQuit": 0}}),
            json!({"version": 1, "app": {"users": []}}),
            json!({"version": 1, "app": {"users": "alice"}}),
            json!({"version": 1, "app": {"users": ["alice", 3]}}),
            json!({"version": 1, "app": {"users": [" "]}}),
            json!({"version": 1, "app": {"theme": "dark"}}),
            json!({"version": 1, "dev": "off"}),
            json!({"version": 1, "dev": {"allow": "no"}}),
            json!({"version": 1, "dev": {"devTools": 0}}),
            json!({"version": 1, "dev": {"allowed": true}}),
        ];
        for v in bad {
            assert!(
                matches!(policy(v.clone()), Err(PolicyError::Invalid(_))),
                "should reject {v}"
            );
        }
        assert!(matches!(
            parse_policy("{not json"),
            Err(PolicyError::Invalid(_))
        ));
    }

    /// The `dev` block is the app's to act on; the daemon must load it, keep it and hand it back.
    #[test]
    fn keeps_the_dev_block_for_the_app() {
        assert_eq!(policy(json!({"version": 1})).unwrap().dev, None);
        assert_eq!(
            policy(json!({"version": 1, "dev": {}})).unwrap().dev,
            Some(DevPolicy::default())
        );
        let p = policy(json!({"version": 1, "dev": {"allow": false, "devTools": true}})).unwrap();
        assert_eq!(
            p.dev,
            Some(DevPolicy {
                allow: Some(false),
                dev_tools: Some(true)
            })
        );
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["dev"], json!({"allow": false, "devTools": true}));
        // A block that only closes the inspector round-trips without gaining an `allow` key.
        let only_tools = policy(json!({"version": 1, "dev": {"devTools": false}})).unwrap();
        assert_eq!(
            serde_json::to_value(&only_tools).unwrap()["dev"],
            json!({"devTools": false})
        );
    }

    #[test]
    fn clamps_limits_and_durations() {
        let limits =
            policy(json!({"version":1,"inputLock":{"maxDurationMs":10,"emergencyHoldMs":1}}))
                .unwrap()
                .lock_limits();
        assert_eq!(
            limits.max_duration_ms, MIN_LOCK_MS,
            "max below the minimum is raised"
        );
        assert_eq!(limits.emergency_hold_ms, MIN_EMERGENCY_HOLD_MS);
        let limits = policy(
            json!({"version":1,"inputLock":{"maxDurationMs":45000.4,"emergencyHoldMs":9e9}}),
        )
        .unwrap()
        .lock_limits();
        assert_eq!(limits.max_duration_ms, 45000);
        assert_eq!(limits.emergency_hold_ms, MAX_EMERGENCY_HOLD_MS);

        assert_eq!(limits.clamp_duration(1.0), Some(MIN_LOCK_MS));
        assert_eq!(limits.clamp_duration(30_000.0), Some(30_000));
        assert_eq!(limits.clamp_duration(30_000.6), Some(30_001));
        assert_eq!(limits.clamp_duration(1e12), Some(45_000));
        assert_eq!(limits.clamp_duration(0.0), None);
        assert_eq!(limits.clamp_duration(-5.0), None);
        assert_eq!(limits.clamp_duration(f64::NAN), None);
        assert_eq!(limits.clamp_duration(f64::INFINITY), None);
        assert_eq!(
            LockLimits::default().clamp_duration(1e12),
            Some(DEFAULT_MAX_LOCK_MS)
        );
    }

    #[test]
    fn disabled_flag_is_reported() {
        let limits = policy(json!({"version":1,"inputLock":{"enabled":false}}))
            .unwrap()
            .lock_limits();
        assert!(!limits.enabled);
        assert_eq!(limits.max_duration_ms, DEFAULT_MAX_LOCK_MS);
    }

    #[test]
    /// The app enforces the `app` restrictions itself, but this struct denies unknown fields:
    /// if it did not know them, a policy using them would fail to load *entirely* and take the
    /// quit/relaunch and guard blocks down with it.
    fn app_restrictions_load_and_round_trip_without_affecting_the_daemon() {
        let doc = json!({"version":1,"app":{
            "allowQuit": false,
            "users": ["alice"],
            "allowPackEditor": false,
            "allowPackRemove": false,
            "allowPackInstall": false,
            "allowDeleteSession": false,
            "allowDeleteHistory": false,
            "allowDeleteMemories": false,
            "allowRemoveEvents": false,
            "allowSandbox": false,
            "requireCharacterSession": true
        }});
        let loaded = policy(doc.clone()).unwrap();
        // The daemon's own decisions are untouched by them.
        let rules = loaded.app_rules();
        assert!(!rules.allow_quit && rules.keeps_alive("alice"));
        let app = loaded.app.as_ref().unwrap();
        assert_eq!(app.allow_pack_editor, Some(false));
        assert_eq!(app.allow_sandbox, Some(false));
        assert_eq!(app.require_character_session, Some(true));
        // Handed back to the app verbatim.
        assert_eq!(serde_json::to_value(&loaded).unwrap(), doc);
        // Omitted keys stay absent rather than becoming `false`.
        let bare = policy(json!({"version":1,"app":{"allowQuit":true}})).unwrap();
        let bare_app = bare.app.as_ref().unwrap();
        assert_eq!(bare_app.allow_pack_editor, None);
        assert_eq!(bare_app.require_character_session, None);
        // A genuinely unknown key is still refused.
        assert!(policy(json!({"version":1,"app":{"allowNonsense":true}})).is_err());
    }

    #[test]
    fn app_rules_default_to_quit_allowed_and_nobody_listed() {
        let none = policy(json!({"version":1})).unwrap().app_rules();
        assert_eq!(
            none,
            AppRules {
                allow_quit: true,
                users: vec![]
            }
        );
        assert!(!none.keeps_alive("alice"));
        let empty = policy(json!({"version":1,"app":{}})).unwrap().app_rules();
        assert!(empty.allow_quit && empty.users.is_empty());
        let only_flag = policy(json!({"version":1,"app":{"allowQuit":false}}))
            .unwrap()
            .app_rules();
        assert!(!only_flag.allow_quit);
        assert!(only_flag.users.is_empty(), "no list: nobody is relaunched");
        assert!(!only_flag.keeps_alive("alice"));
        let full = policy(json!({"version":1,"app":{"allowQuit":false,"users":["alice"," bob "]}}))
            .unwrap()
            .app_rules();
        assert_eq!(full.users, vec!["alice", "bob"]);
        assert!(full.keeps_alive("alice") && full.keeps_alive("bob"));
        assert!(!full.keeps_alive("carol"));
        let allowed = policy(json!({"version":1,"app":{"allowQuit":true,"users":["alice"]}}))
            .unwrap()
            .app_rules();
        assert!(
            !allowed.keeps_alive("alice"),
            "allowQuit true wins over the list"
        );
        // Round trip keeps the block verbatim; a broken store yields the defaults.
        let p = policy(json!({"version":1,"app":{"allowQuit":false,"users":["alice"]}})).unwrap();
        assert_eq!(
            serde_json::to_value(&p).unwrap()["app"],
            json!({"allowQuit":false,"users":["alice"]})
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let mut store = PolicyStore::new(&path);
        assert_eq!(store.app_rules(), AppRules::from_policy(None));
        fs::write(
            &path,
            r#"{"version":1,"app":{"allowQuit":false,"users":["alice"]}}"#,
        )
        .unwrap();
        assert!(store.app_rules().keeps_alive("alice"));
        fs::write(&path, "{broken").unwrap();
        assert!(
            store.app_rules().allow_quit,
            "a broken file never relaunches"
        );
    }

    #[test]
    fn emergency_key_codes() {
        assert_eq!(EmergencyKey::Esc.code(), 1);
        assert_eq!(EmergencyKey::F1.code(), 59);
        assert_eq!(EmergencyKey::F12.code(), 88);
        assert_eq!(EmergencyKey::Pause.code(), 119);
        assert_eq!(
            serde_json::to_value(EmergencyKey::Pause).unwrap(),
            json!("pause")
        );
        assert_eq!(EmergencyKey::F1.as_str(), "f1");
    }

    #[test]
    fn store_reloads_on_change_and_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let mut store = PolicyStore::new(&path);
        assert_eq!(store.load(), Ok(None));

        File::create(&path)
            .unwrap()
            .write_all(br#"{"version":1,"inputLock":{"maxDurationMs":5000}}"#)
            .unwrap();
        assert_eq!(store.lock_limits().unwrap().max_duration_ms, 5000);

        // Same mtime/size → cached (we cannot easily prove the cache hit, but the result is stable).
        assert_eq!(store.lock_limits().unwrap().max_duration_ms, 5000);

        // Different size → reloaded even if the mtime granularity hides the change.
        File::create(&path)
            .unwrap()
            .write_all(br#"{"version":1,"inputLock":{"maxDurationMs":120000}}"#)
            .unwrap();
        assert_eq!(store.lock_limits().unwrap().max_duration_ms, 120_000);

        // Broken file → Err (fail closed), and the `policy` op will surface it.
        File::create(&path).unwrap().write_all(b"{oops").unwrap();
        assert!(matches!(store.lock_limits(), Err(PolicyError::Invalid(_))));
        assert!(store.load().unwrap_err().to_string().contains("invalid"));

        // Removed → defaults again.
        fs::remove_file(&path).unwrap();
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn create_writes_once_with_mode_0644_and_pretty_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("etc").join("rp-code").join("policy.json");
        let mut store = PolicyStore::new(&path);
        assert_eq!(store.load(), Ok(None));

        let value = json!({"version":1,"managedBy":"me","inputLock":{"maxDurationMs":4000}});
        let created = store.create(value.clone()).unwrap();
        assert_eq!(created.managed_by.as_deref(), Some("me"));
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o644);
        let dir_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o755);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("}\n"), "trailing newline: {text:?}");
        assert!(
            text.contains("\n  \"managedBy\": \"me\""),
            "pretty: {text:?}"
        );
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), value);
        // The store sees it immediately.
        assert_eq!(store.lock_limits().unwrap().max_duration_ms, 4000);

        // Second time: EXISTS, file untouched.
        assert!(matches!(
            store.create(json!({"version":1})),
            Err(CreateError::Exists(_))
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        let msg = CreateError::Exists(path.clone()).to_string();
        assert!(msg.contains("only root can change it"), "{msg}");

        // A symlink (even dangling) or a directory at the path also counts as existing.
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &link).unwrap();
        assert!(matches!(
            PolicyStore::new(&link).create(json!({"version":1})),
            Err(CreateError::Exists(_))
        ));
        let sub = dir.path().join("dir.json");
        fs::create_dir(&sub).unwrap();
        assert!(matches!(
            PolicyStore::new(&sub).create(json!({"version":1})),
            Err(CreateError::Exists(_))
        ));
    }

    #[test]
    fn create_rejects_invalid_policies_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let mut store = PolicyStore::new(&path);
        for bad in [
            json!({"version":2}),
            json!({"version":1,"settings":{"theme":"dark"}}),
            json!({"version":1,"extra":1}),
            json!({"version":1,"inputLock":{"emergencyKey":"space"}}),
            json!("nope"),
        ] {
            let err = store.create(bad.clone()).unwrap_err();
            assert!(matches!(err, CreateError::Invalid(_)), "{bad} → {err}");
        }
        assert!(!path.exists());
        assert!(matches!(
            store.create(json!({"version":1,"settings":{"theme":"dark"}})),
            Err(CreateError::Invalid(m)) if m.contains("theme")
        ));
    }

    #[test]
    fn oversized_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"{\"version\":1,\"managedBy\":\"").unwrap();
        f.write_all(&vec![b'x'; MAX_POLICY_BYTES as usize + 10])
            .unwrap();
        f.write_all(b"\"}").unwrap();
        assert!(matches!(load_policy(&path), Err(PolicyError::Invalid(_))));
    }

    #[test]
    fn guard_block_defaults_validates_and_round_trips() {
        let none = policy(json!({"version":1})).unwrap().guard_rules();
        assert_eq!(none, GuardRules::default());
        assert!(!none.enabled());
        assert_eq!(none.mode, GuardMode::Off);
        assert!(none.protect_app && none.wallpaper);
        assert_eq!(none.compositor_ipc, CompositorIpc::ShellOnly);
        assert_eq!(none.shells, vec![GuardShell::Auto]);
        // An empty block is the defaults; mode off needs no users.
        assert_eq!(
            policy(json!({"version":1,"guard":{}}))
                .unwrap()
                .guard_rules(),
            GuardRules::default()
        );
        let full = policy(json!({"version":1,"app":{"users":["alice"]},"guard":{
            "mode":"enforce","protectApp":false,"wallpaper":true,"compositorIpc":"deny","shell":"noctalia",
            "loginHelpers":["/usr/lib/sddm/sddm-helper"],"extraDenyPaths":["~/.config/hypr/hyprpaper.conf","@{HOME}/x"],
            "extraDenySockets":["/run/user/1000/foo.sock"],"allowBinaries":["/usr/bin/hyprctl"]}}))
        .unwrap();
        let rules = full.guard_rules();
        assert!(rules.enabled());
        assert_eq!(rules.mode, GuardMode::Enforce);
        assert!(!rules.protect_app);
        assert_eq!(rules.compositor_ipc, CompositorIpc::Deny);
        assert_eq!(rules.shells, vec![GuardShell::Noctalia]);

        // The same key takes a list, so a bar and a wallpaper daemon can both be guarded.
        let many = parse_policy(
            &json!({"version":1,"app":{"users":["a"]},
                    "guard":{"shell":["noctalia","hyprpaper"]}})
            .to_string(),
        )
        .unwrap()
        .guard_rules();
        assert_eq!(
            many.shells,
            vec![GuardShell::Noctalia, GuardShell::Hyprpaper]
        );
        // An empty list is not a way to silently disable the shell guard.
        let empty = parse_policy(
            &json!({"version":1,"app":{"users":["a"]},"guard":{"shell":[]}}).to_string(),
        )
        .unwrap()
        .guard_rules();
        assert_eq!(empty.shells, vec![GuardShell::Auto]);
        assert_eq!(
            rules.login_helpers.as_deref(),
            Some(&["/usr/lib/sddm/sddm-helper".to_string()][..])
        );
        assert_eq!(rules.extra_deny_paths.len(), 2);
        assert_eq!(rules.allow_binaries, vec!["/usr/bin/hyprctl"]);
        assert_eq!(
            serde_json::to_value(&full).unwrap()["guard"]["compositorIpc"],
            json!("deny")
        );
        let bad = [
            json!({"version":1,"guard":"on"}),
            json!({"version":1,"guard":{"mode":"on"}}),
            json!({"version":1,"guard":{"mode":"audit"}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"mode":"audit","reassert":true}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"compositorIpc":"maybe"}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"shell":"waybar"}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"loginHelpers":[]}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"loginHelpers":["sddm-helper"]}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"extraDenyPaths":["/a b"]}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"allowBinaries":["~/bin/x"]}}),
            json!({"version":1,"app":{"users":["a"]},"guard":{"extraDenySockets":[""]}}),
        ];
        for v in bad {
            assert!(
                matches!(policy(v.clone()), Err(PolicyError::Invalid(_))),
                "should reject {v}"
            );
        }
    }
}
