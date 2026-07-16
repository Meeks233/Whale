// Orca web UI — the whole client. Bundled (with i18n) and minified into
// ../web/app.js by build.ts. Importing i18n for its side effect installs
// window.i18n before any app code runs.
import './i18n';
import { decryptEvent, encryptedEventSourceUrl, encryptedFetch } from './e2ee';

type Params = Record<string, string | number>;

// A history item as returned by the API. Loosely typed — the extra index
// signature keeps the many optional server fields ergonomic to read.
interface Item {
  id: number;
  slug: string;
  status: string;
  title?: string;
  filesize?: number | null;
  total_filesize?: number | null;  // sum across all downloaded resolution variants
  height?: number | null;
  thumbnail_url?: string;
  duration?: number | null;
  extractor?: string;
  site_name?: string;
  video_id?: string;
  uploader?: string;
  error?: string;
  webpage_url?: string;
  local_available?: boolean;
  public?: boolean;
  public_slug?: string;
  public_until?: number | null;
  public_hits?: number;
  playlist_index?: number | null;
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

// One recorded backend error (GET /api/logs), shaped by src/errlog.rs.
interface LogEntry {
  at: number;        // unix seconds
  stage: string;     // "probe" | "download"
  url: string;
  platform: string;
  message: string;
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
function migrateLegacyStorage(current: string, suffix: string): void {
  const previous = ['wha', 'le_', suffix].join('');
  if (localStorage.getItem(current) == null) {
    const value = localStorage.getItem(previous);
    if (value != null) localStorage.setItem(current, value);
  }
  localStorage.removeItem(previous);
}
const TOKEN_KEY = 'orca_token';
migrateLegacyStorage(TOKEN_KEY, 'token');
function getToken(): string { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(tok: string): void {
  if (tok) localStorage.setItem(TOKEN_KEY, tok);
  else localStorage.removeItem(TOKEN_KEY);
  mirrorShareCreds();
}

// Push the server base + token to native storage so the headless "Quick
// Download" ShareActivity can POST to the backend in the background without
// opening the WebView. No-op outside the Tauri app.
function mirrorShareCreds(): void {
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) return;
  try { T.core.invoke('save_share_creds', { base: apiBase(), token: getToken() }); } catch (_) { /* desktop / not ready */ }
}

// ---- Server base URL ------------------------------------------------------
// Empty in a browser (same-origin, unchanged). The native app (Tauri) sets this
// to the remote Orca server so the identical UI can talk to it cross-origin.
const BASE_KEY = 'orca_api_base';
migrateLegacyStorage(BASE_KEY, 'api_base');
function apiBase(): string { return (localStorage.getItem(BASE_KEY) || '').replace(/\/+$/, ''); }
function setApiBase(b: string): void {
  b = (b || '').trim().replace(/\/+$/, '');
  if (b) localStorage.setItem(BASE_KEY, b);
  else localStorage.removeItem(BASE_KEY);
  mirrorShareCreds();
}
// Prefix an app-relative path (starting with `/`) with the configured base.
function apiUrl(path: string): string { return apiBase() + path; }

// True when `host` is a routable PUBLIC IP literal (v4 or v6) — i.e. NOT loopback,
// RFC-1918, CGNAT, or link/unique-local. Mirrors src/net_guard.rs's classification.
// Hostnames (non-literals) return false: we can't resolve them client-side.
function isPublicIpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 brackets
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;      // malformed → treat as hostname
    const [a = 0, b = 0] = o;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;      // link-local 169.254/16
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    return true;                                   // public IPv4
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return false;   // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return false;         // link-local fe80::/10
    if (/^f[cd]/.test(h)) return false;            // unique-local fc00::/7
    return true;                                   // public IPv6
  }
  return false;
}

// A remote base that would leak the bearer token in cleartext. HTTPS is always
// accepted. HTTP is limited to private IPs, localhost/mDNS, and single-label LAN
// hostnames; public IPs and public-looking DNS names are rejected.
function isInsecurePublicBase(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;
  let u: URL;
  try { u = new URL(s.includes('://') ? s : 'http://' + s); } catch (_) { return false; }
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const localName = host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || (!host.includes('.') && !host.includes(':'));
  if (localName) return false;
  const ipv4 = host.split('.');
  const ipLiteral = (ipv4.length === 4 && ipv4.every((part) => {
    const n = Number(part);
    return part !== '' && Number.isInteger(n) && n >= 0 && n <= 255;
  })) || host.includes(':');
  return !ipLiteral || isPublicIpHost(host);
}

// Canonical public domain the operator declared via ORCA_PUBLIC_URL, fetched
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
  websites: byId('websites'),
  websitesToggle: byId('websites-toggle'),
  websitesClose: byId('websites-close'),
  websiteList: byId('website-list'),
  sitesAdd: byId<HTMLButtonElement>('sites-add'),
  siteSearch: byId<HTMLInputElement>('site-search'),
  siteSelToggle: byId<HTMLButtonElement>('site-sel-toggle'),
  siteSelBar: byId('site-select-bar'),
  siteSelCount: byId('site-sel-count'),
  siteSelAll: byId<HTMLButtonElement>('site-sel-all'),
  siteSelInvert: byId<HTMLButtonElement>('site-sel-invert'),
  siteSelEnable: byId<HTMLButtonElement>('site-sel-enable'),
  siteSelDisable: byId<HTMLButtonElement>('site-sel-disable'),
  siteSelMerge: byId<HTMLButtonElement>('site-sel-merge'),
  siteSelDelete: byId<HTMLButtonElement>('site-sel-delete'),
  siteSelCancel: byId<HTMLButtonElement>('site-sel-cancel'),
  siteEdit: byId('site-edit'),
  siteEditTitle: byId('site-edit-title'),
  siteEditClose: byId<HTMLButtonElement>('site-edit-close'),
  siteEditCancel: byId<HTMLButtonElement>('site-edit-cancel'),
  siteEditSave: byId<HTMLButtonElement>('site-edit-save'),
  siteEditName: byId<HTMLInputElement>('site-edit-name'),
  siteEditKey: byId<HTMLInputElement>('site-edit-key'),
  siteEditHosts: byId<HTMLTextAreaElement>('site-edit-hosts'),
  siteEditErr: byId('site-edit-err'),
  token: byId<HTMLInputElement>('token'),
  tokenSave: byId<HTMLButtonElement>('token-save'),
  tokenHint: byId('token-hint'),
  server: byId<HTMLInputElement>('server'),
  serverSave: byId<HTMLButtonElement>('server-save'),
  permRow: byId('perm-row'),
  permissionsPrompt: byId('permissions-prompt'),
  permissionsPromptClose: byId<HTMLButtonElement>('permissions-prompt-close'),
  permissionsPromptLater: byId<HTMLButtonElement>('permissions-prompt-later'),
  permissionsPromptNever: byId<HTMLButtonElement>('permissions-prompt-never'),
  maxRes: byId<HTMLSelectElement>('max-res'),
  maxResSave: byId<HTMLButtonElement>('max-res-save'),
  maxResHint: byId('max-res-hint'),
  maxResLocked: byId('max-res-locked'),
  sealArchive: byId<HTMLTextAreaElement>('seal-archive'),
  sealImport: byId<HTMLButtonElement>('seal-import'),
  logList: byId('log-list'),
  logEmpty: byId('log-empty'),
  logsRefresh: byId<HTMLButtonElement>('logs-refresh'),
  logsCopy: byId<HTMLButtonElement>('logs-copy'),
  resolution: byId('resolution'),
  resolutionList: byId('resolution-list'),
  resolutionEmpty: byId('resolution-empty'),
  resolutionClose: byId<HTMLButtonElement>('resolution-close'),
  resolutionCancel: byId<HTMLButtonElement>('resolution-cancel'),
  resolutionSave: byId<HTMLButtonElement>('resolution-save'),
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
  selAll: byId<HTMLButtonElement>('sel-all'),
  selInvert: byId<HTMLButtonElement>('sel-invert'),
  selDownload: byId<HTMLButtonElement>('sel-download'),
  selShare: byId<HTMLButtonElement>('sel-share'),
  selUnshare: byId<HTMLButtonElement>('sel-unshare'),
  selCopy: byId<HTMLButtonElement>('sel-copy'),
  selClean: byId<HTMLButtonElement>('sel-clean'),
  selDelete: byId<HTMLButtonElement>('sel-delete'),
  selCancel: byId<HTMLButtonElement>('sel-cancel'),
  deleteConfirm: byId('delete-confirm'),
  deleteConfirmSub: byId('delete-confirm-sub'),
  deleteConfirmClose: byId<HTMLButtonElement>('delete-confirm-close'),
  deleteConfirmCancel: byId<HTMLButtonElement>('delete-confirm-cancel'),
  deleteConfirmYes: byId<HTMLButtonElement>('delete-confirm-yes'),
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
  dlStats: byId('dl-stats'),
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
  // Multi-video posts (a link with >1 video, e.g. a tweet with two clips) fold
  // into one playlist card. key = shared webpage_url -> its card container + body.
  groups: new Map<string, { li: HTMLLIElement; body: HTMLUListElement }>(),
  // Latest SSE progress per item id (percent/speed/status), so a playlist fold
  // header can show its aggregate download progress + the live download speed.
  progress: new Map<number, { percent: number | null; speed: string; status: string; shown: number }>(),
  // Folds the user has expanded, by key. Survives list resets (manual / 5-min
  // auto refresh) so a re-render restores the open/closed state.
  expandedGroups: new Set<string>(),
};

// The playlist a multi-video item belongs to (its shared webpage_url), or null
// for a standalone item. The backend sets playlist_index only when siblings
// share a URL, so that flag is exactly our "this belongs to a fold" signal.
function groupKeyOf(item: Item): string | null {
  return item.playlist_index != null && item.webpage_url ? item.webpage_url : null;
}

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
class UnauthorizedError extends Error {}

function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
  opts = opts || {};
  const res = await encryptedFetch(apiUrl(path), path, getToken(), opts);
  if (res.status === 401) {
    showTokenField(true);
    throw new UnauthorizedError('Unauthorized');
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

// ---- Total-downloaded readout (beside the heartbeat) ----------------------
// A small pill showing how many files Orca has stored and their combined size
// — the familiar "N items · X GB" storage summary. Refreshed on boot, on each
// completion, and after deletes. Hidden until the first successful fetch.
const STATS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>`;
// Vertical kebab (⋮) for the website-card overflow menu.
const MORE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
let dlStatsCache: { count: number; total_bytes: number } | null = null;

function renderDlStats(): void {
  const el = els.dlStats;
  if (!el || !dlStatsCache) return;
  const { count, total_bytes } = dlStatsCache;
  if (count <= 0) { el.classList.add('hidden'); return; }
  const size = fmtSize(total_bytes);
  const label = t('stats.summary', { n: count });
  el.innerHTML = `${STATS_SVG}<span class="dl-stats-text">${esc(label)}${size ? ' · ' + esc(size) : ''}</span>`;
  el.setAttribute('title', label + (size ? ' · ' + size : ''));
  el.classList.remove('hidden');
}

async function loadStats(): Promise<void> {
  if (!getToken()) return;
  try {
    const res = await apiFetch('/api/stats');
    if (!res.ok) return;
    dlStatsCache = await res.json();
    renderDlStats();
  } catch (_) { /* offline / unauthorized — leave the last-known readout */ }
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

// Human file size (binary units, matching yt-dlp/file managers): "12.3 MB",
// "1.4 GB". Empty string for a missing/zero size so callers can drop the chip.
function fmtSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  // Whole numbers for bytes/KB, one decimal from MB up (the familiar readout).
  const digits = u <= 1 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[u]}`;
}

// A video pixel height → the resolution label people recognise (4K, 1080p…).
// Buckets the common broadcast tiers; anything else falls back to "<h>p".
function resLabel(height: number | null | undefined): string {
  if (!height || height <= 0) return '';
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  if (height >= 240) return '240p';
  return height + 'p';
}

const TERMINAL: Record<string, number> = { completed: 1, failed: 1, duplicate: 1 };

// Direct media link. `download` forces a browser save; otherwise it streams
// (used as the <video> source). Token rides in the query since <video>/<a>
// can't send an Authorization header.
function itemPath(item: Item | number, suffix = ''): string {
  const resolved = typeof item === 'number' ? state.items.get(item) : item;
  if (!resolved?.slug) throw new Error('missing item slug');
  return '/api/items/' + encodeURIComponent(resolved.slug) + suffix;
}

function fileUrl(item: Item | number, download?: boolean): string {
  const tok = encodeURIComponent(getToken());
  return apiUrl(itemPath(item, '/file') + '?token=' + tok + (download ? '&download=1' : ''));
}

