# @rp/pack — Pack format: schema, loader, validator, zip

Depends on: `@rp/shared`, `zod` (v4), `fflate` (zip), Node `fs/promises` + `path`.

## Exports

```ts
export const packManifestSchema: z.ZodType<PackManifest>;
export const characterDefinitionSchema: z.ZodType<CharacterDefinition>;
export function validateManifest(json: unknown): PackManifest;       // throws RpError('PACK_INVALID', msg, { issues })
export function validateCharacter(json: unknown): CharacterDefinition;
export function loadPack(root: string): Promise<LoadedPack>;          // reads pack.json, the one character dir (persona.md, behaviour scripts, lib/**/*.ts), README.md, indexes assets; `pack.character` is `pack.characters[0]`
export function validatePack(root: string): Promise<{ ok: boolean; problems: string[] }>;  // never throws for content errors
export function indexAssets(root: string, mediaRoot?: string): Promise<AssetEntry[]>;      // recursive; includes character avatars and expression frames marked `role: 'avatar'` (resolvable by path, hidden from sdk.pack listings/searches/tags); kind by extension; mime by extension table
export function resolveAssetPath(root: string, relative: string): string;  // normalises, rejects absolute/`..`/backslash tricks, returns absolute path; throws RpError('PATH_ESCAPE'); must also realpath-check that the resolved file stays under root (symlink escape)
export function packDirectory(root: string, destinationFile: string): Promise<void>;       // validates first; writes .rppack (zip, deflate) with paths relative to root; skips dotfiles, node_modules
export function extractPack(file: string, destinationDir: string): Promise<LoadedPack>;    // zip-slip safe, rejects absolute/`..` entries; then loadPack
export function readManifestFromArchive(file: string): Promise<PackManifest>;             // peek without extracting
export const IGNORED_CAPABILITIES_KEY = 'capabilities'; export function ignoredCapabilitiesWarning(file: string): string;  // legacy key, see Validation rules
export function assetKindFor(path: string): AssetKind; export function mimeFor(path: string): string;
// function library (see "Function library" below)
export function readCharacterLibrary(rootAbs, charDir, { previous? }): Promise<{ library: CharacterLibrary; warnings: string[] }>;   // reads lib/**/*.ts, then buildCharacterLibrary
export function buildCharacterLibrary(sources: Record<libPath, string>, libRel, { previous?, problems? }): Promise<{ library: CharacterLibrary; warnings: string[] }>;   // esbuild; `warnings` are the advisory caps
export function writeLibraryFile(root, charDir, libPath, source): Promise<string>;   // atomic (temp + rename), creates folders; returns the pack-relative path
export function removeLibraryFile(root, charDir, libPath): Promise<boolean>;
export function normalizeLibraryPath(libPath): { ok: true; path } | { ok: false; reason };   // inside lib/, ends in .ts (not .d.ts), no hidden segment
export function libraryNameProblem(name): string | undefined; export const LIB_RESERVED_NAMES: ReadonlySet<string>; export function libraryFilePath(libPath): string;   // `lib/<libPath>`
// what each export looks like, read textually (`library-source.ts`): kind, params, JSDoc summary, @internal
export function scanExports(source): Map<name, { kind: 'function' | 'value' | 'unknown'; params; description?; internal? }>;
export function jsDocSummary(body): { description?; internal: boolean }; export function functionParams(source): string; export function hasExports(source): boolean;
export function libraryReadme(name): string; export function libraryFileTemplate(): string;      // scaffold text for lib/README.md and the editor's starter file
```

## Validation rules

