//! The **policy seal**: what turns the write-once policy file into one that can be replaced and
//! removed, but only by someone holding the enrolled authenticator app.
//!
//! Before the seal, `/etc/rpchat/policy.json` was write-once from the app's side and anything
//! afterwards was root's business. The seal keeps root's file but adds a second, root-only file
//! next to it (`policy.seal`, `0600`) holding a copy of the policy it sealed and the state that
//! decides who may change it. Every operation that would loosen the policy — replacing it,
//! removing it, or turning the seal itself off — has to satisfy that state.
//!
//! A seal is in exactly one of two **mutually exclusive modes**:
//!
//! - **`totp`** — the seal holds a TOTP secret. A person with the enrolled authenticator app
//!   types a code, and the policy becomes editable on this machine. This is the mode for a box
//!   you will stand in front of.
//! - **`chain`** — the seal holds no secret at all, only an Ed25519 **public** key and the hash of
//!   the last policy link it applied (`chain.rs`). There is no code and no local way in: the only
//!   thing that can change the policy is a signed link continuing the chain, and letting the
//!   machine go is itself a link (`unseal: true`). This is the mode for a fleet.
//!
//! Which one a machine is in is decided when it is sealed — by the **Remote Link** blob an
//! administrator pastes, or by the *Lock policy* button, which always means `totp`.
//!
//! What this buys against a local root is layered, and honestly limited; the layers are:
//!
//! 1. **Self-heal.** The daemon compares the policy file against the hash in the seal on every
//!    tick. An edited or deleted policy is rewritten from the sealed copy within seconds and the
//!    attempt is pushed to subscribers as `policy-tamper`. Editing the file therefore does not
//!    change what the app enforces, it just produces an audit record.
//! 2. **Mirrors.** The seal is kept in several places (`seal_paths`). Removing one copy restores
//!    it from the next on the following tick, so `rm /etc/rpchat/policy.seal` does not unseal.
//! 3. **Immutability.** With `lock.immutable` the policy, the seal and its mirrors carry the
//!    ext2/4 immutable attribute, so a plain `rm`/`>`/editor save fails outright — the attacker
//!    has to know to run `chattr -i` first.
//! 4. **The guard.** With the session guard in `enforce`, the confined users' sessions — and
//!    anything they start through `sudo`, which stays in the profile — cannot read or write
//!    `/etc/rpchat/**` at all, and `lock.denyEscapes` also takes away the binaries that leave
//!    the profile behind (`run0`, `machinectl`, `pkexec`, `chattr`, `apparmor_parser`) and
//!    confines `systemd-run`, whose system-manager half is one of them. That is the part that
//!    answers "but I have sudo".
//! 5. **The app fails closed.** The app caches the sealed policy and refuses to run unmanaged
//!    once it has seen a seal, so even a machine whose `/etc/rpchat` was wiped stays managed
//!    until a code unseals it (`docs/system-integration.md`).
//!
//! What it does not buy: a root shell that is *not* confined by the guard can read this file and
//! mint its own codes, and a machine booted from other media has no daemon running at all. Both
//! are listed as residuals in `seal-status` so nobody mistakes this for a TPM.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nix::libc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::totp::{self, TotpConfig, VerifyError};

/// Default seal location: next to the policy file, readable by root only.
pub const DEFAULT_SEAL_PATH: &str = "/etc/rpchat/policy.seal";
/// Mirror locations, tried in order when the primary is gone (see layer 2 above).
pub const DEFAULT_SEAL_MIRRORS: [&str; 2] = [
    "/var/lib/rpchat/policy.seal",
    "/usr/local/libexec/rpchat/policy.seal",
];
/// World-readable marker so the app (running as the user) can tell it is on a sealed machine
/// without being able to read the secret.
pub const DEFAULT_SEAL_MARKER_PATH: &str = "/etc/rpchat/policy.sealed";
/// Refuse absurd seal files instead of parsing them.
pub const MAX_SEAL_BYTES: u64 = 512 * 1024;
/// Failed codes tolerated before the lockout ladder starts.
pub const FREE_ATTEMPTS: u32 = 3;
/// First lockout step, in seconds; it doubles per failure up to [`MAX_LOCKOUT_SECS`].
pub const LOCKOUT_STEP_SECS: u64 = 30;
pub const MAX_LOCKOUT_SECS: u64 = 15 * 60;