// Online-playback proxy: the backend resolves the upstream URL (with cookies)
// and streams the bytes back, so the browser plays through us instead of hitting
// a stale, IP-bound CDN URL directly. Keyed by the item's unguessable slug (like
// share links), never its sequential id, so the URL can't be used to enumerate
// other items. Token rides in the query — a <video> can't set headers.
function streamUrl(slug: string): string {
  const tok = encodeURIComponent(getToken());
  return apiUrl('/api/stream/' + encodeURIComponent(slug) + '?token=' + tok);
}

const streamPrewarmed = new Set<string>();
let streamPrewarmCount = 0;
const streamPrewarmObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting || streamPrewarmCount >= 2) continue;
    const play = entry.target as HTMLElement;
    const slug = play.dataset.slug;
    streamPrewarmObserver.unobserve(play);
    if (!slug || streamPrewarmed.has(slug)) continue;
    streamPrewarmed.add(slug);
    streamPrewarmCount++;
    apiFetch('/api/stream/' + encodeURIComponent(slug) + '/prepare').catch(() => {
      streamPrewarmed.delete(slug);
    });
  }
}, { rootMargin: '160px' });

// Tokenless public link, keyed by the item's random slug (not its id, so it
// can't be guessed by enumeration). Prefers the operator-declared public
// domain (ORCA_PUBLIC_URL) so links carry the real domain regardless of the
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

// Trash glyph (Lucide "trash-2"): borderless inline icon matching Save/Share,
// tinted red on hover. Every card carries one (leftmost action) so any item can
// be deleted — always behind the confirm dialog.
const TRASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

// Eye glyph (Lucide "eye") for the external-access counter capsule.
const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;

// Access-count capsule shown after the status badge once a live share has been
// hit externally. Scoped to the current share window: the backend zeroes the
// count on unshare/expiry, and we also require the share to be live here so the
// capsule vanishes the moment sharing stops. Styled as a neutral pill (not the
// green "on" state).
function hitsHtml(item: Item): string {
  if (!item.public) return '';
  const n = item.public_hits || 0;
  if (n <= 0) return '';
  return `<span class="hits" title="External link accesses">${EYE_SVG}<span class="hits-n">${n}</span></span>`;
}

// A file-size capsule at the LEFT of a card's action row (e.g. "20.4 MB").
// Shows the COMBINED size of every downloaded resolution version (total_filesize),
// so a multi-resolution item reflects its full on-disk footprint. Falls back to
// the primary filesize. Vanishes when the size is unknown. Resolution lives in
// its own button to the right of this chip (see resButtonHtml).
function metaChipsHtml(item: Item): string {
  // Duration rides in the capsule ("1:23 | 2.7MB") only for PORTRAIT items — CSS
  // gates it on .portrait-media, since orientation is only known once the
  // thumbnail loads (see the `load` handler). On a 9:16 thumb the bottom-left
  // duration pill collides with the bottom-right play button, so it moves here.
  // Portrait clips under a minute drop the duration entirely: for a 20s Reel the
  // number is noise, and most short verticals then need no capsule at all.
  const dur = item.duration && item.duration >= 60 ? fmtDuration(item.duration) : '';
  // No local file (stream-only "None" mode, or a copy backed away to the cloud)
  // → no on-disk footprint to report, so no size part.
  const size = item.local_available ? fmtSize(item.total_filesize || item.filesize) : '';
  return metaChip(dur, size);
}

// Build a meta capsule from the (possibly empty) duration | size parts. Each
// part is its own span so CSS can show/hide the duration per orientation; the
// " | " separator is drawn by .chip-dur::after only when a size follows.
function metaChip(dur: string, size: string): string {
  if (!dur && !size) return '';
  const d = dur ? `<span class="chip-dur">${esc(dur)}</span>` : '';
  const s = size ? `<span class="chip-size">${esc(size)}</span>` : '';
  return `<span class="meta-chip">${d}${s}</span>`;
}

// Stacked "layers" glyph — the industry-standard affordance for "multiple
// versions / quality options" (à la a video player's quality selector).
const LAYERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>`;

// Resolution button: sits between the size chip and the delete icon. Shows the
// item's current resolution and, on tap, opens the multi-select to add/remove
// resolution versions. Only for completed video items (a known height).
function resButtonHtml(item: Item): string {
  if (item.status !== 'completed') return '';
  // Label logic: a known height → its label (e.g. "1080p"); a stream-only item
  // (no local file) → "None"; a downloaded file of unknown height (older/audio
  // records) → icon only, so we never mislabel a present file as "None".
  let label = '';
  if (item.height && item.height > 0) label = resLabel(item.height);
  else if (!item.local_available) label = t('res.noneLabel');
  const labelSpan = label ? `<span class="res-btn-label">${esc(label)}</span>` : '';
  return `<button class="act res-btn" data-act="resolutions" data-id="${item.id}" aria-label="${esc(t('res.pick'))}" title="${esc(t('res.pick'))}">${LAYERS_SVG}${labelSpan}</button>`;
}

function actionsHtml(item: Item): string {
  // Delete is global: every card gets a trash icon (leftmost button, i.e. left
  // of the Save button — but right of the size chip + resolution button) so any
  // item — queued, running, failed or completed — can be removed. It always
  // routes through the confirm dialog (openDeleteConfirm).
  const del = `<button class="act act-icon act-del" data-act="delete" data-id="${item.id}" aria-label="${esc(t('aria.delete'))}" title="${esc(t('aria.delete'))}">${TRASH_SVG}</button>`;
  // Save / share only make sense for a completed item with a file. Local file
  // present: Save (download icon) + Share icon. Local file gone (backed away):
  // plays from upstream, no save/share. Sharing state lives in the share dialog.
  let mediaActions = '';
  if (item.status === 'completed') {
    const local = !!item.local_available;
    const pub = !!item.public;
    mediaActions = local
      ? `<a class="act act-icon act-save" href="${fileUrl(item, true)}" download aria-label="${esc(t('aria.save'))}" title="${esc(t('aria.save'))}">${DOWNLOAD_SVG}</a>
      <button class="act act-icon act-share ${pub ? 'act-on' : ''}" data-act="share" data-id="${item.id}" aria-label="${esc(t('aria.share'))}" title="${esc(t('aria.share'))}">${SHARE_SVG}</button>`
      : `<span class="act act-cloud" title="Streams from source — no local copy">${esc(t('cloud.only'))}</span>`;
  }
  // Order: size chip · resolution button · delete · save/share.
  return `<div class="actions">${metaChipsHtml(item)}${resButtonHtml(item)}${del}${mediaActions}</div>`;
}

// Cloud-file corner badge for the thumbnail: shown when an item is completed but
// its local copy is gone, signalling playback will stream from source.
const CLOUD_BADGE = `<span class="cloud-badge" title="Cloud only — plays from source"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 18H6a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 16.5 9H17a3.5 3.5 0 0 1 2 6.37V18Z"/></svg></span>`;
// Play affordance shown on a finished thumbnail (bottom-right). Tapping the
// thumbnail opens the in-app fullscreen player (see openPlayer).
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>`;
const PLAY_BADGE = `<span class="play-badge" aria-hidden="true">${PLAY_ICON}</span>`;
const MEDIA_LOADER = `<span class="media-loader" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></span>`;

function isMediaPending(item: Item, status = item.status): boolean {
  // Resolution jobs emit running events for an already-completed item. Its old
  // file remains valid, so only the first download receives the pending mask.
  return item.status !== 'completed' && (status === 'queued' || status === 'running');
}

// A completed item with a file is playable in-app (local file or cloud fallback).
function isPlayable(item: Item): boolean {
  // Any completed item is playable: with a local file it plays that; without one
  // (stream-only "None" mode, or a copy backed away) it streams from source via
  // /stream-url. Only queued/running/failed items aren't playable.
  return item.status === 'completed';
}

// Friendly platform name from yt-dlp's extractor id (e.g. "youtube:tab" → YouTube).
function sourceLabel(extractor: string | undefined): string {
  if (!extractor) return '';
  const base = (String(extractor).split(/[:_]/)[0] ?? '').toLowerCase();
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
  const base = (String(extractor || '').split(/[:_]/)[0] ?? '').toLowerCase();
  const slug = SITE_ICONS[base] || 'generic';
  const name = sourceLabel(extractor) || 'Source';
  return `<img class="src-logo" src="/icons/sites/${slug}.svg" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}

// Thumbnail block. Playable items become a play button (tap → fullscreen player);
// everything else keeps the link out to the source page. Overlays: cloud
// (top-right), duration (bottom-left), play (bottom-right). The source is now
// shown as a logo before the title (see rowHtml), not on the thumbnail.
function thumbHtml(item: Item, thumb: string, dur: string, cloud: string): string {
  const pending = isMediaPending(item) ? ' media-pending' : '';
  const overlays = `${thumb}${dur}${cloud}${MEDIA_LOADER}`;
  if (isPlayable(item)) {
    const cloudOnly = !item.local_available ? '1' : '';
    return `<div class="thumb-wrap thumb-play${pending}" role="button" tabindex="0" aria-label="Play"
      data-play="1" data-id="${item.id}" data-cloud="${cloudOnly}">${overlays}${PLAY_BADGE}</div>`;
  }
  return `<a class="thumb-wrap${pending}" href="${esc(item.webpage_url)}" target="_blank" rel="noopener">${overlays}</a>`;
}

