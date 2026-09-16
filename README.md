# rp-code

A desktop LLM roleplay chat where characters can **act on your PC by writing
code**. Each character is driven by an LLM that, besides talking, may write
short TypeScript snippets against a documented SDK. The app runs those snippets
in a WebAssembly sandbox and executes the requested actions on the host:
show a picture, play a video or sound, remember something, set a reminder,
notify you, and touch the system, all within the capabilities you leave switched on
under Settings → Permissions (one switch per capability, for every character).

Characters, their behaviours and their media are distributed as shareable
**packs** (`.rppack` files or plain directories).

```
┌─ you ──────────────────────────────────────────────┐
│ "I'm finally done with work"                       │
└────────────────────────────────────────────────────┘
┌─ Luna ─────────────────────────────────────────────┐
│ *grins* Then you've earned this.                   │
│ ▸ action: show a celebratory picture, remind later │
│ Don't forget to actually stand up in 20 minutes.   │
└────────────────────────────────────────────────────┘
```

## Highlights

- **SDK-first**: one TypeScript definition with TSDoc is what the compiler
  checks, what the sandbox exposes and what the model reads. See
  `packages/sdk`.
- **Extensible capabilities**: a capability module bundles typings, docs,
  permission level and host implementation. Add one and the prompt, the
  sandbox proxy and the permission UI pick it up automatically.
- **Sandboxed by construction**: character code runs in QuickJS (wasm) with
  CPU, memory, wall-clock and host-call budgets. It has no ambient access to
  the machine; every host effect is a permission-checked, audited SDK call.
- **Shareable packs**: manifest + one character + persona + media + optional
  behaviour scripts (`onSessionStart`, `onTimer`, ...) + the character's
  function library (`lib/*.ts`).
- **Provider-agnostic**: Anthropic, OpenAI-compatible servers (OpenAI, Ollama,
  LM Studio, OpenRouter, ...).
- **Real overlays on Hyprland**: a native wlr-layer-shell helper renders media
  on the layer you choose (`background`, `bottom`, `top`, `overlay`), on the
  monitor you choose, with opacity and click-through. Other desktops use the
  generic Electron backend; more backends plug into the same interface.
- **Long-term memory**: characters remember facts about you across sessions,
  consolidated automatically and editable in the app.
- **Initiative**: characters can schedule code to run later, wake themselves
  with a self-written prompt, and keep a session moving without you typing,
  within rate limits you control.
- **A function library of their own**: a character can save reusable functions with
  `sdk.lib.define` and call them as `lib.<name>(...)` from any later action, timer
  or event handler. Each function is a file in the pack
  (`characters/<id>/lib/<name>.ts`), so pack authors can ship functions, the
  character's own definitions persist with the installed pack, and the library
  is listed in its prompt. A pack author can keep a function to themselves with a
  `// @internal` first line: the character's other functions and its behaviour
  hooks call it, the character never sees it.
- **External commands**: wallpaper, browser, desktop and voice actions run through
  command templates you edit in Settings. Input locking and injection are
  daemon-only (see *System integration* below).
- **Your browser, driven by characters**: a bundled Manifest V3 extension for
  Chromium-based browsers (Chrome, Chromium, Brave, Edge, Vivaldi, Opera) lets
  `sdk.browser` list tabs, open and read pages, click, type, scroll and take
  screenshots, block pages for a while, restyle or swap a page's pictures, set the
  home page, use bookmarks and history, and run a script in a page (blocking,
  scripting and history each switchable off in Settings → Browser), and raises a
  `browser-navigated` event. It is installed through a
  Chromium enterprise policy the app writes for you (**Settings → Browser**, Linux)
  or loaded unpacked, talks to the app on `127.0.0.1` only, and every extension must
  be allowed once. See [docs/browser-extension.md](docs/browser-extension.md).
- **Questions come to you**: when a character asks something (`sdk.ui.confirm`,
  `choose`, `ask`) or a call needs your permission, it opens its own small window
  in front of whatever you are doing, focused and ready to answer — not a modal
  waiting in a chat window you may not have open. Closing it is a "no".
  Notifications carry the urgency the character chose: quiet, normal, or one that
  stays on screen until you dismiss it.