- `id`: /^[a-z0-9]+(\.[a-z0-9-]+)+$/ ; `version`: semver (simple regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`); `formatVersion === 1`
- **A pack has exactly one character.** `characters` holds exactly one relative dir containing `character.json` (the schema rejects zero or two entries); the loader also reports a problem when `characters/` holds a second directory with a `character.json` that the manifest does not list (`characters/<x>/character.json: a pack has exactly one character …`). The on-disk layout `characters/<id>/…`, the array in `pack.json` and the `packId/characterId` character ref are unchanged; `LoadedPack.character` is the convenience accessor and `LoadedPack.characters` stays a one-entry array for compatibility. `persona` file must exist; `behaviours` files must exist and end with `.ts` or `.js`; `avatar` must exist and be an image.
- `characters/<id>/lib/**/*.ts`: see "Function library". Everything wrong in the library, and its caps, are `warning:` lines, never problems.
- `capabilities` (pack.json and character.json) is a **legacy key**: permissions are app-wide (Settings → Permissions), packs declare none. The schemas accept the key with any value, strip it from the parsed `PackManifest` / `CharacterDefinition` (the types have no such field), and `inspectPack`/`validatePack` add the warning `warning: <file>: "capabilities" is ignored; permissions are set in the app under Settings → Permissions`. `scaffoldPack`, `writeManifest` and `writeCharacter` never write it.
- `promptFunctions` (character.json, optional): the SDK the character's **prompt** describes — an array of module ids (`"avatar"`) and/or single functions (`"avatar.show"`), validated against `PROMPT_FUNCTION_PATTERN` and required to be free of duplicates. Unknown names are not an error: a pack may name a plugin module this machine does not have. It is not a permission — the code keeps every function the user allows (docs/spec/core.md, `promptSelection`) — so it is the author's way of keeping a prompt short and focused. Omit the key for "everything the user allows"; `[]` means "nothing but `sdk.lib`".
- `mediaRoot` default `media`; may not exist (a pack can have no media).
- File names inside the pack must not contain `..` segments or be absolute.

## Function library (`characters/<id>/lib/`)

The character's `lib` is a small TypeScript project the author ships in `characters/<id>/lib/`. Every `.ts` file under it, sub-folders included, is an ES module; each named export is `lib.<exportName>` (and `sdk.lib.<exportName>`, the same object) in every action, timer handler and event handler, and whatever a file does not export is private to it. Types live in `@rp/shared` (`CharacterLibrary`, `LibFunction`, `LibraryProblem`, `LIB_*`).

```ts
// lib/dice.ts
/** @internal Roll an n-sided die. */
export function roll(n: number) {
  return 1 + Math.floor(Math.random() * n);
}
```

```ts
// lib/games/pictures.ts
import { roll } from "../dice";

type Mood = "happy" | "sad";

// private: not exported, so not on lib
async function pick(mood: Mood) {
  const pics = await sdk.pack.findAssets({ anyTags: [mood], kind: "image" });
  return pics[roll(pics.length) - 1];
}

/** Show a picture for a mood; true when there was one. */
export async function cheer(mood: Mood) {
  const pic = await pick(mood);
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}
```

The character sees `- lib.cheer(mood: Mood) — Show a picture for a mood; true when there was one.` under `<library>`; `lib.roll` is on `lib` but not listed, and `pick` is nowhere.

- **Files.** Only regular `.ts` files count: `.d.ts` files, dotfiles, hidden folders, symlinks, a `README.md` and anything else in `lib/` are ignored.
- **Exports.** Each named export lands on `lib` under its own name. A name must be a valid function name — `^[a-zA-Z_$][\w$]*$`, at most 64 characters, no JavaScript reserved word, not `__proto__` (`LIB_NAME_PATTERN` / `LIB_NAME_MAX_CHARS`, `LIB_RESERVED_NAMES`, `libraryNameProblem`) — and may be exported by one file only: a duplicate is reported and the later file's export left out (import it from the first file instead of re-exporting it). `export default` has no name to be called by: reported, that export left out. Exported non-functions (constants, classes) are on `lib` and importable but not listed in the prompt. Type-only exports are erased.
- **Imports.** Files import each other by relative path only (`./dice`, `./dice.ts`, `../games/index`); a package, a `node:` module or a path outside `lib/` is refused. `sdk` and `lib` are globals of the run, not imports.
- **JSDoc.** The `/** … */` right before an export's declaration documents it: its first paragraph (up to a blank line or a tag), on one line, is the description in `- lib.<name>(<params>) — <description>`; the parameters are the declaration's own list as written. A `@internal` tag (text after it still counts as the description, `LIB_INTERNAL_TAG`) marks the author's plumbing — an export a sibling file imports. What that means is core's business (docs/spec/core.md "Internal helpers"): left out of `<library>` and refused to the model's own action code, while other library functions, the pack's behaviour hooks, its event handlers, its timers and the Sandbox tab reach it. The scanner (`scanExports`) is textual; an export it cannot read (a re-export) is still on `lib`, listed with no parameters.
- **Building.** `readCharacterLibrary(rootAbs, charDir, { previous })` reads the files and `buildCharacterLibrary` bundles them with esbuild in two passes: every file as an entry of its own, for the names each exports (the metafile), then one IIFE whose value is the object of every accepted export. The result is `LoadedCharacter.library: CharacterLibrary { files, functions, code, problems }` — `files` every library file (pack-relative path → source), `functions` the listed functions sorted by name (`{ name, file, params, description?, internal? }`), `code` the bundle expression ('' when empty or broken), `problems` against their file. A build error (a syntax error, an import that is refused or does not resolve, top-level await) leaves the library with no functions and no code; a problem with one export only leaves that export out. A file that exports nothing and that no other file imports is reported too (it adds nothing: usually a file in the old one-function format — examples/packs/README.md §8 "Moving a library from the old format" walks an author through converting one). `previous` is returned as is when no file changed. The pack still validates, installs and loads either way: the loader turns every problem into `warning: <file>:<line>:<col>: <message>` (no position when there is none).
- **Caps.** Advisory, reported as `warning:` lines and never as problems: 50 public (non-`@internal`) functions (`LIB_MAX_FUNCTIONS`), 128 KiB of library files in total (`LIB_MAX_TOTAL_BYTES`). A single file has no size cap. The two price differently: a function costs one `<library>` line in the prompt of every turn (sources never go in the prompt), while the bytes are the bundle evaluated in the isolate on each action, timer and event handler, against that run's `cpuMs` budget.
- **Reaching the run.** Core turns `code` into the prelude `const lib = __rp_lib(<code>, ["<internal name>", …]);` (`buildPrelude`, docs/spec/core.md "LibraryService"), which the sandbox prepends to every run; the bundle's top-level statements run then, before the code that calls it, so they should be cheap and must not call `lib` (it is not there yet). A handler a library function hands to `sdk.events.on` / `sdk.timers.runLater` is stored as its own source alone, so it should call `lib.<name>(...)` rather than a private helper. Nothing at run time changes the library: it is the author's.
- **Writing.** `writeLibraryFile` writes atomically (temp file + rename), creating folders, and `removeLibraryFile` deletes; both take a path relative to `lib/`, checked by `normalizeLibraryPath`, and are the editor's (docs/spec/editor.md). `scaffoldPack` creates `lib/README.md` (`libraryReadme`) explaining all of this. `packDirectory` zips the folder like any other pack file.

## Asset kinds

image: png jpg jpeg gif webp avif svg bmp — video: mp4 webm mkv mov m4v — audio: mp3 wav ogg m4a flac aac opus — text: txt md json csv — else other. Provide a mime table for these.

What those containers may hold is wider than what the media pages decode, so a video in a format Chromium refuses (an HEVC or ProRes `.mov`, AC-3 sound) is converted to MP4 once when it is first played and served from a cache — see `capabilities/video-compat.ts` in `docs/spec/desktop.md`.

## Example packs (create under `examples/packs/`)

1. `examples/packs/luna/` — companion character "Luna" with persona.md, avatar (generate a small PNG programmatically in a script or commit a tiny 1×1/16×16 PNG), 2 images and 1 short generated WAV (write a tiny sine-wave WAV file with a script; keep < 100 KB), behaviours `on-session-start.ts` (calls `sdk.llm.wake` with a time-aware greeting brief and `sdk.state.set('sessions', n+1)`), and `on-timer.ts`. Uses `media` and `ui` (no declaration needed: permissions are app-wide).
2. `examples/packs/minimal/` — one character, no media, no behaviours. Used by tests as the smallest valid pack.

Also add `examples/packs/README.md` documenting the format for pack authors (copy §8 of ARCHITECTURE.md and expand with the behaviour hooks and a full SDK usage example).

## Tests

- schema accepts the examples and rejects: bad id, missing characters, `..` in paths, absolute paths
- loadPack on `examples/packs/luna` yields 1 character, persona text, behaviour sources, asset index with correct kinds; on `examples/packs/makima` the shipped `lib/glance.ts` loads `lib.glance` with its JSDoc description
- a second character (listed in `pack.json`, or only present on disk) is a problem; a directory under `characters/` without a `character.json` is not a character
- library files: every `.ts` file under `lib/` (sub-folders included; `.d.ts`, dotfiles, hidden folders, other files ignored) is read, and its exports become `functions` with params, JSDoc description and `@internal`; a library that does not build loads with no functions and the error as a positioned `warning:`; a file in the old one-function format is a warning; the caps are warnings, `@internal` exports not counted; `writeLibraryFile`/`removeLibraryFile` round-trip under sub-folders and leave no temp files; `packDirectory` → `extractPack` carries `lib/**/*.ts`
- `buildCharacterLibrary`: the bundle evaluates to the object of every export (constants included, private helpers not), resolving relative imports across folders; `export default`, a reserved name and a duplicate name are each reported and left out; an import from a package, `node:` or outside `lib/`, an unresolved import and top-level await fail the build; an unchanged folder reuses `previous`
- `scanExports` / `jsDocSummary` / `functionParams`: every declaration form with its summary and parameters, `@internal` with or without text, and not fooled by the word `export` in strings, comments, properties or nested code
- resolveAssetPath rejects `../x`, `/etc/passwd`, `media\\..\\x`, and a symlink pointing outside root (create in a temp dir)
- packDirectory → extractPack round-trips byte-for-byte; extractPack rejects a hand-built zip containing `../evil.txt`
