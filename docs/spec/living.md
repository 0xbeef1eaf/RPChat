# Phase 2 — "living on the PC": senses, events, body, voice, desktop control, inner life

Contracts: `@rp/shared/senses.ts` (PresenceSnapshot, NowPlaying, CalendarEvent, HostEventName,
HostEvent, EventSubscription, MoodState, RoutineEntry/Status, MessagingChannel), `media.ts`
(OverlayKind, AvatarState, DrawShape, WidgetSpec, new MediaCommand/MediaWindowEvent members),
`settings.ts` (new command templates, `senses`, `web`, `desktop`, `messaging`, `permissions`),
`storage.ts` (`subscriptions`), `chat.ts` (new ChatEvents, origins), `capability.ts`
(`preauthorize`, `onEvent` hook, `event` trigger), `llm.ts` (image ContentPart, `supportsVision`),
`pack.ts` (`avatarSet`, `mood` in character.json), `ipc.ts` (`characters.status`, `events`,
`senses`, `packs.inspect`, `InstalledPackView.effectiveCapabilities/blockedByPolicy`, `PackInspection`).

Everything below is additive. Cross-pack character messaging is explicitly out of scope.

## 1. SDK modules (`@rp/sdk`) — ids, permission, methods

Rules: every method has full TSDoc; `docs` ≤ 20 lines with one example; method-level
`permission: 'prompt'` overrides where marked (P); `dangerous: true` where marked (D).
New preamble types: `PresenceSnapshot`, `NowPlaying`, `CalendarEvent`, `HostEventName`,
`EventSubscriptionInfo { id; event; label?; once?; fired }`, `MoodState`, `RoutineEntry`,
`RoutineStatus`, `AvatarStateInfo` (= AvatarState minus imageUrl), `DrawShape`, `WidgetInfo { id; title? }`,
all mirroring `@rp/shared` (add them to the structural-identity test where they mirror exactly).