/// `lock` block of the policy file: the knobs that decide how hard the seal holds. The secret
/// itself is never here — the policy file is world-readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<totp::Algorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digits: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<u32>,
    /// Restore the sealed policy when the file is edited or removed. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_heal: Option<bool>,
    /// Set the immutable attribute on the policy and the seal. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immutable: Option<bool>,
    /// Write the `RefuseManualStop=yes` drop-in for the daemon's unit. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refuse_manual_stop: Option<bool>,
    /// Take the profile-escaping binaries away from guarded sessions. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_escapes: Option<bool>,
}

/// [`LockPolicy`] with the defaults filled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockRules {
    pub totp: TotpConfig,
    pub self_heal: bool,
    pub immutable: bool,
    pub refuse_manual_stop: bool,
    pub deny_escapes: bool,
}

impl Default for LockRules {
    fn default() -> Self {
        LockRules {
            totp: TotpConfig::default(),
            self_heal: true,
            immutable: true,
            refuse_manual_stop: true,
            deny_escapes: true,
        }
    }
}

impl LockRules {
    pub fn from_policy(lock: Option<&LockPolicy>) -> LockRules {
        let mut out = LockRules::default();
        let Some(lock) = lock else { return out };
        let mut cfg = TotpConfig::default();
        if let Some(a) = lock.algorithm {
            cfg.algorithm = a;
        }
        if let Some(d) = lock.digits {
            cfg.digits = d;
        }
        if let Some(p) = lock.period {
            cfg.period = p;
        }
        if let Some(w) = lock.window {
            cfg.window = w;
        }
        out.totp = cfg.sanitised();
        out.self_heal = lock.self_heal.unwrap_or(true);
        out.immutable = lock.immutable.unwrap_or(true);
        out.refuse_manual_stop = lock.refuse_manual_stop.unwrap_or(true);
        out.deny_escapes = lock.deny_escapes.unwrap_or(true);
        out
    }
}

/// Validate a `lock` block beyond what serde enforces.
pub fn validate_lock(lock: &LockPolicy) -> Result<(), String> {
    if let Some(d) = lock.digits {
        if !(6..=8).contains(&d) {
            return Err("lock.digits must be 6, 7 or 8".into());
        }
    }
    if let Some(p) = lock.period {
        if !(totp::MIN_PERIOD..=totp::MAX_PERIOD).contains(&p) {
            return Err(format!(
                "lock.period must be between {} and {} seconds",
                totp::MIN_PERIOD,
                totp::MAX_PERIOD
            ));
        }
    }
    if let Some(w) = lock.window {
        if w > totp::MAX_WINDOW {
            return Err(format!("lock.window must be at most {}", totp::MAX_WINDOW));
        }
    }
    Ok(())
}

/// Which of the two ways in a seal uses. They are mutually exclusive on purpose: a machine with
/// both would be only as strong as the weaker one, and an administrator could not say in one
/// sentence how their fleet is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SealMode {
    /// A code from the enrolled authenticator app unlocks the machine locally.
    #[default]
    Totp,
    /// A signed policy chain is the only way in; nothing on the machine can authorise a change.
    Chain,
}

impl SealMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SealMode::Totp => "totp",
            SealMode::Chain => "chain",
        }
    }

    pub fn parse(text: &str) -> Option<SealMode> {
        match text {
            "totp" => Some(SealMode::Totp),
            "chain" => Some(SealMode::Chain),
            _ => None,
        }
    }
}

/// Where a machine is on its policy chain, and whose signatures it trusts. Set by the Remote Link
/// and moved forward by every link the daemon applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainState {
    /// Where the chain is published.
    pub url: String,
    /// The Ed25519 public key, base64, that links must be signed with. Rotated only by a link
    /// signed with the key it replaces.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Hash of the last link applied; empty before the genesis.
    #[serde(default)]
    pub head: String,
    /// `seq` of the last link applied; 0 before the genesis.
    #[serde(default)]
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u64>,
    /// When the Remote Link was pasted, and by whom it says the machine is managed.
    pub linked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// Every key this chain has rotated through, oldest first — the audit trail of the handover.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotations: Vec<String>,
}

/// The seal file itself. Root-only in `totp` mode, where it carries the secret; in `chain` mode
/// it holds nothing an attacker could use, only public material and a position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seal {
    pub version: u32,
    pub sealed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// Which way in this machine has.
    #[serde(default)]
    pub mode: SealMode,
    /// TOTP parameters and secret — `mode: totp` only. A `chain` seal has neither, which is the
    /// point: there is nothing on the machine that can mint an unlock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<TotpConfig>,
    /// The TOTP secret, base32 as an authenticator app takes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// The policy chain this machine follows — `mode: chain`, and also on a `totp` machine that
    /// has a Remote Link, where the chain delivers updates and the code is for local changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainState>,
    /// SHA-256 of the canonical JSON of `policy`, which is what the self-heal compares against.
    pub policy_hash: String,
    /// The sealed policy, restored when the file on disk stops matching.
    pub policy: Value,
    /// Newest TOTP counter already spent (replay protection).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_counter: Option<u64>,
    /// Consecutive failed codes, for the lockout ladder.
    #[serde(default)]
    pub failures: u32,
    /// Unix seconds until which codes are refused outright.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<u64>,
    /// Tamper records, newest last, capped at [`TAMPER_LOG_MAX`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tampers: Vec<TamperRecord>,
}

