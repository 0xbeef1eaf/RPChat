# @rp/pack — Pack format: schema, loader, validator, zip

Depends on: `@rp/shared`, `zod` (v4), `fflate` (zip), Node `fs/promises` + `path`.

## Exports

```ts
export const packManifestSchema: z.ZodType<PackManifest>;
export const characterDefinitionSchema: z.ZodType<CharacterDefinition>;
export function validateManifest(json: unknown): PackManifest;       // throws RpError('PACK_INVALID', msg, { issues })
export function validateCharacter(json: unknown): CharacterDefinition;
export function loadPack(root: string): Promise<LoadedPack>;          // reads pack.json, every character dir, persona.md, behaviour scripts, README.md, indexes assets
export function validatePack(root: string): Promise<{ ok: boolean; problems: string[] }>;  // never throws for content errors
export function indexAssets(root: string, mediaRoot?: string): Promise<AssetEntry[]>;      // recursive; includes character avatars; kind by extension; mime by extension table
export function resolveAssetPath(root: string, relative: string): string;  // normalises, rejects absolute/`..`/backslash tricks, returns absolute path; throws RpError('PATH_ESCAPE'); must also realpath-check that the resolved file stays under root (symlink escape)
export function packDirectory(root: string, destinationFile: string): Promise<void>;       // validates first; writes .rppack (zip, deflate) with paths relative to root; skips dotfiles, node_modules
export function extractPack(file: string, destinationDir: string): Promise<LoadedPack>;    // zip-slip safe, rejects absolute/`..` entries; then loadPack
export function readManifestFromArchive(file: string): Promise<PackManifest>;             // peek without extracting
export function requestedCapabilities(pack: LoadedPack): string[];                           // pack + character level, deduped, sorted
export function assetKindFor(path: string): AssetKind; export function mimeFor(path: string): string;
```

## Validation rules

- `id`: /^[a-z0-9]+(\.[a-z0-9-]+)+$/ ; `version`: semver (simple regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`); `formatVersion === 1`
- `characters` non-empty; each entry a relative dir containing `character.json`; character ids unique in pack; `persona` file must exist; `behaviours` files must exist and end with `.ts` or `.js`; `avatar` must exist and be an image.
- `capabilities` entries: /^[a-z][a-zA-Z0-9]*$/ (existence against the registry is checked by core, not here).
- `mediaRoot` default `media`; may not exist (a pack can have no media).
- File names inside the pack must not contain `..` segments or be absolute.

## Asset kinds

image: png jpg jpeg gif webp avif svg bmp — video: mp4 webm mkv mov m4v — audio: mp3 wav ogg m4a flac aac opus — text: txt md json csv — else other. Provide a mime table for these.

## Example packs (create under `examples/packs/`)

1. `examples/packs/luna/` — companion character "Luna" with persona.md, avatar (generate a small PNG programmatically in a script or commit a tiny 1×1/16×16 PNG), 2 images and 1 short generated WAV (write a tiny sine-wave WAV file with a script; keep < 100 KB), behaviours `on-session-start.ts` (calls `sdk.chat.say` with a time-aware greeting and `sdk.state.set('sessions', n+1)`), and `on-timer.ts`. Capabilities: media, ui.
2. `examples/packs/minimal/` — one character, no media, no behaviours. Used by tests as the smallest valid pack.

Also add `examples/packs/README.md` documenting the format for pack authors (copy §8 of ARCHITECTURE.md and expand with the behaviour hooks and a full SDK usage example).

## Tests

- schema accepts the examples and rejects: bad id, missing characters, `..` in paths, absolute paths
- loadPack on `examples/packs/luna` yields 1 character, persona text, behaviour sources, asset index with correct kinds
- resolveAssetPath rejects `../x`, `/etc/passwd`, `media\\..\\x`, and a symlink pointing outside root (create in a temp dir)
- packDirectory → extractPack round-trips byte-for-byte; extractPack rejects a hand-built zip containing `../evil.txt`
