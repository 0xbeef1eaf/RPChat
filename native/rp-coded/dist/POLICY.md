# `/etc/rp-code/policy.json` reference

The policy file is owned by root (`root:root 0644`) and read by two parties:

- **`rp-coded`** (the root daemon) reads `inputLock` and enforces it regardless of what the app
  asks for. It re-reads the file whenever its mtime or size changes, so edits apply to the next
  `lock` without a restart.
- **The desktop app** reads `settings` and forces those values over the user's own settings;
  the affected controls show a "managed by policy" badge and cannot be changed from the UI.

`policy.example.json` next to this file contains every field. Delete the keys you do not want to
manage — anything absent keeps the user's own setting / the daemon default. The file must be
strict JSON (no comments, no trailing commas) and at most 256 KiB. **Unknown top-level or
`inputLock` keys make the whole file invalid**, and an invalid or unreadable file makes the
daemon refuse `lock` (`code: "POLICY"`) until it is fixed — it never falls back to defaults
silently once a file exists. `rp-coded --check-devices` does not validate the policy; check
with `python3 -m json.tool /etc/rp-code/policy.json` or by watching `journalctl -u rp-coded`.

## Creating the file without root (write once)

The file is normally written by root (`sudo`, or `install.sh --policy-template`). When it does
not exist yet, **any member of the `rp-code` group can create it once** through the daemon
(Settings → System → *Create policy…*, or the `set-policy` request): the daemon validates the
object exactly like the file, creates `/etc/rp-code` if needed and writes `policy.json` as
`root:root 0644`. After that the daemon refuses further `set-policy` requests (`code: "EXISTS"`)
and **only root can edit or delete the file** — there is no undo from the app. Because the
first person in the group to do it sets the policy for every user of the machine, this is meant
for whoever set the machine up; the values in `settings` override everyone's own settings.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Required. Only version 1 exists. |
| `managedBy` | string (≤ 500 chars) | Free text shown in Settings → System ("Managed by …"). |
| `settings` | object | Forced app settings, see below. |
| `inputLock` | object | Daemon-enforced lock limits, see below. |
| `app` | object | How the app itself may behave: `allowQuit`/`users` keep it running, and the `allow*`/`require*` keys take operations away from it. See below. |
| `guard` | object | The session guard: AppArmor confinement of the `app.users` login sessions, see below. |
| `dev` | object | Whether the app honours its own development switches, see below. |

## `settings` — forced app settings

Only these keys are accepted; each maps to a dotted settings path shown in the UI.

| Key | Type | Effect |
|---|---|---|
| `maxInputLockMs` | number ≥ 0 | Hard cap the app applies to `sdk.input.lock` requests (the daemon applies `inputLock.maxDurationMs` on top; the lower wins). |
| `autonomy` | object | Any of `maxSelfWakesPerHour`, `maxConsecutiveSelfWakes`, `maxTimersPerSession`, `minRepeatIntervalMs`, `minDelayMs` (numbers). Limits how much a character may act without the user. |
| `permissions` | `{ "moduleAllow": { "<module>": boolean } }` | Global allow/deny per SDK module (`input`, `desktop`, `web`, …). `false` makes the module unavailable to every pack. |
| `web` | `{ "allowlist": string[] }` | Hostname patterns (`example.com`, `*.example.com`) `sdk.web` may fetch. Empty = any host. |
| `desktop` | `{ "launchAllowlist": string[] }` | Executables `sdk.desktop.launch` may start. Empty = any. |
| `memory` | object | Any field of the app's memory settings. |
| `senses` | object | `includeInPrompt` (boolean), `watchDirs` (string[]), `calendarSources` (string[]). |
| `displayBackend` | `"auto"` \| `"electron"` \| `"hyprland"` | Which overlay backend the app uses. |
| `updates` | `{ "automatic": boolean, "enabled": boolean, "allowDowngrade": boolean }` | In-place app updates. `enabled: false` switches update checks off entirely (the Updates tab shows "disabled by policy" and hides the token field); `automatic` pins the "check automatically" toggle. `allowDowngrade: true` lets the daemon's `apply-update` (system install) install a version older than the current one; by default such requests are refused. All optional. |
| `browser` | `{ "allowBlocking": boolean, "allowEval": boolean, "allowHistory": boolean, "homePage": string }` | What characters may do through the browser extension: block pages for a while (and for how long at most, ms), run JavaScript in pages, read the browser history, and the home page the extension opens in new tabs (an http(s) URL or `""`). All optional. |

