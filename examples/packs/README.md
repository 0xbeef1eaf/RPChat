# Writing packs for rp-code

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
  "capabilities": ["media", "ui"],     // pack-level requests; trusted modules are implicit
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
- `capabilities` entries match `/^[a-z][a-zA-Z0-9]*$/`. Whether a capability
  actually exists is checked by the app when the pack is installed.

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
  "capabilities": ["system"],         // extra per-character requests (optional)
  "modelHints": { "temperature": 0.9, "maxTokens": 800, "model": "…" }
}
```

### Writing `persona.md`

The persona is the heart of the character. It is placed in the system prompt
right after the engine rules, so write it as instructions to the model: who the
character is, how they talk, what they care about, and — because rp-code
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

The SDK is made of modules, each with a permission level:

| level     | meaning                                                                                  |
|-----------|------------------------------------------------------------------------------------------|
| `trusted` | always available (`chat`, `log`, `state`, `pack`, `timers`); no effects outside the app  |
| `pack`    | must be listed in `capabilities`; the user grants it per pack at install time (`media`, `ui`) |
| `prompt`  | as `pack`, plus a confirmation dialog on every call (`system`)                            |

Only request what the character needs; users see the list at install time.

## 7. Behaviour hooks

A character may bind TypeScript (or JavaScript) files to hooks. They run in the
same sandbox and with the same permissions as code the model writes:

| hook             | when                                                                  | `input`                                         | return value                                   |
|------------------|-----------------------------------------------------------------------|-------------------------------------------------|------------------------------------------------|
| `onInstall`      | once, after the user accepted the capability grants                   | `null`                                          | ignored                                        |
| `onSessionStart` | when a new chat session starts, before the first model turn           | `null`                                          | ignored (use `sdk.chat.say` to speak)          |
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

A character can save functions with `sdk.lib.define` and call them as
`lib.<name>(...)` in every later action, timer handler and event handler. Those
functions are files in the pack, `characters/<id>/lib/<name>.ts`, so you can
ship the ones you want the character to start with — and what the character
defines itself is written to the same folder of the installed copy (a reinstall
replaces the folder, so ship what must survive). Format: an optional first line
`// <description>` (shown in the character's prompt), then exactly one function
expression, as `sdk.lib.define` would receive it:

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
characters, no reserved words). A function may use `sdk` and its sibling `lib`
functions but closes over nothing else. A file that is not one function
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
| `chat`   | trusted    | `say(text)`, `emote(text)`, `history(limit)`, `setStatus(text)`                                  |
| `log`    | trusted    | `debug/info/warn/error(...args)`                                                                 |
| `state`  | trusted    | `get/set/delete/keys` (per character, persistent), `session.get/set/delete/keys`                 |
| `pack`   | trusted    | `asset(path)`, `listAssets(prefix?)`, `tags()`, `readText(path)`, `info()`                       |
| `timers` | trusted    | `schedule(delayMs, payload, opts?)`, `cancel(id)`, `list()`                                      |
| `lib`    | trusted    | `define(name, fn, opts?)`, `remove(name)`, `list()`, `source(name)` — the function library, files under `lib/` (§8) |
| `media`  | pack       | `showImage(asset, opts?)`, `playVideo(asset, opts?)`, `playAudio(asset, opts?)`, `close(id)`, `closeAll()`, `list()` |
| `ui`     | pack       | `notify(title, body?)`, `confirm(question)`, `choose(question, options[])`                       |
| `system` | prompt     | `openExternal(url)`, `exec(command, args?)`, `readFile(path)`, `writeFile(path, text)`, `clipboardWrite(text)` |

Every run is limited (wall-clock timeout, CPU budget, memory, number of host
calls, log and result size), so keep scripts short and never loop forever.

## 10. Sharing a pack

Package a directory with `packDirectory(dir, "my-pack.rppack")` from `@rp/pack`
(the app exposes this in its packs view). The archive is a plain zip with
paths relative to the pack root; the app validates every entry before
extracting and refuses archives with absolute paths or `..` segments.
Installed packs live in `<userData>/packs/<packId>/<version>/`.
