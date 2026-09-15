# @rp/pack — Pack format: schema, loader, validator, zip

Depends on: `@rp/shared`, `zod` (v4), `fflate` (zip), Node `fs/promises` + `path`.

## Exports

```ts
export const packManifestSchema: z.ZodType<PackManifest>;
export const characterDefinitionSchema: z.ZodType<CharacterDefinition>;
export function validateManifest(json: unknown): PackManifest;       // throws RpError('PACK_INVALID', msg, { issues })
export function validateCharacter(json: unknown): CharacterDefinition;
export function loadPack(root: string): Promise<LoadedPack>;          // reads pack.json, the one character dir (persona.md, behaviour scripts, lib/*.ts), README.md, indexes assets; `pack.character` is `pack.characters[0]`
export function validatePack(root: string): Promise<{ ok: boolean; problems: string[] }>;  // never throws for content errors
export function indexAssets(root: string, mediaRoot?: string): Promise<AssetEntry[]>;      // recursive; includes character avatars and expression frames marked `role: 'avatar'` (resolvable by path, hidden from sdk.pack listings/searches/tags); kind by extension; mime by extension table
export function resolveAssetPath(root: string, relative: string): string;  // normalises, rejects absolute/`..`/backslash tricks, returns absolute path; throws RpError('PATH_ESCAPE'); must also realpath-check that the resolved file stays under root (symlink escape)
export function packDirectory(root: string, destinationFile: string): Promise<void>;       // validates first; writes .rppack (zip, deflate) with paths relative to root; skips dotfiles, node_modules
export function extractPack(file: string, destinationDir: string): Promise<LoadedPack>;    // zip-slip safe, rejects absolute/`..` entries; then loadPack
export function readManifestFromArchive(file: string): Promise<PackManifest>;             // peek without extracting
export const IGNORED_CAPABILITIES_KEY = 'capabilities'; export function ignoredCapabilitiesWarning(file: string): string;  // legacy key, see Validation rules
export function assetKindFor(path: string): AssetKind; export function mimeFor(path: string): string;
// function library files (see "Function library" below)
export function readCharacterLibrary(rootAbs, charDir, { previous? }): Promise<{ library: Record<name, CharacterLibraryEntry>; skipped: LibraryFileProblem[]; problems: string[] }>;
export function writeLibraryFunction(root, charDir, name, source, description?, internal?): Promise<string>;   // atomic (temp + rename); returns the pack-relative path
export function removeLibraryFunction(root, charDir, name): Promise<boolean>;
export function functionSourceProblem(source): string | undefined; export function unwrapFunctionSource(raw): string; export function libraryNameProblem(name): string | undefined;
export function parseLibraryFile(text): { source; description?; internal? }; export function formatLibraryFile(source, description?, internal?): string; export function libraryFilePath(name): string;
export function libraryReadme(name): string; export function libraryFunctionTemplate(): string;      // scaffold text for lib/README.md and the editor's starter function
```

## Validation rules

