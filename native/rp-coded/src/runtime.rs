//! The **runtime policy filesystem**: `/run/rp-code/policy`, a tmpfs the daemon mounts, fills and
//! remounts read-only, and the only place the app reads its policy from.
//!
//! Why this exists rather than letting everyone read `/etc/rp-code/policy.json`: a file on disk is
//! whatever the last writer made it. Once a machine is sealed (`seal.rs`) the *effective* policy is
//! the one in the seal, and the daemon is the only thing allowed to decide it changed — which needs
//! a TOTP code. Publishing it into a filesystem the daemon owns makes that structural instead of
//! advisory:
//!
//! - It is a **tmpfs**, so nothing survives a reboot: a machine whose disk was edited offline comes
//!   up with whatever the daemon publishes, not with the edit.
//! - It is **remounted read-only** after every publish, so even root cannot write into it without
//!   first remounting it read-write — an act the guard denies confined sessions and which the
//!   daemon undoes on its next tick.
//! - It is `0750 root:rp-code` with the policy `0640`, so exactly the members of the `rp-code`
//!   group — the app — can read it, and nobody else on the machine can.
//! - Every tick compares what is published against what the daemon means to publish, and republishes
//!   (and reports a tamper) when they differ.
//!
//! When the mount cannot be made — an unprivileged test, a container without `CAP_SYS_ADMIN`, a
//! kernel without tmpfs — the daemon falls back to a plain directory with the same ownership and
//! says so in `degraded`, which surfaces as a residual in `seal-status` rather than silently
//! pretending the protection is there.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where the effective policy is published.
pub const DEFAULT_RUNTIME_DIR: &str = "/run/rp-code/policy";
/// The effective policy inside it (what the app reads).
pub const POLICY_FILE: &str = "policy.json";
/// The state document beside it: where the policy came from and whether the machine is sealed.
pub const STATE_FILE: &str = "state.json";
/// tmpfs options. A policy is measured in kilobytes; a megabyte is already generous, and the cap
/// stops a bug here from eating the machine's memory.
pub const TMPFS_OPTIONS: &str = "mode=0750,size=1m,nr_inodes=64";

/// What the daemon publishes beside the policy so the app can tell the difference between "no
/// policy on this machine" and "a policy the daemon is enforcing".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub version: u32,
    /// Whether a policy is published at all.
    pub present: bool,
    /// `local` (the file on disk), `remote` (a fetched configuration) or `seal` (restored from
    /// the seal after the disk copy was tampered with).
    pub source: String,
    pub published_at: String,
    /// SHA-256 of the canonical policy JSON.
    pub policy_hash: String,
    /// The machine is sealed: the policy cannot be changed without a code.
    pub sealed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// Empty when the protection is fully in place; otherwise what is missing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
}

/// What `publish` was asked to put there.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeDoc {
    pub policy: Option<Value>,
    pub source: String,
    pub sealed: bool,
    pub managed_by: Option<String>,
    pub published_at: String,
}

/// What is published right now (reported through `seal-status` and the daemon's `status`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub dir: String,
    /// A tmpfs of the daemon's own is mounted there.
    pub mounted: bool,
    /// That mount is currently read-only.
    pub read_only: bool,
    /// A policy is published.
    pub present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    /// Why the protection is not complete (empty when it is).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
}

/// The mount operations, behind a trait so the tests drive a fake and `cargo test` needs no
/// privileges.
pub trait MountOps: Send + Sync {
    /// Mount a fresh tmpfs at `dir`.
    fn mount_tmpfs(&self, dir: &Path) -> Result<(), String>;
    /// Remount the filesystem at `dir` read-only (`true`) or read-write (`false`).
    fn remount(&self, dir: &Path, read_only: bool) -> Result<(), String>;
    /// `/proc/self/mountinfo`, so `is_mounted` can be pure.
    fn mountinfo(&self) -> Result<String, String>;
}

