//! System install (`/opt/rp-code`): the unpacked app under `current/`, the previous version
//! under `previous/` for rollback, `versions.json` describing both, and the `apply-update`
//! request that swaps a verified AppImage in — extracted as the *requesting user*, never as
//! root — followed by the daemon's own update when the new bundle ships a newer `rp-coded`.
//!
//! Everything that touches the OS in a way tests cannot (dropping privileges, running the
//! AppImage, running `install.sh`) goes through [`ApplyHooks`]; the rest is plain file system
//! work on a root directory the tests point at a temp dir. See `docs/spec/system.md`.

use std::cmp::Ordering;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};

use crate::protocol::{DaemonError, ErrorCode, InstallInfo};

/// Default install root (`--install-root`, env `RP_CODED_INSTALL_ROOT`).
pub const DEFAULT_INSTALL_ROOT: &str = "/opt/rp-code";
/// Largest AppImage `apply-update` accepts (1 GiB).
pub const MAX_UPDATE_BYTES: u64 = 1 << 30;
/// Files a valid unpacked app tree must contain (relative to the tree).
pub const REQUIRED_FILES: [&str; 3] = ["rp-code", "libffmpeg.so", "resources/app.asar"];
/// Where the bundle ships the daemon and the installer (relative to the tree).
pub const BUNDLED_DAEMON: &str = "resources/bin/rp-coded";
pub const BUNDLED_INSTALLER: &str = "resources/system/install.sh";
/// Name of the AppImage copy inside the staging directory.
const STAGED_APPIMAGE: &str = "update.AppImage";
/// What `--appimage-extract` produces inside its working directory.
const EXTRACT_DIR: &str = "squashfs-root";

// ---------------------------------------------------------------------------
// versions.json
// ---------------------------------------------------------------------------

/// One installed version (`versions.json` `current` / `previous`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub version: String,
    /// RFC 3339 UTC time the tree was put in place.
    pub installed_at: String,
    /// The AppImage the tree was extracted from (informational).
    pub source: String,
}

/// `<root>/versions.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<VersionEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<VersionEntry>,
}

impl VersionsFile {
    pub fn path(root: &Path) -> PathBuf {
        root.join("versions.json")
    }

    /// `Ok(None)` when the file does not exist.
    pub fn load(root: &Path) -> Result<Option<VersionsFile>, String> {
        let path = Self::path(root);
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{} is not valid: {e}", path.display()))
    }

    /// Atomic write (temp file + rename), `0644`, pretty JSON with a trailing newline.
    pub fn write(&self, root: &Path) -> io::Result<()> {
        let path = Self::path(root);
        let tmp = root.join(".versions.json.tmp");
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(self).map_err(io::Error::other)?
        );
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o644)
                .open(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
        }
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))?;
        fs::rename(&tmp, &path)
    }
}

/// `status.install`: what the daemon knows about the system install.
pub fn install_info(root: &Path, daemon_version: &str) -> InstallInfo {
    let versions = VersionsFile::load(root).ok().flatten();
    let current_dir = root.join("current");
    let system_install = current_dir.join("rp-code").is_file() && versions.is_some();
    InstallInfo {
        system_install,
        current: versions
            .as_ref()
            .and_then(|v| v.current.as_ref())
            .map(|e| e.version.clone()),
        previous: versions
            .as_ref()
            .and_then(|v| v.previous.as_ref())
            .filter(|_| root.join("previous").join("rp-code").is_file())
            .map(|e| e.version.clone()),
        daemon_version: daemon_version.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// `major.minor.patch[-pre]` (an optional leading `v` is accepted). Build metadata is ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl Semver {
    pub fn parse(s: &str) -> Option<Semver> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut parts = core.split('.');
        let num = |p: Option<&str>| -> Option<u64> {
            let p = p?;
            if p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            p.parse().ok()
        };
        let major = num(parts.next())?;
        let minor = num(parts.next())?;
        let patch = num(parts.next())?;
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            Some(p) => {
                if p.is_empty()
                    || !p
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
                {
                    return None;
                }
                Some(p.to_string())
            }
            None => None,
        };
        Some(Semver {
            major,
            minor,
            patch,
            pre,
        })
    }
}

impl PartialOrd for Semver {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Semver {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater, // a release beats its pre-releases
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

/// Whether installing `requested` over `installed` is a downgrade. An unparsable installed
/// version never blocks (the file is ours, but do not brick updates over a typo).
pub fn is_downgrade(requested: &Semver, installed: Option<&str>) -> bool {
    match installed.and_then(Semver::parse) {
        Some(cur) => requested < &cur,
        None => false,
    }
}

/// `rp-coded --version` prints `rp-coded 0.1.0 (protocol 1)`; extract the version.
pub fn parse_version_output(out: &str) -> Option<Semver> {
    let word = out.split_whitespace().nth(1)?;
    Semver::parse(word)
}

// ---------------------------------------------------------------------------
// Checksums and paths
// ---------------------------------------------------------------------------

/// Decode the `sha512` field of `latest-linux.yml` (standard base64 with padding; hex is
/// accepted too). `None` when it is not a 64-byte digest.
pub fn decode_sha512(text: &str) -> Option<[u8; 64]> {
    let text = text.trim();
    let bytes = if text.len() == 128 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..64)
            .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
            .collect::<Option<Vec<u8>>>()?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .ok()?
    };
    bytes.try_into().ok()
}

/// Whether `path` is absolute, has no `.`/`..` components and lies under `root`.
pub fn is_plain_path_under(path: &Path, root: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    if path
        .components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return false;
    }
    path.starts_with(root) && path != root
}

/// Copy `from` (already opened; hashed while copying) to `to` (created `0755`, must not exist)
/// and return the digest.
fn copy_and_hash(from: &mut fs::File, to: &Path) -> io::Result<[u8; 64]> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(to)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
    }
    out.sync_all()?;
    Ok(hasher.finalize().into())
}

// ---------------------------------------------------------------------------
// Tree checks and normalisation
// ---------------------------------------------------------------------------

