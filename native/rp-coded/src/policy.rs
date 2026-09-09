//! The root-owned policy file (`/etc/rp-code/policy.json`).
//!
//! The daemon only interprets `inputLock`; the `settings` block is validated for shape and
//! handed to the app verbatim through the `policy` request. Loading is cached on the file's
//! mtime so re-reading on every `policy`/`lock` request is cheap.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
}

/// Keys allowed under `settings` (documented in `docs/spec/system.md`).
pub const SETTINGS_KEYS: [&str; 9] = [
    "autonomy",
    "maxInputLockMs",
    "permissions",
    "web",
    "desktop",
    "memory",
    "senses",
    "displayBackend",
    "updates",
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
            ] {
                if let Some(v) = map.get(key) {
                    if !v.is_object() {
                        return Err(format!("settings.{key} must be an object"));
                    }
                }
            }
            if let Some(updates) = map.get("updates").and_then(Value::as_object) {
                for (key, value) in updates {
                    if !matches!(key.as_str(), "automatic" | "enabled") {
                        return Err(format!("settings.updates.{key} is not a managed setting"));
                    }
                    if !value.is_boolean() {
                        return Err(format!("settings.updates.{key} must be a boolean"));
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
        Ok(())
    }

    /// The `inputLock` limits with defaults and clamping applied.
    pub fn lock_limits(&self) -> LockLimits {
        LockLimits::from_policy(self.input_lock.as_ref())
    }
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

    fn stamp(&self) -> Option<(SystemTime, u64)> {
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
                "updates": {"automatic": false, "enabled": true}
            },
            "inputLock": {"maxDurationMs": 60000, "emergencyKey": "f12", "emergencyHoldMs": 2000, "enabled": true}
        }))
        .unwrap();
        assert_eq!(p.managed_by.as_deref(), Some("IT department"));
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
            json!({"version": 1, "inputLock": {"emergencyKey": "space"}}),
            json!({"version": 1, "inputLock": {"maxDurationMs": -5}}),
            json!({"version": 1, "inputLock": {"foo": 1}}),
            json!({"version": 1, "inputLock": {"enabled": "no"}}),
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
}
