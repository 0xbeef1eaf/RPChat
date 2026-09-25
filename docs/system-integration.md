# System integration on Linux: the `rpchatd` daemon

Characters in rpchat can, when a pack has the `input` capability and you approved it, lock
your keyboard and mouse for a short time or type, press keys and click on your behalf. On Linux
those two things need access to `/dev/input/*` (to take the devices away from the compositor)
and `/dev/uinput` (to create a virtual keyboard/mouse). Handing that access to the desktop app
itself would mean any pack — or any bug — could hold your input indefinitely, and any limit you
set in Settings could be changed by the same app that is being limited.

So the privileged part lives in a tiny separate program, **`rpchatd`**, that runs as root under
systemd and does exactly five things:

1. Lock input (grab keyboards/pointers) for at most the time a **root-owned policy file** allows.
2. Release it on a timer, on request, when you hold the **emergency key**, or when it stops.
3. Inject keystrokes, key combos, clicks and pointer moves through one virtual device.
4. Tell the app what the policy says so the Settings UI can show which values are managed.
5. When the policy says the app may not be quit, **relaunch it** in the user's session if its
   process is killed anyway (see [Keeping the app running](#keeping-the-app-running-appallowquit)).

The app talks to it over a unix socket that only members of the `rpchat` group can open.
Nothing else in rpchat needs elevated rights. `sdk.input` is **daemon-only**: there is no
fallback through user-configured tools, so while the daemon is not installed or not connected
every `sdk.input` call fails with `CAPABILITY_FAILED` ("Input control needs the rpchat system
integration (Settings → System → Install); the daemon is not connected") and the rest of the app
keeps working.

## Installing

**From the app:** Settings → System → *Install system integration…*. It explains what will
change, asks for your password through `pkexec`, runs the bundled installer for your user and
shows its output. Log out and back in afterwards (group membership). The app first copies the
installer, its support files and the daemon binary to `~/.cache/rpchat/system-install/` and
runs that copy, because root cannot read files inside a running AppImage (see below).

**From a terminal** (source checkout or the extracted package):

```sh
cd native/rpchatd && cargo build --release        # skip with the packaged app
sudo ./install.sh --user "$USER" --app-bin /path/to/rpchat   # or the AppImage
```

**From the AppImage:** a running AppImage is a FUSE mount under `/tmp/.mount_*` that only the
user who launched it can traverse, so `sudo /tmp/.mount_…/resources/system/install.sh` fails
with "permission denied" even for root. Either use the Settings button (which stages a copy
for you), or extract the files first:

```sh
./rpchat-*.AppImage --appimage-extract 'resources/system/*' 'resources/bin/rpchatd'
sudo squashfs-root/resources/system/install.sh --user "$USER" --app-bin "$(readlink -f rpchat-*.AppImage)"
rm -r squashfs-root
```

Always pass `--app-bin` with the **`.AppImage` itself**. With an AppImage the installer does a
[system install](#system-install) by default: it unpacks the AppImage to `/opt/rpchat/current`
and points every launcher there (pass `--no-system-install` to keep launching the AppImage). The
`rpchat` binary inside a hand-made `squashfs-root` only runs while the whole extraction is around
(it loads `libffmpeg.so` and its resources from next to itself), so a launcher pointing there
breaks as soon as the folder is removed. The installer refuses to auto-pick such a path; without
`--app-bin` it takes an existing `/opt/rpchat/current/rpchat`, then looks for an
`rpchat*.AppImage` in `~/Applications`, `~/.local/bin`, `~/Downloads` and `~`.

The `.deb` package runs `install.sh --autostart none` on installation, which does the
system-wide steps (group, daemon, udev rule, policy directory) and leaves group membership and
autostart for you or the Settings button. It does not write a policy file (no
`--policy-template`), so the write-once creation from the app stays available.

Flags: `--user <name>` (default: the user behind `sudo`/`pkexec`), `--app-bin <path>` (the
executable or AppImage the autostart and menu entries should launch), `--autostart xdg|systemd|none`
(default `xdg`), `--menu-entry yes|no` (default `yes`: an application menu entry and icon under
`/usr/local/share`, so an AppImage shows up in launchers; the `.deb` passes `no` because the
package ships its own), `--policy-template` (write the example policy if none exists),
`--system-install` / `--no-system-install` (unpack the AppImage to `/opt/rpchat`; the default is
yes for an AppImage, see below), `--dry-run` (print the steps without changing anything),
`--uninstall`. System-install maintenance: `--rollback` (swap the previous version back),
`--remove` (delete the system install, keep the daemon), `--refresh-daemon-files` (what the
daemon runs after updating itself). `--guard` / `--no-guard` engage or disengage the
[session guard](#session-guard) (the PAM line plus `rpchatd --guard-apply`/`--guard-off`; alone
they do only that step, with the other flags they force it during a full install, and without
either the installer engages when the policy's `guard.mode` is not `off`). `--prefix <dir>`
relocates every system path under `<dir>` and skips groups, services and udev — for tests
(`scripts/install-smoke.sh`).

Browser extension flags (see [docs/browser-extension.md](browser-extension.md)):
`--browser-extension <id>` with `--browser-update-url <url>` (and optionally `--browser-port <n>`,
defaulting to the port in the URL) adds step 8, which writes the Chromium managed policy
`rpchat-<user>.json` that force-installs the rpchat browser extension from the app's loopback
update URL. It is written **for `--user` alone**: owned by `root:root` so the user cannot edit
their own policy, and readable only by them (a POSIX ACL, or the group bit where ACLs are
unavailable) so another user's browser skips it and keeps its own. `--browser-only` does just
that step (what Settings → Browser → *Install browser policy…* runs, since it needs no daemon);
`--remove-browser-policy` deletes that user's files (plus the machine-wide `rpchat.json` older
versions wrote) and exits, and `--browser-all-users` widens it to every user's.
The `.deb` never passes these: the extension id is derived from a per-user key.

### What the installer changes

Every step prints `[ok]` when it did something and `[skip]` when it was already done, so
re-running is safe.

| Step | Change |
|---|---|
| 1 | Creates the **`rpchat` group** and adds your user to it (needs a re-login). |
| 2 | Installs the daemon to `/usr/local/libexec/rpchat/rpchatd` (plus `README.md`, `POLICY.md`, `policy.example.json`), the unit `/etc/systemd/system/rpchatd.service`, creates `/etc/rpchat` (`0755`, the one path under `/etc` the hardened service may write to) and runs `systemctl enable --now rpchatd`. |
| 3 | Installs `/etc/udev/rules.d/70-rpchat.rules` (makes `/dev/uinput` group-writable for `rpchat` so group members can use it directly; the daemon itself is root and does not need it), `/etc/modules-load.d/rpchat.conf` (`uinput` at boot), loads the module now and reloads udev. |
| 4 | Policy file: **nothing is written by default** — the file is write-once and you can create it from the app afterwards (below). With `--policy-template`, writes `/etc/rpchat/policy.json` from the example **only if it does not exist**; an existing file is never modified (its ownership is corrected to `root:root 0644` if needed). |
| 5 | **System install** (AppImage only, unless `--no-system-install`): unpacks the AppImage into `/opt/rpchat/current` (root-owned), keeps the old tree as `/opt/rpchat/previous`, writes `/opt/rpchat/versions.json` and links `/usr/local/bin/rpchat`. Every launcher below then points at `/opt/rpchat/current/rpchat`. See [System install](#system-install). |
| 6 | Application menu entry `/usr/local/share/applications/rpchat.desktop` (`Exec=<app> %U`) and icons `/usr/local/share/icons/hicolor/{512x512,128x128,64x64,48x48,32x32}/apps/rpchat.png`, refreshed with `update-desktop-database`/`gtk-update-icon-cache` when present. That directory has no `index.theme` of its own, so a launcher that cannot read the hicolor `Directories` list probes a hard-coded set of sizes instead — several stop at 256x256 and would miss a 512-only icon. Skipped with `--menu-entry no` (the `.deb` does this, it ships its own entry). |
| 7 | Autostart for your user: `~/.config/autostart/rpchat.desktop` (`Exec=<app> --hidden`, XDG) or `~/.config/systemd/user/rpchat.service` (enabled with `systemctl --user` when a session bus is reachable, otherwise it prints the command). Switching methods removes the other entry. It also prints the Hyprland `exec-once = <app> --hidden` line for people who prefer that. |
| 8 | Browser policy, only with `--browser-extension`: `rpchat-<user>.json` (`0600 root:root` plus a read ACL for that user) in `/etc/chromium/policies/managed` and `/etc/opt/chrome/policies/managed` (always) and in the Brave, Edge, Vivaldi and Opera policy directories when that browser looks installed (binary on `PATH` or its `/etc` config directory present). A machine-wide `rpchat.json` left by an older version is removed; other users' files are left alone. `--dry-run` lists every file it would write. |
| 9 | Session guard (with `--guard`, or when the policy has `guard.mode` other than `off`): the `pam_apparmor.so` session line in `/etc/pam.d/system-login` (Arch) or `common-session` (Debian/Ubuntu), then `rpchatd --guard-apply`. `--no-guard` reverses both. |
| 10 | Runs `rpchatd --check-devices` and prints what the daemon can see. |

The daemon creates `/run/rpchat/` (`0750 root:rpchat`) and the socket
`/run/rpchat/daemon.sock` (`0660 root:rpchat`) when it starts. Logs: `journalctl -u rpchatd`.

## System install

An AppImage that updates itself must live in a folder you can write to, and every update
rewrites the file you launch. The system install puts the app where the daemon can maintain it
instead, so updates are applied by `rpchatd` — no `pkexec` prompt, and the previous version stays
around for a rollback. `install.sh` does it by default when `--app-bin` is an AppImage (the
Settings → System installer ticks *Install the app to /opt/rpchat* by default; untick it or pass
`--no-system-install` to keep launching the AppImage).

### Layout

| Path | Contents |
|---|---|
| `/opt/rpchat/current/` | The unpacked app — what `./rpchat-*.AppImage --appimage-extract` produces: `rpchat` (the Electron binary), `libffmpeg.so`, `resources/`, … |
| `/opt/rpchat/previous/` | The version that was current before the last update; the rollback target. |
| `/opt/rpchat/versions.json` | `{ "current": { "version", "installedAt", "source" }, "previous"?: { … } }` — `source` is the AppImage the tree came from. |
| `/usr/local/bin/rpchat` | Symlink to `/opt/rpchat/current/rpchat`. |

Everything under `/opt/rpchat` is `root:root`, directories `0755`, files `0755`/`0644`, never
group- or user-writable. That is deliberate: the path is what the daemon relaunches
(`app.allowQuit: false`) and what future AppArmor profiles key on, so nothing a user can change
runs from it. The menu entry, the autostart entry and the daemon's relaunch registration all
use `/opt/rpchat/current/rpchat`, so a swap takes effect at the next start. The `.deb` package
uses `/opt/rpchat/rpchat` and is unrelated; the two do not share files.

Settings → System shows "System install: /opt/rpchat/current (v1.2.3), previous v1.2.2" while
the app runs from there and the daemon is connected; Settings → Updates then says updates are
applied by the system service.

### How an update is applied

1. The app checks GitHub as before and downloads the release AppImage into
   `~/.cache/rpchat-updater/pending/` (electron-updater; a full download, since there is no old
   AppImage to diff against).
2. *Apply update and restart* sends `apply-update` to the daemon with the file path, the version
   and the `sha512` from the release manifest (`latest-linux.yml`). The request may take a
   minute; the app waits up to five.
3. The daemon refuses unless the peer is a non-root user and the file is a regular file that user
   owns, under their home, at most 1 GiB, opened without following symlinks. It copies the file
   while hashing it and stops on a checksum mismatch. The version must be semver and not older
   than the installed one unless the policy says `settings.updates.allowDowngrade: true`.
4. The copy is extracted (`--appimage-extract`) **as the requesting user** in
   `/opt/rpchat/.staging-<uid>` (`0700`, owned by that user) — untrusted archive contents are never
   unpacked by root. The tree must contain `rpchat`, `libffmpeg.so` and `resources/app.asar`,
   and no setuid/setgid bits, hard links or symlinks pointing outside it; then it is chowned to
   `root:root` and normalised to `0755`/`0644`.
5. Atomic swap: `previous` is removed, `current` becomes `previous`, the new tree becomes
   `current`; `versions.json` is rewritten. Any failure before the swap leaves the install
   untouched; a failed final rename puts the old `current` back.
6. If the bundle ships a newer `rpchatd` (`resources/bin/rpchatd --version`), the daemon runs
   the bundle's `install.sh --refresh-daemon-files` as root — the binary (`.new` + rename), the
   unit, the udev rule, the module list, docs, menu entry and icon — answers `restartDaemon: true`
   and restarts itself once no input lock is active (`systemctl restart rpchatd` under systemd,
   a re-exec otherwise). Every step is in `journalctl -u rpchatd`.
7. The app waits for the daemon to answer again (up to 30 s), unregisters its keepalive
   registration, and relaunches `/opt/rpchat/current/rpchat`.

Errors come back as `REFUSED` (not a system install, root, foreign or unreadable file,
downgrade), `INVALID` (checksum mismatch, bad version, a tree that fails the checks) or
`INTERNAL` (extraction or I/O failure), and Settings → Updates shows them; the download stays
ready so you can retry.

The daemon that is already installed must know `apply-update` (rpchatd 0.2 and later). The
**first** update from an older daemon still needs the installer once: Settings → System →
*Install system integration…* (pkexec) puts the new daemon in place; after that the daemon
updates itself along with the app.

### Rollback and removal

```sh
sudo /opt/rpchat/current/resources/system/install.sh --rollback   # previous ⇄ current, versions.json swapped
sudo /opt/rpchat/current/resources/system/install.sh --remove     # delete /opt/rpchat/{current,previous,versions.json} and the symlink
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
  emergency key, or when the daemon stops (`systemctl stop rpchatd` releases everything).

### Emergency unlock

**Hold `Esc` for 5 seconds** (default) on any grabbed keyboard. The lock ends immediately and the
next status the app sees is "unlocked". A short tap does nothing (so the character cannot be
interrupted by accident), and the key is only *watched* — the daemon never records or forwards
what you type.

The key (`esc`, `f1`, `f12` or `pause`) and the hold time are set in the policy file; the current
values are shown in Settings → System and logged with every lock. When only the mouse is locked,
the keyboard is not grabbed at all, so you keep full keyboard control instead.

Last resorts that always work: switch to a virtual console (`Ctrl+Alt+F3`) and run
`sudo systemctl stop rpchatd`, or unplug and replug the keyboard (the new device is grabbed
again within a second, so type quickly), or wait — a lock can never exceed
`inputLock.maxDurationMs`.

## The policy file

`/etc/rpchat/policy.json` is optional. When present it must be owned by root and is read by
both the daemon (`inputLock`, enforced whatever the app asks) and the app (`settings`, forced
over your own settings and shown as *managed by policy* in the UI). It is re-read whenever it
changes; no restart needed. Full reference with every field and defaults:
`native/rpchatd/dist/POLICY.md` (installed to `/usr/local/libexec/rpchat/POLICY.md`).

```json
{
  "version": 1,
  "managedBy": "shared family PC",
  "settings": { "maxInputLockMs": 60000, "permissions": { "functionAllow": { "desktop": false, "web.fetch": false } } },
  "inputLock": { "enabled": true, "maxDurationMs": 60000, "emergencyKey": "esc", "emergencyHoldMs": 5000 }
}
```

Points worth knowing:

- `settings.permissions.functionAllow` is the app-wide permission policy (Settings → Permissions is
  the only permission control; packs neither request nor are granted anything). Its keys are a
  module id (`desktop`, the whole module) or one function of it (`web.fetch`), and a function key
  wins over its module's. A key the policy file sets to `false` is off for every character and its
  toggle is shown as managed and locked in the app — pinning a module locks its functions with it;
  keys the file does not mention stay under the user's control. `sdk.lib`, the character's own
  saved functions, is not subject to the policy. `moduleAllow` is the name this map had while
  permissions were per module; policy files that still use it keep working unchanged.
- `inputLock.enabled: false` refuses every lock request; injection is unaffected.
- A broken policy file (invalid JSON, unknown keys) makes the daemon refuse locks until it is
  fixed — it fails closed rather than falling back to defaults. `journalctl -u rpchatd` names
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
  own terminals and scripts cannot edit the wallpaper config, run a wallpaper client or kill
  rpchat — and, on a kernel whose AppArmor has the `unix` mediation class, cannot reach the
  compositor/shell IPC either — see [Session guard](#session-guard).
- `dev: { "allow": false }` takes the app's development switches away, so nobody can start the
  app in a mode that ignores the rest of this file. Details below.

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

**In the daemon**: at startup the app opens a dedicated long-lived connection to `rpchatd` and
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
and give-up is in `journalctl -u rpchatd` with uid/pid. The relaunched app finds its single-instance
lock free (the old process is dead) and comes back to the tray.

**Crash loops** back off: a death within 60 s of the previous relaunch waits 3 s, then 6, 12 and
30 s (the cap); after 10 relaunches in 10 minutes the daemon gives up and logs it; five minutes
of uptime reset the counters. An app that comes back on its own before the delay is up (the
updater restarting it) cancels the pending relaunch.

**What it is not**: a security boundary against root or against the user themselves.
`sudo systemctl stop rpchatd` switches the guard off (the app is then just an app that hides its
Quit item; `kill` ends it for good), `sudo rm /etc/rpchat/policy.json` or editing `app.allowQuit`
back to `true` restores the Quit item within a minute, and `install.sh --uninstall` removes the
daemon (the policy file stays, so reinstalling re-arms the guard). A user who is not in
`app.users`, or who is not the active session, is never relaunched. The relaunched process is a
child of the daemon's service, so the unit is less sandboxed than a pure device daemon would be
(no `ProtectHome`, `PrivateTmp`, syscall filter or device policy; see the comments in
`rpchatd.service`), and it runs with *no new privileges*, so Chromium uses its user-namespace
sandbox (which the AppImage does anyway).

### Locking down development mode (`dev.allow`)

```json
{ "version": 1, "managedBy": "family PC", "dev": { "allow": false, "devTools": false } }
```

The app has switches it uses while it is being built: `RP_MOCK_LLM=1` replaces every provider with
a scripted one, `RP_SMOKE=1` drives turns by itself, `RP_EXAMPLE_PLUGIN` installs a plugin from any
directory, `RP_OVERLAY_HELPER` runs any binary as the overlay helper, `RP_DAEMON_SOCKET` points the
app at something pretending to be `rpchatd`, `RP_USER_DATA` gives it another profile,
`RP_POLICY_FILE` gives it another policy, and `ELECTRON_RENDERER_URL` loads the interface itself
from a dev server. Add `--inspect` or `--remote-debugging-port` and the main process and the
renderer are open to anyone. Every one of them is a way to start *your* app with *their* rules.

`dev.allow: false` ends that. At startup — before it has read the environment for anything else —
the app deletes every `RP_*` variable, `ELECTRON_RENDERER_URL`, `ELECTRON_RUN_AS_NODE` and
`NODE_OPTIONS` from its own process, and refuses to start at all when the command line asks for a
debugging channel:

```
[dev-guard] development switches are locked off by policy; ignoring RP_MOCK_LLM, RP_POLICY_FILE
[dev-guard] refusing to start: --remote-debugging-port=9222 would open a debugging channel, and the system policy locks development switches off
```

DevTools follow `allow` unless you say otherwise: `"dev": { "allow": false, "devTools": true }`
keeps the inspector (for support on a machine you manage), `"dev": { "devTools": false }` closes
the inspector and leaves the rest alone. Settings → System shows what the running app started with,
under *Development*.

Two details make this a lock rather than a suggestion:

- **It is read from `/etc/rpchat/policy.json` itself**, synchronously, never through
  `RP_POLICY_FILE` — reading the lock through a file the locked user chose would be no lock at all.
- **It fails closed**: a policy file that exists but cannot be read or does not parse locks the
  switches, rather than falling back to "allowed". The cost of being wrong that way is a
  convenience; the other way it is the lock.

Because it is read once at startup, a change to `dev` applies at the app's next start rather than
within the minute like `app.allowQuit`. The daemon's relaunch cannot reintroduce a switch either:
a registration carries only the whitelisted session variables (`DISPLAY`, `WAYLAND_DISPLAY`, …),
and no `RP_*` variable is in that list.

**What it is not**: a boundary against someone who can replace the app itself, or who runs the
app's code in an Electron binary of their own — nothing inside a process can defend against that.
Install the app to `/opt/rpchat` (root-owned, [System install](#system-install)) and turn the
[session guard](#session-guard) on if that is the threat you have in mind. What this does is keep
a normal user from launching the app you installed in a mode where the rest of this file does not
apply.

### Creating the policy from the app (write once)

You do not need root to create the policy — only to change it later. When the daemon is
connected and no policy file exists, Settings → System shows **Create policy…** in the policy
card. It opens a form over the whole policy file, prefilled from your *current* settings (every
managed key, `inputLock` at your max lock with Esc for 5 s, `managedBy` left empty for you to
fill in), in five tabs:

- **The app** — `app.allowQuit`, the `app.users` list, and a switch per `app` restriction
  (`allowPackEditor`, `allowSandbox`, `requireCharacterSession`, …). On means allowed, as it is
  without a policy.
- **Forced settings** — one switch per settings key the policy can force, grouped by area, with
  the value beside it. A key switched **off is left out of the file entirely**, which is what
  leaves it to each user; switched on it is pinned for everyone and shown to them as *managed by
  policy*. *Force all* / *Force none* set them in one go, and the tab shows how many are on.
  `permissions.functionAllow` is a three-way per module — *user's choice*, *allow*, *deny* — since
  a key left out of the map keeps the user's setting; each module expands to the same three-way
  per function, for pinning one call rather than a whole module.
- **Remote & packs** — the address the policy is fetched from (`remote`) and the packs this
  machine is meant to have (`packs`), each with an optional checksum and version.
- **Session guard** — `guard.mode`, the protection switches, `compositorIpc`, the shell picker
  (`auto` and `none` are exclusive; named shells stack), and the path lists under *Extra rules*.
- **Input lock** — the daemon's own `inputLock` limits, and below them the `lock` switches that
  decide how hard the policy holds once you lock it behind a code.
- **Review** — the exact JSON that will be written, a *Copy* button, and *Load a policy from
  JSON* to fill the form in from a policy prepared elsewhere.

A footer summarises what the policy does ("23 settings forced", "session guard: enforce") and
lists anything that must be fixed first — a guard mode with no `app.users`, a duration below the
daemon's floor, a home page that is not an http(s) URL, a guard path AppArmor could not carry.
**Write policy** stays disabled while any of those stand, because the file is write-once and a
refusal after the fact leaves the machine with no policy at all.

Tick *I understand this cannot be undone without root* and press **Write policy**: the app sends
the JSON to `rpchatd` (`set-policy`), which validates it again exactly like the file, creates
`/etc/rpchat` if needed and writes `policy.json` as `root:root 0644`. Both the daemon and the
app pick the new file up immediately; the managed badges appear once settings reload.

Rules of the flow:

- **Write once.** The daemon only creates the file when nothing exists at that path (not even
  a symlink or directory) and answers `EXISTS` otherwise. It never modifies or removes an
  existing policy; after creation only root can (`sudoedit /etc/rpchat/policy.json`,
  `sudo rm /etc/rpchat/policy.json`).
- **Anyone in the `rpchat` group can do it, once, for the whole machine.** The first member
  to write the file sets the policy for every user; it is meant for the person who set the
  machine up. If several accounts share the machine, decide who does it before adding the others
  to the group, or seed the file as root yourself (`install.sh --policy-template`).
- **The daemon is the only writer.** The app cannot touch `/etc`; the write goes through the
  socket, is logged with your uid/pid and the `managedBy` text (`journalctl -u rpchatd`), and
  the file is written with `O_CREAT|O_EXCL`, so two people cannot both succeed.
- Without the daemon (not installed, or you are not in the group yet) the button is not shown;
  the policy card says so.

Write-once is the default because it needs nothing but the daemon. If you are setting this up for
somebody else, read the next section first: locking the policy behind a code gives you the thing
write-once cannot — the ability to change your mind.

## Locking the policy

Write-once-then-root's is right for a machine you own and wrong for one you manage for somebody
else. **Sealing** replaces it with a lock, and there are two, which are mutually exclusive.

### A code, for a machine you can walk up to

Settings → System → **Policy lock** → *Lock policy*. The daemon generates a TOTP secret, pins the
current policy to it, and shows you — **once** — a QR code to scan with your authenticator app.
*Can't scan it?* opens the secret to type in by hand and the `otpauth://` URI behind the code, for
a phone that is not to hand or an app that takes a URI. Enrol before closing that dialog, and keep
a copy of the secret somewhere safe: nothing shows it again.

From then on *Edit policy…* opens the policy form seeded from what is on disk and asks for the
current code before writing, and *Unlock…* (or `sudo rpchatd --unseal <code>`) releases the
machine. Being root is not enough for either. Three wrong codes are free; after that the lock
refuses everything for 30 seconds, doubling per failure up to 15 minutes, and a code is spent once
used.

### A signed chain, for a fleet

Paste a **Remote Link** whose mode is *chain only* and the machine is sealed differently: **no
secret is generated at all.** It pins a public key and the hash of the last policy version it
applied, and the only thing that can change anything is a new version signed by that key. There is
no code to type, none to steal, and nothing on the machine that could mint one — *Edit policy* and
*Unlock* are simply not offered, and asking for them over the socket is refused.

Releasing such a machine is also a signed version, one that carries *unseal*. That is the trade:
you never have to visit the machine, and you can never get in without the key.

This is also the answer to "can the code be asymmetric?" — it cannot. TOTP is HMAC over a time
counter, so anything that can check a code can generate one. The chain is the asymmetric version
of the same idea: the machine holds only public material.

### What is actually holding it shut

The honest answer is "several things, none of them absolute", and the app says which are in place
— Settings → System lists the rest under *What the lock cannot do*.

1. **The policy the app obeys is not the file.** The daemon publishes it into
   `/run/rpchat/policy`, a filesystem it mounts itself and remounts read-only after each write.
   Editing `/etc/rpchat/policy.json` changes nothing until the daemon agrees.
2. **It puts the file back.** Every few seconds the daemon compares the file against the locked
   copy and rewrites it, recording the attempt in a tamper log you can read in Settings → System.
3. **It keeps spare copies** in `/var/lib/rpchat` and `/usr/local/libexec/rpchat`, so deleting
   one does not unlock anything.
4. **The files are immutable**, so `rm` and an editor's save fail until someone runs `chattr -i`.
5. **The session guard takes the ways out away.** In `enforce` mode a locked policy also denies
   the confined sessions everything under `/etc/rpchat`, `/var/lib/rpchat` and `/run/rpchat` —
   reading included, because in code mode the secret is in there — and the binaries that would
   start a shell outside the confinement or undo it: `run0`, `machinectl`, `pkexec`, `chattr`,
   `apparmor_parser`, `aa-teardown`. **`sudo` is deliberately left alone**: what `sudo` starts is
   its child, so it stays inside the profile and gains nothing. `run0` is the interesting one,
   because it asks the system manager to start the shell and PID 1 is unconfined.

   **`systemd-run` looks like `run0` and is not.** It has three halves and only one of them is an
   escape, so it gets a profile — `rpchat-systemd-run` — instead of a refusal:

   | how it is called | who runs the command | confined? |
   | --- | --- | --- |
   | `systemd-run --user …` | `systemd --user` | yes — the guard's own `user@<uid>.service.d` drop-in confines the user manager, so what it starts inherits `rpchat-session` |
   | `systemd-run --scope …` | `systemd-run` itself, after registering the scope | yes — it `exec`s in its own process, so the command inherits whatever confined it |
   | `systemd-run …` | the **system** manager | **no** — PID 1 is unconfined |

   AppArmor cannot read argv, so the split is made by transport: `rpchat-systemd-run` denies the
   system bus and PID 1's private socket, which only the third form uses. Everything it launches
   goes back through the ordinary exec table, so `systemd-run --scope -- <shell>` still lands the
   shell in `rpchat-shell`.

   This matters more than it sounds. `uwsm app -- <command>` is `systemd-run --user --scope`
   underneath, and that is how a systemd-managed Hyprland, sway or niri session starts its bar,
   its shell and everything on a keybind. While the binary was denied outright, `enforce` meant
   the shell simply never launched — whereas a wallpaper daemon started from XDG autostart (a
   real unit, no `systemd-run` in the path) came up fine. The desktop lost its bar and kept its
   wallpaper, which reads as the guard breaking the shell rather than blocking an escape.

   A path listed in `guard.allowBinaries` overrides whatever rule the guard would otherwise write
   for it — the deny, the `px` into a sub-profile, all of it. It has to: two exec rules for one
   path is `profile has merged rule with conflicting x modifiers`, which is not a conflict
   AppArmor resolves but a parse error that leaves the whole guard unloaded.
6. **The service refuses to stop.** A drop-in with `RefuseManualStop=yes` and `Restart=always`
   turns `systemctl stop rpchatd` into a refusal and brings a killed daemon back.
7. **The app fails closed.** It keeps its own copy of a locked policy. Once it has seen one it
   keeps enforcing it even if `/etc/rpchat` and the daemon are both gone — that case is reported
   as tampering, not as freedom — and forgets it only when a *running* daemon says the machine is
   unlocked.

### What it cannot do

- In code mode, a root shell the session guard does **not** confine can read the secret and mint
  its own codes. Without the guard in `enforce`, locking raises the bar; it does not set one. In
  chain mode there is nothing to read — the same shell can stop the daemon and delete what it
  protects, but it cannot produce a policy the machine would accept.
- Booting from other media bypasses the daemon entirely. Only full-disk encryption with a
  firmware password answers that.
- The app's cached copy lives in the user's own data directory, so the user can delete it. It is
  the difference between "you need the key" and "you need one command off a forum".

## Remote Link: following a policy chain

A machine follows a chain by being given a **Remote Link** — a base64 blob carrying the address,
the public key that signs the chain, and the mode the machine gets. Settings → System → **Remote
Link** → *Paste a link…*. The first one is free; replacing it hands the machine to a different
key, so a code-mode machine asks for its code and a chain-mode machine refuses outright (publish a
release on its current chain first).

A chain is a list of versions, each committing to the one before it by hash and signed. A machine
finds its own position in the file, verifies every version after it, and applies the last — so a
machine that was off for a month catches up by checking each signature on the way. An old version
cannot be replayed, because its `prev` no longer matches. Rotating the signing key is itself a
signed version, authorised by the key it replaces.

### Publishing one

Settings → System → **Remote Link** → *Publish a chain…*, on whichever machine you write policies
on. It generates the signing key (protected by the OS keyring where there is one), gives you the
Remote Link blob to hand out, and signs each new version of the policy as the next link. Paste the
JSON from the policy form's *Review* tab, press *Sign it as the next version*, and publish the
chain file at the address in the link.

To do the same from a terminal — a build server, say, where you would rather the key lived:

```bash
node scripts/rp-policy-chain.mjs keygen --out key.pem
node scripts/rp-policy-chain.mjs link --key key.pem --url https://policies.example.com/chain.json \
     --managed-by "Acme IT" --mode chain             # the blob to hand out
node scripts/rp-policy-chain.mjs sign --key key.pem --chain chain.json --policy policy.json
node scripts/rp-policy-chain.mjs sign --key key.pem --chain chain.json --unseal   # let them go
```

Serve `chain.json` at that address, including every version from your oldest machine's position
onwards. A machine that cannot find its position says so rather than guessing.

**Back up the private key.** Losing it strands every machine on the chain: nothing else can sign a
version they will accept, including the one that would release them.

### Packs

The same policy names the packs a machine should have. Each is pinned by a **signature**, not a
checksum — on a managed machine the policy itself arrived over the network, so a checksum in it
proves only that the policy and the pack agree, not that either came from you:

```bash
node scripts/rp-policy-chain.mjs pack --key key.pem --id luna --version 1.2.0 --file luna.rppack
```

That prints the `packs.sources` entry to paste into the policy. The app downloads and hashes; the
daemon checks the signature, because the daemon is the side holding the key. A machine with no
Remote Link has no key to check against and uses `sha256` instead. `removeUnlisted: true`
uninstalls everything the list does not name.

## Session guard

> **Login helper started before the profiles.** AppArmor attaches a profile at exec time, so a
> `greetd`/`sddm-helper`/`sshd` that was already running when the guard was first engaged stays
> unconfined; `pam_apparmor` then logs `changing to <user> hat: Operation not permitted` and the
> login comes up unconfined. The daemon reports this as a warning in `status.guard.warnings`
> (Settings → System shows it as "not effective"): restart the helper from a TTY
> (`systemctl restart greetd`) or reboot. After a reboot `apparmor.service` loads the
> `rpchat-*` files before the login service starts, so it does not recur.

`app.allowQuit: false` keeps the app running; the **session guard** keeps the user from undoing
what the character did *through their own session*: a terminal, a keybind script, the shell's
wallpaper picker. With a `guard` block in the policy the login sessions of the users in
`app.users` are confined by an AppArmor profile that guards three things — connecting to the
compositor's and the desktop shell's IPC sockets, writing the wallpaper/shell config and state
files, and sending signals or `ptrace` to rpchat. rpchat itself (launched from
`/opt/rpchat/current/rpchat`) transitions into its own profile that allows all of it, so the
character's `noctalia msg wallpaper-set …`, `hyprctl …` and so on keep working while the user's
`hyprctl`, `noctalia msg`, `kill` and `vim ~/.config/noctalia/*.toml` are refused.

**Denying that first `connect()` is not something AppArmor can do on a mainstream kernel, so a
second mechanism does it — and the app says which one you have.** Denying a `connect()` to a
filesystem socket needs AppArmor's fine-grained `unix` mediation class
(`/sys/kernel/security/apparmor/features/unix`). A kernel advertising only `network_v9/af_unix`
has the *coarse* form — "may use unix sockets", no address, no peer — and on one of those there
is no way to express the rule at all. Measured inside a loaded `enforce` profile on 7.2.6: with
`deny /run/rpchat/** rwklx` in force, `open()` on a socket there is `EACCES` and `connect()` to
it **succeeds**; a `unix (connect) peer=(label=rpchat-shell)` rule loads and changes nothing.

So on such a kernel the guard loads a small **BPF LSM** program on `lsm/unix_stream_connect`,
which has the hook AppArmor lacks ([IPC guard](#ipc-guard-bpf-lsm) below, `guard.ipcGuard`). It
needs the kernel booted with the `bpf` LSM; where that is missing the mediation is genuinely
absent and `status.guard.ipcMediation` says `none`, with the gap under *What the lock cannot do*.
The file rules are unaffected either way — they cover `open()` and `bind` — so what survives
without it is that a wallpaper set through the shell's socket does not *persist*, plus the client
binaries below. The guard ships in **audit mode** (nothing blocked, everything logged and
reported to the character); `enforce` is a policy switch.

```json
{ "version": 1, "app": { "allowQuit": false, "users": ["work"] }, "guard": { "mode": "audit" } }
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `audit` loads the profiles with audit rules in complain mode: attempts are logged as `apparmor="AUDIT"`/`"ALLOWED"` and become `guard-attempt` events, nothing is blocked. `enforce` turns them into `deny` rules. `off` unloads everything. |
| `protectApp` | `true` | Signals and `ptrace` from the session to rpchat. |
| `wallpaper` | `true` | The shell's IPC socket and config/state files; the shell runs in `rpchat-shell`. Also denies the row's client-only binaries (`swww`, `awww`) to every profile but rpchat's, which is what stops `awww img <path>` from a terminal on a kernel that cannot mediate `connect()`. A shell shipping one binary for both jobs (`noctalia`, `qs`) cannot be denied that way — it would stop the shell starting — so `noctalia msg` survives there and the residual list says so. |
| `compositorIpc` | `shell-only` | `allow` (nothing), `shell-only` (only the shell and rpchat may talk to the compositor), `deny` (only rpchat). |
| `ipcGuard` | `auto` | Mediate `connect()` to the shell's sockets with a BPF LSM program where the kernel allows it — the check AppArmor cannot make. `off` never loads it. See [IPC guard](#ipc-guard-bpf-lsm). |
| `shell` | `auto` | One row or a list. `auto` takes every row whose binary exists. With several (`["noctalia","hyprpaper"]`) each may serve its own socket but none may connect to another's, so a bar cannot set the wallpaper through a wallpaper daemon. |
| `loginHelpers` | auto-detect | The PAM login helpers whose profile carries the per-user hats (see below). |
| `extraDenyPaths`, `extraDenySockets`, `allowBinaries` | `[]` | More guarded files/sockets (`~/…` allowed); binaries that leave the confinement entirely when executed. |

Full field reference: `native/rpchatd/dist/POLICY.md`.

### Turning it on

1. The kernel must run with the AppArmor LSM (`/sys/kernel/security/apparmor` exists; on Arch
   add `lsm=landlock,lockdown,yama,integrity,apparmor,bpf` to the kernel command line and install
   the `apparmor` package, which ships `apparmor_parser` and `pam_apparmor.so`; on Debian/Ubuntu
   it is on by default, `libpam-apparmor` adds the PAM module). No distro profile needs to be
   enabled — the guard loads only its own five `rpchat-*` profiles. The **`bpf`** in that `lsm=`
   list is what makes the wallpaper IPC lock real rather than partial (see
   [IPC guard](#ipc-guard-bpf-lsm)); Arch's default kernel has `CONFIG_BPF_LSM=y`, Debian's and
   Ubuntu's `CONFIG_LSM` usually omits `bpf` and their `lsm=` has to be set by hand to include it.
2. Put the `guard` block into `/etc/rpchat/policy.json` (Settings → System → *Create policy…*
   when no file exists, `sudoedit` otherwise) with `mode: "audit"` and the users in `app.users`.
3. Run the installer once with `--guard` (Settings → System → *Install system integration…* passes
   it whenever the policy has `guard.mode` other than `off`, or `sudo install.sh --guard`; a ready-made everything-on policy is `native/rpchatd/dist/policy.all-on.json`, installed as `/usr/local/libexec/rpchat/policy.all-on.json`). It
   adds the PAM line and runs `rpchatd --guard-apply`.
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
  Hence the generated `rpchat-login` profile: it attaches to the login helpers found on the
  box (`/usr/lib/sddm/sddm-helper`, `greetd`, `/usr/bin/login`, `sshd`), is permissive
  (`file,` plus every rule class, always complain mode — its only job is to host the hats), and
  defines one hat per listed user (`^work { /** px -> rpchat-session, … }`) plus `^DEFAULT`
  whose every exec is `ux` (unconfined). So a listed user's session command — the compositor,
  a TTY shell, an SSH shell — starts in `rpchat-session`; everyone else's runs unconfined as
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
  done at connect"). That is what tells the shell apart from its own CLI: `rpchat-shell` keeps
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
  `noctalia-wayland-*.sock`) and caches them in `/etc/rpchat/guard-state.json`, so a socket the
  table does not know is still covered from the next engage on (the app sends `guard-apply`
  after writing a policy; `rpchatd --guard-apply` does it by hand). Discovery finds every
  *listening* socket the process owns, and a compositor owns more than its control socket:
  Hyprland also listens on the Wayland display socket and, for XWayland, on `/tmp/.X11-unix/X<n>`.
  Those — plus the session bus, the system bus and the PipeWire/PulseAudio sockets — are on a
  never-guard list (`NEVER_GUARD` in `guard.rs`) and are dropped before they reach a profile or
  the state cache: guarding the display socket would cut every client in the session off from
  its compositor the moment the mode became `enforce`. Only `extraDenySockets` can name them,
  and only deliberately.
- **The user manager, and why the hats are not enough.** AppArmor confinement follows `execve`,
  so `pam_apparmor`'s hat reaches only what the login helper itself started. A systemd-managed
  desktop session does not qualify: `systemctl --user` merely *asks* `systemd --user` to start
  things, and `systemd --user` was started by PID 1 through `user@<uid>.service`. Everything it
  launches — the compositor, the shell, every terminal — therefore runs unconfined, while the
  profiles and hats still load and still look correct. The tell is an audit log that stays empty,
  which reads as "nothing happened" rather than "nothing was watched". So the daemon also writes
  `/etc/systemd/system/user@<uid>.service.d/rpchat-guard.conf` for each `app.users` entry:

  ```ini
  [Service]
  AppArmorProfile=-rpchat-session
  ```

  PID 1 does the transition, and the whole user session starts inside `rpchat-session`
  (the compositor then takes its `px` to `rpchat-compositor`, the shell to `rpchat-shell`).
  The leading **`-`** is load-bearing: without it a `user@<uid>.service` whose profile is not
  loaded *fails to start*, which is every boot before `rpchatd` has engaged — the failure mode
  is "this account cannot log in at all". Drop-ins are written on engage, reaped when a user
  leaves `app.users`, removed by `--no-guard`/`mode: off`, and each change is followed by
  `systemctl daemon-reload`. They bind when PID 1 execs the manager, so a **re-login** is needed,
  not just a policy reload. `status.guard.warnings` reports a session running unconfined despite
  loaded profiles, so this cannot silently no-op again.
- **Exec transitions.** Named transitions take globs: `rpchat-shell` and `rpchat-compositor`
  send every child back with `/** px -> rpchat-session` (a terminal opened by a keybind, a
  script run by the launcher), while `/opt/rpchat/current/rpchat px -> rpchat-app` and the
  shell/compositor binaries have their own targets — a more specific path rule coexists with the
  glob (checked with `apparmor_parser -Q`; the daemon's tests run the generated profiles through
  it). Inside `rpchat-session` everything is `ix` (inherit) except those exemptions and the
  policy's `allowBinaries` (`ux`). rpchat's own children (`noctalia msg …` from a command
  template) inherit `rpchat-app` through `file,`.
- **Signals and ptrace.** `signal (send) peer=rpchat-app` and `ptrace (trace) peer=rpchat-app`
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
  `profile="rpchat-…"`, classifies them (`ipc`, `config`, `signal`, `ptrace`, `exec`), keeps one
  per target every 10 s and pushes them over the app's keepalive connection as
  `{ "ev": "guard-attempt", … }` lines (the app subscribes with `{ "op": "subscribe" }` after
  registering). The app turns each into the `guard-attempt` host event
  (`{ kind, target, command, pid, blocked }`), so a character can subscribe with `sdk.events.on`
  and answer in character when you try to swap the wallpaper back; Settings → System keeps the
  last 50 under *Audit log…*.

The generated files live in `/etc/apparmor.d/rpchat-{session,app,shell,compositor,login}`, each
headed with a hash of the policy and context so a re-engage rewrites nothing that did not change;
`apparmor_parser -Q` validates and `-r` loads them, and the daemon does this at start, whenever
`policy.json` changes and on `guard-apply`. The profiles define their own `@{run}` and `@{HOME}`
(`/home/*/`, `/root/` — a systemd-homed home mounted at `/home/<name>` is covered) and include
nothing from the distro, so a machine with every distro profile parked in
`/etc/apparmor.d/disable` works unchanged. The unit gains `CAP_MAC_ADMIN` and write access to
`/etc/apparmor.d` and `/sys/kernel/security/apparmor` for this.

### IPC guard (BPF LSM)

The one check AppArmor cannot make on a mainstream kernel. Design notes and the measurements
behind it: `docs/spec/ipc-guard-bpf.md`; the code is `native/rpchatd/src/ipcguard.rs` and the
program itself `native/rpchatd/src/bpf/ipc_guard.bpf.c` (~150 lines of C, readable in one sitting).

When `guard.ipcGuard` is `auto` (the default) and `guard.mode` is not `off`, the daemon loads a
BPF program attached to `lsm/unix_stream_connect` and decides from three maps:

| Map | Holds | Filled from |
|---|---|---|
| `rpchat_targets` | the socket nodes to mediate, keyed by `(device major, device minor, inode)` | the shell sockets discovery found (`/proc/net/unix` + `/proc/<pid>/fd`) and the table's globs expanded against the real runtime directories, `stat()`ed |
| `rpchat_allowed` | up to 8 cgroups whose tasks may connect anyway | slot 0 the rpchat app's, from its keepalive registration; the rest the cgroups of the processes serving the mediated sockets |
| `rpchat_mode` | 0 off, 1 audit, 2 enforce | `guard.mode` |

A connection to a socket in `rpchat_targets` from a task in none of `rpchat_allowed` returns
`-EACCES` in enforce and 0 in audit, and either way a record goes into a ring buffer that the
daemon turns into the same `guard-attempt` event an AppArmor denial produces — with
`profile: "bpf-ipc"` rather than an `rpchat-*` name, so a reader can tell them apart.

Four things are worth knowing before turning it on:

- **It is keyed on the inode, not the path**, because the hook is handed a `struct sock *` and
  no string. Inodes churn: a shell that restarts unlinks and rebinds, and the map goes stale at
  exactly the moment someone would retry. The daemon watches `/run/user/<uid>` with inotify and
  rescans, plus every 30 s regardless, but there is a window between `bind()` and the rescan.
- **It allows by cgroup, not by binary.** The character sets a wallpaper by running
  `noctalia msg wallpaper-set …`, a *different binary* from the app, so the allow-list has to
  cover the app's descendants and a cgroup is the one identity they all inherit. The cost is
  that anything sharing the app's cgroup is allowed too: an app started from a terminal shares
  that terminal's scope, which opens the lock to everything in it. A packaged install started
  from autostart or the desktop entry gets its own scope and does not have that gap.
- **It mediates every process on the machine**, not only the confined users' sessions — a BPF
  LSM program has no notion of a profile. Root and system services are denied the guarded sockets
  too. Only the *guarded users' own* sockets go into the map, so another user's shell is
  untouched, but within a guarded user's session the reach is wider than the AppArmor half's.
- **The socket servers may reach each other.** noctalia setting a wallpaper through swww is a
  real configuration, and mediating it would break the shell's own wallpaper setting, so each
  server's cgroup is in the allow-list. The AppArmor design always intended shell→shell denial;
  this is where that intent is traded for a desktop that works, and it is in the residual list.

The program is **pinned** under `/sys/fs/bpf/rpchat/<build>/link`, so `kill -9 rpchatd` does not
drop the mediation — the unit has `RefuseManualStop=yes` and `Restart=always`, but there is a
window otherwise. `guard.mode: off`, `rpchatd --guard-off` and `install.sh --no-guard` unpin it;
`apparmor_parser -R` does not, so remove `/sys/fs/bpf/rpchat/` by hand if that is how you turned
the guard off. The build directory in the path is a hash of the compiled program: a daemon that
was upgraded finds no pin of its own and replaces the old one rather than running both. The unit
gains `CAP_BPF`, `CAP_PERFMON` and write access to `/sys/fs/bpf` for this.

It **fails open**: a kernel without the `bpf` LSM or without BTF, a build made without `clang`,
a program the verifier refuses — all of them leave the desktop working, leave `guard-apply`
succeeding, and set `ipcMediation: "none"` with the reason in the residual list. `bpftool` is
added to the denied escape binaries for the same reason `apparmor_parser` is: it undoes this
layer. Checking it on a live box, from a terminal in a guarded session:

```sh
rpchatd --guard-apply | grep ipcMediation   # must say "bpf" before the rest means anything
awww query                                  # expect: cannot reach the daemon
noctalia msg wallpaper-get                  # expect: the same
```

The program is written in C and compiled by `build.rs` with `clang -target bpf`, then loaded with
[aya](https://aya-rs.dev) (a pure-Rust loader, so the daemon stays on stable Rust — `aya-ebpf`,
which would let the program itself be Rust, needs a nightly toolchain). The kernel types it reads
are hand-written in `src/bpf/vmlinux.h` — five structs and one field each, rather than the
160,000 lines `bpftool btf dump` generates — and every field access is a CO-RE relocation, so one
object works across kernels. Compositor IPC is deliberately **out of scope**: the same hook would
mediate it, but the compositor serves the Wayland display and the X11 sockets alongside its
control socket, and that allow-list is a different question.

### What it cannot do

- **Root undoes it.** A user with `sudo` can `apparmor_parser -R /etc/apparmor.d/rpchat-*`,
  `aa-disable`, edit the policy or stop the daemon. As with the input lock, the guard is for a user
  who has agreed to it.
- **Logout, reboot, TTY switch.** Blocking those means blocking logind for the session (and the
  lock screen with it). The app is back at the next login through autostart and the daemon's
  relaunch; the character's memory of the interruption is the deterrent.
- **Already-open sessions** are confined at their next login; running processes are not moved.
- **The compositor's own code** is not confined (plugins run inside it); only its child
  processes are. What the character launches through rpchat runs with the app's rights.
- **`systemctl --user`**: an app started as a systemd *user* unit lives in the user's delegated
  cgroup, where `systemctl --user stop`/`kill` work without signals (the daemon relaunches it,
  outside that cgroup). Prefer the XDG autostart entry (the installer's default).
- **Plugin self-update stops, palettes keep working.** `rpchat-shell` sends every child back to
  `rpchat-session`, so the `git` and `sh` the shell runs for its own updates are bound by the
  session's rules. Rather than deny the shell's whole config and state tree, the guard denies
  only what carries the wallpaper — `~/.local/state/noctalia/settings.toml`
  (`[wallpaper] directory`, `[wallpaper.default|last|monitors.<output>] path`) and
  `~/.config/noctalia/settings.json` (the wallpaper options and `hooks.wallpaperChange`, a
  command run on every change). `community-palettes/`, `community-templates/`, `colorschemes/`,
  `colors.json` and the caches stay writable, so palette and template updates keep working.
  The **plugin** directories stay denied, and that is deliberate: a plugin is QML/JS/sh executed
  *inside* the shell, and the shell may write `settings.toml`, so a writable plugin tree is only
  a slower way to set the wallpaper. The cost is that plugin self-update fails under `enforce`.
- **Links from unnamed inodes are logged but not blocked.** An `O_TMPFILE` inode has no name, so
  AppArmor renders it `<dir>/#<inode>`, fails the lookup and denies `l` — no rule can match a
  name that cannot be resolved, and an explicit `link subset /{,**} -> /{,**},` changes nothing
  (measured). The kernel refuses that link for unprivileged callers regardless, so these records
  are audit noise on an operation that was already failing, not an enforce-mode breakage.
- **Unknown shells or compositors** are not guarded until a table row exists or discovery has
  seen them running (the status line names what was found; Settings → System lists every gap
  under *What it cannot do*).

### Recovery

`guard.mode: "off"` in the policy unloads the profiles within seconds (the daemon watches the
file); `sudo rpchatd --guard-off` or `sudo apparmor_parser -R /etc/apparmor.d/rpchat-*` does it
without the daemon; `sudo install.sh --no-guard` also removes the PAM line. A confined root shell
can do all of this (the session profile allows `capability mac_admin`), so a TTY login as the
listed user plus `sudo` is enough. The input-lock emergency key is unaffected. If no login works
at all, boot with `apparmor=0` (or a kernel without the LSM) and fix it from there.

> **A login that hangs in D state, unkillable.** `rpchat-login` is generated in *enforce*
> mode, in both guard modes, and this is why. `order=user,group,default` makes `pam_apparmor`
> look for a hat named after the user first, so every login by someone who is not in
> `app.users` is a miss. In enforce mode the kernel returns `-ENOENT` and the module falls
> through to the group and then `^DEFAULT`, which is the design. In *complain* mode it instead
> builds a learning profile — `build_change_hat` → `aa_new_learning_profile` — and that path
> self-deadlocks on the AppArmor policy mutex the `change_hat` already holds:
>
> ```
> INFO: task login:4502 blocked for more than 122 seconds.
>  __mutex_lock / aa_new_learning_profile / build_change_hat / aa_change_hat
> INFO: task login:4502 is blocked on a mutex likely owned by task login:4502.
> ```
>
> The task is in `D` (uninterruptible) state, so `kill -9` does nothing — the signal sits in
> `ShdPnd` forever because the task never returns to user space. It holds the policy mutex, so
> from then on every `apparmor_parser` run and even `cat /sys/kernel/security/apparmor/profiles`
> blocks too, which means `rpchatd --guard-off` and `install.sh --no-guard` cannot help. Only
> a reboot clears it. Seen on 7.2.2-1-cachyos; the profile never being complain avoids the path
> entirely. To recover, remove the PAM line and `/etc/apparmor.d/rpchat-*` as plain file edits
> (neither touches the mutex), set `guard.mode: "off"`, then reboot.

> **A login that hangs with no message — check for two `pam_apparmor.so` lines.** `pam_apparmor`
> enters the hat with a magic token and remembers it. A second `pam_apparmor.so` session line in
> the stack — hand-added, or left behind by another tool — calls `change_hat()` again with a
> *different* token; the kernel refuses the switch and leaves the login process in a profile
> that permits nothing, so `login` cannot even write the failure to the terminal. `optional`
> does not help: the damage is done inside the kernel, not in the PAM return code. It hangs for
> every user, whether or not they are in `app.users`, and in `audit` mode too — complain mode
> softens rule violations, not a failed `change_hat`. Check with
> `grep -c pam_apparmor /etc/pam.d/system-login` (Arch) or `common-session` (Debian/Ubuntu); the
> answer must be `1`. `install.sh --guard` collapses extra lines into its own marked one and
> says so.

## Uninstalling

```sh
sudo native/rpchatd/install.sh --uninstall --user "$USER"
# packaged app: sudo "<resources>/system/install.sh" --uninstall --user "$USER"
```

`install.sh --uninstall` unloads the session guard and removes its PAM line, stops and disables
the service, removes the unit, the binary
directory, the udev rule, the modules-load entry, the [system install](#system-install)
(`/opt/rpchat/{current,previous,versions.json}` and `/usr/local/bin/rpchat`), your autostart
entry, your group membership, the `rpchat` group and every user's browser policy files
(`rpchat-<user>.json`, and `rpchat.json` from older versions) the installer wrote. It **keeps `/etc/rpchat/policy.json`** and prints how to remove it
(`sudo rm -r /etc/rpchat`). Stopping the daemon also ends the relaunch guard of
`app.allowQuit: false`; the running app keeps hiding its Quit item until the policy file is
removed or changed (it re-reads the file within a minute). The packaged app ships the script at
`<resources>/system/install.sh` (Settings → System shows the exact path with a copy button).

## Security notes

- **Group membership is a capability.** Anyone in `rpchat` can lock this machine's input for
  up to the policy maximum and inject keystrokes into whatever window is focused — including
  password prompts. Treat the group exactly like `input`: only add accounts that are allowed to
  do that, and do not add it to service accounts.
- **The daemon does not trust the app.** Durations are clamped server-side, the policy can
  disable locking, and the policy file lives in `/etc` where the app cannot write. The one
  exception is deliberate: `set-policy` lets a group member *create* the file when none exists
  (write once, logged with uid/pid); an existing file is never changed by anything but root, or
  by a code on a locked machine. Nothing the app sends can read your input; the daemon drains
  grabbed events and only looks for the emergency key.
- **A locked policy is layered, not absolute, and says so.** The gate, the self-heal, the spare
  copies, the immutable attribute, the guard's denials, the drop-in and the app's cached copy each
  close one route; `seal-status` returns what they do not close, and Settings → System shows it.
  Nothing about locking a policy resists a root shell the session guard is not confining, or a
  machine booted from other media.
- **In chain mode the machine holds no secret at all.** It pins a public key and a hash. That is
  the whole security argument for a fleet: there is nothing on the machine to read, bribe out of a
  user, or recover from a stolen disk that would let anyone produce a policy it accepts. The
  private key's safety is now the administrator's problem, which is where it can actually be
  managed.
- **A chain is trusted through its signatures, not its address.** HTTPS decides who you are
  talking to; the signatures decide whether the machine believes the answer. Each version commits
  to the one before it, so a machine at version *n* has verified a signature over every version
  that got it there, and an old one cannot be re-served. The app does the fetching and can forge
  none of it.
- **A pinned pack is code a character runs on this machine.** Sign every one. A bare `sha256` is
  only as trustworthy as the policy that carries it, and on a managed machine that policy came
  over the network. Packs still run inside the usual sandbox and the usual permission intersection
  — pinning a pack does not grant it anything.
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
  `rpchatd virtual input` device.
- **Without the daemon** there is no input locking or injection at all: `sdk.input` calls fail
  with `CAPABILITY_FAILED` until the system integration is installed and connected.
- **Updates are verified, extracted as the user and installed as root.** `apply-update` only
  accepts a file the requesting user owns under their home, hashes exactly the bytes it later
  extracts (SHA-512 from the release manifest; release signing is not implemented yet, so the
  manifest fetched over HTTPS with the user's token is the root of trust), unpacks it with that
  user's privileges, refuses trees with setuid bits, hard links or escaping symlinks, and only
  then takes ownership. A member of `rpchat` can therefore install any *genuine release* into
  `/opt/rpchat` — including an older one when the policy allows downgrades — but never
  arbitrary files.
- **Relaunching runs the user's own program as the user.** A registration is only accepted from
  a non-root uid, for an existing executable, with at most 32 arguments and a fixed whitelist of
  environment variables (values ≤ 4 KiB); the daemon adds nothing of its own, drops root before
  `exec` and only relaunches for users listed in `app.users` who own the active session. Root can
  always stop it (`systemctl stop rpchatd`).
