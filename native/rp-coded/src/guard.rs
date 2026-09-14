//! The session guard: AppArmor confinement of the listed users' login sessions, generated
//! from `policy.guard` (docs/system-integration.md "Session guard").
//!
//! Everything here is pure or goes through [`GuardHooks`] (files, `apparmor_parser`, socket
//! discovery) so it is unit-tested without AppArmor; `main.rs` supplies the real hooks.
//!
//! Verified AppArmor facts the profiles rely on (sources in the docs):
//! - `pam_apparmor` calls `change_hat()` into a hat named after the user, the primary group
//!   or `DEFAULT` (`order=`), inside the profile that confines the *login helper*. So the
//!   helper (`sddm-helper`, `login`, `sshd`) carries a profile whose `^<user>` hats send every
//!   exec into `rp-code-session` and whose `^DEFAULT` hat lets everyone else run unconfined.
//! - Filesystem-path unix sockets are mediated as files (`security/apparmor/af_unix.c`):
//!   `bind` is the `mknod` of the socket file (`w` = create), `connect` needs
//!   `AA_MAY_CONNECT|AA_MAY_SEND|AA_MAY_RECEIVE` = open + write + read (`rw`). A profile that
//!   grants `w` but not `r` on a socket can serve it but not connect to it.
//! - Explicit `deny` rules are enforced even in complain mode, so audit mode uses
//!   `audit <rule>` (allowed, logged as `apparmor="AUDIT"`) and enforce mode `audit deny`.
//! - Named exec transitions take globs (`/** px -> rp-code-session`), and a more specific
//!   rule (`/opt/rp-code/current/rp-code px -> rp-code-app`) coexists with `/** ix`
//!   (checked with `apparmor_parser -Q`, see the test at the bottom).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::policy::{CompositorIpc, GuardMode, GuardRules, GuardShell, PolicyFile};

/// Where the generated profiles go.
pub const DEFAULT_PROFILE_DIR: &str = "/etc/apparmor.d";
/// Cached engage state (`/etc/rp-code/guard-state.json`).
pub const DEFAULT_STATE_FILE: &str = "/etc/rp-code/guard-state.json";
/// The app the `rp-code-app` profile attaches to (the system install).
pub const DEFAULT_APP_EXEC: &str = "/opt/rp-code/current/rp-code";
/// AppArmor's securityfs mount: present iff the LSM is active.
pub const APPARMOR_FS: &str = "/sys/kernel/security/apparmor";
/// Profile names, in load order.
pub const PROFILE_NAMES: [&str; 5] = [
    "rp-code-session",
    "rp-code-app",
    "rp-code-shell",
    "rp-code-compositor",
    "rp-code-login",
];
/// Login helpers the guard attaches its hats to when `guard.loginHelpers` is absent (those
/// that exist on the box). Arch first, then Debian/Ubuntu spellings.
pub const KNOWN_LOGIN_HELPERS: [&str; 8] = [
    "/usr/lib/sddm/sddm-helper",
    "/usr/lib/x86_64-linux-gnu/sddm/sddm-helper",
    "/usr/libexec/sddm-helper",
    "/usr/bin/greetd",
    "/usr/sbin/greetd",
    "/usr/bin/login",
    "/usr/sbin/sshd",
    "/usr/bin/sshd",
];
/// PAM files that must carry the `pam_apparmor.so` session line (Arch, then Debian/Ubuntu).
pub const PAM_FILES: [&str; 2] = ["/etc/pam.d/system-login", "/etc/pam.d/common-session"];
/// One `guard-attempt` event per target at most this often.
pub const ATTEMPT_RATE_LIMIT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Shell and compositor table
// ---------------------------------------------------------------------------

/// What a table row describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Shell,
    Compositor,
}

/// A desktop shell, wallpaper daemon or compositor the guard knows: where its binary lives,
/// its process name(s), the filesystem sockets it listens on and the files it persists to.
/// Socket and file globs use `@{run}` (`/run`) and `@{HOME}` (`/home/*/`, `/root/`) as defined
/// at the top of every generated profile; `[0-9]*` stands for the uid directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableEntry {
    pub id: &'static str,
    pub owner: Owner,
    pub binaries: &'static [&'static str],
    pub comm: &'static [&'static str],
    pub sockets: &'static [&'static str],
    /// Config/state paths only the owner may write (the wallpaper persists here).
    pub files: &'static [&'static str],
}

/// Noctalia v5 (`src/ipc/ipc_service.cpp`: `$XDG_RUNTIME_DIR/noctalia-$WAYLAND_DISPLAY.sock`;
/// state `$XDG_STATE_HOME/noctalia/settings.toml`, config `$XDG_CONFIG_HOME/noctalia/*.toml`).
pub const NOCTALIA: TableEntry = TableEntry {
    id: "noctalia",
    owner: Owner::Shell,
    binaries: &["/usr/bin/noctalia", "/usr/local/bin/noctalia"],
    comm: &["noctalia"],
    sockets: &["@{run}/user/[0-9]*/noctalia-*.sock"],
    files: &[
        "@{HOME}/.config/noctalia/**",
        "@{HOME}/.local/state/noctalia/**",
    ],
};
/// Quickshell (Noctalia v4 and other shells): `$XDG_RUNTIME_DIR/quickshell/by-id/<id>/ipc.sock`
/// (`src/core/paths.cpp`, `src/ipc/ipc.cpp`).
pub const QUICKSHELL: TableEntry = TableEntry {
    id: "quickshell",
    owner: Owner::Shell,
    binaries: &["/usr/bin/quickshell", "/usr/bin/qs"],
    comm: &["quickshell", "qs"],
    sockets: &["@{run}/user/[0-9]*/quickshell/**"],
    files: &[
        "@{HOME}/.config/quickshell/**",
        "@{HOME}/.config/noctalia/**",
        "@{HOME}/.local/state/quickshell/**",
    ],
};
/// hyprpaper: `$XDG_RUNTIME_DIR/hypr/<instance>/.hyprpaper.sock` (`hyprctl hyprpaper …`).
pub const HYPRPAPER: TableEntry = TableEntry {
    id: "hyprpaper",
    owner: Owner::Shell,
    binaries: &["/usr/bin/hyprpaper"],
    comm: &["hyprpaper"],
    sockets: &["@{run}/user/[0-9]*/hypr/*/.hyprpaper.sock"],
    files: &["@{HOME}/.config/hypr/hyprpaper.conf"],
};
/// swww: `$XDG_RUNTIME_DIR/swww-$WAYLAND_DISPLAY.sock` (older releases `/tmp/swww/`); the
/// current wallpaper is cached under `~/.cache/swww/`.
pub const SWWW: TableEntry = TableEntry {
    id: "swww",
    owner: Owner::Shell,
    binaries: &["/usr/bin/swww-daemon", "/usr/bin/swww"],
    comm: &["swww-daemon", "swww"],
    sockets: &["@{run}/user/[0-9]*/swww-*.sock", "/tmp/swww/**"],
    files: &["@{HOME}/.cache/swww/**"],
};
/// Hyprland: `.socket.sock` (requests) and `.socket2.sock` (events) under
/// `$XDG_RUNTIME_DIR/hypr/<signature>/`.
pub const HYPRLAND: TableEntry = TableEntry {
    id: "hyprland",
    owner: Owner::Compositor,
    binaries: &["/usr/bin/Hyprland", "/usr/bin/hyprland"],
    comm: &["Hyprland", "hyprland"],
    sockets: &[
        "@{run}/user/[0-9]*/hypr/*/.socket.sock",
        "@{run}/user/[0-9]*/hypr/*/.socket2.sock",
    ],
    files: &[],
};
pub const SWAY: TableEntry = TableEntry {
    id: "sway",
    owner: Owner::Compositor,
    binaries: &["/usr/bin/sway"],
    comm: &["sway"],
    sockets: &["@{run}/user/[0-9]*/sway-ipc.*.sock"],
    files: &[],
};
pub const NIRI: TableEntry = TableEntry {
    id: "niri",
    owner: Owner::Compositor,
    binaries: &["/usr/bin/niri"],
    comm: &["niri"],
    sockets: &["@{run}/user/[0-9]*/niri.*.sock"],
    files: &[],
};
pub const SHELLS: [TableEntry; 4] = [NOCTALIA, QUICKSHELL, HYPRPAPER, SWWW];
pub const COMPOSITORS: [TableEntry; 3] = [HYPRLAND, SWAY, NIRI];

pub fn shell_entry(shell: GuardShell) -> Option<&'static TableEntry> {
    match shell {
        GuardShell::Noctalia => Some(&NOCTALIA),
        GuardShell::Quickshell => Some(&QUICKSHELL),
        GuardShell::Hyprpaper => Some(&HYPRPAPER),
        GuardShell::Swww => Some(&SWWW),
        GuardShell::Auto | GuardShell::None => None,
    }
}

/// The table row a process name belongs to, if any.
pub fn classify_comm(comm: &str) -> Option<&'static TableEntry> {
    SHELLS
        .iter()
        .chain(COMPOSITORS.iter())
        .find(|e| e.comm.contains(&comm))
}

// ---------------------------------------------------------------------------
// Plan: what the profiles are generated from
// ---------------------------------------------------------------------------

/// A socket found by discovery (or cached from an earlier run), already generalised.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DiscoveredSocket {
    pub glob: String,
    pub owner: Owner,
    /// Which table entry the owning process matched (`noctalia`, `hyprland`, …).
    pub entry: String,
}

/// Everything besides the policy that the profile text depends on, resolved by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GuardContext {
    /// `app.users`.
    pub users: Vec<String>,
    /// The app binary (`rp-code-app` attaches to it).
    pub app_exec: String,
    /// Login helpers present on the box (or from the policy), absolute paths.
    pub login_helpers: Vec<String>,
    /// The resolved shell, if any.
    pub shell: Option<&'static TableEntry>,
    /// Compositors present on the box.
    pub compositors: Vec<&'static TableEntry>,
    /// `abi/4.0` when `/etc/apparmor.d/abi/4.0` exists, else `abi/3.0`, else none.
    pub abi: Option<String>,
    /// Sockets discovered at runtime or cached.
    pub discovered: Vec<DiscoveredSocket>,
    pub daemon_version: String,
}

/// One generated profile file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileFile {
    pub name: &'static str,
    pub text: String,
}

