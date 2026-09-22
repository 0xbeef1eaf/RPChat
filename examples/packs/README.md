# Writing packs for rpchat

A **pack** is a directory (or an `.rppack` zip of that directory) that ships
**exactly one character**, its media, optional pre-written behaviour scripts and
the character's function library. Two characters means two packs. This
directory contains three reference packs:

- [`luna/`](./luna) — a complete companion character with an avatar, two images,
  a generated chime and two behaviour scripts. Requests `media` and `ui`.
- [`makima/`](./makima) — uses every pack feature: avatar expressions, wallpapers,
  four behaviour scripts, `media.json`, and a shipped function library
  (`characters/makima/lib/glance.ts`).
- [`minimal/`](./minimal) — the smallest valid pack: one character, no media,
  no behaviours. Used by the test-suite.

`scripts/generate-media.mjs` regenerates the tiny media files (run it with Node).

## 1. Layout

```
my-pack/
├── pack.json                     required
├── README.md                     optional, shown in the app's pack view
├── characters/
│   └── luna/                     exactly one character directory per pack
│       ├── character.json        required
│       ├── persona.md            the character's system prompt body
│       ├── avatar.png            optional
│       ├── lib/                  optional, the function library (see §8)
│       │   └── cheer.ts          one function per file
│       └── scripts/
│           ├── on-session-start.ts
│           └── on-timer.ts
├── media.json                    optional, tags + descriptions for the media (see §5)
└── media/                        optional; `mediaRoot` in pack.json, default "media"
    ├── images/…  video/…  audio/…
```

Every path in the manifests is relative (to the pack root in `pack.json`, to
the character directory in `character.json`), uses forward slashes, and must
not contain `..` segments or be absolute. The loader rejects anything else,
including symlinks that point outside the pack.

## 2. `pack.json`

```jsonc
{
  "formatVersion": 1,
  "id": "com.example.luna",          // reverse-DNS: /^[a-z0-9]+(\.[a-z0-9-]+)+$/
  "name": "Luna",
  "version": "1.0.0",                // semver
  "description": "…",
  "author": { "name": "…", "url": "…", "email": "…" },
  "license": "CC-BY-4.0",
  "homepage": "https://…",
  "tags": ["companion"],
  "characters": ["characters/luna"],  // the one directory containing character.json (exactly one)
  "mediaRoot": "media",               // optional, default "media"; the directory may be absent
  "minAppVersion": "0.1.0"
}
```

Rules enforced by `@rp/pack`:

- `formatVersion` must be `1`.
- `id` is reverse-DNS, lower-case; `version` and `minAppVersion` are semver.
- `characters` lists exactly one directory with a `character.json`. A pack has
  one character; a second `characters/<x>/character.json` on disk is reported
  as a problem even when the manifest does not list it.
- There is no `capabilities` key: permissions are set in the app, not by the
  pack (see §6). A `capabilities` key from older packs is accepted but ignored,
  with the warning `pack.json: "capabilities" is ignored; permissions are set in
  the app under Settings → Permissions`.

## 3. `character.json`

```jsonc
{
  "id": "luna",                       // /^[a-z0-9][a-z0-9-_]*$/, unique in the pack
  "name": "Luna",
  "tagline": "…",
  "avatar": "avatar.png",             // must exist and be an image
  "persona": "persona.md",            // must exist; injected verbatim into the system prompt
  "greeting": "…",                    // first assistant message in a new session
  "exampleDialogue": [{ "user": "…", "character": "…" }],
  "behaviours": { "onSessionStart": "scripts/on-session-start.ts" },
  "modelHints": { "temperature": 0.9, "maxTokens": 800, "model": "…" }
}
```

### Writing `persona.md`

The persona is the heart of the character. It is placed in the system prompt
right after the engine rules, so write it as instructions to the model: who the
character is, how they talk, what they care about, and — because rpchat
characters can *act* — when they should use their abilities and when they
should just talk. `luna/characters/luna/persona.md` is a worked example.

## 4. Media and assets

