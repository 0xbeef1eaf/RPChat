# Browser extension: characters in your browser

With the **rp-code browser bridge** extension installed, a character that has the `browser`
capability can list your tabs, open pages, read them, click links, fill in fields, scroll,
take screenshots and react when a page finishes loading — in your real browser, with your
real logins. Since `sdk.browser` 2.1 it can also keep pages from opening for a while, restyle
or swap the pictures on a page, set your home page, use your bookmarks and history, and run a
script in a page (each of those switchable in Settings → Browser; see
[What else a character can do](#what-else-a-character-can-do-sdkbrowser-21)). Without the extension `sdk.browser.open(url)` still works (it runs the browser
command from Settings → Commands) and every other `sdk.browser` method fails with
`CAPABILITY_FAILED` ("The browser extension is not connected …"), so nothing breaks when it
is absent.

Supported browsers: every Chromium-based one that accepts Manifest V3 extensions and, for the
policy install, managed policies on Linux — Chromium, Google Chrome, Brave, Microsoft Edge,
Vivaldi, Opera. Firefox is not supported (different extension platform).

## How it works

```
 ┌──────────────── rp-code (Electron main) ────────────────┐         ┌──────── browser ────────┐
 │ loopback http server on 127.0.0.1:<bridgePort>          │         │ rp-code browser bridge  │
 │   GET /extension/update.xml   Omaha update manifest     │◄── poll ┤   (MV3 service worker)  │
 │   GET /extension/rp-code.crx  CRX3 signed with your key │         │                         │
 │   GET /extension/id           the extension id          │         │  ws://127.0.0.1:<port>/ │
 │   WS  /bridge  ◄── Origin: chrome-extension://<id> ─────┼─────────┤    bridge, reconnecting │
 │ BrowserBridge: hello → trust prompt → request/response  │         │  chrome.tabs / scripting│
 │ sdk.browser handler ── allowlist ── request(op, args)   │         │  (content injected per  │
 │ 'browser-navigated' host event ← tab-updated(complete)  │         │   call, never resident) │
 └──────────────────────────────────────────────────────────┘         └─────────────────────────┘
```

- The app's loopback server (`apps/desktop/src/main/loopback.ts`) binds the port from
  **Settings → Browser** (`settings.browser.bridgePort`, default **47821**). When that port is
  taken it falls back to an ephemeral one, logs a warning, and the Settings tab shows the
  mismatch — the extension cannot find the app until the port is fixed.
- The extension (`apps/browser-extension/`, package `@rp/browser-extension`) keeps one
  WebSocket to `ws://127.0.0.1:<port>/bridge`, reconnecting with exponential backoff (1 s → 30 s)
  and a 30 s `chrome.alarms` tick that wakes the service worker when Chrome has put it to
  sleep. The port comes from managed policy (`chrome.storage.managed`, delivered by the
  policy's `3rdparty` block and declared in `schema.json`), else the extension's popup
  (`chrome.storage.local`), else the default.
- Protocol: the app sends `{ id, op, args }`, the extension answers `{ id, ok: true, value }` or
  `{ id, ok: false, error: { code, message } }`, and pushes `{ event: 'tab-updated' |
  'tab-activated' | 'tab-removed', data }`. The first frame after connecting is
  `{ hello: { version, browser, extensionId } }`. Requests time out after 15 s (`page.eval` gets its own timeout plus 5 s).
- Ops: `tabs.list/open/activate/close/navigate/back/forward/reload`,
  `page.read/query/click/type/scroll/screenshot/find`, and (2.1) `page.imageEffect`,
  `page.clearImageEffects`, `page.eval`, `rules.block/unblock/list/clear`, `home.set/get`,
  `bookmarks.list/search/add/remove`, `history.search/visits/recent`. Page ops inject a
  self-contained function with `chrome.scripting.executeScript` for that one call; there are no
  persistent content scripts. Internal pages (`chrome://…`, the Web Store) are listed without URL
  or title and can never be read or scripted.
- `sdk.browser` (`packages/sdk/src/modules/browser.ts`, v2) maps 1:1 onto those ops; the host
  handler (`apps/desktop/src/main/capabilities/browser.ts`) applies the web allowlist and
  routes to the bridge. `tab-updated` with `status: 'complete'` becomes the
  **`browser-navigated`** host event (`{ tabId, url, title }`, filter `{ url?, title? }`
  substrings) for `sdk.events.on`.

## What else a character can do (`sdk.browser` 2.1)

Every method below needs the extension, passes the web allowlist for any URL it takes, and is
audited like the rest. Settings → Browser → **What characters may do** switches page blocking,
JavaScript injection and history access off individually; a switched-off call fails with
`CAPABILITY_FAILED` and a message naming the setting.

### Blocking pages for a while

`sdk.browser.block(patterns, { durationMs, redirect?, reason? })` → `{ id, expiresAt }`,
`unblock(id)`, `blocks()`, `clearBlocks()`. Patterns: `example.com` (the host and every
subdomain), `*.example.com` (the same), `example.com/path*` (a path prefix), `example.com/exact`
(that path; `*` inside a path matches anything). Each pattern becomes one dynamic
`declarativeNetRequest` rule (`regexFilter`, `main_frame` only, any port), so only top-level
navigations are affected — embedded resources, the extension's own traffic and the app's pages
are not. Without `redirect` the rule sends the navigation to the extension's `blocked.html`
("This page is unavailable right now — blocked by *character* until *time*", the reason, and an
"Ask in rp-code" hint); with `redirect` it goes to that URL instead. Tabs already showing a
newly blocked page are moved the same way. The rule table lives in `chrome.storage.local`
(dynamic DNR rules persist on their own) and a `chrome.alarms` alarm removes expired rules; the
list and the popup's counter are refreshed from it.

- `durationMs` is optional and uncapped: with it the block expires at `expiresAt`; without it the
  block stays until `unblock()`/`clearBlocks()` or the user presses **Clear all blocks** in
  Settings → Browser (or switches blocking off).
- `127.0.0.1`, `localhost`, `*.localhost`, `chrome://…` and every other browser scheme are
  protected (the app's own media pages, assets and the extension update URL) —
  `PERMISSION_DENIED` in the app, and refused again by the extension.
- Settings → Browser lists the active blocks (who, until when, redirect, reason) with **Clear
  all blocks**; `browser.allowBlocking` (policy: `browser.allowBlocking`) switches the feature
  off ("Blocking pages is disabled in Settings → Browser"). Unblocking and listing keep working
  while it is off so the user can clean up.

### Image effects

`sdk.browser.imageEffect(tabId, effect, { selector?, replaceWith?, durationMs? })` →
`{ applied, replaced, total }` and `clearImageEffects(tabId)`. `effect` is a preset — `blur`
(`blur(6px)`), `grayscale`, `sepia`, `invert`, `hue` (`hue-rotate(180deg)`), `pixelate`, `none` —
or `{ css: "<filter value>" }` (a plain `filter` value; braces, `url()` and markup are rejected).
The extension injects or updates one `<style data-rp-effect>` element applying `filter` to
`img, picture, video` (or `selector`). `pixelate` is approximate: CSS has no pixelation filter,
so it combines `image-rendering: pixelated` with `blur(1px) contrast(2)`. `replaceWith` swaps
every matching `<img>`'s `src` (and drops `srcset`, also on `<picture>` sources) for an http(s)
URL or a pack asset (`AssetRef` or a pack-relative path, served through the app's loopback
asset route as `http://127.0.0.1:<port>/t/<token>/asset/<pack>/<path>`); originals are kept in
`data-rp-original-src` / `data-rp-original-srcset` and restored by `clearImageEffects` or when
`durationMs` runs out (an in-page timer). Nothing persists across navigations.

Caveat: a site with a strict `Content-Security-Policy` `img-src` refuses the replacement image
(the browser shows a broken picture; `replaced` still counts the swapped elements) — use a
filter there, or `clearImageEffects`.

### Home page

`sdk.browser.setHomePage(url | null)`, `homePage()`. The extension overrides the browser's
new-tab page (`chrome_url_overrides.newtab` → `newtab.html`): when a home page is stored in
`chrome.storage.local.homePage` and it is http(s), the page does `location.replace(url)`;
otherwise it shows a plain "rp-code" page. The value lives in `settings.browser.homePage` (Settings → Browser "Home page";
policy key `browser.homePage`) and is pushed to the extension every time one connects, so it
survives extension re-installs. **Install browser policy…** also writes it as
`HomepageLocation` + `HomepageIsNewTabPage: false` (`install.sh --browser-home <url>`), which
covers the browser's Home button and browsers where the user switched the extension's new-tab
override off (`chrome://extensions` lets them) — the policy value still applies there.

### Bookmarks

`sdk.browser.bookmarks({ folder? })` (the tree flattened to `{ id, title, url?, parentId, path }`,
folders included, at most 500), `searchBookmarks(query)`, `addBookmark(url, title, { folder? })`,
`removeBookmark(idOrUrl)`. `folder` is the title of an existing folder or a path such as
`Work/Reading`; missing segments are created under "Other bookmarks". Removing by URL removes
every bookmark of that URL; folders are never removed. Permission: `bookmarks`.

### JavaScript in a page

`sdk.browser.eval(tabId, code, { world?, timeoutMs? })` → `{ value, world, fallback? }`, marked
*dangerous*. `code` is the body of an async function; the awaited return value comes back
JSON-serialised (64 KiB cap; non-serialisable results are an error). The extension injects a
fixed wrapper (`new Function('return (async () => {' + code + '})()')`) with
`chrome.scripting.executeScript`. Timeout default 10 s, max 60 s. `settings.browser.allowEval`
(policy: `browser.allowEval`) switches it off ("JavaScript injection is disabled in Settings →
Browser").

Two worlds, and a finding: `world: "isolated"` (the default) asks for the content-script world
(`world: 'ISOLATED'`) — it sees the DOM but not the page's own JavaScript variables. In
Manifest V3, though, the extension's own CSP (`script-src 'self'`, not relaxable) applies to
content scripts as well, so `new Function` is refused there ("Refused to evaluate a string as
JavaScript because 'unsafe-eval' is not an allowed source"), and `executeScript` serialises
`func` from its real source (an overridden `toString` is ignored), so there is no other way to
run dynamic code in that world. Verified against Chromium 141 by the smoke. The extension
therefore falls back to the main world on that refusal, remembers it for the worker's lifetime,
and reports `world: "main"` plus `fallback: "The isolated world refuses eval (extension CSP);
ran in the main world"`. `world: "main"` runs as the page itself (`world: 'MAIN'`) and can read
page globals — but a page CSP without `unsafe-eval` refuses it, and the error then says "the
page's Content Security Policy forbids eval in the main world". In practice: expect `eval` to
run in the main world; on strict-CSP sites use the fixed helpers (`read`, `query`, `click`, …).

### History

`sdk.browser.history({ text?, since?, until?, limit? })` (`since`/`until`: ISO date-time or a
number of milliseconds ago; default the last 7 days, limit default 100, max 500),
`historyVisits(url)` → `[{ visitTime, transition }]`, `recentHistory(limit?)`. This reads the
whole profile's history through `chrome.history` (permission `history`), which is why
`settings.browser.allowHistory` (policy: `browser.allowHistory`) exists: off → "Browser history
access is disabled in Settings → Browser".

## Installing the extension

### Through the browser policy (recommended, Linux)

**Settings → Browser → Install browser policy…** runs the bundled installer with `pkexec`:

```sh
install.sh --browser-only --browser-extension <id> --browser-update-url http://127.0.0.1:<port>/extension/update.xml --browser-port <port>
```

It writes `rp-code.json` into the managed-policy directory of every Chromium-based browser
that looks installed (binary on `PATH` or its `/etc` config directory present); Chromium and
Chrome always get one:

| Browser | Policy file |
|---|---|
| Chromium | `/etc/chromium/policies/managed/rp-code.json` |
| Google Chrome | `/etc/opt/chrome/policies/managed/rp-code.json` |
| Brave | `/etc/brave/policies/managed/rp-code.json` |
| Microsoft Edge | `/etc/opt/edge/policies/managed/rp-code.json` |
| Vivaldi | `/etc/vivaldi/policies/managed/rp-code.json` |
| Opera | `/etc/opera/policies/managed/rp-code.json` |

The file (`apps/desktop/src/main/browser/policy.ts` builds the same JSON):

```json
{
  "ExtensionInstallForcelist": ["<id>;http://127.0.0.1:47821/extension/update.xml"],
  "ExtensionInstallSources": ["http://127.0.0.1:47821/*"],
  "3rdparty": { "extensions": { "<id>": { "policy": { "port": 47821 } } } }
}
```

The `3rdparty` block lands in the extension's `chrome.storage.managed` as written (Chromium
passes the JSON through and checks it against the extension's `schema.json`); the nested
`policy` object is the layout Chrome documents for the Windows registry and macOS plist, and
the extension also accepts a flat `{ "port": n }`. Verified against Chromium 141 on Linux:
both shapes arrive one to three seconds after the extension starts, and the extension
reconnects when they do.

The browser polls the update URL (at start and every few hours; `chrome://policy` → *Reload
policies* and `chrome://extensions` → *Update* hurry it along), downloads the CRX **from the
app on this computer**, installs it as a force-installed extension the user cannot remove,
and the extension connects. The app must be running for the download to succeed; a browser
started while rp-code is closed retries later. `chrome://policy` shows the policy and any
error; `chrome://extensions` shows the extension as "Installed by your administrator".

With a home page set (Settings → Browser), the file also carries `"HomepageLocation": "<url>"`
and `"HomepageIsNewTabPage": false` (`--browser-home <url>`).

**Extra policy directories.** Chromium forks whose managed-policy directory is not in the table
(Helium, ungoogled-chromium derivatives, distribution builds with their own name) can be added
under Settings → Browser → **Extra policy directories** (one per line; stored in
`settings.browser.extraPolicyDirs`, passed to the installer as repeatable
`--browser-policy-dir <dir>` flags on install *and* remove). Each must be an absolute path ending
in `/policies/managed`. To find a browser's directory, open `chrome://policy` in it (the page
names the platform policy path when a policy is loaded) or watch it look for the directory:
`strace -f -e trace=openat <browser> 2>&1 | grep policies/managed`.

**Remove policy** (`install.sh --remove-browser-policy [--browser-policy-dir <dir>]…`) deletes
every `rp-code.json` the installer wrote; browsers uninstall the extension at their next policy
refresh.
`install.sh --uninstall` removes them as well. The `.deb` post-install never writes this
policy: the extension id is derived from a per-user key (below), so it has to be done from
the app for the user in question. `--dry-run` prints every file it would write.

Caveats:

- **Google Chrome on Windows and macOS** only honours `ExtensionInstallForcelist` entries
  that come from the Chrome Web Store; off-store update URLs are ignored there. Linux Chrome
  and every Chromium build (Chromium, Brave, Edge, Vivaldi, Opera, …) accept this policy. On
  Windows/macOS use *Load unpacked* below.
- **Flatpak / Snap browsers** read policies from inside their sandbox
  (`~/.var/app/<app-id>/config/<browser>/policies/managed/` for Flatpak, e.g.
  `~/.var/app/org.chromium.Chromium/config/chromium/policies/managed/`), which the installer
  does not touch. Copy the JSON there yourself (the Settings tab shows the id and update
  URL), or load the extension unpacked. Sandboxed browsers can reach `127.0.0.1`.
- The **id is per user and per machine**: it comes from `<userData>/extension-key.pem`
  (an RSA-2048 key generated on first use, `0600`, never logged). Deleting that file changes
  the id, so the policy has to be installed again.

### Load unpacked (developers, Windows/macOS Chrome)

`chrome://extensions` → *Developer mode* → *Load unpacked* → pick the folder shown under
**Settings → Browser → Developers** (`<resources>/extension`, a copy of
`apps/browser-extension/dist`; a *Copy* button is next to it). An unpacked extension gets an
id derived from its path, not from the key, so it differs from the policy id — that is fine:
the first time it connects rp-code asks you to allow it. Set the port in the extension's
popup when it is not the default.

### The first connection

When an extension whose id is not yet in **Settings → Browser → Allowed extensions** says
hello, rp-code opens a question window: *"Browser extension `<id>` (`<browser>`) wants to
connect to rp-code — Allow?"*. *Yes* stores the id in `settings.browser.trustedExtensionIds`
and the extension is connected from then on, across restarts. *No* (or closing the window)
refuses it for the rest of this app run without asking again; Settings → Browser lists such
refused ids and lets you allow them, or add any id by hand. *Remove* forgets an id and drops
its live connection. One connection per id is kept — a newer one replaces the old — and
requests go to the most recently connected extension.

## What a character can and cannot do

Can (unless you switched `browser` off under Settings → Permissions, and only while the extension is connected):

- see every open tab's URL and title (`tabs()`), open new tabs or windows, switch between
  tabs, close tabs, navigate, go back/forward, reload;
- read the visible text of an `http(s)` page (capped, default 20 000 characters), find text,
  enumerate elements by CSS selector, click them, type into inputs/textareas/selects/
  contenteditables (with a real form submit when asked), scroll;
- take a PNG screenshot of the visible part of a tab (the tab is brought to the front first);
- get `browser-navigated` events when a tab finishes loading;
- (2.1) block pages for a while, restyle or swap a page's pictures, set the home page, list,
  search, add and remove bookmarks, read the history, and run a script in a page — each
  described above, and each of blocking, scripting and history switchable off in Settings →
  Browser.

Cannot:

- open or navigate to anything but `http://` and `https://` URLs (checked in the app *and* in
  the extension — no `javascript:`, `data:`, `file:`, `chrome://`);
- open or navigate to hosts outside `settings.web.allowlist` when you set one (Settings →
  Integrations → Web access; empty = any host) — `PERMISSION_DENIED`;
- read, script or capture internal pages (`chrome://…`, the Web Store);
- run JavaScript in pages while `Run JavaScript in pages` is off in Settings → Browser (with it
  on, `eval` is a *dangerous* method: audited, and refused by the page's CSP in the main world);
  every other page op only injects the fixed, self-contained helpers with the arguments above;
- block the app's own pages, `localhost` or browser pages, block for longer than the cap in
  Settings → Browser, or block anything while blocking is switched off;
- reach the extension at all when it is not connected, or from another machine (the bridge
  and the update URL are bound to `127.0.0.1`);
- act once you switched it off: `browser` is a pack-level capability (on for every character
  unless switched off under Settings → Permissions) and `openTab`, `navigate`, `close`,
  `click`, `type` and `screenshot` are marked *dangerous* in the SDK, so they are shown as such
  in the permissions UI and the audit log records every call.

Things worth knowing: clicks and typing land in your real session (logged-in accounts,
forms). The SDK docs tell the model not to submit, buy, post or send anything the user did
not ask for in the conversation, and to say what it opened — but the switch is the control;
it applies to every installed character, so switch `browser` off under Settings → Permissions
unless you trust the packs you run, and keep the web allowlist tight when in doubt.

## Security model

1. **Origin check.** The loopback server only upgrades `/bridge` for requests whose `Origin`
   is `chrome-extension://<32 letters a–p>`; anything else gets `403`. Web pages cannot open
   the bridge (their origin is `http(s)://…`), and the hello frame's `extensionId` must match
   the origin or the connection is dropped.
2. **User approval per extension id**, stored in settings; refusals stick for the app run.
3. **Allowlist and URL policy** on every URL the character opens or navigates to, enforced in
   the app before anything reaches the extension, and again by the extension.
4. **Loopback only.** The bridge, the update manifest and the CRX are served on `127.0.0.1`
   without authentication (Chromium's policy fetcher cannot present a token) — they expose
   the extension package and its id, nothing else, and only to processes on this machine.
5. **Signed package.** The CRX is signed with your key, so the id in the policy can only be
   satisfied by a package this app built; the key never leaves `<userData>`.
6. **Least privilege in the extension.** Permissions: `tabs`, `scripting`, `activeTab`,
   `storage`, `alarms`, `declarativeNetRequest` (page blocks), `bookmarks`, `history`, host
   permission `<all_urls>` (needed to read pages the character is sent to and to capture tabs).
   No persistent content scripts, no cookies/downloads permissions, no remote code; the only
   web-accessible resource is `blocked.html`, the page blocked navigations are sent to.

## How the package is built

`pnpm --filter @rp/browser-extension build` bundles `src/background.ts`, `src/popup.ts`,
`src/newtab.ts` and `src/blocked.ts` with esbuild into `dist/` next to `manifest.json`,
`schema.json`, `popup.html`, `newtab.html` and `blocked.html`; the
desktop build (`apps/desktop/scripts/build-extension.mjs`, run by `pnpm --filter @rp/desktop
build`) copies `dist/` to `apps/desktop/resources/extension/` (git-ignored, shipped by
electron-builder as `resources/extension`). The manifest has no `key` field: the packaged
id comes from the CRX signature, an unpacked copy gets a path-derived id.

At run time `apps/desktop/src/main/browser/crx.ts` zips that folder deterministically
(sorted names, fixed timestamps; `fflate`) and writes a **CRX3** file by hand:

```
"Cr24" | uint32le 3 | uint32le headerLen | CrxFileHeader | zip
CrxFileHeader      = field 2 (AsymmetricKeyProof: field 1 public_key, field 2 signature)
                   + field 10000 signed_header_data (= SignedData: field 1 crx_id, 16 bytes)
signature          = RSA-PKCS1-v1_5/SHA-256 over
                     "CRX3 SignedData\0" + uint32le(len(signed_header_data)) + signed_header_data + zip
extension id       = SHA-256(SPKI DER of the public key)[0..16] as hex, digits mapped 0→a … f→p
crx_id             = the same 16 bytes
```

The package is re-signed when the bundled manifest's `version` changes; `update.xml` reports
that version so browsers pick updates up. `GET /extension/id` returns the id as text.

## Testing

- Unit: `apps/browser-extension/src/*.test.ts` (protocol, URL policy, backoff, text
  normalisation, every op against a fake `chrome` — including the DNR rule table, expiry,
  bookmarks, history and eval; `rules.test.ts` for pattern → `regexFilter` conversion and
  expiry, `bookmarks.test.ts` for folder path resolution, `effects.test.ts` for the effect CSS), `apps/desktop/src/main/browser/*.test.ts`
  (CRX3 layout and signature, pinned id derivation for a fixed key, policy JSON/XML, the
  bridge over a fake socket: origin rejection, hello/trust flow, request/response, error
  mapping, timeout, disconnect, event forwarding) and
  `apps/desktop/src/main/capabilities/browser.test.ts` (allowlist, argument validation,
  not-connected errors).
- End to end: `pnpm test:browser` (`scripts/browser-smoke.sh`) builds the extension and the
  app, starts the app on Xvfb with `RP_MOCK_LLM=1 RP_SMOKE=1 RP_SMOKE_BROWSER=1` (the bridge
  auto-trusts in smoke mode), launches Chromium through `playwright-core` with
  `--load-extension`, points the extension at the app's port, and lets the mock model run a
  turn that opens the loopback smoke page, reads it, queries and finds, types, scrolls,
  screenshots and clicks the link — then checks the `browser-navigated` event reached both a
  host subscriber and the character's own `sdk.events` handler. A second turn exercises the 2.1
  capabilities: block `smoke.test/smoke/page2*` (Chromium maps `smoke.test` onto 127.0.0.1 with
  `--host-resolver-rules`, since 127.0.0.1 itself is protected), open it and land on the blocked
  page, unblock and open it for real; `grayscale` + a pack-asset `replaceWith` on the smoke page
  with the computed style and `src` read back through `eval`; set the home page (the launcher
  then opens `chrome://newtab` and the app waits for the `browser-navigated` event on it); add,
  search, list and remove a bookmark; `eval` in the isolated world (`document.title`, plus a
  `new Function` probe) and the main world (`location.href`); `history` / `historyVisits` for
  the smoke page — `[smoke] verify browser capabilities: PASS` lists each. A second phase
  repeats this
  with the **policy path**: the installer writes the managed policy (root or passwordless sudo;
  `RP_SMOKE_POLICY=auto|1|0`), Chromium starts without `--load-extension`, force-installs the
  app-signed CRX from the loopback update URL, receives its port from the `3rdparty` block and
  connects — which is what proves the CRX3 packing against a real browser. The policy files
  are removed afterwards. CI runs both phases after the headful smoke. Needs a Chromium for
  playwright-core (`PLAYWRIGHT_BROWSERS_PATH`, `RP_CHROMIUM_BIN` or `pnpm --filter @rp/desktop
  exec playwright-core install chromium`).