impl ProfileFile {
    pub fn path(&self, dir: &Path) -> PathBuf {
        dir.join(self.name)
    }
}

/// The rendered plan: the files plus a hash identifying policy + context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardPlan {
    pub hash: String,
    pub files: Vec<ProfileFile>,
    pub residual: Vec<String>,
    pub shell: Option<&'static str>,
    pub compositors: Vec<&'static str>,
}

fn quote_hat(name: &str) -> String {
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', ""))
    }
}

/// `~/x` → `@{HOME}/x`; other paths as written.
pub fn normalise_glob(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        format!("@{{HOME}}/{rest}")
    } else {
        p.to_string()
    }
}

/// Everything a permissive profile allows besides files: every mediation class the parser
/// knows, so nothing the session does trips over a missing rule.
const ALLOW_CLASSES: &str = "  capability,\n  network,\n  unix,\n  dbus,\n  signal,\n  ptrace,\n  mount,\n  umount,\n  pivot_root,\n  userns,\n  mqueue,\n  io_uring,\n";
/// The same, indented for a hat body.
const HAT_CLASSES: &str = "    capability,\n    network,\n    unix,\n    dbus,\n    signal,\n    ptrace,\n    mount,\n    umount,\n    pivot_root,\n    userns,\n    mqueue,\n    io_uring,\n";

fn header(hash: &str, version: &str, name: &str, abi: Option<&str>) -> String {
    let mut s = format!(
        "# {name} — generated by rp-coded {version} for the rp-code session guard; do not edit\n# rp-code-guard {hash}\n# Reloaded by rp-coded whenever /etc/rp-code/policy.json changes; `apparmor_parser -R` removes it.\n"
    );
    if let Some(abi) = abi {
        s.push_str(&format!("abi <{abi}>,\n"));
    }
    s.push_str("@{run}=/run /var/run\n@{HOME}=/home/*/ /root/\n\n");
    s
}

/// `audit <rule>` in audit mode (allowed, logged), `audit deny <rule>` in enforce mode.
fn guarded(mode: GuardMode, rule: &str) -> String {
    match mode {
        GuardMode::Enforce => format!("  audit deny {rule},\n"),
        _ => format!("  audit {rule},\n"),
    }
}

fn flags(extra: &[&str]) -> String {
    let mut all = vec!["attach_disconnected"];
    all.extend_from_slice(extra);
    format!("flags=({})", all.join(","))
}

/// Render the profiles for `rules` in `ctx`. Pure. `rules.mode` must not be `Off`.
pub fn render(rules: &GuardRules, ctx: &GuardContext) -> GuardPlan {
    let mode = rules.mode;
    let audit = mode == GuardMode::Audit;
    let session_flags = if audit {
        flags(&["complain"])
    } else {
        flags(&[])
    };
    let abi = ctx.abi.as_deref();

    // --- what is guarded ---------------------------------------------------------------
    let mut deny_sockets: BTreeSet<String> = BTreeSet::new();
    let mut deny_files: BTreeSet<String> = BTreeSet::new();
    let mut shell_sockets: BTreeSet<String> = BTreeSet::new();
    let mut compositor_sockets: BTreeSet<String> = BTreeSet::new();
    if rules.wallpaper {
        if let Some(shell) = ctx.shell {
            for s in shell.sockets {
                shell_sockets.insert((*s).to_string());
            }
            for f in shell.files {
                deny_files.insert((*f).to_string());
            }
        }
    }
    if rules.compositor_ipc != CompositorIpc::Allow {
        for c in &ctx.compositors {
            for s in c.sockets {
                compositor_sockets.insert((*s).to_string());
            }
        }
    }
    for d in &ctx.discovered {
        if never_guard(&d.glob) {
            continue;
        }
        match d.owner {
            Owner::Shell if rules.wallpaper && ctx.shell.is_some_and(|s| s.id == d.entry) => {
                shell_sockets.insert(d.glob.clone());
            }
            Owner::Compositor if rules.compositor_ipc != CompositorIpc::Allow => {
                compositor_sockets.insert(d.glob.clone());
            }
            _ => {}
        }
    }
    for s in &rules.extra_deny_sockets {
        deny_sockets.insert(normalise_glob(s));
    }
    for p in &rules.extra_deny_paths {
        deny_files.insert(normalise_glob(p));
    }
    deny_sockets.extend(shell_sockets.iter().cloned());
    deny_sockets.extend(compositor_sockets.iter().cloned());

    let shell_profile = rules.wallpaper && ctx.shell.is_some();
    let compositor_profile =
        rules.compositor_ipc != CompositorIpc::Allow && !ctx.compositors.is_empty();

    // --- exec transitions shared by session, shell and compositor -------------------
    let mut exits = String::new();
    exits.push_str(&format!("  {} px -> rp-code-app,\n", ctx.app_exec));
    if shell_profile {
        for b in ctx.shell.map(|s| s.binaries).unwrap_or(&[]) {
            exits.push_str(&format!("  {b} px -> rp-code-shell,\n"));
        }
    }
    if compositor_profile {
        for c in &ctx.compositors {
            for b in c.binaries {
                exits.push_str(&format!("  {b} px -> rp-code-compositor,\n"));
            }
        }
    }
    for b in &rules.allow_binaries {
        exits.push_str(&format!("  {b} ux,\n"));
    }

    // --- the guarded rules (session; shell/compositor get the parts that apply) -------
    let mut guard_rules = String::new();
    for s in &deny_sockets {
        guard_rules.push_str(&guarded(mode, &format!("{s} rw")));
    }
    for f in &deny_files {
        guard_rules.push_str(&guarded(mode, &format!("{f} wl")));
    }
    if rules.protect_app {
        guard_rules.push_str(&guarded(mode, "signal (send) peer=rp-code-app"));
        guard_rules.push_str(&guarded(mode, "ptrace (trace) peer=rp-code-app"));
    }

    let mut files = Vec::new();

    // rp-code-session: everything the user could do before, minus the guarded parts.
    let mut session = String::new();
    session.push_str(&format!(
        "profile rp-code-session {session_flags} {{\n{ALLOW_CLASSES}  /** mrwlk,\n  /** ix,\n"
    ));
    session.push_str(&exits);
    session.push_str(&guard_rules);
    session.push_str("}\n");
    files.push(ProfileFile {
        name: "rp-code-session",
        text: session,
    });

    // rp-code-app: everything; children inherit; the session cannot signal or trace it.
    let mut app = String::new();
    app.push_str(&format!(
        "profile rp-code-app {} {} {{\n{ALLOW_CLASSES}  file,\n",
        ctx.app_exec,
        flags(&[])
    ));
    if rules.protect_app {
        for peer in ["rp-code-session", "rp-code-shell", "rp-code-compositor"] {
            if peer == "rp-code-shell" && !shell_profile {
                continue;
            }
            if peer == "rp-code-compositor" && !compositor_profile {
                continue;
            }
            app.push_str(&guarded(mode, &format!("signal (receive) peer={peer}")));
            app.push_str(&guarded(mode, &format!("ptrace (tracedby) peer={peer}")));
        }
    }
    app.push_str("}\n");
    files.push(ProfileFile {
        name: "rp-code-app",
        text: app,
    });

    // rp-code-shell: serves its socket (w = bind) but cannot connect to it (needs r); keeps
    // its config/state writable; children go back to the session.
    if shell_profile {
        let mut shell = String::new();
        shell.push_str(&format!(
            "profile rp-code-shell {session_flags} {{\n{ALLOW_CLASSES}  /** mrwlk,\n  /** px -> rp-code-session,\n"
        ));
        shell.push_str(&exits);
        for s in &shell_sockets {
            shell.push_str(&guarded(mode, &format!("{s} r")));
        }
        if rules.compositor_ipc == CompositorIpc::Deny {
            for s in &compositor_sockets {
                shell.push_str(&guarded(mode, &format!("{s} rw")));
            }
        }
        for s in &rules.extra_deny_sockets {
            shell.push_str(&guarded(mode, &format!("{} rw", normalise_glob(s))));
        }
        if rules.protect_app {
            shell.push_str(&guarded(mode, "signal (send) peer=rp-code-app"));
            shell.push_str(&guarded(mode, "ptrace (trace) peer=rp-code-app"));
        }
        shell.push_str("}\n");
        files.push(ProfileFile {
            name: "rp-code-shell",
            text: shell,
        });
    }

    // rp-code-compositor: owns its sockets; every child (keybind exec, exec-once) returns to
    // the session confinement.
    if compositor_profile {
        let mut comp = String::new();
        comp.push_str(&format!(
            "profile rp-code-compositor {session_flags} {{\n{ALLOW_CLASSES}  /** mrwlk,\n  /** px -> rp-code-session,\n"
        ));
        comp.push_str(&exits);
        for s in &shell_sockets {
            comp.push_str(&guarded(mode, &format!("{s} rw")));
        }
        for f in &deny_files {
            comp.push_str(&guarded(mode, &format!("{f} wl")));
        }
        if rules.protect_app {
            comp.push_str(&guarded(mode, "signal (send) peer=rp-code-app"));
            comp.push_str(&guarded(mode, "ptrace (trace) peer=rp-code-app"));
        }
        comp.push_str("}\n");
        files.push(ProfileFile {
            name: "rp-code-compositor",
            text: comp,
        });
    }

    // rp-code-login: the vehicle for pam_apparmor's hats. Always complain: it must never
    // break a login; its only job is to host the hats.
    let attach = match ctx.login_helpers.len() {
        0 => String::new(),
        1 => format!(" {}", ctx.login_helpers[0]),
        _ => format!(
            " /{{{}}}",
            ctx.login_helpers
                .iter()
                .map(|h| h.trim_start_matches('/'))
                .collect::<Vec<_>>()
                .join(",")
        ),
    };
    let mut login = String::new();
    login.push_str(&format!(
        "profile rp-code-login{attach} {} {{\n{ALLOW_CLASSES}  file,\n",
        flags(&["complain"])
    ));
    for user in &ctx.users {
        login.push_str(&format!(
            "  ^{} {} {{\n{HAT_CLASSES}    /** mrwlk,\n    /** px -> rp-code-session,\n  }}\n",
            quote_hat(user),
            flags(&["complain"])
        ));
    }
    login.push_str(&format!(
        "  ^DEFAULT {} {{\n{HAT_CLASSES}    /** mrwlk,\n    /** ux,\n  }}\n}}\n",
        flags(&["complain"])
    ));
    files.push(ProfileFile {
        name: "rp-code-login",
        text: login,
    });

    // Hash over the bodies (policy + context), then prepend the header carrying it.
    let mut hasher = Sha256::new();
    for f in &files {
        hasher.update(f.name.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.text.as_bytes());
        hasher.update(b"\0");
    }
    hasher.update(mode.as_str().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let hash = hash[..16].to_string();
    for f in &mut files {
        f.text = format!(
            "{}{}",
            header(&hash, &ctx.daemon_version, f.name, abi),
            f.text
        );
    }

    let mut residual = vec![
        "a user with root (sudo) can disable the guard: aa-disable / apparmor_parser -R, or guard.mode: off in the policy".to_string(),
        "logout, reboot and a switch to a virtual console stay possible; the app comes back at the next login".to_string(),
    ];
    if audit {
        residual.insert(0, "audit mode: nothing is blocked; attempts are logged and reported as guard-attempt events".to_string());
    }
    if ctx.login_helpers.is_empty() {
        residual.push("no login helper found (sddm-helper, greetd, login, sshd): sessions are not confined until guard.loginHelpers names one".to_string());
    }
    if rules.wallpaper && ctx.shell.is_none() {
        residual.push(match rules.shell {
            GuardShell::None => "guard.shell is none: wallpaper IPC and files are not guarded".to_string(),
            _ => "no known shell found (noctalia, quickshell, hyprpaper, swww): wallpaper IPC and files are not guarded".to_string(),
        });
    }
    if rules.compositor_ipc != CompositorIpc::Allow && ctx.compositors.is_empty() {
        residual.push(
            "no known compositor found (Hyprland, sway, niri): compositor IPC is not guarded"
                .to_string(),
        );
    }
    if compositor_profile {
        residual.push("compositor plugins run inside the compositor and are not confined; only its child processes are".to_string());
    }
    residual.push(
        "the display sockets (Wayland, X11), the session bus and the audio sockets are never guarded: the session could not run without them".to_string(),
    );
    residual.push(
        "processes the character launches through rp-code run with the app's rights".to_string(),
    );
    residual.push(
        "sessions that were already open when the guard engaged are confined at their next login"
            .to_string(),
    );
    if shell_profile {
        residual.push("if the audit log shows the shell denied getattr on its own socket, the shell needs r too and `<shell> msg` from a terminal becomes the residual gap".to_string());
    }

    GuardPlan {
        hash,
        files,
        residual,
        shell: ctx.shell.map(|s| s.id),
        compositors: ctx.compositors.iter().map(|c| c.id).collect(),
    }
}

// ---------------------------------------------------------------------------
// Audit log → attempts
// ---------------------------------------------------------------------------

/// What kind of guarded thing an audit line touched (`guard-attempt.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptKind {
    Ipc,
    Config,
    Signal,
    Ptrace,
    Exec,
}

