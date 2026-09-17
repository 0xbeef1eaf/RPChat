//! Per-user encryption key history for `sdk.crypto` (`packages/sdk/src/modules/crypto.ts`).
//!
//! Storing the key material in a root-owned file the requesting user cannot open directly is
//! the one thing this buys over the app keeping the key in its own config: a compromised pack
//! (or a bug in the sandbox) that can read the user's `$HOME` still cannot read the key file
//! itself, only ask the daemon for it over the group-gated socket. The daemon never accepts a
//! uid from the wire — every request is scoped by `SO_PEERCRED` (`ctx.peer.uid`), so a user can
//! only ever see or rotate their own history, never anyone else's.
//!
//! One file per uid: `<dir>/<uid>.json` (default `/etc/rpchat/crypto-keys`), directory `0700`,
//! file `0600`, both `root:root` — nobody but root (i.e. the daemon) can open it directly. A
//! user's first `crypto-keys` request creates their first key; `crypto-rotate-key` appends a
//! new one and makes it active. History is kept forever: old keys stay reachable so `decrypt`
//! still works on a file nobody has re-encrypted since the last rotation. The app's own
//! encryption log (path, before/after checksum, key id) holds no key material and lives
//! entirely in the app's own storage — this daemon never sees a file path or a checksum.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::protocol::{DaemonError, DaemonResult};
use crate::totp;

/// Default directory (`/etc/rpchat/crypto-keys`).
pub const DEFAULT_CRYPTO_KEYS_DIR: &str = "/etc/rpchat/crypto-keys";
/// AES-256-GCM key size.
pub const KEY_BYTES: usize = 32;
/// Refuse absurd files instead of parsing them; a lot of rotations is still a small file.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// One key in a user's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CryptoKeyRecord {
    /// Random, opaque; what `sdk.crypto`'s encryption log links a file back to.
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// AES-256 key material, base64.
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
struct KeyFile {
    #[serde(rename = "activeKeyId")]
    active_key_id: String,
    /// Oldest first.
    keys: Vec<CryptoKeyRecord>,
}

/// Reads, creates and rotates per-uid key histories under `dir`.
#[derive(Debug, Clone)]
pub struct CryptoKeyStore {
    dir: PathBuf,
}

impl Default for CryptoKeyStore {
    fn default() -> Self {
        CryptoKeyStore::new(DEFAULT_CRYPTO_KEYS_DIR)
    }
}

impl CryptoKeyStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        CryptoKeyStore { dir: dir.into() }
    }

    fn path_for(&self, uid: u32) -> PathBuf {
        self.dir.join(format!("{uid}.json"))
    }

    /// `uid`'s key history, oldest first, and the active key id. Creates a first key the first
    /// time this uid is seen.
    pub fn get_or_create(&self, uid: u32) -> DaemonResult<(Vec<CryptoKeyRecord>, String)> {
        match read_file(&self.path_for(uid))? {
            Some(file) if !file.keys.is_empty() => Ok((file.keys, file.active_key_id)),
            _ => self.rotate(uid),
        }
    }

    /// Generate a new key, append it to `uid`'s history and make it active. Returns the full
    /// history (oldest first, including the new key) and the new active key id.
    pub fn rotate(&self, uid: u32) -> DaemonResult<(Vec<CryptoKeyRecord>, String)> {
        let path = self.path_for(uid);
        let mut file = read_file(&path)?.unwrap_or_default();
        let record = new_record()?;
        file.active_key_id = record.id.clone();
        file.keys.push(record);
        write_file(&self.dir, &path, &file)?;
        Ok((file.keys, file.active_key_id))
    }
}

fn new_record() -> DaemonResult<CryptoKeyRecord> {
    let key = totp::random_bytes(KEY_BYTES)
        .map_err(|e| DaemonError::internal(format!("read /dev/urandom: {e}")))?;
    let id_bytes = totp::random_bytes(8)
        .map_err(|e| DaemonError::internal(format!("read /dev/urandom: {e}")))?;
    Ok(CryptoKeyRecord {
        id: hex_encode(&id_bytes),
        created_at: crate::seal::iso_secs(now_secs()),
        key: crate::seal::base64_encode(&key),
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_file(path: &Path) -> DaemonResult<Option<KeyFile>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(DaemonError::internal(format!(
                "stat {}: {e}",
                path.display()
            )))
        }
    };
    if !meta.is_file() {
        return Err(DaemonError::internal(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(DaemonError::internal(format!(
            "{} is implausibly large",
            path.display()
        )));
    }
    let text = fs::read_to_string(path)
        .map_err(|e| DaemonError::internal(format!("read {}: {e}", path.display())))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| DaemonError::internal(format!("corrupt {}: {e}", path.display())))
}

/// Write `file` to `path` atomically (temp file + rename); directory `0700`, file `0600`, both
/// root-owned. A member of the `rpchat` group can reach the daemon's socket but never this file.
fn write_file(dir: &Path, path: &Path, file: &KeyFile) -> DaemonResult<()> {
    if !dir.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| DaemonError::internal(format!("mkdir {}: {e}", dir.display())))?;
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| DaemonError::internal(format!("chmod {}: {e}", dir.display())))?;
    let text = serde_json::to_string_pretty(file)
        .map_err(|e| DaemonError::internal(format!("serialise: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    let io_err = |what: &str, e: std::io::Error| {
        DaemonError::internal(format!("{what} {}: {e}", tmp.display()))
    };
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| io_err("create", e))?;
    f.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| io_err("chmod", e))?;
    f.write_all(text.as_bytes())
        .map_err(|e| io_err("write", e))?;
    f.sync_all().map_err(|e| io_err("fsync", e))?;
    drop(f);
    fs::rename(&tmp, path)
        .map_err(|e| DaemonError::internal(format!("rename onto {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_creates_a_key_and_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let store = CryptoKeyStore::new(dir.path());
        let (keys, active) = store.get_or_create(1000).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].id, active);
        assert_eq!(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &keys[0].key)
                .unwrap()
                .len(),
            KEY_BYTES
        );

        // A second call sees the same key, not a new one.
        let (keys2, active2) = store.get_or_create(1000).unwrap();
        assert_eq!(keys2, keys);
        assert_eq!(active2, active);
    }

    #[test]
    fn rotate_appends_and_switches_the_active_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = CryptoKeyStore::new(dir.path());
        let (first, active1) = store.get_or_create(1000).unwrap();
        let (history, active2) = store.rotate(1000).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0], first[0]);
        assert_ne!(active1, active2);
        assert_eq!(history[1].id, active2);

        // History survives a fresh store over the same directory (persisted to disk).
        let reopened = CryptoKeyStore::new(dir.path());
        let (again, active3) = reopened.get_or_create(1000).unwrap();
        assert_eq!(again, history);
        assert_eq!(active3, active2);
    }

    #[test]
    fn different_uids_never_see_each_other_s_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = CryptoKeyStore::new(dir.path());
        let (a, _) = store.get_or_create(1000).unwrap();
        let (b, _) = store.get_or_create(1001).unwrap();
        assert_ne!(a[0].key, b[0].key);
        assert_ne!(a[0].id, b[0].id);
    }

    #[test]
    fn key_file_is_root_only_and_the_directory_is_not_group_readable() {
        let dir = tempfile::tempdir().unwrap();
        let store = CryptoKeyStore::new(dir.path());
        store.get_or_create(1000).unwrap();
        let file_mode = fs::metadata(dir.path().join("1000.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
        let dir_mode = fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }
}