Assets are addressed by path relative to `mediaRoot` in SDK calls
(`sdk.media.showImage("images/luna-smile.png")`) and the app serves them to its
own windows over `rp-asset://<packId>/<relative>`. The model is told which
files exist, grouped by kind. Kind is decided by extension:

| kind  | extensions                                  |
|-------|---------------------------------------------|
| image | png jpg jpeg gif webp avif svg bmp          |
| video | mp4 webm mkv mov m4v                        |
| audio | mp3 wav ogg m4a flac aac opus               |
| text  | txt md json csv                             |
| other | everything else                             |

A video's extension does not promise its contents play: the overlay is Chromium, so an HEVC or
ProRes `.mov` (what phones record and editors export) is converted to H.264 the first time it is
played, which needs `ffmpeg` on the machine. Shipping H.264/AAC or WebM plays everywhere with no
conversion at all.

Dotfiles, `node_modules` and symlinks are not indexed and are not packed.

Every indexed asset also carries **tags**. Folder names become tags
automatically (`media/images/outfits/summer/x.png` → `outfits`, `summer`), so a
sensible directory layout already lets the character pick media by meaning;
`media.json` adds explicit tags and descriptions on top.

## 5. Describing media with `media.json`

An optional `media.json` at the pack root tells the character what each piece
of media *is*, so it can choose "a happy portrait" rather than guessing from a
file name:

```jsonc
{
  "folderTags": true,                 // default true: folder names become tags
  "tags": {                           // vocabulary: tag → short meaning, shown to the model
    "portrait": "A picture of Luna herself",
    "happy": "Cheerful mood; good for cheering someone up"
  },
  "entries": [
    { "match": "media/images/luna-*.png", "tags": ["portrait"] },
    { "match": "media/images/luna-smile.png", "tags": ["smile", "happy"],
      "description": "Luna grinning in warm light." },
    { "match": "media/audio", "tags": ["sound"] }
  ]
}
```

- `match` is a pack-relative path or glob: `*` matches within one path
  segment, `**` matches across segments, `?` matches one character, and a bare
  directory (no wildcards) matches everything under it.
- Tags are lower-case `[a-z0-9][a-z0-9_-]*`, at most 32 characters, at most 20
  per asset; they are trimmed, lower-cased and deduplicated for you.
- An asset gets the union of its folder tags and the tags of **every** entry
  that matches it. When several matching entries set a `description`, the last
  one wins. Descriptions are at most 200 characters.
- Folder tags skip the kind folders (`media`, `images`, `image`, `video`,
  `videos`, `audio`, `sounds`, `text`, `other`, `characters`) and the media root's own name;
  every other directory segment counts. Set `folderTags: false` to opt out.
- `validatePack` warns about entries that match no asset and vocabulary tags
  no asset uses; neither stops the pack from loading.

In the sandbox, `sdk.pack.listAssets()` returns each asset with its tags and
description, and `sdk.pack.tags()` summarises the vocabulary with counts.

### Wallpapers

There is no special wallpaper file type. Put full-screen images under
`media/images/wallpapers/` (the folder name becomes the `wallpaper` tag
automatically) or tag them in `media.json`, add a description that says what
scene or mood they suit, and request the `wallpaper` capability in `pack.json`.
Characters then choose with `sdk.pack.findAssets({ tags: ["wallpaper"] })` and
apply with `sdk.wallpaper.set(asset)`. The user's wallpaper command (Settings →
Commands; auto-detected for swww/hyprpaper, GNOME, macOS and Windows) does the
actual switch, and `sdk.wallpaper.restore()` puts back the file the user chose
as their default in Settings.

```jsonc
// media.json
{
  "tags": { "wallpaper": "Full-screen scene meant to be set as the desktop background" },
  "entries": [
    { "match": "media/images/wallpapers/**", "tags": ["wallpaper"] },
    { "match": "media/images/wallpapers/night-harbour.png", "tags": ["night", "calm"], "description": "Harbour lights at night; use for late, quiet moments" }
  ]
}
```

## 6. Capabilities and permissions