impl AttemptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptKind::Ipc => "ipc",
            AttemptKind::Config => "config",
            AttemptKind::Signal => "signal",
            AttemptKind::Ptrace => "ptrace",
            AttemptKind::Exec => "exec",
        }
    }
}

/// One parsed AppArmor audit record about an `rp-code-*` profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardAttempt {
    pub kind: AttemptKind,
    /// The socket/file path, the peer profile (signal/ptrace) or the executable.
    pub target: String,
    /// The process name (`comm`).
    pub command: String,
    pub pid: u32,
    /// `apparmor="DENIED"`; `ALLOWED` (complain) and `AUDIT` (audit rule) are not blocked.
    pub blocked: bool,
    pub profile: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<String>,
}

/// Split an audit message into `key=value` / `key="value"` pairs (quoted values may hold spaces).
pub fn audit_fields(message: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let bytes = message.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b' ' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        let key = &message[start..i];
        i += 1;
        let value;
        if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let vs = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            value = &message[vs..i.min(bytes.len())];
            i += 1;
        } else {
            let vs = i;
            while i < bytes.len() && bytes[i] != b' ' {
                i += 1;
            }
            value = &message[vs..i];
        }
        if !key.is_empty() {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

/// Parse one kernel/audit message (`audit: type=1400 audit(…): apparmor="DENIED" …` or the
/// `AVC apparmor="DENIED" …` form journald stores from auditd). Only records about
/// `rp-code-*` profiles are attempts; everything else → `None`.
pub fn parse_audit_message(message: &str) -> Option<GuardAttempt> {
    let idx = message.find("apparmor=")?;
    let fields = audit_fields(&message[idx..]);
    let status = fields.get("apparmor")?;
    let blocked = match status.as_str() {
        "DENIED" => true,
        "ALLOWED" | "AUDIT" => false,
        _ => return None,
    };
    let profile = fields.get("profile")?.clone();
    if !profile.starts_with("rp-code-") {
        return None;
    }
    let operation = fields.get("operation").cloned().unwrap_or_default();
    let name = fields.get("name").cloned();
    let peer = fields.get("peer").cloned();
    let (kind, target) = match operation.as_str() {
        "signal" => (AttemptKind::Signal, peer.unwrap_or_default()),
        "ptrace" => (AttemptKind::Ptrace, peer.unwrap_or_default()),
        "exec" => (AttemptKind::Exec, name.unwrap_or_default()),
        "connect" | "bind" | "listen" | "accept" | "sendmsg" | "recvmsg" | "getsockname"
        | "getattr" => (AttemptKind::Ipc, name.unwrap_or_default()),
        _ => {
            let n = name.unwrap_or_default();
            if n.ends_with(".sock") || n.contains("/hypr/") || n.contains("/quickshell/") {
                (AttemptKind::Ipc, n)
            } else {
                (AttemptKind::Config, n)
            }
        }
    };
    if target.is_empty() {
        return None;
    }
    Some(GuardAttempt {
        kind,
        target,
        command: fields.get("comm").cloned().unwrap_or_default(),
        pid: fields.get("pid").and_then(|p| p.parse().ok()).unwrap_or(0),
        blocked,
        profile,
        operation,
        requested: fields
            .get("requested_mask")
            .or_else(|| fields.get("denied_mask"))
            .cloned(),
    })
}

/// `journalctl -o json` line → the `MESSAGE` text (a string, or an array of bytes when the
/// message was not valid UTF-8).
pub fn journal_message(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("MESSAGE")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(bytes) => {
            let b: Vec<u8> = bytes
                .iter()
                .filter_map(|x| x.as_u64().map(|n| n as u8))
                .collect();
            Some(String::from_utf8_lossy(&b).into_owned())
        }
        _ => None,
    }
}

/// `/dev/kmsg` record (`prio,seq,ts,flags;message`) → the message text.
pub fn kmsg_message(record: &str) -> Option<String> {
    let (_, msg) = record.split_once(';')?;
    Some(msg.trim_end().to_string())
}

/// One event per target within [`ATTEMPT_RATE_LIMIT`].
#[derive(Debug, Default)]
pub struct AttemptLimiter {
    last: BTreeMap<String, Instant>,
}

impl AttemptLimiter {
    /// Whether an attempt on `target` should be reported now (and records it).
    pub fn allow(&mut self, target: &str, now: Instant) -> bool {
        if let Some(prev) = self.last.get(target) {
            if now.duration_since(*prev) < ATTEMPT_RATE_LIMIT {
                return false;
            }
        }
        self.last.insert(target.to_string(), now);
        if self.last.len() > 512 {
            let cutoff = now - ATTEMPT_RATE_LIMIT;
            self.last.retain(|_, t| *t >= cutoff);
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Socket discovery (pure parts)
// ---------------------------------------------------------------------------

/// A listening filesystem socket from `/proc/net/unix`: inode and path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListeningSocket {
    pub inode: u64,
    pub path: String,
}

/// Listening (`__SO_ACCEPTCON`, flags `00010000`) path sockets in `/proc/net/unix`.
pub fn parse_proc_net_unix(text: &str) -> Vec<ListeningSocket> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 8 {
            continue;
        }
        let flags = u32::from_str_radix(cols[3], 16).unwrap_or(0);
        if flags & 0x0001_0000 == 0 {
            continue;
        }
        let Ok(inode) = cols[6].parse::<u64>() else {
            continue;
        };
        let path = cols[7];
        if !path.starts_with('/') {
            continue; // abstract (@…) or anonymous
        }
        out.push(ListeningSocket {
            inode,
            path: path.to_string(),
        });
    }
    out
}

