// Whale web UI — the whole client. Bundled (with i18n) and minified into
// ../web/app.js by build.mjs. Importing i18n for its side effect installs
// window.i18n before any app code runs.
import './i18n';

type Params = Record<string, string | number>;

// A history item as returned by the API. Loosely typed — the extra index
// signature keeps the many optional server fields ergonomic to read.
interface Item {
  id: number;
  status: string;
  title?: string;
  filepath?: string | null;
  thumbnail_url?: string;
  duration?: number | null;
  extractor?: string;
  uploader?: string;
  error?: string;
  webpage_url?: string;
  local_available?: boolean;
  public?: boolean;
  public_slug?: string;
  public_until?: number | null;
  public_hits?: number;
  [k: string]: unknown;
}

// A single SSE progress tick.
interface ProgressEv {
  id: number;
  status: string;
  phase?: string;
  speed?: string;
  eta?: string;
  percent?: number | null;
  [k: string]: unknown;
}

// Typed getElementById: every id below is present in index.html.
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as unknown as T;
}

// ---- Native-app theming ---------------------------------------------------
// In the Tauri WebView (Android/desktop) opt the document into Material You /
// Monet theming: html.app-native derives its neutral palette from the system
// AccentColor (see style.css). Browsers keep the plain white / OLED-black
// themes. withGlobalTauri makes window.__TAURI__ available synchronously.
if (window.__TAURI__) document.documentElement.classList.add('app-native');
const isNativeApp = document.documentElement.classList.contains('app-native');

// ---- i18n shorthand -------------------------------------------------------
// `t('key', {vars})` → localized string (see i18n.ts, bundled before app.ts).
const t = (key: string, params?: Params): string => window.i18n.t(key, params);
// Localized status badge label, falling back to the raw status for unknowns.
const statusLabel = (s: string): string => window.i18n.t('status.' + s) || s;

// ---- Token persistence ----------------------------------------------------
const TOKEN_KEY = 'whale_token';
function getToken(): string { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(tok: string): void {
  if (tok) localStorage.setItem(TOKEN_KEY, tok);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---- Server base URL ------------------------------------------------------
// Empty in a browser (same-origin, unchanged). The native app (Tauri) sets this
// to the remote Whale server so the identical UI can talk to it cross-origin.
const BASE_KEY = 'whale_api_base';
function apiBase(): string { return (localStorage.getItem(BASE_KEY) || '').replace(/\/+$/, ''); }
function setApiBase(b: string): void {
  b = (b || '').trim().replace(/\/+$/, '');
  if (b) localStorage.setItem(BASE_KEY, b);
  else localStorage.removeItem(BASE_KEY);
}
// Prefix an app-relative path (starting with `/`) with the configured base.
function apiUrl(path: string): string { return apiBase() + path; }

// Canonical public domain the operator declared via WHALE_PUBLIC_URL, fetched
// from /api/health on boot. Empty until loaded (or if unset) — publicUrl()
// then falls back to the server base / current origin.
let serverPublicUrl = '';
function loadServerConfig(): Promise<void> {
  return fetch(apiUrl('/api/health'))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { serverPublicUrl = ((j && j.public_url) || '').replace(/\/+$/, ''); })
    .catch(() => { /* offline / unreachable — keep the origin fallback */ });
}

// ---- DOM refs -------------------------------------------------------------
const els = {
  settings: byId('settings'),
  settingsToggle: byId('settings-toggle'),
  settingsClose: byId('settings-close'),
  cookies: byId('cookies'),
  cookiesToggle: byId('cookies-toggle'),
  cookiesClose: byId('cookies-close'),
  cookieList: byId('cookie-list'),
  token: byId<HTMLInputElement>('token'),
  tokenSave: byId<HTMLButtonElement>('token-save'),
  tokenHint: byId('token-hint'),
  server: byId<HTMLInputElement>('server'),
  serverSave: byId<HTMLButtonElement>('server-save'),
  sealArchive: byId<HTMLTextAreaElement>('seal-archive'),
  sealImport: byId<HTMLButtonElement>('seal-import'),
  submitForm: byId<HTMLFormElement>('submit-form'),
  url: byId<HTMLInputElement>('url'),
  submitBtn: byId<HTMLButtonElement>('submit-btn'),
  search: byId<HTMLInputElement>('search'),
  history: byId('history'),
  empty: byId('empty'),
  loader: byId('infinite-loader'),
  selectToggle: byId<HTMLButtonElement>('select-toggle'),
  selBar: byId('select-bar'),
  selCount: byId('select-count'),
  selDownload: byId<HTMLButtonElement>('sel-download'),
  selShare: byId<HTMLButtonElement>('sel-share'),
  selUnshare: byId<HTMLButtonElement>('sel-unshare'),
  selCopy: byId<HTMLButtonElement>('sel-copy'),
  selCancel: byId<HTMLButtonElement>('sel-cancel'),
  batchShare: byId('batch-share'),
  batchShareSub: byId('batch-share-sub'),
  batchShareConfirm: byId<HTMLButtonElement>('batch-share-confirm'),
  batchShareClose: byId<HTMLButtonElement>('batch-share-close'),
  toasts: byId('toasts'),
  ptr: byId('ptr'),
  player: byId('player'),
  playerVideo: byId<HTMLVideoElement>('player-video'),
  playerClose: byId<HTMLButtonElement>('player-close'),
  shareOverlay: byId('share'),
  shareTitle: byId('share-title'),
  shareClose: byId<HTMLButtonElement>('share-close'),
  shareMain: byId('share-main'),
  shareLinkRow: byId('share-link-row'),
  shareLink: byId<HTMLInputElement>('share-link'),
  shareCopy: byId<HTMLButtonElement>('share-copy'),
  shareExpiry: byId('share-expiry'),
  shareConfirm: byId<HTMLButtonElement>('share-confirm'),
  shareStop: byId<HTMLButtonElement>('share-stop'),
  shareCancel: byId('share-cancel-confirm'),
  shareCancelBack: byId<HTMLButtonElement>('share-cancel-back'),
  shareCancelYes: byId<HTMLButtonElement>('share-cancel-yes'),
  langToggle: byId<HTMLButtonElement>('lang-toggle'),
  langMenu: byId('lang-menu'),
  themeToggle: byId<HTMLButtonElement>('theme-toggle'),
  themeColorMeta: byId<HTMLMetaElement>('theme-color-meta'),
  serverStatus: byId('server-status'),
};

// ---- List state -----------------------------------------------------------
const PAGE_SIZE = 10; // lazy-load 10 at a time so a huge history never over-fetches
const state = {
  q: '' as string,        // search query (status now folds into the query syntax)
  cursor: null as number | null, // next before_id
  loading: false,
  rows: new Map<number, HTMLLIElement>(),  // id -> <li> element
  items: new Map<number, Item>(),          // id -> latest item object (for the share dialog)
  selectMode: false,                       // multi-select active
  selected: new Set<number>(),             // selected item ids
};

// ---- Toast ----------------------------------------------------------------
function toast(msg: string, kind?: string): void {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); }, 3200);
  setTimeout(() => { el.remove(); }, 3600);
}

// ---- Auth-aware fetch ------------------------------------------------------
async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers, {
    'Authorization': 'Bearer ' + getToken(),
  });
  const res = await fetch(apiUrl(path), Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    showTokenField(true);
    throw { unauthorized: true };
  }
  return res;
}

function showTokenField(invalid: boolean): void {
  els.settings.classList.remove('hidden');
  els.settings.setAttribute('aria-hidden', 'false');
  els.tokenHint.classList.toggle('hidden', !invalid);
  els.token.value = getToken();
  els.token.focus();
}

