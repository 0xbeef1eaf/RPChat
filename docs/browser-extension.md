# Browser extension: characters in your browser

With the **rp-code browser bridge** extension installed, a character that has the `browser`
capability can list your tabs, open pages, read them, click links, fill in fields, scroll,
take screenshots and react when a page finishes loading — in your real browser, with your
real logins. Without the extension `sdk.browser.open(url)` still works (it runs the browser
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
  `{ hello: { version, browser, extensionId } }`. Requests time out after 15 s.
- Ops: `tabs.list/open/activate/close/navigate/back/forward/reload` and
  `page.read/query/click/type/scroll/screenshot/find`. Page ops inject a self-contained
  function with `chrome.scripting.executeScript` for that one call; there are no persistent
  content scripts. Internal pages (`chrome://…`, the Web Store) are listed without URL or
  title and can never be read or scripted.
- `sdk.browser` (`packages/sdk/src/modules/browser.ts`, v2) maps 1:1 onto those ops; the host
  handler (`apps/desktop/src/main/capabilities/browser.ts`) applies the web allowlist and
  routes to the bridge. `tab-updated` with `status: 'complete'` becomes the
  **`browser-navigated`** host event (`{ tabId, url, title }`, filter `{ url?, title? }`
  substrings) for `sdk.events.on`.

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

**Remove policy** (`install.sh --remove-browser-policy`) deletes every `rp-code.json` the
installer wrote; browsers uninstall the extension at their next policy refresh.
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

Can (with the `browser` capability granted to its pack, and only while the extension is connected):

- see every open tab's URL and title (`tabs()`), open new tabs or windows, switch between
  tabs, close tabs, navigate, go back/forward, reload;
- read the visible text of an `http(s)` page (capped, default 20 000 characters), find text,
  enumerate elements by CSS selector, click them, type into inputs/textareas/selects/
  contenteditables (with a real form submit when asked), scroll;
- take a PNG screenshot of the visible part of a tab (the tab is brought to the front first);
- get `browser-navigated` events when a tab finishes loading.

Cannot:

- open or navigate to anything but `http://` and `https://` URLs (checked in the app *and* in
  the extension — no `javascript:`, `data:`, `file:`, `chrome://`);
- open or navigate to hosts outside `settings.web.allowlist` when you set one (Settings →
  Integrations → Web access; empty = any host) — `PERMISSION_DENIED`;
- read, script or capture internal pages (`chrome://…`, the Web Store);
- run arbitrary JavaScript in pages: only the fixed, self-contained page helpers are ever
  injected, with the arguments listed above;
- reach the extension at all when it is not connected, or from another machine (the bridge
  and the update URL are bound to `127.0.0.1`);
- act without your grant: `browser` is a pack-level capability and `openTab`, `navigate`,
  `close`, `click`, `type` and `screenshot` are marked *dangerous* in the SDK, so they are
  shown as such in the permissions UI and the audit log records every call.

Things worth knowing: clicks and typing land in your real session (logged-in accounts,
forms). The SDK docs tell the model not to submit, buy, post or send anything the user did
not ask for in the conversation, and to say what it opened — but the grant is the control;
give `browser` only to packs you trust, and keep the web allowlist tight when in doubt.

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
   `storage`, `alarms`, host permission `<all_urls>` (needed to read pages the character is
   sent to and to capture tabs). No persistent content scripts, no cookies/history/downloads
   permissions, no remote code.

## How the package is built

`pnpm --filter @rp/browser-extension build` bundles `src/background.ts` and `src/popup.ts`
with esbuild into `dist/` next to `manifest.json`, `schema.json` and `popup.html`; the
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
  normalisation, every op against a fake `chrome`), `apps/desktop/src/main/browser/*.test.ts`
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
  host subscriber and the character's own `sdk.events` handler. A second phase repeats this
  with the **policy path**: the installer writes the managed policy (root or passwordless sudo;
  `RP_SMOKE_POLICY=auto|1|0`), Chromium starts without `--load-extension`, force-installs the
  app-signed CRX from the loopback update URL, receives its port from the `3rdparty` block and
  connects — which is what proves the CRX3 packing against a real browser. The policy files
  are removed afterwards. CI runs both phases after the headful smoke. Needs a Chromium for
  playwright-core (`PLAYWRIGHT_BROWSERS_PATH`, `RP_CHROMIUM_BIN` or `pnpm --filter @rp/desktop
  exec playwright-core install chromium`).