function rowHtml(item: Item): string {
  const thumb = item.thumbnail_url
    ? `<img class="thumb" src="${esc(item.thumbnail_url)}" alt="" loading="lazy">`
    : `<div class="thumb thumb-empty"></div>`;
  const dur = item.duration ? `<span class="dur">${esc(fmtDuration(item.duration))}</span>` : '';
  const cloud = item.status === 'completed' && !item.local_available ? CLOUD_BADGE : '';
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
        <span class="badge badge-${esc(item.status)}${badgeFlashClass(item.id, item.status)}">${esc(statusLabel(item.status))}</span>
        ${hitsHtml(item)}
        <span class="phase"></span>
        <span class="speed"></span>
        <span class="eta"></span>
      </div>
      ${bar}
      ${meta}
      ${actionsHtml(item)}
    </div>`;
}

// The Completed badge is hidden by default (see CSS) so a full history isn't a
// wall of green; it only shows for ~30s right after a fresh completion. This adds
// the `flash` class while an id is in that window.
const freshCompleted = new Map<number, ReturnType<typeof setTimeout>>();
function badgeFlashClass(id: number, status: string): string {
  return status === 'completed' && freshCompleted.has(id) ? ' flash' : '';
}
function markFreshCompleted(id: number): void {
  const prev = freshCompleted.get(id);
  if (prev) clearTimeout(prev);
  freshCompleted.set(id, setTimeout(() => {
    freshCompleted.delete(id);
    state.rows.get(id)?.querySelector('.badge-completed')?.classList.remove('flash');
  }, 30_000));
}

// Last-rendered markup per row, so an upsert that produces byte-identical HTML
// (the common case during a periodic refresh) touches no DOM at all — no reparse,
// no thumbnail re-request, no flash. Keyed weakly so removed rows are collectable.
const rowSig = new WeakMap<HTMLLIElement, string>();

function upsertRow(item: Item, prepend?: boolean): HTMLLIElement {
  state.items.set(item.id, item);
  const gkey = groupKeyOf(item);
  let li = state.rows.get(item.id);
  if (!li) {
    li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = String(item.id);
    // Preserve the visual selection state across a full re-render of the row.
    if (state.selected.has(item.id)) li.classList.add('selected');
    state.rows.set(item.id, li);
    if (gkey) {
      // Nest inside the playlist fold, ordered by playlist position so the
      // sublist reads #1, #2, … regardless of the list's newest-first arrival.
      insertByIndex(ensureGroup(gkey, prepend).body, li, item.playlist_index ?? 0);
    } else if (prepend) {
      els.history.prepend(li);
    } else {
      els.history.appendChild(li);
    }
  }
  const html = rowHtml(item);
  if (rowSig.get(li) !== html) {
    li.innerHTML = html;
    rowSig.set(li, html);
  }
  if (item.status === 'completed' && !item.local_available && item.public_slug) {
    const play = li.querySelector<HTMLElement>('.thumb-play');
    if (play) {
      play.dataset.slug = item.public_slug;
      streamPrewarmObserver.observe(play);
    }
  }
  li.classList.toggle('blurred', isItemBlurred(item));
  if (gkey) updateGroupHeader(gkey);
  els.empty.classList.add('hidden');
  return li;
}

// ---- Playlist folds (multi-video posts) -----------------------------------
// A link with several videos (a tweet with two clips) collapses into one card:
// a header previewing up to two thumbnails, expandable into the child rows.
// Reuses the normal item cards as children so play/share/progress/select all work.
function ensureGroup(gkey: string, prepend?: boolean): { li: HTMLLIElement; body: HTMLUListElement } {
  const existing = state.groups.get(gkey);
  if (existing) return existing;
  const li = document.createElement('li');
  // Restore the open/closed state a refresh would otherwise reset.
  li.className = 'group-card' + (state.expandedGroups.has(gkey) ? '' : ' collapsed');
  li.dataset.group = gkey;
  const head = document.createElement('div');
  head.className = 'group-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  const body = document.createElement('ul');
  body.className = 'group-body';
  li.append(head, body);
  const g = { li, body };
  state.groups.set(gkey, g);
  if (prepend) els.history.prepend(li);
  else els.history.appendChild(li);
  return g;
}

// Insert `li` into a fold body keeping children sorted by playlist index.
function insertByIndex(body: HTMLUListElement, li: HTMLLIElement, idx: number): void {
  for (const child of Array.from(body.children)) {
    const other = state.items.get(Number((child as HTMLElement).dataset.id));
    if (other && (other.playlist_index ?? 0) > idx) { body.insertBefore(li, child); return; }
  }
  body.appendChild(li);
}

function groupChildIds(gkey: string): number[] {
  const g = state.groups.get(gkey);
  return g ? [...g.body.children].map((c) => Number((c as HTMLElement).dataset.id)) : [];
}

// Fill the fold header from its children. Industry "playlist" pattern (YouTube /
// file managers): the FIRST video's thumbnail (its real orientation preserved),
// a stacked-card edge behind it so it reads as a list at a glance, the video
// count bottom-left, a sequential-play button bottom-right, plus whole-list
// share / download actions. See the .group-thumb stack CSS.
function updateGroupHeader(gkey: string): void {
  const g = state.groups.get(gkey);
  if (!g) return;
  const items = groupChildIds(gkey).map((id) => state.items.get(id)).filter(Boolean) as Item[];
  if (!items.length) return;
  const first = items[0]!;
  const thumb = first.thumbnail_url
    ? `<img class="thumb" src="${esc(first.thumbnail_url)}" alt="" loading="lazy">`
    : `<div class="thumb thumb-empty"></div>`;
  const base = (first.title || '').replace(/\s*#\d+\s*$/, '');
  // Raw (not HTML-escaped): it's applied via textContent in updateGroupProgress,
  // which does its own escaping — pre-escaping here would double-encode it.
  const uploader = first.uploader ? first.uploader + ' · ' : '';
  // Sequential-play button appears once any child is playable; whole-list
  // download / share once any child still has a local file. Delete-all is always
  // available (the leftmost list action), so the actions row is never empty.
  const play = items.some(isPlayable)
    ? `<button class="play-badge group-play" data-act="play-list" aria-label="${esc(t('group.playAll'))}" title="${esc(t('group.playAll'))}">${PLAY_ICON}</button>`
    : '';
  const dlShare = items.some((it) => isPlayable(it) && it.local_available)
    ? `<button class="act act-icon" data-act="dl-list" aria-label="${esc(t('group.downloadAll'))}" title="${esc(t('group.downloadAll'))}">${DOWNLOAD_SVG}</button>
        <button class="act act-icon" data-act="share-list" aria-label="${esc(t('group.shareAll'))}" title="${esc(t('group.shareAll'))}">${SHARE_SVG}</button>`
    : '';
  // Aggregate size of the whole post, shown left of the list actions (mirrors
  // the per-video size chip). Dropped when no child has a known size yet.
  const totalBytes = items.reduce((sum, it) => sum + (it.total_filesize || it.filesize || 0), 0);
  const sizeChip = metaChip('', fmtSize(totalBytes));
  const listActions = `<div class="actions group-actions">
        ${sizeChip}
        <button class="act act-icon act-del" data-act="del-list" aria-label="${esc(t('aria.delete'))}" title="${esc(t('aria.delete'))}">${TRASH_SVG}</button>
        ${dlShare}
      </div>`;
  const head = g.li.querySelector('.group-head') as HTMLElement;
  head.innerHTML = `
    <div class="thumb-wrap group-thumb${isMediaPending(first) ? ' media-pending' : ''}">
      ${thumb}
      <span class="group-count">${items.length}</span>
      ${play}
      ${MEDIA_LOADER}
    </div>
    <div class="group-info">
      <div class="title">${sourceLogoHtml(first.extractor)}<span>${esc(base)}</span></div>
      <div class="group-sub"><span class="group-status"></span><span class="group-speed"></span></div>
      <div class="progress group-progress hidden"><div class="progress-fill" style="width:0%"></div></div>
    </div>
    <div class="group-side">
      <svg class="group-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      ${listActions}
    </div>`;
  // The uploader prefix is a static lead-in; the status/speed/progress are filled
  // (and kept live) by updateGroupProgress so a progress tick needn't rebuild the
  // whole header.
  const statusEl = head.querySelector('.group-status') as HTMLElement | null;
  if (statusEl && uploader) statusEl.dataset.prefix = uploader;
  updateGroupProgress(gkey);
  refreshGroupHeadSelection(gkey);
}

// Refresh just a fold header's aggregate progress: the overall percent bar, the
// live download speed of the currently-running child, and the summary text.
// Called from updateGroupHeader (initial paint) and from each progress tick
// (patchRow) so the fold reflects downloads without a full header rebuild.
function updateGroupProgress(gkey: string): void {
  const g = state.groups.get(gkey);
  if (!g) return;
  const items = groupChildIds(gkey).map((id) => state.items.get(id)).filter(Boolean) as Item[];
  if (!items.length) return;
  const total = items.length;
  // Prefer the latest SSE status (state.progress) over the possibly-stale item
  // object so a queued→running transition counts toward the aggregate at once.
  const statusOf = (it: Item): string => state.progress.get(it.id)?.status || it.status;
  const done = items.filter((it) => statusOf(it) === 'completed').length;
  const failed = items.filter((it) => statusOf(it) === 'failed').length;
  const active = items.some((it) => statusOf(it) === 'queued' || statusOf(it) === 'running');
  // Overall percent: completed children = 100, a running child contributes its
  // latest tick percent, everything else 0.
  let sum = 0;
  let curSpeed = '';
  for (const it of items) {
    const st = statusOf(it);
    if (st === 'completed') { sum += 100; continue; }
    if (st === 'running') {
      const pr = state.progress.get(it.id);
      // Use the monotonic shown percent so the fold's aggregate bar never dips
      // when a child restarts its second (audio) pass.
      const pct = pr ? pr.shown : 0;
      sum += pct;
      if (!curSpeed && pr && pr.speed) curSpeed = pr.speed;
    }
  }
  const pct = Math.round(sum / total);
  const head = g.li.querySelector('.group-head');
  if (!head) return;
  const bar = head.querySelector('.group-progress');
  const fill = head.querySelector('.group-progress .progress-fill') as HTMLElement | null;
  const statusEl = head.querySelector('.group-status') as HTMLElement | null;
  const speedEl = head.querySelector('.group-speed') as HTMLElement | null;
  head.querySelector('.group-thumb')?.classList.toggle(
    'media-pending',
    isMediaPending(items[0]!, statusOf(items[0]!)),
  );
  if (bar) bar.classList.toggle('hidden', !active);
  if (fill) fill.style.width = pct + '%';
  const prefix = statusEl?.dataset.prefix || '';
  if (statusEl) {
    statusEl.textContent = prefix + (active
      ? t('group.progress', { done, total }) + ` · ${pct}%`
      : failed ? t('group.failed', { n: failed })
        : t('group.count', { n: total }));
  }
  if (speedEl) speedEl.textContent = active && curSpeed ? curSpeed : '';
}

// Mark the fold header selected (all children picked) or partial (some).
function refreshGroupHeadSelection(gkey: string): void {
  const g = state.groups.get(gkey);
  if (!g) return;
  const ids = groupChildIds(gkey);
  const sel = ids.filter((id) => state.selected.has(id)).length;
  const head = g.li.querySelector('.group-head') as HTMLElement;
  head.classList.toggle('selected', sel > 0 && sel === ids.length);
  head.classList.toggle('partial', sel > 0 && sel < ids.length);
}

function refreshGroupHeaders(): void {
  state.groups.forEach((_g, gkey) => refreshGroupHeadSelection(gkey));
}

// Tapping a fold header in select mode picks/clears the whole post at once.
function toggleGroupSelect(gkey: string): void {
  const ids = groupChildIds(gkey);
  const allSel = ids.length > 0 && ids.every((id) => state.selected.has(id));
  ids.forEach((id) => { if (allSel) state.selected.delete(id); else state.selected.add(id); });
  syncSelectionClasses();
}

function toggleGroupExpand(gkey: string): void {
  const g = state.groups.get(gkey);
  if (!g) return;
  const collapsed = g.li.classList.toggle('collapsed');
  if (collapsed) state.expandedGroups.delete(gkey);
  else state.expandedGroups.add(gkey);
}

// Play every playable child in order in the fullscreen player, advancing on end.
function playGroup(gkey: string): void {
  const items = groupChildIds(gkey).map((id) => state.items.get(id)).filter((it) => it && isPlayable(it as Item)) as Item[];
  if (!items.length) { toast(t('toast.noDownloadable'), 'info'); return; }
  playQueue = items.map((it) => ({ id: it.id, cloud: !it.local_available, poster: it.thumbnail_url }));
  playIndex = 0;
  playCurrentInQueue();
}

// Patch a row in place from a ProgressEvent (does not rebuild full row).
function patchRow(ev: ProgressEv): void {
  // Compute a MONOTONIC display percent. A `bv*+ba` download runs two 0→100%
  // passes (video, then audio), so the raw tick percent legitimately jumps back
  // to 0 mid-download — which read as the bar "going backwards". We clamp the
  // shown value to its running max, resetting only when a brand-new job starts
  // (the synthetic Running tick carries percent=null) or the item is re-queued.
  const prevP = state.progress.get(ev.id);
  let shown = prevP ? prevP.shown : 0;
  const cur = ev.percent == null ? null : Math.max(0, Math.min(100, ev.percent));
  if (ev.status === 'queued' || (ev.status === 'running' && ev.percent == null)) shown = 0;
  else if (cur != null) shown = Math.max(shown, cur);
  if (ev.status === 'completed') shown = 100;
  // Record the latest tick so a playlist fold can aggregate progress + speed.
  state.progress.set(ev.id, { percent: ev.percent ?? null, speed: ev.speed || '', status: ev.status, shown });
  const li = state.rows.get(ev.id);
  if (!li) return; // unknown row; will appear on next list load
  const persisted = state.items.get(ev.id);
  li.querySelector('.thumb-wrap')?.classList.toggle(
    'media-pending',
    !!persisted && isMediaPending(persisted, ev.status),
  );
  const badge = li.querySelector('.badge');
  if (badge) {
    badge.textContent = statusLabel(ev.status);
    badge.className = 'badge badge-' + ev.status;
  }
  const phase = li.querySelector('.phase');
  if (phase) {
    // Label the video/audio pass so the per-pass 0→100% reset reads as a new
    // stage rather than the bar "jumping" backwards.
    phase.textContent = ev.phase ? ev.phase.charAt(0).toUpperCase() + ev.phase.slice(1) : '';
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
    // Flash the green Completed badge for 30s (markFreshCompleted) — this is a
    // fresh success, unlike the old completed rows whose badge stays hidden.
    if (ev.status === 'completed') {
      markFreshCompleted(ev.id);
      badge?.classList.add('flash');
      apiFetch(itemPath(ev.id))
        .then((r) => (r.ok ? r.json() : null))
        .then((it) => { if (it) upsertRow(it, false); })
        .catch(() => { /* ignore */ });
      loadStats(); // a fresh file changes the total-downloaded readout
    }
  } else if (bar && fill) {
    bar.classList.remove('hidden');
    fill.style.width = shown + '%';
  }
  // Roll this tick up into the fold header (total progress + live speed).
  const it = state.items.get(ev.id);
  const gk = it ? groupKeyOf(it) : null;
  if (gk) updateGroupProgress(gk);
}

// ---- List loading ---------------------------------------------------------
async function loadItems(reset?: boolean): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.cursor = null;
    state.rows.clear();
    state.items.clear();
    state.groups.clear();
    state.progress.clear();
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
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
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
      data.items.forEach((it: Item) => trackDownload(it.slug));
      const dupes = data.duplicates || 0;
      toast(t('toast.queuedN', { n: data.items.length }) + (dupes ? t('toast.dupSuffix', { n: dupes }) : ''),
        dupes ? 'info' : 'ok');
    } else if (data.item) {
      upsertRow(data.item, true);
      if (!data.duplicate) trackDownload(data.item.slug);
      toast(data.duplicate ? t('toast.alreadyDownloaded') : t('toast.queued'), data.duplicate ? 'info' : 'ok');
    } else {
      toast(t('toast.queued'), 'ok');
    }
    els.url.value = '';
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    els.submitBtn.disabled = false;
  }
}

// ---- SSE ------------------------------------------------------------------
let es: EventSource | null = null;
let eventGeneration = 0;
async function connectEvents(): Promise<void> {
  const token = getToken();
  if (!token) { setServerStatus(false); return; }
  if (es) { es.close(); es = null; }
  const generation = ++eventGeneration;
  const encrypted = await encryptedEventSourceUrl(apiUrl('/api/events'), token);
  if (generation !== eventGeneration) return;
  es = new EventSource(encrypted.url);
  // Stream established → server is reachable (green breathing light).
  es.onopen = () => setServerStatus(true);
  es.addEventListener('progress', async (e) => {
    setServerStatus(true); // any delivered event also confirms liveness
    try { patchRow(JSON.parse(await decryptEvent(encrypted.key, (e as MessageEvent).data))); } catch (_) { /* ignore */ }
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

// ---- Website management ---------------------------------------------------
function fmtBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

interface CookieStatus { present: boolean; enabled: boolean; bytes: number; updated_at: number; expires_at?: number | null; }
interface Website {
  key: string;
  name: string;
  hosts: string[];
  login_url: string;
  enabled: boolean;
  max_height: number | null;
  no_download: boolean;
  blur: boolean;
  sort: number;
  cookie?: CookieStatus;
}

let websitesLoaded: Website[] = [];
// Host suffixes belonging to sites with privacy-blur on, recomputed whenever the
// registry loads/changes. Home-list rows whose source host matches are blurred.
let blurredHosts: string[] = [];
function recomputeBlurredHosts(): void {
  blurredHosts = websitesLoaded.filter((w) => w.blur).flatMap((w) => w.hosts);
}
// Lowercased host of a URL (scheme/userinfo/port tolerant, leading www. stripped).
function hostOfUrl(url?: string | null): string {
  if (!url) return '';
  let s = String(url).trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/)[0] ?? '';
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = (s.split(':')[0] ?? '').toLowerCase().replace(/\.$/, '');
  return s.startsWith('www.') ? s.slice(4) : s;
}
function isItemBlurred(item: Item): boolean {
  if (!blurredHosts.length) return false;
  const host = hostOfUrl(item.webpage_url);
  if (!host) return false;
  return blurredHosts.some((suf) => host === suf || host.endsWith('.' + suf));
}
// Reapply the blurred class across already-rendered home rows (after a blur
// toggle or a fresh website load), without a full list rebuild.
function applyBlurToRows(): void {
  recomputeBlurredHosts();
  state.rows.forEach((li, id) => {
    const it = state.items.get(id);
    if (it) li.classList.toggle('blurred', isItemBlurred(it));
  });
}
// Client-side filter query (name / domains / key) and batch-select state, mirroring
// the home list's search + multi-select so the two screens feel like one system.
let siteQuery = '';
let siteSelectMode = false;
const siteSelected = new Set<string>();

// The per-site maximum-resolution ladder, offered as a single dropdown (not a chip
// row): one unambiguous "cap" control per card.
const SITE_RES_LADDER = [4320, 2160, 1440, 1080, 720, 480, 360];

function siteResSelectHtml(w: Website): string {
  // Current value: 'none' (stream-only) → a pinned height → 'global' (follow the
  // global default). The <select> is the whole control; `data-act="res"` routes its
  // change event.
  const active = w.no_download ? 'none' : (w.max_height && w.max_height > 0 ? String(w.max_height) : 'global');
  const opt = (val: string, label: string): string =>
    `<option value="${val}"${active === val ? ' selected' : ''}>${esc(label)}</option>`;
  const opts = [opt('global', t('sites.followGlobal')), opt('none', t('res.noneLabel'))]
    .concat(SITE_RES_LADDER.map((h) => opt(String(h), resLabel(h) || h + 'p')));
  return `<select class="select site-res-select" data-act="res" aria-label="${esc(t('sites.maxRes'))}">${opts.join('')}</select>`;
}

// Cookie health as a single traffic-light dot (mature status-indicator pattern),
// so the jar's state reads at a glance without ever exposing its contents:
//   green  = present, enabled, healthy      (success)
//   yellow = present, enabled, expiring ≤7d (suspected expiry)
//   red    = present, enabled, past expiry  (failed / needs refresh)
//   grey   = disabled jar, or no cookie at all
// Greedy by design near expiry: we never block a download on this (some sites —
// e.g. YouTube — keep serving past a cookie's nominal expiry), the dot only nudges.
type CookieDotClass = 'ok' | 'warn' | 'err' | 'off';
function cookieDot(w: Website): { cls: CookieDotClass; label: string } {
  const c = w.cookie;
  if (!c || !c.present) return { cls: 'off', label: t('cookie.none') };
  if (!c.enabled) return { cls: 'off', label: t('cookie.disabled', { size: fmtBytes(c.bytes) }) };
  if (c.expires_at) {
    const now = Date.now() / 1000;
    if (c.expires_at <= now) return { cls: 'err', label: t('cookie.expired') };
    const days = Math.floor((c.expires_at - now) / 86400);
    if (days <= 7) return { cls: 'warn', label: t('cookie.expiring', { days: Math.max(1, days) }) };
  }
  return { cls: 'ok', label: t('cookie.active', { size: fmtBytes(c.bytes) }) };
}

// Kebab overflow menu: everything that isn't an everyday control (login, test,
// domain edit, cookie enable/disable + delete, delete site) collapses here so the
// card front shows only the toggle, cookie status, one cookie button and the cap.
function siteMenuHtml(w: Website): string {
  const present = !!(w.cookie && w.cookie.present);
  const items: string[] = [];
  if (w.login_url)
    items.push(`<a class="site-menu-item" href="${esc(w.login_url)}" target="_blank" rel="noopener">${esc(t('cookie.login'))}</a>`);
  items.push(`<button class="site-menu-item" data-act="edit">${esc(t('sites.editDomains'))}</button>`);
  items.push(`<button class="site-menu-item" data-act="validate">${esc(t('sites.validate'))}</button>`);
  if (present) {
    // Enable/disable now lives on the card's cookie switch; the menu keeps only
    // the destructive "forget this jar" action.
    items.push(`<button class="site-menu-item danger" data-act="ck-delete">${esc(t('cookie.delete'))}</button>`);
  }
  items.push(`<button class="site-menu-item danger" data-act="site-delete">${esc(t('sites.delete'))}</button>`);
  return `<div class="site-menu-wrap">
      <button class="site-menu-btn" data-act="menu" aria-label="${esc(t('sites.more'))}" aria-haspopup="true">${MORE_SVG}</button>
      <div class="site-menu-pop hidden" role="menu">${items.join('')}</div>
    </div>`;
}

function websiteCardHtml(w: Website): string {
  const present = !!(w.cookie && w.cookie.present);
  const cookieOn = !!(w.cookie && w.cookie.present && w.cookie.enabled);
  const dot = cookieDot(w);
  return `
    <div class="site-main">
      <button class="site-toggle ${w.enabled ? 'on' : 'off'}" data-act="enable" role="switch" aria-checked="${w.enabled}" title="${esc(w.enabled ? t('sites.disable') : t('sites.enable'))}"><span class="knob"></span></button>
      <div class="site-info">
        <div class="site-titlerow">
          <span class="site-name">${esc(w.name)}</span>
        </div>
        <div class="site-domains-list">${esc(w.hosts.join(', ') || '—')}</div>
      </div>
      ${siteMenuHtml(w)}
    </div>
    <div class="site-settings">
      <div class="site-row">
        <span class="site-row-label">${esc(t('sites.maxRes'))}</span>
        <div class="site-row-ctl">${siteResSelectHtml(w)}</div>
      </div>
      <div class="site-row">
        <span class="site-row-label">
          <span class="ck-dot ck-dot-${dot.cls}" title="${esc(dot.label)}" aria-label="${esc(dot.label)}" role="img"></span>${esc(t('sites.cookie'))}
        </span>
        <div class="site-row-ctl">
          ${present ? `<button class="site-cookie-btn" data-act="ck-import">${esc(t('cookie.replace'))}</button>` : ''}
          <button class="site-cookie-toggle ${cookieOn ? 'on' : 'off'}" data-act="ck-switch" role="switch" aria-checked="${cookieOn}" title="${esc(t('sites.cookie'))}"><span class="knob"></span></button>
        </div>
      </div>
      <div class="site-row">
        <span class="site-row-label">${esc(t('sites.blur'))}</span>
        <div class="site-row-ctl">
          <button class="site-blur-toggle ${w.blur ? 'on' : 'off'}" data-act="blur" role="switch" aria-checked="${w.blur}" title="${esc(t('sites.blur'))}"><span class="knob"></span></button>
        </div>
      </div>
    </div>
    <textarea class="ck-paste hidden" placeholder="${esc(t('ph.cookiePaste'))}" rows="4"></textarea>
    <div class="ck-paste-actions hidden">
      <button class="btn" data-act="ck-save">${esc(t('cookie.save'))}</button>
      <button class="btn btn-ghost" data-act="ck-cancel">${esc(t('cookie.cancel'))}</button>
    </div>`;
}

async function loadWebsites(): Promise<void> {
  if (!getToken()) { showTokenField(false); toast('Set your token first', 'error'); return; }
  try {
    const res = await apiFetch('/api/websites');
    if (!res.ok) { toast(t('toast.loadCookiesFail'), 'error'); return; }
    const data = await res.json();
    websitesLoaded = (data.websites || []) as Website[];
    applyBlurToRows();
    renderWebsites();
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  }
}

// Sites matching the current search box: name, any domain, or key (case-insensitive).
function filteredWebsites(): Website[] {
  const q = siteQuery.trim().toLowerCase();
  if (!q) return websitesLoaded;
  return websitesLoaded.filter((w) =>
    w.name.toLowerCase().includes(q) ||
    w.key.toLowerCase().includes(q) ||
    w.hosts.some((h) => h.toLowerCase().includes(q)));
}

function renderWebsites(): void {
  const shown = filteredWebsites();
  els.websiteList.innerHTML = '';
  for (const w of shown) {
    const div = document.createElement('div');
    div.className = 'website-card' + (w.enabled ? '' : ' disabled') + (siteSelected.has(w.key) ? ' selected' : '');
    div.dataset.key = w.key;
    div.innerHTML = websiteCardHtml(w);
    els.websiteList.appendChild(div);
  }
  els.websites.classList.toggle('sites-selecting', siteSelectMode);
  updateSiteSelBar();
}

// PUT a partial update to a website and refresh its card in place.
async function saveWebsite(key: string, patch: Record<string, unknown>, render = true): Promise<boolean> {
  try {
    const res = await apiFetch('/api/websites/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error'); return false; }
    if (data && data.website) {
      const i = websitesLoaded.findIndex((w) => w.key === key);
      if (i >= 0) websitesLoaded[i] = data.website;
      if (render) renderWebsites();
    }
    return true;
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
    return false;
  }
}

async function websiteAction(key: string, act: string, el: HTMLElement): Promise<void> {
  const w = websitesLoaded.find((x) => x.key === key);
  if (!w) return;
  const card = el.closest('.website-card') as HTMLElement;
  const paste = card.querySelector('.ck-paste') as HTMLTextAreaElement;
  const pasteActions = card.querySelector('.ck-paste-actions') as HTMLElement;

  // Any concrete action dismisses an open overflow menu (the menu toggle itself
  // manages its own open/closed state below).
  if (act !== 'menu') closeSiteMenus();

  switch (act) {
    case 'enable':
      await saveWebsite(key, { enabled: !w.enabled });
      return;
    case 'blur':
      // Toggle the privacy blur; saveWebsite refreshes the card and the home
      // list's blur state is recomputed on the next render.
      if (await saveWebsite(key, { blur: !w.blur })) applyBlurToRows();
      return;
    case 'res': {
      // The card's maximum-resolution dropdown (change event).
      const cap = (el as HTMLSelectElement).value;
      if (cap === 'global') await saveWebsite(key, { max_height: 0, no_download: false });
      else if (cap === 'none') await saveWebsite(key, { no_download: true, max_height: 0 });
      else await saveWebsite(key, { max_height: Number(cap), no_download: false });
      return;
    }
    case 'menu': {
      // Toggle this card's overflow menu; close any other open one.
      const pop = card.querySelector('.site-menu-pop') as HTMLElement;
      const wasOpen = !pop.classList.contains('hidden');
      closeSiteMenus();
      if (!wasOpen) pop.classList.remove('hidden');
      return;
    }
    case 'edit':
      openSiteEdit(w);
      return;
    case 'site-delete':
      if (!confirm(t('sites.deleteConfirm', { name: w.name }))) return;
      try {
        const res = await apiFetch('/api/websites/' + encodeURIComponent(key), { method: 'DELETE' });
        if (res.ok) { siteSelected.delete(key); websitesLoaded = websitesLoaded.filter((x) => x.key !== key); renderWebsites(); }
      } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
      return;
    case 'validate': {
      const sample = prompt(t('sites.validatePrompt', { name: w.name }), w.hosts[0] ? 'https://' + w.hosts[0] + '/' : '');
      if (!sample) return;
      toast(t('sites.validating'), 'info');
      try {
        const res = await apiFetch('/api/websites/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sample }),
        });
        const data = await res.json().catch(() => ({}));
        toast(data.ok ? t('sites.validateOk', { title: data.title || '' }) : t('sites.validateFail', { err: data.error || '' }), data.ok ? 'ok' : 'error');
      } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
      return;
    }
    case 'ck-import':
      paste.classList.remove('hidden'); pasteActions.classList.remove('hidden'); paste.focus();
      return;
    case 'ck-cancel':
      paste.value = ''; paste.classList.add('hidden'); pasteActions.classList.add('hidden');
      return;
    case 'ck-save': {
      const text = paste.value.trim();
      if (!text) { toast(t('toast.pasteCookiesFirst'), 'error'); return; }
      try {
        const res = await apiFetch('/api/websites/' + encodeURIComponent(key) + '/cookies', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.cookieUpdateFail'), 'error'); return; }
        toast(t('toast.cookiesSaved'), 'ok');
        if (data.cookie) w.cookie = data.cookie;
        renderWebsites();
      } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
      return;
    }
    case 'ck-switch': {
      // The cookie switch: with a jar present it flips enabled/disabled; with no
      // jar yet, turning it on opens the import field (there's nothing to enable
      // until cookies exist, so "on" means "let me add some").
      if (w.cookie && w.cookie.present) {
        try {
          const res = await apiFetch('/api/websites/' + encodeURIComponent(key) + '/cookies', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !w.cookie.enabled }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.cookie) { w.cookie = data.cookie; renderWebsites(); }
        } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
      } else {
        // The frontend thinks there's no jar — but our cached view can be stale
        // (app resume, a dropped refresh, an SSE re-render), and a jar the user
        // already imported may still live on the server. Re-verify before making
        // them paste again: PATCH-enable returns the jar when it exists and 404s
        // only when genuinely absent. So enabling reuses the stored cookie; the
        // import field opens only when the server truly has nothing.
        try {
          const res = await apiFetch('/api/websites/' + encodeURIComponent(key) + '/cookies', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
          });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.cookie && data.cookie.present) { w.cookie = data.cookie; renderWebsites(); return; }
          } else if (res.status !== 404) {
            return; // a real server error — don't fall through to a spurious re-import
          }
        } catch (e) { if (isUnauthorized(e)) return; }
        // Genuinely no jar on the server → open the import field to add one.
        paste.classList.remove('hidden'); pasteActions.classList.remove('hidden'); paste.focus();
      }
      return;
    }
    case 'ck-delete': {
      try {
        const res = await apiFetch('/api/websites/' + encodeURIComponent(key) + '/cookies', { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { w.cookie = data.cookie; toast(t('toast.cookiesRemoved'), 'info'); renderWebsites(); }
      } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
      return;
    }
  }
}

function closeSiteMenus(): void {
  els.websiteList.querySelectorAll('.site-menu-pop:not(.hidden)').forEach((m) => m.classList.add('hidden'));
}

// ---- Website multi-select (batch enable/disable/merge/delete) ----
// Mirrors the home list's selection model: a toolbar toggle flips select mode, a
// tap on a card toggles its membership, and a bar exposes the batch actions.
function setSiteSelectMode(on: boolean): void {
  siteSelectMode = on;
  if (!on) siteSelected.clear();
  closeSiteMenus();
  els.siteSelToggle.classList.toggle('active', on);
  renderWebsites();
}

function toggleSiteSelect(key: string): void {
  if (siteSelected.has(key)) siteSelected.delete(key); else siteSelected.add(key);
  const card = els.websiteList.querySelector(`.website-card[data-key="${CSS.escape(key)}"]`);
  if (card) card.classList.toggle('selected', siteSelected.has(key));
  updateSiteSelBar();
}

function selectedSiteKeys(): string[] {
  // In display (sort) order, so merge's target is the topmost selection.
  return filteredWebsites().filter((w) => siteSelected.has(w.key)).map((w) => w.key);
}

function updateSiteSelBar(): void {
  const n = siteSelected.size;
  // Visible whenever select mode is on (even with nothing picked) so the
  // select-all / invert buttons stay reachable — mirrors the home list.
  els.siteSelBar.classList.toggle('hidden', !siteSelectMode);
  els.siteSelCount.textContent = t('sites.selectedN', { n });
  els.siteSelMerge.disabled = n < 2;
  els.siteSelEnable.disabled = n === 0;
  els.siteSelDisable.disabled = n === 0;
  els.siteSelDelete.disabled = n === 0;
  // Select-all / invert act on the visible (filtered) cards.
  const visible = filteredWebsites().length;
  els.siteSelAll.disabled = visible === 0;
  els.siteSelInvert.disabled = visible === 0;
  els.siteSelAll.textContent = visible > 0 && n >= visible ? t('sel.clear') : t('sel.all');
}

// "Select all" over the visible (filtered) cards; toggles to "clear" once every
// visible card is selected (one button covers select-all and none).
function selectAllSites(): void {
  const keys = filteredWebsites().map((w) => w.key);
  const allSelected = keys.length > 0 && keys.every((k) => siteSelected.has(k));
  if (allSelected) keys.forEach((k) => siteSelected.delete(k));
  else keys.forEach((k) => siteSelected.add(k));
  renderWebsites();
}

// Flip each visible card's membership (selected ⇄ unselected).
function invertSiteSelection(): void {
  filteredWebsites().forEach((w) => {
    if (siteSelected.has(w.key)) siteSelected.delete(w.key); else siteSelected.add(w.key);
  });
  renderWebsites();
}

async function batchSetEnabled(enabled: boolean): Promise<void> {
  const keys = selectedSiteKeys();
  if (!keys.length) return;
  for (const key of keys) {
    const w = websitesLoaded.find((x) => x.key === key);
    if (w && w.enabled !== enabled) await saveWebsite(key, { enabled }, false);
  }
  setSiteSelectMode(false);
}

async function batchDeleteSites(): Promise<void> {
  const keys = selectedSiteKeys();
  if (!keys.length) return;
  if (!confirm(t('sites.deleteN', { n: keys.length }))) return;
  for (const key of keys) {
    try {
      const res = await apiFetch('/api/websites/' + encodeURIComponent(key), { method: 'DELETE' });
      if (res.ok) websitesLoaded = websitesLoaded.filter((x) => x.key !== key);
    } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
  }
  setSiteSelectMode(false);
}

// Merge every selected site into the first (by display order); the rest fold in
// and are deleted, with their domains/cookies/download folders migrated.
async function batchMergeSites(): Promise<void> {
  const keys = selectedSiteKeys();
  if (keys.length < 2) return;
  const target = keys[0]!;
  const sources = keys.slice(1);
  const targetName = websitesLoaded.find((w) => w.key === target)?.name || target;
  if (!confirm(t('sites.mergeConfirm', { n: sources.length, name: targetName }))) return;
  try {
    const res = await apiFetch('/api/websites/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, sources }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error'); return; }
    toast(t('sites.merged', { n: sources.length }), 'ok');
    setSiteSelectMode(false);
    loadWebsites();
  } catch (e) { if (!isUnauthorized(e)) toast('Network error', 'error'); }
}

// Add/edit site dialog. `existing` null = add (key editable); else edit (key locked).
let siteEditKey: string | null = null;
function openSiteEdit(existing: Website | null): void {
  siteEditKey = existing ? existing.key : null;
  els.siteEditTitle.textContent = existing ? t('sites.editTitle') : t('sites.addTitle');
  els.siteEditName.value = existing ? existing.name : '';
  els.siteEditKey.value = existing ? existing.key : '';
  els.siteEditKey.readOnly = !!existing;
  els.siteEditHosts.value = existing ? existing.hosts.join(', ') : '';
  els.siteEditErr.classList.add('hidden');
  openModal(els.siteEdit);
  (existing ? els.siteEditHosts : els.siteEditName).focus();
}

async function saveSiteEdit(): Promise<void> {
  const name = els.siteEditName.value.trim();
  const key = (siteEditKey || els.siteEditKey.value.trim().toLowerCase()).replace(/[^a-z0-9_]/g, '');
  const hosts = els.siteEditHosts.value.trim();
  if (!key) { els.siteEditErr.textContent = t('sites.keyRequired'); els.siteEditErr.classList.remove('hidden'); return; }
  const ok = await saveWebsite(key, { name: name || key, hosts });
  if (ok) { closeModal(els.siteEdit); if (!siteEditKey) loadWebsites(); }
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
    const res = await apiFetch(itemPath(id, '/public'), {
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
    if (!isUnauthorized(e)) toast('Network error', 'error');
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
  closeModal(els.websites);
  els.token.value = getToken();
  if (els.server) els.server.value = apiBase();
  openModal(els.settings);
  refreshAppPermissions();
  loadArchive();
  loadLogs();
});
els.settingsClose.addEventListener('click', () => closeModal(els.settings));
els.settings.addEventListener('click', (e) => {
  if (e.target === els.settings) closeModal(els.settings); // backdrop dismiss
});

els.websitesToggle.addEventListener('click', () => {
  closeModal(els.settings);
  openModal(els.websites);
  // Open fresh: no lingering search filter or selection from a previous visit.
  siteQuery = '';
  els.siteSearch.value = '';
  setSiteSelectMode(false);
  loadSettings(); // the global max-res control now lives in this window
  loadWebsites();
});
els.websitesClose.addEventListener('click', () => closeModal(els.websites));
els.websites.addEventListener('click', (e) => {
  if (e.target === els.websites) closeModal(els.websites); // backdrop dismiss
});

els.websiteList.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest('.website-card') as HTMLElement | null;
  if (!card) return;
  // Selection mode: a tap anywhere on the card toggles its membership. Inner
  // controls are pointer-events:none in this mode (CSS) so they never fire.
  if (siteSelectMode) { toggleSiteSelect(card.dataset.key!); return; }
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  // The max-resolution <select> also carries data-act="res", but it must report
  // via its 'change' event only. Handling its click here would immediately
  // re-render the card (saveWebsite → renderWebsites) and destroy the native
  // dropdown before it can open — the "can't open the resolution picker" bug.
  if (!btn || btn.tagName === 'SELECT') return;
  websiteAction(card.dataset.key!, btn.dataset.act!, btn);
});
// The maximum-resolution dropdown reports via change, not click.
els.websiteList.addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest('select[data-act="res"]') as HTMLSelectElement | null;
  if (!sel || siteSelectMode) return;
  const card = sel.closest('.website-card') as HTMLElement;
  websiteAction(card.dataset.key!, 'res', sel);
});
// Click outside any open kebab menu closes it.
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.site-menu-wrap')) closeSiteMenus();
});
els.sitesAdd.addEventListener('click', () => openSiteEdit(null));
els.siteSearch.addEventListener('input', debounce(() => { siteQuery = els.siteSearch.value; renderWebsites(); }, 150));
els.siteSelToggle.addEventListener('click', () => setSiteSelectMode(!siteSelectMode));
els.siteSelAll.addEventListener('click', selectAllSites);
els.siteSelInvert.addEventListener('click', invertSiteSelection);
els.siteSelEnable.addEventListener('click', () => batchSetEnabled(true));
els.siteSelDisable.addEventListener('click', () => batchSetEnabled(false));
els.siteSelMerge.addEventListener('click', batchMergeSites);
els.siteSelDelete.addEventListener('click', batchDeleteSites);
els.siteSelCancel.addEventListener('click', () => setSiteSelectMode(false));
els.siteEditClose.addEventListener('click', () => closeModal(els.siteEdit));
els.siteEditCancel.addEventListener('click', () => closeModal(els.siteEdit));
els.siteEdit.addEventListener('click', (e) => {
  if (e.target === els.siteEdit) closeModal(els.siteEdit);
});
els.siteEditSave.addEventListener('click', saveSiteEdit);

els.tokenSave.addEventListener('click', () => {
  setToken(els.token.value.trim());
  els.tokenHint.classList.add('hidden');
  closeModal(els.settings);
  connectEvents();
  loadItems(true);
  loadStats();
  if (getToken()) loadWebsites();
});

// Server URL (app only): persist, then reconnect the SSE + reload against it.
if (els.serverSave) {
  els.serverSave.addEventListener('click', () => {
    // Refuse a plain-http public-IP server: it would ship the token + cookies in
    // the clear over the internet. Use https, or a private/LAN address.
    if (isInsecurePublicBase(els.server.value)) {
      toast(t('toast.insecureServer'), 'error');
      return;
    }
    setApiBase(els.server.value);
    closeModal(els.settings);
    loadServerConfig();
    connectEvents();
    loadItems(true);
  });
}

type AppPermissionStatus = { notifications: boolean; background: boolean };
let appPermissions: AppPermissionStatus | null = null;
const requestingPermissions = new Set<keyof AppPermissionStatus>();
const PERMISSION_PROMPT_NEVER = 'orca_permissions_prompt_never';
migrateLegacyStorage(PERMISSION_PROMPT_NEVER, 'permissions_prompt_never');

function renderAppPermission(kind: keyof AppPermissionStatus): void {
  const granted = appPermissions?.[kind] ?? null;
  const requesting = requestingPermissions.has(kind);
  const state = requesting ? 'checking' : granted == null ? 'checking' : granted ? 'granted' : 'missing';
  document.querySelectorAll<HTMLButtonElement>(`.permission-item[data-permission="${kind}"]`).forEach((button) => {
    button.dataset.state = state;
    button.disabled = requesting;
    const status = button.querySelector<HTMLElement>('.permission-status');
    const result = button.querySelector<HTMLElement>('.permission-result');
    if (status) status.textContent = t(requesting
      ? 'settings.permRequesting'
      : granted == null ? 'settings.permChecking' : granted ? 'settings.permGranted' : 'settings.permMissing');
    if (result) result.textContent = state === 'granted' ? '✓' : state === 'missing' ? '›' : '…';
  });
}

function renderAppPermissions(): void {
  renderAppPermission('notifications');
  renderAppPermission('background');
}

async function refreshAppPermissions(): Promise<AppPermissionStatus | null> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke) return null;
  try {
    const status = await T.core.invoke('android_permission_status') as AppPermissionStatus;
    appPermissions = { notifications: !!status.notifications, background: !!status.background };
    els.permRow.classList.remove('hidden');
    renderAppPermissions();
    if (appPermissions.notifications && appPermissions.background && !els.permissionsPrompt.classList.contains('hidden')) {
      closeModal(els.permissionsPrompt);
    }
    return appPermissions;
  } catch (_) {
    // Desktop Tauri has no Android permission bridge; keep the row hidden there.
    els.permRow.classList.add('hidden');
    return null;
  }
}

async function requestAppPermission(kind: 'notifications' | 'background'): Promise<void> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke) return;
  const current = await refreshAppPermissions();
  if (!current || current[kind]) return;
  requestingPermissions.add(kind);
  renderAppPermission(kind);
  try {
    if (kind === 'notifications') {
      await T.core.invoke('request_notification_permission');
    } else {
      await T.core.invoke('request_background_permission');
    }
  } catch (_) { /* the next state read shows the actual result */ }
  requestingPermissions.delete(kind);
  await refreshAppPermissions();
}

document.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.permission-item[data-permission]');
  const kind = button?.dataset.permission;
  if (kind === 'notifications' || kind === 'background') requestAppPermission(kind);
});

function dismissPermissionPrompt(never: boolean): void {
  if (never) localStorage.setItem(PERMISSION_PROMPT_NEVER, '1');
  closeModal(els.permissionsPrompt);
}
els.permissionsPromptClose.addEventListener('click', () => dismissPermissionPrompt(false));
els.permissionsPromptLater.addEventListener('click', () => dismissPermissionPrompt(false));
els.permissionsPromptNever.addEventListener('click', () => dismissPermissionPrompt(true));

// ---- Seal / yt-dlp download archive editor --------------------------------
// Not just import: the textarea shows every dedup key Orca has recorded so the
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
    if (!isUnauthorized(e)) toast(t('toast.loadArchiveFail'), 'error');
  }
}

// ---- Max-resolution setting -----------------------------------------------
// Server-side cap on the resolution yt-dlp downloads. Highest by default; a
// ORCA_MAX_HEIGHT env var pins it (the control then reads locked/disabled).
async function loadSettings(): Promise<void> {
  if (!els.maxRes || !getToken()) return;
  try {
    const res = await apiFetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    // "None" (no-download) is the sentinel value "none"; otherwise the numeric cap
    // (0 = highest). See put_settings.
    els.maxRes.value = data.no_download ? 'none' : String(data.max_height || 0);
    const locked = !!data.max_height_locked;
    els.maxRes.disabled = locked;
    els.maxResSave.disabled = locked;
    els.maxResLocked.classList.toggle('hidden', !locked);
  } catch (_) { /* offline / unauthorized — leave the control as-is */ }
}

// ---- Diagnostics error log ------------------------------------------------
// Reads the backend's bounded ring buffer (GET /api/logs) and renders each
// entry as a native <details> disclosure — the standard, dependency-free
// collapsible "log line": summary shows time + platform + a one-line preview,
// expanding reveals the full message. Per-row and copy-all buttons use the
// existing clipboard helper. Refreshed each time Settings opens.
let logsCache: LogEntry[] = [];

function fmtLogTime(at: number): string {
  try { return new Date(at * 1000).toLocaleString(); } catch (_) { return String(at); }
}

// One entry flattened to plain text for the clipboard.
function logEntryText(e: LogEntry): string {
  return `${fmtLogTime(e.at)}  [${e.stage}] ${e.platform}\n${e.url}\n${e.message}`;
}

function renderLogs(entries: LogEntry[]): void {
  const list = els.logList;
  if (!list) return;
  list.textContent = '';
  if (els.logEmpty) els.logEmpty.classList.toggle('hidden', entries.length > 0);
  for (const e of entries) {
    const d = document.createElement('details');
    d.className = 'log-entry log-entry--' + (e.stage === 'download' ? 'download' : 'probe');

    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="log-time">${esc(fmtLogTime(e.at))}</span>` +
      `<span class="log-badge">${esc(e.platform || 'unknown')}</span>` +
      `<span class="log-stage">${esc(e.stage)}</span>` +
      `<span class="log-msg-short">${esc(e.message)}</span>`;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'log-copy';
    copyBtn.title = t('logs.copyOne');
    copyBtn.setAttribute('aria-label', t('logs.copyOne'));
    copyBtn.textContent = '⧉';
    // Don't let the copy button toggle the disclosure.
    copyBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      copyText(logEntryText(e), t('toast.logCopied'));
    });
    summary.appendChild(copyBtn);
    d.appendChild(summary);

    const pre = document.createElement('pre');
    pre.className = 'log-full';
    pre.textContent = `${e.url}\n\n${e.message}`;
    d.appendChild(pre);

    list.appendChild(d);
  }
}

