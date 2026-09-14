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
| `app` | object | How the app itself may behave (`allowQuit`, `users`), see below. |

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

## Minimal examples

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