| module | perm | methods |
|---|---|---|
| `presence` | pack | `status(): PresenceSnapshot`; `nowPlaying(): NowPlaying \| null`; `activeWindow(): {title,app,class?} \| null`; `idleMs(): number` |
| `screen` | pack | `look(opts?: { monitor?: MonitorSelector; question?: string }): { description: string; width; height }` (D) — screenshot described by a vision model; `draw(shapes: DrawShape[], opts?: { monitor?; durationMs? }): { ids: string[] }`; `clear(ids?: string[]): void` |
| `calendar` | pack | `upcoming(hours?: number): CalendarEvent[]` (default 24 h, max 14 d); `today(): CalendarEvent[]` |
| `web` | pack | `fetch(url, opts?: { method?: 'GET'\|'POST'; headers?; body?: string; maxBytes? }): { status; headers; text }` (D; restricted to the allowlist when one is set); `rss(url, limit?): Array<{ title; link; published?; summary? }>` (allowlist likewise); `weather(place: string): { place; tempC; feelsLikeC; condition; windKph; humidity; forecast: Array<{ day; minC; maxC; condition }> }` (open-meteo, always allowed) |
| `events` | trusted | `on(event: HostEventName, code: string, opts?: { filter?: Record<string, Json>; input?: Json; once?: boolean; label?: string }): EventSubscriptionInfo`; `off(id): boolean`; `list(): EventSubscriptionInfo[]`; `emit(name: string, data?: Json): void` (custom `custom:<name>` events a character can raise for its own subscriptions) |
| `avatar` | pack | `show(opts?: { expression?; size?; monitor?; position?; x?; y?; layer?; opacity?; clickThrough?; lookAtCursor? }): AvatarStateInfo`; `set(patch: { expression?; size?; lookAtCursor?; opacity?; clickThrough? }): AvatarStateInfo`; `say(text, opts?: { durationMs? }): void` (speech bubble); `animate(name: AvatarAnimation): void`; `moveTo(target: { monitor?; position?; x?; y? }, opts?: { durationMs? }): void`; `hide(): void`; `state(): AvatarStateInfo \| null`; `expressions(): string[]` |
| `widgets` | pack | `show(spec: { id?; title?; html; width?; height? } & OverlayOptions): WidgetInfo`; `update(id, patch: { html?; title?; postMessage?: Json }): void`; `close(id): void`; `closeAll(): void`; `list(): WidgetInfo[]` |
| `voice` | pack | `speak(text, opts?: { rate?: number; voice?: string; wait?: boolean }): void`; `stop(): void`; `listen(opts?: { maxSeconds?: number }): { text: string }` (D) |
| `desktop` | pack | `launch(app: string, args?: string[]): { pid?: number }` (D; restricted to launchAllowlist when one is set); `listWindows(): Array<{ id; title; app; monitor?; workspace?; focused }>`; `focusWindow(match: { id?; title?; app? }): boolean`; `moveWindow(match, to: { monitor?; x?; y?; width?; height?; workspace? }): boolean`; `workspace(target: string \| number): void`; `currentWorkspace(): { id; name }`; `setVolume(level: number): void`; `getVolume(): number \| null`; `setBrightness(level): void`; `doNotDisturb(on: boolean): void`; `setTheme(theme: 'dark'\|'light'): void` |
| `input` (v1.1) | pack | existing lock/unlock/status + `type(text)`, `key(combo)`, `click(x, y, button?)`, `moveMouse(x, y)` (all D; no per-call prompt once granted) |
| `files` | pack | character home dir: `write(path, text): void`; `append(path, text): void`; `read(path, maxBytes?): string`; `list(prefix?): Array<{ path; bytes; modifiedAt }>`; `delete(path): boolean`; `open(path): void` (open with the default app, D); `homePath(): string` |
| `mood` | trusted | `get(): MoodState`; `nudge(delta: { mood?: number; energy?: number }, reason: string): MoodState` (deltas clamped ±0.5); `set(state: { mood?; energy?; tags? }, reason: string): MoodState` |
| `routine` | trusted | `set(entries: RoutineEntry[]): RoutineStatus`; `get(): { entries: RoutineEntry[]; status: RoutineStatus }`; `now(): RoutineStatus`; `override(state: RoutineStateName, opts?: { minutes?: number; label? }): RoutineStatus` |
| `messaging` | pack | `send(channel: string, text: string): { ok: boolean }` (D); `channels(): Array<{ name; kind }>` |
| `system` (v1.1) | pack | + `clipboardRead(): string` (D) |

`presence` docs must say: prefer the `<senses>` line already in the prompt; call `status()` only for
fresh numbers inside an action.

## 2. LLM (`@rp/llm`)

Map `image` ContentParts: Anthropic `{ type: 'image', source: { type: 'base64', media_type, data } }`;
OpenAI `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }`. `supportsVision`
default: true for anthropic, false for openai-compatible unless set. When a request carries images and
the provider config says no vision, replace them with a text part `[image omitted: model has no vision]`.
Tests for both mappings.

## 3. Core (`@rp/core`)

### 3.1 Host integration surface (what desktop calls / provides)

```ts
EngineOptions {
  ...,
  senses?: SensesProvider;       // host → core
}
interface SensesProvider {
  snapshot(sessionId?: string): Promise<PresenceSnapshot>;     // host samples; core adds sinceLastMessageMs/localTime/dayPart if missing
  /** Host pushes raw events (window-changed, user-idle/back, battery-low, screen-locked/unlocked, song-changed, file-added, widget-message, avatar-clicked). */
  subscribe(listener: (event: HostEvent) => void): () => void;
  /** Called with the union of event names any live subscription needs, so the host only samples what is used. */
  setInterest?(events: HostEventName[]): void;
}
engine.hostEvents.emit(event: HostEvent): void;       // alternative to subscribe(), same effect
engine.mood.get(characterRef); engine.routine.status(characterRef); engine.routine.entries(characterRef);
engine.subscriptions.list(sessionId?); engine.subscriptions.remove(id);
engine.packs.inspect(sourcePath): Promise<PackInspection>;
engine.permissions.effective(packId): { effective: string[]; blockedByPolicy: string[] };
```