/// Pure: whether `dir` is a mount point of its own according to `mountinfo`, and whether that
/// mount is read-only. `/proc/self/mountinfo` field 5 is the mount point and field 6 the
/// per-mount options, which start with `ro` or `rw`.
pub fn mount_state(mountinfo: &str, dir: &Path) -> Option<bool> {
    let wanted = dir.to_string_lossy();
    let mut found = None;
    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        // The path is escaped octal-style for spaces and tabs; policy paths have neither, but
        // decode the two that matter so a surprising mount point does not read as a match.
        let point = fields[4].replace("\\040", " ").replace("\\011", "\t");
        if point != wanted {
            continue;
        }
        // The last matching line wins: a later mount covers an earlier one at the same point.
        found = Some(fields[5].split(',').any(|o| o == "ro"));
    }
    found
}

/// The real mount syscalls.
pub struct RealMounts;

impl MountOps for RealMounts {
    fn mount_tmpfs(&self, dir: &Path) -> Result<(), String> {
        use nix::mount::{mount, MsFlags};
        let flags = MsFlags::MS_NOSUID | MsFlags::MS_NODEV | MsFlags::MS_NOEXEC;
        mount(
            Some("tmpfs"),
            dir,
            Some("tmpfs"),
            flags,
            Some(TMPFS_OPTIONS),
        )
        .map_err(|e| format!("mount tmpfs on {}: {e}", dir.display()))
    }

    fn remount(&self, dir: &Path, read_only: bool) -> Result<(), String> {
        use nix::mount::{mount, MsFlags};
        let mut flags =
            MsFlags::MS_REMOUNT | MsFlags::MS_NOSUID | MsFlags::MS_NODEV | MsFlags::MS_NOEXEC;
        if read_only {
            flags |= MsFlags::MS_RDONLY;
        }
        mount(
            Some("tmpfs"),
            dir,
            Some("tmpfs"),
            flags,
            Some(TMPFS_OPTIONS),
        )
        .map_err(|e| {
            format!(
                "remount {} {}: {e}",
                dir.display(),
                if read_only { "read-only" } else { "read-write" }
            )
        })
    }

    fn mountinfo(&self) -> Result<String, String> {
        fs::read_to_string("/proc/self/mountinfo")
            .map_err(|e| format!("read /proc/self/mountinfo: {e}"))
    }
}

/// Publishes the effective policy into the runtime filesystem.
pub struct RuntimeFs {
    pub dir: PathBuf,
    /// gid of the `rp-code` group, so the app can read the published policy. `None` leaves the
    /// group as root's (tests, and a machine without the group).
    pub group: Option<u32>,
    /// Whether to mount a tmpfs at all (`lock.runtimeFs: false`, or a platform that cannot).
    pub mount: bool,
    ops: Box<dyn MountOps>,
}

impl RuntimeFs {
    pub fn new(
        dir: impl Into<PathBuf>,
        group: Option<u32>,
        mount: bool,
        ops: Box<dyn MountOps>,
    ) -> Self {
        RuntimeFs {
            dir: dir.into(),
            group,
            mount,
            ops,
        }
    }

    pub fn real(dir: impl Into<PathBuf>, group: Option<u32>, mount: bool) -> Self {
        RuntimeFs::new(dir, group, mount, Box::new(RealMounts))
    }

    pub fn policy_path(&self) -> PathBuf {
        self.dir.join(POLICY_FILE)
    }

    pub fn state_path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    /// The policy currently published (used by the tick to notice tampering).
    pub fn published_hash(&self) -> Option<String> {
        let text = fs::read_to_string(self.policy_path()).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        Some(crate::seal::policy_hash(&value))
    }

    /// Mount state of the directory: `(mounted, read_only)`.
    fn mounted(&self) -> (bool, bool) {
        match self.ops.mountinfo() {
            Ok(info) => match mount_state(&info, &self.dir) {
                Some(ro) => (true, ro),
                None => (false, false),
            },
            Err(_) => (false, false),
        }
    }

