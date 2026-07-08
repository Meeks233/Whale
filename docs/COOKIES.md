# COOKIES.md — Per-platform cookie downloads

Whale can attach site cookies to yt-dlp so that logins, age-gated, and
subscriber-only media download. Inspired by Seal's per-site login, adapted to a
server.

## Why paste, not capture

Seal is an Android app: it opens a native `WebView` and reads the login cookies
via `CookieManager`. Whale runs in an ordinary **browser**, where the
Same-Origin Policy plus `X-Frame-Options: DENY` / CSP `frame-ancestors` (sent by
X, YouTube, Instagram, …) make it **impossible** for Whale's JavaScript to read
cookies from an embedded login page. So instead:

1. Log in on the site (the UI offers a "Log in ↗" link per platform).
2. Export its cookies with a "Get cookies.txt LOCALLY" browser extension.
3. Paste the Netscape `cookies.txt` into Whale, tagged to that platform.

Whale stores it server-side and **auto-applies it to every future download from
that platform** — enabled by default the moment it's saved.

## Platform detection (aliases, case-insensitive)

`src/platform.rs` maps a URL to a canonical platform by **host suffix**, always
lowercased first — hostnames are case-insensitive (RFC 3986), so `X.COM`,
`x.com`, and `www.X.com` all resolve identically. Aliases share one canonical
`key`, so a cookie captured for X is reused for every twitter link:

| key         | name          | hosts (aliases)                                   |
|-------------|---------------|---------------------------------------------------|
| youtube     | YouTube       | youtube.com, youtu.be, youtube-nocookie.com       |
| twitter     | X / Twitter   | x.com, twitter.com, t.co                           |
| instagram   | Instagram     | instagram.com, instagr.am, ig.me                  |
| facebook    | Facebook      | facebook.com, fb.watch, fb.com                    |
| tiktok      | TikTok        | tiktok.com                                         |
| bilibili    | Bilibili      | bilibili.com, b23.tv, bilibili.tv                 |
| reddit      | Reddit        | reddit.com, redd.it                               |
| twitch      | Twitch        | twitch.tv                                          |
| vimeo       | Vimeo         | vimeo.com                                          |
| niconico    | Niconico      | nicovideo.jp, nico.ms                             |
| weibo       | Weibo         | weibo.com, weibo.cn                               |
| soundcloud  | SoundCloud    | soundcloud.com                                    |
| dailymotion | Dailymotion   | dailymotion.com, dai.ly                           |

Matching is `host == suffix || host.ends_with(".{suffix}")`, so subdomains
(`m.`, `music.`, `mobile.`) match while look-alikes (`notyoutube.com`,
`youtube.com.evil.example`) do not.

## Storage

`src/cookies.rs`, under `<WHALE_DATA_DIR>/cookies/`:

- `<key>.txt`     → cookies present and **enabled** (applied)
- `<key>.txt.off` → cookies present but **disabled** (kept, not applied)

Enable/disable is an atomic rename. Pasted text is validated (must contain
tab-separated cookie lines) and the Netscape header is prepended if missing.

## Resolution order (per download)

`cookies::resolve(store, global, url)`:

1. platform cookie for the URL's host, **if present and enabled** → use it;
2. else the global `WHALE_COOKIES` file (if configured) → use it;
3. else no cookies.

Applied in both the metadata probe (`api::items::submit`) and the download
worker (`queue::run_job`).

## API (bearer-token protected)

| Method | Path                     | Body                          | Effect                              |
|--------|--------------------------|-------------------------------|-------------------------------------|
| GET    | `/api/cookies`           | —                             | Catalog + per-platform status       |
| PUT    | `/api/cookies/:platform` | `{"cookies":"<netscape txt>"}`| Save (replace), enabled             |
| PATCH  | `/api/cookies/:platform` | `{"enabled":bool}`            | Enable / disable existing cookies   |
| DELETE | `/api/cookies/:platform` | —                             | Remove stored cookies               |

`:platform` must be a known catalog key; unknown keys are rejected with `400`
(this also guards against path traversal, since the key becomes a filename).