async function loadLogs(): Promise<void> {
  if (!els.logList || !getToken()) return;
  try {
    const res = await apiFetch('/api/logs');
    if (!res.ok) return;
    const data = await res.json();
    logsCache = (data.entries || []) as LogEntry[];
    renderLogs(logsCache);
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.logsLoadFail'), 'error');
  }
}

if (els.logsRefresh) {
  els.logsRefresh.addEventListener('click', () => loadLogs());
}
if (els.logsCopy) {
  els.logsCopy.addEventListener('click', () => {
    if (!logsCache.length) { toast(t('logs.empty'), 'info'); return; }
    copyText(logsCache.map(logEntryText).join('\n\n'), t('toast.logsCopied', { n: logsCache.length }));
  });
}

// ---- Per-item resolution multi-select -------------------------------------
// The resolution button on a completed card opens this: a checkbox list of the
// resolution versions the source offers, with the already-downloaded ones
// checked. Applying downloads newly-checked versions and deletes the files of
// unchecked ones. At least one must stay checked (no silent fallback).
let resTarget: number | null = null;

async function openResolutions(id: number): Promise<void> {
  if (!getToken()) { showTokenField(false); return; }
  // Fetch first, decide second: the source's resolution set is cached server-side
  // after the first probe, so this is fast on repeat opens. Only pop the modal
  // when there's an actual choice to make (≥2 options); a single available
  // resolution just gets a toast — no dialog to dismiss (Req 2).
  let data: { available?: number[]; downloaded?: number[] };
  try {
    const res = await apiFetch(itemPath(id, '/resolutions'));
    if (!res.ok) throw new Error('load');
    data = await res.json();
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('res.loadFail'), 'error');
    return;
  }
  // Collapse heights that map to the same human label (e.g. a portrait video's
  // 1280 and a 1080 both read "1080p") so the picker never shows a duplicate row;
  // keep the highest actual height per label (list arrives highest-first).
  const available = dedupByLabel(data.available || []);
  const downloaded = data.downloaded || [];
  // Open the picker whenever there's a real choice: ≥2 source resolutions, OR the
  // item already holds ≥1 downloaded version (so it can be cleared to "None").
  // Only short-circuit with a toast when there is genuinely nothing to decide.
  if (available.length <= 1 && downloaded.length === 0) {
    toast(t('res.single', { res: resLabel(available[0]) || t('res.noneLabel') }), 'info');
    return;
  }
  resTarget = id;
  els.resolutionEmpty.classList.add('hidden');
  renderResolutionOptions(available, downloaded);
  openModal(els.resolution);
}