/// The uid in a `/proc/<pid>/status` text (`Uid:` real uid).
pub fn parse_status_uid(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|l| l.strip_prefix("Uid:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|u| u.parse().ok())
}

/// `socket:[1234]` → 1234.
pub fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// Generalise a concrete socket path into a profile glob: `/run/user/<uid>` → `@{run}/user/[0-9]*`,
/// `/home/<name>` → `@{HOME}`, and every run of digits or of 4+ hex characters in a path
/// component (instance signatures, pids, display numbers) → `*`.
pub fn generalise_socket_path(path: &str) -> String {
    let mut components: Vec<String> = Vec::new();
    let mut rest = path;
    let mut prefix = String::new();
    if let Some(after) = rest.strip_prefix("/run/user/") {
        let uid_len = after.find('/').unwrap_or(after.len());
        if after[..uid_len].chars().all(|c| c.is_ascii_digit()) && uid_len > 0 {
            prefix = "@{run}/user/[0-9]*".to_string();
            rest = &after[uid_len..];
        }
    } else if let Some(after) = rest.strip_prefix("/home/") {
        let name_len = after.find('/').unwrap_or(after.len());
        if name_len > 0 {
            prefix = "@{HOME}".to_string();
            rest = &after[name_len..];
        }
    }
    for comp in rest.split('/').filter(|c| !c.is_empty()) {
        components.push(generalise_component(comp));
    }
    let mut out = prefix;
    for c in components {
        out.push('/');
        out.push_str(&c);
    }
    if out.is_empty() {
        path.to_string()
    } else {
        out
    }
}

fn generalise_component(comp: &str) -> String {
    let chars: Vec<char> = comp.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_hexdigit() {
            let start = i;
            let mut all_digits = true;
            while i < chars.len() && chars[i].is_ascii_hexdigit() {
                if !chars[i].is_ascii_digit() {
                    all_digits = false;
                }
                i += 1;
            }
            let run: String = chars[start..i].iter().collect();
            if all_digits || run.len() >= 4 {
                if !out.ends_with('*') {
                    out.push('*');
                }
            } else {
                out.push_str(&run);
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    // A component that is only stars and separators is just `*`.
    if !out.is_empty()
        && out.contains('*')
        && out
            .chars()
            .all(|c| c == '*' || c == '_' || c == '-' || c == '.')
    {
        return "*".to_string();
    }
    out
}

/// Socket globs the guard must never take away from the session, whoever listens on them.
/// Discovery finds every *listening* filesystem socket a table process owns, and a compositor
/// owns more than its control socket: Hyprland listens on the Wayland display socket and (for
/// XWayland) on `/tmp/.X11-unix/X<n>`. Guarding those cuts every client in the session off
/// from its display server — harmless in audit mode, fatal the moment the mode is `enforce`.
/// Patterns are matched against the *generalised* glob (see [`generalise_socket_path`]); `*`
/// here stands for one path component or part of one, so `@{run}/user/*/…` also matches the
/// `[0-9]*` that generalisation produces for the uid.
pub const NEVER_GUARD: [&str; 8] = [
    "@{run}/user/*/wayland-*",     // the Wayland display socket
    "/tmp/.X*-unix/*",             // X11 / XWayland
    "@{run}/user/*/X*-unix/*",     // the same under XDG_RUNTIME_DIR
    "@{run}/user/*/bus",           // the session bus
    "/run/dbus/system_bus_socket", // the system bus
    "@{run}/user/*/pipewire-*",    // audio/video
    "@{run}/user/*/pulse/*",       // audio
    "@{run}/user/*/systemd/*",     // the user manager's private socket
];

/// Does `candidate` match `pattern`, where the pattern's `*` stands for any run of characters
/// inside one path component? The candidate is compared literally, so a `*` or `[0-9]*` left
/// by generalisation is just text a pattern `*` can cover.
pub fn glob_match(pattern: &str, candidate: &str) -> bool {
    fn go(p: &[u8], c: &[u8]) -> bool {
        match p.first() {
            None => c.is_empty(),
            Some(b'*') => {
                // `*` eats zero or more characters, never crossing a path separator.
                let mut i = 0;
                loop {
                    if go(&p[1..], &c[i..]) {
                        return true;
                    }
                    if i == c.len() || c[i] == b'/' {
                        return false;
                    }
                    i += 1;
                }
            }
            Some(&ch) => !c.is_empty() && c[0] == ch && go(&p[1..], &c[1..]),
        }
    }
    go(pattern.as_bytes(), candidate.as_bytes())
}

/// A discovered socket the guard refuses to touch ([`NEVER_GUARD`]).
pub fn never_guard(glob: &str) -> bool {
    NEVER_GUARD.iter().any(|p| glob_match(p, glob))
}

// ---------------------------------------------------------------------------
// State file and status
// ---------------------------------------------------------------------------

/// `/etc/rp-code/guard-state.json`: what was engaged last, so a restart knows what to unload
/// and discovery results survive reboots (the shell is not running when the daemon starts).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardState {
    #[serde(default)]
    pub mode: GuardMode,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub loaded: Vec<String>,
    #[serde(default)]
    pub users: Vec<String>,
    #[serde(default)]
    pub sockets: Vec<DiscoveredSocket>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl GuardState {
    pub fn parse(text: &str) -> Option<GuardState> {
        serde_json::from_str(text).ok()
    }

    pub fn to_json(&self) -> String {
        let mut s = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into());
        s.push('\n');
        s
    }
}

/// `status.guard` / `guard-status` (`GuardInfo` in `@rp/shared`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardInfo {
    /// The AppArmor LSM is active (`/sys/kernel/security/apparmor` exists).
    pub available: bool,
    pub mode: GuardMode,
    pub loaded: Vec<String>,
    pub users: Vec<String>,
    pub residual: Vec<String>,
    /// Things that make the guard ineffective right now and how to fix them (e.g. a login
    /// helper that started before the profiles were loaded); empty when everything is in place.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pam_configured: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Engage / disengage through hooks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserOp {
    /// `apparmor_parser -Q -K` (syntax only).
    Check,
    /// `apparmor_parser -r -K` (load/replace).
    Replace,
    /// `apparmor_parser -R -K` (unload).
    Remove,
}

impl fmt::Display for ParserOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ParserOp::Check => "check",
            ParserOp::Replace => "load",
            ParserOp::Remove => "unload",
        })
    }
}

pub type FileExists = Box<dyn Fn(&Path) -> bool + Send + Sync>;
pub type ReadFile = Box<dyn Fn(&Path) -> Option<String> + Send + Sync>;
pub type WriteFile = Box<dyn Fn(&Path, &str) -> io::Result<()> + Send + Sync>;
pub type RemoveFile = Box<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;
pub type Parser = Box<dyn Fn(ParserOp, &[PathBuf]) -> Result<(), String> + Send + Sync>;
pub type Discover = Box<dyn Fn(&[String]) -> Vec<DiscoveredSocket> + Send + Sync>;
/// Login helpers (by executable path) that are running right now WITHOUT an AppArmor label:
/// `(pid, exe)` pairs. Such a helper was exec'd before the profiles were loaded and cannot enter
/// a hat, so every login it handles stays unconfined until it restarts.
pub type UnconfinedHelpers = Box<dyn Fn(&[String]) -> Vec<(u32, String)> + Send + Sync>;

/// The OS-touching parts, injectable for tests.
pub struct GuardHooks {
    /// The AppArmor LSM is active.
    pub available: Box<dyn Fn() -> bool + Send + Sync>,
    /// `abi/4.0` / `abi/3.0` when those files exist under the profile dir.
    pub abi: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub file_exists: FileExists,
    pub read_file: ReadFile,
    pub write_file: WriteFile,
    pub remove_file: RemoveFile,
    pub parser: Parser,
    /// Listening sockets of the listed users' shell/compositor processes, generalised.
    pub discover: Discover,
    /// Running login helpers that carry no profile (see `UnconfinedHelpers`).
    pub unconfined_helpers: UnconfinedHelpers,
    pub now: Box<dyn Fn() -> String + Send + Sync>,
}

/// Fixed locations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardPaths {
    pub profile_dir: PathBuf,
    pub state_file: PathBuf,
    pub app_exec: String,
    pub daemon_version: String,
}

impl Default for GuardPaths {
    fn default() -> Self {
        GuardPaths {
            profile_dir: PathBuf::from(DEFAULT_PROFILE_DIR),
            state_file: PathBuf::from(DEFAULT_STATE_FILE),
            app_exec: DEFAULT_APP_EXEC.to_string(),
            daemon_version: crate::VERSION.to_string(),
        }
    }
}

fn read_state(hooks: &GuardHooks, paths: &GuardPaths) -> GuardState {
    (hooks.read_file)(&paths.state_file)
        .and_then(|t| GuardState::parse(&t))
        .unwrap_or_default()
}

fn write_state(hooks: &GuardHooks, paths: &GuardPaths, state: &GuardState) -> Result<(), String> {
    (hooks.write_file)(&paths.state_file, &state.to_json())
        .map_err(|e| format!("cannot write {}: {e}", paths.state_file.display()))
}

/// The first of [`PAM_FILES`] that exists and how many uncommented `pam_apparmor.so` session
/// lines it carries; `None` when neither file exists.
pub fn pam_lines(hooks: &GuardHooks) -> Option<(&'static str, usize)> {
    for f in PAM_FILES {
        if let Some(text) = (hooks.read_file)(Path::new(f)) {
            let n = text
                .lines()
                .filter(|l| {
                    let l = l.trim();
                    !l.starts_with('#') && l.contains("pam_apparmor.so")
                })
                .count();
            return Some((f, n));
        }
    }
    None
}

/// Whether a PAM file carries the `pam_apparmor.so` session line: `Some(true/false)` from
/// the first of [`PAM_FILES`] that exists, `None` when neither does.
pub fn pam_configured(hooks: &GuardHooks) -> Option<bool> {
    pam_lines(hooks).map(|(_, n)| n > 0)
}

/// More than one `pam_apparmor.so` line hangs every login on this machine, so say so wherever
/// the guard reports its state. pam_apparmor enters the hat with a magic token and remembers
/// it; the second line calls `change_hat()` again with a different token, the kernel refuses
/// the switch and leaves the login process in a profile that permits nothing — it cannot even
/// write the failure to the terminal. `optional` does not help (the PAM return code is not
/// where the damage is) and neither does `audit` mode (complain softens rule violations, not a
/// failed `change_hat`).
pub fn pam_duplicate_warning(hooks: &GuardHooks) -> Option<String> {
    match pam_lines(hooks) {
        Some((file, n)) if n > 1 => Some(format!(
            "{file} has {n} pam_apparmor.so session lines: the second change_hat() fails and every login hangs with no message. Keep one (sudo install.sh --guard collapses them) before logging out."
        )),
        _ => None,
    }
}

/// Resolve the context: which helpers, shell and compositors exist; merge discovery with the
/// cached sockets.
pub fn resolve_context(
    rules: &GuardRules,
    users: &[String],
    hooks: &GuardHooks,
    paths: &GuardPaths,
    cached: &[DiscoveredSocket],
) -> GuardContext {
    let exists = |p: &str| (hooks.file_exists)(Path::new(p));
    let login_helpers = match &rules.login_helpers {
        Some(list) => list.clone(),
        None => KNOWN_LOGIN_HELPERS
            .iter()
            .filter(|h| exists(h))
            .map(|h| (*h).to_string())
            .collect(),
    };
    let shell = match rules.shell {
        GuardShell::Auto => SHELLS.iter().find(|s| s.binaries.iter().any(|b| exists(b))),
        other => shell_entry(other),
    };
    let compositors: Vec<&'static TableEntry> = COMPOSITORS
        .iter()
        .filter(|c| c.binaries.iter().any(|b| exists(b)))
        .collect();
    let mut discovered: BTreeSet<DiscoveredSocket> = cached.iter().cloned().collect();
    discovered.extend((hooks.discover)(users));
    // Drop the session's lifelines before they reach the profiles or the state cache; an
    // older cache may still carry them (see NEVER_GUARD).
    discovered.retain(|d| !never_guard(&d.glob));
    GuardContext {
        users: users.to_vec(),
        app_exec: paths.app_exec.clone(),
        login_helpers,
        shell,
        compositors,
        abi: (hooks.abi)(),
        discovered: discovered.into_iter().collect(),
        daemon_version: paths.daemon_version.clone(),
    }
}

