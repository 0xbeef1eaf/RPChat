//! Wire types for the JSON-lines protocol between the desktop app and `rpchatd`.
//!
//! These mirror `DaemonRequest` / `DaemonResponse` in `packages/shared/src/system.ts`
//! field for field; the tests below pin the exact JSON shapes. One request per line on
//! the unix socket, one response line per request, in order.

use std::fmt;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

use crate::guard::{GuardAttempt, GuardInfo};
use crate::policy::PolicyFile;
use crate::runtime::RuntimeInfo;
use crate::seal::{SealMode, TamperRecord};
use crate::totp::TotpConfig;

/// Protocol version this daemon speaks (`hello.version` it accepts and `protocol` it reports).
pub const PROTOCOL_VERSION: u32 = 1;

/// Longest `text` accepted by `type` (characters).
pub const TEXT_MAX_CHARS: usize = 2000;
/// Longest `combo` accepted by `key`.
pub const COMBO_MAX_CHARS: usize = 64;
/// Longest `reason` kept for a lock; longer reasons are truncated.
pub const REASON_MAX_CHARS: usize = 200;
/// Longest TOTP code accepted (digits plus the spaces people paste).
pub const CODE_MAX_CHARS: usize = 32;

// ---------------------------------------------------------------------------
// Requests (app → daemon)
// ---------------------------------------------------------------------------

/// Mouse button for `click`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

/// Which input devices a lock covers (`LockDevices` in `@rp/shared`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockDevices {
    /// Devices with typing keys (KEY_A ...); a keyboard with a built-in trackpoint counts.
    Keyboard,
    /// Pointers: mice (EV_REL), touchpads / touchscreens / tablets (EV_ABS + BTN_LEFT/BTN_TOUCH).
    Mouse,
    #[default]
    Both,
}

impl LockDevices {
    pub fn as_str(self) -> &'static str {
        match self {
            LockDevices::Keyboard => "keyboard",
            LockDevices::Mouse => "mouse",
            LockDevices::Both => "both",
        }
    }

    pub fn wants_keyboard(self) -> bool {
        matches!(self, LockDevices::Keyboard | LockDevices::Both)
    }

    pub fn wants_pointer(self) -> bool {
        matches!(self, LockDevices::Mouse | LockDevices::Both)
    }
}

/// One request line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Request {
    Hello {
        version: u32,
    },
    Status,
    Policy,
    Lock {
        #[serde(rename = "durationMs")]
        duration_ms: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        devices: Option<LockDevices>,
    },
    Unlock,
    Type {
        text: String,
    },
    Key {
        combo: String,
    },
    Click {
        x: f64,
        y: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<Button>,
    },
    Move {
        x: f64,
        y: f64,
    },
    /// Create the policy file (write-once while the machine is unsealed: `EXISTS` when one is
    /// already there). On a sealed machine a `code` from the enrolled authenticator replaces the
    /// policy instead, and the seal is re-pinned to what was written. The object is validated
    /// exactly like the file would be.
    #[serde(rename = "set-policy")]
    SetPolicy {
        policy: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Seal this machine: generate a TOTP secret, pin `policy` (or the policy already on disk)
    /// to it and publish it into the runtime filesystem. The secret comes back exactly once.
    #[serde(rename = "seal-policy")]
    SealPolicy {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        policy: Option<serde_json::Value>,
        /// TOTP parameters to enrol with; the defaults (SHA1, 6 digits, 30 s) suit every app.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        totp: Option<TotpConfig>,
    },
    /// Remove the seal after a valid `code`. With `removePolicy` the policy file goes too, so
    /// the machine comes back unmanaged.
    #[serde(rename = "unseal-policy")]
    UnsealPolicy {
        code: String,
        #[serde(
            default,
            rename = "removePolicy",
            skip_serializing_if = "Option::is_none"
        )]
        remove_policy: Option<bool>,
    },
    /// The seal, the runtime filesystem and the remote-configuration state, without secrets.
    #[serde(rename = "seal-status")]
    SealStatus,
    /// Apply a policy chain the app fetched (`chain.rs` decides whether to believe it).
    /// `document` is the response body verbatim — the signatures cover those bytes.
    #[serde(rename = "remote-apply")]
    RemoteApply {
        document: String,
    },
    /// Paste a **Remote Link**: the base64 blob that points this machine at a policy chain and
    /// pins the key signing it. On an unlinked machine this is what seals it, in whichever mode
    /// the blob names. On a machine already linked in `totp` mode it needs a `code`; on one in
    /// `chain` mode it is refused outright — only a signed link can move that machine.
    #[serde(rename = "set-remote-link")]
    SetRemoteLink {
        blob: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Whether a downloaded pack may be installed: the app hashes the bytes, the daemon checks
    /// the hash and the administrator's signature against the key it pins.
    #[serde(rename = "verify-pack")]
    VerifyPack {
        id: String,
        sha256: String,
    },
    /// Keepalive registration: how to relaunch the app in the requester's session when this
    /// connection drops without `unregister` while the policy says `app.allowQuit: false`.
    Register {
        exec: String,
        args: Vec<String>,
        cwd: String,
        env: std::collections::BTreeMap<String, String>,
    },
    /// Forget this connection's registration (an intended exit follows).
    Unregister,
    /// System install: verify `file` (an AppImage the requesting user downloaded) against
    /// `sha512`, extract it as that user, swap it into `<install-root>/current` and update the
    /// daemon itself when the bundle ships a newer one.
    #[serde(rename = "apply-update")]
    ApplyUpdate {
        file: String,
        version: String,
        sha512: String,
    },
    /// Session guard: (re)generate and load the AppArmor profiles from the policy now (also
    /// done at start and whenever the policy file changes).
    #[serde(rename = "guard-apply")]
    GuardApply,
    /// Session guard: what is engaged, without touching anything.
    #[serde(rename = "guard-status")]
    GuardStatus,
    /// Receive server-pushed `{ "ev": … }` lines on this connection for the named events
    /// (`guard-attempt`). Replaces an earlier subscription on the same connection.
    Subscribe {
        events: Vec<String>,
    },
}

