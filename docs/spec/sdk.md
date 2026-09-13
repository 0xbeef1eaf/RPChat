# @rp/sdk — Capability registry, standard modules, typings/docs generation

Depends on: `@rp/shared` only. Pure TypeScript, no Node APIs beyond what tests need.

## Exports (`src/index.ts`)

```ts
export class CapabilityRegistry {
  register(spec: CapabilityModuleSpec): void;            // throws RpError('INVALID_ARGUMENT') on duplicate id / invalid spec
  get(id: string): CapabilityModuleSpec | undefined;
  list(): CapabilityModuleSpec[];                        // stable order: registration order
  has(id: string): boolean;
  /** Effective permission for a method (method override or module default). */
  permissionFor(module: string, method: string): PermissionLevel;   // throws CAPABILITY_UNKNOWN
  methodSpec(module: string, method: string): CapabilityMethodSpec;   // throws CAPABILITY_UNKNOWN
}
export function createStandardRegistry(): CapabilityRegistry;          // all v1 modules registered
export function validateModuleSpec(spec: CapabilityModuleSpec): string[]; // list of problems, [] = valid
export function generateSdkTypings(registry, options?: { modules?: string[] }): string;
export function generateSdkDocs(registry, options?: { modules?: string[]; deniedModules?: string[] }): string;
// Prompt reference generated from the type definitions: rules, then per module one entry per method —
// `- name(sig): ret — TSDoc summary`, every `@param`, `@returns`, the first `@example` — helper types on one
// line, one module example; shared preamble types only when referenced; ungranted modules are not mentioned.
export function generateSdkIndex(registry, options?: { modules?: string[]; deniedModules?: string[]; helperTypes?: boolean }): string;
export function describeSurface(registry, options?: { modules?: string[] }): SdkSurface;
export const SDK_PREAMBLE_TYPINGS: string;  // shared helper types (AssetRef, MediaHandle, ...)
export * as modules from './modules/index.js';   // chatModule, logModule, stateModule, packModule, timersModule, mediaModule, uiModule, systemModule
```

`options.modules` filters to the granted modules (used by core when building prompts and sandbox surface).

## Generated typings format

