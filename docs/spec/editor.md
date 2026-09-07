# Pack editor

Goal: build and maintain packs inside the app without touching files by hand. A **project** is a
pack folder on disk (by default under `<userData>/workspace/<packId>/`, or any folder the user
opens). Every edit is written straight to the folder in the canonical pack format, so a project is
always a valid-or-diagnosed pack that can be exported (`.rppack`) or installed into the app.
Contracts: `@rp/shared/editor.ts` and `IpcApi.editor`.

## @rp/pack — writers and scaffolding (pure fs helpers)

```ts
scaffoldPack(dir, { packId, name, characterId, characterName }): Promise<void>   // pack.json, README.md, media/{images,video,audio}/.gitkeep-less dirs, media.json ({entries:[],tags:{}}), characters/<id>/{character.json, persona.md (template), scripts/}
writeManifest(dir, manifest): Promise<void>                                       // validates first (PACK_INVALID), pretty JSON, stable key order
writeCharacter(dir, charDir, definition, personaText, behaviours): Promise<void>  // character.json, persona file, scripts/<hook>.ts (removed when the hook is absent), keeps unknown files
writeMediaManifest(dir, manifest): Promise<void>
writeReadme(dir, text): Promise<void>
addAssetFile(dir, sourceFile, { kind? }): Promise<AssetEntry>                     // copies into `<mediaRoot>/<images|video|audio|text|other>/<name>`, de-duplicates names (`name-2.png`), rejects unsupported kinds
removeAsset(dir, assetPath): Promise<void>                                        // deletes the file and drops exact-path media.json entries
personaTemplate(name): string; behaviourTemplates(): BehaviourTemplate[]           // onSessionStart / onUserMessage / onTimer / onEvent / onSessionEnd / onInstall starter scripts with comments
slugify(name): string                                                             // character id from a name
```
Tests: scaffold → loadPack ok; write/read round trips; addAssetFile naming; removeAsset cleans media.json.

## Desktop main — `EditorService` (`src/main/editor/`)

- Registry of open projects in `<userData>/data/editor-projects.json` (`{ key, dir }`), key = sha1(dir) first 12 chars.
- `read(key)` = `loadPack` (tolerant: on `PACK_INVALID` still return manifest/characters that parse, with `validation.problems` filled) + `validatePack` + `summariseTags` + per-asset `folderTags`/`manifestTags` split (from `folderTagsFor` and the manifest entries) + `rp-asset://` URLs.
- Assets served for previews: the asset protocol accepts `rp-asset://editor-<key>/<path>` for registered project dirs (same path guard as installed packs).
- Pickers via `dialog.showOpenDialog`; `addMediaFiles` accepts absolute paths from renderer drag and drop (`File.path` via `webUtils.getPathForFile` in preload — expose `editor.pathsForFiles` if needed; simpler: renderer passes `webUtils.getPathForFile(file)` obtained in preload through a small `app.pathForFile(file)` helper added to the preload API only, not to IpcApi).
- `installToApp` → `engine.packs.install(dir)` (replaces an installed pack with the same id, keeping grants). `exportPack` → `dialog.showSaveDialog` + `packDirectory`. `importInstalled` → copies the installed root into the workspace (refuses if a project with the same dir exists).
- `revealInFolder` → `shell.showItemInFolder`.
- Tests: registry persistence, key derivation, asset URL mapping, tolerant read of a broken manifest.

## Renderer — "Pack editor" route

- Project list: cards (name, id, version, characters, installed badge), "New pack" (form: name → id suggestion `com.<user>.<slug>`, first character name), "Open folder", "Import installed pack…" (select from installed), remove from list (does not delete files).
- Editor layout: left rail with sections **Pack**, **Characters** (one entry per character + add), **Media**, **README**, **Check & publish**; sticky header with pack name, "Install to app", "Export .rppack", "Reveal folder", validation status pill (ok / N problems / N warnings).
- Pack: id (locked after creation with an "advanced" unlock), name, version (semver hint), description, author name/url, license, homepage, tags (chips), capabilities checklist from `capabilities.list()` grouped by permission with summaries (trusted ones shown as always-on, not selectable), min app version.
- Character: id (locked after creation), name, tagline, greeting, avatar (preview + pick), persona editor (textarea with monospaced font, word count, and a side-by-side markdown preview toggle), example dialogue (list of user/character pairs), behaviours (per hook: enable toggle → code editor textarea with the template inserted, "Insert template"), extra capabilities checklist, model hints (temperature, max tokens, model), avatarSet expressions (name → pick file, default expression select, size), mood baselines (two sliders). Save button (dirty tracking) + Ctrl/Cmd+S.
- Media: grid/list of assets with thumbnails (images), kind badge, size; drag-and-drop zone + "Add files" button; per asset: folder tags (read-only chips), editable manifest tags (chips input with suggestions from the vocabulary), description; the editor maintains `media.json` as one exact-path entry per asset plus a "Rules" panel for glob entries (match, tags, description) and a "Tag vocabulary" table (tag → meaning, unused tags flagged). Remove asset with confirm.
- README: textarea + preview.
- Check & publish: validation problems/warnings list (re-run button), export, install to app, "Start a chat with …" after install.
- Tests: pure helpers (id suggestion/slug, media.json ↔ per-asset edit model, dirty tracking reducer).