impl Request {
    /// The `op` name as it appears on the wire (for logs).
    pub fn op(&self) -> &'static str {
        match self {
            Request::Hello { .. } => "hello",
            Request::Status => "status",
            Request::Policy => "policy",
            Request::Lock { .. } => "lock",
            Request::Unlock => "unlock",
            Request::Type { .. } => "type",
            Request::Key { .. } => "key",
            Request::Click { .. } => "click",
            Request::Move { .. } => "move",
            Request::SetPolicy { .. } => "set-policy",
            Request::SealPolicy { .. } => "seal-policy",
            Request::UnsealPolicy { .. } => "unseal-policy",
            Request::SealStatus => "seal-status",
            Request::RemoteApply { .. } => "remote-apply",
            Request::SetRemoteLink { .. } => "set-remote-link",
            Request::VerifyPack { .. } => "verify-pack",
            Request::Register { .. } => "register",
            Request::Unregister => "unregister",
            Request::ApplyUpdate { .. } => "apply-update",
            Request::GuardApply => "guard-apply",
            Request::GuardStatus => "guard-status",
            Request::Subscribe { .. } => "subscribe",
        }
    }
}

/// Parse one line. `Ok(None)` for blank lines, `Err` with a message for anything else.
pub fn parse_line(line: &str) -> Result<Option<Request>, String> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<Request>(line)
        .map(Some)
        .map_err(|e| format!("invalid request: {e}"))
}

// ---------------------------------------------------------------------------
// Responses (daemon → app)
// ---------------------------------------------------------------------------

/// Error codes, matching the `code` union in `DaemonResponse`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// The daemon declined to serve the request in its current state (unsupported protocol
    /// version, shutting down).
    Refused,
    /// The policy file forbids it (`inputLock.enabled === false`) or is unreadable/invalid.
    Policy,
    /// No input devices to grab, or no uinput device for injection.
    NoDevices,
    /// A device is grabbed by another process (EBUSY) or the injector is in use.
    Busy,
    /// Malformed or out-of-range request.
    Invalid,
    /// Unexpected I/O failure; details in `error` and the journal.
    Internal,
    /// `set-policy` while a policy file already exists (only root can change it).
    Exists,
    /// A TOTP code was needed and was missing, wrong, replayed or locked out.
    Code,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 8] = [
        ErrorCode::Refused,
        ErrorCode::Policy,
        ErrorCode::NoDevices,
        ErrorCode::Busy,
        ErrorCode::Invalid,
        ErrorCode::Internal,
        ErrorCode::Exists,
        ErrorCode::Code,
    ];
}

/// Device summary reported by `hello`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeviceCounts {
    pub keyboards: u32,
    pub pointers: u32,
    pub uinput: bool,
}

/// `status.locked` / `DaemonStatus.locked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo {
    /// ISO-8601 (RFC 3339, UTC, millisecond precision) time the lock ends.
    pub until: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub devices: LockDevices,
}