The SDK is made of modules, each with a permission level. Permissions are
**app-wide and per function**: the user switches any SDK function — or a whole
module at once — on or off under Settings → Permissions, for every character.
Everything is on until they say otherwise. Packs neither request nor are granted
anything: there is nothing to declare in `pack.json` or `character.json`. (A
`capabilities` key from older packs is accepted, ignored and reported as a
loader warning.) `sdk.lib` is the one module outside all of this — it is the
character's own saved functions, so it is always available.

The level says how much ceremony a call needs, not whether it is allowed:

| level     | meaning                                                                                  |
|-----------|------------------------------------------------------------------------------------------|
| `trusted` | effects stay inside the app's own data (`chat`, `state`, `pack`, `timers`, …); never confirmed |
| `pack`    | reaches outside the app (`media`, `ui`, `crypto`, `system`, …); used without asking       |
| `prompt`  | as `pack`, plus a confirmation dialog on every call (no built-in module uses it)          |

Write the character so it copes with a function being off — a user may well keep
`crypto.decrypt` and drop `crypto.encrypt`. The call fails with
`PERMISSION_DENIED` naming Settings → Permissions, and the function is absent
from the SDK reference the model sees, so a character that reads its own
reference will not reach for it in the first place.

You can also choose what that reference **describes**: `promptFunctions` in
`character.json` (Pack editor → Character → "SDK in the prompt") lists the
modules and `module.function` names your character's prompt should carry. It
trims the prompt, not the pack — your behaviour scripts and `lib` functions
still call everything the user allows, so you can keep `sdk.wallpaper` out of
the character's reference and still set the wallpaper from a `lib` function. It
cannot widen anything: the user's permissions always have the last word.

## 7. Behaviour hooks

A character may bind TypeScript (or JavaScript) files to hooks. They run in the
same sandbox and with the same permissions as code the model writes:

| hook             | when                                                                  | `input`                                         | return value                                   |
|------------------|-----------------------------------------------------------------------|-------------------------------------------------|------------------------------------------------|
| `onInstall`      | once, right after the user installed the pack                         | `null`                                          | ignored                                        |
| `onSessionStart` | when a new chat session starts, before the first model turn           | `null`                                          | ignored (use `sdk.llm.wake` to open)           |
| `onUserMessage`  | after each user message, before the model turn                        | `{ text }`                                      | `{ skipLlm: true }` to fully script the reply  |
| `onTimer`        | when a timer scheduled with `sdk.timers.schedule` fires               | `{ timer: { id, payload, label? } }`            | ignored                                        |
| `onEvent`        | when a host event fires that no `sdk.events.on` subscription handled  | `{ event, data }`                               | ignored                                        |
| `onSessionEnd`   | when the session is closed                                            | `null`                                          | ignored                                        |

Each script sees the hook's input as a constant named `input`.

If no `onTimer` script exists, a firing timer instead wakes the model with a
system message describing the timer payload.

A script is the **body of an async function**: a global `sdk` object and
`console` are in scope, top-level `await` and `return` are allowed, and there
are no imports. The same is true of the code the model writes.

## 8. Function library (`lib/`)