/// What a walk over an extracted tree found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TreeReport {
    pub files: u64,
    pub dirs: u64,
    pub symlinks: u64,
    pub bytes: u64,
}

/// Refuse anything that must not end up root-owned under `/opt`: the required files must be
/// there, and there may be no setuid/setgid bits, no hard links, no symlinks leaving the tree
/// and nothing but files, directories and symlinks.
pub fn check_tree(dir: &Path) -> Result<TreeReport, String> {
    for rel in REQUIRED_FILES {
        let p = dir.join(rel);
        match fs::symlink_metadata(&p) {
            Ok(m) if m.is_file() => {}
            _ => return Err(format!("not an rp-code app tree: {rel} is missing")),
        }
    }
    let mut report = TreeReport::default();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = fs::read_dir(&d).map_err(|e| format!("cannot read {}: {e}", d.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot read {}: {e}", d.display()))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)
                .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
            let rel = path
                .strip_prefix(dir)
                .unwrap_or(&path)
                .display()
                .to_string();
            let ft = meta.file_type();
            if ft.is_symlink() {
                report.symlinks += 1;
                let target =
                    fs::read_link(&path).map_err(|e| format!("cannot read symlink {rel}: {e}"))?;
                if !symlink_stays_inside(&path, &target, dir) {
                    return Err(format!(
                        "symlink {rel} points outside the tree ({})",
                        target.display()
                    ));
                }
            } else if ft.is_dir() {
                report.dirs += 1;
                if meta.mode() & 0o6000 != 0 {
                    return Err(format!("{rel}/ has a setuid/setgid bit"));
                }
                stack.push(path);
            } else if ft.is_file() {
                report.files += 1;
                report.bytes += meta.len();
                if meta.mode() & 0o6000 != 0 {
                    return Err(format!("{rel} has a setuid/setgid bit"));
                }
                if meta.nlink() > 1 {
                    return Err(format!("{rel} is a hard link ({} links)", meta.nlink()));
                }
            } else {
                return Err(format!("{rel} is not a file, directory or symlink"));
            }
        }
    }
    Ok(report)
}

/// Resolve `target` relative to the symlink's directory lexically and check it stays under
/// `root` (absolute targets are refused outright: the tree moves around).
fn symlink_stays_inside(link: &Path, target: &Path, root: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut resolved: Vec<std::ffi::OsString> = link
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_os_string())
                .collect()
        })
        .unwrap_or_default();
    for c in target.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved.pop().is_none() {
                    return false;
                }
            }
            Component::Normal(n) => resolved.push(n.to_os_string()),
            _ => return false,
        }
    }
    true
}

/// Make the tree what a root-owned install must be: everything `root:root`, directories
/// `0755`, files `0755` when any execute bit was set and `0644` otherwise (this drops every
/// setuid/setgid bit), symlinks re-owned but otherwise untouched.
pub fn normalise_tree(dir: &Path) -> io::Result<()> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in fs::read_dir(&d)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            let ft = meta.file_type();
            std::os::unix::fs::lchown(&path, Some(0), Some(0))?;
            if ft.is_symlink() {
                continue;
            }
            let mode = if ft.is_dir() {
                stack.push(path.clone());
                0o755
            } else if meta.mode() & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        }
    }
    std::os::unix::fs::chown(dir, Some(0), Some(0))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755))
}

/// Everything root-owned and without setuid bits — verified after `normalise_tree`.
pub fn verify_root_owned(dir: &Path) -> Result<(), String> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let meta = fs::symlink_metadata(&d).map_err(|e| e.to_string())?;
        if meta.uid() != 0 || meta.gid() != 0 {
            return Err(format!("{} is not owned by root", d.display()));
        }
        if !meta.file_type().is_symlink() && meta.mode() & 0o6022 != 0 {
            return Err(format!(
                "{} has a setuid/setgid bit or is group/world writable",
                d.display()
            ));
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&d).map_err(|e| e.to_string())? {
                stack.push(entry.map_err(|e| e.to_string())?.path());
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The swap
// ---------------------------------------------------------------------------

/// Put `new_tree` (a directory on the same file system as `root`) in place: `previous` is
/// removed, `current` becomes `previous`, `new_tree` becomes `current`. Rolls back the rename
/// of `current` when the final rename fails. `new_tree` is consumed on success.
pub fn swap_in(root: &Path, new_tree: &Path) -> io::Result<()> {
    let current = root.join("current");
    let previous = root.join("previous");
    if previous.exists() {
        fs::remove_dir_all(&previous)?;
    }
    let had_current = current.exists();
    if had_current {
        fs::rename(&current, &previous)?;
    }
    if let Err(e) = fs::rename(new_tree, &current) {
        if had_current {
            // Best effort: put the old version back before reporting.
            let _ = fs::rename(&previous, &current);
        }
        return Err(e);
    }
    Ok(())
}

/// `install.sh --rollback` in Rust form (test reference for the shell implementation): swap
/// `previous` and `current` (both must exist) and the two entries of `versions.json`.
#[cfg(test)]
pub fn rollback(root: &Path) -> Result<VersionsFile, String> {
    let current = root.join("current");
    let previous = root.join("previous");
    if !previous.join("rp-code").is_file() {
        return Err("no previous version to roll back to".into());
    }
    let tmp = root.join(".rollback");
    let _ = fs::remove_dir_all(&tmp);
    fs::rename(&current, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&previous, &current).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &previous).map_err(|e| e.to_string())?;
    let mut versions = VersionsFile::load(root)?.unwrap_or_default();
    std::mem::swap(&mut versions.current, &mut versions.previous);
    versions.write(root).map_err(|e| e.to_string())?;
    Ok(versions)
}

// ---------------------------------------------------------------------------
// apply-update
// ---------------------------------------------------------------------------