/// `status.keepalive` (`KeepaliveInfo` in `@rp/shared`): relaunch registration state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveInfo {
    /// Whether any connection currently holds a registration.
    pub registered: bool,
    /// Relaunches performed since the daemon started.
    pub relaunches: u32,
    /// `app.allowQuit` from the policy (true without a policy).
    pub allow_quit: bool,
}

/// `status.install` (`InstallInfo` in `@rp/shared`): the system install as the daemon sees it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    /// `<install-root>/current/rpchat` exists and `versions.json` describes it.
    pub system_install: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    /// The running daemon's version (what `apply-update` compares the bundled one against).
    pub daemon_version: String,
}

/// `seal-status.seal` (`SealInfo` in `@rp/shared`): what the seal is, never what it knows.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealInfo {
    pub sealed: bool,
    /// Which way in this machine has: a code (`totp`) or a signed chain (`chain`).
    #[serde(default)]
    pub mode: SealMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// SHA-256 of the sealed policy: the app compares it with what it was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    /// The TOTP parameters — absent in `chain` mode, where there is no code at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<TotpConfig>,
    /// Consecutive wrong codes, and when the lockout they armed ends.
    pub failures: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<String>,
    /// Every place a copy of the seal is kept.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// The protections that are actually in place right now, not what the policy asked for.
    pub immutable: bool,
    pub self_heal: bool,
    pub deny_escapes: bool,
    pub refuse_manual_stop: bool,
    /// Noticed changes to the sealed files, newest last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tampers: Vec<TamperRecord>,
    /// What this seal cannot protect against, one sentence each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub residual: Vec<String>,
}

/// `seal-status.remote` (`RemoteInfo` in `@rp/shared`): where the policy comes from and how the
/// last fetch went. The daemon never fetches anything itself; the app reports back through
/// `remote-apply`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    /// This machine has a Remote Link, so it has somewhere to fetch from and a key to check it.
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub enabled: bool,
    pub interval_minutes: u64,
    /// The pinned public key (base64) and the name the administrator gave it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Where the machine is on its chain: the last link's `seq` and hash.
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// When the Remote Link was pasted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_at: Option<String>,
    /// Keys this chain has rotated through, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// The packs the policy pins, for the app to install.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packs: Vec<crate::remote::PackSource>,
    pub remove_unlisted: bool,
    pub pack_refresh_minutes: u64,
}

/// Payload of a successful response; the `op` tag names the request it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Ok {
    Hello {
        version: String,
        protocol: u32,
        devices: DeviceCounts,
    },
    Status {
        locked: Option<LockInfo>,
        keepalive: KeepaliveInfo,
        install: InstallInfo,
        /// The session guard (`GuardInfo` in `@rp/shared`).
        guard: GuardInfo,
    },
    Policy {
        policy: Option<PolicyFile>,
        path: String,
    },
    Lock {
        until: String,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        devices: LockDevices,
    },
    Unlock,
    /// `skipped` is an extension over the shared contract: characters the US keymap could
    /// not produce (the app ignores unknown fields).
    Type {
        skipped: u32,
    },
    Key,
    Click,
    Move,
    /// The policy file that was just created or replaced.
    #[serde(rename = "set-policy")]
    SetPolicy {
        path: String,
        /// Whether an existing policy was replaced (a sealed machine) rather than created.
        replaced: bool,
    },
    /// The machine is now sealed in code mode. `secret` and `otpauth` are the only time either
    /// is shown. Linking a machine to a policy chain is `set-remote-link`, not this.
    #[serde(rename = "seal-policy")]
    SealPolicy {
        path: String,
        secret: String,
        otpauth: String,
        seal: SealInfo,
        runtime: RuntimeInfo,
    },
    #[serde(rename = "unseal-policy")]
    UnsealPolicy {
        path: String,
        /// Whether the policy file was removed as well.
        removed: bool,
    },
    #[serde(rename = "seal-status")]
    SealStatus {
        seal: SealInfo,
        runtime: RuntimeInfo,
        remote: RemoteInfo,
    },
    #[serde(rename = "remote-apply")]
    RemoteApply {
        /// Whether the chain moved (a re-fetch of the same file does not).
        changed: bool,
        /// How many links were verified in this walk.
        applied: u32,
        seq: u64,
        /// The last link asked for the seal to be lifted, and it was.
        unsealed: bool,
        #[serde(rename = "policyHash")]
        policy_hash: String,
        runtime: RuntimeInfo,
        remote: RemoteInfo,
    },
    /// The machine is now linked. `secret`/`otpauth` are present only when the blob asked for
    /// `totp` mode and this was the link that sealed it — the one time either is readable.
    #[serde(rename = "set-remote-link")]
    SetRemoteLink {
        mode: SealMode,
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        otpauth: Option<String>,
        seal: SealInfo,
        runtime: RuntimeInfo,
        remote: RemoteInfo,
    },
    #[serde(rename = "verify-pack")]
    VerifyPack {
        /// Whether the administrator's key vouched for this pack (false on a machine with no key,
        /// where only the checksum was available).
        signed: bool,
    },
    Register,
    Unregister,
    /// The version now under `current`; `restartDaemon` says the daemon updated itself and is
    /// about to restart (the app should wait for it before relaunching).
    #[serde(rename = "apply-update")]
    ApplyUpdate {
        version: String,
        #[serde(rename = "restartDaemon")]
        restart_daemon: bool,
    },
    #[serde(rename = "guard-apply")]
    GuardApply {
        guard: GuardInfo,
    },
    #[serde(rename = "guard-status")]
    GuardStatus {
        guard: GuardInfo,
    },
    /// The events this connection now receives.
    Subscribe {
        events: Vec<String>,
    },
}