/// How many tamper records the seal keeps.
pub const TAMPER_LOG_MAX: usize = 20;

/// One noticed change to a sealed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TamperRecord {
    pub at: String,
    /// `policy-edited`, `policy-removed`, `seal-removed`.
    pub kind: String,
    pub path: String,
    /// Whether the daemon put it back.
    pub healed: bool,
}

/// The part of the seal the app is allowed to see (`policy.sealed`, mode 0644).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealMarker {
    pub version: u32,
    pub sealed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    pub policy_hash: String,
    #[serde(default)]
    pub mode: SealMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<TotpConfig>,
    /// The sealed policy itself: the app reads this when the policy file has been removed, so
    /// wiping `/etc/rpchat/policy.json` does not leave the app unmanaged.
    pub policy: Value,
}

/// Why a seal operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// A seal already exists (sealing twice).
    Exists(PathBuf),
    /// No seal on this machine (unsealing or verifying without one).
    Missing,
    /// The seal file is unreadable or not valid JSON.
    Broken(String),
    /// Too many wrong codes; `.0` is how many seconds are left.
    LockedOut(u64),
    /// The code was refused.
    Code(VerifyError),
    /// A code was offered to a machine that is held by a signed chain, which has none.
    NotTotp,
    Io(String),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Exists(p) => write!(f, "this machine is already sealed ({})", p.display()),
            SealError::Missing => write!(f, "this machine is not sealed"),
            SealError::Broken(m) => write!(f, "the policy seal is damaged: {m}"),
            SealError::LockedOut(secs) => write!(
                f,
                "too many wrong codes; try again in {secs} second{}",
                if *secs == 1 { "" } else { "s" }
            ),
            SealError::Code(e) => write!(f, "{e}"),
            SealError::NotTotp => write!(
                f,
                "this machine is held by a signed policy chain, not by a code: publish a link that unseals it"
            ),
            SealError::Io(m) => write!(f, "{m}"),
        }
    }
}

/// SHA-256 of `data`, lower-case hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The hash the seal pins: SHA-256 over the compact JSON of the policy value. `serde_json`'s
/// default map is ordered, so the same policy always hashes the same whatever order it was
/// written in, and a reformatted-but-equal file does not read as tampering.
pub fn policy_hash(policy: &Value) -> String {
    sha256_hex(serde_json::to_string(policy).unwrap_or_default().as_bytes())
}

/// Seconds of lockout after `failures` consecutive wrong codes (pure).
pub fn lockout_secs(failures: u32) -> u64 {
    if failures <= FREE_ATTEMPTS {
        return 0;
    }
    let steps = failures - FREE_ATTEMPTS - 1;
    LOCKOUT_STEP_SECS
        .saturating_mul(1u64 << steps.min(20))
        .min(MAX_LOCKOUT_SECS)
}

/// Unix seconds now.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// ISO-8601 (UTC, seconds) for a unix timestamp — the format every other timestamp in the
/// protocol uses.
pub fn iso_secs(unix_secs: u64) -> String {
    crate::protocol::iso_millis(unix_secs.saturating_mul(1000))
}

/// Where the seal lives: the primary file, its mirrors and the world-readable marker.
#[derive(Debug, Clone)]
pub struct SealPaths {
    pub seal: PathBuf,
    pub mirrors: Vec<PathBuf>,
    pub marker: PathBuf,
}

impl Default for SealPaths {
    fn default() -> Self {
        SealPaths {
            seal: PathBuf::from(DEFAULT_SEAL_PATH),
            mirrors: DEFAULT_SEAL_MIRRORS.iter().map(PathBuf::from).collect(),
            marker: PathBuf::from(DEFAULT_SEAL_MARKER_PATH),
        }
    }
}

impl SealPaths {
    /// Every location a seal may be read from, primary first.
    pub fn all(&self) -> Vec<PathBuf> {
        let mut out = vec![self.seal.clone()];
        out.extend(self.mirrors.iter().cloned());
        out
    }