// Keep only the first (highest) height for each distinct resolution label, so two
// heights that bucket to the same label don't produce duplicate picker rows.
function dedupByLabel(heights: number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const h of heights) {
    const label = resLabel(h) || (h + 'p');
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(h);
  }
  return out;
}

// Each option is a toggle row (industry multi-select pattern), NOT a native
// checkbox: the row itself highlights when selected (like the home-screen card
// multi-select), so Android WebViews don't paint the stray rectangular checkbox
// tap-highlight (Req 4).
function renderResolutionOptions(available: number[], downloaded: number[]): void {
  els.resolutionList.textContent = '';
  if (!available.length) {
    els.resolutionEmpty.classList.remove('hidden');
    els.resolutionSave.disabled = true;
    return;
  }
  els.resolutionEmpty.classList.add('hidden');
  const have = new Set(downloaded);
  for (const h of available) {
    const opt = document.createElement('div');
    opt.className = 'res-opt' + (have.has(h) ? ' selected' : '');
    opt.dataset.height = String(h);
    opt.setAttribute('role', 'checkbox');
    opt.setAttribute('aria-checked', have.has(h) ? 'true' : 'false');
    opt.tabIndex = 0;
    const span = document.createElement('span');
    span.textContent = resLabel(h) || (h + 'p');
    opt.appendChild(span);
    els.resolutionList.appendChild(opt);
  }
  els.resolutionSave.disabled = false;
}