- **It keeps living while you look away**: timers, events and self-wakes run in the
  app's engine, not in the chat view — a character wakes up whether you are on
  that conversation, in Settings or in the tray. When it speaks while you are
  somewhere else you get a desktop notification (click it to jump straight to
  that chat) and an unread count in the sidebar.
- **Retry a reply**: not the answer you hoped for? `↻` on the newest reply (or
  **Try again** when a turn failed) throws it away and asks the character again
  from the same history — your message is not re-sent, and whatever the discarded
  reply already did (a picture, a memory, a timer) stays done.
- **Readable at your size**: zoom the chat text with the `A− 100% A+` buttons in
  the chat header, <kbd>Ctrl</kbd> `+` / `-` / `0`, or Settings → Appearance. The
  reading column widens with the text, so bigger type takes from the side gutters
  rather than from the line length.
- **See what the model sees**: Settings → General → Debug → "Show model traffic"
  adds a *Model traffic* button to the chat that lists every request sent to the
  model for the session (full system prompt, messages, tools) and its response.
- **Senses and events**: characters can see what you're doing (idle time,
  active window, now playing, battery, calendar), look at the screen through a
  vision model, and subscribe to events (you came back, a song changed, a file
  landed in Downloads, a time of day) that run their code without a turn.
- **A body and a voice**: a persistent avatar overlay with expressions, speech
  bubbles and animations; on-screen drawing; character-built widgets; text to
  speech in the character's own cloned voice (or through your own commands) and
  push-to-talk. See [docs/voice.md](docs/voice.md) for the measured behaviour and
  the traps.
- **Desktop control**: launch apps, move and focus windows, switch workspaces,
  volume, brightness, do-not-disturb, theme; a per-character home folder; typed
  input and clicks unless you switch them off; outbound messages via webhooks.
- **Inner life**: a mood model that decays and reacts, a daily routine with
  wake-ups on transitions, and long-term memory.
- **Permissions are an intersection**: what a pack asks for ∩ what your global
  policy allows ∩ the per-pack toggle. Inspect any pack before installing it.
- **SDK plugins**: drop a folder with `plugin.json`, a `.d.ts` with TSDoc, a
  markdown guide and a `main.js` into the plugins directory and the app adds
  the module to the SDK: it shows up in the reference, the prompt, the
  permission policy and pack capability requests like any built-in. See
  [docs/plugins.md](docs/plugins.md) and `examples/plugins/clock`.
- **Built-in pack editor**: create or import a pack, edit the manifest, the
  character (persona, greeting, behaviours, avatar and expressions), its function
  library (Scripts), media with tags and descriptions, and the README, with live
  validation, then install it
  into the app or export an `.rppack` to share. Media can be tagged and described
  by a vision model (qwen3-vl on a local Ollama, Claude, …): the editor sends each
  asset to the model, shows what it suggests, and only writes what you accept.

## Repository

| path                 | package        | role                                             |
|----------------------|----------------|--------------------------------------------------|
| `apps/desktop`       | `@rp/desktop`  | Electron app: main, preload, renderer, media window |
| `packages/shared`    | `@rp/shared`   | Cross-package contracts                          |
| `packages/sdk`       | `@rp/sdk`      | Capability registry, standard modules, d.ts/docs generator |
| `packages/pack`      | `@rp/pack`     | Pack format: schema, loader, validator, `.rppack` zip |
| `packages/llm`       | `@rp/llm`      | LLM provider abstraction                         |
| `packages/sandbox`   | `@rp/sandbox`  | QuickJS runner and host bridge                   |
| `packages/core`      | `@rp/core`     | Chat engine, action loop, permissions, storage   |
| `native/overlay-wlr` | `rp-overlay-wlr` | Rust wlr-layer-shell overlay helper (Hyprland, Sway, river, KDE Wayland) |
| `native/rp-coded`    | `rp-coded`     | Rust root daemon: input locking, injection, locked policy; installer and udev/systemd files |
| `examples/packs`     |                | Sample packs and the pack-author guide           |
| `docs`               |                | Architecture and per-package specs               |

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then the specs in
`docs/spec/` (`overlay.md`, `overlay-helper.md`, `memory.md`, `autonomy.md`,
and one per package).