    /// Put every seal path under `root` (tests, and `--seal <path>` style overrides).
    pub fn under(root: &Path) -> SealPaths {
        SealPaths {
            seal: root.join("policy.seal"),
            mirrors: vec![
                root.join("mirror-a/policy.seal"),
                root.join("mirror-b/policy.seal"),
            ],
            marker: root.join("policy.sealed"),
        }
    }
}

fn io<E: std::fmt::Display>(what: &str, e: E) -> SealError {
    SealError::Io(format!("{what}: {e}"))
}

/// Write `text` to `path` with `mode`, creating the parent directory and replacing whatever is
/// there (temp file + rename, so a reader never sees half a seal). The immutable attribute is
/// cleared first and restored by the caller.
fn write_file(path: &Path, text: &str, mode: u32) -> Result<(), SealError> {
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o755)
                .create(dir)
                .map_err(|e| io(&format!("mkdir {}", dir.display()), e))?;
        }
    }
    let tmp = path.with_extension("tmp-seal");
    let _ = set_immutable(path, false);
    let _ = fs::remove_file(&tmp);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&tmp)
        .map_err(|e| io(&format!("create {}", tmp.display()), e))?;
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|e| io("chmod", e))?;
    file.write_all(text.as_bytes())
        .map_err(|e| io(&format!("write {}", tmp.display()), e))?;
    file.sync_all().map_err(|e| io("fsync", e))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| io(&format!("rename onto {}", path.display()), e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Immutable attribute (ext2/3/4, btrfs, xfs, f2fs)
// ---------------------------------------------------------------------------

/// `FS_IOC_GETFLAGS` / `FS_IOC_SETFLAGS` (`_IOR('f', 1, long)` / `_IOW('f', 2, long)`), spelled
/// out rather than built with the ioctl macros so the daemon keeps its current nix features.
const FS_IOC_GETFLAGS: libc::c_ulong = 0x8008_6601;
const FS_IOC_SETFLAGS: libc::c_ulong = 0x4008_6602;
const FS_IMMUTABLE_FL: libc::c_long = 0x0000_0010;

/// Set or clear the immutable attribute on `path`. Best effort: filesystems that do not support
/// the ioctl (tmpfs, overlayfs, a container's root) answer `ENOTTY`/`EOPNOTSUPP` and the caller
/// carries on — the seal's other layers do not depend on it.
pub fn set_immutable(path: &Path, on: bool) -> Result<bool, String> {
    use std::os::unix::io::AsRawFd;
    let file = match fs::OpenOptions::new().read(true).open(path) {
        Ok(f) => f,
        Err(e) => return Err(format!("open {}: {e}", path.display())),
    };
    let mut flags: libc::c_long = 0;
    // SAFETY: `file` is open for reading and `flags` is a live `long`, which is what
    // FS_IOC_GETFLAGS writes through the pointer.
    let rc = unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_GETFLAGS, &mut flags) };
    if rc != 0 {
        return Err(format!(
            "FS_IOC_GETFLAGS {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let wanted = if on {
        flags | FS_IMMUTABLE_FL
    } else {
        flags & !FS_IMMUTABLE_FL
    };
    if wanted == flags {
        return Ok(false);
    }
    // SAFETY: same contract, FS_IOC_SETFLAGS reads the `long` behind the pointer.
    let rc = unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_SETFLAGS, &wanted) };
    if rc != 0 {
        return Err(format!(
            "FS_IOC_SETFLAGS {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(true)
}

/// Whether `path` currently carries the immutable attribute.
pub fn is_immutable(path: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(file) = fs::OpenOptions::new().read(true).open(path) else {
        return false;
    };
    let mut flags: libc::c_long = 0;
    // SAFETY: as in `set_immutable`.
    let rc = unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_GETFLAGS, &mut flags) };
    rc == 0 && (flags & FS_IMMUTABLE_FL) != 0
}

/// Reads, writes and repairs the seal across its locations.
#[derive(Debug, Clone)]
pub struct SealStore {
    pub paths: SealPaths,
}

impl SealStore {
    pub fn new(paths: SealPaths) -> Self {
        SealStore { paths }
    }