// ---- Server status light (SSE-driven heartbeat) ---------------------------
// A breathing dot beside the brand: green + pulsing while the SSE stream is
// live (open or delivering events), red when it drops or before a token is set.
// Mirrors the common "connection heartbeat" indicator — driven purely off the
// EventSource lifecycle so it tracks real server reachability, not a poll.
let serverUp = false;
function setServerStatus(up: boolean): void {
  serverUp = up;
  const el = els.serverStatus;
  if (!el) return;
  el.classList.toggle('up', up);
  el.classList.toggle('down', !up);
  const label = up ? t('status.up') : t('status.down');
  el.setAttribute('aria-label', label);
  el.setAttribute('title', label);
}

// ---- Rendering ------------------------------------------------------------
function esc(s: unknown): string {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

const TERMINAL: Record<string, number> = { completed: 1, failed: 1, duplicate: 1 };

// Direct media link. `download` forces a browser save; otherwise it streams
// (used as the <video> source). Token rides in the query since <video>/<a>
// can't send an Authorization header.
function fileUrl(id: number, download?: boolean): string {
  const tok = encodeURIComponent(getToken());
  return apiUrl('/api/items/' + id + '/file?token=' + tok + (download ? '&download=1' : ''));
}

// Tokenless public link, keyed by the item's random slug (not its id, so it
// can't be guessed by enumeration). Prefers the operator-declared public
// domain (WHALE_PUBLIC_URL) so links carry the real domain regardless of the
// origin the UI was loaded from; falls back to the app's server base, then the
// current origin.
function publicUrl(slug: string): string {
  return (serverPublicUrl || apiBase() || location.origin) + '/api/p/' + slug;
}

// Save icon (Lucide "download"): borderless glyph, sized to sit inline on the
// completed status row. No outer chrome — just the currentColor stroke.
const DOWNLOAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;

// Share glyph (Lucide "share-2"): matches the Save icon's borderless, inline
// currentColor style. A single icon replaces the old Public/Private + Copy pair;
// tapping it opens the share dialog (see openShare). When the item is live
// (public), the icon turns the same green as the Completed badge (.act-on) as an
// at-a-glance "this is shared" cue.
const SHARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>`;

// Eye glyph (Lucide "eye") for the external-access counter capsule.
const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;

// Access-count capsule shown after the status badge once a share has been hit
// externally. Persists even after unsharing (public_hits is kept) so an abused
// link stays visible. Styled as a neutral pill (not the green "on" state).
function hitsHtml(item: Item): string {
  const n = item.public_hits || 0;
  if (n <= 0) return '';
  return `<span class="hits" title="External link accesses">${EYE_SVG}<span class="hits-n">${n}</span></span>`;
}

function actionsHtml(item: Item): string {
  if (item.status !== 'completed' || !item.filepath) return '';
  const local = !!item.local_available;
  const pub = !!item.public;
  // Rendered inline on the status row (see rowHtml), pushed to the right. Local
  // file present: Save (download icon) + Share icon. Local file gone (backed
  // away): plays from upstream, no save/share. Sharing state (private vs. live
  // link + expiry) lives inside the share dialog, Baidu-netdisk style.
  const localActions = local
    ? `<a class="act act-icon act-save" href="${fileUrl(item.id, true)}" download aria-label="${esc(t('aria.save'))}" title="${esc(t('aria.save'))}">${DOWNLOAD_SVG}</a>
      <button class="act act-icon act-share ${pub ? 'act-on' : ''}" data-act="share" data-id="${item.id}" aria-label="${esc(t('aria.share'))}" title="${esc(t('aria.share'))}">${SHARE_SVG}</button>`
    : `<span class="act act-cloud" title="Local copy is gone — plays from source">${esc(t('cloud.only'))}</span>`;
  return `<div class="actions">${localActions}</div>`;
}

// Cloud-file corner badge for the thumbnail: shown when an item is completed but
// its local copy is gone, signalling playback will stream from source.
const CLOUD_BADGE = `<span class="cloud-badge" title="Cloud only — plays from source"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 18H6a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 16.5 9H17a3.5 3.5 0 0 1 2 6.37V18Z"/></svg></span>`;
// Play affordance shown on a finished thumbnail (bottom-right). Tapping the
// thumbnail opens the in-app fullscreen player (see openPlayer).
const PLAY_BADGE = `<span class="play-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span>`;

// A completed item with a file is playable in-app (local file or cloud fallback).
function isPlayable(item: Item): boolean {
  return item.status === 'completed' && !!item.filepath;
}

// Friendly platform name from yt-dlp's extractor id (e.g. "youtube:tab" → YouTube).
function sourceLabel(extractor: string | undefined): string {
  if (!extractor) return '';
  const base = String(extractor).split(/[:_]/)[0].toLowerCase();
  const NAMES: Record<string, string> = {
    youtube: 'YouTube', twitter: 'X', x: 'X', bilibili: 'Bilibili', tiktok: 'TikTok',
    instagram: 'Instagram', soundcloud: 'SoundCloud', vimeo: 'Vimeo', twitch: 'Twitch',
    facebook: 'Facebook', reddit: 'Reddit', weibo: 'Weibo', niconico: 'Niconico',
    dailymotion: 'Dailymotion', pornhub: 'Pornhub', generic: 'Web',
  };
  return NAMES[base] || (base.charAt(0).toUpperCase() + base.slice(1));
}

// Per-site logo asset (web/icons/sites/*.svg) for the extractor id. Falls back
// to a neutral globe. Maps yt-dlp extractor bases/aliases → bundled slug.
const SITE_ICONS: Record<string, string> = {
  youtube: 'youtube', twitter: 'x', x: 'x', bilibili: 'bilibili', tiktok: 'tiktok',
  instagram: 'instagram', soundcloud: 'soundcloud', vimeo: 'vimeo', twitch: 'twitch',
  facebook: 'facebook', reddit: 'reddit', weibo: 'weibo', niconico: 'niconico',
  nicovideo: 'niconico', dailymotion: 'dailymotion',
};
function sourceLogoHtml(extractor: string | undefined): string {
  const base = String(extractor || '').split(/[:_]/)[0].toLowerCase();
  const slug = SITE_ICONS[base] || 'generic';
  const name = sourceLabel(extractor) || 'Source';
  return `<img class="src-logo" src="/icons/sites/${slug}.svg" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}

// Thumbnail block. Playable items become a play button (tap → fullscreen player);
// everything else keeps the link out to the source page. Overlays: cloud
// (top-right), duration (bottom-left), play (bottom-right). The source is now
// shown as a logo before the title (see rowHtml), not on the thumbnail.
function thumbHtml(item: Item, thumb: string, dur: string, cloud: string): string {
  const overlays = `${thumb}${dur}${cloud}`;
  if (isPlayable(item)) {
    const cloudOnly = !item.local_available ? '1' : '';
    return `<div class="thumb-wrap thumb-play" role="button" tabindex="0" aria-label="Play"
      data-play="1" data-id="${item.id}" data-cloud="${cloudOnly}">${overlays}${PLAY_BADGE}</div>`;
  }
  return `<a class="thumb-wrap" href="${esc(item.webpage_url)}" target="_blank" rel="noopener">${overlays}</a>`;
}

function rowHtml(item: Item): string {
  const thumb = item.thumbnail_url
    ? `<img class="thumb" src="${esc(item.thumbnail_url)}" alt="" loading="lazy">`
    : `<div class="thumb thumb-empty"></div>`;
  const dur = item.duration ? `<span class="dur">${esc(fmtDuration(item.duration))}</span>` : '';
  const cloud = item.status === 'completed' && item.filepath && !item.local_available ? CLOUD_BADGE : '';
  const logo = sourceLogoHtml(item.extractor);
  const uploader = item.uploader ? `<div class="uploader">${esc(item.uploader)}</div>` : '';
  const active = item.status === 'queued' || item.status === 'running';
  const bar = `<div class="progress ${active ? '' : 'hidden'}"><div class="progress-fill" style="width:0%"></div></div>`;
  const meta = item.error ? `<div class="err">${esc(item.error)}</div>` : '';
  // Multi-select needs no in-card checkbox: the card itself highlights when
  // selected (see .item.selected in style.css), so nothing is injected here that
  // would compete with the thumbnail for horizontal space.
  return `
    ${thumbHtml(item, thumb, dur, cloud)}
    <div class="body">
      <div class="title">${logo}<span>${esc(item.title)}</span></div>
      ${uploader}
      <div class="statusline">
        <span class="badge badge-${esc(item.status)}">${esc(statusLabel(item.status))}</span>
        ${hitsHtml(item)}
        <span class="phase"></span>
        <span class="speed"></span>
        <span class="eta"></span>
        ${actionsHtml(item)}
      </div>
      ${bar}
      ${meta}
    </div>`;
}

function upsertRow(item: Item, prepend?: boolean): HTMLLIElement {
  state.items.set(item.id, item);
  let li = state.rows.get(item.id);
  if (!li) {
    li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = String(item.id);
    // Preserve the visual selection state across a full re-render of the row.
    if (state.selected.has(item.id)) li.classList.add('selected');
    state.rows.set(item.id, li);
    if (prepend) els.history.prepend(li);
    else els.history.appendChild(li);
  }
  li.innerHTML = rowHtml(item);
  els.empty.classList.add('hidden');
  return li;
}

// Patch a row in place from a ProgressEvent (does not rebuild full row).
function patchRow(ev: ProgressEv): void {
  notifyProgress(ev); // native download notification (mobile only; no-op elsewhere)
  const li = state.rows.get(ev.id);
  if (!li) return; // unknown row; will appear on next list load
  const badge = li.querySelector('.badge');
  if (badge) {
    badge.textContent = statusLabel(ev.status);
    badge.className = 'badge badge-' + ev.status;
  }
  const phase = li.querySelector('.phase');
  if (phase) {
    // Label the video/audio pass so the per-pass 0→100% reset reads as a new
    // stage rather than the bar "jumping" backwards.
    phase.textContent = ev.phase ? ev.phase[0].toUpperCase() + ev.phase.slice(1) : '';
    phase.className = 'phase' + (ev.phase ? ' phase-' + ev.phase : '');
  }
  const speed = li.querySelector('.speed');
  if (speed) speed.textContent = ev.speed || '';
  const eta = li.querySelector('.eta');
  if (eta) eta.textContent = ev.eta ? 'ETA ' + ev.eta : '';
  const bar = li.querySelector('.progress');
  const fill = li.querySelector('.progress-fill') as HTMLElement | null;
  const terminal = !!TERMINAL[ev.status];
  if (terminal) {
    if (bar) bar.classList.add('hidden');
    if (phase) phase.textContent = '';
    if (speed) speed.textContent = '';
    if (eta) eta.textContent = '';
    // A just-completed item gains a file: refetch to render play/save/share.
    if (ev.status === 'completed') {
      apiFetch('/api/items/' + ev.id)
        .then((r) => (r.ok ? r.json() : null))
        .then((it) => { if (it) upsertRow(it, false); })
        .catch(() => { /* ignore */ });
    }
  } else if (bar && fill) {
    bar.classList.remove('hidden');
    if (ev.percent != null) fill.style.width = Math.max(0, Math.min(100, ev.percent)) + '%';
  }
}

// ---- List loading ---------------------------------------------------------
async function loadItems(reset?: boolean): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.cursor = null;
    state.rows.clear();
    state.items.clear();
    els.history.innerHTML = '';
    els.loader.classList.add('hidden'); // hide until we know there's a next page
  }
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  params.set('limit', String(PAGE_SIZE));
  if (state.cursor != null) params.set('before_id', String(state.cursor));
  try {
    const res = await apiFetch('/api/items?' + params.toString());
    if (!res.ok) { toast(t('toast.loadHistoryFail'), 'error'); return; }
    const data = await res.json();
    (data.items || []).forEach((it: Item) => upsertRow(it, false));
    state.cursor = data.next_cursor;
    // Keep the spinner mounted (not display:none) while more pages exist so the
    // IntersectionObserver can see it re-enter the viewport for the next page.
    els.loader.classList.toggle('hidden', data.next_cursor == null);
    const isEmpty = state.rows.size === 0;
    els.empty.classList.toggle('hidden', !isEmpty);
  } catch (e) {
    if (!e || !e.unauthorized) toast(t('toast.network'), 'error');
  } finally {
    state.loading = false;
    // If the loader is still within reach (content shorter than the viewport,
    // so no fresh intersection event will fire), keep filling until it scrolls
    // off-screen or the pages run out.
    requestAnimationFrame(topUpIfNeeded);
  }
}

// Pull another page if the spinner is at/near the bottom of the viewport.
function topUpIfNeeded(): void {
  if (state.loading || state.cursor == null || els.loader.classList.contains('hidden')) return;
  const r = els.loader.getBoundingClientRect();
  if (r.top < window.innerHeight + 300) loadItems(false);
}

// ---- Submit ---------------------------------------------------------------
async function submitUrl(url: string): Promise<void> {
  if (!url) return;
  if (!getToken()) { showTokenField(false); toast(t('toast.setToken'), 'error'); return; }
  els.submitBtn.disabled = true;
  try {
    const res = await apiFetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, options: {} }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 422 || (data && data.error === 'probe_failed')) {
      toast(data.message || t('toast.probeFail'), 'error');
      return;
    }
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.submitFail'), 'error');
      return;
    }
    // Accept both single {item} and batch {items} shapes.
    if (Array.isArray(data.items)) {
      data.items.forEach((it: Item) => upsertRow(it, true));
      const dupes = data.duplicates || 0;
      toast(t('toast.queuedN', { n: data.items.length }) + (dupes ? t('toast.dupSuffix', { n: dupes }) : ''),
        dupes ? 'info' : 'ok');
    } else if (data.item) {
      upsertRow(data.item, true);
      toast(data.duplicate ? t('toast.alreadyDownloaded') : t('toast.queued'), data.duplicate ? 'info' : 'ok');
    } else {
      toast(t('toast.queued'), 'ok');
    }
    els.url.value = '';
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    els.submitBtn.disabled = false;
  }
}

// ---- SSE ------------------------------------------------------------------
let es: EventSource | null = null;
function connectEvents(): void {
  const token = getToken();
  if (!token) { setServerStatus(false); return; }
  if (es) { es.close(); es = null; }
  es = new EventSource(apiUrl('/api/events?token=' + encodeURIComponent(token)));
  // Stream established → server is reachable (green breathing light).
  es.onopen = () => setServerStatus(true);
  es.addEventListener('progress', (e) => {
    setServerStatus(true); // any delivered event also confirms liveness
    try { patchRow(JSON.parse((e as MessageEvent).data)); } catch (_) { /* ignore */ }
  });
  // Stream dropped → red. EventSource retries a merely-stalled stream itself,
  // but on some (Android WebView) engines a connection that never opened — e.g.
  // the network wasn't up yet at a cold app launch — gets wedged and never
  // recovers on its own. Schedule our own reconnect so the heartbeat (and live
  // updates) heal without a manual reload; the re-check skips it if it recovered.
  es.onerror = () => {
    setServerStatus(false);
    scheduleReconnect();
  };
}

// One pending reconnect at a time; recreates the stream unless it came back on
// its own in the meantime.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect(): void {
  if (reconnectTimer || !getToken()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!es || es.readyState !== EventSource.OPEN) connectEvents();
  }, 3000);
}

// Regaining visibility/focus (mobile suspends sockets) re-opens the stream if it
// isn't already live, so the light turns green again on resume.
function ensureEventsConnected(): void {
  if (!getToken()) return;
  if (!es || es.readyState !== EventSource.OPEN) connectEvents();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureEventsConnected(); });
window.addEventListener('focus', ensureEventsConnected);

// ---- Cookies --------------------------------------------------------------
function fmtBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

interface CookiePlatform {
  key: string;
  name: string;
  present: boolean;
  enabled: boolean;
  bytes: number;
  login_url: string;
}

function cookieRowHtml(p: CookiePlatform): string {
  const statusText = !p.present
    ? `<span class="ck-status ck-none">${esc(t('cookie.notSet'))}</span>`
    : p.enabled
      ? `<span class="ck-status ck-on">${esc(t('cookie.active', { size: fmtBytes(p.bytes) }))}</span>`
      : `<span class="ck-status ck-off">${esc(t('cookie.disabled', { size: fmtBytes(p.bytes) }))}</span>`;
  const actions = p.present
    ? `<button class="ck-btn" data-act="toggle" data-enabled="${p.enabled ? 'false' : 'true'}">${esc(p.enabled ? t('cookie.disable') : t('cookie.enable'))}</button>
       <button class="ck-btn ck-danger" data-act="delete">${esc(t('cookie.delete'))}</button>`
    : '';
  return `
    <div class="ck-head">
      <span class="ck-name">${esc(p.name)}</span>
      ${statusText}
    </div>
    <div class="ck-body">
      <a class="ck-btn" href="${esc(p.login_url)}" target="_blank" rel="noopener">${esc(t('cookie.login'))}</a>
      <button class="ck-btn" data-act="paste">${esc(p.present ? t('cookie.replace') : t('cookie.paste'))}</button>
      ${actions}
      <textarea class="ck-paste hidden" placeholder="${esc(t('ph.cookiePaste'))}" rows="4"></textarea>
      <div class="ck-paste-actions hidden">
        <button class="ck-btn ck-primary" data-act="save">${esc(t('cookie.save'))}</button>
        <button class="ck-btn" data-act="cancel">${esc(t('cookie.cancel'))}</button>
      </div>
    </div>`;
}

async function loadCookies(): Promise<void> {
  if (!getToken()) { showTokenField(false); toast('Set your token first', 'error'); return; }
  try {
    const res = await apiFetch('/api/cookies');
    if (!res.ok) { toast(t('toast.loadCookiesFail'), 'error'); return; }
    const data = await res.json();
    els.cookieList.innerHTML = '';
    (data.platforms || []).forEach((p: CookiePlatform) => {
      const div = document.createElement('div');
      div.className = 'cookie-item';
      div.dataset.key = p.key;
      div.innerHTML = cookieRowHtml(p);
      els.cookieList.appendChild(div);
    });
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  }
}

async function cookieAction(key: string, act: string, el: HTMLElement): Promise<void> {
  const item = el.closest('.cookie-item') as HTMLElement;
  const paste = item.querySelector('.ck-paste') as HTMLTextAreaElement;
  const pasteActions = item.querySelector('.ck-paste-actions') as HTMLElement;
  if (act === 'paste') {
    paste.classList.remove('hidden');
    pasteActions.classList.remove('hidden');
    paste.focus();
    return;
  }
  if (act === 'cancel') {
    paste.value = '';
    paste.classList.add('hidden');
    pasteActions.classList.add('hidden');
    return;
  }
  try {
    let res: Response | undefined;
    if (act === 'save') {
      const text = paste.value.trim();
      if (!text) { toast(t('toast.pasteCookiesFirst'), 'error'); return; }
      res = await apiFetch('/api/cookies/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: text }),
      });
    } else if (act === 'toggle') {
      const enabled = el.dataset.enabled === 'true';
      res = await apiFetch('/api/cookies/' + encodeURIComponent(key), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } else if (act === 'delete') {
      res = await apiFetch('/api/cookies/' + encodeURIComponent(key), { method: 'DELETE' });
    }
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.cookieUpdateFail'), 'error'); return; }
    if (act === 'save') toast(t('toast.cookiesSaved'), 'ok');
    if (act === 'delete') toast(t('toast.cookiesRemoved'), 'info');
    loadCookies();
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  }
}

// ---- Share dialog (Baidu-netdisk style) -----------------------------------
// Items start private. Tapping the share icon opens a dialog to pick a window
// (7 days / 30 days / permanent); confirming makes the item public with that
// expiry and reveals a copyable tokenless link. Re-sharing/going private live
// in the same dialog.
const share: { id: number | null } = { id: null };

// Human-friendly "expires in N days" / "expired" from a Unix-seconds timestamp.
function fmtExpiry(untilSec: number | null | undefined): string {
  if (untilSec == null) return t('expiry.never');
  const secs = untilSec - Math.floor(Date.now() / 1000);
  if (secs <= 0) return t('expiry.expired');
  const days = Math.floor(secs / 86400);
  if (days >= 1) return t('expiry.in', { n: days, unit: t(days === 1 ? 'unit.day' : 'unit.days') });
  const hours = Math.max(1, Math.floor(secs / 3600));
  return t('expiry.in', { n: hours, unit: t(hours === 1 ? 'unit.hour' : 'unit.hours') });
}

function openShare(id: number): void {
  const item = state.items.get(id);
  if (!item) return;
  share.id = id;
  els.shareOverlay.classList.remove('hidden');
  els.shareOverlay.setAttribute('aria-hidden', 'false');
  showCancelConfirm(false); // always start on the main view
  renderShare(item);
}

// Toggle between the main share view and the cancel-confirmation ("undo") view.
function showCancelConfirm(on: boolean): void {
  els.shareMain.classList.toggle('hidden', on);
  els.shareCancel.classList.toggle('hidden', !on);
}

function closeShare(): void {
  share.id = null;
  els.shareOverlay.classList.add('hidden');
  els.shareOverlay.setAttribute('aria-hidden', 'true');
}

// Reflect the item's current sharing state: a live public link (with expiry +
// copy + stop-sharing) or the duration picker for a private item.
function renderShare(item: Item): void {
  const live = !!item.public && !!item.public_slug;
  els.shareTitle.textContent = item.title || t('share.title');
  if (live) {
    els.shareLinkRow.classList.remove('hidden');
    els.shareLink.value = publicUrl(item.public_slug!);
    els.shareExpiry.textContent = fmtExpiry(item.public_until);
    els.shareStop.classList.remove('hidden');
    els.shareConfirm.textContent = t('share.update');
  } else {
    els.shareLinkRow.classList.add('hidden');
    els.shareStop.classList.add('hidden');
    els.shareConfirm.textContent = t('share.create');
  }
}

// POST the chosen public state + window; re-render the dialog and the row.
async function applyShare(makePublic: boolean): Promise<void> {
  const id = share.id;
  if (id == null) return;
  const days = selectedShareDays(); // 7 | 30 | null (permanent)
  const body = makePublic ? { public: true, expires_in_days: days } : { public: false };
  els.shareConfirm.disabled = true;
  els.shareStop.disabled = true;
  try {
    const res = await apiFetch('/api/items/' + id + '/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.updateFail'), 'error'); return; }
    upsertRow(data, false);            // refresh the row's share icon (green) state
    if (!makePublic) { toast(t('toast.sharingStopped'), 'info'); closeShare(); }
    else { if (share.id === id) { showCancelConfirm(false); renderShare(data); } toast(t('toast.linkReady'), 'ok'); }
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    els.shareConfirm.disabled = false;
    els.shareStop.disabled = false;
  }
}

// Selected radio value → days (null for the permanent option).
function selectedShareDays(): number | null {
  const sel = els.shareOverlay.querySelector('input[name="share-window"]:checked') as HTMLInputElement | null;
  const v = sel ? sel.value : '7';
  return v === 'permanent' ? null : Number(v);
}

function copyShareLink(): void {
  const link = els.shareLink.value;
  if (!link) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(
      () => toast(t('toast.linkCopied'), 'ok'),
      () => { els.shareLink.select(); toast(link, 'info'); });
  } else {
    els.shareLink.select();
    toast(link, 'info');
  }
}

// ---- Debounce -------------------------------------------------------------
function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let h: ReturnType<typeof setTimeout> | undefined;
  return function (...args: A): void {
    clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  };
}

// ---- Modal dialogs (settings / cookies) -----------------------------------
// Popup overlays modelled on the share dialog: backdrop dismiss, aria state,
// and a close button — rather than panels rendered inline into the page.
function openModal(el: HTMLElement): void {
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
}
function closeModal(el: HTMLElement): void {
  // Drop focus first: hiding an ancestor with aria-hidden while a descendant
  // (e.g. the close button) keeps focus trips an a11y warning.
  if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

// ---- Wire up UI -----------------------------------------------------------
els.settingsToggle.addEventListener('click', () => {
  closeModal(els.cookies);
  els.token.value = getToken();
  if (els.server) els.server.value = apiBase();
  openModal(els.settings);
  loadArchive();
});
els.settingsClose.addEventListener('click', () => closeModal(els.settings));
els.settings.addEventListener('click', (e) => {
  if (e.target === els.settings) closeModal(els.settings); // backdrop dismiss
});

els.cookiesToggle.addEventListener('click', () => {
  closeModal(els.settings);
  openModal(els.cookies);
  loadCookies();
});
els.cookiesClose.addEventListener('click', () => closeModal(els.cookies));
els.cookies.addEventListener('click', (e) => {
  if (e.target === els.cookies) closeModal(els.cookies); // backdrop dismiss
});

els.cookieList.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const item = btn.closest('.cookie-item') as HTMLElement | null;
  if (!item) return;
  cookieAction(item.dataset.key!, btn.dataset.act!, btn);
});

els.tokenSave.addEventListener('click', () => {
  setToken(els.token.value.trim());
  els.tokenHint.classList.add('hidden');
  closeModal(els.settings);
  connectEvents();
  loadItems(true);
});

// Server URL (app only): persist, then reconnect the SSE + reload against it.
if (els.serverSave) {
  els.serverSave.addEventListener('click', () => {
    setApiBase(els.server.value);
    closeModal(els.settings);
    loadServerConfig();
    connectEvents();
    loadItems(true);
  });
}

// ---- Seal / yt-dlp download archive editor --------------------------------
// Not just import: the textarea shows every dedup key Whale has recorded so the
// user can edit history in place. Save reconciles the edited list against what
// was loaded — added lines are imported, removed lines are deleted.
let sealLoaded = new Set<string>(); // keys present when the editor was last loaded

// Parse the textarea into a Set of valid `extractor id` keys (space-bearing).
function parseArchiveKeys(): Set<string> {
  return new Set(
    (els.sealArchive.value || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.includes(' '))
  );
}

async function loadArchive(): Promise<void> {
  if (!els.sealArchive || !getToken()) return;
  try {
    const res = await apiFetch('/api/archive');
    if (!res.ok) return;
    const data = await res.json();
    const keys = (data.keys || []).slice().sort();
    sealLoaded = new Set(keys);
    els.sealArchive.value = keys.join('\n');
  } catch (e) {
    if (!e || !e.unauthorized) toast(t('toast.loadArchiveFail'), 'error');
  }
}

if (els.sealImport) {
  els.sealImport.addEventListener('click', async () => {
    const now = parseArchiveKeys();
    const toAdd = [...now].filter((k) => !sealLoaded.has(k));
    const toRemove = [...sealLoaded].filter((k) => !now.has(k));
    if (!toAdd.length && !toRemove.length) { toast(t('toast.noChanges'), 'info'); return; }
    els.sealImport.disabled = true;
    try {
      if (toAdd.length) {
        const res = await apiFetch('/api/archive/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archive: toAdd.join('\n') }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
          return;
        }
      }
      for (const key of toRemove) {
        const res = await apiFetch('/api/archive', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) { toast(t('toast.removeFail', { key }), 'error'); return; }
      }
      sealLoaded = now;
      els.sealArchive.value = [...now].sort().join('\n');
      toast(t('toast.archiveSaved', { add: toAdd.length, rem: toRemove.length }), 'ok');
    } catch (e) {
      if (!e || !e.unauthorized) toast('Network error', 'error');
    } finally {
      els.sealImport.disabled = false;
    }
  });
}

els.submitForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitUrl(els.url.value.trim());
});

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  loadItems(true);
}, 300));

// Infinite scroll: pull the next page whenever the spinner scrolls into view.
// rootMargin pre-fetches a little before it's actually visible.
const loaderObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !state.loading && state.cursor != null) {
    loadItems(false);
  }
}, { rootMargin: '300px' });
loaderObserver.observe(els.loader);

// Delegated actions on cards: in select mode a tap toggles the row; otherwise
// thumbnail play / share dialog as before.
els.history.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (state.selectMode) {
    if (suppressClick) { suppressClick = false; return; } // ignore the click a long-press spawns
    const li = target.closest('.item') as HTMLElement | null;
    if (li) { e.preventDefault(); toggleSelect(Number(li.dataset.id)); }
    return;
  }
  const play = target.closest('.thumb-play') as HTMLElement | null;
  if (play) { e.preventDefault(); openPlayer(Number(play.dataset.id), play.dataset.cloud === '1'); return; }

  const btn = target.closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'share') openShare(id);
});

// ---- Multi-select -------------------------------------------------------
// Toggle via the toolbar button or by long-pressing a card (touch). Selected
// items can be batch-downloaded, shared, or have their links copied. There is no
// per-card checkbox: the whole card highlights when selected (industry-standard
// "selection state on the surface itself"), so the thumbnail keeps its full size.
function enterSelectMode(): void {
  state.selectMode = true;
  document.body.classList.add('selecting');
  els.selectToggle.classList.add('active');
  updateSelBar();
}
function exitSelectMode(): void {
  state.selectMode = false;
  document.body.classList.remove('selecting');
  els.selectToggle.classList.remove('active');
  state.selected.clear();
  state.rows.forEach((li) => li.classList.remove('selected'));
  updateSelBar();
}
function toggleSelect(id: number): void {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const li = state.rows.get(id);
  if (li) li.classList.toggle('selected', state.selected.has(id));
  updateSelBar();
}
function updateSelBar(): void {
  const n = state.selected.size;
  els.selCount.textContent = n ? t('sel.countN', { n }) : t('sel.count0');
  els.selBar.classList.toggle('hidden', !state.selectMode);
  [els.selDownload, els.selShare, els.selUnshare, els.selCopy].forEach((b) => { b.disabled = n === 0; });
}

// Items backing the current selection (latest known objects).
function selectedItems(): Item[] {
  return [...state.selected].map((id) => state.items.get(id)).filter(Boolean) as Item[];
}

els.selectToggle.addEventListener('click', () => {
  if (state.selectMode) exitSelectMode();
  else enterSelectMode();
});
els.selCancel.addEventListener('click', exitSelectMode);

// Long-press a card (touch) to enter select mode / select that row. A moved
// finger or lifted press under the threshold cancels (so scrolling is intact).
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let suppressClick = false; // set when a long-press fired, to swallow the trailing click
els.history.addEventListener('touchstart', (e) => {
  suppressClick = false; // clear any stale flag from a prior long-press with no click
  const li = (e.target as HTMLElement).closest('.item') as HTMLElement | null;
  if (!li) return;
  const id = Number(li.dataset.id);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    if (!state.selectMode) enterSelectMode();
    toggleSelect(id);
    if (navigator.vibrate) navigator.vibrate(15);
  }, 500);
}, { passive: true });
function cancelPress(): void { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
els.history.addEventListener('touchmove', cancelPress, { passive: true });
els.history.addEventListener('touchend', cancelPress);
els.history.addEventListener('touchcancel', cancelPress);

// ---- Batch actions ------------------------------------------------------
function copyText(text: string, okMsg: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg, 'ok'), () => toast(text, 'info'));
  } else {
    toast(text, 'info');
  }
}

// Save every selected item that still has a local file. Staggered so the
// browser doesn't drop rapid concurrent downloads.
function batchDownload(): void {
  const items = selectedItems().filter((it) => it.status === 'completed' && it.local_available && it.filepath);
  if (!items.length) { toast(t('toast.noDownloadable'), 'info'); return; }
  items.forEach((it, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = fileUrl(it.id, true);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
  toast(t('toast.downloadingN', { n: items.length }), 'ok');
}

// Open the batch-share dialog: the same 7 / 30 / permanent duration picker as
// the single-item share, applied to every selected completed item at once.
function openBatchShare(): void {
  const items = selectedItems().filter((it) => it.status === 'completed' && it.filepath);
  if (!items.length) { toast(t('toast.noShareable'), 'info'); return; }
  els.batchShareSub.textContent = t('batchShare.sub', { n: items.length });
  const def = els.batchShare.querySelector('input[value="7"]') as HTMLInputElement | null;
  if (def) def.checked = true; // reset to the default window each open
  openModal(els.batchShare);
}

// Selected batch-share radio → days (null for the permanent option).
function selectedBatchShareDays(): number | null {
  const sel = els.batchShare.querySelector('input[name="batch-share-window"]:checked') as HTMLInputElement | null;
  const v = sel ? sel.value : '7';
  return v === 'permanent' ? null : Number(v);
}

// Make every selected completed item public with the chosen window.
async function applyBatchShare(): Promise<void> {
  const items = selectedItems().filter((it) => it.status === 'completed' && it.filepath);
  if (!items.length) { closeModal(els.batchShare); return; }
  const days = selectedBatchShareDays();
  els.batchShareConfirm.disabled = true;
  let ok = 0;
  try {
    for (const it of items) {
      const res = await apiFetch('/api/items/' + it.id + '/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: true, expires_in_days: days }),
      });
      if (res.ok) { const data = await res.json(); upsertRow(data, false); ok++; }
    }
    const label = days == null ? t('dur.permanently') : t('dur.days', { n: days });
    toast(ok ? t('toast.sharedN', { n: ok, dur: label }) : t('toast.shareFail'), ok ? 'ok' : 'error');
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    els.batchShareConfirm.disabled = false;
    closeModal(els.batchShare);
    updateSelBar(); // re-enable per current selection
  }
}

// Stop sharing every selected item that is currently public (turns them private).
async function batchUnshare(): Promise<void> {
  const items = selectedItems().filter((it) => it.public);
  if (!items.length) { toast(t('toast.noShared'), 'info'); return; }
  els.selUnshare.disabled = true;
  let ok = 0;
  try {
    for (const it of items) {
      const res = await apiFetch('/api/items/' + it.id + '/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: false }),
      });
      if (res.ok) { const data = await res.json(); upsertRow(data, false); ok++; }
    }
    toast(ok ? t('toast.stoppedSharingN', { n: ok }) : t('toast.updateFail'), ok ? 'info' : 'error');
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    updateSelBar();
  }
}

// Copy the public links of the selected items that are currently shared.
function batchCopyLinks(): void {
  const links = selectedItems()
    .filter((it) => it.public && it.public_slug)
    .map((it) => publicUrl(it.public_slug!));
  if (!links.length) { toast(t('toast.noSharedLinks'), 'info'); return; }
  copyText(links.join('\n'), t('toast.linksCopiedN', { n: links.length }));
}

els.selDownload.addEventListener('click', batchDownload);
els.selShare.addEventListener('click', openBatchShare);
els.selUnshare.addEventListener('click', batchUnshare);
els.selCopy.addEventListener('click', batchCopyLinks);
els.batchShareConfirm.addEventListener('click', applyBatchShare);
els.batchShareClose.addEventListener('click', () => closeModal(els.batchShare));
els.batchShare.addEventListener('click', (e) => {
  if (e.target === els.batchShare) closeModal(els.batchShare); // backdrop dismiss
});

// Once a thumbnail image loads we know its real orientation. Portrait sources
// (vertical video) get their wrapper tagged so CSS shows a portrait box instead
// of cropping them into the landscape default. `load` doesn't bubble, so listen
// in the capture phase on the shared list container.
els.history.addEventListener('load', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('thumb')) return;
  const portrait = img.naturalHeight > img.naturalWidth * 1.05;
  img.closest('.thumb-wrap')?.classList.toggle('portrait', portrait);
}, true);

// Keyboard access for the play thumbnail (it's a role="button").
els.history.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const play = (e.target as HTMLElement).closest('.thumb-play') as HTMLElement | null;
  if (!play) return;
  e.preventDefault();
  openPlayer(Number(play.dataset.id), play.dataset.cloud === '1');
});

// ---- Fullscreen in-app player ---------------------------------------------
// Tapping a finished thumbnail opens a fullscreen overlay instead of navigating
// away (a new page/tab fights the mobile app's single-task model). We push a
// history entry so the Android back button pops the player back to the list
// rather than exiting the app.
function openPlayer(id: number, cloud: boolean): void {
  const v = els.playerVideo;
  els.player.classList.remove('hidden');
  els.player.setAttribute('aria-hidden', 'false');
  document.body.classList.add('player-open');
  // Browser: push a history entry so Back pops the player. In the native app the
  // central back handler (below) does this via its own sentinel — don't stack.
  if (!isNativeApp && !(history.state && history.state.player)) history.pushState({ player: true }, '');
  const play = () => v.play().catch(() => { /* autoplay may need a tap */ });
  if (cloud) {
    v.removeAttribute('src');
    v.dataset.loading = '1';
    apiFetch('/api/items/' + id + '/stream-url')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.url) { v.src = d.url; v.load(); play(); }
        else { toast(t('toast.streamFail'), 'error'); closePlayer(true); }
      })
      .catch(() => { closePlayer(true); })
      .finally(() => { delete v.dataset.loading; });
  } else {
    v.src = fileUrl(id);
    v.load();
    play();
  }
}

// Hide the player and release the media. `pop` true rewinds the history entry
// we pushed (used when closing via the ✕ button; the back button already popped).
function closePlayer(pop: boolean): void {
  if (els.player.classList.contains('hidden')) return;
  const v = els.playerVideo;
  v.pause();
  v.removeAttribute('src');
  v.load();
  els.player.classList.add('hidden');
  els.player.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('player-open');
  if (!isNativeApp && pop && history.state && history.state.player) history.back();
}

// ---- Share dialog wiring --------------------------------------------------
els.shareClose.addEventListener('click', closeShare);
els.shareOverlay.addEventListener('click', (e) => {
  if (e.target === els.shareOverlay) closeShare(); // click the backdrop to dismiss
});
els.shareConfirm.addEventListener('click', () => applyShare(true));
els.shareStop.addEventListener('click', () => showCancelConfirm(true));   // ask first
els.shareCancelBack.addEventListener('click', () => showCancelConfirm(false));
els.shareCancelYes.addEventListener('click', () => applyShare(false));
els.shareCopy.addEventListener('click', copyShareLink);

els.playerClose.addEventListener('click', () => closePlayer(true));

// ---- Android back button --------------------------------------------------
// Back should peel one layer at a time — close the top-most open surface
// (fullscreen player → a modal → multi-select mode) instead of leaving the app
// — then, with nothing left open, a "press Back again to exit" guard prevents a
// stray single Back from quitting. This is the standard Android app pattern
// (Telegram/WhatsApp). See CLAUDE.md "Android back".
//
// Mechanism: the hardware Back is delivered to the WebView as history
// navigation, so we keep one sentinel history entry to consume. On popstate we
// close the top layer and re-arm the sentinel; when nothing is open we run the
// double-press exit. Browsers keep native back behavior — only the native app
// installs this (the exit uses the Tauri process plugin).

// Close the top-most open surface. Returns true if it handled the Back.
function dismissTopLayer(): boolean {
  if (!els.player.classList.contains('hidden')) { closePlayer(false); return true; }
  if (!els.batchShare.classList.contains('hidden')) { closeModal(els.batchShare); return true; }
  if (!els.shareOverlay.classList.contains('hidden')) { closeShare(); return true; }
  if (!els.settings.classList.contains('hidden')) { closeModal(els.settings); return true; }
  if (!els.cookies.classList.contains('hidden')) { closeModal(els.cookies); return true; }
  if (state.selectMode) { exitSelectMode(); return true; }
  return false;
}

if (isNativeApp) {
  let exitArmed = false;
  let exitArmedAt = 0;
  const armSentinel = () => history.pushState({ whaleBack: true }, '');

  // Ask Tauri to quit (process plugin). If it's unavailable the sentinel isn't
  // re-armed, so we've dropped to the WebView root and the next hardware Back
  // exits the activity anyway — a safe fallback, just one extra press.
  const exitApp = () => {
    const T = window.__TAURI__;
    try { T && T.core && T.core.invoke('plugin:process|exit', { code: 0 }); } catch (_) { /* fall through */ }
  };

  // Seed the sentinel so the first Back always yields a popstate to catch.
  armSentinel();

  window.addEventListener('popstate', () => {
    if (dismissTopLayer()) { exitArmed = false; armSentinel(); return; }
    // Nothing open → double-press-to-exit.
    const now = Date.now();
    if (exitArmed && now - exitArmedAt < 2000) { exitApp(); return; }
    exitArmed = true;
    exitArmedAt = now;
    toast(t('toast.pressBackExit'), 'info');
    armSentinel();
  });
} else {
  // Browser / installed PWA: Back pops whatever pushed a history entry (today
  // that's only the player).
  window.addEventListener('popstate', () => {
    if (!els.player.classList.contains('hidden')) closePlayer(false);
  });
}

// ---- Share target: ?url= / ?text= (browser/PWA) ---------------------------
function handleShareParam(): void {
  const p = new URLSearchParams(location.search);
  const shared = p.get('url') || p.get('text') || '';
  if (!shared) return;
  // Clean the URL so a reload doesn't resubmit.
  history.replaceState(null, '', location.pathname);
  handleSharedText(shared);
}

// Pull the first http(s) URL out of arbitrary shared text ("Watch this https://…").
function extractUrl(text: string): string {
  const m = String(text || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : (text || '').trim();
}

// Common entry for a shared URL from any source: fill the box and submit.
function handleSharedText(shared: string): void {
  let text = String(shared || '');
  // Some share paths (the Android sharetarget plugin) deliver the text
  // percent-encoded (https%3A%2F%2F…). Decode defensively before extracting.
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    try { text = decodeURIComponent(text); } catch (_) { /* keep raw */ }
  }
  const url = extractUrl(text);
  if (!url) return;
  els.url.value = url;
  if (getToken()) submitUrl(url);
  else { showTokenField(false); toast(t('toast.setTokenSubmit'), 'info'); }
}

// ---- Android/iOS share target (native app) --------------------------------
// The mobile-sharetarget plugin queues ACTION_SEND intents; drain them on
// launch and whenever the app regains focus. No-op outside the Tauri app.
async function drainSharedIntents(): Promise<void> {
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) return;
  try {
    for (let i = 0; i < 20; i++) {
      const text = await T.core.invoke('plugin:mobile-sharetarget|pop_intent_queue_and_extract_text');
      if (!text) break;
      handleSharedText(text);
    }
  } catch (_) { /* plugin absent (desktop) or nothing queued */ }
}

// Drain now, then again shortly after: a shared intent is often enqueued a beat
// after the focus/resume event that woke us, so a single drain can miss it
// (this was the "X share does nothing" bug).
function drainSoon(): void {
  drainSharedIntents();
  setTimeout(drainSharedIntents, 250);
  setTimeout(drainSharedIntents, 700);
}

function setupNativeShare(): void {
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) return; // desktop / plugin absent
  drainSoon();
  if (T.event && T.event.listen) {
    // Android delivers a fresh share via focus/resume on the existing task.
    T.event.listen('tauri://focus', drainSoon);
    T.event.listen('tauri://resume', drainSoon);
    T.event.listen('new-intent', drainSoon);
  }
  // Belt-and-suspenders: any time the WebView regains visibility/focus, re-drain.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) drainSoon(); });
  window.addEventListener('focus', drainSoon);
}

// ---- Native download notifications (mobile) -------------------------------
// Seal-style: ask for the notification permission up front, then surface each
// download's live progress as an ongoing notification that updates in place.
const notif: { granted: boolean; last: Map<number, { pct: number; t: number; phase: string }> } = {
  granted: false,
  last: new Map(),
};

async function setupNotifications(): Promise<void> {
  const N = window.__TAURI__ && window.__TAURI__.notification;
  if (!N) return; // desktop browser or plugin absent
  try {
    let ok = await N.isPermissionGranted();
    if (!ok) ok = (await N.requestPermission()) === 'granted';
    notif.granted = !!ok;
  } catch (_) { /* plugin missing/blocked — silently skip */ }
}

// Drive a per-item notification from progress ticks. Throttled so we replace one
// ongoing notification (by item id) instead of spamming a stack of them.
function notifyProgress(ev: ProgressEv): void {
  const N = window.__TAURI__ && window.__TAURI__.notification;
  if (!N || !notif.granted) return;
  const li = state.rows.get(ev.id);
  const titleEl = li && li.querySelector('.title');
  const title = (titleEl && titleEl.textContent) || ('Item #' + ev.id);
  try {
    if (ev.status === 'completed') {
      N.sendNotification({ id: ev.id, icon: 'ic_notification', title, body: '✓ Download complete', ongoing: false, autoCancel: true });
      notif.last.delete(ev.id);
      return;
    }
    if (ev.status === 'failed') {
      N.sendNotification({ id: ev.id, icon: 'ic_notification', title, body: '✗ Download failed', ongoing: false, autoCancel: true });
      notif.last.delete(ev.id);
      return;
    }
    if (ev.status !== 'running') return;
    const prev = notif.last.get(ev.id) || { pct: -10, t: 0, phase: '' };
    const now = Date.now();
    const pct = ev.percent == null ? prev.pct : ev.percent;
    const phaseChanged = (ev.phase || '') !== prev.phase;
    // Update at most ~1/s and only on a ≥2% move or a stage change.
    if (!phaseChanged && now - prev.t < 900 && Math.abs(pct - prev.pct) < 2) return;
    const stage = ev.phase ? ev.phase[0].toUpperCase() + ev.phase.slice(1) + ' · ' : '';
    const pctStr = ev.percent == null ? 'Downloading' : Math.round(ev.percent) + '%';
    const spd = ev.speed ? ' · ' + ev.speed : '';
    N.sendNotification({ id: ev.id, icon: 'ic_notification', title, body: `${stage}${pctStr}${spd}`, ongoing: true, silent: true });
    notif.last.set(ev.id, { pct, t: now, phase: ev.phase || '' });
  } catch (_) { /* plugin call failed; ignore */ }
}

// ---- Pull-to-refresh ------------------------------------------------------
// Other clients can enqueue downloads out of band; a pull-down reloads the list.
(function setupPullToRefresh() {
  const THRESH = 70; // px pull to trigger a refresh
  const ptr = els.ptr;
  let startY = 0, pulling = false, dist = 0;
  const atTop = () => window.scrollY <= 0;

  window.addEventListener('touchstart', (e) => {
    pulling = atTop() && !state.loading && els.player.classList.contains('hidden');
    if (pulling) { startY = e.touches[0].clientY; dist = 0; }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) { ptr.style.transform = ''; ptr.classList.remove('visible', 'ready'); return; }
    const pull = Math.min(dist, THRESH * 1.6);
    ptr.classList.add('visible');
    ptr.classList.toggle('ready', dist >= THRESH);
    ptr.style.transform = `translateX(-50%) translateY(${pull}px)`;
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (!pulling) return;
    const trigger = dist >= THRESH;
    pulling = false;
    ptr.style.transform = '';
    ptr.classList.remove('visible', 'ready');
    if (trigger) {
      ptr.classList.add('spinning');
      Promise.resolve(loadItems(true)).finally(() => ptr.classList.remove('spinning'));
    }
  });
})();

// ---- Service worker -------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  });
}

// ---- Language picker (topbar popover) -------------------------------------
// Auto-detected from the browser/OS on first load (see i18n.ts). The languages
// icon in the topbar opens a small popover menu — the standard header-menu
// pattern — to override the current page; "Auto (system)" clears the override.
function renderLangMenu(): void {
  if (!els.langMenu) return;
  const pref = window.i18n.langPref();
  const langs = window.i18n.supported();
  const rows: [string, string][] = [
    ['auto', t('lang.auto')],
    ...Object.keys(langs).map((code) => [code, langs[code].label] as [string, string]),
  ];
  els.langMenu.innerHTML = rows.map(([code, label]) =>
    `<button class="popover-item${code === pref ? ' active' : ''}" role="menuitemradio"
       aria-checked="${code === pref}" data-lang="${code}">${esc(label)}</button>`).join('');
}

function toggleLangMenu(open?: boolean): void {
  const willOpen = open != null ? open : els.langMenu.classList.contains('hidden');
  if (willOpen) renderLangMenu();
  els.langMenu.classList.toggle('hidden', !willOpen);
  els.langToggle.setAttribute('aria-expanded', String(willOpen));
  els.langToggle.classList.toggle('active', willOpen);
}

if (els.langToggle) {
  els.langToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleLangMenu(); });
  els.langMenu.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-lang]') as HTMLElement | null;
    if (!btn) return;
    window.i18n.setLang(btn.dataset.lang!);
    toggleLangMenu(false);
  });
  // Click / tap anywhere else closes the popover.
  document.addEventListener('click', (e) => {
    if (els.langMenu.classList.contains('hidden')) return;
    if (!els.langMenu.contains(e.target as Node) && e.target !== els.langToggle) toggleLangMenu(false);
  });
}

// ---- Theme toggle (system-aware, manual override) -------------------------
// Follows the OS by default; the sun/moon button cycles System → Light → Dark.
// A forced choice sets html[data-theme] (see style.css); "system" removes it so
// prefers-color-scheme governs again. The glyph shows the *effective* theme.
const THEME_KEY = 'whale_theme';
const THEME_ORDER = ['system', 'light', 'dark'];
const SUN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`;

function themePref(): string { return localStorage.getItem(THEME_KEY) || 'system'; }
function systemDark(): boolean { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
function effectiveTheme(): string {
  const p = themePref();
  return p === 'system' ? (systemDark() ? 'dark' : 'light') : p;
}

// Apply the preference: force via data-theme, or clear it to follow the system.
// Also keep the status-bar theme-color meta in sync with the resolved bg.
function applyTheme(): void {
  const pref = themePref();
  if (pref === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', pref);
  if (els.themeColorMeta) {
    // Read the actual resolved background so app-native Monet tints are honored.
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) els.themeColorMeta.setAttribute('content', bg);
  }
}

function renderThemeToggle(): void {
  if (!els.themeToggle) return;
  els.themeToggle.innerHTML = effectiveTheme() === 'dark' ? MOON_SVG : SUN_SVG;
  const label = t('aria.theme') + ': ' + t('theme.' + themePref());
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('title', label);
}

if (els.themeToggle) {
  els.themeToggle.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themePref()) + 1) % THEME_ORDER.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme();
    renderThemeToggle();
  });
  // Re-resolve when the system theme flips while we're following it.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (themePref() === 'system') { applyTheme(); renderThemeToggle(); }
    });
  }
}