// Toggle a resolution row's selected state (click / keyboard). Delegated from the
// list container so it survives re-renders.
function toggleResOpt(opt: HTMLElement): void {
  const on = opt.classList.toggle('selected');
  opt.setAttribute('aria-checked', on ? 'true' : 'false');
}

async function saveResolutions(): Promise<void> {
  if (resTarget == null) return;
  const heights = [...els.resolutionList.querySelectorAll('.res-opt.selected')]
    .map((c) => Number((c as HTMLElement).dataset.height));
  // Deselecting everything is the explicit "None" mode: the backend purges every
  // local file and keeps the entry as a stream-only record (plays from source).
  const target = resTarget;
  els.resolutionSave.disabled = true;
  try {
    const res = await apiFetch(itemPath(target, '/resolutions'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heights }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error'); return; }
    const queued = ((data && data.queued) || []).length;
    toast(!heights.length ? t('res.cleared') : queued ? t('res.queued', { n: queued }) : t('res.updated'), 'ok');
    closeModal(els.resolution);
    // Refetch so the card's resolution label/size reflect the new highest kept
    // version immediately (removals repoint the primary server-side; Req 3).
    apiFetch(itemPath(target))
      .then((r) => (r.ok ? r.json() : null))
      .then((it) => { if (it) upsertRow(it, false); })
      .catch(() => { /* SSE / next load will catch up */ });
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    els.resolutionSave.disabled = false;
  }
}

els.resolutionClose.addEventListener('click', () => closeModal(els.resolution));
els.resolutionCancel.addEventListener('click', () => closeModal(els.resolution));
els.resolution.addEventListener('click', (e) => {
  if (e.target === els.resolution) closeModal(els.resolution); // backdrop dismiss
});
els.resolutionSave.addEventListener('click', saveResolutions);
// Toggle a resolution row on tap (delegated) and on Enter/Space for keyboard use.
els.resolutionList.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest('.res-opt') as HTMLElement | null;
  if (opt) toggleResOpt(opt);
});
els.resolutionList.addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const opt = (ev.target as HTMLElement).closest('.res-opt') as HTMLElement | null;
  if (opt) { ev.preventDefault(); toggleResOpt(opt); }
});