/// Names of the events a connection may subscribe to.
pub const EVENT_NAMES: [&str; 3] = ["guard-attempt", "policy-tamper", "policy-changed"];

/// A server-pushed line (`DaemonEvent` in `@rp/shared`): `{ "ev": "guard-attempt", "at", … }`.
/// Distinguished from responses by the `ev` key; the app dispatches it to listeners instead of
/// matching it against a pending request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "ev", rename_all = "kebab-case")]
pub enum Event {
    GuardAttempt {
        at: String,
        #[serde(flatten)]
        attempt: GuardAttempt,
    },
    /// A sealed file was changed behind the daemon's back, and what it did about it.
    PolicyTamper {
        at: String,
        #[serde(flatten)]
        tamper: TamperRecord,
    },
    /// The effective policy changed (a code-authorised write, a remote configuration, or a
    /// restore from the seal). The app re-reads the runtime policy when it sees this.
    PolicyChanged {
        at: String,
        /// `local`, `remote` or `seal`.
        source: String,
        #[serde(rename = "policyHash")]
        policy_hash: String,
    },
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::GuardAttempt { .. } => "guard-attempt",
            Event::PolicyTamper { .. } => "policy-tamper",
            Event::PolicyChanged { .. } => "policy-changed",
        }
    }

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("event serialises")
    }
}

/// Marker that serialises as the JSON literal `true` and refuses anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            true => std::result::Result::Ok(True),
            false => Err(de::Error::custom("expected `ok: true`")),
        }
    }
}

/// Marker that serialises as the JSON literal `false` and refuses anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct False;

impl Serialize for False {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            false => std::result::Result::Ok(False),
            true => Err(de::Error::custom("expected `ok: false`")),
        }
    }
}

/// `{ ok: true, op, ... }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: True,
    #[serde(flatten)]
    pub payload: Ok,
}

/// `{ ok: false, error, code }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrResponse {
    pub ok: False,
    pub error: String,
    pub code: ErrorCode,
}

/// One response line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)] // `Ok::Status` carries the guard info; responses are short-lived
pub enum Response {
    Ok(OkResponse),
    Err(ErrResponse),
}

impl Response {
    pub fn ok(payload: Ok) -> Response {
        Response::Ok(OkResponse { ok: True, payload })
    }

    pub fn err(code: ErrorCode, error: impl Into<String>) -> Response {
        Response::Err(ErrResponse {
            ok: False,
            error: error.into(),
            code,
        })
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Response::Ok(_))
    }

    /// The single JSON line for this response (no trailing newline).
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("response serialises")
    }
}

/// A request handler failure that becomes an error response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonError {
    pub code: ErrorCode,
    pub message: String,
}