## Getting started

Requirements: Node 22+, pnpm 10.

```bash
pnpm install
pnpm build:packages      # builds every library package
pnpm test                # vitest across the workspace
pnpm dev                 # runs the Electron app with hot reload
```

Try it without an API key: `RP_MOCK_LLM=1 pnpm dev` uses a scripted mock
provider that shows an image from the sample pack and replies.

`pnpm test:headful` runs the built app headful on an Xvfb display with a
file-backed framebuffer, drives two mock-LLM turns, screenshots every window
(chat with the action card, Packs, Settings, SDK reference, the prompt window,
the overlays and the whole framebuffer) into `/tmp/rp-headful-shots`, verifies
from pixel data that the image overlay shows the pack image and the video overlay
is playing (colour spread and frame advance), checks audio playback was accepted,
checks a character's question opened a prompt window and that answering it there
reached the action, and fails if the main process raised an uncaught exception. Needs `Xvfb`, `xwd`, `xdotool` and ImageMagick.

`pnpm test:browser` runs the browser-extension smoke: the built app on Xvfb in browser
smoke mode, Chromium launched through `playwright-core` with the unpacked extension, and
a mock-LLM turn that opens, reads, queries, types into, screenshots and clicks through a
page served by the app, checking that the `browser-navigated` event comes back. Needs
`Xvfb` and a Chromium for playwright-core (`pnpm --filter @rp/desktop exec playwright-core
install chromium`, or `PLAYWRIGHT_BROWSERS_PATH` / `RP_CHROMIUM_BIN`).

`pnpm test:wlr` does the same for the Hyprland path: it runs the native
layer-shell helper against a nested headless Sway compositor (real
wlr-layer-shell, software rendered), with the app on Xvfb driving it through
the `hyprland` backend, and verifies the layer surfaces from `grim` captures.
Needs `sway`, `grim`, `Xvfb`, ImageMagick, and the built helper.

### Hyprland (and other wlr-layer-shell compositors)

The desktop build compiles and bundles the native overlay helper automatically
when Rust and the `gtk3`, `gtk-layer-shell` and `webkit2gtk-4.1` development
packages are present (Debian/Ubuntu: `libgtk-3-dev libgtk-layer-shell-dev
libwebkit2gtk-4.1-dev`; Arch: `gtk3 gtk-layer-shell webkit2gtk-4.1`). It lands in
`apps/desktop/resources/bin/rp-overlay-wlr` and ships inside packaged builds.
Without those tools the build prints a notice and skips it (set
`RP_REQUIRE_NATIVE=1` to make that a failure).

The app picks the `hyprland` backend automatically under Hyprland. Without the
helper it falls back to Hyprland IPC emulation (top/overlay only), and on other
desktops to plain Electron windows. See `docs/spec/overlay.md` and
`native/overlay-wlr/README.md`.

The IPC fallback keeps overlays where the SDK put them by registering window
rules over the Hyprland socket at startup — nothing is written to your Hyprland
config, and the rules are re-registered after a `hyprctl reload` and dropped
again when the app quits. Sessions configured in Lua (`hyprland.lua`, Hyprland
0.5x) are detected from Hyprland's own answers and driven through `eval` with
`hl.window_rule` / `hl.dispatch` instead of the legacy `keyword` and `dispatch`
commands.

### Tray icon

rp-code keeps a tray icon on every launch; closing the window hides it there (Settings →
General → *Closing the window keeps rp-code running in the tray*) so timers, self-wakes and the
browser bridge keep working, and **Quit** lives in the tray menu. On Linux the tray is a
StatusNotifier item: install `libayatana-appindicator3-1` (Debian/Ubuntu; the `.deb` depends on
it) or `libayatana-appindicator` (Arch) and make sure your bar has a tray module (Waybar:
`"tray"`). Without both, no icon appears and closing the window quits.

### System integration (input locking, run on login, locked settings)