if (els.maxResSave) {
  els.maxResSave.addEventListener('click', async () => {
    els.maxResSave.disabled = true;
    try {
      const none = els.maxRes.value === 'none';
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(none ? { no_download: true } : { max_height: Number(els.maxRes.value) || 0 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error'); return; }
      els.maxRes.value = data.no_download ? 'none' : String(data.max_height || 0);
      toast(t('toast.settingsSaved'), 'ok');
    } catch (e) {
      if (!isUnauthorized(e)) toast('Network error', 'error');
    } finally {
      els.maxResSave.disabled = false;
    }
  });
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
      if (!isUnauthorized(e)) toast('Network error', 'error');
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

// Native "tap-to-peek" for privacy-blurred cards. Industry spoiler pattern:
// a tap reveals briefly, but re-blurs the instant the user's attention moves on
// (a tap anywhere outside the card, a scroll) — and after a short fallback timeout
// — rather than lingering revealed. Only one card peeks at a time.
let revealedPeek: { el: HTMLElement; timer: number } | null = null;
function reblurNow(): void {
  if (!revealedPeek) return;
  clearTimeout(revealedPeek.timer);
  revealedPeek.el.classList.remove('revealed');
  revealedPeek = null;
  document.removeEventListener('pointerdown', onOutsidePeek, true);
  window.removeEventListener('scroll', reblurNow, true);
}
function onOutsidePeek(e: Event): void {
  if (revealedPeek && !revealedPeek.el.contains(e.target as Node)) reblurNow();
}
function revealBlurred(el: HTMLElement): void {
  reblurNow(); // collapse any prior peek first
  el.classList.add('revealed');
  const timer = window.setTimeout(reblurNow, 2500); // short fallback auto-hide
  revealedPeek = { el, timer };
  // The reveal fired on `click`, so this next-pointerdown listener only catches
  // the FOLLOWING interaction — a tap elsewhere (or a scroll) re-blurs at once.
  document.addEventListener('pointerdown', onOutsidePeek, true);
  window.addEventListener('scroll', reblurNow, true);
}

// Delegated actions on cards: in select mode a tap toggles the row; otherwise
// thumbnail play / share dialog as before.
els.history.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const head = target.closest('.group-head') as HTMLElement | null;
  const gkey = () => (head!.parentElement as HTMLElement).dataset.group as string;
  if (state.selectMode) {
    if (suppressClick) { suppressClick = false; return; } // ignore the click a long-press spawns
    if (head) { e.preventDefault(); toggleGroupSelect(gkey()); return; } // whole fold at once
    const li = target.closest('.item') as HTMLElement | null;
    if (li) { e.preventDefault(); toggleSelect(Number(li.dataset.id)); }
    return;
  }
  // Native app: the first tap on a blurred (privacy) card reveals it temporarily
  // instead of activating whatever was under the finger. On the web the card
  // reveals on :hover (CSS), so this only matters for touch.
  if (isNativeApp) {
    const bl = target.closest('.item.blurred:not(.revealed)') as HTMLElement | null;
    if (bl) {
      // Only the blurred visual area (thumbnail / title / uploader) reveals-then-
      // waits. The action buttons are never blurred (see .item.blurred CSS), so a
      // tap on one reveals the card AND activates the button in a single tap —
      // no second press. The play overlay counts as blurred content (reveal first).
      const onAction = target.closest('[data-act]');
      if (!onAction) {
        e.preventDefault();
        revealBlurred(bl);
        return;
      }
      revealBlurred(bl); // reveal, then fall through to run the button's action
    }
  }
  if (head) {
    // Whole-list actions on the fold header take priority over expand/collapse.
    const act = target.closest('[data-act]') as HTMLElement | null;
    if (act && head.contains(act)) {
      e.preventDefault();
      const a = act.dataset.act;
      if (a === 'play-list') playGroup(gkey());
      else if (a === 'share-list') shareGroup(gkey());
      else if (a === 'dl-list') downloadGroup(gkey());
      else if (a === 'del-list') deleteGroup(gkey());
      return;
    }
    toggleGroupExpand(gkey());
    return;
  }
  // A title too long for its two lines expands in place on tap (and re-clamps on
  // a second tap) — the disclosure pattern YouTube/Reddit use. Height only grows
  // for the one row the user asked about, never the resting list.
  const titleEl = target.closest('.title') as HTMLElement | null;
  if (titleEl) {
    const row = titleEl.closest('.item') as HTMLElement | null;
    if (row) { row.classList.toggle('title-open'); return; }
  }
  const play = target.closest('.thumb-play') as HTMLElement | null;
  if (play) { e.preventDefault(); openPlayer(Number(play.dataset.id), play.dataset.cloud === '1', thumbSrc(play)); return; }

  const btn = target.closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'share') openShare(id);
  else if (btn.dataset.act === 'delete') openDeleteConfirm([id]);
  else if (btn.dataset.act === 'resolutions') openResolutions(id);
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
  [els.selDownload, els.selShare, els.selUnshare, els.selCopy, els.selClean, els.selDelete].forEach((b) => { b.disabled = n === 0; });
  // Select-all / invert act on the loaded rows, so they're live whenever any
  // row exists; "Select all" reads "Clear" once everything loaded is selected.
  const loaded = state.rows.size;
  els.selAll.disabled = loaded === 0;
  els.selInvert.disabled = loaded === 0;
  els.selAll.textContent = loaded > 0 && n >= loaded ? t('sel.clear') : t('sel.all');
  refreshGroupHeaders(); // keep fold headers' selected/partial state in sync
}

// Items backing the current selection (latest known objects).
function selectedItems(): Item[] {
  return [...state.selected].map((id) => state.items.get(id)).filter(Boolean) as Item[];
}

// Reflect the selection Set onto every loaded row and refresh the toolbar.
function syncSelectionClasses(): void {
  state.rows.forEach((li, id) => li.classList.toggle('selected', state.selected.has(id)));
  updateSelBar();
}

// "Select all" over the loaded rows; toggles to "clear" once all are selected
// (the standard file-manager pattern — one button covers select-all and none).
function selectAllLoaded(): void {
  const ids = [...state.rows.keys()];
  const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
  if (allSelected) state.selected.clear();
  else ids.forEach((id) => state.selected.add(id));
  syncSelectionClasses();
}

// Flip each loaded row's membership (selected ⇄ unselected).
function invertSelection(): void {
  state.rows.forEach((_li, id) => {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  });
  syncSelectionClasses();
}

els.selectToggle.addEventListener('click', () => {
  if (state.selectMode) exitSelectMode();
  else enterSelectMode();
});
els.selCancel.addEventListener('click', exitSelectMode);
els.selAll.addEventListener('click', selectAllLoaded);
els.selInvert.addEventListener('click', invertSelection);

// Long-press a card (touch) to enter select mode / select that row. A moved
// finger or lifted press under the threshold cancels (so scrolling is intact).
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let suppressClick = false; // set when a long-press fired, to swallow the trailing click
els.history.addEventListener('touchstart', (e) => {
  suppressClick = false; // clear any stale flag from a prior long-press with no click
  const el = e.target as HTMLElement;
  const head = el.closest('.group-head') as HTMLElement | null;
  const li = el.closest('.item') as HTMLElement | null;
  if (!head && !li) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    if (!state.selectMode) enterSelectMode();
    // Long-press a fold header picks the whole post; a child card picks that row.
    if (head) toggleGroupSelect((head.parentElement as HTMLElement).dataset.group as string);
    else toggleSelect(Number(li!.dataset.id));
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

// Save every item that still has a local file (the current selection, or an
// explicit list — used to download a whole fold). Staggered so the browser
// doesn't drop rapid concurrent downloads.
function batchDownload(source?: Item[]): void {
  const items = (source ?? selectedItems()).filter((it) => it.status === 'completed' && it.local_available);
  if (!items.length) { toast(t('toast.noDownloadable'), 'info'); return; }
  items.forEach((it, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = fileUrl(it, true);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
  toast(t('toast.downloadingN', { n: items.length }), 'ok');
}

// Open the batch-share dialog: the same 7 / 30 / permanent duration picker as
// the single-item share, applied to every completed item in the selection — or
// an explicit list (a whole fold), stashed so the deferred confirm targets it.
let batchShareSource: Item[] | null = null;
function openBatchShare(source?: Item[]): void {
  batchShareSource = source ?? null;
  const items = (source ?? selectedItems()).filter((it) => it.status === 'completed' && it.local_available);
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

// Make every targeted completed item public with the chosen window (the stashed
// fold list if a fold was shared, else the current selection).
async function applyBatchShare(): Promise<void> {
  const items = (batchShareSource ?? selectedItems()).filter((it) => it.status === 'completed' && it.local_available);
  if (!items.length) { closeModal(els.batchShare); return; }
  const days = selectedBatchShareDays();
  els.batchShareConfirm.disabled = true;
  let ok = 0;
  try {
    for (const it of items) {
      const res = await apiFetch(itemPath(it, '/public'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: true, expires_in_days: days }),
      });
      if (res.ok) { const data = await res.json(); upsertRow(data, false); ok++; }
    }
    const label = days == null ? t('dur.permanently') : t('dur.days', { n: days });
    toast(ok ? t('toast.sharedN', { n: ok, dur: label }) : t('toast.shareFail'), ok ? 'ok' : 'error');
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    els.batchShareConfirm.disabled = false;
    closeModal(els.batchShare);
    batchShareSource = null;
    updateSelBar(); // re-enable per current selection
  }
}

// Whole-fold helpers wired to the header's play/share/download actions.
function shareGroup(gkey: string): void {
  openBatchShare(groupChildIds(gkey).map((id) => state.items.get(id)).filter(Boolean) as Item[]);
}
function downloadGroup(gkey: string): void {
  batchDownload(groupChildIds(gkey).map((id) => state.items.get(id)).filter(Boolean) as Item[]);
}

// Stop sharing every selected item that is currently public (turns them private).
async function batchUnshare(): Promise<void> {
  const items = selectedItems().filter((it) => it.public);
  if (!items.length) { toast(t('toast.noShared'), 'info'); return; }
  els.selUnshare.disabled = true;
  let ok = 0;
  try {
    for (const it of items) {
      const res = await apiFetch(itemPath(it, '/public'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: false }),
      });
      if (res.ok) { const data = await res.json(); upsertRow(data, false); ok++; }
    }
    toast(ok ? t('toast.stoppedSharingN', { n: ok }) : t('toast.updateFail'), ok ? 'info' : 'error');
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
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

// Drop a row from the DOM and all state maps (after a successful delete). If it
// was the last child of a playlist fold, remove the (now empty) fold too;
// otherwise refresh the fold header (thumbnails / count / status).
function removeRow(id: number): void {
  const li = state.rows.get(id);
  const groupCard = li?.closest('.group-card') as HTMLElement | null;
  li?.remove();
  state.rows.delete(id);
  state.items.delete(id);
  state.selected.delete(id);
  const gkey = groupCard?.dataset.group;
  if (gkey) {
    const g = state.groups.get(gkey);
    if (g && g.body.children.length === 0) { groupCard!.remove(); state.groups.delete(gkey); }
    else updateGroupHeader(gkey);
  }
}

// Ids awaiting the confirm dialog's Yes. Deletion is destructive (DB record +
// any local files), so every path — a single card's trash icon, a whole fold,
// or the multi-select selection — routes through this one confirm.
let pendingDeleteIds: number[] = [];
function openDeleteConfirm(ids: number[]): void {
  const n = ids.length;
  if (!n) return;
  pendingDeleteIds = ids;
  // Sum the local file sizes we'd reclaim so the confirm states how much space
  // deleting frees (industry file-manager pattern for a destructive delete).
  const freed = ids.reduce((sum, id) => {
    const it = state.items.get(id);
    return sum + (it?.total_filesize || it?.filesize || 0);
  }, 0);
  const sub = t('deleteConfirm.sub', { n });
  els.deleteConfirmSub.textContent = freed > 0
    ? sub + ' ' + t('deleteConfirm.frees', { size: fmtSize(freed) })
    : sub;
  openModal(els.deleteConfirm);
}

// Delete every video of a playlist fold (its child ids), behind the confirm.
function deleteGroup(gkey: string): void {
  openDeleteConfirm(groupChildIds(gkey));
}

// DELETE every pending item, removing its local file too (the backend no-ops
// safely when there's no file, so this just clears the record then). Rows drop
// from the list as they succeed.
async function batchDelete(): Promise<void> {
  const ids = pendingDeleteIds.slice();
  pendingDeleteIds = [];
  closeModal(els.deleteConfirm);
  if (!ids.length) return;
  els.selDelete.disabled = true;
  let ok = 0;
  try {
    for (const id of ids) {
      const res = await apiFetch(itemPath(id) + '?delete_file=true', { method: 'DELETE' });
      if (res.ok) { removeRow(id); ok++; }
    }
    if (ok) els.empty.classList.toggle('hidden', state.rows.size > 0);
    if (ok) loadStats(); // removed files shrink the total-downloaded readout
    toast(ok ? t('toast.deletedN', { n: ok }) : t('toast.deleteFail'), ok ? 'ok' : 'error');
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    updateSelBar();
  }
}

// Batch "clean local downloads": set every selected item to "None" (stream-only)
// by reconciling its resolutions to the empty set. The backend purges each item's
// local files and clears its primary, keeping the DB entry so it still streams
// from source. Rows refresh in place (cloud badge, no size chip).
async function batchClean(): Promise<void> {
  const ids = [...state.selected];
  if (!ids.length) return;
  els.selClean.disabled = true;
  let ok = 0;
  try {
    for (const id of ids) {
      const res = await apiFetch(itemPath(id, '/resolutions'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heights: [] }),
      });
      if (res.ok) {
        ok++;
        apiFetch(itemPath(id))
          .then((r) => (r.ok ? r.json() : null))
          .then((it) => { if (it) upsertRow(it, false); })
          .catch(() => { /* SSE / next load will catch up */ });
      }
    }
    if (ok) loadStats(); // freed files shrink the total-downloaded readout
    toast(ok ? t('sel.cleanedN', { n: ok }) : t('toast.saveFail'), ok ? 'ok' : 'error');
    exitSelectMode();
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    updateSelBar();
  }
}

els.selDownload.addEventListener('click', () => batchDownload());
els.selShare.addEventListener('click', () => openBatchShare());
els.selUnshare.addEventListener('click', batchUnshare);
els.selCopy.addEventListener('click', batchCopyLinks);
els.selClean.addEventListener('click', batchClean);
els.selDelete.addEventListener('click', () => openDeleteConfirm([...state.selected]));
els.deleteConfirmYes.addEventListener('click', batchDelete);
els.deleteConfirmCancel.addEventListener('click', () => closeModal(els.deleteConfirm));
els.deleteConfirmClose.addEventListener('click', () => closeModal(els.deleteConfirm));
els.deleteConfirm.addEventListener('click', (e) => {
  if (e.target === els.deleteConfirm) closeModal(els.deleteConfirm); // backdrop dismiss
});
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
  // Also tag the whole card: the duration moves off the thumbnail and into the
  // size capsule for portrait (see metaChipsHtml), and the capsule lives in
  // .body — outside .thumb-wrap — so it needs a shared ancestor to key off.
  img.closest('.item, .group-head')?.classList.toggle('portrait-media', portrait);
}, true);