    /// Read one seal file.
    fn read_at(path: &Path) -> Result<Option<Seal>, SealError> {
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io(&format!("stat {}", path.display()), e)),
        };
        if !meta.is_file() {
            return Err(SealError::Broken(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        if meta.len() > MAX_SEAL_BYTES {
            return Err(SealError::Broken(format!(
                "{} is larger than {MAX_SEAL_BYTES} bytes",
                path.display()
            )));
        }
        let text =
            fs::read_to_string(path).map_err(|e| io(&format!("read {}", path.display()), e))?;
        let seal: Seal = serde_json::from_str(&text)
            .map_err(|e| SealError::Broken(format!("{}: {e}", path.display())))?;
        if seal.version != 1 {
            return Err(SealError::Broken(format!(
                "unsupported seal version {}",
                seal.version
            )));
        }
        Ok(Some(seal))
    }

    /// The seal, from the primary file or — when that is gone — the first mirror that still has
    /// one. Returns the seal and the paths that were missing it, which the caller restores.
    pub fn load_with_gaps(&self) -> Result<Option<(Seal, Vec<PathBuf>)>, SealError> {
        let mut found: Option<Seal> = None;
        let mut gaps = Vec::new();
        let mut broken: Option<SealError> = None;
        for path in self.paths.all() {
            match Self::read_at(&path) {
                Ok(Some(seal)) => {
                    if found.is_none() {
                        found = Some(seal);
                    }
                }
                Ok(None) => gaps.push(path),
                Err(e) => {
                    // A damaged copy is a gap to overwrite as long as another copy is intact;
                    // only report it when nothing readable is left.
                    gaps.push(path);
                    if broken.is_none() {
                        broken = Some(e);
                    }
                }
            }
        }
        match found {
            Some(seal) => Ok(Some((seal, gaps))),
            None => match broken {
                Some(e) => Err(e),
                None => Ok(None),
            },
        }
    }

    /// The seal, or `None` when this machine is not sealed.
    pub fn load(&self) -> Result<Option<Seal>, SealError> {
        Ok(self.load_with_gaps()?.map(|(seal, _)| seal))
    }

    pub fn sealed(&self) -> bool {
        matches!(self.load(), Ok(Some(_)))
    }

    /// Write the seal to every location plus the world-readable marker.
    pub fn save(&self, seal: &Seal, immutable: bool) -> Result<(), SealError> {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(seal).map_err(|e| io("serialise seal", e))?
        );
        for path in self.paths.all() {
            write_file(&path, &text, 0o600)?;
            if immutable {
                let _ = set_immutable(&path, true);
            }
        }
        let marker = SealMarker {
            version: 1,
            sealed_at: seal.sealed_at.clone(),
            managed_by: seal.managed_by.clone(),
            policy_hash: seal.policy_hash.clone(),
            mode: seal.mode,
            totp: seal.totp,
            policy: seal.policy.clone(),
        };
        let marker_text = format!(
            "{}\n",
            serde_json::to_string_pretty(&marker).map_err(|e| io("serialise marker", e))?
        );
        write_file(&self.paths.marker, &marker_text, 0o644)?;
        if immutable {
            let _ = set_immutable(&self.paths.marker, true);
        }
        Ok(())
    }

    /// Remove every copy of the seal and the marker (after a verified code).
    pub fn remove(&self) -> Result<(), SealError> {
        for path in self
            .paths
            .all()
            .into_iter()
            .chain([self.paths.marker.clone()])
        {
            let _ = set_immutable(&path, false);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io(&format!("remove {}", path.display()), e)),
            }
        }
        Ok(())
    }

    /// Seal `policy` with a fresh secret. Fails when a seal already exists — replacing one needs
    /// a code, which is `verify` + `reseal`.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        policy: Value,
        cfg: TotpConfig,
        managed_by: Option<String>,
        immutable: bool,
        now: u64,
    ) -> Result<(Seal, String), SealError> {
        if let Some((_, _)) = self.load_with_gaps()? {
            return Err(SealError::Exists(self.paths.seal.clone()));
        }
        let secret = totp::random_secret().map_err(|e| io("read /dev/urandom", e))?;
        let cfg = cfg.sanitised();
        let seal = Seal {
            version: 1,
            sealed_at: iso_secs(now),
            managed_by,
            mode: SealMode::Totp,
            totp: Some(cfg),
            secret: Some(totp::base32_encode(&secret)),
            chain: None,
            policy_hash: policy_hash(&policy),
            policy,
            last_counter: None,
            failures: 0,
            locked_until: None,
            tampers: Vec::new(),
        };
        self.save(&seal, immutable)?;
        Ok((seal, totp::otpauth_uri("rpchat", "policy", &secret, cfg)))
    }

    /// Seal `policy` in `chain` mode: no secret is generated, because there is nothing for one to
    /// authorise. The machine pins the key and the position from the Remote Link and from then on
    /// believes only what that key signs.
    pub fn create_chain(
        &self,
        policy: Value,
        chain: ChainState,
        managed_by: Option<String>,
        immutable: bool,
        now: u64,
    ) -> Result<Seal, SealError> {
        if self.load_with_gaps()?.is_some() {
            return Err(SealError::Exists(self.paths.seal.clone()));
        }
        let seal = Seal {
            version: 1,
            sealed_at: iso_secs(now),
            managed_by,
            mode: SealMode::Chain,
            totp: None,
            secret: None,
            chain: Some(chain),
            policy_hash: policy_hash(&policy),
            policy,
            last_counter: None,
            failures: 0,
            locked_until: None,
            tampers: Vec::new(),
        };
        self.save(&seal, immutable)?;
        Ok(seal)
    }

    /// Check `code` against the seal, applying the lockout ladder and the replay window, and
    /// persist the outcome either way. `Ok(seal)` is the seal as it stands after a success.
    pub fn verify(&self, code: &str, now: u64, immutable: bool) -> Result<Seal, SealError> {
        let Some((mut seal, gaps)) = self.load_with_gaps()? else {
            return Err(SealError::Missing);
        };
        if seal.mode != SealMode::Totp {
            return Err(SealError::NotTotp);
        }
        if let Some(until) = seal.locked_until {
            if now < until {
                return Err(SealError::LockedOut(until - now));
            }
        }
        let cfg = seal.totp.ok_or_else(|| {
            SealError::Broken("the seal is in code mode but carries no parameters".into())
        })?;
        let secret = seal
            .secret
            .as_deref()
            .and_then(totp::base32_decode)
            .filter(|s| (totp::MIN_SECRET_BYTES..=totp::MAX_SECRET_BYTES).contains(&s.len()))
            .ok_or_else(|| {
                SealError::Broken(format!(
                    "the stored secret is not {}..{} bytes of base32",
                    totp::MIN_SECRET_BYTES,
                    totp::MAX_SECRET_BYTES
                ))
            })?;
        match totp::verify(&secret, code, now, cfg, seal.last_counter) {
            Ok(counter) => {
                seal.last_counter = Some(counter);
                seal.failures = 0;
                seal.locked_until = None;
                self.save(&seal, immutable)?;
                Ok(seal)
            }
            Err(e) => {
                // A malformed entry (a typo) still counts: otherwise the ladder is trivially
                // avoided by sending short strings.
                seal.failures = seal.failures.saturating_add(1);
                let wait = lockout_secs(seal.failures);
                seal.locked_until = if wait > 0 { Some(now + wait) } else { None };
                let _ = gaps;
                self.save(&seal, immutable)?;
                Err(SealError::Code(e))
            }
        }
    }

    /// Replace the sealed policy, keeping the secret and the counters (after a verified code).
    pub fn reseal(
        &self,
        mut seal: Seal,
        policy: Value,
        managed_by: Option<String>,
        immutable: bool,
        now: u64,
    ) -> Result<Seal, SealError> {
        seal.policy_hash = policy_hash(&policy);
        seal.policy = policy;
        seal.managed_by = managed_by;
        seal.sealed_at = iso_secs(now);
        self.save(&seal, immutable)?;
        Ok(seal)
    }

    /// Record a noticed tamper in the seal (capped, newest last).
    pub fn note_tamper(&self, seal: &mut Seal, record: TamperRecord, immutable: bool) {
        seal.tampers.push(record);
        if seal.tampers.len() > TAMPER_LOG_MAX {
            let excess = seal.tampers.len() - TAMPER_LOG_MAX;
            seal.tampers.drain(0..excess);
        }
        if let Err(e) = self.save(seal, immutable) {
            log_warn!("cannot record the tamper in the seal: {e}");
        }
    }
}

