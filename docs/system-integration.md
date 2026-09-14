# System integration on Linux: the `rp-coded` daemon

Characters in rp-code can, when a pack has the `input` capability and you approved it, lock
your keyboard and mouse for a short time or type, press keys and click on your behalf. On Linux
those two things need access to `/dev/input/*` (to take the devices away from the compositor)
and `/dev/uinput` (to create a virtual keyboard/mouse). Handing that access to the desktop app
itself would mean any pack — or any bug — could hold your input indefinitely, and any limit you
set in Settings could be changed by the same app that is being limited.

So the privileged part lives in a tiny separate program, **`rp-coded`**, that runs as root under
systemd and does exactly five things:

1. Lock input (grab keyboards/pointers) for at most the time a **root-owned policy file** allows.
2. Release it on a timer, on request, when you hold the **emergency key**, or when it stops.
3. Inject keystrokes, key combos, clicks and pointer moves through one virtual device.
4. Tell the app what the policy says so the Settings UI can show which values are managed.
5. When the policy says the app may not be quit, **relaunch it** in the user's session if its
   process is killed anyway (see [Keeping the app running](#keeping-the-app-running-appallowquit)).

The app talks to it over a unix socket that only members of the `rp-code` group can open.
Nothing else in rp-code needs elevated rights. `sdk.input` is **daemon-only**: there is no
fallback through user-configured tools, so while the daemon is not installed or not connected
every `sdk.input` call fails with `CAPABILITY_FAILED` ("Input control needs the rp-code system
integration (Settings → System → Install); the daemon is not connected") and the rest of the app
keeps working.

## Installing

**From the app:** Settings → System → *Install system integration…*. It explains what will
change, asks for your password through `pkexec`, runs the bundled installer for your user and
shows its output. Log out and back in afterwards (group membership). The app first copies the
installer, its support files and the daemon binary to `~/.cache/rp-code/system-install/` and
runs that copy, because root cannot read files inside a running AppImage (see below).

**From a terminal** (source checkout or the extracted package):

```sh
cd native/rp-coded && cargo build --release        # skip with the packaged app
sudo ./install.sh --user "$USER" --app-bin /path/to/rp-code   # or the AppImage
```

**From the AppImage:** a running AppImage is a FUSE mount under `/tmp/.mount_*` that only the
user who launched it can traverse, so `sudo /tmp/.mount_…/resources/system/install.sh` fails
with "permission denied" even for root. Either use the Settings button (which stages a copy
for you), or extract the files first:

```sh
./rp-code-*.AppImage --appimage-extract 'resources/system/*' 'resources/bin/rp-coded'
sudo squashfs-root/resources/system/install.sh --user "$USER" --app-bin "$(readlink -f rp-code-*.AppImage)"
rm -r squashfs-root
```

Always pass `--app-bin` with the **`.AppImage` itself**. With an AppImage the installer does a
[system install](#system-install) by default: it unpacks the AppImage to `/opt/rp-code/current`
and points every launcher there (pass `--no-system-install` to keep launching the AppImage). The
`rp-code` binary inside a hand-made `squashfs-root` only runs while the whole extraction is around
(it loads `libffmpeg.so` and its resources from next to itself), so a launcher pointing there
breaks as soon as the folder is removed. The installer refuses to auto-pick such a path; without
`--app-bin` it takes an existing `/opt/rp-code/current/rp-code`, then looks for an
`rp-code*.AppImage` in `~/Applications`, `~/.local/bin`, `~/Downloads` and `~`.

The `.deb` package runs `install.sh --autostart none` on installation, which does the
system-wide steps (group, daemon, udev rule, policy directory) and leaves group membership and
autostart for you or the Settings button. It does not write a policy file (no
`--policy-template`), so the write-once creation from the app stays available.

Flags: `--user <name>` (default: the user behind `sudo`/`pkexec`), `--app-bin <path>` (the
executable or AppImage the autostart and menu entries should launch), `--autostart xdg|systemd|none`
(default `xdg`), `--menu-entry yes|no` (default `yes`: an application menu entry and icon under
`/usr/local/share`, so an AppImage shows up in launchers; the `.deb` passes `no` because the
package ships its own), `--policy-template` (write the example policy if none exists),
`--system-install` / `--no-system-install` (unpack the AppImage to `/opt/rp-code`; the default is
yes for an AppImage, see below), `--dry-run` (print the steps without changing anything),
`--uninstall`. System-install maintenance: `--rollback` (swap the previous version back),
`--remove` (delete the system install, keep the daemon), `--refresh-daemon-files` (what the
daemon runs after updating itself). `--guard` / `--no-guard` engage or disengage the
[session guard](#session-guard) (the PAM line plus `rp-coded --guard-apply`/`--guard-off`; alone
they do only that step, with the other flags they force it during a full install, and without
either the installer engages when the policy's `guard.mode` is not `off`). `--prefix <dir>`
relocates every system path under `<dir>` and skips groups, services and udev — for tests
(`scripts/install-smoke.sh`).

Browser extension flags (see [docs/browser-extension.md](browser-extension.md)):
`--browser-extension <id>` with `--browser-update-url <url>` (and optionally `--browser-port <n>`,
defaulting to the port in the URL) adds step 7, which writes the Chromium managed policy
`rp-code.json` that force-installs the rp-code browser extension from the app's loopback update
URL; `--browser-only` does just that step (what Settings → Browser → *Install browser policy…*
runs, since it needs no daemon); `--remove-browser-policy` deletes those files and exits.
The `.deb` never passes these: the extension id is derived from a per-user key.

### What the installer changes

Every step prints `[ok]` when it did something and `[skip]` when it was already done, so
re-running is safe.

| Step | Change |
|---|---|
| 1 | Creates the **`rp-code` group** and adds your user to it (needs a re-login). |
| 2 | Installs the daemon to `/usr/local/libexec/rp-code/rp-coded` (plus `README.md`, `POLICY.md`, `policy.example.json`), the unit `/etc/systemd/system/rp-coded.service`, creates `/etc/rp-code` (`0755`, the one path under `/etc` the hardened service may write to) and runs `systemctl enable --now rp-coded`. |
| 3 | Installs `/etc/udev/rules.d/70-rp-code.rules` (makes `/dev/uinput` group-writable for `rp-code` so group members can use it directly; the daemon itself is root and does not need it), `/etc/modules-load.d/rp-code.conf` (`uinput` at boot), loads the module now and reloads udev. |
| 4 | Policy file: **nothing is written by default** — the file is write-once and you can create it from the app afterwards (below). With `--policy-template`, writes `/etc/rp-code/policy.json` from the example **only if it does not exist**; an existing file is never modified (its ownership is corrected to `root:root 0644` if needed). |
| 5 | **System install** (AppImage only, unless `--no-system-install`): unpacks the AppImage into `/opt/rp-code/current` (root-owned), keeps the old tree as `/opt/rp-code/previous`, writes `/opt/rp-code/versions.json` and links `/usr/local/bin/rp-code`. Every launcher below then points at `/opt/rp-code/current/rp-code`. See [System install](#system-install). |
| 6 | Application menu entry `/usr/local/share/applications/rp-code.desktop` (`Exec=<app> %U`) and icon `/usr/local/share/icons/hicolor/512x512/apps/rp-code.png`, refreshed with `update-desktop-database`/`gtk-update-icon-cache` when present. Skipped with `--menu-entry no` (the `.deb` does this, it ships its own entry). |
| 7 | Autostart for your user: `~/.config/autostart/rp-code.desktop` (`Exec=<app> --hidden`, XDG) or `~/.config/systemd/user/rp-code.service` (enabled with `systemctl --user` when a session bus is reachable, otherwise it prints the command). Switching methods removes the other entry. It also prints the Hyprland `exec-once = <app> --hidden` line for people who prefer that. |
| 8 | Browser policy, only with `--browser-extension`: `rp-code.json` in `/etc/chromium/policies/managed` and `/etc/opt/chrome/policies/managed` (always) and in the Brave, Edge, Vivaldi and Opera policy directories when that browser looks installed (binary on `PATH` or its `/etc` config directory present). `--dry-run` lists every file it would write. |
| 9 | Session guard (with `--guard`, or when the policy has `guard.mode` other than `off`): the `pam_apparmor.so` session line in `/etc/pam.d/system-login` (Arch) or `common-session` (Debian/Ubuntu), then `rp-coded --guard-apply`. `--no-guard` reverses both. |
| 10 | Runs `rp-coded --check-devices` and prints what the daemon can see. |

The daemon creates `/run/rp-code/` (`0750 root:rp-code`) and the socket
`/run/rp-code/daemon.sock` (`0660 root:rp-code`) when it starts. Logs: `journalctl -u rp-coded`.

## System install

An AppImage that updates itself must live in a folder you can write to, and every update
rewrites the file you launch. The system install puts the app where the daemon can maintain it
instead, so updates are applied by `rp-coded` — no `pkexec` prompt, and the previous version stays
around for a rollback. `install.sh` does it by default when `--app-bin` is an AppImage (the
Settings → System installer ticks *Install the app to /opt/rp-code* by default; untick it or pass
`--no-system-install` to keep launching the AppImage).

### Layout

| Path | Contents |
|---|---|
| `/opt/rp-code/current/` | The unpacked app — what `./rp-code-*.AppImage --appimage-extract` produces: `rp-code` (the Electron binary), `libffmpeg.so`, `resources/`, … |
| `/opt/rp-code/previous/` | The version that was current before the last update; the rollback target. |
| `/opt/rp-code/versions.json` | `{ "current": { "version", "installedAt", "source" }, "previous"?: { … } }` — `source` is the AppImage the tree came from. |
| `/usr/local/bin/rp-code` | Symlink to `/opt/rp-code/current/rp-code`. |

Everything under `/opt/rp-code` is `root:root`, directories `0755`, files `0755`/`0644`, never
group- or user-writable. That is deliberate: the path is what the daemon relaunches
(`app.allowQuit: false`) and what future AppArmor profiles key on, so nothing a user can change
runs from it. The menu entry, the autostart entry and the daemon's relaunch registration all
use `/opt/rp-code/current/rp-code`, so a swap takes effect at the next start. The `.deb` package
uses `/opt/rp-code/rp-code` and is unrelated; the two do not share files.

Settings → System shows "System install: /opt/rp-code/current (v1.2.3), previous v1.2.2" while
the app runs from there and the daemon is connected; Settings → Updates then says updates are
applied by the system service.

### How an update is applied

1. The app checks GitHub as before and downloads the release AppImage into
   `~/.cache/rp-code-updater/pending/` (electron-updater; a full download, since there is no old
   AppImage to diff against).
2. *Apply update and restart* sends `apply-update` to the daemon with the file path, the version
   and the `sha512` from the release manifest (`latest-linux.yml`). The request may take a
   minute; the app waits up to five.
3. The daemon refuses unless the peer is a non-root user and the file is a regular file that user
   owns, under their home, at most 1 GiB, opened without following symlinks. It copies the file
   while hashing it and stops on a checksum mismatch. The version must be semver and not older
   than the installed one unless the policy says `settings.updates.allowDowngrade: true`.
4. The copy is extracted (`--appimage-extract`) **as the requesting user** in
   `/opt/rp-code/.staging-<uid>` (`0700`, owned by that user) — untrusted archive contents are never
   unpacked by root. The tree must contain `rp-code`, `libffmpeg.so` and `resources/app.asar`,
   and no setuid/setgid bits, hard links or symlinks pointing outside it; then it is chowned to
   `root:root` and normalised to `0755`/`0644`.
5. Atomic swap: `previous` is removed, `current` becomes `previous`, the new tree becomes
   `current`; `versions.json` is rewritten. Any failure before the swap leaves the install
   untouched; a failed final rename puts the old `current` back.
6. If the bundle ships a newer `rp-coded` (`resources/bin/rp-coded --version`), the daemon runs
   the bundle's `install.sh --refresh-daemon-files` as root — the binary (`.new` + rename), the
   unit, the udev rule, the module list, docs, menu entry and icon — answers `restartDaemon: true`
   and restarts itself once no input lock is active (`systemctl restart rp-coded` under systemd,
   a re-exec otherwise). Every step is in `journalctl -u rp-coded`.
7. The app waits for the daemon to answer again (up to 30 s), unregisters its keepalive
   registration, and relaunches `/opt/rp-code/current/rp-code`.

Errors come back as `REFUSED` (not a system install, root, foreign or unreadable file,
downgrade), `INVALID` (checksum mismatch, bad version, a tree that fails the checks) or
`INTERNAL` (extraction or I/O failure), and Settings → Updates shows them; the download stays
ready so you can retry.

The daemon that is already installed must know `apply-update` (rp-coded 0.2 and later). The
**first** update from an older daemon still needs the installer once: Settings → System →
*Install system integration…* (pkexec) puts the new daemon in place; after that the daemon
updates itself along with the app.

### Rollback and removal

```sh
sudo /opt/rp-code/current/resources/system/install.sh --rollback   # previous ⇄ current, versions.json swapped
sudo /opt/rp-code/current/resources/system/install.sh --remove     # delete /opt/rp-code/{current,previous,versions.json} and the symlink
```

`--rollback` is the manual escape hatch when a new version misbehaves: restart the app
afterwards; the next update goes forward again (an older version is only refused by
`apply-update`, never by the installer). `--uninstall` removes the system install together with
the daemon.

## How a lock works

- The app asks for a duration; the daemon **clamps** it to `inputLock.maxDurationMs` from the
  policy (default 5 minutes, minimum 1 s) and answers with the duration it actually applied. The
  app additionally applies your own *Max input lock* setting, so the shorter of the two wins.
- The daemon opens every keyboard and pointer in `/dev/input` (or only one class when the
  character asked for `keyboard` or `mouse`), grabs them so the compositor stops receiving
  events, keeps reading them so nothing queues up, and grabs devices you plug in during the lock
  within a second.
- Typing and clicking by the character still work during a lock: they go through the daemon's
  own virtual device, which is never grabbed.
- The lock ends when the time is up, when the character calls `unlock`, when you use the
  emergency key, or when the daemon stops (`systemctl stop rp-coded` releases everything).

### Emergency unlock

**Hold `Esc` for 5 seconds** (default) on any grabbed keyboard. The lock ends immediately and the
next status the app sees is "unlocked". A short tap does nothing (so the character cannot be
interrupted by accident), and the key is only *watched* — the daemon never records or forwards
what you type.

The key (`esc`, `f1`, `f12` or `pause`) and the hold time are set in the policy file; the current
values are shown in Settings → System and logged with every lock. When only the mouse is locked,
the keyboard is not grabbed at all, so you keep full keyboard control instead.

Last resorts that always work: switch to a virtual console (`Ctrl+Alt+F3`) and run
`sudo systemctl stop rp-coded`, or unplug and replug the keyboard (the new device is grabbed
again within a second, so type quickly), or wait — a lock can never exceed
`inputLock.maxDurationMs`.

## The policy file

`/etc/rp-code/policy.json` is optional. When present it must be owned by root and is read by
both the daemon (`inputLock`, enforced whatever the app asks) and the app (`settings`, forced
over your own settings and shown as *managed by policy* in the UI). It is re-read whenever it
changes; no restart needed. Full reference with every field and defaults:
`native/rp-coded/dist/POLICY.md` (installed to `/usr/local/libexec/rp-code/POLICY.md`).

```json
{
  "version": 1,
  "managedBy": "shared family PC",
  "settings": { "maxInputLockMs": 60000, "permissions": { "moduleAllow": { "desktop": false } } },
  "inputLock": { "enabled": true, "maxDurationMs": 60000, "emergencyKey": "esc", "emergencyHoldMs": 5000 }
}
```

Points worth knowing:

- `settings.permissions.moduleAllow` is the app-wide permission policy (Settings → Permissions is
  the only permission control; packs neither request nor are granted modules). A module the
  policy file sets to `false` is off for every character and its toggle is shown as managed and
  locked in the app; modules the file does not mention stay under the user's control.
- `inputLock.enabled: false` refuses every lock request; injection is unaffected.
- A broken policy file (invalid JSON, unknown keys) makes the daemon refuse locks until it is
  fixed — it fails closed rather than falling back to defaults. `journalctl -u rp-coded` names
  the problem.
- No policy file at all means the daemon defaults (5 min max, Esc for 5 s) and no managed
  settings.
- `settings.updates` controls the in-app updater: `{ "enabled": false }` switches update checks
  off on this machine (Settings → Updates shows "disabled by policy" and hides the token field),
  `{ "automatic": false }` only pins the "check automatically" toggle so users still update by hand,
  and `{ "allowDowngrade": true }` lets the daemon install an older version over a system install
  (refused by default).
- `app.allowQuit: false` with `app.users: ["alice"]` keeps the app running for those users: no
  way to quit in the UI and a relaunch by the daemon after a kill or crash. Details below.
- `guard: { "mode": "audit" }` confines the listed users' login sessions with AppArmor so their
  own terminals and scripts cannot reach the compositor/shell IPC, edit the wallpaper config or
  kill rp-code — see [Session guard](#session-guard).

### Keeping the app running (`app.allowQuit`)

```json
{ "version": 1, "managedBy": "family PC", "app": { "allowQuit": false, "users": ["alice"] } }
```

**In the app** (as soon as the policy file says so; it is re-read within a minute): the tray menu
has no *Quit* item (Show/Hide and *Check for updates* stay), closing the window always hides it to
the tray — also when the tray is unavailable or *close to tray* is off — Ctrl+Q and `app.quit()`
are cancelled, and `SIGINT`/`SIGTERM`/`SIGHUP` are ignored with a log line. Settings → System says
"Quitting is disabled by policy (managed by …) for: alice". `SIGKILL` cannot be caught, and a
crash is a crash — that is what the daemon is for. Update restarts still work: the updater
authorises its own quit and tells the daemon first.

**In the daemon**: at startup the app opens a dedicated long-lived connection to `rp-coded` and
registers how it was started — the executable (the `.AppImage` itself for an AppImage), its
arguments, working directory and a fixed whitelist of session variables (`DISPLAY`,
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `HOME`, `PATH`, …; nothing else,
and nothing from the daemon's own environment). Registering is always done; the daemon only acts
on it when **all** of these hold once that connection drops without an `unregister`:

1. the policy file (re-read at that moment) says `app.allowQuit: false`;
2. the user who registered (uid from the socket, resolved to a name) is in `app.users` — an
   absent or empty list means nobody is relaunched, which the journal says once;
3. that user owns the **active graphical session** according to logind (`/run/systemd/sessions`,
   `loginctl` as fallback): an active `wayland`/`x11` session on a seat. After user switching the
   other user is active, so the relaunch is dropped; when the listed user comes back nothing
   happens until the app registers again — their autostart entry does that at the next login;
4. after a 1.5 s delay the process is really gone (`/proc/<pid>` missing or a different process).

Then it starts `exec args…` as that user — `setgid`, supplementary groups, `setuid`, never root —
detached in its own session, with exactly the registered environment and working directory
(`$HOME` when that is gone), output to `/dev/null`. Every registration, unregistration, relaunch
and give-up is in `journalctl -u rp-coded` with uid/pid. The relaunched app finds its single-instance
lock free (the old process is dead) and comes back to the tray.

**Crash loops** back off: a death within 60 s of the previous relaunch waits 3 s, then 6, 12 and
30 s (the cap); after 10 relaunches in 10 minutes the daemon gives up and logs it; five minutes
of uptime reset the counters. An app that comes back on its own before the delay is up (the
updater restarting it) cancels the pending relaunch.

**What it is not**: a security boundary against root or against the user themselves.
`sudo systemctl stop rp-coded` switches the guard off (the app is then just an app that hides its
Quit item; `kill` ends it for good), `sudo rm /etc/rp-code/policy.json` or editing `app.allowQuit`
back to `true` restores the Quit item within a minute, and `install.sh --uninstall` removes the
daemon (the policy file stays, so reinstalling re-arms the guard). A user who is not in
`app.users`, or who is not the active session, is never relaunched. The relaunched process is a
child of the daemon's service, so the unit is less sandboxed than a pure device daemon would be
(no `ProtectHome`, `PrivateTmp`, syscall filter or device policy; see the comments in
`rp-coded.service`), and it runs with *no new privileges*, so Chromium uses its user-namespace
sandbox (which the AppImage does anyway).

### Creating the policy from the app (write once)

You do not need root to create the policy — only to change it later. When the daemon is
connected and no policy file exists, Settings → System shows **Create policy…** in the policy
card. It opens an editor prefilled with a policy built from your *current* settings (every
managed key, `inputLock` at your max lock with Esc for 5 s, `managedBy` left empty for you to
fill in), with a *Reset to current settings* link. Edit it, tick *I understand this cannot be
undone without root* and press **Write policy**: the app validates the JSON (problems are listed
in the dialog), sends it to `rp-coded` (`set-policy`), which validates it again exactly like the
file, creates `/etc/rp-code` if needed and writes `policy.json` as `root:root 0644`. Both the
daemon and the app pick the new file up immediately; the managed badges appear once settings
reload.

Rules of the flow:

- **Write once.** The daemon only creates the file when nothing exists at that path (not even
  a symlink or directory) and answers `EXISTS` otherwise. It never modifies or removes an
  existing policy; after creation only root can (`sudoedit /etc/rp-code/policy.json`,
  `sudo rm /etc/rp-code/policy.json`).
- **Anyone in the `rp-code` group can do it, once, for the whole machine.** The first member
  to write the file sets the policy for every user; it is meant for the person who set the
  machine up. If several accounts share the machine, decide who does it before adding the others
  to the group, or seed the file as root yourself (`install.sh --policy-template`).
- **The daemon is the only writer.** The app cannot touch `/etc`; the write goes through the
  socket, is logged with your uid/pid and the `managedBy` text (`journalctl -u rp-coded`), and
  the file is written with `O_CREAT|O_EXCL`, so two people cannot both succeed.
- Without the daemon (not installed, or you are not in the group yet) the button is not shown;
  the policy card says so.

## Session guard

> **Login helper started before the profiles.** AppArmor attaches a profile at exec time, so a
> `greetd`/`sddm-helper`/`sshd` that was already running when the guard was first engaged stays
> unconfined; `pam_apparmor` then logs `changing to <user> hat: Operation not permitted` and the
> login comes up unconfined. The daemon reports this as a warning in `status.guard.warnings`
> (Settings → System shows it as "not effective"): restart the helper from a TTY
> (`systemctl restart greetd`) or reboot. After a reboot `apparmor.service` loads the
> `rp-code-*` files before the login service starts, so it does not recur.

`app.allowQuit: false` keeps the app running; the **session guard** keeps the user from undoing
what the character did *through their own session*: a terminal, a keybind script, the shell's
wallpaper picker. With a `guard` block in the policy the login sessions of the users in
`app.users` are confined by an AppArmor profile that guards three things — connecting to the
compositor's and the desktop shell's IPC sockets, writing the wallpaper/shell config and state
files, and sending signals or `ptrace` to rp-code. rp-code itself (launched from
`/opt/rp-code/current/rp-code`) transitions into its own profile that allows all of it, so the
character's `noctalia msg wallpaper-set …`, `hyprctl …` and so on keep working while the user's
`hyprctl`, `noctalia msg`, `kill` and `vim ~/.config/noctalia/*.toml` are refused. It ships in
**audit mode** (nothing blocked, everything logged and reported to the character); `enforce` is
a policy switch.

```json
{ "version": 1, "app": { "allowQuit": false, "users": ["work"] }, "guard": { "mode": "audit" } }
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `audit` loads the profiles with audit rules in complain mode: attempts are logged as `apparmor="AUDIT"`/`"ALLOWED"` and become `guard-attempt` events, nothing is blocked. `enforce` turns them into `deny` rules. `off` unloads everything. |
| `protectApp` | `true` | Signals and `ptrace` from the session to rp-code. |
| `wallpaper` | `true` | The shell's IPC socket and config/state files; the shell runs in `rp-code-shell`. |
| `compositorIpc` | `shell-only` | `allow` (nothing), `shell-only` (only the shell and rp-code may talk to the compositor), `deny` (only rp-code). |
| `shell` | `auto` | `noctalia`, `quickshell`, `hyprpaper`, `swww` or `none`; `auto` takes the first whose binary exists. |
| `loginHelpers` | auto-detect | The PAM login helpers whose profile carries the per-user hats (see below). |
| `extraDenyPaths`, `extraDenySockets`, `allowBinaries` | `[]` | More guarded files/sockets (`~/…` allowed); binaries that leave the confinement entirely when executed. |

Full field reference: `native/rp-coded/dist/POLICY.md`.

### Turning it on

1. The kernel must run with the AppArmor LSM (`/sys/kernel/security/apparmor` exists; on Arch
   add `lsm=landlock,lockdown,yama,integrity,apparmor,bpf` to the kernel command line and install
   the `apparmor` package, which ships `apparmor_parser` and `pam_apparmor.so`; on Debian/Ubuntu
   it is on by default, `libpam-apparmor` adds the PAM module). No distro profile needs to be
   enabled — the guard loads only its own five `rp-code-*` profiles.
2. Put the `guard` block into `/etc/rp-code/policy.json` (Settings → System → *Create policy…*
   when no file exists, `sudoedit` otherwise) with `mode: "audit"` and the users in `app.users`.
3. Run the installer once with `--guard` (Settings → System → *Install system integration…* passes
   it whenever the policy has `guard.mode` other than `off`, or `sudo install.sh --guard`; a ready-made everything-on policy is `native/rp-coded/dist/policy.all-on.json`, installed as `/usr/local/libexec/rp-code/policy.all-on.json`). It
   adds the PAM line and runs `rp-coded --guard-apply`.
4. Log out and back in: only sessions opened after the PAM line is in place are confined.
5. Watch Settings → System → Session guard → *Audit log…* (or `journalctl -k -g apparmor=`)
   for a day. Every line is something enforce mode would block: your own `hyprctl`, the wallpaper
   picker, keybind scripts. If something you need shows up, add it to `allowBinaries`
   (executables) or drop the part of the guard that catches it (`compositorIpc: "allow"`,
   `wallpaper: false`).
6. Switch `mode` to `"enforce"`. The daemon re-reads the policy within seconds and reloads the
   profiles in place; running sessions pick the new rules up immediately.

### What it blocks, and how

Every rule below was checked against the sources named, not guessed.

- **Who gets confined — pam_apparmor.** `pam_apparmor.so` is a PAM *session* module. When a
  session opens it calls `change_hat()` on the login process into a hat named after the user,
  the user's primary group or `DEFAULT`, in the order given by `order=` (`order=user,group,default`
  tries the user name first). It can only change into a hat that exists *inside the profile that
  already confines the login process* — an unconfined helper has no hats, so the module does
  nothing. (Source: `changehat/pam_apparmor/README` and `pam_apparmor.c` in the AppArmor tree;
  the README's own example is `session optional pam_apparmor.so order=user,group,default`.)
  Hence the generated `rp-code-login` profile: it attaches to the login helpers found on the
  box (`/usr/lib/sddm/sddm-helper`, `greetd`, `/usr/bin/login`, `sshd`), is permissive
  (`file,` plus every rule class, always complain mode — its only job is to host the hats), and
  defines one hat per listed user (`^work { /** px -> rp-code-session, … }`) plus `^DEFAULT`
  whose every exec is `ux` (unconfined). So a listed user's session command — the compositor,
  a TTY shell, an SSH shell — starts in `rp-code-session`; everyone else's runs unconfined as
  before. On Arch `/etc/pam.d/sddm`, `login` and `sshd` include `system-login`, which is where
  the installer puts the line (last session line, after `pam_systemd_home` via `system-auth`
  and `pam_systemd`); on Debian/Ubuntu it goes into `common-session`.
- **Filesystem-path unix sockets.** AppArmor mediates a socket with a filesystem path as a
  *file* (`apparmor.d(5)`, "Unix socket rules": "Unix domain sockets with file system paths are
  mediated via file access rules"). In the kernel (`security/apparmor/af_unix.c`, Linux 6.17+,
  the same code Ubuntu carried earlier): `bind` of a path socket is the `mknod` of the socket
  file — `aa_unix_bind_perm` says "fs bind is handled by mknod" — so it needs **`w`** (create);
  `connect` goes through `unix_connect_perm` (`lsm.c`) with request
  `AA_MAY_CONNECT | AA_MAY_SEND | AA_MAY_RECEIVE`, which `unix_fs_perm` masks with `NET_FS_PERMS`
  and checks as a path permission; `include/net.h` defines `AA_MAY_CONNECT` as `AA_MAY_OPEN`,
  `AA_MAY_SEND` as `AA_MAY_WRITE` and `AA_MAY_RECEIVE` as `AA_MAY_READ`, so connecting needs
  **`rw`**. Listen and accept (`AA_MAY_LISTEN`/`AA_MAY_ACCEPT`) are not in `NET_FS_PERMS` and
  cost nothing; messages on an established stream are not re-checked ("right to send on stream
  done at connect"). That is what tells the shell apart from its own CLI: `rp-code-shell` keeps
  `w` on `noctalia-*.sock` (it may bind and serve it) and loses `r` (it may not connect to it),
  so `noctalia msg` from a terminal — which runs the same binary and lands in the same profile —
  is refused, while the shell process keeps working. The one thing to watch in audit mode: a
  `getattr` denial from the shell on its own socket (`getsockname` needs `r`); if it appears,
  the shell needs `r` too and the CLI-from-a-terminal case becomes the residual gap.
- **Which sockets.** Noctalia v5 listens on `$XDG_RUNTIME_DIR/noctalia-$WAYLAND_DISPLAY.sock`
  (`src/ipc/ipc_service.cpp`, `resolveSocketPath()`; the CLI in `ipc_client.cpp` computes the
  same path), persists the wallpaper to `$XDG_STATE_HOME/noctalia/settings.toml` and reads
  `$XDG_CONFIG_HOME/noctalia/*.toml`. Quickshell: `$XDG_RUNTIME_DIR/quickshell/by-id/<id>/ipc.sock`
  (`src/core/paths.cpp`). Hyprland: `$XDG_RUNTIME_DIR/hypr/<signature>/.socket.sock` and
  `.socket2.sock`; hyprpaper `.hyprpaper.sock` next to them; swww `swww-$WAYLAND_DISPLAY.sock`.
  The daemon also **discovers** sockets: at every engage it reads `/proc/net/unix` (listening
  path sockets) and `/proc/<pid>/fd` of the listed users' shell/compositor processes, generalises
  per-launch parts to `*` (`hypr/0c9c…_42/` → `hypr/*/`, `noctalia-wayland-1.sock` →
  `noctalia-wayland-*.sock`) and caches them in `/etc/rp-code/guard-state.json`, so a socket the
  table does not know is still covered from the next engage on (the app sends `guard-apply`
  after writing a policy; `rp-coded --guard-apply` does it by hand).
- **Exec transitions.** Named transitions take globs: `rp-code-shell` and `rp-code-compositor`
  send every child back with `/** px -> rp-code-session` (a terminal opened by a keybind, a
  script run by the launcher), while `/opt/rp-code/current/rp-code px -> rp-code-app` and the
  shell/compositor binaries have their own targets — a more specific path rule coexists with the
  glob (checked with `apparmor_parser -Q`; the daemon's tests run the generated profiles through
  it). Inside `rp-code-session` everything is `ix` (inherit) except those exemptions and the
  policy's `allowBinaries` (`ux`). rp-code's own children (`noctalia msg …` from a command
  template) inherit `rp-code-app` through `file,`.
- **Signals and ptrace.** `signal (send) peer=rp-code-app` and `ptrace (trace) peer=rp-code-app`
  are guarded in the session, shell and compositor profiles, and the app profile guards the
  receiving side (`signal (receive)`, `ptrace (tracedby)`) — AppArmor checks both peers. Root,
  systemd, logind and the daemon are unconfined and unaffected; `pkill`/`htop` still see the
  process (only `trace`, not `read`, is guarded).
- **Audit vs enforce.** Explicit `deny` rules are enforced *even in complain mode*
  (`apparmor.d(5)`: complain "only allows policy violations that are not covered by a rule").
  Audit mode therefore uses `audit <rule>` — the access is allowed and logged as
  `apparmor="AUDIT"` — with the profile in `complain` so anything the generator forgot is
  logged rather than refused; enforce mode uses `audit deny <rule>` and drops `complain`.
- **Reporting.** The daemon tails the kernel log (`journalctl -f -o json _TRANSPORT=kernel +
  _TRANSPORT=audit`, falling back to `/dev/kmsg`) for `apparmor=` records with
  `profile="rp-code-…"`, classifies them (`ipc`, `config`, `signal`, `ptrace`, `exec`), keeps one
  per target every 10 s and pushes them over the app's keepalive connection as
  `{ "ev": "guard-attempt", … }` lines (the app subscribes with `{ "op": "subscribe" }` after
  registering). The app turns each into the `guard-attempt` host event
  (`{ kind, target, command, pid, blocked }`), so a character can subscribe with `sdk.events.on`
  and answer in character when you try to swap the wallpaper back; Settings → System keeps the
  last 50 under *Audit log…*.

The generated files live in `/etc/apparmor.d/rp-code-{session,app,shell,compositor,login}`, each
headed with a hash of the policy and context so a re-engage rewrites nothing that did not change;
`apparmor_parser -Q` validates and `-r` loads them, and the daemon does this at start, whenever
`policy.json` changes and on `guard-apply`. The profiles define their own `@{run}` and `@{HOME}`
(`/home/*/`, `/root/` — a systemd-homed home mounted at `/home/<name>` is covered) and include
nothing from the distro, so a machine with every distro profile parked in
`/etc/apparmor.d/disable` works unchanged. The unit gains `CAP_MAC_ADMIN` and write access to
`/etc/apparmor.d` and `/sys/kernel/security/apparmor` for this.

### What it cannot do

- **Root undoes it.** A user with `sudo` can `apparmor_parser -R /etc/apparmor.d/rp-code-*`,
  `aa-disable`, edit the policy or stop the daemon. As with the input lock, the guard is for a user
  who has agreed to it.
- **Logout, reboot, TTY switch.** Blocking those means blocking logind for the session (and the
  lock screen with it). The app is back at the next login through autostart and the daemon's
  relaunch; the character's memory of the interruption is the deterrent.
- **Already-open sessions** are confined at their next login; running processes are not moved.
- **The compositor's own code** is not confined (plugins run inside it); only its child
  processes are. What the character launches through rp-code runs with the app's rights.
- **`systemctl --user`**: an app started as a systemd *user* unit lives in the user's delegated
  cgroup, where `systemctl --user stop`/`kill` work without signals (the daemon relaunches it,
  outside that cgroup). Prefer the XDG autostart entry (the installer's default).
- **Unknown shells or compositors** are not guarded until a table row exists or discovery has
  seen them running (the status line names what was found; Settings → System lists every gap
  under *What it cannot do*).

### Recovery

`guard.mode: "off"` in the policy unloads the profiles within seconds (the daemon watches the
file); `sudo rp-coded --guard-off` or `sudo apparmor_parser -R /etc/apparmor.d/rp-code-*` does it
without the daemon; `sudo install.sh --no-guard` also removes the PAM line. A confined root shell
can do all of this (the session profile allows `capability mac_admin`), so a TTY login as the
listed user plus `sudo` is enough. The input-lock emergency key is unaffected.

## Uninstalling

```sh
sudo native/rp-coded/install.sh --uninstall --user "$USER"
# packaged app: sudo "<resources>/system/install.sh" --uninstall --user "$USER"
```

`install.sh --uninstall` unloads the session guard and removes its PAM line, stops and disables
the service, removes the unit, the binary
directory, the udev rule, the modules-load entry, the [system install](#system-install)
(`/opt/rp-code/{current,previous,versions.json}` and `/usr/local/bin/rp-code`), your autostart
entry, your group membership, the `rp-code` group and any browser policy files (`rp-code.json`)
the installer wrote. It **keeps `/etc/rp-code/policy.json`** and prints how to remove it
(`sudo rm -r /etc/rp-code`). Stopping the daemon also ends the relaunch guard of
`app.allowQuit: false`; the running app keeps hiding its Quit item until the policy file is
removed or changed (it re-reads the file within a minute). The packaged app ships the script at
`<resources>/system/install.sh` (Settings → System shows the exact path with a copy button).

## Security notes

- **Group membership is a capability.** Anyone in `rp-code` can lock this machine's input for
  up to the policy maximum and inject keystrokes into whatever window is focused — including
  password prompts. Treat the group exactly like `input`: only add accounts that are allowed to
  do that, and do not add it to service accounts.
- **The daemon does not trust the app.** Durations are clamped server-side, the policy can
  disable locking, and the policy file lives in `/etc` where the app cannot write. The one
  exception is deliberate: `set-policy` lets a group member *create* the file when none exists
  (write once, logged with uid/pid); an existing file is never changed by anything but root.
  Nothing the app sends can read your input; the daemon drains grabbed events and only looks
  for the emergency key.
- **Least privilege for a root process.** The systemd unit runs with a closed device policy
  (input devices and `/dev/uinput` only), read-only file system, no new privileges, a system-call
  allow-list and just the capabilities needed to hand the socket to the group. Every lock is
  logged with the requesting user id and process id.
- **Wayland compositors cannot tell injected input from yours.** That is the point, but it also
  means the character's `type`/`key`/`click` land in whichever window has focus. The app asks
  packs to focus the right window first and keep sequences short; keep the `input` capability
  limited to packs you trust.
- **Injection uses a US keyboard layout.** Characters that do not exist on US-QWERTY are skipped
  and counted (`skipped` in the response); if your compositor uses another layout the typed
  characters differ. Clicks use the primary screen's pixel space (first connected DRM output,
  fallback 1920×1080); multi-monitor layouts may need a compositor-side mapping for the
  `rp-coded virtual input` device.
- **Without the daemon** there is no input locking or injection at all: `sdk.input` calls fail
  with `CAPABILITY_FAILED` until the system integration is installed and connected.
- **Updates are verified, extracted as the user and installed as root.** `apply-update` only
  accepts a file the requesting user owns under their home, hashes exactly the bytes it later
  extracts (SHA-512 from the release manifest; release signing is not implemented yet, so the
  manifest fetched over HTTPS with the user's token is the root of trust), unpacks it with that
  user's privileges, refuses trees with setuid bits, hard links or escaping symlinks, and only
  then takes ownership. A member of `rp-code` can therefore install any *genuine release* into
  `/opt/rp-code` — including an older one when the policy allows downgrades — but never
  arbitrary files.
- **Relaunching runs the user's own program as the user.** A registration is only accepted from
  a non-root uid, for an existing executable, with at most 32 arguments and a fixed whitelist of
  environment variables (values ≤ 4 KiB); the daemon adds nothing of its own, drops root before
  `exec` and only relaunches for users listed in `app.users` who own the active session. Root can
  always stop it (`systemctl stop rp-coded`).