impl DaemonError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        DaemonError {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl fmt::Display for DaemonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for DaemonError {}

impl From<DaemonError> for Response {
    fn from(e: DaemonError) -> Response {
        Response::err(e.code, e.message)
    }
}

pub type DaemonResult<T> = Result<T, DaemonError>;

/// Format a unix-epoch millisecond timestamp as RFC 3339 UTC with millisecond precision
/// (`2026-01-02T03:04:05.678Z`), the shape `new Date().toISOString()` produces.
pub fn iso_millis(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let millis = unix_ms % 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm), days since 1970-01-01.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn round_trip_request(v: Value) -> Request {
        let req: Request = serde_json::from_value(v.clone()).expect("parses");
        let back = serde_json::to_value(&req).expect("serialises");
        // Numbers may come back as floats (30000 → 30000.0); compare keys and the re-parsed value.
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&back), keys(&v), "request keys round trip");
        assert_eq!(
            serde_json::from_value::<Request>(back).expect("re-parses"),
            req,
            "request round trip"
        );
        req
    }

    fn round_trip_response(r: &Response, expected: Value) {
        let v = serde_json::to_value(r).expect("serialises");
        assert_eq!(v, expected, "response shape");
        let parsed: Response = serde_json::from_value(v).expect("parses back");
        assert_eq!(&parsed, r, "response round trip");
        assert!(r.to_line().ends_with('}') && !r.to_line().contains('\n'));
    }

    #[test]
    fn every_request_op_round_trips() {
        assert_eq!(
            round_trip_request(json!({"op":"hello","version":1})),
            Request::Hello { version: 1 }
        );
        assert_eq!(round_trip_request(json!({"op":"status"})), Request::Status);
        assert_eq!(round_trip_request(json!({"op":"policy"})), Request::Policy);
        assert_eq!(
            round_trip_request(
                json!({"op":"lock","durationMs":30000,"reason":"surprise","devices":"keyboard"})
            ),
            Request::Lock {
                duration_ms: 30000.0,
                reason: Some("surprise".into()),
                devices: Some(LockDevices::Keyboard)
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"lock","durationMs":1500.5})),
            Request::Lock {
                duration_ms: 1500.5,
                reason: None,
                devices: None
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"lock","durationMs":1,"devices":"mouse"})).op(),
            "lock"
        );
        assert!(parse_line(r#"{"op":"lock","durationMs":1,"devices":"trackball"}"#).is_err());
        assert_eq!(LockDevices::default(), LockDevices::Both);
        assert!(LockDevices::Both.wants_keyboard() && LockDevices::Both.wants_pointer());
        assert!(LockDevices::Keyboard.wants_keyboard() && !LockDevices::Keyboard.wants_pointer());
        assert!(!LockDevices::Mouse.wants_keyboard() && LockDevices::Mouse.wants_pointer());
        assert_eq!(LockDevices::Mouse.as_str(), "mouse");
        assert_eq!(round_trip_request(json!({"op":"unlock"})), Request::Unlock);
        assert_eq!(
            round_trip_request(json!({"op":"type","text":"hi"})),
            Request::Type { text: "hi".into() }
        );
        assert_eq!(
            round_trip_request(json!({"op":"key","combo":"ctrl+s"})),
            Request::Key {
                combo: "ctrl+s".into()
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"click","x":10,"y":20,"button":"right"})),
            Request::Click {
                x: 10.0,
                y: 20.0,
                button: Some(Button::Right)
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"click","x":1.5,"y":2.5})),
            Request::Click {
                x: 1.5,
                y: 2.5,
                button: None
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"move","x":0,"y":0})),
            Request::Move { x: 0.0, y: 0.0 }
        );
        assert_eq!(
            round_trip_request(json!({"op":"set-policy","policy":{"version":1,"managedBy":"me"}})),
            Request::SetPolicy {
                policy: json!({"version":1,"managedBy":"me"}),
                code: None,
            }
        );
        assert_eq!(
            round_trip_request(json!({"op":"set-policy","policy":{"version":1},"code":"123456"})),
            Request::SetPolicy {
                policy: json!({"version":1}),
                code: Some("123456".into()),
            }
        );
        assert!(
            parse_line(r#"{"op":"set-policy"}"#).is_err(),
            "policy is required"
        );
        assert!(
            parse_line(r#"{"op":"setpolicy","policy":{}}"#).is_err(),
            "the op is kebab-case on the wire"
        );
        let reg = round_trip_request(
            json!({"op":"register","exec":"/usr/bin/rpchat","args":["--hidden"],"cwd":"/home/a","env":{"HOME":"/home/a","DISPLAY":":0"}}),
        );
        assert_eq!(
            reg,
            Request::Register {
                exec: "/usr/bin/rpchat".into(),
                args: vec!["--hidden".into()],
                cwd: "/home/a".into(),
                env: [("DISPLAY", ":0"), ("HOME", "/home/a")]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            }
        );
        assert!(
            parse_line(r#"{"op":"register","exec":"/x"}"#).is_err(),
            "args/cwd/env required"
        );
        assert!(
            parse_line(r#"{"op":"register","exec":"/x","args":"no","cwd":"/","env":{}}"#).is_err()
        );
        assert!(
            parse_line(r#"{"op":"register","exec":"/x","args":[],"cwd":"/","env":{"A":1}}"#)
                .is_err()
        );
        assert_eq!(
            round_trip_request(json!({"op":"unregister"})),
            Request::Unregister
        );
        assert_eq!(
            round_trip_request(
                json!({"op":"apply-update","file":"/home/a/.cache/rpchat-updater/pending/x.AppImage","version":"0.1.9","sha512":"AAAA"})
            ),
            Request::ApplyUpdate {
                file: "/home/a/.cache/rpchat-updater/pending/x.AppImage".into(),
                version: "0.1.9".into(),
                sha512: "AAAA".into(),
            }
        );
        assert!(
            parse_line(r#"{"op":"apply-update","file":"/x"}"#).is_err(),
            "version and sha512 are required"
        );
        assert!(
            parse_line(r#"{"op":"apply-update","file":"/x","version":1,"sha512":""}"#).is_err()
        );
        assert_eq!(
            round_trip_request(json!({"op":"guard-apply"})),
            Request::GuardApply
        );
        assert_eq!(
            round_trip_request(json!({"op":"guard-status"})),
            Request::GuardStatus
        );
        assert_eq!(
            round_trip_request(json!({"op":"subscribe","events":["guard-attempt"]})),
            Request::Subscribe {
                events: vec!["guard-attempt".into()]
            }
        );
        assert!(
            parse_line(r#"{"op":"subscribe"}"#).is_err(),
            "events required"
        );
        assert!(parse_line(r#"{"op":"subscribe","events":"guard-attempt"}"#).is_err());
    }

    #[test]
    fn request_op_names_match_wire() {
        for (v, name) in [
            (json!({"op":"hello","version":1}), "hello"),
            (json!({"op":"status"}), "status"),
            (json!({"op":"guard-apply"}), "guard-apply"),
            (json!({"op":"guard-status"}), "guard-status"),
            (json!({"op":"subscribe","events":[]}), "subscribe"),
            (json!({"op":"policy"}), "policy"),
            (json!({"op":"lock","durationMs":1}), "lock"),
            (json!({"op":"unlock"}), "unlock"),
            (json!({"op":"type","text":""}), "type"),
            (json!({"op":"key","combo":""}), "key"),
            (json!({"op":"click","x":0,"y":0}), "click"),
            (json!({"op":"move","x":0,"y":0}), "move"),
            (json!({"op":"set-policy","policy":{}}), "set-policy"),
            (
                json!({"op":"register","exec":"/x","args":[],"cwd":"/","env":{}}),
                "register",
            ),
            (json!({"op":"unregister"}), "unregister"),
            (
                json!({"op":"apply-update","file":"/x","version":"1.0.0","sha512":"a"}),
                "apply-update",
            ),
        ] {
            let req: Request = serde_json::from_value(v).unwrap();
            assert_eq!(req.op(), name);
        }
    }

    #[test]
    fn parse_line_handles_blank_unknown_and_garbage() {
        assert_eq!(parse_line("  \n"), std::result::Result::Ok(None));
        assert_eq!(
            parse_line(r#"{"op":"status"}"#),
            std::result::Result::Ok(Some(Request::Status))
        );
        assert!(parse_line(r#"{"op":"reboot"}"#)
            .unwrap_err()
            .contains("invalid request"));
        assert!(parse_line("not json").is_err());
        assert!(
            parse_line(r#"{"op":"lock"}"#).is_err(),
            "durationMs is required"
        );
        assert!(
            parse_line(r#"{"op":"lock","durationMs":"5"}"#).is_err(),
            "durationMs must be a number"
        );
        assert!(parse_line(r#"{"op":"click","x":1,"y":2,"button":"back"}"#).is_err());
        // Unknown extra fields are tolerated.
        assert_eq!(
            parse_line(r#"{"op":"status","seq":4}"#),
            std::result::Result::Ok(Some(Request::Status))
        );
    }

    #[test]
    fn every_ok_response_round_trips() {
        round_trip_response(
            &Response::ok(Ok::Hello {
                version: "0.1.0".into(),
                protocol: PROTOCOL_VERSION,
                devices: DeviceCounts {
                    keyboards: 1,
                    pointers: 2,
                    uinput: true,
                },
            }),
            json!({"ok":true,"op":"hello","version":"0.1.0","protocol":1,"devices":{"keyboards":1,"pointers":2,"uinput":true}}),
        );
        let ka = KeepaliveInfo {
            registered: false,
            relaunches: 0,
            allow_quit: true,
        };
        let ka_json = json!({"registered":false,"relaunches":0,"allowQuit":true});
        let install = InstallInfo {
            system_install: false,
            current: None,
            previous: None,
            daemon_version: "0.1.0".into(),
        };
        let install_json = json!({"systemInstall":false,"daemonVersion":"0.1.0"});
        let guard = GuardInfo::default();
        let guard_json =
            json!({"available":false,"mode":"off","loaded":[],"users":[],"residual":[]});
        round_trip_response(
            &Response::ok(Ok::Status {
                locked: None,
                keepalive: ka,
                install: install.clone(),
                guard: guard.clone(),
            }),
            json!({"ok":true,"op":"status","locked":null,"keepalive":ka_json,"install":install_json,"guard":guard_json}),
        );
        round_trip_response(
            &Response::ok(Ok::Status {
                locked: None,
                keepalive: ka,
                install: InstallInfo {
                    system_install: true,
                    current: Some("0.1.9".into()),
                    previous: Some("0.1.8".into()),
                    daemon_version: "0.1.0".into(),
                },
                guard: guard.clone(),
            }),
            json!({"ok":true,"op":"status","locked":null,"keepalive":ka_json,"install":{"systemInstall":true,"current":"0.1.9","previous":"0.1.8","daemonVersion":"0.1.0"},"guard":guard_json}),
        );
        let engaged = GuardInfo {
            available: true,
            mode: crate::policy::GuardMode::Audit,
            loaded: vec!["rpchat-session".into()],
            users: vec!["work".into()],
            residual: vec!["audit mode".into()],
            warnings: vec![],
            pam_configured: Some(true),
            shell: Some("noctalia".into()),
            compositor: Some("hyprland".into()),
            applied_at: Some("2026-09-14T12:00:00.000Z".into()),
            last_error: None,
        };
        let engaged_json = json!({"available":true,"mode":"audit","loaded":["rpchat-session"],"users":["work"],"residual":["audit mode"],"pamConfigured":true,"shell":"noctalia","compositor":"hyprland","appliedAt":"2026-09-14T12:00:00.000Z"});
        round_trip_response(
            &Response::ok(Ok::GuardApply {
                guard: engaged.clone(),
            }),
            json!({"ok":true,"op":"guard-apply","guard":engaged_json}),
        );
        round_trip_response(
            &Response::ok(Ok::GuardStatus { guard: engaged }),
            json!({"ok":true,"op":"guard-status","guard":engaged_json}),
        );
        round_trip_response(
            &Response::ok(Ok::Subscribe {
                events: vec!["guard-attempt".into()],
            }),
            json!({"ok":true,"op":"subscribe","events":["guard-attempt"]}),
        );
        // Pushed events carry `ev` instead of `ok`/`op`.
        let ev = Event::GuardAttempt {
            at: "2026-09-14T12:00:00.000Z".into(),
            attempt: GuardAttempt {
                kind: crate::guard::AttemptKind::Ipc,
                target: "/run/user/1000/hypr/x/.socket.sock".into(),
                command: "hyprctl".into(),
                pid: 42,
                blocked: false,
                profile: "rpchat-session".into(),
                operation: "connect".into(),
                requested: Some("wr".into()),
            },
        };
        let v: Value = serde_json::from_str(&ev.to_line()).unwrap();
        assert_eq!(
            v,
            json!({"ev":"guard-attempt","at":"2026-09-14T12:00:00.000Z","kind":"ipc","target":"/run/user/1000/hypr/x/.socket.sock","command":"hyprctl","pid":42,"blocked":false,"profile":"rpchat-session","operation":"connect","requested":"wr"})
        );
        assert_eq!(serde_json::from_value::<Event>(v).unwrap(), ev);
        assert_eq!(ev.name(), "guard-attempt");
        assert!(
            serde_json::from_str::<Response>(&ev.to_line()).is_err(),
            "an event is not a response"
        );
        round_trip_response(
            &Response::ok(Ok::ApplyUpdate {
                version: "0.1.9".into(),
                restart_daemon: true,
            }),
            json!({"ok":true,"op":"apply-update","version":"0.1.9","restartDaemon":true}),
        );
        round_trip_response(
            &Response::ok(Ok::Status {
                locked: Some(LockInfo {
                    until: "2026-01-01T00:00:00.000Z".into(),
                    reason: Some("r".into()),
                    devices: LockDevices::Both,
                }),
                keepalive: KeepaliveInfo {
                    registered: true,
                    relaunches: 3,
                    allow_quit: false,
                },
                install: install.clone(),
                guard: guard.clone(),
            }),
            json!({"ok":true,"op":"status","locked":{"until":"2026-01-01T00:00:00.000Z","reason":"r","devices":"both"},"keepalive":{"registered":true,"relaunches":3,"allowQuit":false},"install":install_json,"guard":guard_json}),
        );
        round_trip_response(
            &Response::ok(Ok::Status {
                locked: Some(LockInfo {
                    until: "2026-01-01T00:00:00.000Z".into(),
                    reason: None,
                    devices: LockDevices::Mouse,
                }),
                keepalive: ka,
                install,
                guard,
            }),
            json!({"ok":true,"op":"status","locked":{"until":"2026-01-01T00:00:00.000Z","devices":"mouse"},"keepalive":ka_json,"install":install_json,"guard":guard_json}),
        );
        round_trip_response(
            &Response::ok(Ok::Register),
            json!({"ok":true,"op":"register"}),
        );
        round_trip_response(
            &Response::ok(Ok::Unregister),
            json!({"ok":true,"op":"unregister"}),
        );
        round_trip_response(
            &Response::ok(Ok::Policy {
                policy: None,
                path: "/etc/rpchat/policy.json".into(),
            }),
            json!({"ok":true,"op":"policy","policy":null,"path":"/etc/rpchat/policy.json"}),
        );
        let policy: PolicyFile = serde_json::from_value(
            json!({"version":1,"managedBy":"IT","inputLock":{"enabled":true}}),
        )
        .unwrap();
        round_trip_response(
            &Response::ok(Ok::Policy {
                policy: Some(policy),
                path: "/p".into(),
            }),
            json!({"ok":true,"op":"policy","policy":{"version":1,"managedBy":"IT","inputLock":{"enabled":true}},"path":"/p"}),
        );
        round_trip_response(
            &Response::ok(Ok::Lock {
                until: "2026-01-01T00:00:30.000Z".into(),
                duration_ms: 30000,
                devices: LockDevices::Keyboard,
            }),
            json!({"ok":true,"op":"lock","until":"2026-01-01T00:00:30.000Z","durationMs":30000,"devices":"keyboard"}),
        );
        round_trip_response(&Response::ok(Ok::Unlock), json!({"ok":true,"op":"unlock"}));
        round_trip_response(
            &Response::ok(Ok::Type { skipped: 2 }),
            json!({"ok":true,"op":"type","skipped":2}),
        );
        round_trip_response(&Response::ok(Ok::Key), json!({"ok":true,"op":"key"}));
        round_trip_response(&Response::ok(Ok::Click), json!({"ok":true,"op":"click"}));
        round_trip_response(&Response::ok(Ok::Move), json!({"ok":true,"op":"move"}));
        round_trip_response(
            &Response::ok(Ok::SetPolicy {
                path: "/etc/rpchat/policy.json".into(),
                replaced: false,
            }),
            json!({"ok":true,"op":"set-policy","path":"/etc/rpchat/policy.json","replaced":false}),
        );
    }

    #[test]
    fn every_error_code_round_trips() {
        let names = [
            "REFUSED",
            "POLICY",
            "NO_DEVICES",
            "BUSY",
            "INVALID",
            "INTERNAL",
            "EXISTS",
            "CODE",
        ];
        assert_eq!(names.len(), ErrorCode::ALL.len());
        for (code, name) in ErrorCode::ALL.iter().zip(names) {
            round_trip_response(
                &Response::err(*code, "why"),
                json!({"ok":false,"error":"why","code":name}),
            );
        }
        let e: DaemonError = DaemonError::new(ErrorCode::Busy, "grabbed elsewhere");
        assert_eq!(
            Response::from(e.clone()),
            Response::err(ErrorCode::Busy, "grabbed elsewhere")
        );
        assert_eq!(e.to_string(), "Busy: grabbed elsewhere");
    }

    #[test]
    fn ok_marker_rejects_wrong_literal() {
        assert!(serde_json::from_str::<Response>(r#"{"ok":false,"op":"unlock"}"#).is_err());
        assert!(
            serde_json::from_str::<Response>(r#"{"ok":true,"error":"x","code":"BUSY"}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Response>(r#"{"ok":false,"error":"x","code":"NOPE"}"#).is_err()
        );
    }

    #[test]
    fn iso_millis_matches_javascript() {
        assert_eq!(iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_millis(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_millis(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }
}