/// Base64 (standard alphabet, padded) — the one place the daemon needs to *produce* base64.
#[cfg_attr(not(test), allow(dead_code))]
pub fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Decode base64, accepting both the standard and the URL-safe alphabet, padded or not. The
/// engines are tried one by one rather than through a trait object: `base64::Engine` has generic
/// methods, so it is not dyn-compatible.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine;
    let trimmed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = trimmed.as_bytes();
    STANDARD
        .decode(bytes)
        .or_else(|_| STANDARD_NO_PAD.decode(bytes))
        .or_else(|_| URL_SAFE.decode(bytes))
        .or_else(|_| URL_SAFE_NO_PAD.decode(bytes))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn paths(dir: &TempDir) -> SealPaths {
        SealPaths::under(dir.path())
    }

    fn policy() -> Value {
        json!({ "version": 1, "managedBy": "Acme", "app": { "allowQuit": false, "users": ["alice"] } })
    }

    fn code_now(seal: &Seal, now: u64) -> String {
        let cfg = seal.totp.expect("a code-mode seal");
        let secret =
            totp::base32_decode(seal.secret.as_deref().expect("a code-mode seal")).unwrap();
        totp::code_at(&secret, cfg.counter(now), cfg)
    }

    #[test]
    fn lockout_ladder_starts_after_the_free_attempts_and_is_capped() {
        assert_eq!(lockout_secs(0), 0);
        assert_eq!(lockout_secs(FREE_ATTEMPTS), 0);
        assert_eq!(lockout_secs(FREE_ATTEMPTS + 1), LOCKOUT_STEP_SECS);
        assert_eq!(lockout_secs(FREE_ATTEMPTS + 2), LOCKOUT_STEP_SECS * 2);
        assert_eq!(lockout_secs(FREE_ATTEMPTS + 3), LOCKOUT_STEP_SECS * 4);
        assert_eq!(lockout_secs(100), MAX_LOCKOUT_SECS);
    }

    #[test]
    fn policy_hash_ignores_key_order_and_formatting() {
        let a = json!({ "version": 1, "managedBy": "x" });
        let b = json!({ "managedBy": "x", "version": 1 });
        assert_eq!(policy_hash(&a), policy_hash(&b));
        assert_ne!(policy_hash(&a), policy_hash(&json!({ "version": 1 })));
    }

    #[test]
    fn create_writes_every_copy_and_the_marker() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        let (seal, uri) = store
            .create(
                policy(),
                TotpConfig::default(),
                Some("Acme".into()),
                false,
                1_700_000_000,
            )
            .unwrap();
        assert!(uri.starts_with("otpauth://totp/rpchat:policy?secret="));
        for p in store.paths.all() {
            assert!(p.exists(), "{} missing", p.display());
            let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{} mode", p.display());
        }
        let marker: SealMarker =
            serde_json::from_str(&fs::read_to_string(&store.paths.marker).unwrap()).unwrap();
        assert_eq!(marker.policy_hash, seal.policy_hash);
        assert_eq!(marker.policy, policy());
        // The marker must not carry the secret, in any spelling.
        let marker_text = fs::read_to_string(&store.paths.marker).unwrap();
        assert!(!marker_text.contains(seal.secret.as_deref().unwrap()));
        assert_eq!(
            fs::metadata(&store.paths.marker)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        // Sealing twice is refused.
        assert!(matches!(
            store.create(policy(), TotpConfig::default(), None, false, 1_700_000_000),
            Err(SealError::Exists(_))
        ));
    }

    #[test]
    fn a_removed_copy_is_found_in_a_mirror() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        store
            .create(policy(), TotpConfig::default(), None, false, 1_700_000_000)
            .unwrap();
        fs::remove_file(&store.paths.seal).unwrap();
        let (seal, gaps) = store.load_with_gaps().unwrap().expect("still sealed");
        assert_eq!(gaps, vec![store.paths.seal.clone()]);
        // Saving again fills the gap back in.
        store.save(&seal, false).unwrap();
        assert!(store.paths.seal.exists());
        // A corrupt primary with an intact mirror is still a seal.
        fs::write(&store.paths.seal, "{ not json").unwrap();
        assert!(store.load().unwrap().is_some());
        // Every copy gone means unsealed.
        store.remove().unwrap();
        assert!(store.load().unwrap().is_none());
        assert!(!store.paths.marker.exists());
    }

    #[test]
    fn verify_accepts_a_code_once_and_refuses_the_same_one_again() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        let now = 1_700_000_000u64;
        let (seal, _) = store
            .create(policy(), TotpConfig::default(), None, false, now)
            .unwrap();
        let code = code_now(&seal, now);
        let after = store.verify(&code, now, false).unwrap();
        assert_eq!(after.failures, 0);
        assert_eq!(after.last_counter, Some(seal.totp.unwrap().counter(now)));
        // The same code again is a replay, not a second unlock: watching someone type one buys
        // nothing, even inside its own 30-second step.
        assert!(matches!(
            store.verify(&code, now, false),
            Err(SealError::Code(VerifyError::Replayed))
        ));
    }

    #[test]
    fn wrong_codes_climb_the_lockout_ladder_and_a_good_one_clears_it() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        let now = 1_700_000_000u64;
        let (seal, _) = store
            .create(policy(), TotpConfig::default(), None, false, now)
            .unwrap();
        // The first FREE_ATTEMPTS wrong codes are refused without a wait.
        for attempt in 1..=FREE_ATTEMPTS {
            let err = store.verify("000000", now, false).unwrap_err();
            assert!(
                matches!(err, SealError::Code(_)),
                "attempt {attempt}: {err}"
            );
            assert_eq!(store.load().unwrap().unwrap().locked_until, None);
        }
        // The next one is still answered, but it arms the lockout.
        assert!(matches!(
            store.verify("000000", now, false),
            Err(SealError::Code(_))
        ));
        let armed = store.load().unwrap().unwrap();
        assert_eq!(armed.failures, FREE_ATTEMPTS + 1);
        assert_eq!(armed.locked_until, Some(now + LOCKOUT_STEP_SECS));
        // While it holds, even the right code is refused without being spent.
        let good = code_now(&seal, now);
        assert_eq!(
            store.verify(&good, now, false),
            Err(SealError::LockedOut(LOCKOUT_STEP_SECS))
        );
        assert_eq!(store.load().unwrap().unwrap().last_counter, None);
        // Once it expires, a good code clears the counters again.
        let later = now + LOCKOUT_STEP_SECS + 1;
        let cleared = store.verify(&code_now(&seal, later), later, false).unwrap();
        assert_eq!(cleared.failures, 0);
        assert_eq!(cleared.locked_until, None);
    }

    #[test]
    fn verify_without_a_seal_says_so() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        assert_eq!(store.verify("123456", 1, false), Err(SealError::Missing));
    }

    #[test]
    fn reseal_keeps_the_secret_and_repins_the_hash() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        let now = 1_700_000_000u64;
        let (seal, _) = store
            .create(policy(), TotpConfig::default(), None, false, now)
            .unwrap();
        let next = json!({ "version": 1, "managedBy": "Acme 2" });
        let resealed = store
            .reseal(
                seal.clone(),
                next.clone(),
                Some("Acme 2".into()),
                false,
                now + 10,
            )
            .unwrap();
        assert_eq!(resealed.secret, seal.secret);
        assert_eq!(resealed.mode, SealMode::Totp);
        assert_eq!(resealed.policy_hash, policy_hash(&next));
        assert_eq!(store.load().unwrap().unwrap().policy, next);
    }

    #[test]
    fn tamper_records_are_capped() {
        let dir = TempDir::new().unwrap();
        let store = SealStore::new(paths(&dir));
        let (mut seal, _) = store
            .create(policy(), TotpConfig::default(), None, false, 1)
            .unwrap();
        for i in 0..TAMPER_LOG_MAX + 5 {
            store.note_tamper(
                &mut seal,
                TamperRecord {
                    at: iso_secs(i as u64),
                    kind: "policy-edited".into(),
                    path: "/etc/rpchat/policy.json".into(),
                    healed: true,
                },
                false,
            );
        }
        assert_eq!(seal.tampers.len(), TAMPER_LOG_MAX);
        assert_eq!(
            seal.tampers.last().unwrap().at,
            iso_secs((TAMPER_LOG_MAX + 4) as u64)
        );
        assert_eq!(store.load().unwrap().unwrap().tampers.len(), TAMPER_LOG_MAX);
    }

    #[test]
    fn lock_rules_apply_the_documented_defaults() {
        let rules = LockRules::from_policy(None);
        assert!(
            rules.self_heal && rules.immutable && rules.refuse_manual_stop && rules.deny_escapes
        );
        assert_eq!(rules.totp, TotpConfig::default());
        let lock = LockPolicy {
            algorithm: Some(totp::Algorithm::Sha256),
            digits: Some(8),
            period: Some(60),
            window: Some(2),
            self_heal: Some(false),
            immutable: Some(false),
            refuse_manual_stop: Some(false),
            deny_escapes: Some(false),
        };
        let rules = LockRules::from_policy(Some(&lock));
        assert_eq!(rules.totp.digits, 8);
        assert_eq!(rules.totp.period, 60);
        assert!(
            !rules.self_heal
                && !rules.immutable
                && !rules.refuse_manual_stop
                && !rules.deny_escapes
        );
        assert_eq!(
            validate_lock(&LockPolicy {
                digits: Some(9),
                ..lock
            }),
            Err("lock.digits must be 6, 7 or 8".into())
        );
    }

    #[test]
    fn base64_round_trips_and_accepts_both_alphabets() {
        let data = vec![0u8, 1, 250, 251, 252, 253, 254, 255];
        let std = base64_encode(&data);
        assert_eq!(base64_decode(&std).unwrap(), data);
        assert_eq!(
            base64_decode(&std.replace('+', "-").replace('/', "_")).unwrap(),
            data
        );
        assert_eq!(base64_decode("not base64!!"), None);
    }
}