// Keyboard access for the play thumbnail (it's a role="button").
els.history.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const head = (e.target as HTMLElement).closest('.group-head') as HTMLElement | null;
  if (head) {
    e.preventDefault();
    const gkey = (head.parentElement as HTMLElement).dataset.group as string;
    if (state.selectMode) toggleGroupSelect(gkey); else toggleGroupExpand(gkey);
    return;
  }
  const play = (e.target as HTMLElement).closest('.thumb-play') as HTMLElement | null;
  if (!play) return;
  e.preventDefault();
  openPlayer(Number(play.dataset.id), play.dataset.cloud === '1', thumbSrc(play));
});

// ---- Fullscreen in-app player ---------------------------------------------
// Tapping a finished thumbnail opens a fullscreen overlay instead of navigating
// away (a new page/tab fights the mobile app's single-task model). We push a
// history entry so the Android back button pops the player back to the list
// rather than exiting the app.
// The tapped card's already-loaded thumbnail image, used as the player poster.
function thumbSrc(play: HTMLElement): string | undefined {
  const img = play.querySelector('img.thumb') as HTMLImageElement | null;
  return img?.currentSrc || img?.src || undefined;
}

// Sequential-play queue for a whole fold. Empty for a normal single-tap play, so
// the `ended` handler is a no-op there.
let playQueue: Array<{ id: number; cloud: boolean; poster?: string }> = [];
let playIndex = 0;
let playerScrollY = 0;
function playCurrentInQueue(): void {
  const cur = playQueue[playIndex];
  if (cur) openPlayer(cur.id, cur.cloud, cur.poster);
}

function openPlayer(id: number, cloud: boolean, poster?: string): void {
  const v = els.playerVideo;
  const opening = els.player.classList.contains('hidden');
  if (opening) {
    playerScrollY = window.scrollY;
    document.body.style.top = `-${playerScrollY}px`;
  }
  // Show the source thumbnail as the poster so the load gap (especially the
  // cloud proxy resolve) reads as the still frame instead of Chrome's default
  // gray media placeholder. Cleared again in closePlayer.
  if (poster) v.poster = poster; else v.removeAttribute('poster');
  els.player.classList.remove('hidden');
  els.player.setAttribute('aria-hidden', 'false');
  document.body.classList.add('player-open');
  // Browser: push a history entry so Back pops the player. In the native app the
  // central back handler (below) does this via its own sentinel — don't stack.
  if (!isNativeApp && !(history.state && history.state.player)) history.pushState({ player: true }, '');
  const play = () => v.play().catch(() => { /* autoplay may need a tap */ });
  if (cloud) {
    // Online mode: play through the backend proxy, keyed by the item's slug (not
    // its id). It resolves the upstream URL with cookies and streams the bytes
    // back, so we never hand the browser a stale/IP-bound CDN URL. The resolve
    // happens server-side (capped at 25s); the poster holds until the first bytes
    // arrive, and the <video> 'error' handler surfaces a failed resolve.
    const slug = state.items.get(id)?.slug;
    if (!slug) { toast(t('toast.streamFail'), 'error'); closePlayer(true); return; }
    v.src = streamUrl(slug);
    v.load();
    play();
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
  v.removeAttribute('poster');
  v.load();
  els.player.classList.add('hidden');
  els.player.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('player-open');
  document.body.style.top = '';
  window.scrollTo(0, playerScrollY);
  // A native hardware Back finishes its popstate restoration after this handler.
  // Re-apply once layout/history settle so WebView cannot overwrite us with the
  // sentinel entry's old (usually top-of-page) scroll position.
  requestAnimationFrame(() => window.scrollTo(0, playerScrollY));
  playQueue = []; // stop any sequential fold playback
  if (!isNativeApp && pop && history.state && history.state.player) history.back();
}

// Advance a fold's sequential playback when the current clip ends.
els.playerVideo.addEventListener('ended', () => {
  if (playIndex < playQueue.length - 1) { playIndex++; playCurrentInQueue(); }
});

// The media itself failing to load (a cloud source the browser can't play — e.g.
// an IP-bound upstream URL that resolved fine but won't stream) would otherwise
// leave the player frozen on its poster. Surface it and close instead of hanging.
// Guarded on a live src attribute so closePlayer's own src teardown — which
// clears the attribute before hiding — never trips a spurious toast.
els.playerVideo.addEventListener('error', () => {
  if (els.player.classList.contains('hidden')) return;
  if (!els.playerVideo.getAttribute('src')) return;
  toast(t('toast.streamFail'), 'error');
  closePlayer(true);
});

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
  if (!els.permissionsPrompt.classList.contains('hidden')) { closeModal(els.permissionsPrompt); return true; }
  if (!els.deleteConfirm.classList.contains('hidden')) { closeModal(els.deleteConfirm); return true; }
  if (!els.batchShare.classList.contains('hidden')) { closeModal(els.batchShare); return true; }
  if (!els.shareOverlay.classList.contains('hidden')) { closeShare(); return true; }
  if (!els.siteEdit.classList.contains('hidden')) { closeModal(els.siteEdit); return true; }
  if (!els.settings.classList.contains('hidden')) { closeModal(els.settings); return true; }
  if (!els.websites.classList.contains('hidden')) { closeModal(els.websites); return true; }
  if (state.selectMode) { exitSelectMode(); return true; }
  return false;
}

if (isNativeApp) {
  let exitArmed = false;
  let exitArmedAt = 0;
  const armSentinel = () => history.pushState({ orcaBack: true }, '');

  // The sentinel exists only to consume Android Back; its captured scroll offset
  // must never compete with the player's explicit list-position restoration.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  // Ask Tauri to quit (process plugin). If it's unavailable the sentinel isn't
  // re-armed, so we've dropped to the WebView root and the next hardware Back
  // exits the activity anyway — a safe fallback, just one extra press.
  const exitApp = () => {
    const T = window.__TAURI__;
    try { if (T?.core) T.core.invoke('plugin:process|exit', { code: 0 }); } catch (_) { /* fall through */ }
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
  // Keep native creds fresh for the headless Quick Download share target,
  // including for installs configured before this bridge existed.
  mirrorShareCreds();
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
// The Android foreground service (DownloadService.kt) is the SINGLE owner of
// download notifications. It polls the backend, so its progress survives the app
// being backgrounded or its process reclaimed — neither of which the WebView
// does. This file only hands it slugs to track; it never posts notifications
// itself. Two owners writing the same notification id was why progress used to
// stall and never reach "complete".
function setupAppPermissionRefresh(): void {
  if (!isNativeApp) return;
  const refresh = () => { setTimeout(refreshAppPermissions, 100); };
  refreshAppPermissions().then((status) => {
    if (!status || (status.notifications && status.background)) return;
    if (localStorage.getItem(PERMISSION_PROMPT_NEVER) !== '1') openModal(els.permissionsPrompt);
  });
  const T = window.__TAURI__;
  T?.event?.listen?.('tauri://resume', refresh);
  T?.event?.listen?.('tauri://focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
}

// Ask the native service to own this download's notification through to
// completion. No-op on the web (where the tab must stay open anyway).
function trackDownload(slug: string | undefined): void {
  if (!isNativeApp || !slug) return;
  try {
    window.__TAURI__?.core?.invoke('track_download', { slug });
  } catch (_) { /* best-effort — the download itself is unaffected */ }
}

// A download notification was tapped: bring the user to that item's row. The
// slug is stashed natively on the tap (MainActivity) and drained here, because
// the WebView may not exist yet on a cold start.
async function drainDeepLink(): Promise<void> {
  if (!isNativeApp) return;
  try {
    const slug = await window.__TAURI__?.core?.invoke('take_pending_deeplink');
    if (typeof slug === 'string' && slug) focusItemBySlug(slug);
  } catch (_) { /* plugin call failed; ignore */ }
}

// A tap can arrive on a cold start (drained once at boot) or while the app is
// already running in the background (tauri://resume, or the WebView regaining
// visibility), so every one of those has to re-check.
function setupDeepLinks(): void {
  if (!isNativeApp) return;
  drainDeepLink();
  const T = window.__TAURI__;
  T?.event?.listen?.('tauri://resume', () => { drainDeepLink(); });
  T?.event?.listen?.('tauri://focus', () => { drainDeepLink(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) drainDeepLink(); });
}

// Scroll an item into view and flash it, so a notification tap lands somewhere
// obvious rather than just opening the list at the top.
function focusItemBySlug(slug: string): void {
  const find = (): Item | undefined => {
    for (const item of state.items.values()) if (item.slug === slug) return item;
    return undefined;
  };
  const reveal = (item: Item): boolean => {
    const row = state.rows.get(item.id);
    if (!row) return false;
    // The row may be inside a collapsed group — open it first, or the scroll
    // target is hidden and the tap appears to do nothing.
    const group = row.closest('.group-card') as HTMLElement | null;
    const gkey = group?.dataset.group;
    if (gkey && group?.classList.contains('collapsed')) toggleGroupExpand(gkey);
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('focus-flash');
    setTimeout(() => row.classList.remove('focus-flash'), 2000);
    return true;
  };
  const item = find();
  if (item && reveal(item)) return;
  // Not rendered yet (a cold start races the first list load) — reload, then retry.
  loadItems(true).then(() => {
    const found = find();
    if (found) reveal(found);
  });
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
    if (pulling) { startY = e.touches[0]?.clientY ?? 0; dist = 0; }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = (e.touches[0]?.clientY ?? startY) - startY;
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
    ...Object.keys(langs).map((code) => [code, langs[code]!.label] as [string, string]),
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
const THEME_KEY = 'orca_theme';
migrateLegacyStorage(THEME_KEY, 'theme');
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
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themePref()) + 1) % THEME_ORDER.length]!;
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
  renderAppPermissions();
  setServerStatus(serverUp);
  renderDlStats(); // re-localize the "N items · X GB" summary
  if (getToken()) loadItems(true);
  if (!els.websites.classList.contains('hidden')) loadWebsites();
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
  softRefresh();
}

// Non-destructive page-1 refresh: reconcile the newest page in place instead of
// wiping #history and rebuilding it (the old loadItems(true), which flashed).
// Existing rows patch via upsertRow's signature guard (untouched when unchanged),
// genuinely-new rows are inserted at the top in order, and rows that vanished
// server-side within the refreshed range are removed. Rows below the first page
// (older, scroll-loaded) are left alone.
async function softRefresh(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    const res = await apiFetch('/api/items?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    const items: Item[] = data.items || [];
    // Iterate oldest→newest so prepending new rows leaves them newest-first.
    for (let i = items.length - 1; i >= 0; i--) upsertRow(items[i]!, true);
    // Drop rows deleted upstream. When a full page came back, only reconcile within
    // its window (id >= the oldest returned) so scroll-loaded older rows are spared.
    // When a partial page came back the whole history fits here, so reconcile all.
    const present = new Set(items.map((it) => it.id));
    const floor = items.length >= PAGE_SIZE ? items[items.length - 1]!.id : -Infinity;
    for (const id of [...state.rows.keys()]) {
      if (id >= floor && !present.has(id)) removeRow(id);
    }
    els.empty.classList.toggle('hidden', state.rows.size !== 0);
  } catch (e) {
    if (!isUnauthorized(e)) { /* transient; the next tick or SSE will heal it */ }
  } finally {
    state.loading = false;
  }
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
loadStats();
if (getToken()) loadWebsites(); // populate per-site privacy-blur state for the home list
handleShareParam();
setupNativeShare();
setupAppPermissionRefresh();
setupDeepLinks();
