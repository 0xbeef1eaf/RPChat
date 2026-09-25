# `/etc/rpchat/policy.json` reference

The policy file is owned by root (`root:root 0644`) and read by two parties:

- **`rpchatd`** (the root daemon) reads `inputLock` and enforces it regardless of what the app
  asks for. It re-reads the file whenever its mtime or size changes, so edits apply to the next
  `lock` without a restart.
- **The desktop app** reads `settings` and forces those values over the user's own settings;
  the affected controls show a "managed by policy" badge and cannot be changed from the UI.

`policy.example.json` next to this file contains every field; its `sha256` and `signature` are
all-zero placeholders, so replace them with real ones (`rp-policy-chain.mjs pack`) before using
the pack entry. Delete the keys you do not want to
manage — anything absent keeps the user's own setting / the daemon default. The file must be
strict JSON (no comments, no trailing commas) and at most 256 KiB. **Unknown top-level or
`inputLock` keys make the whole file invalid**, and an invalid or unreadable file makes the
daemon refuse `lock` (`code: "POLICY"`) until it is fixed — it never falls back to defaults
silently once a file exists. `rpchatd --check-devices` does not validate the policy; check
with `python3 -m json.tool /etc/rpchat/policy.json` or by watching `journalctl -u rpchatd`.

## Creating the file without root (write once)

The file is normally written by root (`sudo`, or `install.sh --policy-template`). When it does
not exist yet, **any member of the `rpchat` group can create it once** through the daemon
(Settings → System → *Create policy…*, or the `set-policy` request): the daemon validates the
object exactly like the file, creates `/etc/rpchat` if needed and writes `policy.json` as
`root:root 0644`. After that the daemon refuses further `set-policy` requests (`code: "EXISTS"`)
and **only root can edit or delete the file** — there is no undo from the app. Because the
first person in the group to do it sets the policy for every user of the machine, this is meant
for whoever set the machine up; the values in `settings` override everyone's own settings.

## Locking the policy (the seal)

Write-once-then-root's is the right shape for a machine you own and the wrong one for a machine
you manage for somebody else: you cannot change your mind, and the person sitting at it can undo
everything with one `sudo rm`. **Sealing** replaces that with a lock. A seal is in exactly one of
two mutually exclusive modes — a machine with both would be only as strong as the weaker one.

### `totp` — a code opens it

Settings → System → *Lock policy* (or the `seal-policy` request) makes the daemon generate a TOTP
secret, pin the current policy to it, and answer **once** with the secret and an `otpauth://` URI.
The app renders that URI as a QR code to scan, with the secret and the URI behind a *Can't scan
it?* disclosure. Nothing shows either again: the secret exists in `/etc/rpchat/policy.seal`,
`0600 root:root`, and nowhere else. Afterwards:

- `set-policy` **replaces** the policy when it carries a valid `code`, and re-pins the seal to
  what was written. Without one, or with a wrong one, the answer is `code: "CODE"`.
- `unseal-policy` removes the lock with a code, optionally taking the policy file with it.
  `rpchatd --unseal <code>` does the same from a root terminal — being root is not enough.
- Three wrong codes are free; after that the lock refuses everything for 30 s, doubling per
  failure to 15 minutes. A code is spent once it is used, so watching someone type one is
  worthless.

This is the mode for a machine you will stand in front of.

### `chain` — only a signature opens it

Pasting a **Remote Link** whose `mode` is `chain` (the default) seals the machine differently:
**no secret is generated, because there is nothing for one to authorise.** The seal holds an
Ed25519 *public* key and the hash of the last policy link it applied, and the only thing that can
change the policy is a new link, signed by that key, continuing that chain. Letting the machine go
is also a link — one with `unseal: true` — so even release is an act the key authorises. There is
no code to type, no code to steal, and nothing on the machine that could mint one; `set-policy`
and `unseal-policy` are refused outright with `code: "CODE"` and a message saying so.

This is the mode for a fleet. It is also the answer to "can TOTP be asymmetric": it cannot —
RFC 6238 is HMAC over a time counter, so anything that can check a code can generate one — but
the *lock* can be, and this is it.

### What holds it shut

Sealing is layered rather than absolute, and the app says so — `seal-status` returns a
`residual` list that Settings → System shows under *What the lock cannot do*. The layers:

1. **The policy that counts is not the file.** The daemon publishes the sealed policy into
   `/run/rpchat/policy`, a tmpfs it mounts itself and remounts read-only after each write
   (`0750 root:rpchat`, the policy `0640`), and the app reads it from there. Editing
   `/etc/rpchat/policy.json` therefore changes nothing until the daemon agrees.
2. **Self-heal.** Every few seconds the daemon compares the file against the sealed copy. An
   edited or deleted policy is rewritten and the attempt is pushed to the app as a
   `policy-tamper` event, which Settings → System keeps in a tamper log (`lock.selfHeal`).
3. **Mirrors.** The seal is kept in `/etc/rpchat`, `/var/lib/rpchat` and
   `/usr/local/libexec/rpchat`. Removing one copy restores it from the next.
4. **Immutability.** `lock.immutable` sets the ext2/4 immutable attribute on the policy, the
   seal and its mirrors, so a plain `rm` or editor save fails until someone runs `chattr -i`.
5. **The session guard.** With `guard.mode: "enforce"`, a policy that has a `lock` block also
   denies the confined sessions everything under `/etc/rpchat`, `/var/lib/rpchat`,
   `/run/rpchat` and the unit files — read as well as write, because in `totp` mode reading the
   secret is as good as owning the lock — and, with `lock.denyEscapes`, the binaries that would
   leave the confinement behind or undo it: `run0`, `machinectl`, `pkexec`, `chattr`,
   `apparmor_parser`, `aa-teardown`. **`sudo` is deliberately still there**: a `sudo` child is a
   child, so it stays inside the profile and gains nothing. `run0` is the one that matters,
   because it asks PID 1 to start the shell and it is born outside. **`systemd-run` is confined
   rather than denied**, in `rpchat-systemd-run`: only its system-manager half is an escape, and
   `--user`/`--scope` is how a systemd-managed desktop starts its own shell.
6. **`RefuseManualStop`.** `lock.refuseManualStop` writes
   `/etc/systemd/system/rpchatd.service.d/50-rpchat-sealed.conf` with `RefuseManualStop=yes`
   and `Restart=always`, so `systemctl stop rpchatd` is declined and a killed daemon comes back.
7. **The app fails closed.** The app keeps its own copy of a sealed policy in its user data.
   Once it has seen a seal it keeps enforcing it even if `/etc/rpchat` and the daemon are both
   gone, and reports that as tampering (Settings → System) rather than as freedom. It drops
   that copy only when a *connected* daemon reports an unsealed machine — which cannot happen
   without a code.

### What it does not do

- In `totp` mode, a root shell the session guard does **not** confine can read `policy.seal` and
  generate its own codes. The guard in `enforce` with `denyEscapes` is what closes that; without
  it, sealing raises the bar rather than setting one. **In `chain` mode there is nothing to
  read**: the seal holds only a public key and a hash, so the same shell can stop the daemon and
  delete what it protects, but it cannot produce a policy the machine would accept.
- Booting the machine from other media bypasses the daemon entirely. Only full-disk encryption
  with a firmware password answers that.
- The app's cached copy lives in the user's own data directory, so the user can delete it too.
  It is the difference between "unlocking needs the code" and "unlocking needs one command from
  a forum", not a boundary of its own.

Keep the secret — or the private key — somewhere safe. Without it, and without root on a machine
where the guard is not enforcing, the only way back is reinstalling.

## Remote Link and the policy chain

A machine follows a chain by being given a **Remote Link**: a base64 blob carrying the address of
the chain, the Ed25519 public key that signs it, and the mode the machine gets. Paste it into
Settings → System → *Remote Link*, or send `set-remote-link`. The first one is free; replacing it
is a change of trust root, so a `totp` machine asks for its code and a `chain` machine refuses —
only its own chain can move it. The blob is signed by the key it carries, so one mangled by a chat
app or swapped in transit is refused rather than trusted for arriving in the right box.

The **app** fetches the chain — it has the network stack, the proxy configuration and the user's
session — and hands the bytes to the daemon, which decides whether to believe them. The daemon
therefore needs no TLS stack of its own and holds no private key of any kind; a patched app cannot
loosen a machine, because it has nothing to sign with.

A chain file is a list of links:

```jsonc
{
  "version": 1,
  "links": [
    { "seq": 1, "prev": "",          "issuedAt": "…", "policy": { … }, "signature": { "alg": "ed25519", "value": "…" } },
    { "seq": 2, "prev": "<sha256 of link 1>",         "policy": { … }, "signature": { … } }
  ]
}
```