/// The home directory of a uid (from passwd); `None` refuses the request.
pub type HomeOf = Box<dyn Fn(u32) -> Option<PathBuf> + Send + Sync>;
/// Run `<appimage> --appimage-extract` as `uid`/`gid` with `cwd` as the working directory; must
/// leave `cwd/squashfs-root` behind.
pub type Extract = Box<dyn Fn(&Path, &Path, u32, u32) -> Result<(), String> + Send + Sync>;
/// `<path> --version` output, parsed. `None` when it cannot be run.
pub type DaemonVersionOf = Box<dyn Fn(&Path) -> Option<Semver> + Send + Sync>;
/// Run the new bundle's `install.sh --refresh-daemon-files` as root.
pub type RefreshDaemonFiles = Box<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;
/// Whether the daemon at this path is a different build from the one currently *running*
/// (content, not version). `None` when the comparison cannot be made.
pub type DiffersFromRunning = Box<dyn Fn(&Path) -> Option<bool> + Send + Sync>;

/// The parts of `apply-update` that need the OS (privileges, other programs), injectable.
pub struct ApplyHooks {
    pub home_of: HomeOf,
    pub extract: Extract,
    pub daemon_version_of: DaemonVersionOf,
    pub refresh_daemon_files: RefreshDaemonFiles,
    pub differs_from_running: DiffersFromRunning,
}

/// `{ op: 'apply-update' }` as validated and applied.
pub struct ApplyRequest<'a> {
    pub file: &'a str,
    pub version: &'a str,
    pub sha512: &'a str,
    pub uid: u32,
    pub gid: u32,
    /// `settings.updates.allowDowngrade` from the policy.
    pub allow_downgrade: bool,
    /// The running daemon's version (self-update happens when the bundle's is newer).
    pub running_daemon: &'a str,
}

/// What `apply-update` answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyOutcome {
    pub version: String,
    pub restart_daemon: bool,
    /// The version that was current before (for the log).
    pub replaced: Option<String>,
}

fn refused(msg: impl Into<String>) -> DaemonError {
    DaemonError::new(ErrorCode::Refused, msg)
}

/// Staging directory for one user: `<root>/.staging-<uid>`, `0700` and owned by that user so
/// the AppImage can be extracted there without root.
fn staging_dir(root: &Path, uid: u32) -> PathBuf {
    root.join(format!(".staging-{uid}"))
}

/// Apply an update. Every failure cleans the staging area up; a failure after the swap started
/// rolls the rename back. The caller (the daemon) restarts itself when `restart_daemon` is set.
pub fn apply_update(
    root: &Path,
    req: &ApplyRequest<'_>,
    hooks: &ApplyHooks,
) -> Result<ApplyOutcome, DaemonError> {
    if req.uid == 0 {
        return Err(refused("root may not apply updates through the daemon"));
    }
    let requested = Semver::parse(req.version)
        .ok_or_else(|| DaemonError::invalid(format!("version {:?} is not semver", req.version)))?;
    let digest = decode_sha512(req.sha512).ok_or_else(|| {
        DaemonError::invalid("sha512 must be the base64 (or hex) SHA-512 of the file")
    })?;
    let versions = VersionsFile::load(root)
        .map_err(DaemonError::internal)?
        .ok_or_else(|| {
            refused(format!(
                "no system install at {} (run install.sh --system-install first)",
                root.display()
            ))
        })?;
    if !root.join("current").join("rp-code").is_file() {
        return Err(refused(format!(
            "{}/current is not an rp-code install",
            root.display()
        )));
    }
    let installed = versions.current.as_ref().map(|c| c.version.as_str());
    if is_downgrade(&requested, installed) && !req.allow_downgrade {
        return Err(refused(format!(
            "{} is older than the installed {} (settings.updates.allowDowngrade is not set)",
            req.version,
            installed.unwrap_or("?")
        )));
    }

    // The file: a plain path under the user's home, a regular file they own, opened without
    // following a final symlink, bounded in size.
    let home = (hooks.home_of)(req.uid)
        .ok_or_else(|| refused(format!("uid {} has no home directory", req.uid)))?;
    let file = Path::new(req.file);
    if !is_plain_path_under(file, &home) {
        return Err(refused(format!(
            "file must be an absolute path under {} without . or .. components",
            home.display()
        )));
    }
    let mut src = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc_o_nofollow_cloexec())
        .open(file)
        .map_err(|e| refused(format!("cannot open {}: {e}", file.display())))?;
    let meta = src
        .metadata()
        .map_err(|e| DaemonError::internal(e.to_string()))?;
    if !meta.is_file() {
        return Err(refused(format!("{} is not a regular file", file.display())));
    }
    if meta.uid() != req.uid {
        return Err(refused(format!(
            "{} is owned by uid {}, not by the requester",
            file.display(),
            meta.uid()
        )));
    }
    if meta.len() == 0 || meta.len() > MAX_UPDATE_BYTES {
        return Err(refused(format!(
            "{} is {} bytes; expected 1..{} bytes",
            file.display(),
            meta.len(),
            MAX_UPDATE_BYTES
        )));
    }

    // Stage: copy while hashing (what we verify is exactly what gets extracted), then extract
    // as the user.
    let staging = staging_dir(root, req.uid);
    let cleanup = |staging: &Path| {
        let _ = fs::remove_dir_all(staging);
    };
    let _ = fs::remove_dir_all(&staging);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|e| DaemonError::internal(format!("cannot create {}: {e}", staging.display())))?;
    std::os::unix::fs::chown(&staging, Some(req.uid), Some(req.gid)).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("cannot chown {}: {e}", staging.display()))
    })?;
    let copy = staging.join(STAGED_APPIMAGE);
    let actual = copy_and_hash(&mut src, &copy).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("cannot copy {}: {e}", file.display()))
    })?;
    drop(src);
    if actual != digest {
        cleanup(&staging);
        return Err(DaemonError::invalid(format!(
            "sha512 mismatch for {} (the file is not the release the manifest describes)",
            file.display()
        )));
    }
    log_info!(
        "apply-update: {} ({} bytes) verified; extracting as uid {} gid {}",
        file.display(),
        meta.len(),
        req.uid,
        req.gid
    );
    (hooks.extract)(&copy, &staging, req.uid, req.gid).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("extracting the AppImage failed: {e}"))
    })?;
    let tree = staging.join(EXTRACT_DIR);
    let report = check_tree(&tree).map_err(|e| {
        cleanup(&staging);
        DaemonError::invalid(format!("refusing the extracted tree: {e}"))
    })?;
    normalise_tree(&tree).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("cannot take ownership of the tree: {e}"))
    })?;
    verify_root_owned(&tree).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("tree not root-owned after normalisation: {e}"))
    })?;
    let _ = fs::remove_file(&copy);
    log_info!(
        "apply-update: tree ok ({} files, {} dirs, {} symlinks, {} bytes); swapping in {}",
        report.files,
        report.dirs,
        report.symlinks,
        report.bytes,
        req.version
    );

    // Swap.
    let new_tree = root.join(".new");
    let _ = fs::remove_dir_all(&new_tree);
    fs::rename(&tree, &new_tree).map_err(|e| {
        cleanup(&staging);
        DaemonError::internal(format!("cannot move the tree into place: {e}"))
    })?;
    cleanup(&staging);
    swap_in(root, &new_tree).map_err(|e| {
        let _ = fs::remove_dir_all(&new_tree);
        DaemonError::internal(format!("swap failed (old version kept): {e}"))
    })?;
    let replaced = versions.current.clone();
    let next = VersionsFile {
        current: Some(VersionEntry {
            version: req.version.to_string(),
            installed_at: crate::protocol::iso_millis(now_ms()),
            source: req.file.to_string(),
        }),
        previous: replaced.clone(),
    };
    next.write(root).map_err(|e| {
        DaemonError::internal(format!(
            "installed {} but cannot write versions.json: {e}",
            req.version
        ))
    })?;
    log_info!(
        "apply-update: {} installed to {}/current (previous: {})",
        req.version,
        root.display(),
        replaced
            .as_ref()
            .map(|r| r.version.as_str())
            .unwrap_or("none")
    );

    // Self-update from the bundle.
    let restart_daemon = match self_update(root, req.running_daemon, hooks) {
        Ok(v) => v,
        Err(e) => {
            log_error!("apply-update: {e}; the daemon keeps running the old version");
            false
        }
    };
    Ok(ApplyOutcome {
        version: req.version.to_string(),
        restart_daemon,
        replaced: replaced.map(|r| r.version),
    })
}