- `id`: /^[a-z0-9]+(\.[a-z0-9-]+)+$/ ; `version`: semver (simple regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`); `formatVersion === 1`
- **A pack has exactly one character.** `characters` holds exactly one relative dir containing `character.json` (the schema rejects zero or two entries); the loader also reports a problem when `characters/` holds a second directory with a `character.json` that the manifest does not list (`characters/<x>/character.json: a pack has exactly one character …`). The on-disk layout `characters/<id>/…`, the array in `pack.json` and the `packId/characterId` character ref are unchanged; `LoadedPack.character` is the convenience accessor and `LoadedPack.characters` stays a one-entry array for compatibility. `persona` file must exist; `behaviours` files must exist and end with `.ts` or `.js`; `avatar` must exist and be an image.
- `characters/<id>/lib/*.ts`: see "Function library". A file that is not one function expression (or whose stem is not a valid name) is a `warning:` and skipped; the caps are problems.
- `capabilities` (pack.json and character.json) is a **legacy key**: permissions are app-wide (Settings → Permissions), packs declare none. The schemas accept the key with any value, strip it from the parsed `PackManifest` / `CharacterDefinition` (the types have no such field), and `inspectPack`/`validatePack` add the warning `warning: <file>: "capabilities" is ignored; permissions are set in the app under Settings → Permissions`. `scaffoldPack`, `writeManifest` and `writeCharacter` never write it.
- `mediaRoot` default `media`; may not exist (a pack can have no media).
- File names inside the pack must not contain `..` segments or be absolute.

## Function library (`characters/<id>/lib/`)

The character's `sdk.lib` functions live in the pack, one file per function: `characters/<id>/lib/<name>.ts`. The file is an optional first line `// <description>` followed by the function expression exactly as `sdk.lib.define` received it (arrow or `async function`):

```ts
// show a picture for a mood
async (mood: string) => {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}
```

- `<name>` is the function name: `^[a-zA-Z_$][\w$]*$`, at most 64 characters, no JavaScript reserved words, not `__proto__` (`LIB_NAME_PATTERN` / `LIB_NAME_MAX_CHARS` in `@rp/shared`). Only regular `.ts` files count; a `README.md`, sub-folders and dotfiles in `lib/` are ignored.
- **Internal helpers.** A first line of `// @internal` (optionally `// @internal <description>`, `LIB_INTERNAL_MARKER` in `@rp/shared`) marks a function as the author's plumbing: `parseLibraryFile` returns `internal: true` and the loader sets it on the entry, `formatLibraryFile(source, description?, internal?)` and `writeLibraryFunction(…, description?, internal?)` write the marker back. Everything else about the file is unchanged (name rules, the one-function-expression check, the caps). What it means for the character is core's business (docs/spec/core.md "LibraryService"): its own functions and the pack's behaviour hooks call it, the character itself never sees it.
- The loader reads the folder into `LoadedCharacter.library: Record<name, { source; description?; internal?; bytes; file; updatedAt }>` (sorted by name; `updatedAt` is the file's mtime) and checks each source with `functionSourceProblem` — the same esbuild "exactly one function expression" check `LibraryService` applies to `sdk.lib.define`, so both cannot drift. A file that fails is reported as `warning: characters/<id>/lib/<name>.ts: not a single function expression: …` and left out; the pack still loads.
- Caps, reported as problems: 50 files (`LIB_MAX_FUNCTIONS`), 128 KiB in total (`LIB_MAX_TOTAL_BYTES`). A single file has no size cap — the total is what bounds the prelude prepended to every run.
- `readCharacterLibrary(rootAbs, charDir, { previous })` reuses entries whose source text is unchanged, so core's rescan after every `define` stays cheap. `writeLibraryFunction` writes atomically (temp file + rename) and `removeLibraryFunction` deletes; core calls both against the installed copy, so what a character defines lands next to what the author shipped. `scaffoldPack` creates `lib/README.md` (`libraryReadme`) explaining the format. `packDirectory` zips the folder like any other pack file.

## Asset kinds

image: png jpg jpeg gif webp avif svg bmp — video: mp4 webm mkv mov m4v — audio: mp3 wav ogg m4a flac aac opus — text: txt md json csv — else other. Provide a mime table for these.

## Example packs (create under `examples/packs/`)

1. `examples/packs/luna/` — companion character "Luna" with persona.md, avatar (generate a small PNG programmatically in a script or commit a tiny 1×1/16×16 PNG), 2 images and 1 short generated WAV (write a tiny sine-wave WAV file with a script; keep < 100 KB), behaviours `on-session-start.ts` (calls `sdk.llm.wake` with a time-aware greeting brief and `sdk.state.set('sessions', n+1)`), and `on-timer.ts`. Uses `media` and `ui` (no declaration needed: permissions are app-wide).
2. `examples/packs/minimal/` — one character, no media, no behaviours. Used by tests as the smallest valid pack.

Also add `examples/packs/README.md` documenting the format for pack authors (copy §8 of ARCHITECTURE.md and expand with the behaviour hooks and a full SDK usage example).

## Tests

- schema accepts the examples and rejects: bad id, missing characters, `..` in paths, absolute paths
- loadPack on `examples/packs/luna` yields 1 character, persona text, behaviour sources, asset index with correct kinds; on `examples/packs/makima` the shipped `lib/glance.ts` loads with its description
- a second character (listed in `pack.json`, or only present on disk) is a problem; a directory under `characters/` without a `character.json` is not a character
- library files: read sorted with descriptions; a `// @internal` first line sets `internal` and keeps the rest of the line as the description; bad ones skipped with a warning; caps are problems; `writeLibraryFunction`/`removeLibraryFunction` round-trip and leave no temp files; `packDirectory` → `extractPack` carries `lib/*.ts`
- resolveAssetPath rejects `../x`, `/etc/passwd`, `media\\..\\x`, and a symlink pointing outside root (create in a temp dir)
- packDirectory → extractPack round-trips byte-for-byte; extractPack rejects a hand-built zip containing `../evil.txt`