- **`prev`** is the SHA-256 of the previous link's canonical bytes. A machine finds its own head
  in the file, verifies every link after it, and applies the last. It does not need to have seen
  the intermediate ones: a machine that was off for a month walks the tail, checking each
  signature. Links before its head are not re-verified — the head hash already commits to them.
- **Replay and reordering are impossible.** An old link's `prev` no longer matches what the
  machine holds, and two links claiming the same position have different hashes, so only one can
  continue the chain the machine is on.
- **`nextKey`** rotates the signing key. The rotation is signed by the key it *replaces*, which is
  what keeps the chain verifiable end to end — a stolen key cannot introduce itself. Every
  rotation is logged and shown in Settings → System.
- **`unseal: true`** releases every machine that takes the link: the seal is lifted, the policy the
  chain last set stays in place, and the machine is an ordinary one again.
- **`policy` may be omitted** — a link that only rotates the key or unseals leaves the policy alone.

Signing is Ed25519 over `rpchat-chain/v1\n` followed by the link's canonical bytes: the link
without its `signature`, as compact JSON with object keys sorted. That is what `serde_json` writes
for a value and what `JSON.stringify` writes over recursively sorted entries, so both ends agree
without either implementing a canonicalisation spec.

Three implementations produce it and are pinned to one shared test vector: the daemon
(`chain.rs`, verifying), the app (Settings → System → *Publish a chain*), and
`scripts/rp-policy-chain.mjs`, which does the same from a terminal and doubles as the
specification for a management system written in something else.

```bash
node scripts/rp-policy-chain.mjs keygen --out key.pem
node scripts/rp-policy-chain.mjs link --key key.pem --url https://policies.example.com/chain.json \
     --managed-by "Acme IT" --mode chain           # the blob to hand out
node scripts/rp-policy-chain.mjs sign --key key.pem --chain chain.json --policy policy.json
node scripts/rp-policy-chain.mjs sign --key key.pem --chain chain.json --unseal   # let them go
```

Serve `chain.json` at the address in the link, including at least every link from your oldest
machine's position onwards. A machine that cannot find its head in the file says so rather than
guessing, and an administrator serves a longer window.

## Packs the policy pins

```jsonc
"packs": {
  "sources": [
    { "id": "luna", "url": "https://example.com/luna.rppack", "signature": "…", "version": "1.2.0" }
  ],
  "removeUnlisted": false,
  "refreshMinutes": 360
}
```

A pack is pinned by a **signature**, not a checksum. A checksum says only "these are the bytes the
policy named" — and on a managed machine the policy itself arrived over the network, so whoever
can change the policy can change the checksum with it. The signature is the administrator's key
vouching for the pack, which is a claim the machine can check against a key it already trusts. It
covers the id, the version and the SHA-256 of the file **together**
(`rpchat-pack/v1\n<id>\n<version>\n<sha256>`), so a signed pack cannot be re-labelled as a
different one. Produce it with:

```bash
node scripts/rp-policy-chain.mjs pack --key key.pem --id luna --version 1.2.0 --file luna.rppack
```

On a machine with a Remote Link a signature is **required** and an unsigned entry is refused. On
one with no link there is no key to check against, and `sha256` is used instead — the only
integrity signal available, and enough, because a machine with no link already trusts its local
policy.

The app downloads and hashes; the daemon verifies (`verify-pack`), which keeps hundreds of
megabytes off the socket while leaving the decision with the side that holds the key. An archive
whose `id` or version turns out not to be the pinned one is refused rather than installed under
the wrong name. With a `version`, an installed pack of another version is replaced; without one,
an installed pack of that id is left alone (re-downloading hundreds of megabytes on every tick to
learn nothing would be worse). `removeUnlisted: true` uninstalls everything the list does not
name. This half works from a local policy too — no Remote Link needed, with `sha256` doing the
work.

Pinned packs are installed even where `app.allowPackInstall` is `false`: that restriction is
about the person at the machine, not about the policy.

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
| `remote` | object | Where the policy chain is fetched from, see *Remote Link and the policy chain*. |
| `packs` | object | The packs this machine is meant to have, see *Packs the policy pins*. |
| `lock` | object | How hard the policy holds once the machine is sealed, see *Locking the policy behind a code*. |