Locking the keyboard or mouse needs access to `/dev/input`, which desktop users
do not have. The `rp-coded` daemon (built alongside the helper and shipped under
`resources/bin`, with its udev rules, systemd units and installer under
`resources/system`) runs as a hardened root service and performs those actions
on the app's behalf over a group-restricted socket. Run the installer once:

```bash
sudo resources/system/install.sh          # or native/rp-coded/install.sh from a checkout
```

It creates the `rp-code` group, installs the udev rule and service, sets the app
to start on login, unpacks an AppImage into `/opt/rp-code/current` (the *system install*:
root-owned, updated by the daemon without a password, previous version kept for
`install.sh --rollback`; `--no-system-install` keeps the AppImage), and prepares `/etc/rp-code` for `policy.json`, a root-owned file that
can cap lock durations, pin settings the user cannot change and disable modules
outright. With `"app": { "allowQuit": false, "users": ["alice"] }` the policy also keeps
the app running for those users: no Quit in the tray or Ctrl+Q, closing hides to the
tray, and the daemon relaunches the app in their session if it is killed or crashes
(`native/rp-coded/dist/POLICY.md`). A `"guard": { "mode": "audit" }` block turns on the
*session guard*: AppArmor profiles generated by the daemon that confine those users' login
sessions so their own terminals, keybind scripts and pickers cannot reach the compositor/shell
IPC (`hyprctl`, `noctalia msg`), edit the wallpaper config or kill rp-code — while rp-code
itself may; attempts reach characters as the `guard-attempt` event, and `enforce` blocks them.
The app shows the daemon and policy state under **Settings → System**,
where you can also create the policy once without a root password (afterwards only
root can change it).

A policy can be **locked** instead of being written once, in one of two ways. With a **code**, the
daemon pins the policy to a TOTP secret it shows you exactly once, and replacing or removing it
needs the code your authenticator app is showing — `sudo` is not enough. With a **signed policy
chain**, the machine holds no secret at all: it pins an Ed25519 public key and the hash of the last
version it applied, and the only thing that can change anything is a new version signed by that
key, committing to the one before it. Letting a machine go is also a signed version, so even
release is an act the key authorises.

Either way the effective policy is published into a read-only filesystem the daemon mounts itself,
an edited policy file is put back within seconds and reported, spare copies of the lock are kept,
the files are immutable, the service refuses a manual stop, and — with the session guard enforcing
— `run0`, `systemd-run`, `machinectl`, `pkexec` and `chattr` are taken away from the managed
sessions, so there is no unconfined shell to undo it from. What it still cannot do is listed in
the app rather than glossed over.

A machine follows a chain by being given a **Remote Link**: one base64 blob carrying the address,
the key and the mode. The same policy **pins the packs** the machine gets, each one signed rather
than merely checksummed, installed without anybody choosing a file, with everything else optionally
removed. The app is both ends of this: Settings → System publishes a chain, signs each version and
hands out the link, and `scripts/rp-policy-chain.mjs` does the same from a terminal.
See [docs/system-integration.md](docs/system-integration.md).

The same installer writes the browser extension policy for **Settings → Browser**
(`install.sh --browser-only --browser-extension <id> --browser-update-url <url> [--browser-home <url>] [--browser-policy-dir <dir>]…`); see
[docs/browser-extension.md](docs/browser-extension.md).

To chat for real, open **Settings → Providers**, add a provider (Anthropic,
or an OpenAI-compatible base URL such as `http://localhost:11434/v1` for
Ollama), pick a model, then install `examples/packs/luna` from **Packs** and
start a session.

## Releases and CI

Every push to `main` is tagged and released automatically
(`.github/workflows/release.yml`): the version is `v<major>.<minor>.<N>` with
`major.minor` from the root `package.json` and `N` the number of commits on
`main`, so no version-bump commits are needed. The workflow builds Linux
installers (AppImage and `.deb`, with the layer-shell helper bundled), attaches
them with SHA-256 checksums and generated release notes, and skips silently if
the tag already exists. Windows and macOS builds are switched off for now; the
electron-builder targets for them remain configured.

### Updating

