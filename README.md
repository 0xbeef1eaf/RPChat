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
- **External commands**: wallpaper, browser and input-lock actions run through
  command templates you edit in Settings.
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

Build the native overlay helper once (needs Rust plus `gtk3`, `gtk-layer-shell`
and `webkit2gtk-4.1` development packages; Debian/Ubuntu:
`libgtk-3-dev libgtk-layer-shell-dev libwebkit2gtk-4.1-dev`):

```bash
pnpm build:native
mkdir -p apps/desktop/resources/bin
cp native/overlay-wlr/target/release/rp-overlay-wlr apps/desktop/resources/bin/
```

The app picks the `hyprland` backend automatically under Hyprland. Without the
helper it falls back to Hyprland IPC emulation (top/overlay only), and on other
desktops to plain Electron windows. See `docs/spec/overlay.md` and
`native/overlay-wlr/README.md`.

To chat for real, open **Settings → Providers**, add a provider (Anthropic,
or an OpenAI-compatible base URL such as `http://localhost:11434/v1` for
Ollama), pick a model, then install `examples/packs/luna` from **Packs** and
start a session.

## Writing a pack

See [examples/packs/README.md](examples/packs/README.md) for the format, the
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