## `settings` — forced app settings

Only these keys are accepted; each maps to a dotted settings path shown in the UI. Any number
that caps something (every `max*` below, and the memory budgets) also takes `-1` for "unlimited";
on a floor (`minRepeatIntervalMs`, `minDelayMs`) `-1` means no floor.

| Key | Type | Effect |
|---|---|---|
| `maxInputLockMs` | number ≥ 1000, or `-1` | Hard cap the app applies to `sdk.input.lock` requests (the daemon applies `inputLock.maxDurationMs` on top; the lower wins). |
| `autonomy` | object | Any of `maxSelfWakesPerHour`, `maxConsecutiveSelfWakes`, `maxTimersPerSession`, `minRepeatIntervalMs`, `minDelayMs` (numbers, `-1` = unlimited). Limits how much a character may act without the user. |
| `permissions` | `{ "moduleAllow": { "<module>": boolean } }` | Global allow/deny per SDK module (`input`, `desktop`, `web`, …). `false` makes the module unavailable to every pack. |
| `web` | `{ "allowlist": string[] }` | Hostname patterns (`example.com`, `*.example.com`) `sdk.web` may fetch. Empty = any host. |
| `desktop` | `{ "launchAllowlist": string[] }` | Executables `sdk.desktop.launch` may start. Empty = any. |
| `memory` | object | Any field of the app's memory settings. `maxEntriesPerCharacter` and `promptBudgetTokens` take `-1` for no limit. |
| `senses` | object | `includeInPrompt` (boolean), `watchDirs` (string[]), `calendarSources` (string[]). |
| `displayBackend` | `"auto"` \| `"electron"` \| `"hyprland"` | Which overlay backend the app uses. |
| `updates` | `{ "automatic": boolean, "enabled": boolean, "allowDowngrade": boolean }` | In-place app updates. `enabled: false` switches update checks off entirely (the Updates tab shows "disabled by policy" and hides the token field); `automatic` pins the "check automatically" toggle. `allowDowngrade: true` lets the daemon's `apply-update` (system install) install a version older than the current one; by default such requests are refused. All optional. |
| `browser` | `{ "allowBlocking": boolean, "allowEval": boolean, "allowHistory": boolean }` | What characters may do through the browser extension: block pages for a while, run JavaScript in pages, read the browser history. All optional. The home page the extension opens in new tabs is not here — only a character sets it, with `sdk.browser.setHomePage`. |
| `media` | `{ "maxConcurrent": { "image": n, "video": n, "audio": n }, "maxQueued": { … } }` | How much of `sdk.media` may run at once, counted per kind. `maxConcurrent` is the cap (`0` or `-1` = no cap, the default); `maxQueued` is how many further calls may wait behind it (`0` refuses an over-cap call instead of queueing it, `-1` lets any number wait). A queued call is not blocked or failed: it returns a handle straight away and opens by itself when one of its kind closes. Every number is optional and pinned on its own. |

The daemon only validates that these are objects/numbers/strings of the right kind; the app
validates the inner values against its settings schema and ignores what it cannot apply.