/// Compare the bundled daemon with the running one and refresh the installed files when it is
/// newer. `Ok(true)` means the caller must restart.
fn self_update(root: &Path, running: &str, hooks: &ApplyHooks) -> Result<bool, String> {
    let bundled = root.join("current").join(BUNDLED_DAEMON);
    if !bundled.is_file() {
        log_info!(
            "apply-update: bundle ships no daemon ({}); nothing to self-update",
            bundled.display()
        );
        return Ok(false);
    }
    let Some(new) = (hooks.daemon_version_of)(&bundled) else {
        return Err(format!("cannot read the version of {}", bundled.display()));
    };
    let Some(cur) = Semver::parse(running) else {
        return Err(format!("running daemon version {running:?} is not semver"));
    };
    // A newer version always refreshes. An *equal* version still can: the version string is
    // not bumped for every build, so "0.2.0 == 0.2.0" says nothing about whether the bundle
    // ships the same daemon. Comparing content catches the same-version rebuild, which is the
    // ordinary case during development and after any fix that did not move the version.
    //
    // This matters beyond tidiness: if the daemon will not refresh itself, finishing an update
    // needs `sudo install.sh --refresh-daemon-files` plus `systemctl restart` by hand — so the
    // guarded user has to be given sudo, and sudo is exactly what undoes the guard.
    if new < cur {
        log_info!(
            "apply-update: bundled rp-coded {}.{}.{} is older than the running {running}; no self-update",
            new.major,
            new.minor,
            new.patch
        );
        return Ok(false);
    }
    if new == cur {
        match (hooks.differs_from_running)(&bundled) {
            Some(true) => log_info!(
                "apply-update: bundled rp-coded is {running} like the running one but a different build; refreshing"
            ),
            Some(false) => {
                log_info!(
                    "apply-update: bundled rp-coded {running} is the build already running; no self-update"
                );
                return Ok(false);
            }
            None => {
                log_info!(
                    "apply-update: bundled rp-coded is {running} and it cannot be compared with the running build; no self-update"
                );
                return Ok(false);
            }
        }
    }
    let installer = root.join("current").join(BUNDLED_INSTALLER);
    if !installer.is_file() {
        return Err(format!(
            "bundle has no {BUNDLED_INSTALLER}; cannot self-update"
        ));
    }
    log_info!(
        "apply-update: bundled rp-coded {}.{}.{} is newer than {running}; refreshing the daemon files ({} --refresh-daemon-files)",
        new.major,
        new.minor,
        new.patch,
        installer.display()
    );
    (hooks.refresh_daemon_files)(&installer)?;
    log_info!("apply-update: daemon files refreshed; restart pending");
    Ok(true)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn libc_o_nofollow_cloexec() -> i32 {
    use nix::fcntl::OFlag;
    (OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC).bits()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A fake AppImage: a shell script whose `--appimage-extract` unpacks an embedded tar into
    /// `./squashfs-root`. `tree` lists `(relative path, content)`; directories are implied.
    pub fn fake_appimage(path: &Path, tree: &[(&str, &[u8])]) {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join(EXTRACT_DIR);
        for (rel, content) in tree {
            let p = src.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
            if *rel == "rp-code" || rel.ends_with(".sh") || rel.ends_with("rp-coded") {
                fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        symlink("rp-code", src.join("AppRun")).unwrap();
        let tar = std::process::Command::new("tar")
            .args(["-C", dir.path().to_str().unwrap(), "-cf", "-", EXTRACT_DIR])
            .output()
            .unwrap();
        assert!(tar.status.success());
        let script = b"#!/bin/sh\n# fake AppImage for tests\nif [ \"$1\" = --appimage-extract ]; then\n  sed -e '1,/^__TAR__$/d' \"$0\" | tar -xf -\n  exit $?\nfi\necho \"fake rp-code $*\"\nexit 0\n__TAR__\n";
        let mut body = script.to_vec();
        body.extend_from_slice(&tar.stdout);
        fs::write(path, &body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    pub fn sha512_b64(path: &Path) -> String {
        let bytes = fs::read(path).unwrap();
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes))
    }

    /// Run the fake AppImage as ourselves (tests may not be root).
    pub fn extract_here(appimage: &Path, cwd: &Path) -> Result<(), String> {
        let out = std::process::Command::new(appimage)
            .arg("--appimage-extract")
            .current_dir(cwd)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    pub fn app_tree(version: &str) -> Vec<(&'static str, Vec<u8>)> {
        vec![
            (
                "rp-code",
                format!("#!/bin/sh\necho rp-code {version}\n").into_bytes(),
            ),
            ("libffmpeg.so", b"ffmpeg".to_vec()),
            ("resources/app.asar", format!("asar {version}").into_bytes()),
            (
                "rp-code.desktop",
                format!("[Desktop Entry]\nX-AppImage-Version={version}\n").into_bytes(),
            ),
        ]
    }

    pub fn seed_install(root: &Path, version: &str) {
        let current = root.join("current");
        for (rel, content) in app_tree(version) {
            let p = current.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
        }
        VersionsFile {
            current: Some(VersionEntry {
                version: version.into(),
                installed_at: "2026-01-01T00:00:00.000Z".into(),
                source: "/seed.AppImage".into(),
            }),
            previous: None,
        }
        .write(root)
        .unwrap();
    }

    fn is_root() -> bool {
        nix::unistd::getuid().is_root()
    }

    /// Hooks for tests: home = the temp dir, extraction as ourselves, the bundled daemon's
    /// version from its content (`version X`), refresh recorded.
    pub fn test_hooks(
        home: PathBuf,
        refreshed: std::sync::Arc<std::sync::Mutex<Vec<PathBuf>>>,
    ) -> ApplyHooks {
        ApplyHooks {
            home_of: Box::new(move |_| Some(home.clone())),
            extract: Box::new(|appimage, cwd, _, _| extract_here(appimage, cwd)),
            daemon_version_of: Box::new(|p| {
                let text = fs::read_to_string(p).ok()?;
                parse_version_output(&text)
            }),
            refresh_daemon_files: Box::new(move |installer| {
                if installer.ends_with("fail.sh") {
                    return Err("refresh failed".into());
                }
                refreshed.lock().unwrap().push(installer.to_path_buf());
                Ok(())
            }),
            // Tests drive the equal-version case through the file's own content: a bundled
            // daemon whose text contains "same-build" stands for "identical to the running one".
            differs_from_running: Box::new(|p| {
                let text = fs::read_to_string(p).ok()?;
                Some(!text.contains("same-build"))
            }),
        }
    }

    #[test]
    fn semver_parses_and_orders() {
        let v = |s: &str| Semver::parse(s).unwrap();
        assert_eq!(
            v("1.2.3"),
            Semver {
                major: 1,
                minor: 2,
                patch: 3,
                pre: None
            }
        );
        assert_eq!(v("v0.1.42+build.7").patch, 42);
        assert_eq!(v("1.0.0-beta.1").pre.as_deref(), Some("beta.1"));
        assert!(v("0.1.10") > v("0.1.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(
            v("1.0.0") > v("1.0.0-rc.1"),
            "a release beats its pre-releases"
        );
        assert!(v("1.0.0-rc.2") > v("1.0.0-rc.1"));
        assert_eq!(v("1.0.0"), v("v1.0.0"));
        for bad in [
            "", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", "1.2.3-", "1..3", "1.2.3-é",
        ] {
            assert!(Semver::parse(bad).is_none(), "{bad:?} must not parse");
        }
        assert!(is_downgrade(&v("0.1.5"), Some("0.1.6")));
        assert!(
            !is_downgrade(&v("0.1.6"), Some("0.1.6")),
            "reinstalling the same version is fine"
        );
        assert!(!is_downgrade(&v("0.1.7"), Some("0.1.6")));
        assert!(
            !is_downgrade(&v("0.0.1"), Some("garbage")),
            "unparsable installed version never blocks"
        );
        assert!(!is_downgrade(&v("0.0.1"), None));
        assert_eq!(
            parse_version_output("rp-coded 0.2.0 (protocol 1)\n"),
            Some(v("0.2.0"))
        );
        assert_eq!(parse_version_output("nope"), None);
    }

    #[test]
    fn sha512_decoding_and_path_rules() {
        let b64 = "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";
        let digest = decode_sha512(b64).expect("base64 digest");
        assert_eq!(digest[0], 0xcf);
        let hex = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        assert_eq!(decode_sha512(&hex), Some(digest));
        assert_eq!(
            decode_sha512(&format!("  {b64}\n")),
            Some(digest),
            "whitespace trimmed"
        );
        assert!(decode_sha512("abc").is_none());
        assert!(
            decode_sha512(&base64::engine::general_purpose::STANDARD.encode([0u8; 32])).is_none(),
            "wrong length"
        );
        let home = Path::new("/home/alice");
        assert!(is_plain_path_under(
            Path::new("/home/alice/.cache/rp-code-updater/pending/x.AppImage"),
            home
        ));
        assert!(!is_plain_path_under(
            Path::new("/home/alice/../root/x"),
            home
        ));
        assert!(!is_plain_path_under(Path::new("/home/alice"), home));
        assert!(!is_plain_path_under(Path::new("/home/alicex/x"), home));
        assert!(!is_plain_path_under(Path::new("relative/x"), home));
        assert!(!is_plain_path_under(Path::new("/tmp/x"), home));
    }

    #[test]
    fn versions_file_round_trips_and_reports_install_info() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(VersionsFile::load(dir.path()), Ok(None));
        let v = VersionsFile {
            current: Some(VersionEntry {
                version: "0.1.9".into(),
                installed_at: "2026-09-14T10:00:00.000Z".into(),
                source: "/home/a/x.AppImage".into(),
            }),
            previous: Some(VersionEntry {
                version: "0.1.8".into(),
                installed_at: "2026-09-01T10:00:00.000Z".into(),
                source: "/home/a/y.AppImage".into(),
            }),
        };
        v.write(dir.path()).unwrap();
        let text = fs::read_to_string(dir.path().join("versions.json")).unwrap();
        assert!(
            text.starts_with("{\n  \"current\": {\n    \"version\": \"0.1.9\""),
            "{text}"
        );
        assert!(text.ends_with("}\n"));
        assert_eq!(
            fs::metadata(dir.path().join("versions.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        assert_eq!(VersionsFile::load(dir.path()), Ok(Some(v.clone())));
        // Without the trees it is not a system install; with them it is.
        let info = install_info(dir.path(), "0.1.0");
        assert_eq!(
            info,
            InstallInfo {
                system_install: false,
                current: Some("0.1.9".into()),
                previous: None,
                daemon_version: "0.1.0".into()
            }
        );
        seed_install(dir.path(), "0.1.9");
        fs::create_dir_all(dir.path().join("previous")).unwrap();
        fs::write(dir.path().join("previous/rp-code"), "x").unwrap();
        v.write(dir.path()).unwrap();
        let info = install_info(dir.path(), "0.1.0");
        assert_eq!(
            info,
            InstallInfo {
                system_install: true,
                current: Some("0.1.9".into()),
                previous: Some("0.1.8".into()),
                daemon_version: "0.1.0".into()
            }
        );
        fs::write(dir.path().join("versions.json"), "{").unwrap();
        assert!(VersionsFile::load(dir.path())
            .unwrap_err()
            .contains("not valid"));
        assert!(!install_info(dir.path(), "0").system_install);
    }

    #[test]
    fn tree_checks_refuse_what_must_not_become_root_owned() {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("t");
        assert!(check_tree(&tree).is_err(), "missing tree");
        for (rel, content) in app_tree("1.0.0") {
            let p = tree.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
        }
        fs::create_dir_all(tree.join("usr/share/icons")).unwrap();
        fs::write(tree.join("usr/share/icons/rp-code.png"), "png").unwrap();
        symlink("usr/share/icons/rp-code.png", tree.join(".DirIcon")).unwrap();
        symlink("../icons/rp-code.png", tree.join("usr/share/link")).unwrap();
        let report = check_tree(&tree).unwrap();
        assert_eq!((report.files, report.dirs, report.symlinks), (5, 4, 2));
        assert!(report.bytes > 0);

        fs::remove_file(tree.join("libffmpeg.so")).unwrap();
        assert!(check_tree(&tree)
            .unwrap_err()
            .contains("libffmpeg.so is missing"));
        fs::write(tree.join("libffmpeg.so"), "x").unwrap();

        symlink("/etc/passwd", tree.join("evil")).unwrap();
        assert!(check_tree(&tree)
            .unwrap_err()
            .contains("evil points outside"));
        fs::remove_file(tree.join("evil")).unwrap();
        symlink("../../outside", tree.join("usr/up")).unwrap();
        assert!(check_tree(&tree).unwrap_err().contains("up points outside"));
        fs::remove_file(tree.join("usr/up")).unwrap();

        fs::set_permissions(tree.join("rp-code"), fs::Permissions::from_mode(0o4755)).unwrap();
        assert!(check_tree(&tree).unwrap_err().contains("setuid"));
        fs::set_permissions(tree.join("rp-code"), fs::Permissions::from_mode(0o755)).unwrap();

        fs::hard_link(tree.join("libffmpeg.so"), tree.join("hard")).unwrap();
        assert!(check_tree(&tree).unwrap_err().contains("hard link"));
        fs::remove_file(tree.join("hard")).unwrap();

        nix::unistd::mkfifo(
            &tree.join("fifo"),
            nix::sys::stat::Mode::from_bits_truncate(0o644),
        )
        .unwrap();
        assert!(check_tree(&tree)
            .unwrap_err()
            .contains("fifo is not a file"));
        fs::remove_file(tree.join("fifo")).unwrap();
        assert!(check_tree(&tree).is_ok());

        // Normalisation: 0700 dirs (what --appimage-extract leaves) become 0755, x bits kept.
        fs::set_permissions(tree.join("resources"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            tree.join("rp-code.desktop"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        if is_root() {
            normalise_tree(&tree).unwrap();
            assert_eq!(
                fs::metadata(tree.join("resources"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o755
            );
            assert_eq!(
                fs::metadata(tree.join("rp-code"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o755
            );
            assert_eq!(
                fs::metadata(tree.join("rp-code.desktop"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o644
            );
            assert_eq!(
                fs::symlink_metadata(tree.join(".DirIcon")).unwrap().uid(),
                0
            );
            verify_root_owned(&tree).unwrap();
        } else {
            // chown to root needs root; the mode pass alone is what we can check here.
            assert!(normalise_tree(&tree).is_err());
            assert!(verify_root_owned(&tree)
                .unwrap_err()
                .contains("not owned by root"));
        }
    }

    #[test]
    fn swap_and_rollback_on_a_temp_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        seed_install(root, "0.1.0");
        let new = root.join(".new");
        fs::create_dir_all(new.join("resources")).unwrap();
        fs::write(new.join("rp-code"), "new").unwrap();
        swap_in(root, &new).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("current/rp-code")).unwrap(),
            "new"
        );
        assert!(root.join("previous/rp-code").is_file());
        assert!(!new.exists());
        // A second swap replaces `previous`.
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("rp-code"), "newer").unwrap();
        swap_in(root, &new).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("previous/rp-code")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(root.join("current/rp-code")).unwrap(),
            "newer"
        );
        // A failing final rename puts `current` back.
        let missing = root.join("does-not-exist");
        assert!(swap_in(root, &missing).is_err());
        assert_eq!(
            fs::read_to_string(root.join("current/rp-code")).unwrap(),
            "newer"
        );
        assert!(
            !root.join("previous").exists(),
            "the old previous was removed before the failure"
        );
        // Rollback swaps the trees and the versions.json entries.
        fs::create_dir_all(root.join("previous")).unwrap();
        fs::write(root.join("previous/rp-code"), "old").unwrap();
        VersionsFile {
            current: Some(VersionEntry {
                version: "2".into(),
                installed_at: "t".into(),
                source: "s".into(),
            }),
            previous: Some(VersionEntry {
                version: "1".into(),
                installed_at: "t".into(),
                source: "s".into(),
            }),
        }
        .write(root)
        .unwrap();
        let v = rollback(root).unwrap();
        assert_eq!(v.current.unwrap().version, "1");
        assert_eq!(v.previous.unwrap().version, "2");
        assert_eq!(
            fs::read_to_string(root.join("current/rp-code")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(root.join("previous/rp-code")).unwrap(),
            "newer"
        );
        fs::remove_dir_all(root.join("previous")).unwrap();
        assert!(rollback(root).unwrap_err().contains("no previous version"));
    }

    #[test]
    fn self_update_triggers_on_a_rebuild_at_the_same_version() {
        // The version string is not bumped for every build, so `bundled > running` misses the
        // ordinary case: same version, different binary. Missing it means a human has to finish
        // the update with sudo — and sudo is what undoes the guard.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join("current/resources/bin")).unwrap();
        fs::create_dir_all(root.join("current/resources/system")).unwrap();
        fs::write(root.join("current").join(BUNDLED_INSTALLER), "#!/bin/sh\n").unwrap();
        let bundled = root.join("current").join(BUNDLED_DAEMON);
        let refreshed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let hooks = test_hooks(root.clone(), refreshed.clone());
        let run = |text: &str| {
            fs::write(&bundled, text).unwrap();
            refreshed.lock().unwrap().clear();
            let r = self_update(&root, "0.2.0", &hooks);
            (r, refreshed.lock().unwrap().len())
        };

        // Newer: refresh, as before.
        assert_eq!(run("rp-coded 0.3.0 (protocol 1)"), (Ok(true), 1));
        // Same version, different build: refresh. This is the case that was being missed.
        assert_eq!(run("rp-coded 0.2.0 (protocol 1)"), (Ok(true), 1));
        // Same version, same build: nothing to do, and no pointless restart.
        assert_eq!(
            run("rp-coded 0.2.0 (protocol 1) same-build"),
            (Ok(false), 0)
        );
        // Older: never downgrade the daemon behind the user's back.
        assert_eq!(run("rp-coded 0.1.0 (protocol 1)"), (Ok(false), 0));
    }

    #[test]
    fn apply_update_end_to_end_on_a_temp_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("opt");
        let home = dir.path().join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        // Root may not request updates: as root the test stands in for uid 1000 and hands the
        // files over; otherwise we are the requesting user ourselves.
        let uid = if is_root() {
            1000
        } else {
            nix::unistd::getuid().as_raw()
        };
        let gid = if is_root() {
            1000
        } else {
            nix::unistd::getgid().as_raw()
        };
        let owned = |p: &Path| {
            if is_root() {
                std::os::unix::fs::chown(p, Some(uid), Some(gid)).unwrap();
            }
        };
        let refreshed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let hooks = test_hooks(home.clone(), refreshed.clone());
        let mut tree = app_tree("0.2.0");
        tree.push((
            "resources/bin/rp-coded",
            b"rp-coded 0.9.0 (protocol 1)\n".to_vec(),
        ));
        tree.push(("resources/system/install.sh", b"#!/bin/sh\n".to_vec()));
        let tree_refs: Vec<(&str, &[u8])> = tree.iter().map(|(p, c)| (*p, c.as_slice())).collect();
        let appimage = home.join("rp-code-0.2.0.AppImage");
        fake_appimage(&appimage, &tree_refs);
        owned(&appimage);
        let sha = sha512_b64(&appimage);
        let req = |version: &'static str,
                   sha512: &'static str,
                   file: PathBuf,
                   allow_downgrade: bool| ApplyRequest {
            file: Box::leak(file.to_string_lossy().into_owned().into_boxed_str()),
            version,
            sha512,
            uid,
            gid,
            allow_downgrade,
            running_daemon: "0.1.0",
        };
        let sha_static: &'static str = Box::leak(sha.clone().into_boxed_str());

        // Not a system install yet → REFUSED, and nothing is created.
        let e = apply_update(
            &root,
            &req("0.2.0", sha_static, appimage.clone(), false),
            &hooks,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Refused);
        assert!(e.message.contains("no system install"));
        seed_install(&root, "0.1.0");

        // Bad inputs.
        let e = apply_update(
            &root,
            &req("two", sha_static, appimage.clone(), false),
            &hooks,
        )
        .unwrap_err();
        assert!(e.code == ErrorCode::Invalid && e.message.contains("semver"));
        let e = apply_update(
            &root,
            &req("0.2.0", "nope", appimage.clone(), false),
            &hooks,
        )
        .unwrap_err();
        assert!(e.code == ErrorCode::Invalid && e.message.contains("sha512"));
        let e = apply_update(
            &root,
            &req("0.0.1", sha_static, appimage.clone(), false),
            &hooks,
        )
        .unwrap_err();
        assert!(
            e.code == ErrorCode::Refused && e.message.contains("older"),
            "{e}"
        );
        let e = apply_update(
            &root,
            &req("0.2.0", sha_static, PathBuf::from("/etc/passwd"), false),
            &hooks,
        )
        .unwrap_err();
        assert!(
            e.code == ErrorCode::Refused && e.message.contains("under"),
            "{e}"
        );
        let link = home.join("link.AppImage");
        symlink(&appimage, &link).unwrap();
        let e = apply_update(&root, &req("0.2.0", sha_static, link, false), &hooks).unwrap_err();
        assert!(
            e.code == ErrorCode::Refused && e.message.contains("cannot open"),
            "symlinks are not followed: {e}"
        );
        let e = apply_update(
            &root,
            &req("0.2.0", sha_static, home.clone().join("missing"), false),
            &hooks,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Refused);
        // Wrong checksum: refused before anything is extracted, staging cleaned up.
        let wrong: &'static str = Box::leak(
            base64::engine::general_purpose::STANDARD
                .encode([7u8; 64])
                .into_boxed_str(),
        );
        let e =
            apply_update(&root, &req("0.2.0", wrong, appimage.clone(), false), &hooks).unwrap_err();
        assert!(
            e.code == ErrorCode::Invalid && e.message.contains("mismatch"),
            "{e}"
        );
        assert!(!root.join(format!(".staging-{uid}")).exists());
        assert_eq!(
            fs::read_to_string(root.join("current/resources/app.asar")).unwrap(),
            "asar 0.1.0",
            "old version untouched"
        );
        let e = apply_update(
            &root,
            &ApplyRequest {
                uid: 0,
                ..req("0.2.0", sha_static, appimage.clone(), false)
            },
            &hooks,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Refused);

        if !is_root() {
            // Taking ownership needs root; the swap itself is covered by `swap_and_rollback_on_a_temp_root`.
            let e = apply_update(
                &root,
                &req("0.2.0", sha_static, appimage.clone(), false),
                &hooks,
            )
            .unwrap_err();
            assert_eq!(e.code, ErrorCode::Internal);
            assert!(
                !root.join(format!(".staging-{uid}")).exists(),
                "staging cleaned up"
            );
            return;
        }

        // The real thing (root): swap, versions.json, self-update branch (0.9.0 > 0.1.0).
        let out = apply_update(
            &root,
            &req("0.2.0", sha_static, appimage.clone(), false),
            &hooks,
        )
        .unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                version: "0.2.0".into(),
                restart_daemon: true,
                replaced: Some("0.1.0".into())
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("current/resources/app.asar")).unwrap(),
            "asar 0.2.0"
        );
        assert_eq!(
            fs::read_to_string(root.join("previous/resources/app.asar")).unwrap(),
            "asar 0.1.0"
        );
        assert!(!root.join(".new").exists() && !root.join(format!(".staging-{uid}")).exists());
        verify_root_owned(&root.join("current")).unwrap();
        assert_eq!(
            fs::metadata(root.join("current/resources"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o755
        );
        let v = VersionsFile::load(&root).unwrap().unwrap();
        assert_eq!(v.current.as_ref().unwrap().version, "0.2.0");
        assert_eq!(
            v.current.as_ref().unwrap().source,
            appimage.to_string_lossy()
        );
        assert!(v.current.as_ref().unwrap().installed_at.ends_with('Z'));
        assert_eq!(v.previous.as_ref().unwrap().version, "0.1.0");
        assert_eq!(
            refreshed.lock().unwrap().as_slice(),
            &[root.join("current/resources/system/install.sh")]
        );
        assert!(install_info(&root, "0.1.0").system_install);

        // Same version again is allowed (reinstall); an older daemon in the bundle → no restart.
        let mut tree2 = app_tree("0.2.0");
        tree2.push((
            "resources/bin/rp-coded",
            b"rp-coded 0.1.0 (protocol 1)\n".to_vec(),
        ));
        let refs2: Vec<(&str, &[u8])> = tree2.iter().map(|(p, c)| (*p, c.as_slice())).collect();
        let again = home.join("again.AppImage");
        fake_appimage(&again, &refs2);
        owned(&again);
        let sha2: &'static str = Box::leak(sha512_b64(&again).into_boxed_str());
        let out = apply_update(&root, &req("0.2.0", sha2, again.clone(), false), &hooks).unwrap();
        assert!(!out.restart_daemon);
        assert_eq!(refreshed.lock().unwrap().len(), 1);
        // Downgrade with the policy flag set.
        let out = apply_update(&root, &req("0.1.5", sha2, again.clone(), true), &hooks).unwrap();
        assert_eq!(out.version, "0.1.5");
        assert_eq!(
            VersionsFile::load(&root)
                .unwrap()
                .unwrap()
                .previous
                .unwrap()
                .version,
            "0.2.0"
        );
        // A tree that fails the sanity check is refused and the install untouched.
        let bad = home.join("bad.AppImage");
        fake_appimage(&bad, &[("rp-code", b"x"), ("libffmpeg.so", b"y")]);
        owned(&bad);
        let sha_bad: &'static str = Box::leak(sha512_b64(&bad).into_boxed_str());
        let e = apply_update(&root, &req("0.3.0", sha_bad, bad, false), &hooks).unwrap_err();
        assert!(
            e.code == ErrorCode::Invalid && e.message.contains("app.asar is missing"),
            "{e}"
        );
        assert_eq!(
            VersionsFile::load(&root)
                .unwrap()
                .unwrap()
                .current
                .unwrap()
                .version,
            "0.1.5"
        );
        assert!(!root.join(format!(".staging-{uid}")).exists());
        // A refresh failure keeps the app update and reports no restart.
        let mut tree3 = app_tree("0.4.0");
        tree3.push((
            "resources/bin/rp-coded",
            b"rp-coded 9.9.9 (protocol 1)\n".to_vec(),
        ));
        tree3.push(("resources/system/install.sh", b"#!/bin/sh\n".to_vec()));
        let refs3: Vec<(&str, &[u8])> = tree3.iter().map(|(p, c)| (*p, c.as_slice())).collect();
        let third = home.join("third.AppImage");
        fake_appimage(&third, &refs3);
        owned(&third);
        let sha3: &'static str = Box::leak(sha512_b64(&third).into_boxed_str());
        let failing = ApplyHooks {
            refresh_daemon_files: Box::new(|_| Err("boom".into())),
            ..test_hooks(home.clone(), refreshed.clone())
        };
        let out = apply_update(&root, &req("0.4.0", sha3, third, false), &failing).unwrap();
        assert_eq!(
            out,
            ApplyOutcome {
                version: "0.4.0".into(),
                restart_daemon: false,
                replaced: Some("0.1.5".into())
            }
        );
    }
}