The daemon only validates that these are objects/numbers/strings of the right kind; the app
validates the inner values against its settings schema and ignores what it cannot apply.

## `inputLock` — daemon-enforced limits

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` refuses every `lock` request with `code: "POLICY"`. Injection (`type`/`key`/`click`/`move`) is unaffected. |
| `maxDurationMs` | number | `300000` (5 min) | Longest single lock. Requests above are clamped, not refused; the response's `durationMs` says what was applied. Values below 1000 are raised to 1000. |
| `emergencyKey` | `"esc"` \| `"f1"` \| `"f12"` \| `"pause"` | `"esc"` | Key that ends a lock when held down. |
| `emergencyHoldMs` | number | `5000` | How long the key must be held (clamped to 500 … 60000). |

Notes:

- A lock is renewed by another `lock` request (the deadline moves), so `maxDurationMs` bounds
  one request, not a whole session. Combine with `settings.autonomy` and `settings.maxInputLockMs`
  if you want to bound the total.
- The emergency chord is read from the grabbed keyboards. A `devices: "mouse"` lock leaves the
  keyboard free, so the chord is not needed (and not available) there.
- The daemon logs every lock with the requesting uid/pid to the journal
  (`journalctl -u rp-coded`).

## `app` — keeping the app running

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowQuit` | boolean | `true` | `false` removes every way to quit from the app (no *Quit* in the tray, closing the window only hides it, Ctrl+Q and SIGTERM/SIGINT/SIGHUP are ignored) and makes the daemon **relaunch** the app when its process dies anyway (`kill -9`, a crash) — for the users below only. Update restarts still work. |
| `users` | non-empty array of unix user names | none | Who the daemon relaunches the app for. The relaunch also requires that this user currently owns the **active graphical session** (logind: an active `wayland`/`x11` session on a seat). Without this list nothing is relaunched, even with `allowQuit: false` (logged once). Not a settings key: it is shown in Settings → System, not as a managed setting. |