    fn ensure_dir(&self, degraded: &mut Vec<String>) -> Result<(), String> {
        if !self.dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o750)
                .create(&self.dir)
                .map_err(|e| format!("mkdir {}: {e}", self.dir.display()))?;
        }
        if let Err(e) = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o750)) {
            degraded.push(format!(
                "cannot set the mode of {}: {e}",
                self.dir.display()
            ));
        }
        self.chown(&self.dir, degraded);
        Ok(())
    }

    fn chown(&self, path: &Path, degraded: &mut Vec<String>) {
        let Some(gid) = self.group else { return };
        use nix::unistd::{chown, Gid};
        if let Err(e) = chown(path, None, Some(Gid::from_raw(gid))) {
            degraded.push(format!(
                "cannot give {} to the rp-code group: {e}",
                path.display()
            ));
        }
    }

    /// Write one file inside the runtime directory (the mount is already read-write).
    fn write(
        &self,
        path: &Path,
        text: &str,
        mode: u32,
        degraded: &mut Vec<String>,
    ) -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(path)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|e| format!("chmod {}: {e}", path.display()))?;
        file.write_all(text.as_bytes())
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        file.sync_all()
            .map_err(|e| format!("fsync {}: {e}", path.display()))?;
        drop(file);
        self.chown(path, degraded);
        Ok(())
    }

    /// Publish `doc`. The sequence is: make sure the directory exists, mount the tmpfs if it is
    /// not there yet, remount read-write, write both files, remount read-only. Every step that
    /// fails is recorded in `degraded` and the publish carries on, because a policy the app can
    /// read matters more than the mount that protects it.
    pub fn publish(&self, doc: &RuntimeDoc) -> RuntimeInfo {
        let mut degraded = Vec::new();
        if let Err(e) = self.ensure_dir(&mut degraded) {
            return RuntimeInfo {
                dir: self.dir.to_string_lossy().into_owned(),
                degraded: vec![e],
                ..RuntimeInfo::default()
            };
        }
        let (mut mounted, _) = self.mounted();
        if self.mount && !mounted {
            match self.ops.mount_tmpfs(&self.dir) {
                Ok(()) => {
                    mounted = true;
                    // A fresh mount hides whatever the directory held; give the mount point the
                    // ownership and mode the app needs.
                    let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o750));
                    self.chown(&self.dir.to_path_buf(), &mut degraded);
                }
                Err(e) => degraded.push(format!(
                    "{e}; the policy is published in a plain directory, which root can write to"
                )),
            }
        } else if !self.mount {
            degraded.push("the runtime filesystem is switched off (lock.runtimeFs: false); the policy is published in a plain directory".into());
        }
        if mounted {
            if let Err(e) = self.ops.remount(&self.dir, false) {
                degraded.push(e);
            }
        }

        let hash = doc.policy.as_ref().map(crate::seal::policy_hash);
        let mut result = RuntimeInfo {
            dir: self.dir.to_string_lossy().into_owned(),
            mounted,
            read_only: false,
            present: doc.policy.is_some(),
            policy_hash: hash.clone(),
            published_at: Some(doc.published_at.clone()),
            degraded: Vec::new(),
        };

        match &doc.policy {
            Some(policy) => {
                let text = serde_json::to_string_pretty(policy)
                    .map(|mut t| {
                        t.push('\n');
                        t
                    })
                    .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}\n"));
                if let Err(e) = self.write(&self.policy_path(), &text, 0o640, &mut degraded) {
                    degraded.push(e);
                    result.present = false;
                }
            }
            None => {
                if let Err(e) = fs::remove_file(self.policy_path()) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        degraded.push(format!(
                            "cannot remove {}: {e}",
                            self.policy_path().display()
                        ));
                    }
                }
            }
        }

        let state = RuntimeState {
            version: 1,
            present: result.present,
            source: doc.source.clone(),
            published_at: doc.published_at.clone(),
            policy_hash: hash.unwrap_or_default(),
            sealed: doc.sealed,
            managed_by: doc.managed_by.clone(),
            degraded: degraded.clone(),
        };
        let state_text = serde_json::to_string_pretty(&state)
            .map(|mut t| {
                t.push('\n');
                t
            })
            .unwrap_or_default();
        if let Err(e) = self.write(&self.state_path(), &state_text, 0o640, &mut degraded) {
            degraded.push(e);
        }

        if mounted {
            match self.ops.remount(&self.dir, true) {
                Ok(()) => result.read_only = true,
                Err(e) => degraded.push(e),
            }
        }
        result.degraded = degraded;
        result
    }

    /// What is published, without touching anything.
    pub fn info(&self) -> RuntimeInfo {
        let (mounted, read_only) = self.mounted();
        let state: Option<RuntimeState> = fs::read_to_string(self.state_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        RuntimeInfo {
            dir: self.dir.to_string_lossy().into_owned(),
            mounted,
            read_only,
            present: self.policy_path().exists(),
            policy_hash: self.published_hash(),
            published_at: state.as_ref().map(|s| s.published_at.clone()),
            degraded: state.map(|s| s.degraded).unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// A fake `MountOps` built with the real directory, so `mountinfo` can answer with a line
    /// that actually matches it.
    struct PathMounts {
        dir: PathBuf,
        state: Mutex<Option<bool>>,
        calls: Mutex<Vec<String>>,
        fail_mount: bool,
    }

    impl PathMounts {
        fn new(dir: &Path, fail_mount: bool) -> Self {
            PathMounts {
                dir: dir.to_path_buf(),
                state: Mutex::new(None),
                calls: Mutex::new(Vec::new()),
                fail_mount,
            }
        }
    }

    impl MountOps for PathMounts {
        fn mount_tmpfs(&self, dir: &Path) -> Result<(), String> {
            self.calls.lock().unwrap().push("mount".into());
            if self.fail_mount {
                return Err(format!(
                    "mount tmpfs on {}: EPERM (operation not permitted)",
                    dir.display()
                ));
            }
            *self.state.lock().unwrap() = Some(false);
            Ok(())
        }

        fn remount(&self, _dir: &Path, read_only: bool) -> Result<(), String> {
            self.calls.lock().unwrap().push(if read_only {
                "ro".into()
            } else {
                "rw".to_string()
            });
            *self.state.lock().unwrap() = Some(read_only);
            Ok(())
        }

        fn mountinfo(&self) -> Result<String, String> {
            Ok(match *self.state.lock().unwrap() {
                Some(ro) => format!(
                    "42 25 0:44 / {} {},nosuid,nodev,noexec shared:1 - tmpfs tmpfs {},mode=750\n",
                    self.dir.display(),
                    if ro { "ro" } else { "rw" },
                    if ro { "ro" } else { "rw" }
                ),
                None => "22 25 0:21 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw\n".into(),
            })
        }
    }

    fn doc(policy: Option<Value>) -> RuntimeDoc {
        RuntimeDoc {
            policy,
            source: "local".into(),
            sealed: true,
            managed_by: Some("Acme".into()),
            published_at: "2026-09-16T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn mount_state_reads_the_point_and_the_read_only_flag() {
        let info = "22 25 0:21 / /run rw,nosuid shared:5 - tmpfs tmpfs rw\n\
                    42 22 0:44 / /run/rp-code/policy ro,nosuid,nodev,noexec shared:9 - tmpfs tmpfs ro,mode=750\n";
        assert_eq!(
            mount_state(info, Path::new("/run/rp-code/policy")),
            Some(true)
        );
        assert_eq!(mount_state(info, Path::new("/run")), Some(false));
        assert_eq!(mount_state(info, Path::new("/run/rp-code")), None);
        assert!(mount_state(info, Path::new("/nowhere")).is_none());
        // A later mount at the same point wins.
        let stacked = "42 22 0:44 / /x rw - tmpfs tmpfs rw\n43 22 0:45 / /x ro - tmpfs tmpfs ro\n";
        assert_eq!(mount_state(stacked, Path::new("/x")), Some(true));
    }

    #[test]
    fn publish_mounts_writes_and_remounts_read_only() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("policy");
        let ops = PathMounts::new(&target, false);
        let fs_ = RuntimeFs::new(&target, None, true, Box::new(ops));
        let policy = json!({ "version": 1, "managedBy": "Acme" });
        let info = fs_.publish(&doc(Some(policy.clone())));
        assert!(info.mounted && info.read_only && info.present, "{info:?}");
        assert_eq!(info.degraded, Vec::<String>::new());
        assert_eq!(
            info.policy_hash.as_deref(),
            Some(crate::seal::policy_hash(&policy).as_str())
        );
        let written: Value =
            serde_json::from_str(&fs::read_to_string(fs_.policy_path()).unwrap()).unwrap();
        assert_eq!(written, policy);
        let state: RuntimeState =
            serde_json::from_str(&fs::read_to_string(fs_.state_path()).unwrap()).unwrap();
        assert!(state.sealed && state.present);
        assert_eq!(state.source, "local");
        assert_eq!(state.managed_by.as_deref(), Some("Acme"));
        assert_eq!(
            fs::metadata(fs_.policy_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o750
        );
        // Publishing again over a mounted directory does not mount twice.
        let info = fs_.publish(&doc(Some(policy)));
        assert!(info.mounted && info.read_only);
    }

    #[test]
    fn a_failed_mount_still_publishes_and_says_what_is_missing() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("policy");
        let fs_ = RuntimeFs::new(
            &target,
            None,
            true,
            Box::new(PathMounts::new(&target, true)),
        );
        let info = fs_.publish(&doc(Some(json!({ "version": 1 }))));
        assert!(!info.mounted && !info.read_only);
        assert!(info.present);
        assert_eq!(info.degraded.len(), 1);
        assert!(
            info.degraded[0].contains("root can write to"),
            "{:?}",
            info.degraded
        );
        assert!(fs_.policy_path().exists());
    }

    #[test]
    fn switching_the_runtime_filesystem_off_is_reported_as_degraded() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("policy");
        let fs_ = RuntimeFs::new(
            &target,
            None,
            false,
            Box::new(PathMounts::new(&target, false)),
        );
        let info = fs_.publish(&doc(Some(json!({ "version": 1 }))));
        assert!(!info.mounted);
        assert!(info.degraded[0].contains("switched off"));
    }

    #[test]
    fn publishing_nothing_removes_the_policy_but_keeps_the_state() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("policy");
        let fs_ = RuntimeFs::new(
            &target,
            None,
            true,
            Box::new(PathMounts::new(&target, false)),
        );
        fs_.publish(&doc(Some(json!({ "version": 1 }))));
        assert!(fs_.policy_path().exists());
        let info = fs_.publish(&RuntimeDoc {
            policy: None,
            sealed: false,
            ..doc(None)
        });
        assert!(!info.present);
        assert!(!fs_.policy_path().exists());
        let state: RuntimeState =
            serde_json::from_str(&fs::read_to_string(fs_.state_path()).unwrap()).unwrap();
        assert!(!state.present && !state.sealed);
        assert_eq!(fs_.published_hash(), None);
    }

    #[test]
    fn info_reports_what_is_published_without_touching_it() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("policy");
        let fs_ = RuntimeFs::new(
            &target,
            None,
            true,
            Box::new(PathMounts::new(&target, false)),
        );
        let policy = json!({ "version": 1 });
        fs_.publish(&doc(Some(policy.clone())));
        let info = fs_.info();
        assert!(info.mounted && info.read_only && info.present);
        assert_eq!(info.policy_hash, Some(crate::seal::policy_hash(&policy)));
        assert_eq!(
            info.published_at.as_deref(),
            Some("2026-09-16T10:00:00.000Z")
        );
    }
}