/// Engage (or disengage, for `mode: off` / no policy) according to `policy`. Idempotent:
/// unchanged files are not rewritten; the profiles are (re)loaded on every call so a fresh
/// boot picks them up. Returns what `status.guard` reports.
pub fn apply(policy: Option<&PolicyFile>, hooks: &GuardHooks, paths: &GuardPaths) -> GuardInfo {
    let rules = policy.map(|p| p.guard_rules()).unwrap_or_default();
    let users: Vec<String> = policy.map(|p| p.app_rules().users).unwrap_or_default();
    let available = (hooks.available)();
    let mut state = read_state(hooks, paths);
    let mut info = GuardInfo {
        available,
        mode: rules.mode,
        users: users.clone(),
        pam_configured: pam_configured(hooks),
        ..GuardInfo::default()
    };

    if !rules.enabled() {
        // Disengage whatever an earlier run loaded.
        if !state.loaded.is_empty() || state.mode != GuardMode::Off {
            let files: Vec<PathBuf> = PROFILE_NAMES
                .iter()
                .map(|n| paths.profile_dir.join(n))
                .filter(|p| (hooks.file_exists)(p))
                .collect();
            if !files.is_empty() && available {
                if let Err(e) = (hooks.parser)(ParserOp::Remove, &files) {
                    info.last_error = Some(format!("unload failed: {e}"));
                }
            }
            for f in &files {
                if let Err(e) = (hooks.remove_file)(f) {
                    info.last_error = Some(format!("cannot remove {}: {e}", f.display()));
                }
            }
            state.mode = GuardMode::Off;
            state.loaded.clear();
            state.hash.clear();
            state.users.clear();
            state.applied_at = Some((hooks.now)());
            state.last_error = info.last_error.clone();
            if let Err(e) = write_state(hooks, paths, &state) {
                info.last_error = Some(e);
            }
        }
        info.applied_at = state.applied_at.clone();
        return info;
    }

    if !available {
        info.last_error = Some(format!(
            "AppArmor is not active ({APPARMOR_FS} is missing): boot with the apparmor LSM enabled"
        ));
        info.residual = vec!["unavailable: nothing is confined".to_string()];
        return info;
    }
    if users.is_empty() {
        info.last_error = Some("guard needs app.users: nobody to confine".to_string());
        return info;
    }

    let ctx = resolve_context(&rules, &users, hooks, paths, &state.sockets);
    let plan = render(&rules, &ctx);
    info.residual = plan.residual.clone();
    info.shell = plan.shell.map(|s| s.to_string());
    info.compositor = if plan.compositors.is_empty() {
        None
    } else {
        Some(plan.compositors.join(", "))
    };

    // Write changed files, remove stale ones (a profile the new plan no longer has).
    let mut written = Vec::new();
    let mut changed = false;
    for f in &plan.files {
        let path = f.path(&paths.profile_dir);
        if (hooks.read_file)(&path).as_deref() != Some(f.text.as_str()) {
            if let Err(e) = (hooks.write_file)(&path, &f.text) {
                info.last_error = Some(format!("cannot write {}: {e}", path.display()));
                state.last_error = info.last_error.clone();
                let _ = write_state(hooks, paths, &state);
                return info;
            }
            changed = true;
        }
        written.push(path);
    }
    let planned: BTreeSet<&str> = plan.files.iter().map(|f| f.name).collect();
    for stale in PROFILE_NAMES.iter().filter(|n| !planned.contains(*n)) {
        let path = paths.profile_dir.join(stale);
        if (hooks.file_exists)(&path) {
            let _ = (hooks.parser)(ParserOp::Remove, std::slice::from_ref(&path));
            let _ = (hooks.remove_file)(&path);
            changed = true;
        }
    }

    let result = (hooks.parser)(ParserOp::Check, &written)
        .map_err(|e| format!("profile check failed: {e}"))
        .and_then(|_| {
            (hooks.parser)(ParserOp::Replace, &written)
                .map_err(|e| format!("profile load failed: {e}"))
        });
    match result {
        Ok(()) => {
            info.loaded = plan.files.iter().map(|f| f.name.to_string()).collect();
            info.warnings = helper_warnings(&(hooks.unconfined_helpers)(&ctx.login_helpers));
            info.warnings.extend(pam_duplicate_warning(hooks));
            state.mode = rules.mode;
            state.hash = plan.hash.clone();
            state.loaded = info.loaded.clone();
            state.users = users.clone();
            state.sockets = ctx.discovered.clone();
            state.applied_at = Some((hooks.now)());
            state.last_error = None;
            let _ = changed;
        }
        Err(e) => {
            info.last_error = Some(e.clone());
            state.last_error = Some(e);
            state.applied_at = Some((hooks.now)());
        }
    }
    info.applied_at = state.applied_at.clone();
    if let Err(e) = write_state(hooks, paths, &state) {
        info.last_error = Some(e);
    }
    info
}

/// Warning lines for login helpers running without a profile: they were started before the
/// profiles were loaded, so the sessions they open cannot be confined until they restart.
pub fn helper_warnings(unconfined: &[(u32, String)]) -> Vec<String> {
    unconfined
        .iter()
        .map(|(pid, exe)| {
            let name = Path::new(exe)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| exe.clone());
            let unit = match name.as_str() {
                "greetd" => "greetd",
                "sddm-helper" => "sddm",
                "sshd" => "sshd",
                _ => "the login service",
            };
            format!(
                "{name} (pid {pid}) is running unconfined: it started before the profiles were loaded, so logins it opens are not guarded until it restarts (from a TTY: systemctl restart {unit}, or reboot); pam_apparmor then reports \"Operation not permitted\" changing to the hat"
            )
        })
        .collect()
}