```ts
// ---- rp-code character SDK (generated) ----
<SDK_PREAMBLE_TYPINGS>
/** The SDK available to character code as the global `sdk`. */
declare const sdk: Sdk;
interface Sdk {
  /** <summary> (permission: pack) */
  media: MediaApi;
  ...
}
declare const console: { log(...a: unknown[]): void; ... };   // maps to sdk.log
declare const lib: { [name: string]: (...args: any[]) => any };  // the character's function library (LIB_TYPINGS); defined at run time by CodeRunRequest.prelude
<each module's typings verbatim, separated by a `// ---- module: <id> vX.Y.Z ----` banner>
```

`validateModuleSpec` must check: id pattern, semver, `typings` contains `interface <apiTypeName>`, every key of `methods` appears as a member `name(` in the interface source, and every method-looking member in the interface (`^\s+(\w+)\s*[(<]` at the top nesting level of the interface body) is present in `methods`. Keep the check regex-based; do not pull in the TypeScript compiler at runtime. (A vitest test may use `typescript` transpile to assert the generated d.ts compiles with no diagnostics — do that.)

## Preamble helper types

```ts
/** Reference to a file inside the current pack, obtained from `sdk.pack.asset()`. */
interface AssetRef { readonly path: string; readonly kind: 'image'|'video'|'audio'|'text'|'other'; readonly mime: string; readonly bytes: number }
type MediaPosition = 'center'|'top-left'|'top-right'|'bottom-left'|'bottom-right';
interface ShowImageOptions {...}  interface PlayVideoOptions {...}  interface PlayAudioOptions {...}   // mirror @rp/shared/media exactly
interface MediaHandle { readonly id: string; readonly kind: 'image'|'video'|'audio'; readonly asset: string }
interface HistoryMessage { role: 'user'|'assistant'; text: string; at: string }
interface TimerInfo { id: string; fireAt: string; payload: unknown; label?: string }
type Json = null|boolean|number|string|Json[]|{[k:string]:Json};
```

## Standard modules — exact method signatures (put these in `typings` with full TSDoc)

chat (trusted)
- `say(text: string): Promise<void>` — append an assistant message now (shown immediately, before the LLM's next text).
- `emote(text: string): Promise<void>` — append an italic action line ("*smiles*").
- `history(limit?: number): Promise<HistoryMessage[]>` — most recent messages, newest last, default 20, max 100.
- `setStatus(text: string | null): Promise<void>` — one-line status shown under the character name (e.g. "thinking about dinner").

log (trusted)
- `debug/info/warn/error(...args: unknown[]): void` — captured into the action result. `console.*` inside the sandbox maps here.

state (trusted)
- `get(key: string): Promise<Json | undefined>`, `set(key: string, value: Json): Promise<void>`, `delete(key: string): Promise<void>`, `keys(): Promise<string[]>`, `all(): Promise<Record<string, Json>>` — persistent per character (across sessions).
- `session: { get, set, delete, keys, all }` — same but per session. NOTE: nested object; the surface describes nested members with dotted method names `session.get` etc. The sandbox proxy must support one level of nesting: `SdkSurface.modules[].methods` may contain `"session.get"`.

pack (trusted)
- `asset(path: string): Promise<AssetRef>` — validate & describe a file; throws NOT_FOUND / PATH_ESCAPE.
- `listAssets(prefix?: string, kind?: AssetRef['kind']): Promise<AssetRef[]>`
- `readText(path: string, maxBytes?: number): Promise<string>` — text assets only, default max 64 KiB.
- `info(): Promise<{ id: string; name: string; version: string; description?: string; characterId: string; characterName: string }>`

timers (trusted)
- `schedule(delayMs: number, payload: Json, opts?: { label?: string }): Promise<TimerInfo>` — min 1000 ms, max 7 days; fires an `onTimer` behaviour or wakes the LLM with the payload.
- `cancel(id: string): Promise<boolean>`
- `list(): Promise<TimerInfo[]>`

lib (trusted) — the character's own function library, persisted per character (core: `LibraryService`, docs/spec/core.md)
- `define(name: string, fn: ((...args: any[]) => unknown) | string, opts?: { description?: string }): Promise<LibFunctionInfo>` — save or replace a function. `fn` crosses the boundary exactly like a `Handler`: the sandbox serialises a function argument to the action body `return await (<its compiled source>)(input);` (docs/spec/sandbox.md §4) and core unwraps that to the function expression; a string holding a function expression is accepted as is. Names `^[a-zA-Z_$][\w$]*$`, ≤ 64 chars, no reserved words; ≤ 50 functions per character, ≤ 16 KiB per source, ≤ 128 KiB in total; the source must parse (esbuild) as a single function expression → `INVALID_ARGUMENT` otherwise.
- `remove(name: string): Promise<boolean>`, `list(): Promise<LibFunctionInfo[]>`, `source(name: string): Promise<string>` (NOT_FOUND).
- `LibFunctionInfo { name; description?; bytes; updatedAt }` is declared in the module typings. A library function may be async and may use `sdk` and `lib` (its siblings) but nothing else from the defining action's scope; redefining a name replaces it. Every later run (action, timer handler, event handler, behaviour hook) sees `lib.<name>(...)`; the prompt lists the library under `<library>`. Docs example: `await sdk.lib.define("cheer", async (mood: string) => { … }, { description: "show a picture for a mood" })`, then `await lib.cheer("happy")`.

media (pack)
- `showImage(asset: AssetRef | string, options?: ShowImageOptions): Promise<MediaHandle>`
- `playVideo(asset: AssetRef | string, options?: PlayVideoOptions): Promise<MediaHandle>`
- `playAudio(asset: AssetRef | string, options?: PlayAudioOptions): Promise<MediaHandle>`
- `close(handle: MediaHandle | string): Promise<void>`
- `closeAll(): Promise<void>`
- `list(): Promise<MediaHandle[]>`

ui (pack)
- `notify(title: string, body?: string, opts?: { urgency?: "low" | "normal" | "critical" }): Promise<void>` — OS notification; `low` is silent, `critical` stays until dismissed.
- `confirm(question: string): Promise<boolean>` — a window of its own, in front of the user; the user answers.
- `choose(question: string, options: string[]): Promise<string | null>`

browser (pack, v2.1.0; docs/browser-extension.md) — `open`, `openTab`, `close`, `navigate`, `click`, `type`, `screenshot`, `block`, `imageEffect`, `setHomePage`, `addBookmark`, `removeBookmark`, `eval` are `dangerous: true`
- `open(url: string, options?: { newWindow?: boolean }): Promise<BrowserTab | null>` — the extension when connected (returns the tab), else the browser command template (returns null).
- `status(): Promise<{ connected: boolean; browser?: string }>`
- `tabs(): Promise<BrowserTab[]>`, `openTab(url, { active?, newWindow? }): Promise<BrowserTab>`, `activate(tabId)`, `close(tabId)`, `navigate(tabId, url)`, `back/forward/reload(tabId)` — all `BrowserTab` (`{ id, windowId, url, title, active, index }`).
- `read(tabId?, { maxChars? }): Promise<{ url; title; text }>` (default cap 20 000 chars; tabId defaults to the active tab), `query(tabId, selector, { limit? }): Promise<BrowserElement[]>` (`{ index, tag, text, href?, value? }`), `click(tabId, selector, { index? })`, `type(tabId, selector, text, { submit? })`, `scroll(tabId, { y? | selector? })`, `screenshot(tabId?): Promise<{ dataUrl; url; title }>` (PNG data URL), `find(tabId, text): Promise<{ count; first? }>`.
- `block(patterns, { durationMs?, redirect?, reason? }): Promise<{ id; expiresAt; patterns }>` (no duration = until lifted; 127.0.0.1/localhost/browser pages refused), `unblock(id)`, `blocks(): Promise<BrowserBlock[]>`, `clearBlocks()`.
- `imageEffect(tabId, effect, { selector?, replaceWith?: AssetRef | string, durationMs? }): Promise<{ applied; replaced; total }>` (`effect`: `blur | grayscale | sepia | invert | hue | pixelate | none | { css }`; pack assets are served through the loopback asset route), `clearImageEffects(tabId)`.
- `setHomePage(url | null)`, `homePage()` — the extension's new-tab override and the policy's `HomepageLocation`.
- `bookmarks({ folder? })`, `searchBookmarks(query)`, `addBookmark(url, title, { folder? })`, `removeBookmark(idOrUrl)` — `BrowserBookmark` = `{ id, title, url?, parentId, path }`.
- `eval(tabId, code, { world?: "isolated" | "main", timeoutMs? }): Promise<{ value; world; fallback? }>` — the code is an async function body; result JSON, 64 KiB cap. The isolated world refuses eval under the MV3 extension CSP, so the extension falls back to the main world and reports it (`fallback`); the main world is subject to the page's CSP.
- `history({ text?, since?, until?, limit? })`, `historyVisits(url)`, `recentHistory(limit?)` — `BrowserHistoryItem` = `{ url, title, lastVisitTime, visitCount }`.
- Only http(s) URLs; `settings.web.allowlist` applies to every URL opened, navigated to, bookmarked, redirected to or set as home page. Every method but `open` (and `setHomePage`/`homePage`, which read and write the setting) throws `CAPABILITY_FAILED` while no extension is connected; `block`, `eval` and the history methods throw `CAPABILITY_FAILED` with a message naming the toggle when `settings.browser.allowBlocking` / `allowEval` / `allowHistory` is off.

system (pack; was `prompt` before per-call prompts were dropped) — every method `dangerous: true`
- `openExternal(url: string): Promise<void>` (http/https only)
- `exec(command: string, args?: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>`
- `readFile(path: string, maxBytes?: number): Promise<string>`
- `writeFile(path: string, text: string): Promise<void>`
- `clipboardWrite(text: string): Promise<void>`

## Docs for the LLM

The prompt builder injects `generateSdkIndex` (not the full typings + docs); the `help` module (`sdk.help.modules()`, `sdk.help.module(id)`, trusted) returns a granted module's complete `typings` and `docs` on demand. The first code fence of `docs` doubles as the module's example in the index, so keep it short and representative.

Each module's `docs` is 5–20 lines of markdown: purpose, when to use, 1–2 short code examples, pitfalls. `generateSdkDocs` prefixes a general section: code is the body of an async function, `sdk` is global, `await` every call, return small JSON, keep actions short, do not busy-loop, prefer one action per intention, denied modules list.

## Tests (vitest)

- registry registration, duplicate rejection, permissionFor with overrides
- validateModuleSpec catches a method missing from `methods` and vice versa
- generated typings compile (use `typescript` transpileModule / createProgram in-memory with `noEmit`, asserting zero semantic diagnostics; `typescript` as devDependency)
- describeSurface lists nested `session.get` for state
- filtering by granted modules omits typings and lists denied ones in docs