## `inputLock` — daemon-enforced limits

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` refuses every `lock` request with `code: "POLICY"`. Injection (`type`/`key`/`click`/`move`) is unaffected. |
| `maxDurationMs` | number | `300000` (5 min) | Longest single lock. Requests above are clamped, not refused; the response's `durationMs` says what was applied. Values below 1000 are raised to 1000; `-1` means unlimited (held to a hundred years so the deadline fits a clock). |
| `emergencyKey` | `"esc"` \| `"f1"` \| `"f12"` \| `"pause"` | `"esc"` | Key that ends a lock when held down. |
| `emergencyHoldMs` | number | `5000` | How long the key must be held (clamped to 500 … 60000). |

Notes:

- A lock is renewed by another `lock` request (the deadline moves), so `maxDurationMs` bounds
  one request, not a whole session. Combine with `settings.autonomy` and `settings.maxInputLockMs`
  if you want to bound the total.
- The emergency chord is read from the grabbed keyboards. A `devices: "mouse"` lock leaves the
  keyboard free, so the chord is not needed (and not available) there.
- The daemon logs every lock with the requesting uid/pid to the journal
  (`journalctl -u rpchatd`).

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
relaunches in 10 minutes (`journalctl -u rpchatd` says so); five minutes of uptime reset the
counters. If another user becomes the active session in the meantime the relaunch is dropped;
the app comes back through the user's autostart at their next login. `systemctl stop rpchatd`
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
| `allowStopGeneration` | boolean | `true` | `false` makes a reply finish once it has started: *Stop* in the composer is greyed out and `chat.abort` is refused. Retrying, resetting the session and deleting a message or the history are refused too **while a reply is running** — each of those aborts it first — and work as usual the rest of the time. |
| `allowDeleteSession` | boolean | `true` | `false` removes *Delete session* from the session panel and refuses `sessions.remove`. |
| `allowDeleteHistory` | boolean | `true` | `false` removes *Clear history* and the per-message delete, and refuses `sessions.clearMessages` / `sessions.removeMessage`. |
| `allowResetState` | boolean | `true` | `false` removes *Reset session state* from the session panel and refuses `sessions.resetState`, so a conversation cannot be started over from its runtime side — its `sdk.state.session.*` scratch values, timers, event subscriptions, history summary and status line stay. A reset never reached further than that: the messages, the character's own `sdk.state.*` and its memories persist across one anyway. |
| `allowDeleteMemories` | boolean | `true` | `false` removes *Forget* from the memories panel and refuses `memories.remove`. Adding and editing memories still work. |
| `allowRemoveEvents` | boolean | `true` | `false` removes *Remove* from the events drawer and refuses `events.remove`, so a character's `sdk.events.on` subscriptions cannot be unsubscribed by hand. |
| `allowCloseMedia` | boolean | `true` | `false` removes *Close media* from the chat header and refuses `media.closeAll`, so a character's overlays cannot be swept off the screen by hand. The character's own `sdk.media.close` / `sdk.media.closeAll` are unaffected — this is only the by-hand button. |
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
    "allowStopGeneration": false,
    "allowDeleteSession": false,
    "allowDeleteHistory": false,
    "allowResetState": false,
    "allowDeleteMemories": false,
    "allowRemoveEvents": false,
    "allowCloseMedia": false,
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
startup and only from `/etc/rpchat/policy.json`** — never through `RP_POLICY_FILE`, which is one
of the switches being taken away. A policy file that exists but cannot be read or does not parse
locks the switches too, rather than falling back to "allowed". Because it is read once, changing
`dev` takes effect at the app's next start, not within the minute like the rest of this file.
Settings → System shows what the running app started with, under *Development*.

What it is not: a boundary against someone who can replace the app itself or run its code in
another Electron binary (`ELECTRON_RUN_AS_NODE` set on a *different* executable, for instance).
A system install under `/opt/rpchat` with the session guard is what makes the binary itself hard
to swap; this keeps a normal user from launching the app you installed in a mode that ignores the
rest of the policy.

```json
{ "version": 1, "dev": { "allow": false, "devTools": false } }
```

## Templates

- `policy.example.json` — every key with its default: nothing changes until you edit it.
- `policy.all-on.json` — the "everything on" policy: the app cannot be quit and is relaunched
  for the listed user, the development switches and DevTools are off, the session guard runs in
  **enforce** mode, and the `lock` block is ready for sealing. Replace `alice` with your user
  name. For a first run set `"guard": { "mode": "audit" }`, log in, read the audit log under
  Settings → System, then switch to `enforce` — and only then seal it, because the guard's
  denials are most of what makes the lock hold.

## `guard` — the session guard (AppArmor)

Confines the login sessions of the users in `app.users` so that their own terminals, keybind
scripts and pickers cannot undo what the character did: connecting to the compositor's and the
desktop shell's IPC sockets, writing the wallpaper/shell config and state files, and signalling
or tracing rpchat are logged (`audit`) or refused (`enforce`). rpchat itself (launched from
`/opt/rpchat/current/rpchat`) runs in its own profile that allows all of it. Needs the AppArmor
LSM (`/sys/kernel/security/apparmor`), `apparmor_parser` and the `pam_apparmor` line
`install.sh --guard` adds; `mode` other than `off` requires a non-empty `app.users`. Details,
verified AppArmor facts and the recovery steps: `docs/system-integration.md` "Session guard".

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"off"` \| `"audit"` \| `"enforce"` | `"off"` | `audit` loads the profiles in complain mode with audit rules: nothing is blocked, every attempt is logged and reported to the app as a `guard-attempt` event. `enforce` blocks. `off` unloads the profiles. |
| `protectApp` | boolean | `true` | Signals (`kill`, `pkill`) and `ptrace` from the session to rpchat are guarded. |
| `wallpaper` | boolean | `true` | The shell's IPC socket and its config/state files are guarded; the shell itself runs in `rpchat-shell` (may serve its socket, may not connect to it). |
| `compositorIpc` | `"allow"` \| `"shell-only"` \| `"deny"` | `"shell-only"` | Who may reach the compositor's control socket (Hyprland `.socket.sock`/`.socket2.sock`, sway, niri): everyone, only the shell and rpchat, or only rpchat. Anything but `allow` runs the compositor in `rpchat-compositor` so its keybind/exec children return to the session confinement. |
| `ipcGuard` | `"auto"` \| `"off"` | `"auto"` | Mediate `connect()` to the shell's sockets with a **BPF LSM program** where the kernel allows it (`lsm=…,bpf` on the kernel command line, `CONFIG_BPF_LSM=y`, BTF at `/sys/kernel/btf/vmlinux`). AppArmor cannot make that check on a mainstream kernel — it has only the coarse `af_unix` class — so without this `wallpaper` covers `open()` and the config files but not `connect()`, and `<shell> msg` from a terminal still reaches the daemon. `auto` uses it where it works and reports `ipcMediation: "none"` where it does not; `off` never loads it. There is no `require`: refusing to engage the guard at all on an unsupported kernel would turn a kernel update into an unconfined desktop. `guard-status` reports which mechanism is live. |
| `shell` | one of `"auto"`, `"noctalia"`, `"quickshell"`, `"hyprpaper"`, `"swww"`, `"none"` — **or a non-empty list of them** | `"auto"` | Which shell table rows apply. `auto` takes **every** row whose binary exists. Name several (`["noctalia","hyprpaper"]`) when a bar and a separate wallpaper daemon are both running: they share one `rpchat-shell` profile where each may *serve* its own socket but none may *connect* to any of them, so neither can drive the other — a bar cannot set the wallpaper through a wallpaper daemon. Guarding a socket nobody serves costs nothing, so listing extra rows is safe. |
| `loginHelpers` | non-empty string[] | auto-detect | The PAM login helpers whose profile carries the per-user hats (`/usr/lib/sddm/sddm-helper`, `greetd`, `/usr/bin/login`, `sshd` — those present on the box). |
| `extraDenyPaths` | string[] | `[]` | More files the session may not write (absolute, `~/…` or `@{HOME}/…` globs). |
| `extraDenySockets` | string[] | `[]` | More unix socket paths the session may not connect to. |
| `allowBinaries` | string[] | `[]` | Absolute paths that leave the confinement entirely when executed (`ux`); use sparingly. |

