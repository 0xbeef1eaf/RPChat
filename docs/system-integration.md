# System integration on Linux: the `rp-coded` daemon

Characters in rp-code can, when a pack has the `input` capability and you approved it, lock
your keyboard and mouse for a short time or type, press keys and click on your behalf. On Linux
those two things need access to `/dev/input/*` (to take the devices away from the compositor)
and `/dev/uinput` (to create a virtual keyboard/mouse). Handing that access to the desktop app
itself would mean any pack — or any bug — could hold your input indefinitely, and any limit you
set in Settings could be changed by the same app that is being limited.

So the privileged part lives in a tiny separate program, **`rp-coded`**, that runs as root under
systemd and does exactly four things:

1. Lock input (grab keyboards/pointers) for at most the time a **root-owned policy file** allows.
2. Release it on a timer, on request, when you hold the **emergency key**, or when it stops.
3. Inject keystrokes, key combos, clicks and pointer moves through one virtual device.
4. Tell the app what the policy says so the Settings UI can show which values are managed.

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

Always pass `--app-bin` with the **`.AppImage` itself**. The `rp-code` binary inside
`squashfs-root` only runs while the whole extraction is around (it loads `libffmpeg.so` and its
resources from next to itself), so a launcher pointing there breaks as soon as the folder is
removed. The installer refuses to auto-pick such a path, and looks for an `rp-code*.AppImage` in
`~/Applications`, `~/.local/bin`, `~/Downloads` and `~` when no `--app-bin` is given.

The `.deb` package runs `install.sh --autostart none` on installation, which does the
system-wide steps (group, daemon, udev rule, policy directory) and leaves group membership and
autostart for you or the Settings button. It does not write a policy file (no
`--policy-template`), so the write-once creation from the app stays available.

Flags: `--user <name>` (default: the user behind `sudo`/`pkexec`), `--app-bin <path>` (the
executable or AppImage the autostart and menu entries should launch), `--autostart xdg|systemd|none`
(default `xdg`), `--menu-entry yes|no` (default `yes`: an application menu entry and icon under
`/usr/local/share`, so an AppImage shows up in launchers; the `.deb` passes `no` because the
package ships its own), `--policy-template` (write the example policy if none exists), `--dry-run`
(print the steps without changing anything), `--uninstall`.

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
| 5 | Application menu entry `/usr/local/share/applications/rp-code.desktop` (`Exec=<app> %U`) and icon `/usr/local/share/icons/hicolor/512x512/apps/rp-code.png`, refreshed with `update-desktop-database`/`gtk-update-icon-cache` when present. Skipped with `--menu-entry no` (the `.deb` does this, it ships its own entry). |
| 6 | Autostart for your user: `~/.config/autostart/rp-code.desktop` (`Exec=<app> --hidden`, XDG) or `~/.config/systemd/user/rp-code.service` (enabled with `systemctl --user` when a session bus is reachable, otherwise it prints the command). Switching methods removes the other entry. It also prints the Hyprland `exec-once = <app> --hidden` line for people who prefer that. |
| 7 | Browser policy, only with `--browser-extension`: `rp-code.json` in `/etc/chromium/policies/managed` and `/etc/opt/chrome/policies/managed` (always) and in the Brave, Edge, Vivaldi and Opera policy directories when that browser looks installed (binary on `PATH` or its `/etc` config directory present). `--dry-run` lists every file it would write. |
| 8 | Runs `rp-coded --check-devices` and prints what the daemon can see. |

The daemon creates `/run/rp-code/` (`0750 root:rp-code`) and the socket
`/run/rp-code/daemon.sock` (`0660 root:rp-code`) when it starts. Logs: `journalctl -u rp-coded`.

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

- `inputLock.enabled: false` refuses every lock request; injection is unaffected.
- A broken policy file (invalid JSON, unknown keys) makes the daemon refuse locks until it is
  fixed — it fails closed rather than falling back to defaults. `journalctl -u rp-coded` names
  the problem.
- No policy file at all means the daemon defaults (5 min max, Esc for 5 s) and no managed
  settings.
- `settings.updates` controls the in-app updater: `{ "enabled": false }` switches update checks
  off on this machine (Settings → Updates shows "disabled by policy" and hides the token field),
  `{ "automatic": false }` only pins the "check automatically" toggle so users still update by hand.

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

## Uninstalling

```sh
sudo native/rp-coded/install.sh --uninstall --user "$USER"
# packaged app: sudo "<resources>/system/install.sh" --uninstall --user "$USER"
```

`install.sh --uninstall` stops and disables the service, removes the unit, the binary
directory, the udev rule, the modules-load entry, your autostart entry, your group membership,
the `rp-code` group and any browser policy files (`rp-code.json`) the installer wrote. It **keeps `/etc/rp-code/policy.json`** and prints how to remove it
(`sudo rm -r /etc/rp-code`). The packaged app ships the script at
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
