# Frontend (Web UI + PWA)

A single, minimal, framework-free web app served by the backend. Sources are
TypeScript + CSS in `frontend/src/`; a tiny esbuild step bundles + minifies them
into `web/` (the committed artifacts), which `rust-embed` embeds into the binary
(served by `web.rs`) and the Tauri app ships verbatim.
Goal: submit a URL and watch/browse history from any device, installable to the home screen.

## 1. Files

Sources — `frontend/src/` (edit these):

| File | Purpose |
|---|---|
| `app.ts` | API calls, SSE subscription, rendering, token persistence, multi-select, player |
| `i18n.ts` | Localization dictionary + runtime (bundled into `app.js`) |
| `sw.ts` | Service worker source |
| `style.css` | Responsive styling (mobile-first) |

Built artifacts — `web/` (generated, committed, do **not** hand-edit the `.js`/`.css`):

| File | Purpose |
|---|---|
| `index.html` | App shell (hand-authored; loads the single bundled `app.js`) |
| `app.js` | Bundled + minified `app.ts` + `i18n.ts` (one request) |
| `style.css` | Minified stylesheet |
| `manifest.webmanifest` | PWA metadata, `share_target`, icons |
| `sw.js` | Built service worker: cache app shell, enable install/offline shell |
| `icons/` | PWA icons (192, 512) |

Served: `GET /` → `index.html`; `GET /<asset>` → matching file (auth-free, see API.md).

## 1a. Build

The Docker image and the Tauri app both consume `web/` directly — there is **no
build step in Docker/CI**, so the `web/` artifacts are committed. After editing
anything under `frontend/src/`, rebuild them:

```
cd frontend
npm install       # first time only (esbuild + typescript)
npm run check     # tsc --noEmit typecheck, then bundle/minify into ../web
# or: npm run build (bundle only) / npm run typecheck (types only)
```

`build.mjs` emits `web/app.js`, `web/sw.js`, `web/style.css`. Commit the updated
sources **and** the regenerated `web/` artifacts together.

## 2. Token handling

- No login page. A settings field accepts the bearer token; stored in `localStorage`.
- All `fetch` calls send `Authorization: Bearer <token>`.
- SSE (`EventSource` can't set headers) uses `/api/events?token=<token>`.
- If any `/api/*` returns `401`, show the token field with an "invalid token" hint.

## 3. Views (single page)

1. **Submit bar** (top): URL input + "Download" button. On submit → `POST /api/items`.
   - Show a toast: "Queued", or "Already downloaded" when `duplicate:true`, or the probe error.
2. **History list**: `GET /api/items` (keyset paginated, infinite scroll / "load more").
   Each row: thumbnail, title, uploader, status badge, and for active rows a live progress bar.
   - Filter chips: All / Queued / Running / Completed / Failed.
   - Search box → `?q=`.
3. **Live updates**: open one `EventSource('/api/events?token=…')`; on each `ProgressEvent`
   patch the matching row by `id` (progress bar, status badge). Terminal status finalizes it.

## 4. PWA specifics

`manifest.webmanifest` (sketch):
```json
{
  "name": "Whale", "short_name": "Whale", "start_url": "/", "display": "standalone",
  "background_color": "#0b1220", "theme_color": "#0b1220",
  "icons": [ {"src":"/icons/192.png","sizes":"192x192","type":"image/png"},
             {"src":"/icons/512.png","sizes":"512x512","type":"image/png"} ],
  "share_target": {
    "action": "/", "method": "GET",
    "params": { "url": "url", "text": "text", "title": "title" }
  }
}
```
- **Share target**: on Android/desktop, "Share → Whale" opens `/?url=<shared>`; `app.js`
  reads the `url`/`text` query param, prefills the submit box, and (if a token is stored)
  auto-submits. This is the "minimal submit端" on mobile without a native app.
- **iOS**: no Web Share Target API; users add to home screen and paste, or use a one-line
  Shortcut that `POST`s to `/api/items` with the token. Document both in README.

## 5. Service worker scope

Keep it conservative: cache only the **app shell** (html/js/css/icons) for install +
offline-open. **Never** cache `/api/*` responses (data must be live). `sw.js` uses a
network-first (or network-only) strategy for `/api/*` and cache-first for the shell.

## 6. Non-goals (v1)

- No client-side framework, no bundler, no auth UI beyond the token field.
- No in-browser video playback of results (files land in `WHALE_DOWNLOAD_DIR`; serving media
  is out of scope — could be added as a static file route later).
