# rp-code

A desktop LLM roleplay chat where characters can **act on your PC by writing
code**. Each character is driven by an LLM that, besides talking, may write
short TypeScript snippets against a documented SDK. The app runs those snippets
in a WebAssembly sandbox and executes the requested actions on the host:
show a picture, play a video or sound, remember something, set a reminder,
notify you, and (with per-call approval) touch the system.

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
| `examples/packs`     |                | Sample packs and the pack-author guide           |
| `docs`               |                | Architecture and per-package specs               |

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
installing packs from people you do not know. Capabilities with effects
outside the app (`system.*`) always require a per-call confirmation.

## License

MIT