A character can save functions with `lib.register` and call them as
`lib.<name>(...)` in every later action, timer handler and event handler
(`sdk.lib` is that same object, so `sdk.lib.<name>(...)` works too). Those
functions are files in the pack, `characters/<id>/lib/<name>.ts`, so you can
ship the ones you want the character to start with — and what the character
registers itself is written to the same folder of the installed copy (a reinstall
replaces the folder, so ship what must survive). Format: an optional first line
`// <description>` (shown in the character's prompt), then exactly one function
expression, as `lib.register` would receive it:

```ts
// characters/makima/lib/glance.ts
// show a random portrait of Makima for five seconds and return its path
async () => {
  const portraits = await sdk.pack.findAssets({ tags: ["portrait"], kind: "image" });
  if (portraits.length === 0) return null;
  const pick = portraits[Math.floor(Math.random() * portraits.length)];
  await sdk.media.showImage(pick, { durationMs: 5000, position: "bottom-right" });
  return pick.path;
}
```

The file name is the function name (a JavaScript identifier, at most 64
characters, no reserved words, and not `register` or `unregister` — the
library's own methods). A function may use `sdk` and its sibling `lib`
functions but closes over nothing else.

Library functions are the right place for anything that outlives one action:
the Makima pack ships six desktop **mini games** (`memoryGame`, `simonSays`,
`writeLines`, `whackAMole`, `reactionTest`, `slidingPuzzle`) built on
`sdk.widgets` and `sdk.media`. They show the pattern for long-running,
event-driven library code (see `makima/README.md`, "Mini games"):

- a starter takes its options — including callbacks **by library-function
  name**, `{ onLose: "punish", onWin?: "reward" }` — stores everything it needs
  in `sdk.state.session` (key `game`) and subscribes `sdk.events.on` handlers;
- handlers run later in a fresh isolate, so they close over nothing: they read
  the record back from session state and call `lib.gameLost(info)` /
  `lib.endGame(info)`, which invoke `lib[onLose]` / `lib[onWin]` with
  `{ game, event | result, attempt, mistakes, …details }`;
- pack images inside widget HTML use `{{asset:media/images/x.png}}` placeholders,
  which the host turns into loadable URLs; clicks on images shown with
  `sdk.media.showImage` arrive as `media-clicked` / `media-closed` events. A file that is not one function
expression is skipped with a warning; the caps — 50 files, 16 KiB per file,
128 KiB in total — are errors. Anything in `lib/` that is not a `.ts` file
(a README, say) is ignored. The pack editor's **Scripts** tab edits this folder.

## 9. SDK usage example

```ts
// Show a picture, remember it, and set a reminder — the body of one action.
const pic = sdk.pack.asset("images/luna-smile.png");
await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right" });

const shown = ((await sdk.state.get("timesShownSmile")) as number | null) ?? 0;
await sdk.state.set("timesShownSmile", shown + 1);

await sdk.timers.schedule(
  15 * 60 * 1000,
  { reason: "check whether they took a break" },
  { label: "Break check" },
);

await sdk.ui.notify("Luna", "I'll check in on you in 15 minutes.");
return { shown: shown + 1 };
```

Standard modules (v1):

| module   | permission | methods                                                                                          |
|----------|------------|--------------------------------------------------------------------------------------------------|
| `chat`   | trusted    | `emote(text)`, `history(limit)`, `setStatus(text)`                                              |
| `state`  | trusted    | `get/set/delete/keys` (per character, persistent), `session.get/set/delete/keys`                 |
| `pack`   | trusted    | `asset(path)`, `listAssets(prefix?)`, `tags()`, `readText(path)`, `info()`                       |
| `timers` | trusted    | `schedule(delayMs, payload, opts?)`, `cancel(id)`, `list()`                                      |
| `lib`    | trusted    | `register(name, fn, opts?)`, `unregister(name)` — `sdk.lib` **is** the `lib` global, so every other member is one of your saved functions; files under `lib/` (§8). The one module the permission policy never touches |
| `media`  | pack       | `showImage(asset, opts?)`, `playVideo(asset, opts?)`, `playAudio(asset, opts?)`, `overlay(asset, opts?)` (whole-screen, click-through), `close(id)`, `closeAll()`, `list()` |
| `ui`     | pack       | `notify(title, body?)`, `confirm(question)`, `choose(question, options[])`                       |
| `webcam` | pack       | `takeImage()`, `takeVideo(seconds)` — saved under `webcam/` in the character home, returned as a `source: 'home'` AssetRef that `sdk.media` can show |
| `crypto` | pack       | `encrypt(path)`, `decrypt(path)` — one of the user's own files, in place, under a key the app manages |
| `system` | pack       | `openExternal(url)`, `exec(command, args?)`, `readFile(path)`, `writeFile(path, text)`, `clipboardWrite(text)` |

Every run is limited (wall-clock timeout, CPU budget, memory, number of host
calls, log and result size), so keep scripts short and never loop forever.

## 10. Sharing a pack

Package a directory with `packDirectory(dir, "my-pack.rppack")` from `@rp/pack`
(the app exposes this in its packs view). The archive is a plain zip with
paths relative to the pack root; the app validates every entry before
extracting and refuses archives with absolute paths or `..` segments.
Installed packs live in `<userData>/packs/<packId>/<version>/`.
