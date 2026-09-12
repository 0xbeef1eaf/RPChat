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
- Auto-tagging (`editor/tagger.ts`, `editor/images.ts`): `suggestMediaTags(key, paths, options)` asks a
  vision model (qwen3-vl on a local OpenAI-compatible server, Claude, …) for tags and a description per
  asset and returns `MediaTagSuggestion[]` — it never writes; the renderer folds accepted suggestions into
  its `media.json` draft. One provider call per asset (at most `MAX_TAG_BATCH` = 25 per call, 180 s each):
  PNG and JPEG are decoded and downscaled to 768 px by `electronImageReader` (JPEG, PNG when the art
  has alpha) — Electron's `nativeImage` reads nothing else, so every other image (WebP, AVIF, GIF, BMP,
  SVG) and every video arrives as a still the renderer decoded with a canvas (`options.frames[path]`);
  text files are quoted, audio and anything else is tagged from its name only. `basis` says which, and
  a frame for a non-video asset still counts as `image`. The prompt carries the pack name and
  description, the character names, the asset's folder tags (never suggested again), its current tags and
  description, the tag vocabulary with meanings and the other tags in use, so the model reuses the
  author's vocabulary; the answer is one JSON object (`tags`, `description`, `meanings`) parsed
  tolerantly, normalised with `normalizeTag`, capped at `options.maxTags` and — with `vocabularyOnly` —
  restricted to known tags. A provider that is not vision-capable, a missing provider, a timeout or a
  provider error becomes a per-asset `error` (the run itself only throws when no provider resolves).
  `options.jsonSchema` additionally constrains the answer with `response_format`
  (`TAG_RESPONSE_SCHEMA`); off by default because not every OpenAI-compatible server accepts a schema,
  but it is what makes a reasoning model answer at all instead of spending `TAG_MAX_TOKENS` thinking.
  `options.reasoningEffort` (`none` …) is the other half of that: on a model that honours it the
  answer costs tens of tokens instead of thousands. Both are surfaced in the auto-tag dialog.
  `options.learned` carries the tags and meanings a run has coined so far into the pack context
  (the dialog makes one call per asset, so `media.json` — unsaved until the author says so — is
  otherwise all main can see); blank meanings are dropped. Within one run each answer is folded back into
  the pack context (`absorbSuggestion`): tags it coined count as in use and meanings it gave join
  the vocabulary for the assets still to come, so a run over a whole pack converges on one word per
  idea instead of `cosy`/`cozy`/`snug`. A meaning the author wrote is never overwritten.
- `apps/desktop/scripts/tag-media.ts` runs the same tagging from the command line and *writes*
  `media.json` (`node --experimental-transform-types apps/desktop/scripts/tag-media.ts <pack> [asset …]`).
  It imports `MediaTagger`, the renderer's `applySuggestions`/`fromEditModel` and `writeMediaManifest` so
  the two paths cannot drift; only the decoding differs — ImageMagick instead of `nativeImage`, ffmpeg
  instead of a `<video>` element — and it defaults to `--reasoning-effort none` with the schema on,
  because a local thinking model is otherwise unusable for tagging. `--debug` wraps the provider to
  print each request and stream the answer, `--dry-run` prints the manifest instead of writing it.
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
- Media → auto-tagging: the dialog also carries "Thinking" (`reasoningEffort`, empty = leave it to the
  model) and "Hold the model to the answer format" (`jsonSchema`), both off by default because
  `response_format` and the `none`/`max` levels are not universal; `tagOptions()` builds the options
  for both the dialog run and the per-asset ✨ button so a setting cannot reach one and miss the other.
- Media → auto-tagging: "✨ Auto-tag…" opens a dialog (provider limited to vision-capable ones with a
  model field and "Fetch" models, scope = untagged only / everything currently listed, tags per asset,
  free-text guidance, and switches for vocabulary-only, adding new tags to the vocabulary, replacing tags
  instead of merging, overwriting written descriptions). It runs the assets one at a time with a progress
  line and a Stop button, decoding a still for anything main cannot read (`needsRendererFrame` →
  `frameFor` in `lib/frames.ts`: `<video>` for video, `<img>` + canvas for WebP/AVIF/GIF/BMP/SVG), then shows
  every suggestion (tags, description, a badge when the model only saw a frame, the text or the file name)
  with per-asset checkboxes; "Apply" folds them into the draft, which the author still has to save. Each
  asset card also has a "✨ Suggest" button that applies one suggestion straight away with the dialog's
  current settings. Pure helpers in `lib/tagging.ts` (provider filtering, scope, merge, vocabulary).
- README: textarea + preview.
- Check & publish: validation problems/warnings list (re-run button), export, install to app, "Start a chat with …" after install.
- Tests: pure helpers (id suggestion/slug, media.json ↔ per-asset edit model, dirty tracking reducer).
