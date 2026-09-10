# rp-code

A desktop LLM roleplay chat where characters can **act on your PC by writing
code**. Each character is driven by an LLM that, besides talking, may write
short TypeScript snippets against a documented SDK. The app runs those snippets
in a WebAssembly sandbox and executes the requested actions on the host:
show a picture, play a video or sound, remember something, set a reminder,
notify you, and touch the system, all within the capabilities you grant.

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
- **Shareable packs**: manifest + characters + persona + media + optional
  behaviour scripts (`onSessionStart`, `onTimer`, ...).
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
- **External commands**: wallpaper, browser, desktop and voice actions run through
  command templates you edit in Settings. Input locking and injection are
  daemon-only (see *System integration* below).
- **See what the model sees**: Settings → General → Debug → "Show model traffic"
  adds a *Model traffic* button to the chat that lists every request sent to the
  model for the session (full system prompt, messages, tools) and its response.
- **Senses and events**: characters can see what you're doing (idle time,
  active window, now playing, battery, calendar), look at the screen through a
  vision model, and subscribe to events (you came back, a song changed, a file
  landed in Downloads, a time of day) that run their code without a turn.
- **A body and a voice**: a persistent avatar overlay with expressions, speech
  bubbles and animations; on-screen drawing; character-built widgets; text to
  speech and push-to-talk through your own commands.
- **Desktop control**: launch apps, move and focus windows, switch workspaces,
  volume, brightness, do-not-disturb, theme; a per-character home folder; typed
  input and clicks once you grant them; outbound messages via webhooks.
- **Inner life**: a mood model that decays and reacts, a daily routine with
  wake-ups on transitions, and long-term memory.
- **Permissions are an intersection**: what a pack asks for ∩ what your global
  policy allows ∩ the per-pack toggle. Inspect any pack before installing it.
- **SDK plugins**: drop a folder with `plugin.json`, a `.d.ts` with TSDoc, a
  markdown guide and a `main.js` into the plugins directory and the app adds
  the module to the SDK: it shows up in the reference, the prompt, the
  permission policy and pack capability requests like any built-in. See
  [docs/plugins.md](docs/plugins.md) and `examples/plugins/clock`.
- **Built-in pack editor**: create or import a pack, edit the manifest,
  characters (persona, greeting, behaviours, avatar and expressions), media with
  tags and descriptions, and the README, with live validation, then install it
  into the app or export an `.rppack` to share.

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
file-backed framebuffer, drives one mock-LLM turn, screenshots every window
(chat with the action card, Packs, Settings, SDK reference, the overlays and the
whole framebuffer) into `/tmp/rp-headful-shots`, verifies from pixel data that
the image overlay shows the pack image and the video overlay is playing (colour
spread and frame advance), checks audio playback was accepted, and fails if the
main process raised an uncaught exception. Needs `Xvfb`, `xwd`, `xdotool` and ImageMagick.

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
to start on login, and prepares `/etc/rp-code` for `policy.json`, a root-owned file that
can cap lock durations, pin settings the user cannot change and disable modules
outright. The app shows the daemon and policy state under **Settings → System**,
where you can also create the policy once without a root password (afterwards only
root can change it).
See [docs/system-integration.md](docs/system-integration.md).

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
is also applied on quit. The **`.deb`** install is notified only: the app
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

For the on-disk format, see [examples/packs/README.md](examples/packs/README.md), the
behaviour hooks and a tour of the SDK. The SDK reference the characters see is
also available inside the app under **SDK Reference**.

## Security

Packs and model output are untrusted. Read the security model in
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-security-model) before
installing packs from people you do not know. Nothing prompts per call: once you grant a
capability to a pack (within your global policy), the character uses it freely,
and every call is written to the audit log.

## License

MIT