### 3.2 Permission policy (intersection)

`PermissionService.isAllowed`: for non-trusted modules require (1) the pack requested the module
(pack or character level), (2) `settings.permissions.moduleAllow[module] !== false`, (3) the per-pack
grant is true. Install sets per-pack grants to `moduleAllow[module] !== false` (so the effective set is
the intersection out of the box; the user can narrow further per pack). Changing the global policy
does not rewrite per-pack grants; it is applied at check time and reflected in
`InstalledPackView.effectiveCapabilities`/`blockedByPolicy`. The prompt's SDK reference is filtered to the
effective set; blocked modules are listed as not available with the reason "denied by your settings".
`prompt`-level methods: if the handler's `preauthorize(method, args, ctx)` resolves true, skip the dialog
(still audited `allowed`); otherwise the existing per-call prompt with allow-session memory.

`packs.inspect(sourcePath)`: loads (dir or archive, without installing) → `PackInspection` with
`allowedByPolicy`/`blockedByPolicy`/`unknownCapabilities` against the registry and policy.

### 3.3 Events (`EventService`)

- `on/off/list` per session (`Storage.subscriptions`), cap 30 per session (INVALID_ARGUMENT), code ≤ 16 KiB.
- Host events arrive via `SensesProvider.subscribe` or `hostEvents.emit`; core also generates: `time`
  (evaluates every minute: filter `{ hour?, minute?, weekday? }`, missing = any; `minute` defaults to 0
  when only `hour` is given), `custom:*` (from `sdk.events.emit`), `routine-changed`.
- Matching: `user-idle` fires when `data.idleMs >= filter.idleMs ?? 300000` and the subscription is
  not already in the idle state (per-subscription edge detection; `user-back` resets). `battery-low`:
  edge below `filter.percent ?? 20`. `window-changed`/`app-launched`: optional `filter.app`/`filter.title`
  (case-insensitive substring). `file-added`: optional `filter.dir`, `filter.ext`. `song-changed`: any.
  `widget-message`: `filter.widgetId`. Generic: any other filter key must equal `data[key]`.
- Firing: run `code` via `BehaviourRunner.runScript` with `input = { event, data, ...input }`, trigger
  `{ kind: 'event', subscriptionId, event }`; if the character has an `onEvent` behaviour it also runs
  (input `{ event, data }`) for events with no matching subscription; audit as `events.fire`
  allowed/failed; `fired++`; `once` → remove. Event code runs do not count toward autonomy limits, but
  wakes they trigger do. Emit `event-fired` chat event. Debounce identical event+subscription within 2 s.
- `setInterest` is called whenever the subscription set changes (union of event names + always `time`
  handled in core).

### 3.4 Senses in the prompt

When the pack has effective `presence` and `settings.senses.includeInPrompt`, the `<session>` section
gets one line built from `senses.snapshot(sessionId)`: `Right now: <localTime> (<dayPart>); user
<at keyboard|away N min>; active window: "<title>" (<app>); playing: <title> — <artist>; battery N%
(on battery)`. Missing parts omitted. Also the `<mood>` block (§3.5) and `<routine>` state.

### 3.5 Mood (`MoodService`)

Per character, stored in `state` scope `char:<ref>` key `mood`. Baseline from character.json
(`mood.baseline` default 0.2, `energyBaseline` 0.7). `nudge`/`set` clamp to ranges, keep `recent` (5),
emit `mood-changed`. Decay: on every read, apply exponential decay toward baseline with half-life 6 h
for mood and 3 h for energy since `updatedAt`; energy baseline is multiplied by the routine state
(`asleep` 0.2, `away` 0.6, `busy` 0.8, `available` 1). Prompt `<mood>`: "Mood: <word> (<n>), energy:
<word>; recent: <reasons>" with words from 5 buckets each. Engine rules: let mood colour your tone; use
`sdk.mood.nudge` when something moves you.