/// `status.guard` without touching anything: from the state file and the LSM presence.
pub fn current_info(
    policy: Option<&PolicyFile>,
    hooks: &GuardHooks,
    paths: &GuardPaths,
) -> GuardInfo {
    let rules = policy.map(|p| p.guard_rules()).unwrap_or_default();
    let state = read_state(hooks, paths);
    let mut info = GuardInfo {
        available: (hooks.available)(),
        mode: state.mode,
        loaded: state.loaded.clone(),
        users: state.users.clone(),
        pam_configured: pam_configured(hooks),
        applied_at: state.applied_at.clone(),
        last_error: state.last_error.clone(),
        ..GuardInfo::default()
    };
    if rules.mode != state.mode {
        info.mode = rules.mode;
        info.residual.push(format!(
            "policy says {} but {} is engaged; guard-apply is pending",
            rules.mode.as_str(),
            state.mode.as_str()
        ));
    }
    if !info.loaded.is_empty() {
        let helpers = match &rules.login_helpers {
            Some(list) => list.clone(),
            None => KNOWN_LOGIN_HELPERS.iter().map(|s| s.to_string()).collect(),
        };
        info.warnings = helper_warnings(&(hooks.unconfined_helpers)(&helpers));
    }
    info.warnings.extend(pam_duplicate_warning(hooks));
    info
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::policy::parse_policy;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// An in-memory OS: files, parser calls and discovery results.
    #[derive(Default)]
    pub struct FakeOs {
        pub files: Mutex<HashMap<PathBuf, String>>,
        pub existing: Mutex<Vec<String>>,
        pub parser_calls: Mutex<Vec<(ParserOp, Vec<PathBuf>)>>,
        pub parser_fail: Mutex<Option<ParserOp>>,
        pub discovered: Mutex<Vec<DiscoveredSocket>>,
        pub available: Mutex<bool>,
    }

    impl FakeOs {
        pub fn hooks(self: &Arc<Self>) -> GuardHooks {
            let a = self.clone();
            let b = self.clone();
            let c = self.clone();
            let d = self.clone();
            let e = self.clone();
            let f = self.clone();
            let g = self.clone();
            let h = self.clone();
            GuardHooks {
                available: Box::new(move || *a.available.lock().unwrap()),
                abi: Box::new(|| Some("abi/4.0".into())),
                file_exists: Box::new(move |p| {
                    b.files.lock().unwrap().contains_key(p)
                        || b.existing.lock().unwrap().iter().any(|e| Path::new(e) == p)
                }),
                read_file: Box::new(move |p| c.files.lock().unwrap().get(p).cloned()),
                write_file: Box::new(move |p, t| {
                    d.files
                        .lock()
                        .unwrap()
                        .insert(p.to_path_buf(), t.to_string());
                    Ok(())
                }),
                remove_file: Box::new(move |p| {
                    e.files.lock().unwrap().remove(p);
                    Ok(())
                }),
                parser: Box::new(move |op, paths| {
                    f.parser_calls.lock().unwrap().push((op, paths.to_vec()));
                    if *f.parser_fail.lock().unwrap() == Some(op) {
                        return Err(format!("{op} exploded"));
                    }
                    Ok(())
                }),
                discover: Box::new(move |_| g.discovered.lock().unwrap().clone()),
                unconfined_helpers: Box::new(move |_| Vec::new()),
                now: Box::new(move || {
                    let _ = &h;
                    "2026-09-14T12:00:00.000Z".to_string()
                }),
            }
        }
    }

    #[test]
    fn unconfined_login_helper_becomes_a_warning_with_the_restart_hint() {
        let w = helper_warnings(&[(962, "/usr/bin/greetd".to_string())]);
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("greetd (pid 962) is running unconfined"));
        assert!(w[0].contains("systemctl restart greetd"));
        assert!(helper_warnings(&[]).is_empty());
    }

    fn paths(dir: &Path) -> GuardPaths {
        GuardPaths {
            profile_dir: dir.join("apparmor.d"),
            state_file: dir.join("guard-state.json"),
            app_exec: DEFAULT_APP_EXEC.to_string(),
            daemon_version: "9.9.9".into(),
        }
    }

    pub fn noctalia_hyprland_ctx(mode_users: &[&str]) -> GuardContext {
        GuardContext {
            users: mode_users.iter().map(|u| u.to_string()).collect(),
            app_exec: DEFAULT_APP_EXEC.to_string(),
            login_helpers: vec!["/usr/lib/sddm/sddm-helper".into(), "/usr/bin/login".into()],
            shell: Some(&NOCTALIA),
            compositors: vec![&HYPRLAND],
            abi: Some("abi/4.0".into()),
            discovered: vec![DiscoveredSocket {
                glob: "@{run}/user/[0-9]*/noctalia-wayland-*.sock".into(),
                owner: Owner::Shell,
                entry: "noctalia".into(),
            }],
            daemon_version: "9.9.9".into(),
        }
    }

    fn rules(json: serde_json::Value) -> GuardRules {
        parse_policy(&json.to_string()).unwrap().guard_rules()
    }

    fn text_of<'a>(plan: &'a GuardPlan, name: &str) -> &'a str {
        &plan.files.iter().find(|f| f.name == name).unwrap().text
    }

    #[test]
    fn renders_the_noctalia_hyprland_sddm_case_in_audit_mode() {
        let r = rules(
            serde_json::json!({"version":1,"app":{"users":["work"]},"guard":{"mode":"audit","allowBinaries":["/usr/bin/hyprctl-safe"],"extraDenyPaths":["~/.config/hypr/hyprpaper.conf"]}}),
        );
        let plan = render(&r, &noctalia_hyprland_ctx(&["work"]));
        assert_eq!(
            plan.files.iter().map(|f| f.name).collect::<Vec<_>>(),
            vec![
                "rp-code-session",
                "rp-code-app",
                "rp-code-shell",
                "rp-code-compositor",
                "rp-code-login"
            ]
        );
        let session = text_of(&plan, "rp-code-session");
        assert!(session.contains("abi <abi/4.0>,"));
        assert!(session.contains("profile rp-code-session flags=(attach_disconnected,complain) {"));
        assert!(session.contains("  /** ix,\n"));
        assert!(session.contains("  /opt/rp-code/current/rp-code px -> rp-code-app,\n"));
        assert!(session.contains("  /usr/bin/noctalia px -> rp-code-shell,\n"));
        assert!(session.contains("  /usr/bin/Hyprland px -> rp-code-compositor,\n"));
        assert!(session.contains("  /usr/bin/hyprctl-safe ux,\n"));
        // Audit mode: `audit` allow rules, never `deny` (deny is enforced even in complain mode).
        assert!(session.contains("  audit @{run}/user/[0-9]*/hypr/*/.socket.sock rw,\n"));
        assert!(session.contains("  audit @{run}/user/[0-9]*/hypr/*/.socket2.sock rw,\n"));
        assert!(session.contains("  audit @{run}/user/[0-9]*/noctalia-*.sock rw,\n"));
        assert!(
            session.contains("  audit @{run}/user/[0-9]*/noctalia-wayland-*.sock rw,\n"),
            "discovered socket"
        );
        assert!(session.contains("  audit @{HOME}/.config/noctalia/** wl,\n"));
        assert!(session.contains("  audit @{HOME}/.local/state/noctalia/** wl,\n"));
        assert!(session.contains("  audit @{HOME}/.config/hypr/hyprpaper.conf wl,\n"));
        assert!(session.contains("  audit signal (send) peer=rp-code-app,\n"));
        assert!(session.contains("  audit ptrace (trace) peer=rp-code-app,\n"));
        assert!(!session.contains("deny"));
        let app = text_of(&plan, "rp-code-app");
        assert!(app.contains(
            "profile rp-code-app /opt/rp-code/current/rp-code flags=(attach_disconnected) {"
        ));
        assert!(app.contains("  file,\n"));
        assert!(app.contains("  audit signal (receive) peer=rp-code-session,\n"));
        assert!(app.contains("  audit ptrace (tracedby) peer=rp-code-compositor,\n"));
        let shell = text_of(&plan, "rp-code-shell");
        assert!(shell.contains("  /** px -> rp-code-session,\n"));
        assert!(
            shell.contains("  audit @{run}/user/[0-9]*/noctalia-*.sock r,\n"),
            "bind (w) allowed, connect (needs r) audited"
        );
        assert!(
            !shell.contains("hypr/*/.socket.sock rw"),
            "shell-only: the shell may talk to the compositor"
        );
        let comp = text_of(&plan, "rp-code-compositor");
        assert!(comp.contains("  /** px -> rp-code-session,\n"));
        assert!(comp.contains("  audit @{run}/user/[0-9]*/noctalia-*.sock rw,\n"));
        let login = text_of(&plan, "rp-code-login");
        assert!(login.contains("profile rp-code-login /{usr/lib/sddm/sddm-helper,usr/bin/login} flags=(attach_disconnected,complain) {"));
        assert!(login.contains("  ^work flags=(attach_disconnected,complain) {\n"));
        assert!(login.contains("    /** px -> rp-code-session,\n"));
        assert!(login.contains("  ^DEFAULT flags=(attach_disconnected,complain) {\n"));
        assert!(login.contains("    /** ux,\n"));
        for f in &plan.files {
            assert!(f.text.contains(&format!("# rp-code-guard {}", plan.hash)));
            assert!(f
                .text
                .contains("@{run}=/run /var/run\n@{HOME}=/home/*/ /root/\n"));
        }
        assert_eq!(plan.shell, Some("noctalia"));
        assert_eq!(plan.compositors, vec!["hyprland"]);
        assert!(plan.residual[0].starts_with("audit mode"));
        // Same inputs → same hash; a different mode → a different one.
        assert_eq!(
            render(&r, &noctalia_hyprland_ctx(&["work"])).hash,
            plan.hash
        );
        let mut r2 = r.clone();
        r2.mode = GuardMode::Enforce;
        assert_ne!(
            render(&r2, &noctalia_hyprland_ctx(&["work"])).hash,
            plan.hash
        );
    }

    #[test]
    fn enforce_mode_denies_and_drops_complain() {
        let r = rules(
            serde_json::json!({"version":1,"app":{"users":["work","o'neil"]},"guard":{"mode":"enforce","compositorIpc":"deny"}}),
        );
        let plan = render(&r, &noctalia_hyprland_ctx(&["work", "o'neil"]));
        let session = text_of(&plan, "rp-code-session");
        assert!(session.contains("profile rp-code-session flags=(attach_disconnected) {"));
        assert!(!session.contains("complain"));
        assert!(session.contains("  audit deny @{run}/user/[0-9]*/hypr/*/.socket.sock rw,\n"));
        assert!(session.contains("  audit deny signal (send) peer=rp-code-app,\n"));
        let shell = text_of(&plan, "rp-code-shell");
        assert!(
            shell.contains("  audit deny @{run}/user/[0-9]*/hypr/*/.socket.sock rw,\n"),
            "compositorIpc deny reaches the shell"
        );
        assert!(shell.contains("  audit deny @{run}/user/[0-9]*/noctalia-*.sock r,\n"));
        let login = text_of(&plan, "rp-code-login");
        assert!(login.contains("  ^work flags=(attach_disconnected,complain) {\n"));
        assert!(
            login.contains("  ^\"o'neil\" flags=(attach_disconnected,complain) {\n"),
            "odd names are quoted"
        );
        assert!(
            login.contains("complain"),
            "the login profile never enforces"
        );
        assert!(!plan.residual[0].starts_with("audit mode"));
    }

    #[test]
    fn switches_off_parts_and_falls_back_without_shell_or_compositor() {
        let r = rules(
            serde_json::json!({"version":1,"app":{"users":["a"]},"guard":{"mode":"audit","protectApp":false,"wallpaper":false,"compositorIpc":"allow"}}),
        );
        let ctx = GuardContext {
            users: vec!["a".into()],
            app_exec: DEFAULT_APP_EXEC.into(),
            login_helpers: vec!["/usr/lib/sddm/sddm-helper".into()],
            shell: Some(&NOCTALIA),
            compositors: vec![&HYPRLAND],
            abi: None,
            discovered: vec![],
            daemon_version: "1".into(),
        };
        let plan = render(&r, &ctx);
        assert_eq!(
            plan.files.iter().map(|f| f.name).collect::<Vec<_>>(),
            vec!["rp-code-session", "rp-code-app", "rp-code-login"]
        );
        let session = text_of(&plan, "rp-code-session");
        assert!(!session.contains("abi <"));
        assert!(!session.contains("noctalia"));
        assert!(!session.contains("hypr"));
        assert!(!session.contains("signal (send)"));
        assert!(
            session.contains("profile rp-code-login /usr/lib/sddm/sddm-helper")
                || text_of(&plan, "rp-code-login")
                    .contains("profile rp-code-login /usr/lib/sddm/sddm-helper flags=")
        );
        // Nothing found on the box: residuals say so, the login profile has no attachment.
        let bare = GuardContext {
            users: vec!["a".into()],
            app_exec: DEFAULT_APP_EXEC.into(),
            ..GuardContext::default()
        };
        let r2 = rules(
            serde_json::json!({"version":1,"app":{"users":["a"]},"guard":{"mode":"enforce"}}),
        );
        let plan2 = render(&r2, &bare);
        assert!(text_of(&plan2, "rp-code-login")
            .contains("profile rp-code-login flags=(attach_disconnected,complain) {"));
        assert!(plan2
            .residual
            .iter()
            .any(|r| r.starts_with("no login helper found")));
        assert!(plan2
            .residual
            .iter()
            .any(|r| r.starts_with("no known shell found")));
        assert!(plan2
            .residual
            .iter()
            .any(|r| r.starts_with("no known compositor found")));
    }

    #[test]
    fn parses_audit_lines_from_kernel_and_journal() {
        let denied = r#"audit: type=1400 audit(1757851200.123:456): apparmor="DENIED" operation="connect" class="file" profile="rp-code-session" name="/run/user/1000/hypr/0c9c_1757_42/.socket.sock" pid=4242 comm="hyprctl" requested_mask="wr" denied_mask="wr" fsuid=1000 ouid=1000"#;
        let a = parse_audit_message(denied).unwrap();
        assert_eq!(
            a,
            GuardAttempt {
                kind: AttemptKind::Ipc,
                target: "/run/user/1000/hypr/0c9c_1757_42/.socket.sock".into(),
                command: "hyprctl".into(),
                pid: 4242,
                blocked: true,
                profile: "rp-code-session".into(),
                operation: "connect".into(),
                requested: Some("wr".into())
            }
        );
        let audited = r#"AVC apparmor="AUDIT" operation="open" class="file" profile="rp-code-session" name="/home/work/.local/state/noctalia/settings.toml" pid=77 comm="vim" requested_mask="w" fsuid=1000 ouid=1000"#;
        let b = parse_audit_message(audited).unwrap();
        assert_eq!(
            (b.kind, b.blocked, b.command.as_str(), b.target.as_str()),
            (
                AttemptKind::Config,
                false,
                "vim",
                "/home/work/.local/state/noctalia/settings.toml"
            )
        );
        let sig = r#"audit: type=1400 audit(1.2:3): apparmor="ALLOWED" operation="signal" class="signal" profile="rp-code-session" pid=9 comm="kill" requested_mask="send" denied_mask="send" signal=term peer="rp-code-app""#;
        let c = parse_audit_message(sig).unwrap();
        assert_eq!(
            (c.kind, c.target.as_str(), c.blocked),
            (AttemptKind::Signal, "rp-code-app", false)
        );
        let pt = r#"apparmor="DENIED" operation="ptrace" class="ptrace" profile="rp-code-session//null-x" pid=9 comm="gdb" requested_mask="trace" denied_mask="trace" peer="rp-code-app""#;
        assert_eq!(parse_audit_message(pt).unwrap().kind, AttemptKind::Ptrace);
        let ex = r#"apparmor="DENIED" operation="exec" class="file" profile="rp-code-shell" name="/usr/bin/x" pid=1 comm="sh" requested_mask="x" denied_mask="x" target="rp-code-session""#;
        assert_eq!(parse_audit_message(ex).unwrap().kind, AttemptKind::Exec);
        // Sockets reached through a non-connect operation still count as IPC.
        let st = r#"apparmor="DENIED" operation="getattr" class="file" profile="rp-code-shell" name="/run/user/1000/noctalia-wayland-1.sock" pid=1 comm="noctalia" requested_mask="r" denied_mask="r""#;
        assert_eq!(parse_audit_message(st).unwrap().kind, AttemptKind::Ipc);
        // Other profiles, other statuses and non-apparmor lines are ignored.
        assert!(parse_audit_message(
            r#"apparmor="DENIED" operation="open" profile="firefox" name="/x" pid=1 comm="a""#
        )
        .is_none());
        assert!(parse_audit_message(r#"apparmor="STATUS" operation="profile_load" profile="unconfined" name="rp-code-session" pid=1 comm="apparmor_parser""#).is_none());
        assert!(parse_audit_message("usb 1-1: new device").is_none());
        // Journal JSON and kmsg framing.
        let j = format!(
            r#"{{"MESSAGE":{},"_TRANSPORT":"kernel"}}"#,
            serde_json::to_string(denied).unwrap()
        );
        assert_eq!(journal_message(&j).as_deref(), Some(denied));
        assert_eq!(
            journal_message(r#"{"MESSAGE":[104,105]}"#).as_deref(),
            Some("hi")
        );
        assert!(journal_message("nope").is_none());
        assert_eq!(
            kmsg_message(&format!("6,1234,5678,-;{denied}\n")).as_deref(),
            Some(denied)
        );
        assert!(kmsg_message("no separator").is_none());
        // Field splitting keeps quoted spaces.
        let f = audit_fields(r#"a="x y" b=1 c="" d"#);
        assert_eq!(f.get("a").map(String::as_str), Some("x y"));
        assert_eq!(f.get("b").map(String::as_str), Some("1"));
        assert_eq!(f.get("c").map(String::as_str), Some(""));
        assert!(!f.contains_key("d"));
    }

    #[test]
    fn rate_limits_per_target() {
        let mut l = AttemptLimiter::default();
        let t0 = Instant::now();
        assert!(l.allow("/a", t0));
        assert!(!l.allow("/a", t0 + Duration::from_secs(9)));
        assert!(l.allow("/b", t0 + Duration::from_secs(1)));
        assert!(l.allow("/a", t0 + Duration::from_secs(10)));
        assert!(!l.allow("/a", t0 + Duration::from_secs(19)));
    }

    #[test]
    fn generalises_socket_paths() {
        assert_eq!(
            generalise_socket_path(
                "/run/user/1000/hypr/0c9c4a4c3f9f1c0a_1757851200_42/.socket.sock"
            ),
            "@{run}/user/[0-9]*/hypr/*/.socket.sock"
        );
        assert_eq!(
            generalise_socket_path("/run/user/1000/noctalia-wayland-1.sock"),
            "@{run}/user/[0-9]*/noctalia-wayland-*.sock"
        );
        assert_eq!(
            generalise_socket_path("/run/user/1000/sway-ipc.1000.42.sock"),
            "@{run}/user/[0-9]*/sway-ipc.*.*.sock"
        );
        assert_eq!(
            generalise_socket_path("/run/user/1000/niri.wayland-1.1234.sock"),
            "@{run}/user/[0-9]*/niri.wayland-*.*.sock"
        );
        assert_eq!(
            generalise_socket_path("/run/user/1000/quickshell/by-id/deadbeef42/ipc.sock"),
            "@{run}/user/[0-9]*/quickshell/by-id/*/ipc.sock"
        );
        assert_eq!(
            generalise_socket_path("/home/work/.cache/foo/x.sock"),
            "@{HOME}/.cache/foo/x.sock"
        );
        assert_eq!(
            generalise_socket_path("/tmp/swww/wayland-1.sock"),
            "/tmp/swww/wayland-*.sock"
        );
        assert_eq!(generalise_socket_path("/run/user/abc/x"), "/run/user/abc/x");
        assert_eq!(generalise_socket_path("/x"), "/x");
        assert_eq!(normalise_glob("~/.config/x"), "@{HOME}/.config/x");
        assert_eq!(normalise_glob("/etc/x"), "/etc/x");
    }

    #[test]
    fn a_second_pam_apparmor_line_is_reported_as_a_warning() {
        let os = Arc::new(FakeOs::default());
        let hooks = os.hooks();
        let one = "session    optional   pam_apparmor.so      order=user,group,default # rp-code session guard\n";
        assert_eq!(pam_lines(&hooks), None, "no PAM file");
        assert_eq!(pam_configured(&hooks), None);
        assert!(pam_duplicate_warning(&hooks).is_none());

        let f = PathBuf::from("/etc/pam.d/system-login");
        let base = "session    required   pam_env.so\n";
        os.files.lock().unwrap().insert(f.clone(), base.into());
        assert_eq!(pam_lines(&hooks), Some(("/etc/pam.d/system-login", 0)));
        assert_eq!(pam_configured(&hooks), Some(false));
        assert!(pam_duplicate_warning(&hooks).is_none());

        os.files
            .lock()
            .unwrap()
            .insert(f.clone(), format!("{base}{one}"));
        assert_eq!(pam_configured(&hooks), Some(true));
        assert!(pam_duplicate_warning(&hooks).is_none(), "one line is right");

        // A commented-out line does not count; a second live one does.
        os.files
            .lock()
            .unwrap()
            .insert(f.clone(), format!("{base}{one}# {one}"));
        assert!(pam_duplicate_warning(&hooks).is_none(), "comments ignored");
        os.files
            .lock()
            .unwrap()
            .insert(f, format!("{base}{one}session optional pam_apparmor.so\n"));
        let w = pam_duplicate_warning(&hooks).expect("warned");
        assert!(w.contains("2 pam_apparmor.so session lines"), "{w}");
        assert!(w.contains("every login hangs"), "{w}");
    }

    #[test]
    fn the_sessions_lifelines_are_never_guarded() {
        // Hyprland listens on all of these, so discovery attributes them to the compositor;
        // guarding them would cut every client off from its display server under `enforce`.
        for path in [
            "/run/user/1000/wayland-1",
            "/run/user/1000/wayland-0",
            "/tmp/.X11-unix/X1",
            "/run/user/1000/bus",
            "/run/user/1000/pipewire-0",
            "/run/user/1000/pulse/native",
        ] {
            let glob = generalise_socket_path(path);
            assert!(never_guard(&glob), "{path} -> {glob} should be exempt");
        }
        // The control sockets the guard exists for are not exempt.
        for path in [
            "/run/user/1000/hypr/0c9c_1757_42/.socket.sock",
            "/run/user/1000/hypr/0c9c_1757_42/.socket2.sock",
            "/run/user/1000/noctalia-wayland-1.sock",
            "/run/user/1000/sway-ipc.1000.42.sock",
            "/tmp/swww/wayland-1.sock",
        ] {
            let glob = generalise_socket_path(path);
            assert!(!never_guard(&glob), "{path} -> {glob} should be guarded");
        }
        assert!(glob_match("/a/*/c", "/a/b/c"));
        assert!(!glob_match("/a/*/c", "/a/b/x/c"), "* stops at a separator");
        assert!(glob_match("@{run}/user/*/bus", "@{run}/user/[0-9]*/bus"));
    }

    #[test]
    fn discovery_never_puts_a_display_socket_into_the_profiles() {
        let mut ctx = noctalia_hyprland_ctx(&["work"]);
        ctx.discovered = vec![
            DiscoveredSocket {
                glob: generalise_socket_path("/run/user/1000/wayland-1"),
                owner: Owner::Compositor,
                entry: "hyprland".into(),
            },
            DiscoveredSocket {
                glob: generalise_socket_path("/tmp/.X11-unix/X1"),
                owner: Owner::Compositor,
                entry: "hyprland".into(),
            },
            DiscoveredSocket {
                glob: generalise_socket_path("/run/user/1000/hypr/0c9c_1757_42/.socket2.sock"),
                owner: Owner::Compositor,
                entry: "hyprland".into(),
            },
        ];
        let r = rules(
            serde_json::json!({"version":1,"app":{"users":["work"]},"guard":{"mode":"enforce"}}),
        );
        let plan = render(&r, &ctx);
        let session = text_of(&plan, "rp-code-session");
        assert!(!session.contains("wayland-*"), "{session}");
        assert!(!session.contains("-unix"), "{session}");
        assert!(session.contains("audit deny @{run}/user/[0-9]*/hypr/*/.socket*.sock rw"));
    }

    #[test]
    fn parses_proc_fixtures_for_discovery() {
        let unix = "Num       RefCount Protocol Flags    Type St Inode Path\n\
0000000000000001: 00000002 00000000 00010000 0001 01 12345 /run/user/1000/noctalia-wayland-1.sock\n\
0000000000000002: 00000003 00000000 00000000 0001 03 12346 /run/user/1000/noctalia-wayland-1.sock\n\
0000000000000003: 00000002 00000000 00010000 0001 01 12347 @/tmp/dbus-abc\n\
0000000000000004: 00000002 00000000 00010000 0001 01 12348 /run/user/1000/hypr/0c9c_1757_42/.socket.sock\n\
0000000000000005: 00000002 00000000 00010000 0001 01 12349\n\
garbage line\n";
        let l = parse_proc_net_unix(unix);
        assert_eq!(
            l,
            vec![
                ListeningSocket {
                    inode: 12345,
                    path: "/run/user/1000/noctalia-wayland-1.sock".into()
                },
                ListeningSocket {
                    inode: 12348,
                    path: "/run/user/1000/hypr/0c9c_1757_42/.socket.sock".into()
                },
            ]
        );
        assert_eq!(
            parse_status_uid(
                "Name:\tnoctalia\nUmask:\t0022\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n"
            ),
            Some(1000)
        );
        assert_eq!(parse_status_uid("Name:\tx\n"), None);
        assert_eq!(socket_inode("socket:[12345]"), Some(12345));
        assert_eq!(socket_inode("pipe:[1]"), None);
        assert_eq!(classify_comm("noctalia").map(|e| e.id), Some("noctalia"));
        assert_eq!(
            classify_comm("Hyprland").map(|e| (e.id, e.owner)),
            Some(("hyprland", Owner::Compositor))
        );
        assert_eq!(classify_comm("swww-daemon").map(|e| e.id), Some("swww"));
        assert!(classify_comm("bash").is_none());
    }

    #[test]
    fn state_round_trips() {
        let s = GuardState {
            mode: GuardMode::Audit,
            hash: "abc".into(),
            loaded: vec!["rp-code-session".into()],
            users: vec!["work".into()],
            sockets: vec![DiscoveredSocket {
                glob: "@{run}/user/[0-9]*/noctalia-wayland-*.sock".into(),
                owner: Owner::Shell,
                entry: "noctalia".into(),
            }],
            applied_at: Some("2026-09-14T12:00:00.000Z".into()),
            last_error: None,
        };
        let text = s.to_json();
        assert!(text.contains("\"mode\": \"audit\""));
        assert!(text.contains("\"owner\": \"shell\""));
        assert_eq!(GuardState::parse(&text), Some(s));
        assert_eq!(GuardState::parse("{}"), Some(GuardState::default()));
        assert!(GuardState::parse("{").is_none());
        let info = GuardInfo {
            available: true,
            mode: GuardMode::Enforce,
            loaded: vec![],
            users: vec![],
            residual: vec!["x".into()],
            pam_configured: Some(true),
            ..GuardInfo::default()
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"available":true,"mode":"enforce","loaded":[],"users":[],"residual":["x"],"pamConfigured":true})
        );
    }

    #[test]
    fn apply_engages_reloads_idempotently_and_disengages() {
        let os = Arc::new(FakeOs::default());
        *os.available.lock().unwrap() = true;
        os.existing.lock().unwrap().extend(
            [
                "/usr/lib/sddm/sddm-helper",
                "/usr/bin/noctalia",
                "/usr/bin/Hyprland",
            ]
            .map(String::from),
        );
        os.files.lock().unwrap().insert(
            PathBuf::from("/etc/pam.d/system-login"),
            "session optional pam_apparmor.so order=user,group,default\n".into(),
        );
        os.discovered.lock().unwrap().push(DiscoveredSocket {
            glob: "@{run}/user/[0-9]*/noctalia-wayland-*.sock".into(),
            owner: Owner::Shell,
            entry: "noctalia".into(),
        });
        let hooks = os.hooks();
        let p = paths(Path::new("/t"));
        let policy =
            parse_policy(r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"audit"}}"#)
                .unwrap();

        let info = apply(Some(&policy), &hooks, &p);
        assert_eq!(info.last_error, None, "{info:?}");
        assert!(info.available);
        assert_eq!(info.mode, GuardMode::Audit);
        assert_eq!(
            info.loaded,
            vec![
                "rp-code-session",
                "rp-code-app",
                "rp-code-shell",
                "rp-code-compositor",
                "rp-code-login"
            ]
        );
        assert_eq!(info.users, vec!["work"]);
        assert_eq!(info.pam_configured, Some(true));
        assert_eq!(info.shell.as_deref(), Some("noctalia"));
        assert_eq!(info.compositor.as_deref(), Some("hyprland"));
        assert_eq!(info.applied_at.as_deref(), Some("2026-09-14T12:00:00.000Z"));
        let calls = os.parser_calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, ParserOp::Check);
        assert_eq!(calls[1].0, ParserOp::Replace);
        assert_eq!(calls[1].1.len(), 5);
        assert!(calls[1].1[0].ends_with("apparmor.d/rp-code-session"));
        let state = GuardState::parse(&os.files.lock().unwrap()[&p.state_file]).unwrap();
        assert_eq!(state.mode, GuardMode::Audit);
        assert_eq!(state.sockets.len(), 1);
        let session_text = os.files.lock().unwrap()[&p.profile_dir.join("rp-code-session")].clone();
        assert!(session_text.contains("noctalia-wayland-*.sock rw,"));

        // Discovery finds nothing next time (shell not running): the cache keeps the socket,
        // files are unchanged, the profiles are still (re)loaded.
        os.discovered.lock().unwrap().clear();
        let again = apply(Some(&policy), &hooks, &p);
        assert_eq!(again.last_error, None);
        assert_eq!(
            os.files.lock().unwrap()[&p.profile_dir.join("rp-code-session")],
            session_text
        );
        assert_eq!(os.parser_calls.lock().unwrap().len(), 4);

        // current_info reads the state without touching the parser; a policy change is flagged.
        let cur = current_info(Some(&policy), &hooks, &p);
        assert_eq!(
            (cur.mode, cur.loaded.len(), cur.pam_configured),
            (GuardMode::Audit, 5, Some(true))
        );
        assert!(cur.residual.is_empty());
        let enforce =
            parse_policy(r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"enforce"}}"#)
                .unwrap();
        let pending = current_info(Some(&enforce), &hooks, &p);
        assert_eq!(pending.mode, GuardMode::Enforce);
        assert!(pending.residual[0].contains("guard-apply is pending"));

        // Enforce rewrites the files (deny rules) and reloads.
        let e = apply(Some(&enforce), &hooks, &p);
        assert_eq!(e.mode, GuardMode::Enforce);
        assert!(
            os.files.lock().unwrap()[&p.profile_dir.join("rp-code-session")].contains("audit deny")
        );

        // A parser failure is reported and recorded, nothing else breaks.
        *os.parser_fail.lock().unwrap() = Some(ParserOp::Check);
        let bad = apply(Some(&enforce), &hooks, &p);
        assert!(bad
            .last_error
            .as_deref()
            .unwrap()
            .contains("profile check failed: check exploded"));
        assert!(bad.loaded.is_empty());
        assert!(GuardState::parse(&os.files.lock().unwrap()[&p.state_file])
            .unwrap()
            .last_error
            .is_some());
        *os.parser_fail.lock().unwrap() = None;

        // mode off: unloaded, files removed, state cleared; a second off is a no-op.
        let off = parse_policy(r#"{"version":1,"app":{"users":["work"]},"guard":{"mode":"off"}}"#)
            .unwrap();
        let before = os.parser_calls.lock().unwrap().len();
        let o = apply(Some(&off), &hooks, &p);
        assert_eq!(
            (o.mode, o.loaded.len(), o.last_error),
            (GuardMode::Off, 0, None)
        );
        let calls = os.parser_calls.lock().unwrap().clone();
        assert_eq!(calls[before].0, ParserOp::Remove);
        assert_eq!(calls[before].1.len(), 5);
        assert!(!os
            .files
            .lock()
            .unwrap()
            .contains_key(&p.profile_dir.join("rp-code-session")));
        assert_eq!(
            GuardState::parse(&os.files.lock().unwrap()[&p.state_file])
                .unwrap()
                .mode,
            GuardMode::Off
        );
        apply(None, &hooks, &p);
        assert_eq!(os.parser_calls.lock().unwrap().len(), before + 1);

        // Without the LSM nothing is written and the status says why.
        *os.available.lock().unwrap() = false;
        let na = apply(Some(&policy), &hooks, &p);
        assert!(!na.available);
        assert!(na
            .last_error
            .as_deref()
            .unwrap()
            .contains("AppArmor is not active"));
        assert_eq!(os.parser_calls.lock().unwrap().len(), before + 1);
    }

    /// The generated profiles pass `apparmor_parser -Q` when the parser is installed (CI has
    /// it; the container may). Skipped otherwise.
    #[test]
    fn generated_profiles_pass_apparmor_parser_when_available() {
        let parser = ["/usr/sbin/apparmor_parser", "/usr/bin/apparmor_parser"]
            .into_iter()
            .find(|p| Path::new(p).exists());
        let Some(parser) = parser else {
            eprintln!("apparmor_parser not installed; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let abi = if Path::new("/etc/apparmor.d/abi/4.0").exists() {
            Some("abi/4.0".to_string())
        } else {
            None
        };
        for (mode, ipc) in [
            ("audit", "shell-only"),
            ("enforce", "deny"),
            ("enforce", "allow"),
        ] {
            let r = rules(
                serde_json::json!({"version":1,"app":{"users":["work","o'neil"]},"guard":{"mode":mode,"compositorIpc":ipc,"allowBinaries":["/usr/bin/free"],"extraDenyPaths":["~/.config/hypr/hyprpaper.conf"],"extraDenySockets":["/run/user/1000/extra.sock"]}}),
            );
            let mut ctx = noctalia_hyprland_ctx(&["work", "o'neil"]);
            ctx.abi = abi.clone();
            let plan = render(&r, &ctx);
            let mut files = Vec::new();
            for f in &plan.files {
                let path = dir.path().join(format!("{}-{mode}-{ipc}", f.name));
                std::fs::write(&path, &f.text).unwrap();
                files.push(path);
            }
            if std::env::var_os("RP_CODED_DUMP_PROFILES").is_some() && mode == "audit" {
                for f in &plan.files {
                    println!("===== /etc/apparmor.d/{} =====\n{}", f.name, f.text);
                }
            }
            let out = std::process::Command::new(parser)
                .arg("-Q")
                .arg("-K")
                .args(&files)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "apparmor_parser -Q failed for {mode}/{ipc}:\n{}\n{}",
                String::from_utf8_lossy(&out.stderr),
                plan.files
                    .iter()
                    .map(|f| f.text.clone())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
    }
}