The packaged app updates itself from those releases (**Settings → Updates**).
Because the repository is private, each user needs their own fine-grained
personal access token with read-only *Contents* access to
`0xbeef1eaf/llm-rp-code` (create it at github.com/settings/personal-access-tokens
and paste it into the Updates tab). The token is stored encrypted through the
OS keyring (Electron `safeStorage`; a `0600` file when no keyring is available),
never in the settings JSON or the binary. The **AppImage** checks about 30 s
after launch and every 6 hours (configurable, or switch automatic checks off),
downloads the new release in the background when the AppImage lives in a
folder you can write to, and offers *Restart now / Later*; a downloaded update
is also applied on quit. A **system install** (`/opt/rp-code/current`, what the
system-integration installer makes of an AppImage) downloads the same way and then
hands the file to the `rp-coded` daemon, which verifies the checksum, unpacks it as
your user, swaps it in as root, keeps the old version under `/opt/rp-code/previous`
and updates itself from the bundle when needed — no password prompt (see
[docs/system-integration.md](docs/system-integration.md#system-install)). The **`.deb`** install is notified only: the app
announces new releases and links to the release page, where you install the
package as usual. Development runs never check. Administrators can pin the
"check automatically" toggle or switch update checks off entirely with the
`settings.updates` key of the root-owned policy file (`native/rp-coded/dist/POLICY.md`).
Each release carries `latest-linux.yml`, the manifest `electron-updater` reads;
keep it attached.

Every other push and pull request runs `.github/workflows/ci.yml`: build,
typecheck, all unit tests, the helper's cargo tests, the Xvfb headful smoke and
the nested-Sway layer-shell smoke and a smoke run of the packaged app
(screenshots are uploaded as artifacts).

## Writing a pack

The quickest way is the **Pack editor** inside the app (sidebar → Pack editor →
New pack): it scaffolds the folder, lets you fill in everything through forms,
validates as you go, and installs or exports with one click.

Under **Media**, "✨ Auto-tag…" hands your images, video frames and audio to a
vision model and proposes tags and one-line descriptions for `media.json`, reusing
the tag vocabulary you already have; you tick what to keep before it touches the
draft. It uses the providers from **Settings → Providers** — for a local model, an
OpenAI-compatible provider on `http://localhost:11434/v1` with model `qwen3-vl:8b`
and "Model accepts images" ticked.

The same tagging runs from the command line, writing `media.json` directly:

```bash
node --experimental-transform-types apps/desktop/scripts/tag-media.ts examples/packs/luna --dry-run
node --experimental-transform-types apps/desktop/scripts/tag-media.ts examples/packs/luna \
  --model qwen3-vl:8b media/images/luna-smile.png
```

With no assets named it tags the untagged ones (`--scope all` for every asset); `--debug`
prints each request and streams the answer, and `--help` lists every option. It needs ImageMagick for images and ffmpeg
for video frames.

For a local *thinking* model, it asks for `reasoning_effort: none` and constrains the answer
with `response_format` by default — without those a reasoning model spends its whole token
budget deliberating and never answers. Models whose template has no thinking switch (qwen3-vl)
ignore the effort setting; use an instruct build of those.

For the on-disk format, see [examples/packs/README.md](examples/packs/README.md), the
behaviour hooks and a tour of the SDK. The SDK reference the characters see is
also available inside the app under **SDK Reference**.

To try an SDK call before putting it in a behaviour or a persona, open **Sandbox**
(<kbd>Ctrl</kbd>+<kbd>7</kbd>): pick a character, type the body of an action —
`sdk`, `lib` and an optional JSON `input` are in scope, `return` gives the
value — and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>. It runs in the same sandbox
with the character's permissions and session, and shows the value, the error
with a code frame, the console output and every SDK call it made.

## Security

Packs and model output are untrusted. Read the security model in
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-security-model) before
installing packs from people you do not know. Permissions are app-wide: every installed
character can use every capability you have not switched off under Settings → Permissions
(packs neither request nor are granted anything; a `capabilities` key in an old pack is
ignored with a warning). Nothing prompts per call: a character uses what is switched on
freely, and every call is written to the audit log.

## License

MIT