### 3.6 Routine (`RoutineService`)

Entries in `state` scope `char:<ref>` key `routine.entries`; overrides key `routine.override`
(`{ state, label, until }`). `status(ref, now)`: latest entry at or before now (wrapping to the previous
day) unless an override is active; `next` = the following entry. Transitions are detected by the same
per-minute tick as `time` events: on change emit `routine-changed` (chat event + host event for
subscriptions) and, if the new entry has `wakePrompt`, `ChatService.selfWake` in the character's most
recent session (autonomy limits apply). While `asleep`/`away`: user messages still get a turn, but the
prompt states the routine so the character can respond in character (e.g. groggy, or a short "back
later"); timers/events still run. Prompt `<routine>`: current state, label, until, next.

### 3.7 Core-provided handlers

`events`, `mood`, `routine` (trusted; core). Everything else in §1 is a host handler.
`files`: host (needs userData path) — core exposes `engine.paths.characterHome(ref)` helper? No: host
computes `<userData>/characters/<encoded ref>/home`.

Tests: policy intersection (requested/global/per-pack matrix, prompt filtering, inspect), preauthorize
skip, event matching incl. edges and filters, subscription cap/once/debounce, time events, routine
transitions + wake, mood decay/nudge/prompt words, senses line rendering.

## 4. Desktop main (`apps/desktop`)

- **SensesProvider** (`src/main/senses/`): `presence.ts` samples every `settings.senses.pollMs` only
  while something needs it (prompt inclusion or subscriptions): idle via `powerMonitor.getSystemIdleTime()`,
  lock via `powerMonitor` `lock-screen`/`unlock-screen`, battery via `powerMonitor.isOnBatteryPower()` +
  Linux `/sys/class/power_supply/*/capacity` (else null), active window via Hyprland `j/activewindow`
  (and the event socket `activewindow>>` for instant `window-changed`) or the `activeWindow` template
  (JSON or `title\tapp`), now-playing via the `nowPlaying` template (default `playerctl metadata
  --format '{"title":"{{title}}","artist":"{{artist}}","album":"{{album}}","app":"{{playerName}}","status":"{{status}}"}'`
  when `playerctl` is on PATH). Emits edge events (`user-idle`/`user-back` with the threshold
  `settings.senses.idleThresholdMs`, `battery-low`, `screen-*`, `song-changed`, `window-changed`,
  `app-launched`). `watch.ts`: `fs.watch` on `settings.senses.watchDirs` → `file-added` (debounced,
  ignore dotfiles/partial downloads `.part/.crdownload`). Widget/avatar page events → `widget-message` /
  `avatar-clicked`.
- **Handlers** (`src/main/capabilities/`): `presence` (from the provider), `screen` (`look`: screenshot
  via `desktopCapturer` on X11/Windows/macOS, `screenshot` template on Wayland (Hyprland default
  `grim -o {monitor} {file}`), downscale to ≤ 1280 px PNG, then a vision call through the session's
  provider via `engine.llm.describeImage(sessionId, png, question)` (add that helper to core's llm
  handler/service: tool-less call with an image part); `draw`: one full-monitor `draw` overlay per
  monitor, click-through, layer `overlay`, `draw-set`/`draw-clear` commands, durations handled in main),
  `calendar` (parse ICS from `calendarSources` files/URLs, cache 5 min; a small RFC 5545 parser with
  tests: VEVENT, DTSTART/DTEND incl. all-day and TZ offsets, SUMMARY/LOCATION/DESCRIPTION, simple RRULE
  FREQ=DAILY/WEEKLY expansion within the window), `web` (allowlist match on hostname, `preauthorize` =
  allowlisted; http(s) only; timeout 20 s; `maxBytes`; `rss` via a small RSS/Atom parser; `weather`
  via open-meteo geocoding + forecast), `avatar` (one overlay per character, kind `avatar`, loads
  `media.html` with `avatar-*` commands; expressions from `avatarSet` (fallback: the `avatar` image as
  `neutral`); `moveTo` animates by re-placing through the backend in steps or via CSS when on the same
  monitor; persists last state per character in main memory), `widgets` (kind `widget`; `html` sanitised
  only by the iframe sandbox; `postMessage` → page → iframe; iframe messages → `widget-message` events),
  `voice` (`tts` template with `{text}`/`{file}`: if the template writes `{file}` play it in the audio
  window; defaults: Linux `espeak-ng "{text}"` if on PATH, macOS `say "{text}"`, Windows PowerShell SAPI
  one-liner; fallback when empty: `speechSynthesis` in the hidden audio window; `wait` awaits
  completion; `stop` kills/cancels; `listen`: `stt` template printing the transcript), `desktop`
  (Hyprland: `j/clients`, `dispatch focuswindow address:`, `movewindow`, `resizewindowpixel`,
  `movetoworkspace`, `workspace`, `j/activeworkspace`; other platforms: only what templates provide;
  `launch` via template or direct spawn with `preauthorize` = executable name in `launchAllowlist`;
  volume defaults `wpctl set-volume @DEFAULT_AUDIO_SINK@ {level}%` / `wpctl get-volume` (parse), then
  `pactl`; brightness `brightnessctl set {level}%`; DND `makoctl mode -t do-not-disturb` if on PATH,
  else `dunstctl set-paused {on}`; theme `gsettings set org.gnome.desktop.interface color-scheme
  prefer-{theme}`), `input` additions (`inputType` default `ydotool type -- "{text}"` when on PATH else
  `xdotool type -- "{text}"`; key/click/move likewise), `files` (home `<userData>/characters/<encoded
  ref>/home`, path guard like assets, 5 MB per file, 200 files, `open` via `shell.openPath`),
  `messaging` (discord/slack/generic JSON POST, telegram GET/POST `text`, `command` template; 10 s
  timeout; `channels()` from settings), `system.clipboardRead`.
- **IPC**: `characters.status`, `events.list/remove`, `senses.snapshot`, `packs.inspect`, and the new
  `InstalledPackView` fields; forward the new chat events.
- **Settings defaults**: extend `defaultTemplates` for all new templates (Hyprland-aware).
- Tests: presence edge detection with a fake sampler, ICS parser, RSS parser, allowlist matcher,
  files path guard, messaging payload builders, desktop Hyprland command builders, avatar placement.

## 5. Renderer

- **media.html** gains three page kinds driven by the command type: `avatar` (image with expression
  swap + CSS animations, optional cursor tracking of an `eyes` layer if the image has none: just a
  subtle tilt toward the cursor; speech bubble; click → `avatar-clicked`), `widget` (title bar +
  sandboxed iframe `sandbox="allow-scripts"` with `srcdoc`; parent↔iframe `postMessage`; iframe messages
  → `widget-message` report), `draw` (full-viewport SVG, click-through, shapes with fade-out).
- **Settings**: Permissions page (global policy toggles per non-trusted module from
  `capabilities.list()`, grouped by permission level, with the note that packs get the intersection),
  Senses section (poll, idle threshold, calendar sources, watch dirs, include-in-prompt, live snapshot
  from `senses.snapshot()`), Web allowlist, Desktop launch allowlist, Messaging channels editor,
  and the new command templates in the Commands section (grouped: senses, voice, desktop, input).
- **Packs**: capability filter chips (show packs requesting a given module), per-pack badges
  "N blocked by your policy" with the blocked list, effective capabilities shown; "Inspect" button on
  the install picker showing `PackInspection` before confirming install.
- **Chat**: character header shows mood word + energy and routine state (from `characters.status`,
  refreshed on `mood-changed`/`routine-changed`); an "Events" drawer listing live subscriptions for the
  session with remove buttons; `event-fired` shows a small inline marker.