Recovery as root: `guard.mode: "off"` (picked up within seconds, or `rpchatd --guard-apply`),
`rpchatd --guard-off`, or `apparmor_parser -R /etc/apparmor.d/rpchat-*`. The last one leaves the
BPF program attached — it is pinned, deliberately, so `kill -9 rpchatd` does not drop it — so
remove `/sys/fs/bpf/rpchat/` as well, or use one of the first two, which unpin it. `install.sh --no-guard`
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

A machine somebody else manages: the policy comes from a chain, two packs are pinned, anything
else is removed. Publish this as link 1 and hand out the Remote Link; nobody types anything into
the machine except that blob.

```json
{
  "version": 1,
  "managedBy": "Acme IT",
  "app": { "allowQuit": false, "users": ["alice"] },
  "guard": { "mode": "enforce" },
  "remote": { "url": "https://policies.example.com/chain.json", "intervalMinutes": 60 },
  "packs": {
    "sources": [
      { "id": "luna", "url": "https://packs.example.com/luna-1.2.0.rppack", "signature": "…", "version": "1.2.0" },
      { "id": "onboarding", "url": "https://packs.example.com/onboarding.rppack", "signature": "…" }
    ],
    "removeUnlisted": true
  },
  "lock": {}
}
```

Install one pack and leave everything else alone (no Remote Link, so the checksum does the work):

```json
{ "version": 1, "packs": { "sources": [{ "id": "luna", "url": "https://packs.example.com/luna.rppack", "sha256": "…" }] } }
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