How the relaunch works: the running app registers with the daemon on a long-lived connection
(`register`: executable, arguments, working directory and a whitelist of session variables such
as `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `HOME`). When
that connection drops without an `unregister` — the app was killed or crashed — the daemon
re-reads the policy, checks the user list and the active session, waits 1.5 s, confirms the
process is really gone and starts it again as that user (never as root) with exactly the
registered environment. Crash loops back off (1.5 s → 3 → 6 → 12 → 30 s) and stop after 10
relaunches in 10 minutes (`journalctl -u rp-coded` says so); five minutes of uptime reset the
counters. If another user becomes the active session in the meantime the relaunch is dropped;
the app comes back through the user's autostart at their next login. `systemctl stop rp-coded`
switches the guard off entirely, and `kill` from a root shell followed by removing the policy
line lets the app be quit normally again (the app re-reads the file within a minute).

## `app` — restrictions the app enforces on itself

The keys above keep the app *running*; these take operations *away* from it. Every `allow*`
defaults to `true` and `requireCharacterSession` to `false`, so a policy that omits them behaves
exactly as before. Unlike `guard` (which the daemon enforces with AppArmor around the session),
these are refused by the app itself on its IPC boundary — so the UI hides the control **and** the
operation is refused whoever asks: a devtools console or a character's own script included.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowPackEditor` | boolean | `true` | `false` closes the pack editor: the *Pack editor* entry disappears and the whole `editor:*` IPC namespace is refused. |
| `allowPackRemove` | boolean | `true` | `false` removes *Uninstall* from every pack card and refuses `packs.uninstall`. |
| `allowPackInstall` | boolean | `true` | `false` freezes the installed packs on disk: no pack can be added, replaced or rewritten. Refuses `packs.install` and the editor's *Install to app*. The editor itself still opens (unless `allowPackEditor` is false) and can still export a `.rppack`. |
| `allowDeleteSession` | boolean | `true` | `false` removes *Delete session* from the session panel and refuses `sessions.remove`. |
| `allowDeleteHistory` | boolean | `true` | `false` removes *Clear history* and the per-message delete, and refuses `sessions.clearMessages` / `sessions.removeMessage`. |
| `allowDeleteMemories` | boolean | `true` | `false` removes *Forget* from the memories panel and refuses `memories.remove`. Adding and editing memories still work. |
| `allowRemoveEvents` | boolean | `true` | `false` removes *Remove* from the events drawer and refuses `events.remove`, so a character's `sdk.events.on` subscriptions cannot be unsubscribed by hand. |
| `allowSandbox` | boolean | `true` | `false` closes the Sandbox tab: the entry disappears and `sandbox.run` / `sandbox.cancel` are refused. Characters' own scripts are unaffected — this is only the by-hand runner. |
| `requireCharacterSession` | boolean | `false` | `true` keeps the app inside a conversation: it opens straight into the most recent session (starting one with the first installed character when there is none) instead of an empty chat, and the **last** remaining session cannot be deleted even when `allowDeleteSession` is true. |

Settings → System lists whichever of these are in force, next to the forced settings. They are
not settings keys, so they never appear in `settings` and are not shown as managed settings.

A kiosk-style example — a machine where a character is always there to talk to and nothing about
it can be taken apart:

```json
{
  "version": 1,
  "managedBy": "family PC",
  "app": {
    "allowQuit": false,
    "users": ["alice"],
    "allowPackEditor": false,
    "allowPackRemove": false,
    "allowPackInstall": false,
    "allowDeleteSession": false,
    "allowDeleteHistory": false,
    "allowDeleteMemories": false,
    "allowRemoveEvents": false,
    "allowSandbox": false,
    "requireCharacterSession": true
  }
}
```

## `dev` — the development switches

The app carries a handful of switches for its own development: environment variables that swap the
model for a scripted one, drive turns by themselves, install an example pack or plugin, point the
app at another user-data directory, policy file, daemon socket or overlay helper binary, or load
the interface itself from a dev server — plus DevTools and the debugger flags. On a developer's
machine they are conveniences. On a machine you manage they are the way around everything else in
this file, so `dev.allow: false` takes them away.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allow` | boolean | `true` | `false` makes the app ignore every `RP_*` environment variable, `ELECTRON_RENDERER_URL`, `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` — they are deleted before anything reads them — and **refuse to start** when the command line asks for a debugging channel (`--inspect`, `--remote-debugging-port`, `--js-flags`, …). The log line names what was ignored. |
| `devTools` | boolean | follows `allow` | Whether DevTools may be opened in the app's windows. Set it to `true` next to `allow: false` to keep the inspector for support, or to `false` on its own to close the inspector while the environment switches stay. |

How it is read matters as much as what it says: the app reads this block **synchronously at
startup and only from `/etc/rp-code/policy.json`** — never through `RP_POLICY_FILE`, which is one
of the switches being taken away. A policy file that exists but cannot be read or does not parse
locks the switches too, rather than falling back to "allowed". Because it is read once, changing
`dev` takes effect at the app's next start, not within the minute like the rest of this file.
Settings → System shows what the running app started with, under *Development*.

What it is not: a boundary against someone who can replace the app itself or run its code in
another Electron binary (`ELECTRON_RUN_AS_NODE` set on a *different* executable, for instance).
A system install under `/opt/rp-code` with the session guard is what makes the binary itself hard
to swap; this keeps a normal user from launching the app you installed in a mode that ignores the
rest of the policy.

```json
{ "version": 1, "dev": { "allow": false, "devTools": false } }
```

## Templates

- `policy.example.json` — every key with its default: nothing changes until you edit it.
- `policy.all-on.json` — the "everything on" policy: the app cannot be quit and is relaunched
  for the listed user, the development switches and DevTools are off, and the session guard runs
  in **enforce** mode. Replace `alice` with your user name. For a first run set
  `"guard": { "mode": "audit" }`, log in, read the audit log under Settings → System, then switch
  to `enforce`.

## `guard` — the session guard (AppArmor)

Confines the login sessions of the users in `app.users` so that their own terminals, keybind
scripts and pickers cannot undo what the character did: connecting to the compositor's and the
desktop shell's IPC sockets, writing the wallpaper/shell config and state files, and signalling
or tracing rp-code are logged (`audit`) or refused (`enforce`). rp-code itself (launched from
`/opt/rp-code/current/rp-code`) runs in its own profile that allows all of it. Needs the AppArmor
LSM (`/sys/kernel/security/apparmor`), `apparmor_parser` and the `pam_apparmor` line
`install.sh --guard` adds; `mode` other than `off` requires a non-empty `app.users`. Details,
verified AppArmor facts and the recovery steps: `docs/system-integration.md` "Session guard".

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"off"` \| `"audit"` \| `"enforce"` | `"off"` | `audit` loads the profiles in complain mode with audit rules: nothing is blocked, every attempt is logged and reported to the app as a `guard-attempt` event. `enforce` blocks. `off` unloads the profiles. |
| `protectApp` | boolean | `true` | Signals (`kill`, `pkill`) and `ptrace` from the session to rp-code are guarded. |
| `wallpaper` | boolean | `true` | The shell's IPC socket and its config/state files are guarded; the shell itself runs in `rp-code-shell` (may serve its socket, may not connect to it). |
| `compositorIpc` | `"allow"` \| `"shell-only"` \| `"deny"` | `"shell-only"` | Who may reach the compositor's control socket (Hyprland `.socket.sock`/`.socket2.sock`, sway, niri): everyone, only the shell and rp-code, or only rp-code. Anything but `allow` runs the compositor in `rp-code-compositor` so its keybind/exec children return to the session confinement. |
| `shell` | one of `"auto"`, `"noctalia"`, `"quickshell"`, `"hyprpaper"`, `"swww"`, `"none"` — **or a non-empty list of them** | `"auto"` | Which shell table rows apply. `auto` takes **every** row whose binary exists. Name several (`["noctalia","hyprpaper"]`) when a bar and a separate wallpaper daemon are both running: they share one `rp-code-shell` profile where each may *serve* its own socket but none may *connect* to any of them, so neither can drive the other — a bar cannot set the wallpaper through a wallpaper daemon. Guarding a socket nobody serves costs nothing, so listing extra rows is safe. |
| `loginHelpers` | non-empty string[] | auto-detect | The PAM login helpers whose profile carries the per-user hats (`/usr/lib/sddm/sddm-helper`, `greetd`, `/usr/bin/login`, `sshd` — those present on the box). |
| `extraDenyPaths` | string[] | `[]` | More files the session may not write (absolute, `~/…` or `@{HOME}/…` globs). |
| `extraDenySockets` | string[] | `[]` | More unix socket paths the session may not connect to. |
| `allowBinaries` | string[] | `[]` | Absolute paths that leave the confinement entirely when executed (`ux`); use sparingly. |

Recovery as root: `guard.mode: "off"` (picked up within seconds, or `rp-coded --guard-apply`),
`rp-coded --guard-off`, or `apparmor_parser -R /etc/apparmor.d/rp-code-*`. `install.sh --no-guard`
also removes the PAM line. Sessions already open when the guard engages are confined at their
next login.

## Minimal examples

Guard `alice`'s session in audit mode first (logs only), then switch to `enforce` once the log
shows nothing unexpected:

```json
{ "version": 1, "app": { "allowQuit": false, "users": ["alice"] }, "guard": { "mode": "audit" } }
```


Keep the app running for `alice` (no quit in the UI, relaunched after a kill or crash):

```json
{ "version": 1, "managedBy": "family PC", "app": { "allowQuit": false, "users": ["alice"] } }
```

Disable locking entirely, keep everything else at the user's choice:

```json
{ "version": 1, "inputLock": { "enabled": false } }
```

Keep the app at the version the administrator installed (no update checks, no token field):

```json
{ "version": 1, "settings": { "updates": { "enabled": false } } }
```

Cap locks at 30 s with F12 as the panic key, and forbid the `desktop` module:

```json
{
  "version": 1,
  "managedBy": "shared family PC",
  "settings": { "maxInputLockMs": 30000, "permissions": { "moduleAllow": { "desktop": false } } },
  "inputLock": { "maxDurationMs": 30000, "emergencyKey": "f12", "emergencyHoldMs": 2000 }
}
```