// Re-render everything that isn't covered by static [data-i18n] markup whenever
// the language changes: the theme toggle's mode label, the server-status label,
// live list rows (badges), and the cookie list if it's open. (The language menu
// is rebuilt on open.)
document.addEventListener('i18n:changed', () => {
  renderThemeToggle();
  setServerStatus(serverUp);
  if (getToken()) loadItems(true);
  if (!els.cookies.classList.contains('hidden')) loadCookies();
});

// ---- Auto-refresh ---------------------------------------------------------
// A safety net behind the SSE stream: re-fetch the first page every 5 minutes so
// a dropped or idle stream never leaves history stale. Default-on, but gentle —
// the standard background-refresh pattern: only while the tab is visible and the
// user is parked at the top, so we never yank a scrolled list or hammer the
// server. Honours the ≤10-item page size (loadItems(true) re-fetches only page 1).
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let lastAutoRefresh = Date.now();

function autoRefresh(): void {
  if (document.hidden || !getToken() || state.loading) return;
  if (state.q) return;              // don't clobber an active search
  if (window.scrollY > 200) return; // user is browsing older pages — leave them be
  lastAutoRefresh = Date.now();
  loadItems(true);
}

setInterval(autoRefresh, AUTO_REFRESH_MS);
// Mobile suspends background timers, so also refresh on regaining visibility once
// at least one interval has elapsed since the last refresh.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastAutoRefresh >= AUTO_REFRESH_MS) autoRefresh();
});

// ---- Boot -----------------------------------------------------------------
applyTheme();                // resolve theme before first paint work
window.i18n.apply(document); // localize the static markup before anything shows
renderThemeToggle();
setServerStatus(false);      // start red; SSE onopen flips it green when live
if (!getToken()) showTokenField(false);
loadServerConfig();
connectEvents();
loadItems(true);
handleShareParam();
setupNativeShare();
setupNotifications();
