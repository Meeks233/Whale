# Orca browser extension

Submit videos to your self-hosted [Orca](../README.md) over the **same
end-to-end-encrypted channel** the web UI uses (OSC v2 — ephemeral P-256 ECDH +
HKDF-SHA256 with `SHA256(token)` as a pre-shared key, AES-256-GCM envelopes), and
download them straight from any video page.

Firefox first (Manifest V3, `browser_specific_settings.gecko`). The code is
written to be Chrome-portable: no `EventSource` (SSE is parsed from a streaming
`fetch`), `browser.*` via the Firefox types, and MV3 throughout.

## What it does

- **Toolbar status icon (default surface).** The toolbar button reflects the
  active download's whole lifecycle: cloud-download → spinner → live progress
  ring (with a percent badge) → cloud-check on success / X on failure.
- **In-page download button.** A cloud-download button is mounted on video
  pages/posts. Click → spinner → progress ring → cloud-check (click it to preview
  the finished video in a new tab) or X on failure.
- **Popup.** First launch shows a **welcome** screen (server URL + token, then the
  E2EE handshake). Afterwards: a **Connection** tab (edit server/token, feature
  toggles) and a **Website management** tab (per-site cookies, resolution, share
  quality, format, subtitles, blur; add / edit / delete; search).
- **In-tab preview.** Finished videos are fetched over the sealed media transport
  and decrypted locally (64 KiB chunks) into a playable blob — the token never
  leaves the privileged extension context.

## Architecture

| Context | File | Role |
|---|---|---|
| Crypto core | `src/lib/e2ee.ts` | OSC handshake + AEAD envelope + media-chunk decrypt (WebCrypto) |
| API client | `src/lib/api.ts` | Sealed request wrapper, submit, SSE-over-fetch |
| Background | `src/background.ts` | Owns the session; SSE fan-out; toolbar-icon state machine |
| Content | `src/content/detect.ts` | Site detection + per-button state machine |
| Popup | `src/popup/*` | Welcome, Connection, Website management |
| Preview | `src/preview/*` | Local decrypt-and-play page |

The token and session key live only in the background / privileged pages; content
scripts talk to the background over `runtime` messaging and never see either.

## Build

```sh
npm install
npm run dist        # typecheck -> esbuild bundle (dist-ext/) -> web-ext zip
```

- `npm run build` — assemble `dist-ext/` (loadable unpacked extension).
- `npm run lint` — `web-ext lint` the assembled extension.
- `npm run package` — zip into `web-ext-artifacts/orca-<version>.zip`.
- `npx tsx scripts/verify-e2ee.ts` — drive the crypto against a live server
  (`ORCA_BASE`, `ORCA_TOKEN`) as an end-to-end handshake/seal check.

## Install for testing

**Manual.** Firefox → `about:debugging` → **This Firefox** → **Load Temporary
Add-on** → pick `dist-ext/manifest.json` (or the zip in `web-ext-artifacts/`).

**Automated (no clicks).** The [`firefox-devtools-mcp`][ffmcp] MCP server loads
`dist-ext/` as a temporary add-on over WebDriver BiDi and drives Firefox with the
same click / snapshot / console / network / `evaluate_script` tools the
chrome-devtools MCP offers — the Firefox equivalent of that flow.

- One-shot acceptance gate:

  ```sh
  npm run build && npm run verify:ext
  ```

  This launches Firefox Developer Edition (headless), temporarily loads the
  extension, opens a page, and asserts the content script + background boot with
  no extension-origin console errors (saves a screenshot to
  `web-ext-artifacts/verify.png`). Point it at a real video page to exercise the
  in-page button:

  ```sh
  ORCA_VERIFY_URL='https://www.youtube.com/watch?v=…' npm run verify:ext
  ```

  Overrides: `ORCA_FIREFOX` (Firefox 153+ binary path — `evaluate_script` /
  logpoints require 153+), `HEADFUL=1` (show the window), `MCP_SERVER_JS` (path
  to a local `firefox-devtools-mcp`; otherwise falls back to `npx`).

- Interactive agent debugging: the repo registers the server in `.mcp.json`
  (`firefox-devtools`, pointed at `/opt/firefox-devedition/firefox`). After
  approving it (`/mcp`), an agent can call `install_extension` →
  `new_page`/`click_by_uid`/`fill_by_uid`/`take_snapshot` →
  `list_console_messages`/`list_network_requests`/`evaluate_script`, plus
  `enable_debugger`/`set_logpoint` for background-script breakpoints.

[ffmcp]: https://github.com/mozilla/firefox-devtools-mcp

## Headless userscript (Tampermonkey / Violentmonkey)

For browsers where you'd rather run a userscript than install an extension, the
same code ships as a **single-file userscript** — `dist-userscript/orca.user.js`.
It is the headless twin of the extension: the in-page **download / status
button** (top-left of any video) and the **token bridge** come from the *exact
same sources* as the extension, so you maintain one codebase, not two.

```sh
npm run dist:userscript   # typecheck -> dist-userscript/orca.user.js
```

Then open the file (or drag it into your userscript manager) to install.

**How it reuses the extension code.** The bundle is built from
`src/content/detect.ts` + `src/lib/*` **unchanged** — the button, the OSC v2
crypto (`e2ee.ts`), the API client (`api.ts`) and the progress math are shared
verbatim. The only userscript-specific glue is `src/userscript/`:

| File | Role |
|---|---|
| `src/userscript/shim.ts` | Stands in for the background page: recreates the sliver of `browser.*` `detect.ts` talks to, backed by the real `OrcaClient`; bridges the token; routes API calls through `GM_xmlhttpRequest`. |
| `src/userscript/main.ts` | Entry point — imports the shim (first) then the shared content script. |
| `build-userscript.ts` | esbuild → one `.user.js` with the userscript header; inlines `inject.css`. |

**Token flow (zero-config).** There is no popup. Instead:

- On your **Orca dashboard** page, the script reads `localStorage.orca_token` and
  mirrors it (plus the server base) into the userscript manager's cross-origin GM
  store — so video pages on other sites can use it.
- If the dashboard ever loses its token but the GM store still has one for that
  server, the script **reverse-injects** it back into `localStorage` and reloads,
  so the dashboard boots logged in again (guarded against reload loops).

So: log in to your Orca web app once, and the button starts working everywhere.
Token changes made later on the dashboard (Settings / welcome field) are picked up
live — a `storage` listener for other tabs, plus a light poll on the dashboard page
for same-tab edits the event can't see. Because API calls go over `GM_xmlhttpRequest`
(declared `@connect *`), the E2EE channel reaches a self-hosted server on any origin
— LAN, localhost or a domain — without CORS / Private-Network-Access friction.

**Manual fallback (no web app needed).** The userscript-manager menu (the extension
icon → *Orca*) offers **set server + token**, **show current config**, and **clear
config** — for anyone who hasn't opened the dashboard, to reset a stale token, or to
debug. *Set* validates the credentials with a real handshake and reports the result.

There is no SSE fan-out in the userscript; `detect.ts`'s built-in poll fallback
drives the live progress ring, so behaviour matches the extension.

## Publishing to AMO

The build passes `web-ext lint` with 0 errors/warnings/notices and declares
`data_collection_permissions: { required: ["none"] }` (the extension collects
nothing — everything is E2EE to your own server). Submit the zip at
[addons.mozilla.org](https://addons.mozilla.org/developers/) after setting your
own `gecko.id`.
