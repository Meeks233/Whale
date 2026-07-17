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
  // Name the server serves the file under. With `filesize` it fingerprints the
  // file precisely enough for the Android app to recognise its own copy in
  // Downloads/Orca without having saved it through this build (see scanLocal).
  filename?: string | null;
  total_filesize?: number | null;  // sum across all downloaded resolution variants
  height?: number | null;
  // Height the download is aiming for, set by the backend when the job starts.
  // It is what the live chip reports while a transfer is in flight — `height`
  // stays null until a file actually lands.
  target_height?: number | null;
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
  /// Whose fault it was, classified by the backend (errlog::classify): "warn" =
  /// a dead end the user drove into, "error" = Orca broke. Older servers omit it.
  severity?: 'warn' | 'error';
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

// Project links (issue tracker, privacy policy, source) open in the system
// browser on native, and in a new tab on the web — where the plain
// <a target="_blank"> already does exactly that, so this only engages in the app.
// A `target="_blank"` inside the Tauri WebView otherwise either does nothing or
// loads GitHub over the app itself, and that WebView has no tabs, no address bar
// and no back button — the user just ends up stuck.
//
// Deliberately keyed to github.com rather than every external link: the opener's
// capability scope (capabilities/default.json) only allows this project's own
// URLs, so casting wider here would hand user-supplied links (a site's login URL,
// an item's source page) to a call that fails closed and toasts an error. Those
// keep whatever behaviour they have today.
const PROJECT_LINK_ORIGIN = 'https://github.com';
document.addEventListener('click', (e) => {
  if (!isNativeApp) return;
  const a = (e.target as HTMLElement).closest('a[target="_blank"]') as HTMLAnchorElement | null;
  if (!a || !a.href.startsWith(PROJECT_LINK_ORIGIN + '/')) return;
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return; // no bridge (desktop dev) — leave the default behaviour
  e.preventDefault();
  invoke('plugin:opener|open_url', { url: a.href });
});

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
  tokenHint: byId('token-hint'),
  server: byId<HTMLInputElement>('server'),
  permRow: byId('perm-row'),
  hideDlRow: byId('hide-dl-row'),
  hideDlHint: byId('hide-dl-hint'),
  hideDlToggle: byId<HTMLButtonElement>('hide-dl-toggle'),
  hideDlNeedsPerm: byId('hide-dl-needs-perm'),
  maxStorage: byId<HTMLInputElement>('max-storage'),
  maxStorageUnit: byId<HTMLSelectElement>('max-storage-unit'),
  maxStorageLocked: byId('max-storage-locked'),
  permissionsPrompt: byId('permissions-prompt'),
  permissionsPromptClose: byId<HTMLButtonElement>('permissions-prompt-close'),
  permissionsPromptLater: byId<HTMLButtonElement>('permissions-prompt-later'),
  permissionsPromptNever: byId<HTMLButtonElement>('permissions-prompt-never'),
  // The four global-default rows are containers now, not controls: JS fills each
  // with the same markup the site cards use, so the two can't drift apart.
  sitesGlobal: document.querySelector<HTMLElement>('.sites-global')!,
  maxRes: byId('max-res'),
  maxResLocked: byId('max-res-locked'),
  streamQuality: byId('stream-quality'),
  format: byId('format'),
  formatLocked: byId('format-locked'),
  subs: byId('subs'),
  subsLocked: byId('subs-locked'),
  pasteBtn: byId<HTMLButtonElement>('paste-btn'),
  toTop: byId<HTMLButtonElement>('to-top'),
  sealArchive: byId<HTMLTextAreaElement>('seal-archive'),
  archiveRestore: byId<HTMLButtonElement>('archive-restore'),
  settingsSaveBar: byId('settings-save-bar'),
  settingsSave: byId<HTMLButtonElement>('settings-save'),
  settingsRevert: byId<HTMLButtonElement>('settings-revert'),
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
  welcome: byId('welcome'),
  welcomeServer: byId<HTMLInputElement>('welcome-server'),
  welcomeToken: byId<HTMLInputElement>('welcome-token'),
  welcomeError: byId('welcome-error'),
  welcomeStart: byId<HTMLButtonElement>('welcome-start'),
  welcomePerms: byId('welcome-perms'),
  selectToggle: byId<HTMLButtonElement>('select-toggle'),
  filterBtn: byId<HTMLButtonElement>('filter-btn'),
  filterMenu: byId('filter-menu'),
  queueToggle: byId<HTMLButtonElement>('queue-toggle'),
  queueCancel: byId<HTMLButtonElement>('queue-cancel'),
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
  selMore: byId<HTMLButtonElement>('sel-more'),
  selMenu: byId('sel-menu'),
  confirmBox: byId('confirm'),
  confirmTitle: byId('confirm-title'),
  confirmSub: byId('confirm-sub'),
  confirmClose: byId<HTMLButtonElement>('confirm-close'),
  confirmCancel: byId<HTMLButtonElement>('confirm-cancel'),
  confirmYes: byId<HTMLButtonElement>('confirm-yes'),
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
  langSelect: byId<HTMLSelectElement>('lang-select'),
  themeColorMeta: byId<HTMLMetaElement>('theme-color-meta'),
  serverStatus: byId('server-status'),
  dlStats: byId('dl-stats'),
};

// ---- List state -----------------------------------------------------------
const PAGE_SIZE = 10; // lazy-load 10 at a time so a huge history never over-fetches
const state = {
  q: '' as string,        // search query (status now folds into the query syntax)
  filter: '' as string,   // active status-filter key ('' = everything); see FILTERS
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
  // The last tick per row. `phase`/`eta` ride along not for the fold aggregate but
  // because rowHtml can't reproduce them: they exist only in the statusline spans
  // SSE paints, so a row rebuilt mid-download needs them to repaint itself.
  progress: new Map<number, { percent: number | null; speed: string; eta: string; phase: string; status: string; shown: number }>(),
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

// ---- Storage readout (beside the heartbeat) -------------------------------
// How full the disk is, as a ring + "58% · 1.2 TB". The ring is the donut/radial
// gauge every storage UI converged on (Google Drive, iOS Storage, disk widgets):
// one glance says how full without reading a number, because "most of the circle
// is filled" needs no units, no baseline, and no comparison — which a bare
// "1.2 TB" never gave you. The file COUNT is gone: it told you nothing about
// whether you were about to run out, which is the only question this corner of
// the screen has to answer.
//
// It colours itself as the reserve runs down — amber under 25% free, red under
// the 5% mark where the backend stops starting new downloads (STORAGE_BLOCK_FREE
// in queue.rs) and parks them as paused instead. So the warning arrives well
// before the behaviour changes, and the red state explains a pause that would
// otherwise look like a bug.
//
// Uncapped installs get the size alone: a percentage of "unlimited" is
// meaningless, so no ring is drawn rather than a fake one.
const STORAGE_WARN_FREE = 0.25;
const STORAGE_BLOCK_FREE = 0.05;
// r=9 in a 24-box; the circumference the dash array is measured against.
const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** Donut gauge, `frac` in 0..1 filled. Starts at 12 o'clock and fills clockwise. */
function ringSvg(frac: number): string {
  const filled = Math.max(0, Math.min(1, frac)) * RING_C;
  return `<svg class="dl-ring" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">`
    + `<circle class="dl-ring-track" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="5"/>`
    + `<circle class="dl-ring-fill" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="5"`
    + ` stroke-dasharray="${filled.toFixed(2)} ${RING_C.toFixed(2)}" transform="rotate(-90 12 12)"/>`
    + `</svg>`;
}
// Pause / resume. Sized to sit in a card's action row (18px, like the other
// .act glyphs) and scaled up by CSS where they stand alone in the toolbar.
const PAUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/></svg>`;
const RESUME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.029 4.285A2 2 0 0 0 7 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/><path d="M3 4v16"/></svg>`;
// Retry, on a failed card. Re-queues the same row (POST /api/items/:slug/retry)
// rather than re-submitting the URL, so the item keeps its id, its place in the
// list, and its archive key.
const RETRY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
// Lucide "x": cancel — stop this download and throw its partial away. Deliberately
// NOT a second pause-like glyph; an X is what every browser's download shelf uses
// for the irreversible half of the stop pair.
const CANCEL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
// Vertical kebab (⋮) for the website-card overflow menu.
const MORE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
interface Stats {
  count: number;
  total_bytes: number;
  /** Storage cap in bytes; null on an uncapped install. */
  limit_bytes: number | null;
  limit_locked: boolean;
  /** Server-wide count of paused items — drives the global pause button. */
  paused: number;
}
let dlStatsCache: Stats | null = null;

function renderDlStats(): void {
  const el = els.dlStats;
  if (!el || !dlStatsCache) return;
  const { count, total_bytes, limit_bytes } = dlStatsCache;
  if (count <= 0 && !total_bytes) { el.classList.add('hidden'); return; }
  const size = fmtSize(total_bytes) || '0 B';
  el.classList.remove('warn', 'crit');
  if (limit_bytes && limit_bytes > 0) {
    const used = total_bytes / limit_bytes;
    const free = 1 - used;
    // Round toward "fuller": 99.6% must not render as a reassuring 100%-free-ish
    // number, and anything non-zero must not read as 0%.
    const pct = Math.min(100, Math.ceil(used * 100));
    if (free <= STORAGE_BLOCK_FREE) el.classList.add('crit');
    else if (free <= STORAGE_WARN_FREE) el.classList.add('warn');
    const text = `${pct}% · ${size}`;
    el.innerHTML = `${ringSvg(used)}<span class="dl-stats-text">${esc(text)}</span>`;
    el.setAttribute('title', t('stats.usage', { pct: String(pct), used: size, total: fmtSize(limit_bytes) }));
  } else {
    // Uncapped: no percentage to show, so no ring — just what's stored.
    el.innerHTML = `<span class="dl-stats-text">${esc(size)}</span>`;
    el.setAttribute('title', t('stats.stored', { used: size }));
  }
  el.classList.remove('hidden');
}

async function loadStats(): Promise<void> {
  if (!getToken()) return;
  try {
    const res = await apiFetch('/api/stats');
    if (!res.ok) return;
    dlStatsCache = await res.json() as Stats;
    renderDlStats();
    // Same payload carries the server-wide paused count, so the global
    // pause/resume button re-renders from the same fetch rather than its own.
    renderQueueToggle();
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
  return `<span class="chip" title="External link accesses">${EYE_SVG}<span class="hits-n">${n}</span></span>`;
}

// A file-size capsule at the LEFT of a card's action row (e.g. "20.4 MB").
// Shows the COMBINED size of every downloaded resolution version (total_filesize),
// so a multi-resolution item reflects its full on-disk footprint. Falls back to
// the primary filesize. Vanishes when the size is unknown. Resolution lives in
// its own button to the right of this chip (see resButtonHtml).
function metaChipsHtml(item: Item): string {
  // No local file (stream-only "None" mode, or a copy backed away to the cloud)
  // → no on-disk footprint to report, so the size chip vanishes entirely.
  if (!item.local_available) return '';
  return metaChip('', fmtSize(item.total_filesize || item.filesize));
}

// Build a meta capsule from the (possibly empty) resolution | size parts.
function metaChip(res: string, size: string): string {
  const parts = [res, size].filter(Boolean);
  if (!parts.length) return '';
  return `<span class="chip">${esc(parts.join(' | '))}</span>`;
}

// Stacked "layers" glyph — the industry-standard affordance for "multiple
// versions / quality options" (à la a video player's quality selector).
const LAYERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>`;

// Resolution button: sits between the size chip and the delete icon. Shows the
// item's current resolution and, on tap, opens the multi-select to add/remove
// resolution versions. Only for completed video items (a known height).
function resButtonHtml(item: Item): string {
  // Canceled is here alongside completed because cancelling is not the end of an
  // item's life — it's the point you most want to change your mind about which
  // quality to fetch, and the picker is the only place that choice exists. Its
  // partial is gone, so there is no downloaded set to contradict a new pick.
  if (item.status !== 'completed' && item.status !== 'canceled') return '';
  // Label logic: a known height → its label (e.g. "1080p"); a stream-only item
  // (no local file) → "None"; a downloaded file of unknown height (older/audio
  // records) → icon only, so we never mislabel a present file as "None".
  let label = '';
  if (item.height && item.height > 0) label = resLabel(item.height);
  else if (!item.local_available) label = t('res.noneLabel');
  const labelSpan = label ? `<span class="res-btn-label">${esc(label)}</span>` : '';
  return `<button class="chip chip-btn" data-act="resolutions" data-id="${item.id}" aria-label="${esc(t('res.pick'))}" title="${esc(t('res.pick'))}">${LAYERS_SVG}${labelSpan}</button>`;
}

// The live counterpart of the size + resolution capsules: while a download is in
// flight neither of those can answer anything. There is no file yet, so its size
// is unknown (the total only settles when the last byte lands) and `height` is
// still null — so the row would otherwise sit empty for exactly the stretch the
// user is watching it. Instead the same capsule slot reports the transfer itself:
// the app's one spinner, plus the quality being fetched (target_height, written by
// the backend when the job starts) in the running blue the badge and phase already
// use. Falls back to the spinner alone when the target isn't known yet (audio-only
// sources, a row queued before the job picked its height).
function dlChipHtml(item: Item): string {
  const label = item.target_height && item.target_height > 0
    ? `<span class="dl-res">${esc(resLabel(item.target_height))}</span>`
    : '';
  return `<span class="chip chip-dl" title="${esc(t('item.downloading'))}"><span class="chip-spin" aria-hidden="true">${SPINNER_SVG}</span>${label}</span>`;
}

function actionsHtml(item: Item): string {
  // Delete is global: every card gets a trash icon (leftmost button, i.e. left
  // of the Save button — but right of the size chip + resolution button) so any
  // item — queued, running, failed or completed — can be removed. It always
  // routes through the confirm dialog (openDeleteConfirm).
  const del = `<button class="act act-del" data-act="delete" data-id="${item.id}" aria-label="${esc(t('aria.delete'))}" title="${esc(t('aria.delete'))}">${TRASH_SVG}</button>`;
  // A download in flight gets the whole row to itself: the live chip, then the
  // three ways to stop it, in escalating order of how much they throw away —
  // delete (record and all), cancel (the transfer and its partial), pause (only
  // the waiting). They occupy the same three slots a finished card gives to
  // delete / save / share, so the button under your thumb doesn't move as an item
  // completes. Save and share are absent for the reason they'd be useless: there
  // is no file to hand over yet.
  if (item.status === 'queued' || item.status === 'running') {
    const cancel = `<button class="act act-cancel" data-act="cancel" data-id="${item.id}" aria-label="${esc(t('item.cancel'))}" title="${esc(t('item.cancel'))}">${CANCEL_SVG}</button>`;
    const pause = `<button class="act" data-act="pause" data-id="${item.id}" aria-label="${esc(t('item.pause'))}" title="${esc(t('item.pause'))}">${PAUSE_SVG}</button>`;
    return `<div class="actions">${dlChipHtml(item)}${del}${cancel}${pause}</div>`;
  }
  // Pause / resume, only while there's a transfer to hold or release. A paused
  // item keeps its partial file, so resuming continues rather than restarts.
  let hold = '';
  if (item.status === 'paused') {
    hold = `<button class="act act-resume" data-act="resume" data-id="${item.id}" aria-label="${esc(t('item.resume'))}" title="${esc(t('item.resume'))}">${RESUME_SVG}</button>`;
  } else if (item.status === 'failed' || item.status === 'canceled') {
    // A failure is usually transient (a dropped connection, a site hiccup) or has
    // just been fixed by the user (cookies added), so the fix is one tap from the
    // card that reported it rather than a re-paste of the URL. A canceled item
    // offers the same button for a different reason: cancelling threw the partial
    // away, so starting over is the only route back — there is nothing to resume.
    hold = `<button class="act act-retry" data-act="retry" data-id="${item.id}" aria-label="${esc(t('item.retry'))}" title="${esc(t('item.retry'))}">${RETRY_SVG}</button>`;
  }
  // Save / share only make sense for a completed item with a file. Local file
  // present: Save (download icon) + Share icon. Local file gone (backed away or
  // never fetched): there is nothing to hand over, so the slot offers the way
  // back to a download instead — the same retry a canceled item gets, for the
  // same reason (no partial to resume, no file to keep). It replaces the old
  // "Cloud only" pill, which stated the situation but gave no way out of it.
  let mediaActions = '';
  if (item.status === 'completed') {
    const local = !!item.local_available;
    const pub = !!item.public;
    mediaActions = local
      ? `<a class="act act-save" href="${fileUrl(item, true)}" download data-id="${item.id}" aria-label="${esc(t('aria.save'))}" title="${esc(t('aria.save'))}">${DOWNLOAD_SVG}</a>
      <button class="act act-share ${pub ? 'act-on' : ''}" data-act="share" data-id="${item.id}" aria-label="${esc(t('aria.share'))}" title="${esc(t('aria.share'))}">${SHARE_SVG}</button>`
      : `<button class="act act-retry" data-act="retry" data-id="${item.id}" aria-label="${esc(t('item.download'))}" title="${esc(t('item.download'))}">${RETRY_SVG}</button>`;
  }
  // Order: size chip · resolution button · pause/resume · delete · save/share.
  return `<div class="actions">${metaChipsHtml(item)}${resButtonHtml(item)}${hold}${del}${mediaActions}</div>`;
}

// Play affordance shown on a finished thumbnail (bottom-right). Tapping the
// thumbnail opens the in-app fullscreen player (see openPlayer).
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>`;
const PLAY_BADGE = `<span class="play-badge" aria-hidden="true">${PLAY_ICON}</span>`;
// The app's one spinner: lucide's loader-circle, turned by the shared `spin`
// keyframes in style.css. Every "working on it" indicator reuses this — the
// thumbnail's pending mask and the submit button — so there is a single shape and
// a single animation to keep consistent rather than a second one that drifts.
const SPINNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
const MEDIA_LOADER = `<span class="media-loader" aria-hidden="true">${SPINNER_SVG}</span>`;

function isMediaPending(item: Item, status = item.status): boolean {
  // Resolution jobs emit running events for an already-completed item. Its old
  // file remains valid, so only the first download receives the pending mask.
  return item.status !== 'completed' && (status === 'queued' || status === 'running');
}

// A completed item with a file is playable in-app (local file or cloud fallback).
function isPlayable(item: Item): boolean {
  // Any completed item is playable: with a local file it plays that; without one
  // (stream-only "None" mode, or a copy backed away) it streams from source via
  // /stream-url.
  //
  // Paused too, and for the same reason: playback falls back to the source proxy,
  // which never needed a local copy (see ensure_streamable in api/media.rs). A
  // download the storage cap parked is exactly the item you still want to watch —
  // withholding the play button would make "recorded and still playable" a lie.
  // Queued/running/failed stay unplayable: a file is coming, or nothing is.
  return item.status === 'completed' || item.status === 'paused';
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
// everything else keeps the link out to the source page. Overlays: duration
// (bottom-left), play (bottom-right). The source is now shown as a logo before
// the title (see rowHtml), not on the thumbnail.
function thumbHtml(item: Item, thumb: string, dur: string): string {
  const pending = isMediaPending(item) ? ' media-pending' : '';
  const overlays = `${thumb}${dur}${MEDIA_LOADER}`;
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
  // Clips under a minute are tagged so CSS can drop the pill on portrait thumbs,
  // where it would crowd the play button and where "0:20" on a Reel is just
  // noise. Landscape keeps every duration (see .dur in style.css).
  const durShort = item.duration && item.duration < 60 ? ' dur-short' : '';
  const dur = item.duration ? `<span class="dur${durShort}">${esc(fmtDuration(item.duration))}</span>` : '';
  const logo = sourceLogoHtml(item.extractor);
  const uploader = item.uploader ? `<div class="uploader">${esc(item.uploader)}</div>` : '';
  const active = item.status === 'queued' || item.status === 'running';
  const bar = `<div class="progress ${active ? '' : 'hidden'}"><div class="progress-fill" style="width:0%"></div></div>`;
  // A failure is reported by the badge and the retry button, NOT by its text: a
  // yt-dlp error is a multi-line stderr tail, and pasting it into the card blew
  // the row open to a screenful of monospace while still being too clipped to
  // read. The whole message lives in Settings → Logs, which is built to show it.
  // Multi-select needs no in-card checkbox: the card itself highlights when
  // selected (see .item.selected in style.css), so nothing is injected here that
  // would compete with the thumbnail for horizontal space.
  return `
    ${thumbHtml(item, thumb, dur)}
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
    // The fresh markup ships the statusline's live spans empty, so anything the
    // SSE tick had painted there is gone. Put it back from the last tick.
    restoreLiveFields(li, item.id);
  }
  if (item.status === 'completed' && !item.local_available && item.public_slug) {
    const play = li.querySelector<HTMLElement>('.thumb-play');
    if (play) {
      play.dataset.slug = item.public_slug;
      streamPrewarmObserver.observe(play);
    }
  }
  li.classList.toggle('blurred', isItemBlurred(item));
  // Ask the device whether it already holds this item's file (Android only, and
  // batched — see queueLocalScan), then paint what we already know so a row
  // re-rendered from cache keeps its green Save icon.
  queueLocalScan(item);
  paintLocalMark(item);
  if (gkey) updateGroupHeader(gkey);
  // This is the only place item statuses enter state.items, so it's where the
  // global pause/resume button learns there's now something running to pause.
  // (Whether anything is PAUSED comes from the server — see renderQueueToggle.)
  renderQueueToggle();
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
    ? `<button class="act" data-act="dl-list" aria-label="${esc(t('group.downloadAll'))}" title="${esc(t('group.downloadAll'))}">${DOWNLOAD_SVG}</button>
        <button class="act" data-act="share-list" aria-label="${esc(t('group.shareAll'))}" title="${esc(t('group.shareAll'))}">${SHARE_SVG}</button>`
    : '';
  // Aggregate size of the whole post, shown left of the list actions (mirrors
  // the per-video size chip). Dropped when no child has a known size yet.
  const totalBytes = items.reduce((sum, it) => sum + (it.total_filesize || it.filesize || 0), 0);
  const sizeChip = metaChip('', fmtSize(totalBytes));
  const listActions = `<div class="actions group-actions">
        ${sizeChip}
        <button class="act act-del" data-act="del-list" aria-label="${esc(t('aria.delete'))}" title="${esc(t('aria.delete'))}">${TRASH_SVG}</button>
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

// Rows whose target_height has already been asked for after a job start, so the
// ask happens once per job rather than once per start tick. Cleared when the job
// reaches a terminal state: a retry is a new job that may pick a new height.
const chipRefetched = new Set<number>();

// Paint the statusline's live spans: which pass is running (Video / Audio), the
// speed and the ETA. Nothing here can be derived from the Item — these values
// exist only in the SSE tick — so rowHtml ships the spans empty and this is the
// only thing that ever fills them. Called from the tick, and again whenever a row
// is rebuilt, which would otherwise drop the labels on the floor.
function paintLiveFields(li: HTMLElement, phase: string, speed: string, eta: string): void {
  const phaseEl = li.querySelector('.phase');
  if (phaseEl) {
    // Label the video/audio pass so the per-pass 0→100% reset reads as a new
    // stage rather than the bar "jumping" backwards.
    phaseEl.textContent = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : '';
    phaseEl.className = 'phase' + (phase ? ' phase-' + phase : '');
  }
  const speedEl = li.querySelector('.speed');
  if (speedEl) speedEl.textContent = speed;
  const etaEl = li.querySelector('.eta');
  if (etaEl) etaEl.textContent = eta ? 'ETA ' + eta : '';
}

// Restore the live spans (and the bar) onto a row that was just rebuilt from an
// Item, using the last tick we saw. Without this a rebuild mid-download blanks
// the Video/Audio label until the next tick repaints it — and an audio-only job
// rebuilds on *every* tick (its target_height is never set, so the chip refetch
// below never settles), which is why the Audio label went missing entirely while
// Video, refetching once, only flickered.
function restoreLiveFields(li: HTMLLIElement, id: number): void {
  const p = state.progress.get(id);
  if (!p || TERMINAL[p.status]) return;
  paintLiveFields(li, p.phase, p.speed, p.eta);
  const bar = li.querySelector('.progress');
  const fill = li.querySelector('.progress-fill') as HTMLElement | null;
  if (bar && fill) {
    bar.classList.remove('hidden');
    fill.style.width = p.shown + '%';
  }
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
  // Record the latest tick so a playlist fold can aggregate progress + speed —
  // and so a rebuilt row can restore the live spans (see paintLiveFields).
  state.progress.set(ev.id, {
    percent: ev.percent ?? null, speed: ev.speed || '', eta: ev.eta || '',
    phase: ev.phase || '', status: ev.status, shown,
  });
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
  paintLiveFields(li, ev.phase || '', ev.speed || '', ev.eta || '');
  const bar = li.querySelector('.progress');
  const fill = li.querySelector('.progress-fill') as HTMLElement | null;
  const terminal = !!TERMINAL[ev.status];
  if (terminal) {
    if (bar) bar.classList.add('hidden');
    paintLiveFields(li, '', '', '');
    chipRefetched.delete(ev.id); // a retry starts a new job, which may pick a new height
    // A just-completed item gains a file: refetch to render play/save/share.
    // Flash the green Completed badge for 30s (markFreshCompleted) — this is a
    // fresh success, unlike the old completed rows whose badge stays hidden.
    if (ev.status === 'completed') {
      markFreshCompleted(ev.id);
      badge?.classList.add('flash');
      apiFetch(itemPath(ev.id))
        .then((r) => (r.ok ? r.json() : null))
        .then((it) => {
          if (!it) return;
          upsertRow(it, false);
          // The server now holds the taller file this item was upgraded for —
          // pull it down to replace the local copy (see pendingLocalUpgrade).
          runPendingLocalUpgrade(it);
        })
        .catch(() => { /* ignore */ });
      loadStats(); // a fresh file changes the total-downloaded readout
    }
  } else if (bar && fill) {
    bar.classList.remove('hidden');
    fill.style.width = shown + '%';
    // The tick that STARTS a job (Running with no percent yet) is the moment the
    // backend has just decided — and written — which resolution this download is
    // going for. The row in hand predates that decision, so its live chip would
    // spin without a quality beside it until the next poll happened along, up to
    // 30s later. Refetch once, here, so the chip is complete from the first tick.
    //
    // Guarded on having ASKED, not on the answer: an audio-only job has no height
    // to record, so `target_height` stays null however many times we look. Keying
    // the guard off the answer made every start tick refetch and rebuild the row
    // forever — which is what kept wiping the Audio label out of the statusline.
    if (ev.status === 'running' && ev.percent == null && !persisted?.target_height
        && !chipRefetched.has(ev.id)) {
      chipRefetched.add(ev.id);
      apiFetch(itemPath(ev.id))
        .then((r) => (r.ok ? r.json() : null))
        .then((it) => { if (it) upsertRow(it, false); })
        .catch(() => { /* the poll will catch up */ });
    }
  }
  // Roll this tick up into the fold header (total progress + live speed).
  const it = state.items.get(ev.id);
  const gk = it ? groupKeyOf(it) : null;
  if (gk) updateGroupProgress(gk);
}

// ---- Status filter --------------------------------------------------------
// The funnel's options. Each is a server-side narrowing, never a client-side
// sieve: `status` and `local` both become query params that the SQL applies, so
// a filtered view costs one page of exactly the rows asked for. The alternative
// — pulling history and testing each row here — would page the whole library to
// show ten rows, and would break keyset pagination while doing it.
//
// "Downloaded" and "Cloud only" split the completed rows by whether a file
// actually landed, which is the distinction the cards themselves draw (Save +
// Share vs a Download button), so it's the one worth filtering on.
const FILTERS: Array<{ key: string; label: string; status?: string; local?: boolean }> = [
  { key: '', label: 'filter.all' },
  { key: 'downloaded', label: 'filter.downloaded', status: 'completed', local: true },
  { key: 'cloud', label: 'filter.cloud', status: 'completed', local: false },
  { key: 'running', label: 'status.running', status: 'running' },
  { key: 'queued', label: 'status.queued', status: 'queued' },
  { key: 'paused', label: 'status.paused', status: 'paused' },
  { key: 'canceled', label: 'status.canceled', status: 'canceled' },
  { key: 'failed', label: 'status.failed', status: 'failed' },
];

function activeFilter(): { status?: string; local?: boolean } | null {
  return FILTERS.find((f) => f.key === state.filter && f.key !== '') || null;
}

// Stamp the active filter onto an /api/items query. The single place that knows
// how a filter becomes params, so the first page, the infinite scroll and the
// 30s poll can't drift apart on what they're asking for.
function applyFilterParams(params: URLSearchParams): void {
  const f = activeFilter();
  if (!f) return;
  if (f.status) params.set('status', f.status);
  if (f.local != null) params.set('local', String(f.local));
}

function renderFilterMenu(): void {
  els.filterMenu.textContent = '';
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.className = 'site-menu-item' + (state.filter === f.key ? ' filter-on' : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = t(f.label);
    b.addEventListener('click', () => {
      closeFilterMenu();
      if (state.filter === f.key) return; // already showing this — don't refetch
      state.filter = f.key;
      renderFilterMenu();
      // The funnel fills in as the at-a-glance "you are not seeing everything".
      els.filterBtn.classList.toggle('active', !!state.filter);
      loadItems(true);
    });
    els.filterMenu.appendChild(b);
  }
}

function closeFilterMenu(): void {
  els.filterMenu.classList.add('hidden');
  els.filterBtn.setAttribute('aria-expanded', 'false');
}

els.filterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.filterMenu.classList.toggle('hidden');
  els.filterBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
});
document.addEventListener('click', (e) => {
  if (!els.filterMenu.classList.contains('hidden')
      && !(e.target as HTMLElement).closest('#filter-btn, #filter-menu')) closeFilterMenu();
});

// ---- First-paint cache ----------------------------------------------------
// A reload used to cost a blank list plus a full round trip before the first card
// existed, and then built every row from scratch. This is the stale-while-
// revalidate pattern (the same idea as HTTP's Cache-Control: stale-while-
// revalidate, and what SWR/React Query do): keep the last page we rendered, paint
// it on the next boot without waiting for the network, then reconcile it against
// the server in the background.
//
// The saving is real because upsertRow already diffs: the revalidate feeds every
// row back through the signature guard, so rows that didn't change touch no DOM
// and re-request no thumbnails. A refresh therefore rebuilds only what actually
// moved, instead of all of it.
//
// Only the default view is cached. A filtered or searched list is a question the
// user asked, not the one they'd expect to return to on a fresh load.
const CACHE_KEY = 'orca_items_cache';
const CACHE_VER = 1;

function isDefaultView(): boolean {
  return !state.q && !state.filter;
}

function cacheFirstPage(items: Item[]): void {
  if (!isDefaultView()) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      v: CACHE_VER, base: apiBase(), items: items.slice(0, PAGE_SIZE),
    }));
  } catch (_) {
    // Quota or private mode. The cache is an optimisation with a working
    // fallback (the network), so a failure to store is not worth reporting.
  }
}

/**
 * Paint the cached page synchronously, before any fetch. Returns whether it
 * painted, which is what tells boot to reconcile (softRefresh) rather than cold-
 * load — the difference between updating the list and rebuilding it.
 */
function hydrateFromCache(): boolean {
  if (!getToken()) return false;
  let snap: { v?: number; base?: string; items?: Item[] } | null = null;
  try {
    snap = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch (_) { return false; }
  // Pinned to the server it came from, and to this build's shape: pointing the
  // app at a different host must never flash the previous host's library, and a
  // stale shape is not worth a migration path when the network refills it in a
  // second anyway.
  if (!snap || snap.v !== CACHE_VER || snap.base !== apiBase()) return false;
  const items = snap.items || [];
  if (!items.length) return false;
  // Oldest→newest so the newest ends up on top, matching softRefresh.
  for (let i = items.length - 1; i >= 0; i--) upsertRow(items[i]!, true);
  return true;
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
  const firstPage = state.cursor == null; // scroll-loaded pages must not overwrite the cache
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  applyFilterParams(params);
  params.set('limit', String(PAGE_SIZE));
  if (state.cursor != null) params.set('before_id', String(state.cursor));
  try {
    const res = await apiFetch('/api/items?' + params.toString());
    if (!res.ok) { toast(t('toast.loadHistoryFail'), 'error'); return; }
    const data = await res.json();
    if (firstPage) cacheFirstPage(data.items || []);
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

// Backstop for a page too short to scroll: if the spinner is already on screen
// after a load, no intersection event will ever fire, so keep filling until it
// falls below the fold. Matches the observer's threshold exactly (visible = load)
// — when this was the more eager of the two, it kept pulling pages the observer
// wouldn't have asked for.
function topUpIfNeeded(): void {
  if (state.loading || state.cursor == null || els.loader.classList.contains('hidden')) return;
  const r = els.loader.getBoundingClientRect();
  if (r.top < window.innerHeight) loadItems(false);
}

// ---- Submit ---------------------------------------------------------------
// ---- Pasted-link parsing --------------------------------------------------
// Mirrors src/url_normalize.rs (itself ported from the old Flutter client's
// UrlUtils), so a pasted blob folds and dedupes here the same way the backend
// would. The backend still re-normalizes authoritatively on submit — doing it
// client-side is what lets the paste button drop tracking params on sight and
// report an honest "2 links, 1 duplicate removed".

// A link runs to the first whitespace/quote/bracket, including the CJK
// full-width closers that commonly hug a pasted URL.
const LINK_RE = /https?:\/\/[^\s'"<>。！？、）」］)\]]+/gi;

const TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'ref_src', 'ref_url', 'source', 'feature', 'spm_id_from',
]);

// Everything but the known tracking params; the `?` goes away when nothing
// meaningful survives.
function stripTracking(u: URL): string {
  const kept = new URLSearchParams();
  u.searchParams.forEach((v, k) => { if (!TRACKING.has(k)) kept.append(k, v); });
  const base = `${u.protocol}//${u.hostname}${u.pathname}`;
  const q = kept.toString();
  return q ? `${base}?${q}` : base;
}

function normalizeLink(raw: string): string {
  // Trailing punctuation clings to links pasted out of prose.
  const trimmed = raw.trim().replace(/[.,;!\])]+$/, '');
  let u: URL;
  try { u = new URL(trimmed); } catch (_) { return trimmed; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return trimmed;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    if (host.includes('youtu.be') && segs[0]) return `https://www.youtube.com/watch?v=${segs[0]}`;
    for (const marker of ['shorts', 'embed']) {
      const i = segs.indexOf(marker);
      if (i >= 0 && segs[i + 1]) return `https://www.youtube.com/watch?v=${segs[i + 1]}`;
    }
    const v = u.searchParams.get('v');
    // Discard a stray `?si=` glued onto the id.
    if (v) return `https://www.youtube.com/watch?v=${v.split('?')[0]}`;
    return stripTracking(u);
  }
  if (host.includes('twitter.com') || host.includes('x.com')) {
    const i = segs.indexOf('status');
    if (i >= 0 && segs[i + 1]) return `https://twitter.com/i/status/${segs[i + 1]}`;
    return `https://twitter.com${u.pathname}`;
  }
  if (host.includes('bilibili.com')) {
    const bv = segs.find((s) => s.startsWith('BV'));
    return bv ? `https://www.bilibili.com/video/${bv}` : `https://www.bilibili.com${u.pathname}`;
  }
  if (host.includes('tiktok.com') || host.includes('xiaohongshu.com')) {
    return `${u.protocol}//${host}${u.pathname}`;
  }
  return stripTracking(u);
}

// Every link in a blob of text, normalized and deduped (first occurrence wins).
function parseLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.match(LINK_RE) || []) {
    const n = normalizeLink(m);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Submit every link in the box, one at a time. Sequential rather than parallel:
// the backend paces downloads politely, and a burst of concurrent probes is
// exactly the batch-downloader signature the queue works to avoid.
async function submitInput(): Promise<void> {
  const raw = els.url.value.trim();
  if (!raw) return;
  const links = parseLinks(raw);
  // A lone unparseable string still goes to the backend, which surfaces the real
  // error — silently dropping it would be worse than a clear "probe failed".
  for (const link of (links.length ? links : [raw])) await submitUrl(link);
}

// Submit-button working state: the download glyph swaps to the shared spinner
// (SPINNER_SVG) while a submit is in flight, so a probe that takes a few seconds
// reads as "working" rather than as a dead button. Counted rather than a boolean
// because a pasted blob submits its links one after another — a plain flag would
// blink the spinner off and back on between each one.
const SUBMIT_ICON = els.submitBtn.innerHTML;
let submitsInFlight = 0;
function setSubmitBusy(busy: boolean): void {
  submitsInFlight = Math.max(0, submitsInFlight + (busy ? 1 : -1));
  const on = submitsInFlight > 0;
  els.submitBtn.disabled = on;
  els.submitBtn.classList.toggle('busy', on);
  els.submitBtn.innerHTML = on ? SPINNER_SVG : SUBMIT_ICON;
}

async function submitUrl(url: string): Promise<void> {
  if (!url) return;
  if (!getToken()) { showTokenField(false); toast(t('toast.setToken'), 'error'); return; }
  setSubmitBusy(true);
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
    setSubmitBusy(false);
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
  /// Per-site download heights as CSV; null = follow the global default, ''
  /// = the empty set (stream-only, download nothing).
  max_heights: string | null;
  /// Per-site share-bandwidth cap; null = follow the global default.
  stream_quality: string | null;
  /// Per-site container; null = follow the global default.
  container: string | null;
  /// Per-site subtitle capture; null = follow the global default.
  subs: boolean | null;
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

// The maximum-resolution ladder, mirroring the backend's HEIGHT_LADDER. `0` is
// the "highest available" sentinel — a distinct intent from any concrete height,
// so it is an option rather than an absence of one.
const RES_LADDER = [0, 4320, 2160, 1440, 1080, 720, 480, 360];

// ---- Multi-select ----------------------------------------------------------
// Resolution is a *set*: picking {1080, 480} downloads both copies. A native
// <select multiple> renders as an always-open scrolling listbox that would dwarf
// every other row, and a chip row for 8 options wraps to three lines — so this is
// the pattern the rest of the industry converged on (Linear/GitHub/Notion): a
// trigger that looks exactly like the neighbouring <select>, summarising the
// selection on ONE line, opening a checkable popover on click.
//
// Emits a bubbling `multiselect-change` CarrierEvent so the global row and the
// site cards share this one implementation and only differ in what they persist.
interface MultiSelectOpts {
  act: string;               // routing key, read back off the element
  heights: number[] | null;  // null = follow global (per-site only)
  followable: boolean;       // cards offer "Follow global"; the global itself can't
  ariaLabel: string;
  disabled?: boolean;
}

/** Short label for the trigger — long enough to identify, short enough to fit. */
function heightLabel(h: number): string {
  return h > 0 ? resLabel(h) || h + 'p' : t('res.highestShort');
}

/** Full label for the menu, where there's room to be unambiguous. */
function heightOptLabel(h: number): string {
  return h > 0 ? `${resLabel(h) || h + 'p'}${h >= 1440 ? ` (${h}p)` : ''}` : t('res.highest');
}

/**
 * One-line summary of the selection. Never lists more than the tallest pick: the
 * point of the control is to be readable at a glance, and "1080p +2" answers
 * "what will this download" without the reader parsing a list.
 */
function multiSelectSummary(heights: number[] | null): string {
  if (heights === null) return t('sites.followGlobal');
  const [tallest, ...rest] = heights;
  if (tallest === undefined) return t('res.noneLabel');
  return rest.length ? `${heightLabel(tallest)} +${rest.length}` : heightLabel(tallest);
}

function multiSelectHtml(o: MultiSelectOpts): string {
  const sel = o.heights;
  const follow = sel === null;
  const opt = (value: string, label: string, on: boolean): string =>
    `<button type="button" class="multiselect-opt" role="option" data-value="${value}" aria-selected="${on}">${esc(label)}</button>`;
  const opts: string[] = [];
  if (o.followable) {
    opts.push(opt('global', t('sites.followGlobal'), follow));
    opts.push('<div class="multiselect-sep" role="separator"></div>');
  }
  for (const h of RES_LADDER) {
    opts.push(opt(String(h), heightOptLabel(h), !follow && sel.includes(h)));
  }
  return `<div class="multiselect" data-act="${o.act}">
    <button type="button" class="select site-res-select multiselect-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(o.ariaLabel)}"${o.disabled ? ' disabled' : ''}>
      <span class="multiselect-value">${esc(multiSelectSummary(sel))}</span>
    </button>
    <div class="multiselect-menu hidden" role="listbox" aria-multiselectable="true">${opts.join('')}</div>
  </div>`;
}

/** Read the current selection back out of the DOM. `null` = follow global. */
function multiSelectValue(root: HTMLElement): number[] | null {
  const opts = Array.from(root.querySelectorAll<HTMLElement>('.multiselect-opt'));
  const followOn = opts.some((o) => o.dataset.value === 'global' && o.getAttribute('aria-selected') === 'true');
  if (followOn) return null;
  return opts
    .filter((o) => o.dataset.value !== 'global' && o.getAttribute('aria-selected') === 'true')
    .map((o) => Number(o.dataset.value))
    // Descending, but HIGHEST (0) first — mirrors the backend's ordering so the
    // summary names the same "tallest" the server will treat as primary.
    .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : b - a));
}

function closeMultiSelects(except?: Element): void {
  document.querySelectorAll<HTMLElement>('.multiselect').forEach((m) => {
    if (m === except) return;
    m.querySelector('.multiselect-menu')?.classList.add('hidden');
    m.querySelector('.multiselect-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

/** Repaint a multi-select in place (after a save echo or a failed write). */
function setMultiSelect(root: HTMLElement, heights: number[] | null): void {
  const follow = heights === null;
  root.querySelectorAll<HTMLElement>('.multiselect-opt').forEach((o) => {
    const v = o.dataset.value;
    const on = v === 'global' ? follow : !follow && heights.includes(Number(v));
    o.setAttribute('aria-selected', String(on));
  });
  const value = root.querySelector('.multiselect-value');
  if (value) value.textContent = multiSelectSummary(heights);
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const root = target.closest('.multiselect') as HTMLElement | null;
  if (!root) { closeMultiSelects(); return; }

  const trigger = target.closest('.multiselect-trigger') as HTMLButtonElement | null;
  if (trigger) {
    if (trigger.disabled) return;
    const menu = root.querySelector('.multiselect-menu') as HTMLElement;
    const open = menu.classList.contains('hidden');
    closeMultiSelects(root);
    menu.classList.toggle('hidden', !open);
    trigger.setAttribute('aria-expanded', String(open));
    return;
  }

  const opt = target.closest('.multiselect-opt') as HTMLElement | null;
  if (!opt) return;
  // "Follow global" is a mode, not a member: choosing it clears the set, and
  // choosing any height leaves it. The menu stays open on a height so several can
  // be picked in one visit — closing after each would make picking three
  // resolutions a three-trip errand.
  if (opt.dataset.value === 'global') {
    setMultiSelect(root, null);
    closeMultiSelects();
  } else {
    const current = multiSelectValue(root) ?? [];
    const h = Number(opt.dataset.value);
    const next = current.includes(h) ? current.filter((x) => x !== h) : current.concat(h);
    setMultiSelect(root, next.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : b - a)));
  }
  root.dispatchEvent(new CustomEvent('multiselect-change', {
    bubbles: true,
    detail: { act: root.dataset.act, heights: multiSelectValue(root) },
  }));
});

// Escape closes the open popover before the modal's own Escape handler would
// close the whole sheet — dismissing a menu should not also discard the screen.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.multiselect .multiselect-menu:not(.hidden)');
  if (!open) return;
  e.stopPropagation();
  closeMultiSelects();
});

function siteResSelectHtml(w: Website): string {
  return multiSelectHtml({
    act: 'res',
    heights: w.max_heights === null || w.max_heights === undefined
      ? null
      : parseHeights(w.max_heights),
    followable: true,
    ariaLabel: t('sites.maxRes'),
  });
}

/** CSV → heights, mirroring the backend's HeightSet::parse leniency. */
function parseHeights(csv: string): number[] {
  return csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && RES_LADDER.includes(n));
}

// The share-bandwidth tiers, mirroring the backend's STREAM_QUALITIES. Named in
// tiers rather than pixel heights because it's a policy applied across sources
// whose ladders differ.
const STREAM_QUALITIES: Array<[string, string]> = [
  ['lowest', 'stream.lowest'], ['lower', 'stream.lower'],
  ['higher', 'stream.higher'], ['highest', 'stream.highest'],
];

function siteStreamSelectHtml(w: Website): string {
  const active = w.stream_quality || '';
  const opt = (val: string, label: string): string =>
    `<option value="${val}"${active === val ? ' selected' : ''}>${esc(label)}</option>`;
  const opts = [opt('', t('sites.followGlobal'))]
    .concat(STREAM_QUALITIES.map(([val, key]) => opt(val, t(key))));
  return `<select class="select site-res-select" data-act="stream" aria-label="${esc(t('settings.streamQuality'))}">${opts.join('')}</select>`;
}

// The containers offered per site, mirroring the global picker's list (and the
// backend's `CONTAINERS`). Labels are the conventional uppercase spellings.
const SITE_FORMATS: Array<[string, string]> = [
  ['mkv', 'MKV'], ['mp4', 'MP4'], ['webm', 'WebM'],
  ['mov', 'MOV'], ['avi', 'AVI'], ['flv', 'FLV'],
];

function siteFormatSelectHtml(w: Website): string {
  // '' (empty) is the "follow global" sentinel the backend uses to clear the
  // per-site container.
  const active = w.container || '';
  const opt = (val: string, label: string): string =>
    `<option value="${val}"${active === val ? ' selected' : ''}>${esc(label)}</option>`;
  const opts = [opt('', t('sites.followGlobal'))]
    .concat(SITE_FORMATS.map(([val, label]) => opt(val, label)));
  return `<select class="select site-res-select" data-act="fmt" aria-label="${esc(t('sites.format'))}">${opts.join('')}</select>`;
}

function siteSubsSelectHtml(w: Website): string {
  // Three states — follow global / force on / force off — so this is a <select>
  // rather than the two-state pill switch used elsewhere on the card.
  const active = w.subs === null || w.subs === undefined ? 'global' : (w.subs ? 'on' : 'off');
  const opt = (val: string, label: string): string =>
    `<option value="${val}"${active === val ? ' selected' : ''}>${esc(label)}</option>`;
  const opts = [
    opt('global', t('sites.subsGlobal')),
    opt('on', t('sites.subsOn')),
    opt('off', t('sites.subsOff')),
  ];
  return `<select class="select site-res-select" data-act="subs" aria-label="${esc(t('sites.subs'))}">${opts.join('')}</select>`;
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
      <div class="form-row">
        <span class="form-row-label">${esc(t('sites.maxRes'))}</span>
        <div class="form-row-ctl">${siteResSelectHtml(w)}</div>
      </div>
      <div class="form-row">
        <span class="form-row-label">${esc(t('settings.streamQuality'))}</span>
        <div class="form-row-ctl">${siteStreamSelectHtml(w)}</div>
      </div>
      <div class="form-row">
        <span class="form-row-label">${esc(t('sites.format'))}</span>
        <div class="form-row-ctl">${siteFormatSelectHtml(w)}</div>
      </div>
      <div class="form-row">
        <span class="form-row-label">${esc(t('sites.subs'))}</span>
        <div class="form-row-ctl">${siteSubsSelectHtml(w)}</div>
      </div>
      <div class="form-row">
        <span class="form-row-label">
          <span class="ck-dot ck-dot-${dot.cls}" title="${esc(dot.label)}" aria-label="${esc(dot.label)}" role="img"></span>${esc(t('sites.cookie'))}
        </span>
        <div class="form-row-ctl">
          ${present ? `<button class="site-cookie-btn" data-act="ck-import">${esc(t('cookie.replace'))}</button>` : ''}
          <button class="site-cookie-toggle ${cookieOn ? 'on' : 'off'}" data-act="ck-switch" role="switch" aria-checked="${cookieOn}" title="${esc(t('sites.cookie'))}"><span class="knob"></span></button>
        </div>
      </div>
      <div class="form-row">
        <span class="form-row-label">${esc(t('sites.blur'))}</span>
        <div class="form-row-ctl">
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
    rankWebsites();
    applyBlurToRows();
    renderWebsites();
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  }
}

/**
 * How many of this site's settings differ from the defaults. Each of the four
 * inherited settings counts when it's pinned (non-null = "don't follow the
 * global"), plus the two flags that are themselves departures from the norm.
 * Cookies are excluded: a jar is state the site needed, not a preference the
 * user expressed.
 */
function customCount(w: Website): number {
  return Number(w.max_heights !== null) + Number(w.stream_quality !== null)
    + Number(w.container !== null) + Number(w.subs !== null)
    + Number(w.blur) + Number(!w.enabled);
}

/**
 * site key → its position in the list, most-customised first.
 *
 * Computed when the registry loads and then held still, NOT derived per render.
 * The list is long and mostly untouched defaults, so floating the handful of
 * configured sites to the top is worth doing — but every toggle re-renders the
 * list, and re-ranking there would tear the card out from under the finger that
 * just tapped it. Ranking on load puts a site the user just customised at the
 * top the next time they open the sheet, which is when it helps and doesn't
 * startle. Ties keep the server's order — `sort` is stable.
 */
let siteRank = new Map<string, number>();
function rankWebsites(): void {
  siteRank = new Map(
    [...websitesLoaded]
      .sort((a, b) => customCount(b) - customCount(a))
      .map((w, i) => [w.key, i]),
  );
}

// Sites matching the current search box: name, any domain, or key (case-insensitive).
function filteredWebsites(): Website[] {
  const q = siteQuery.trim().toLowerCase();
  const matching = !q ? websitesLoaded : websitesLoaded.filter((w) =>
    w.name.toLowerCase().includes(q) ||
    w.key.toLowerCase().includes(q) ||
    w.hosts.some((h) => h.toLowerCase().includes(q)));
  return [...matching].sort((a, b) => (siteRank.get(a.key) ?? 0) - (siteRank.get(b.key) ?? 0));
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
    case 'stream': {
      // The card's share-quality dropdown (change event). '' clears back to
      // follow-global, via the same flag pattern `subs` uses below.
      const v = (el as HTMLSelectElement).value;
      if (v === '') await saveWebsite(key, { stream_quality_global: true });
      else await saveWebsite(key, { stream_quality: v });
      return;
    }
    case 'fmt': {
      // The card's video-format dropdown (change event). '' clears the per-site
      // container back to "follow global".
      await saveWebsite(key, { container: (el as HTMLSelectElement).value });
      return;
    }
    case 'subs': {
      // The card's subtitle dropdown (change event). `subs_global` is how the
      // API expresses "clear back to follow-global", since a null `subs` in JSON
      // is indistinguishable from an omitted field.
      const v = (el as HTMLSelectElement).value;
      if (v === 'global') await saveWebsite(key, { subs_global: true });
      else await saveWebsite(key, { subs: v === 'on' });
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
      if (!(await askConfirm({
        title: t('sites.deleteTitle'),
        sub: t('sites.deleteConfirm', { name: w.name }),
        confirm: t('cookie.delete'),
        danger: true,
      }))) return;
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
  if (!(await askConfirm({
    title: t('sites.deleteTitle'),
    sub: t('sites.deleteN', { n: keys.length }),
    confirm: t('cookie.delete'),
    danger: true,
  }))) return;
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
  if (!(await askConfirm({
    title: t('sites.mergeTitle'),
    sub: t('sites.mergeConfirm', { n: sources.length, name: targetName }),
    confirm: t('sites.merge'),
    danger: true,
  }))) return;
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

// ---- The one confirmation dialog -------------------------------------------
// Every irreversible action asks through here — deleting items, wiping local
// files, revoking public links, rewriting the archive. One box, filled in per
// call, so the wording, layout and the red-for-destructive rule are decided once
// instead of drifting apart across a dialog per action.
//
//   if (!(await askConfirm({ title: …, sub: …, confirm: …, danger: true }))) return;
//
// Resolves false on Cancel, the ✕, a backdrop tap or Escape (see dismissTopLayer).
let confirmResolve: ((ok: boolean) => void) | null = null;

function askConfirm(opts: {
  title: string;
  sub: string;
  confirm: string;
  danger?: boolean;
}): Promise<boolean> {
  settleConfirm(false); // a second ask supersedes any dialog still open
  els.confirmTitle.textContent = opts.title;
  els.confirmSub.textContent = opts.sub;
  els.confirmYes.textContent = opts.confirm;
  // Red is reserved for actions that destroy something. Toggled per call, so a
  // reused box never keeps the previous action's colour.
  els.confirmYes.classList.toggle('btn-danger', !!opts.danger);
  openModal(els.confirmBox);
  return new Promise<boolean>((resolve) => { confirmResolve = resolve; });
}

// Close the dialog and answer whoever is awaiting it. Safe to call when nothing
// is pending, which is what lets the generic dismiss paths just call it.
function settleConfirm(ok: boolean): void {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null;
  closeModal(els.confirmBox);
  resolve(ok);
}

els.confirmYes.addEventListener('click', () => settleConfirm(true));
els.confirmCancel.addEventListener('click', () => settleConfirm(false));
els.confirmClose.addEventListener('click', () => settleConfirm(false));
els.confirmBox.addEventListener('click', (e) => {
  if (e.target === els.confirmBox) settleConfirm(false); // backdrop dismiss
});

// ---- Wire up UI -----------------------------------------------------------
els.settingsToggle.addEventListener('click', () => {
  closeModal(els.websites);
  els.token.value = getToken();
  if (els.server) els.server.value = apiBase();
  openModal(els.settings);
  // Whichever platform we're on: one of these owns the permission block, and the
  // other returns immediately.
  refreshAppPermissions();
  refreshWebPermissions();
  loadArchive();
  // Also this sheet's storage cap: /api/settings carries both it and the
  // per-site defaults the Websites window shows, so either window opening
  // refreshes from the same one fetch.
  loadSettings();
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
  // The per-site <select>s also carry data-act, but must report via their
  // 'change' event only. Handling their click here would immediately re-render
  // the card (saveWebsite → renderWebsites) and destroy the native dropdown
  // before it can open — the "can't open the resolution picker" bug. The
  // resolution multi-select is excluded for the same reason: it reports via
  // `multiselect-change` once, after the popover is done being clicked in.
  if (!btn || btn.tagName === 'SELECT' || btn.classList.contains('multiselect')) return;
  websiteAction(card.dataset.key!, btn.dataset.act!, btn);
});
// The per-site dropdowns (share quality / format / subtitles) report via change,
// not click — the click handler above deliberately ignores SELECTs.
els.websiteList.addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest('select[data-act]') as HTMLSelectElement | null;
  if (!sel || siteSelectMode) return;
  const card = sel.closest('.website-card') as HTMLElement;
  websiteAction(card.dataset.key!, sel.dataset.act!, sel);
});
// The per-site resolution multi-select. Fires once per option toggled, carrying
// the whole set — so each pick is saved, matching how every other control on the
// card treats "changing it" as "saving it".
els.websiteList.addEventListener('multiselect-change', (e) => {
  const root = e.target as HTMLElement;
  if (siteSelectMode) return;
  const card = root.closest('.website-card') as HTMLElement | null;
  if (!card) return;
  const heights = (e as CustomEvent).detail.heights as number[] | null;
  // `render: false` — re-rendering the card would rebuild the popover the user is
  // still clicking in and slam it shut after the first pick, which is exactly what
  // a multi-select must not do. The control already painted itself optimistically;
  // websitesLoaded is still updated, so the next full render agrees with the DOM.
  saveWebsite(card.dataset.key!, heights === null
    ? { max_heights_global: true }
    : { max_heights: heights }, false);
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

// Commit the typed token, then re-pull everything that was gated behind it.
// Called by the sheet's one Save (see saveSettings).
async function applyToken(): Promise<boolean> {
  setToken(els.token.value.trim());
  els.tokenHint.classList.add('hidden');
  connectEvents();
  loadItems(true);
  loadStats();
  if (getToken()) {
    loadWebsites();
    loadArchive();
  }
  return true;
}

// Server URL (app only): persist, then reconnect the SSE + reload against it.
async function applyServerUrl(): Promise<boolean> {
  // Refuse a plain-http public-IP server: it would ship the token + cookies in
  // the clear over the internet. Use https, or a private/LAN address.
  if (isInsecurePublicBase(els.server.value)) {
    toast(t('toast.insecureServer'), 'error');
    return false;
  }
  setApiBase(els.server.value);
  loadServerConfig();
  connectEvents();
  loadItems(true);
  return true;
}

// `storage` is "may write shared storage" — on Android 11+ that is the "All
// files access" grant, which is the only way to write Downloads/Orca (and the
// only way at all to create the hidden .Orca folder; MediaStore refuses a
// dot-prefixed directory).
type AppPermissionStatus = { notifications: boolean; background: boolean; storage: boolean };
let appPermissions: AppPermissionStatus | null = null;
// Not a permission — where saves land. Mirrored from the native side, which
// owns the setting, so it survives reinstall-free app restarts.
let hideDownloads = false;
const requestingPermissions = new Set<keyof AppPermissionStatus>();
const PERMISSION_PROMPT_NEVER = 'orca_permissions_prompt_never';
migrateLegacyStorage(PERMISSION_PROMPT_NEVER, 'permissions_prompt_never');

// The glyph at the end of a permission row, per state. Granted is a real check
// mark rather than the "✓" character — the text glyph rendered at whatever weight
// and baseline the system font felt like, which is what made the row look
// unfinished next to its icon. Colour comes from the row's [data-state] (see
// .permission-result in style.css), so the green lives in one place.
type PermissionState = 'granted' | 'missing' | 'checking';
const PERMISSION_RESULT: Record<PermissionState, string> = {
  granted: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  missing: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`,
  checking: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
};

function renderAppPermission(kind: keyof AppPermissionStatus): void {
  const granted = appPermissions?.[kind] ?? null;
  const requesting = requestingPermissions.has(kind);
  const state: PermissionState = requesting || granted == null ? 'checking' : granted ? 'granted' : 'missing';
  document.querySelectorAll<HTMLButtonElement>(`.permission-item[data-permission="${kind}"]`).forEach((button) => {
    button.dataset.state = state;
    button.disabled = requesting;
    const status = button.querySelector<HTMLElement>('.permission-status');
    const result = button.querySelector<HTMLElement>('.permission-result');
    if (status) status.textContent = t(requesting
      ? 'settings.permRequesting'
      : granted == null ? 'settings.permChecking' : granted ? 'settings.permGranted' : 'settings.permMissing');
    if (result) result.innerHTML = PERMISSION_RESULT[state];
  });
}

/**
 * Which permission rows still have something to ask for. Empty → the whole block
 * hides (see renderAppPermissions): a list of green ticks is furniture, and the
 * section only earns its space while it has an action to offer.
 *
 * The two platforms genuinely differ. Android needs all three and cannot work
 * without storage. The web build has exactly one worth asking about —
 * notifications, for download-finished alerts — and never insists: everything
 * works without it. A hard `denied` there is also filtered out, because script
 * cannot re-request it, so the row would be a button that does nothing.
 */
function pendingPermissions(): Array<keyof AppPermissionStatus> {
  if (!appPermissions) return [];
  if (isAndroidApp()) {
    return (['notifications', 'background', 'storage'] as const)
      .filter((k) => !appPermissions![k]);
  }
  return webNotificationsPending() ? ['notifications'] : [];
}

function webNotificationsPending(): boolean {
  return 'Notification' in window && Notification.permission === 'default';
}

function renderAppPermissions(): void {
  renderAppPermission('notifications');
  renderAppPermission('background');
  renderAppPermission('storage');
  renderHideDownloads();
  els.permRow.classList.toggle('hidden', pendingPermissions().length === 0);
}

/**
 * The browser build's permission state. Mirrors the Android shape so the one
 * renderer serves both; `background`/`storage` are reported granted because they
 * have no browser equivalent and must never count as pending.
 */
function refreshWebPermissions(): void {
  if (isNativeApp) return;
  if (!('Notification' in window)) { els.permRow.classList.add('hidden'); return; }
  appPermissions = {
    notifications: Notification.permission === 'granted',
    background: true,
    storage: true,
  };
  renderAppPermissions();
}

// The hide toggle is meaningless without storage access (we couldn't move the
// files), so it follows that grant.
function renderHideDownloads(): void {
  const allowed = !!appPermissions?.storage;
  // Android-only: the folder it switches between exists only there. The row now
  // shares the Downloads group with the storage cap, so its explanatory line has
  // to hide alongside it — the group itself stays, since the cap is everywhere.
  const android = isAndroidApp();
  els.hideDlRow.classList.toggle('hidden', !android);
  els.hideDlHint.classList.toggle('hidden', !android);
  setSwitch(els.hideDlToggle, hideDownloads);
  els.hideDlToggle.disabled = !allowed;
  els.hideDlNeedsPerm.classList.toggle('hidden', allowed || !android);
}

async function refreshAppPermissions(): Promise<AppPermissionStatus | null> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke) return null;
  try {
    const status = await T.core.invoke('android_permission_status') as AppPermissionStatus & { hideDownloads?: boolean };
    appPermissions = {
      notifications: !!status.notifications,
      background: !!status.background,
      storage: !!status.storage,
    };
    hideDownloads = !!status.hideDownloads;
    // Visibility is renderAppPermissions' call now — it hides the block once
    // nothing is left to grant, and unhiding here would fight it.
    renderAppPermissions();
    if (appPermissions.notifications && appPermissions.background && appPermissions.storage
      && !els.permissionsPrompt.classList.contains('hidden')) {
      closeModal(els.permissionsPrompt);
    }
    return appPermissions;
  } catch (_) {
    // Desktop Tauri has no Android permission bridge; keep the row hidden there.
    els.permRow.classList.add('hidden');
    return null;
  }
}

const PERMISSION_COMMANDS: Record<keyof AppPermissionStatus, string> = {
  notifications: 'request_notification_permission',
  background: 'request_background_permission',
  storage: 'request_storage_permission',
};

async function requestAppPermission(kind: keyof AppPermissionStatus): Promise<void> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke) return;
  const current = await refreshAppPermissions();
  if (!current || current[kind]) return;
  requestingPermissions.add(kind);
  renderAppPermission(kind);
  try {
    await T.core.invoke(PERMISSION_COMMANDS[kind]);
  } catch (_) { /* the next state read shows the actual result */ }
  requestingPermissions.delete(kind);
  await refreshAppPermissions();
}

function isPermissionKind(v: string | undefined): v is keyof AppPermissionStatus {
  return v === 'notifications' || v === 'background' || v === 'storage';
}

document.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.permission-item[data-permission]');
  const kind = button?.dataset.permission;
  if (!isPermissionKind(kind)) return;
  if (isNativeApp) { requestAppPermission(kind); return; }
  // Web: the browser's own prompt. Whatever the user answers, re-render — a
  // grant hides the block, a denial does too (it can't be asked again).
  if (kind === 'notifications' && 'Notification' in window) {
    Notification.requestPermission().finally(() => refreshWebPermissions());
  }
});

// Flipping "hide my downloads" also MOVES everything already saved, so the
// setting applies retroactively rather than stranding old files in the folder
// the user just chose to stop using.
if (els.hideDlToggle) {
  els.hideDlToggle.addEventListener('click', async () => {
    const T = window.__TAURI__;
    if (!T?.core?.invoke || els.hideDlToggle.disabled) return;
    const next = !hideDownloads;
    els.hideDlToggle.disabled = true;
    setSwitch(els.hideDlToggle, next);
    try {
      const status = await T.core.invoke('set_hide_downloads', { hidden: next }) as
        { hideDownloads?: boolean; moved?: number };
      hideDownloads = !!status.hideDownloads;
      const moved = status.moved || 0;
      toast(moved > 0 ? t('toast.hideDlMoved', { n: moved })
        : t(hideDownloads ? 'toast.hideDlOn' : 'toast.hideDlOff'), 'ok');
    } catch (_) {
      toast(t('toast.hideDlFail'), 'error');
    }
    await refreshAppPermissions();
  });
}

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
let archiveHasBackup = false;       // server holds a previous version to roll back to

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
    // Server order, kept as-is: it hands these back newest-recorded first (see
    // Archive::keys), which is the order the box shows. Sorting here would throw
    // that away and replace it with something alphabetical and meaningless.
    const keys: string[] = data.keys || [];
    sealLoaded = new Set(keys);
    archiveHasBackup = !!data.has_backup;
    els.sealArchive.value = keys.join('\n');
    renderSaveBar();
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.loadArchiveFail'), 'error');
  }
}

// ---- Global download defaults ----------------------------------------------
// The fallback for any site that doesn't pin its own: which resolutions to
// download, what shares may cost, the container, and subtitles. Each can be
// independently pinned by an env var (the control then reads locked/disabled).
//
// Rendered from the same builders the site cards use — `followable: false` is the
// only difference, since the global has nothing to follow. Sharing the builders is
// what makes the two sets of rows identical rather than merely similar.
interface GlobalSettings {
  max_heights: number[];
  max_heights_locked: boolean;
  stream_quality: string;
  container: string;
  container_locked: boolean;
  subs: boolean;
  subs_locked: boolean;
}
let globalSettings: GlobalSettings | null = null;

function renderGlobalDefaults(d: GlobalSettings): void {
  els.maxRes.innerHTML = multiSelectHtml({
    act: 'g-res',
    heights: d.max_heights,
    followable: false,
    ariaLabel: t('settings.maxRes'),
    disabled: d.max_heights_locked,
  });
  els.maxResLocked.classList.toggle('hidden', !d.max_heights_locked);

  const opt = (val: string, label: string, on: boolean): string =>
    `<option value="${val}"${on ? ' selected' : ''}>${esc(label)}</option>`;

  // No env pin for share quality: it's a sharing policy, not a deployment
  // constant, so there is no locked state to render.
  els.streamQuality.innerHTML =
    `<select class="select site-res-select" data-act="g-stream" aria-label="${esc(t('settings.streamQuality'))}">${
      STREAM_QUALITIES.map(([v, k]) => opt(v, t(k), d.stream_quality === v)).join('')
    }</select>`;

  els.format.innerHTML =
    `<select class="select site-res-select" data-act="g-fmt" aria-label="${esc(t('settings.format'))}"${d.container_locked ? ' disabled' : ''}>${
      SITE_FORMATS.map(([v, label]) => opt(v, label, d.container === v)).join('')
    }</select>`;
  els.formatLocked.classList.toggle('hidden', !d.container_locked);

  // A two-state select rather than the pill switch it used to be: the site cards
  // express subtitles as a dropdown, and this row sits directly above them.
  els.subs.innerHTML =
    `<select class="select site-res-select" data-act="g-subs" aria-label="${esc(t('settings.subs'))}"${d.subs_locked ? ' disabled' : ''}>${
      opt('on', t('sites.subsOn'), d.subs) + opt('off', t('sites.subsOff'), !d.subs)
    }</select>`;
  els.subsLocked.classList.toggle('hidden', !d.subs_locked);
}

async function loadSettings(): Promise<void> {
  if (!els.maxRes || !getToken()) return;
  try {
    const res = await apiFetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    globalSettings = {
      max_heights: Array.isArray(data.max_heights) ? data.max_heights : [0],
      max_heights_locked: !!data.max_heights_locked,
      stream_quality: String(data.stream_quality || 'higher'),
      container: String(data.container || 'mkv'),
      container_locked: !!data.container_locked,
      subs: !!data.subs,
      subs_locked: !!data.subs_locked,
    };
    renderGlobalDefaults(globalSettings);
    // The storage cap rides the same payload but lives in the Settings sheet, not
    // the per-site defaults, so it's tracked separately (and by the save bar).
    storageLoaded = typeof data.max_storage === 'number' ? data.max_storage : null;
    storageLocked = !!data.max_storage_locked;
    renderMaxStorage();
    renderSaveBar();
  } catch (_) { /* offline / unauthorized — leave the controls as-is */ }
}

/** PUT one global default, repainting from the server's echo. */
async function commitGlobal(patch: Record<string, unknown>): Promise<void> {
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
      // Snap back to the last known-good state rather than leaving the UI
      // asserting a value the server rejected.
      if (globalSettings) renderGlobalDefaults(globalSettings);
      return;
    }
    globalSettings = {
      max_heights: Array.isArray(data.max_heights) ? data.max_heights : [0],
      max_heights_locked: !!data.max_heights_locked,
      stream_quality: String(data.stream_quality || 'higher'),
      container: String(data.container || 'mkv'),
      container_locked: !!data.container_locked,
      subs: !!data.subs,
      subs_locked: !!data.subs_locked,
    };
    toast(t('toast.settingsSaved'), 'ok');
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
    if (globalSettings) renderGlobalDefaults(globalSettings);
  }
}

// Paint a pill switch's on/off state (class + ARIA together, so the two can't
// drift apart).
function setSwitch(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.setAttribute('aria-checked', String(on));
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
    // Two independent axes: which stage failed (drives the badge's default hue)
    // and whose fault it was (drives the severity rule). A server that predates
    // classification sends no severity — treat it as an error rather than
    // silently painting real bugs amber.
    d.className = 'log-entry log-entry--' + (e.stage === 'download' ? 'download' : 'probe')
      + ' log-entry--' + (e.severity === 'warn' ? 'warn' : 'error');

    // Two lines, not one: metadata (when / where / which stage) above the
    // message, each owning its own row. Cramming all four into one flex line
    // meant three nowrap chips squeezed the message into a sliver — and expanding
    // the row let that sliver wrap into a tall ragged column beside them. This is
    // the shape CI logs and Sentry use, and it's why the message can now use the
    // full width in both states.
    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="log-chevron" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>` +
      `<span class="log-sum">` +
        `<span class="log-meta">` +
          `<span class="log-badge">${esc(e.platform || 'unknown')}</span>` +
          `<span class="log-stage">${esc(e.stage)}</span>` +
          `<span class="log-time">${esc(fmtLogTime(e.at))}</span>` +
        `</span>` +
        `<span class="log-msg-short">${esc(e.message)}</span>` +
      `</span>`;

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

    // The expanded body labels its two facts instead of running them together as
    // one blob of text with a blank line in the middle — the URL is what you
    // check first, and it was indistinguishable from the message's first line.
    const full = document.createElement('div');
    full.className = 'log-full';
    for (const [label, value] of [[t('logs.url'), e.url], [t('logs.message'), e.message]] as const) {
      if (!value) continue;
      const field = document.createElement('div');
      field.className = 'log-field';
      const key = document.createElement('span');
      key.className = 'log-key';
      key.textContent = label;
      const pre = document.createElement('pre');
      pre.className = 'log-value';
      pre.textContent = value;
      field.append(key, pre);
      full.appendChild(field);
    }
    d.appendChild(full);

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
    // Asking the server for a taller copy of something already on this device is
    // implicitly asking for the device's copy to get taller too — otherwise the
    // upgrade is invisible where the user actually watches it. Flag it now; the
    // pull happens once the download lands (see runPendingLocalUpgrade).
    flagLocalUpgrade(target, heights);
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

// Items whose on-device copy should be refreshed once the server finishes
// fetching a taller version. Ids, not slugs, to match the SSE event key. Held in
// memory only: if the app dies mid-download the upgrade is forgotten, which is
// the right trade — a surprise multi-hundred-MB save on next launch is worse
// than the user tapping Save again.
const pendingLocalUpgrade = new Set<number>();

/**
 * Note that `id` should have its local copy replaced, if there's a local copy at
 * all and the newly-requested set actually beats it. Both conditions matter:
 * without the first we'd save files the user never asked to have offline, and
 * without the second, *removing* a resolution would trigger a pointless re-save
 * of a file the device already has.
 */
function flagLocalUpgrade(id: number, heights: number[]): void {
  if (!isAndroidApp() || !heights.length) return;
  const local = localFileFor(state.items.get(id)?.slug);
  if (!local) return;
  // 0 ("highest available") always counts as an upgrade: we can't know what it
  // resolves to until the download lands, and the server only ever repoints the
  // primary at something taller.
  const wantsTaller = heights.some((h) => h === 0 || h > local.height);
  if (wantsTaller) pendingLocalUpgrade.add(id);
}

/** Re-save an upgraded item over its local copy. MediaSaver deletes the old one. */
function runPendingLocalUpgrade(it: Item): void {
  if (!pendingLocalUpgrade.delete(it.id)) return;
  if (it.status !== 'completed' || !it.local_available) return;
  void saveItemsNative([it]);
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

// ---- Global site defaults (Website management) ----------------------------
// Picking a value IS the save — no Save button per control, which is how the
// per-site dropdowns on the cards below have always behaved. PUT /api/settings
// is a partial patch, so each control sends only its own field. Delegated,
// because renderGlobalDefaults rebuilds these controls on every load and echo;
// a listener bound to the element itself would die with it.
if (els.sitesGlobal) {
  els.sitesGlobal.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest('select[data-act]') as HTMLSelectElement | null;
    if (!sel) return;
    switch (sel.dataset.act) {
      case 'g-stream': commitGlobal({ stream_quality: sel.value }); break;
      case 'g-fmt': commitGlobal({ container: sel.value }); break;
      case 'g-subs': commitGlobal({ subs: sel.value === 'on' }); break;
    }
  });
  els.sitesGlobal.addEventListener('multiselect-change', (e) => {
    const detail = (e as CustomEvent).detail;
    if (detail.act !== 'g-res') return;
    // The global has no "follow global" option, so heights is never null here.
    commitGlobal({ max_heights: detail.heights ?? [] });
  });
}

// ---- The one Save ----------------------------------------------------------
// Settings holds three things the user types rather than picks — the server URL,
// the API token and the archive — so unlike the pick-is-the-save controls above
// they need an explicit commit. That commit is ONE bar, docked at the bottom of
// the sheet and shown only while something is genuinely different from what is
// stored (dirtyFields below), instead of a Save button beside each field.

// ---- Storage cap ----------------------------------------------------------
// Stored and sent as bytes — a number plus a unit is how you *type* a size, not
// something the server should have to parse and re-guess. Binary units, matching
// fmtSize and the backend's parse_size, so a cap of "500 GB" and a usage readout
// of "499.8 GB" are measured against the same ruler.
const UNIT_BYTES = {
  MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5,
} as const;
type StorageUnit = keyof typeof UNIT_BYTES;
// Largest first: renderMaxStorage picks the first that leaves a value ≥ 1.
const STORAGE_UNITS: StorageUnit[] = ['PB', 'TB', 'GB', 'MB'];
/** Narrow the <select>'s value to a known unit; anything else falls back to GB. */
function storageUnit(v: string): StorageUnit {
  return (STORAGE_UNITS as string[]).includes(v) ? (v as StorageUnit) : 'GB';
}
let storageLoaded: number | null = null; // committed cap in bytes; null = unlimited
let storageLocked = false;               // pinned by ORCA_MAX_STORAGE

/** The cap the fields currently describe, in bytes. Blank / 0 = unlimited. */
function draftMaxStorage(): number | null {
  const n = parseFloat(els.maxStorage.value);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * UNIT_BYTES[storageUnit(els.maxStorageUnit.value)]);
}

/** Paint `bytes` back into the number + unit pair, picking the unit that reads
 *  most naturally (the largest one that leaves a value ≥ 1, i.e. "1.5 TB" over
 *  "1536 GB"). Trailing zeros are trimmed so a round 500 shows as "500". */
function renderMaxStorage(): void {
  const bytes = storageLoaded;
  els.maxStorageLocked.classList.toggle('hidden', !storageLocked);
  els.maxStorage.disabled = storageLocked;
  els.maxStorageUnit.disabled = storageLocked;
  if (!bytes || bytes <= 0) { els.maxStorage.value = ''; els.maxStorageUnit.value = 'GB'; return; }
  const unit = STORAGE_UNITS.find((u) => bytes >= UNIT_BYTES[u]) ?? 'MB';
  els.maxStorage.value = String(parseFloat((bytes / UNIT_BYTES[unit]).toFixed(2)));
  els.maxStorageUnit.value = unit;
}

// What each tracked field currently holds vs. what is committed. Compared as
// strings so "same value retyped" doesn't count as dirty.
function committedSettings(): Record<string, string> {
  return {
    server: apiBase(),
    token: getToken(),
    archive: [...sealLoaded].sort().join('\n'),
    maxStorage: String(storageLoaded ?? ''),
  };
}
function draftSettings(): Record<string, string> {
  return {
    server: (els.server.value || '').trim().replace(/\/+$/, ''),
    token: (els.token.value || '').trim(),
    archive: [...parseArchiveKeys()].sort().join('\n'),
    maxStorage: String(draftMaxStorage() ?? ''),
  };
}
function dirtyFields(): string[] {
  const now = draftSettings();
  const saved = committedSettings();
  return Object.keys(now).filter((k) => now[k] !== saved[k])
    // An env-pinned cap can't be saved, so it must never count as dirty: the
    // field is disabled, but a value that doesn't round-trip byte-for-byte (an
    // operator's odd `ORCA_MAX_STORAGE=12345678`) would otherwise strand the save
    // bar open over a field nobody can edit.
    .filter((k) => !(k === 'maxStorage' && storageLocked));
}

function renderSaveBar(): void {
  if (!els.settingsSaveBar) return;
  els.settingsSaveBar.classList.toggle('hidden', dirtyFields().length === 0);
  renderArchiveRestore();
}

// Restore is the archive's undo, and what it undoes depends on where you are:
// while the box is dirty it throws away YOUR edits (back to the recorded
// version); once clean it rolls the server back to the version before the last
// save. One button, because from the user's side it's one intent — "undo".
function renderArchiveRestore(): void {
  if (!els.archiveRestore) return;
  const dirty = dirtyFields().includes('archive');
  const show = dirty || archiveHasBackup;
  els.archiveRestore.classList.toggle('hidden', !show);
  if (!show) return;
  const key = dirty ? 'settings.archiveDiscard' : 'settings.archiveRestore';
  els.archiveRestore.textContent = t(key);
  els.archiveRestore.dataset.mode = dirty ? 'discard' : 'restore';
}

// Rewriting the archive decides what Orca will and won't fetch again and a slip
// isn't otherwise recoverable, so a save that touches it is confirmed first —
// showing exactly how many keys are being added and dropped.
function confirmArchiveSave(): Promise<boolean> {
  const now = parseArchiveKeys();
  const added = [...now].filter((k) => !sealLoaded.has(k)).length;
  const removed = [...sealLoaded].filter((k) => !now.has(k)).length;
  return askConfirm({
    title: t('archiveConfirm.title'),
    sub: t('archiveConfirm.sub', { add: added, rem: removed }),
    confirm: t('btn.save'),
    // Not red: the previous version is kept and Restore brings it straight back,
    // so this is a checkpoint, not a one-way door.
  });
}

async function saveSettings(): Promise<void> {
  const dirty = dirtyFields();
  if (!dirty.length) return;
  // Confirm the destructive part BEFORE committing any of it, so cancelling
  // leaves the whole sheet untouched rather than half-saved.
  if (dirty.includes('archive') && !(await confirmArchiveSave())) return;

  els.settingsSave.disabled = true;
  try {
    if (dirty.includes('server')) {
      if (!(await applyServerUrl())) return;
    }
    if (dirty.includes('token')) {
      if (!(await applyToken())) return;
    }
    if (dirty.includes('archive')) {
      if (!(await applyArchive())) return;
    }
    if (dirty.includes('maxStorage')) {
      if (!(await applyMaxStorage())) return;
    }
    toast(t('toast.settingsSaved'), 'ok');
  } finally {
    els.settingsSave.disabled = false;
    renderSaveBar();
  }
}

// Commit the storage cap. `null` clears it (unlimited) — PUT /api/settings tells
// that apart from "field not sent", so this can't be expressed by omitting it.
async function applyMaxStorage(): Promise<boolean> {
  const bytes = draftMaxStorage();
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_storage: bytes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
      return false;
    }
    storageLoaded = bytes;
    renderMaxStorage();
    // A new cap changes what the gauge is a percentage OF, and can push the
    // install straight into the amber/red band — repaint it now, not in 30s.
    loadStats();
    return true;
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
    return false;
  }
}

// Push the edited archive as a whole. The server replaces rather than merges (so
// a deleted line really does free the key) and keeps the previous version aside
// for Restore — see PUT /api/archive.
async function applyArchive(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/archive', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archive: [...parseArchiveKeys()].join('\n') }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
      return false;
    }
    sealLoaded = parseArchiveKeys();
    // Leave the box exactly as the user left it — it already holds what was just
    // saved, in the order it was saved. (parseArchiveKeys drops blank/malformed
    // lines, so re-joining from the Set also tidies those away.)
    els.sealArchive.value = [...sealLoaded].join('\n');
    archiveHasBackup = true;
    return true;
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
    return false;
  }
}

async function restoreArchive(): Promise<void> {
  els.archiveRestore.disabled = true;
  try {
    const res = await apiFetch('/api/archive/restore', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
      return;
    }
    // Newest-first from the server, like /api/archive — don't re-sort.
    const keys = (data.keys || []) as string[];
    sealLoaded = new Set(keys);
    els.sealArchive.value = keys.join('\n');
    archiveHasBackup = true; // the version we rolled back FROM is the new backup
    toast(t('toast.archiveRestored', { n: keys.length }), 'ok');
  } catch (e) {
    if (!isUnauthorized(e)) toast('Network error', 'error');
  } finally {
    els.archiveRestore.disabled = false;
    renderSaveBar();
  }
}

if (els.archiveRestore) {
  els.archiveRestore.addEventListener('click', () => {
    if (els.archiveRestore.dataset.mode === 'discard') {
      // Local edits only — nothing was sent, so just repaint from what's recorded.
      els.sealArchive.value = [...sealLoaded].sort().join('\n');
      renderSaveBar();
      return;
    }
    restoreArchive();
  });
}

if (els.settingsSave) {
  els.settingsSave.addEventListener('click', saveSettings);
  els.settingsRevert.addEventListener('click', () => {
    els.server.value = apiBase();
    els.token.value = getToken();
    // Server order (newest first), as loaded — see loadArchive.
    els.sealArchive.value = [...sealLoaded].join('\n');
    renderMaxStorage();
    renderSaveBar();
  });
  // Track every tracked field. `input` fires on typing AND on paste/undo, which
  // a `change` listener would miss until blur. The unit <select> is the exception:
  // it only ever emits `change`.
  for (const el of [els.server, els.token, els.sealArchive, els.maxStorage]) {
    el.addEventListener('input', renderSaveBar);
  }
  els.maxStorageUnit.addEventListener('change', renderSaveBar);
}

els.submitForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitInput();
});

// Paste button: pull the clipboard, keep every link in it, and stage them in the
// box for review rather than submitting behind the user's back.
if (els.pasteBtn) {
  els.pasteBtn.addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {
      // Denied permission, or a browser without the async clipboard read.
      toast(t('toast.pasteFail'), 'error');
      return;
    }
    const links = parseLinks(text);
    if (!links.length) { toast(t('toast.pasteEmpty'), 'info'); return; }
    const dropped = (text.match(LINK_RE) || []).length - links.length;
    els.url.value = links.join(' ');
    els.url.focus();
    toast(
      dropped
        ? t('toast.pastedDedup', { n: links.length, d: dropped })
        : t('toast.pastedN', { n: links.length }),
      'ok',
    );
  });
}

// ---- Back to top ----------------------------------------------------------
// Revealed once the page is scrolled a couple of viewports down — far enough
// that scrolling back by hand is a chore, not so eager that it covers content
// during normal browsing. Hidden while the player owns the screen.
function setupBackToTop(): void {
  if (!els.toTop) return;
  const THRESHOLD = 600;
  const sync = (): void => {
    const show = window.scrollY > THRESHOLD && !document.body.classList.contains('player-open');
    els.toTop.classList.toggle('hidden', !show);
  };
  window.addEventListener('scroll', sync, { passive: true });
  els.toTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  sync();
}
setupBackToTop();

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  loadItems(true);
}, 300));

// Infinite scroll: pull the next page once the spinner actually reaches the
// viewport — no prefetch margin. This used to pre-fetch 300px early, which fired
// while the spinner was still off-screen and grew the list under a user who
// hadn't reached the bottom yet; on a short page the two thresholds could even
// chain and run pages on without a deliberate scroll. Reaching the end is the
// gesture that asks for more, so wait for it.
const loaderObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !state.loading && state.cursor != null) {
    loadItems(false);
  }
});
loaderObserver.observe(els.loader);

// Every interactive control a card can carry: the thumbnail's play target, the
// bottom-right action row (delete / save / share, plus the size + resolution
// chips), and anything else that declares an action. Save is an <a download>
// with no data-act, and the play target's class is .thumb-play, so neither is
// covered by [data-act] alone — hence all three.
const CARD_CONTROLS = '[data-act], .thumb-play, .act';

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
      // waits. Every control on the card is sharp already (blur only touches
      // .thumb/.title/.uploader — see .item.blurred CSS), so a tap on one runs
      // its action on the FIRST press rather than being spent on an unblur — and
      // leaves the blur alone entirely. Revealing here too would mean playing a
      // video from a private site also stripped that card bare behind the player,
      // which is the opposite of what the blur is for. Tapping the blurred image
      // itself still peeks, so the privacy gesture is intact.
      //
      // This must name every control by the class it actually carries: the play
      // button is .thumb-play (the badge inside it is a decorative child, and
      // .play-badge alone missed the rest of the hit target), and the action row
      // is .act — of which Save is an <a download> with no data-act at all.
      if (!target.closest(CARD_CONTROLS)) {
        e.preventDefault();
        revealBlurred(bl);
        return;
      }
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

  // Save stays a real <a download> so the browser keeps its native behaviour;
  // only the Android app (where that anchor is inert) is intercepted.
  const save = target.closest('.act-save') as HTMLAnchorElement | null;
  if (save && isAndroidApp()) {
    e.preventDefault();
    const item = state.items.get(Number(save.dataset.id));
    if (!item) return;
    // A green icon means the file is already in Downloads/Orca. Say so rather
    // than silently re-downloading a copy the device already has; the resolution
    // picker is where a *different* version is asked for.
    if (localFileFor(item.slug)) { toast(t('toast.alreadySaved'), 'info'); return; }
    saveItemsNative([item]);
    return;
  }

  const btn = target.closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'share') openShare(id);
  else if (btn.dataset.act === 'delete') openDeleteConfirm([id]);
  else if (btn.dataset.act === 'resolutions') openResolutions(id);
  else if (btn.dataset.act === 'pause') holdItem(id, true);
  else if (btn.dataset.act === 'resume') holdItem(id, false);
  else if (btn.dataset.act === 'retry') retryItem(id);
  else if (btn.dataset.act === 'cancel') cancelItem(id);
});

// Give up on one download. Unlike pause this discards the partial file server-
// side, so it asks first — the bytes already fetched are what's being thrown
// away, and there is no undo beyond starting the download over.
async function cancelItem(id: number): Promise<void> {
  const item = state.items.get(id);
  if (!item) return;
  const ok = await askConfirm({
    title: t('cancelConfirm.title'),
    sub: t('cancelConfirm.sub'),
    confirm: t('item.cancel'),
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiFetch(itemPath(item, '/cancel'), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.cancelFail'), 'error');
      return;
    }
    upsertRow(data, false);
    loadStats();
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
  }
}

// Re-queue a failed item. Like holdItem, the server echoes the updated row, so
// the card repaints from the new status (Queued) and the retry button gives way
// to the pause button on its own.
async function retryItem(id: number): Promise<void> {
  const item = state.items.get(id);
  if (!item) return;
  try {
    const res = await apiFetch(itemPath(item, '/retry'), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.retryFail'), 'error');
      return;
    }
    upsertRow(data, false);
    loadStats();
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
  }
}

// Pause or resume one item. The server echoes the updated row, so the card (and
// with it the button that was just pressed) repaints from what actually happened
// rather than from what we assumed would.
async function holdItem(id: number, pause: boolean): Promise<void> {
  const item = state.items.get(id);
  if (!item) return;
  try {
    const res = await apiFetch(itemPath(item, pause ? '/pause' : '/resume'), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast((data && (data.message || data.error)) || t('toast.saveFail'), 'error');
      return;
    }
    upsertRow(data, false);
    loadStats(); // the paused count moved — re-render the global toggle with it
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
  }
}

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
// The bar shows only the actions the CURRENT selection can actually take, rather
// than every action always, greyed out. Nothing is enabled-but-hidden: if a
// button is on screen it works.
//
// The split between the bar and its overflow menu is by frequency, not by
// importance: Download / Share / Delete are what a selection is made FOR, so they
// stay on the surface as icons; select-all, invert, unshare, copy-links and clean
// are the once-in-a-while ones, and live one tap deeper. That's the same division
// Gmail and Google Photos make, and it's what lets the bar fit a phone in one row
// (it used to wrap nine word-buttons onto three).
function updateSelBar(): void {
  const n = state.selected.size;
  const loaded = state.rows.size;
  const picked = selectedItems();
  const done = picked.filter((it) => it.status === 'completed');
  const local = done.filter((it) => it.local_available);

  els.selCount.textContent = n ? t('sel.countN', { n }) : t('sel.count0');
  els.selBar.classList.toggle('hidden', !state.selectMode);
  if (!state.selectMode) closeSelMenu();

  const show = (b: HTMLElement, on: boolean): boolean => {
    b.classList.toggle('hidden', !on);
    return on;
  };
  // Primaries: each needs something it can act ON.
  show(els.selDownload, local.length > 0);   // needs a file to hand over
  show(els.selShare, done.length > 0);       // needs a finished item to publish
  show(els.selDelete, n > 0);                // any record can be deleted

  // Overflow. "Select all" flips to "Clear" once everything loaded is selected —
  // one entry covering both, the standard file-manager move.
  const inMenu = [
    show(els.selAll, loaded > 0),
    show(els.selInvert, loaded > 0),
    show(els.selCopy, done.length > 0),               // needs a finished item to link to
    show(els.selUnshare, picked.some((it) => it.public)), // needs a LIVE share
    show(els.selClean, local.length > 0),             // needs a file to erase
  ];
  els.selAll.textContent = loaded > 0 && n >= loaded ? t('sel.clear') : t('sel.all');
  // An empty menu is worse than no menu: a ⋮ that opens onto nothing reads as a
  // bug. Hide the trigger with its contents, and close it if it's open right now.
  if (!show(els.selMore, inMenu.some(Boolean))) closeSelMenu();
  refreshGroupHeaders(); // keep fold headers' selected/partial state in sync
}

// ---- Select-bar overflow menu ----
// Deliberately the same open/close shape as the website cards' ⋮ (see
// closeSiteMenus): click the trigger to toggle, click anywhere else to dismiss.
function closeSelMenu(): void {
  els.selMenu.classList.add('hidden');
  els.selMore.setAttribute('aria-expanded', 'false');
}
function toggleSelMenu(): void {
  const open = els.selMenu.classList.toggle('hidden') === false;
  els.selMore.setAttribute('aria-expanded', String(open));
}
els.selMore.addEventListener('click', (e) => { e.stopPropagation(); toggleSelMenu(); });
// Any tap outside the menu dismisses it — including one on a menu item, which is
// what closes the menu after the action it triggered.
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#sel-more')) closeSelMenu();
});

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

// ---- Global pause / resume ------------------------------------------------
// Deliberately server-driven. The button asks "is the BACKEND holding anything
// paused?" (stats.paused, a count across every item) rather than "does the page
// I'm looking at contain a paused row?" — the client only ever holds ~10 items,
// so a selection-scoped answer would render Pause while a hundred paused
// downloads sat two pages down, and the one press that could release them would
// pause instead. That mismatch is the failure mode this shape exists to avoid.
//
// Anything paused → offer Resume; that outranks showing Pause, because a stalled
// queue is the state the user needs a way out of.
//
// Always visible, like the select toggle it sits beside. It used to hide itself
// when there was nothing queued or paused, which meant that at rest — the state
// the app is in most of the time — the control simply wasn't there to be found,
// and you'd have to already know it existed to catch it during a download. A
// permanent, predictable button is worth more than one that only appears when
// it's already too late to look for it; with an idle queue it's disabled instead,
// which SAYS "nothing to pause" rather than hiding the answer.
function renderQueueToggle(): void {
  const btn = els.queueToggle;
  if (!btn) return;
  const paused = dlStatsCache?.paused ?? 0;
  const active = [...state.items.values()].some(
    (it) => it.status === 'queued' || it.status === 'running');
  const resume = paused > 0;
  const label = t(resume ? 'queue.resumeAll' : 'queue.pauseAll');
  btn.classList.remove('hidden');
  btn.innerHTML = resume ? RESUME_SVG : PAUSE_SVG;
  btn.dataset.act = resume ? 'resume' : 'pause';
  btn.disabled = !resume && !active; // nothing paused, nothing running
  btn.classList.toggle('active', resume); // paused queue is a state worth flagging
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  // Cancel-all rides the same render, and reads the same two facts. It covers
  // strictly more than pause does — paused items are outstanding downloads too —
  // so it stays live whenever there is anything running OR anything parked.
  const cancelBtn = els.queueCancel;
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = !active && paused === 0;
  }
}

els.queueCancel?.addEventListener('click', async () => {
  const ok = await askConfirm({
    title: t('cancelAllConfirm.title'),
    sub: t('cancelAllConfirm.sub'),
    confirm: t('queue.cancelAll'),
    danger: true,
  });
  if (!ok) return;
  els.queueCancel.disabled = true;
  try {
    const res = await apiFetch('/api/queue/cancel', { method: 'POST' });
    if (!res.ok) { toast(t('toast.saveFail'), 'error'); return; }
    const data = await res.json().catch(() => ({}));
    toast(t('toast.canceledN', { n: data.canceled ?? 0 }), 'ok');
    // Same reasoning as the pause toggle: the server decided what the signal
    // covered, so re-read rather than guess which rows changed.
    await Promise.all([loadStats(), softRefresh()]);
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
  } finally {
    renderQueueToggle();
  }
});

els.queueToggle?.addEventListener('click', async () => {
  const resume = els.queueToggle.dataset.act === 'resume';
  els.queueToggle.disabled = true;
  try {
    const res = await apiFetch('/api/queue/' + (resume ? 'resume' : 'pause'), { method: 'POST' });
    if (!res.ok) { toast(t('toast.saveFail'), 'error'); return; }
    const data = await res.json().catch(() => ({}));
    const n = resume ? data.resumed : data.paused;
    toast(t(resume ? 'toast.resumedN' : 'toast.pausedN', { n: n ?? 0 }), 'ok');
    // Re-read rather than guess: the server decided what the signal covered, and
    // its paused count is what the button's next state has to agree with.
    await Promise.all([loadStats(), softRefresh()]);
  } catch (e) {
    if (!isUnauthorized(e)) toast(t('toast.network'), 'error');
  } finally {
    // Re-derive rather than blindly re-enable: whether this button should now be
    // live depends on what the queue looks like after the signal, and that's the
    // one place that decides it.
    renderQueueToggle();
  }
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

// ---- Saving to the device -------------------------------------------------
// In a browser, saving is `<a href download>` and the browser does the rest.
// An Android WebView has NO download manager and Tauri registers no
// DownloadListener, so that anchor click is swallowed silently — which is why
// the Save button did nothing at all in the app. There, hand the same tokenised
// URL to the native saver (Downloads/Orca, or the hidden .Orca).
//
// Scoped to Android on purpose: desktop Tauri's webview does honour `download`,
// and the native saver is Android-only.
function isAndroidApp(): boolean {
  return !!window.__TAURI__?.core?.invoke && /Android/i.test(navigator.userAgent);
}

// Only a fallback: the server sends the real filename in Content-Disposition,
// which the native side prefers. This is what a notification shows meanwhile.
function saveLabel(item: Item): string {
  return item.title || item.slug || 'Orca download';
}

/**
 * Hand `items` to the native saver, guiding the user through the storage grant
 * first if it's missing. Without that grant the write fails with an opaque
 * EACCES — the "silently does nothing" failure this whole path exists to kill.
 */
async function saveItemsNative(items: Item[]): Promise<void> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke) return;
  let status = await refreshAppPermissions();
  if (!status?.storage) {
    toast(t('toast.storageNeeded'), 'info');
    await requestAppPermission('storage');
    status = await refreshAppPermissions();
    // On Android 11+ the grant happens on a Settings screen, so it is normal to
    // arrive here still ungranted; the user re-taps Save once they're back.
    if (!status?.storage) return;
  }
  try {
    for (const it of items) {
      // slug + height let the native side file this under the item, so playback
      // can find it later and a taller save can recognise itself as a
      // replacement for this one rather than a second copy.
      await T.core.invoke('save_media', {
        url: fileUrl(it, true),
        name: saveLabel(it),
        slug: it.slug,
        height: it.height || 0,
      });
    }
    toast(t('toast.savingN', { n: items.length }), 'ok');
    watchForSaves(items.map((it) => it.slug));
  } catch (_) {
    toast(t('toast.saveToDeviceFail'), 'error');
  }
}

/**
 * Turn the Save icons green once the transfers actually finish. The native saver
 * is fire-and-forget — it hands off to a foreground service and returns long
 * before any bytes land — and it reports completion through a notification, not
 * back to the WebView. So poll, but only while a save this tap started is still
 * outstanding, and give up after a few minutes so a failed save can't leave a
 * timer running for the life of the session.
 */
function watchForSaves(slugs: string[]): void {
  const waiting = new Set(slugs);
  const deadline = Date.now() + 5 * 60_000;
  const tick = window.setInterval(() => {
    for (const slug of waiting) if (localIndex.get(slug)) waiting.delete(slug);
    if (!waiting.size || Date.now() > deadline) { clearInterval(tick); return; }
    for (const slug of waiting) localFp.delete(slug);
    state.items.forEach((it) => { if (waiting.has(it.slug)) queueLocalScan(it); });
  }, 2000);
}

// Save every item that still has a local file (the current selection, or an
// explicit list — used to download a whole fold). Staggered so the browser
// doesn't drop rapid concurrent downloads.
function batchDownload(source?: Item[]): void {
  const items = (source ?? selectedItems()).filter((it) => it.status === 'completed' && it.local_available);
  if (!items.length) { toast(t('toast.noDownloadable'), 'info'); return; }
  if (isAndroidApp()) { saveItemsNative(items); return; }
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
  // Kills live links other people may be holding, and a new one won't have the
  // old URL. The single-item Stop sharing has always confirmed; doing N at once
  // is strictly worse to get wrong, so it confirms too.
  const confirmed = await askConfirm({
    title: t('unshareConfirm.title'),
    sub: t('unshareConfirm.sub', { n: items.length }),
    confirm: t('sel.unshare'),
    danger: true,
  });
  if (!confirmed) return;
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
// Sum the local file sizes an action would reclaim, so its confirm can state how
// much space it frees (the file-manager convention for a destructive delete).
function freedBytes(ids: number[]): number {
  return ids.reduce((sum, id) => {
    const it = state.items.get(id);
    return sum + (it?.total_filesize || it?.filesize || 0);
  }, 0);
}

async function openDeleteConfirm(ids: number[]): Promise<void> {
  const n = ids.length;
  if (!n) return;
  const freed = freedBytes(ids);
  const sub = t('deleteConfirm.sub', { n });
  const ok = await askConfirm({
    title: t('deleteConfirm.title'),
    sub: freed > 0 ? sub + ' ' + t('deleteConfirm.frees', { size: fmtSize(freed) }) : sub,
    confirm: t('deleteConfirm.confirm'),
    danger: true,
  });
  if (ok) batchDelete(ids);
}

// Delete every video of a playlist fold (its child ids), behind the confirm.
function deleteGroup(gkey: string): void {
  openDeleteConfirm(groupChildIds(gkey));
}

// DELETE every confirmed item, removing its local file too (the backend no-ops
// safely when there's no file, so this just clears the record then). Rows drop
// from the list as they succeed.
async function batchDelete(ids: number[]): Promise<void> {
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
  // Erases the downloaded file of every selected item. Nothing about that is
  // reversible without re-downloading, so it asks first — same as Delete does.
  const freed = freedBytes(ids);
  const sub = t('cleanConfirm.sub', { n: ids.length });
  const confirmed = await askConfirm({
    title: t('cleanConfirm.title'),
    sub: freed > 0 ? sub + ' ' + t('deleteConfirm.frees', { size: fmtSize(freed) }) : sub,
    confirm: t('sel.clean'),
    danger: true,
  });
  if (!confirmed) return;
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
  // Also runs when a fold advances to the next clip, so the previous item's
  // tracks never carry over.
  clearSubtitles();
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

  // Prefer a copy already on this device: it starts instantly, costs no data,
  // and works with the server unreachable. Everything below is the fallback for
  // when there is no local file.
  if (!playLocal(id, v, play)) {
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
      loadSubtitles(id);
    }
  }
}

// ---- Local copies on this device (Android app) ----------------------------
// Which items already exist as files in Downloads/Orca. Two things hang off it:
// the Save icon goes green (and stops re-downloading) once a copy is here, and
// the player prefers that copy over streaming from the server.
//
// The device can't answer this from a slug alone: it only recorded the saves
// made through this build, so a folder full of videos from an earlier build read
// as "not downloaded" and streamed anyway. So the server now fingerprints every
// item it returns (filename + exact byte size) and the app matches that against
// the folder — one directory listing per batch, no file ever opened. See
// MediaSaver.FolderIndex, which also explains why size alone settles the
// resolution question.
//
// `url` is a loopback address served by the app itself, NOT `convertFileSrc()`:
// Android's WebView routes <video> through a media stack that never consults the
// asset-protocol interceptor, so an asset:// URL fetches fine and plays never.
// See LocalMediaServer.kt.
interface LocalCopy { url: string; height: number }

// slug → the local copy, or null for "asked, there isn't one". Absent means
// not asked yet, which is what makes this a cache rather than a guess.
const localIndex = new Map<string, LocalCopy | null>();
// slug → the fingerprint the answer in localIndex was computed from. A
// resolution change rewrites an item's file, so its old verdict must not stand.
const localFp = new Map<string, string>();

function fingerprint(it: Item): string {
  return `${it.filename || ''}|${it.filesize || 0}`;
}

// Items waiting to be asked about, coalesced so that rendering a page of ten
// costs one round trip (and one directory listing) rather than ten.
let localQueue: Item[] = [];
let localTimer = 0;

function queueLocalScan(item: Item): void {
  if (!isAndroidApp() || item.status !== 'completed') return;
  // Cloud-only items are asked about too, and deliberately: the server having
  // pruned its copy says nothing about this device, which may still hold a save
  // from before the prune. It just can't be *adopted* — with no server file
  // there's no fingerprint to match — so only the registry can answer, which is
  // exactly what an empty name/size makes happen.
  if (localFp.get(item.slug) === fingerprint(item)) return; // already answered
  localQueue.push(item);
  if (localTimer) return;
  localTimer = window.setTimeout(() => {
    localTimer = 0;
    const batch = localQueue;
    localQueue = [];
    void scanLocal(batch);
  }, 0);
}

async function scanLocal(batch: Item[]): Promise<void> {
  const T = window.__TAURI__;
  if (!T?.core?.invoke || !batch.length) return;
  // Last write wins if the same item was queued twice in one tick (an upsert
  // racing a progress tick), so the index can't end up holding a stale verdict.
  const items = [...new Map(batch.map((it) => [it.slug, it])).values()];
  let res: Array<{ url?: string; height?: number }>;
  try {
    res = await T.core.invoke('local_files', {
      items: items.map((it) => ({
        slug: it.slug,
        name: it.filename || '',
        size: it.filesize || 0,
        height: it.height || 0,
      })),
    }) as Array<{ url?: string; height?: number }>;
  } catch (_) {
    return; // leave them unanswered; the next render asks again
  }
  items.forEach((it, i) => {
    const r = res?.[i];
    localIndex.set(it.slug, r?.url ? { url: r.url, height: r.height || 0 } : null);
    localFp.set(it.slug, fingerprint(it));
    paintLocalMark(it);
  });
}

// Green Save icon on the card for an item whose file is already on this device.
// Painted here rather than in rowHtml because the answer arrives after the row
// does — and repainting the row wholesale would re-request its thumbnail.
function paintLocalMark(item: Item): void {
  const save = state.rows.get(item.id)?.querySelector('.act-save');
  save?.classList.toggle('act-local', !!localIndex.get(item.slug));
}

/**
 * Re-ask about everything on screen. Saves land asynchronously (DownloadService
 * writes the file long after the tap returns) and the user can delete files from
 * a file manager behind our back, so the index is refreshed whenever the app
 * comes back to the foreground rather than trusted forever.
 */
function refreshLocalIndex(): void {
  if (!isAndroidApp()) return;
  localFp.clear();
  state.items.forEach((it) => queueLocalScan(it));
}

/**
 * The file saved on this device for an item, or null. Android app only —
 * everywhere else there is no local-save path, so this is always null and the
 * caller falls through to the server.
 *
 * Answered from the index rather than by asking the device again: by the time a
 * card can be tapped its row has already been scanned.
 */
function localFileFor(slug: string | undefined): LocalCopy | null {
  return (slug && localIndex.get(slug)) || null;
}

/**
 * Point the player at the on-device copy, if there is one. Returns whether it
 * took over, so the caller can fall back to the server when it didn't.
 */
function playLocal(id: number, v: HTMLVideoElement, play: () => void): boolean {
  const local = localFileFor(state.items.get(id)?.slug);
  if (!local) return false;
  v.src = local.url;
  v.load();
  play();
  loadSubtitles(id);
  return true;
}

// Attach the item's subtitle sidecars as <track> elements. Local playback only:
// a cloud/stream item has no sidecars on disk. Subtitles are also muxed into the
// file itself (yt-dlp `--embed-subs`), but the browser won't surface embedded
// tracks from a progressive <video>, so the preview needs them served alongside.
// Best-effort — a failure here must never break playback.
async function loadSubtitles(id: number): Promise<void> {
  const slug = state.items.get(id)?.slug;
  if (!slug || !getToken()) return;
  try {
    const res = await apiFetch(itemPath(id, '/subs'));
    if (!res.ok) return;
    const data = await res.json();
    const subs: Array<{ lang: string; label: string }> = data.subs || [];
    // The player may have moved on (closed, or advanced to the next clip of a
    // fold) while this was in flight — don't graft stale tracks onto it.
    if (els.player.classList.contains('hidden')) return;
    if (playQueue.length && playQueue[playIndex]?.id !== id) return;
    const tok = encodeURIComponent(getToken());
    subs.forEach((s, i) => {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = s.lang;
      track.label = s.label || s.lang;
      // Token rides in the query — a <track> can't set headers, same as <video>.
      track.src = apiUrl(itemPath(id, '/subs/' + encodeURIComponent(s.lang)) + '?token=' + tok);
      if (i === 0) track.default = true;
      els.playerVideo.appendChild(track);
    });
  } catch (_) { /* no subtitles is a normal, silent outcome */ }
}

// Drop any <track> elements from a previous item so they can't bleed into the
// next one.
function clearSubtitles(): void {
  els.playerVideo.querySelectorAll('track').forEach((tr) => tr.remove());
}

// Hide the player and release the media. `pop` true rewinds the history entry
// we pushed (used when closing via the ✕ button; the back button already popped).
function closePlayer(pop: boolean): void {
  if (els.player.classList.contains('hidden')) return;
  const v = els.playerVideo;
  v.pause();
  v.removeAttribute('src');
  v.removeAttribute('poster');
  clearSubtitles();
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
  if (!els.confirmBox.classList.contains('hidden')) { settleConfirm(false); return true; }
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
  // Coming back to the app is also when the local-copy index is most likely to
  // be wrong: a save may have finished in the background, or the user may have
  // been in a file manager deleting things. Both are answered by re-asking.
  const refresh = () => { setTimeout(refreshAppPermissions, 100); refreshLocalIndex(); };
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

// ---- Language (Settings › Appearance) -------------------------------------
// The app already follows the OS: i18n.ts picks the closest supported locale out
// of navigator.languages on load, which in the Android WebView tracks the system
// language. This picker only exists to override that, so it defaults to "Auto
// (system)" and lives in Settings rather than costing a permanent topbar button.
function renderLangSelect(): void {
  if (!els.langSelect) return;
  const pref = window.i18n.langPref();
  const langs = window.i18n.supported();
  const rows: [string, string][] = [
    ['auto', t('lang.auto')],
    ...Object.keys(langs).map((code) => [code, langs[code]!.label] as [string, string]),
  ];
  els.langSelect.innerHTML = rows
    .map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`)
    .join('');
  els.langSelect.value = pref;
}

if (els.langSelect) {
  // Applied on the spot: a language you have to press Save to see would be a
  // worse experience than the topbar button this replaced.
  els.langSelect.addEventListener('change', () => window.i18n.setLang(els.langSelect.value));
}

// ---- Theme (Settings › Appearance) ----------------------------------------
// Follows the OS by default via prefers-color-scheme (see style.css) — including
// in the Android WebView, which tracks the system dark-mode setting. The
// segmented picker only overrides that: a forced choice sets html[data-theme],
// and "System" removes it so prefers-color-scheme governs again.
const THEME_KEY = 'orca_theme';
migrateLegacyStorage(THEME_KEY, 'theme');

function themePref(): string { return localStorage.getItem(THEME_KEY) || 'system'; }

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

function renderThemePicker(): void {
  const pref = themePref();
  document.querySelectorAll<HTMLInputElement>('input[name="theme-pref"]').forEach((r) => {
    r.checked = r.value === pref;
  });
}

document.querySelectorAll<HTMLInputElement>('input[name="theme-pref"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    localStorage.setItem(THEME_KEY, radio.value);
    applyTheme();
  });
});

// Re-resolve when the system theme flips while we're following it. Without this
// the WebView repaints its own colours but our theme-color meta goes stale.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref() === 'system') applyTheme();
  });
}

// Re-render everything that isn't covered by static [data-i18n] markup whenever
// the language changes: the server-status label, live list rows (badges), the
// language picker's own "Auto (system)" row, and the website list if it's open.
document.addEventListener('i18n:changed', () => {
  renderLangSelect();
  renderFilterMenu(); // its rows are built from t(), not [data-i18n] markup
  renderArchiveRestore();
  renderAppPermissions();
  setServerStatus(serverUp);
  renderDlStats(); // re-localize the "N items · X GB" summary
  if (getToken()) loadItems(true);
  if (!els.websites.classList.contains('hidden')) loadWebsites();
});

// ---- Auto-refresh ---------------------------------------------------------
// ONE polling cycle for the whole client, on both web and the app: every 30s,
// everything that has to reconcile with the server does it on this tick and
// nothing keeps a timer of its own. SSE still delivers live updates the moment
// they happen — this is the safety net behind it, so a dropped or idle stream
// never leaves the UI stale.
//
// The tick drives two fetches, and they are deliberately NOT merged into one
// request. They answer to different conditions: the header readout (storage
// gauge + the paused count behind the global pause button) must stay truthful no
// matter where the user is, while the list refresh is the gentle
// background-refresh pattern — it holds off while the tab is hidden, while a
// search is active, or while the user is scrolled into older pages, because
// rebuilding the list under them is worse than a slightly stale one. Folding the
// readout into the list response would mean the gauge froze for exactly the
// users who scrolled away, which is when a filling disk matters most.
const AUTO_REFRESH_MS = 30 * 1000;
let lastAutoRefresh = Date.now();

function autoRefresh(): void {
  // Nothing to poll for while backgrounded or signed out; the visibilitychange
  // handler below catches the client up the moment it comes back.
  if (document.hidden || !getToken()) return;
  lastAutoRefresh = Date.now();
  loadStats(); // cheap aggregate; runs every tick so the gauge never goes stale
  if (state.loading) return;
  if (state.q) return;              // don't clobber an active search
  if (window.scrollY > 200) return; // user is browsing older pages — leave them be
  softRefresh();
}

// Non-destructive page-1 refresh: reconcile the newest page in place instead of
// wiping #history and rebuilding it (the old loadItems(true), which flashed).
// Existing rows patch via upsertRow's signature guard (untouched when unchanged),
// genuinely-new rows are inserted at the top in order, and rows that vanished
// server-side within the refreshed range are removed. Rows below the first page
// (older, scroll-loaded) are left alone.
// `establishPaging` is for the one caller that isn't a poll: a boot that painted
// the list from cache. The 30s poll runs against a list loadItems already set the
// cursor for and must not touch it — but a hydrated boot has never called
// loadItems at all, so without this the cursor stays null, the loader stays
// hidden, and the list dead-ends at the cached page with no way to scroll further.
async function softRefresh(establishPaging = false): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams();
    // The poll asks the same question the visible list was built from — without
    // the filter it would prepend rows the filter excludes, quietly undoing it.
    applyFilterParams(params);
    params.set('limit', String(PAGE_SIZE));
    const res = await apiFetch('/api/items?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    const items: Item[] = data.items || [];
    cacheFirstPage(items); // keep the next boot's first paint current
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
    if (establishPaging) {
      state.cursor = data.next_cursor;
      // Keep the spinner mounted (not display:none) while more pages exist, so
      // the IntersectionObserver can see it re-enter the viewport.
      els.loader.classList.toggle('hidden', data.next_cursor == null);
      // Runs after `finally` clears state.loading, so the top-up isn't a no-op.
      requestAnimationFrame(topUpIfNeeded);
    }
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

// ---- First run ------------------------------------------------------------
// Marks the welcome window as spent, so it is a one-time event rather than
// something that returns whenever the server is briefly unreachable.
const WELCOME_KEY = 'orca_welcome_done';

function welcomeError(key: string): void {
  els.welcomeError.textContent = t(key);
  els.welcomeError.classList.remove('hidden');
}

/**
 * First run = the welcome has never been completed AND there are no credentials
 * already. The token check is what keeps an existing install — one that upgraded
 * into this build already working — from being asked to set itself up again.
 */
function needsWelcome(): boolean {
  if (localStorage.getItem(WELCOME_KEY) === '1') return false;
  if (getToken()) { localStorage.setItem(WELCOME_KEY, '1'); return false; }
  return true;
}

/**
 * Check a candidate server + token by asking that server something only a valid
 * token can answer. Deliberately not apiFetch: that reads the *saved* token and
 * throws up the Settings sheet on a 401 — the very thing this flow replaces.
 * Nothing is persisted until it comes back clean, so a typo leaves the app
 * unconfigured rather than half-configured. Returns an i18n key, '' for success.
 */
async function verifyCreds(base: string, token: string): Promise<string> {
  const path = '/api/items?limit=1';
  let res: Response;
  try {
    res = await encryptedFetch(base + path, path, token, {});
  } catch (_) {
    return 'toast.network'; // wrong host, no DNS, server down, TLS refused
  }
  if (res.status === 401) return 'settings.tokenInvalid';
  return res.ok ? '' : 'toast.loadHistoryFail';
}

async function submitWelcome(): Promise<void> {
  const base = (els.welcomeServer.value || '').trim().replace(/\/+$/, '');
  const token = (els.welcomeToken.value || '').trim();
  els.welcomeError.classList.add('hidden');
  // The same rule the Settings field enforces: a plain-http public server would
  // ship the token and cookies across the internet in the clear.
  if (isInsecurePublicBase(base)) { welcomeError('toast.insecureServer'); return; }
  if (!token) { welcomeError('settings.tokenInvalid'); return; }
  els.welcomeStart.disabled = true;
  const err = await verifyCreds(base, token);
  els.welcomeStart.disabled = false;
  if (err) { welcomeError(err); return; }
  setApiBase(base);
  setToken(token);
  // Verified, so the permission prompt is marked seen as well: the user was just
  // asked, here. A second modal asking the same thing as this one closes reads as
  // a bug rather than as thoroughness.
  localStorage.setItem(WELCOME_KEY, '1');
  localStorage.setItem(PERMISSION_PROMPT_NEVER, '1');
  closeModal(els.welcome);
  startApp(); // everything checks out → the main page, populated
}

function openWelcome(): void {
  els.welcomeServer.value = apiBase();
  // Permissions are an Android concept here; the browser build has nothing to ask
  // for at this point and an empty section would just be furniture.
  els.welcomePerms.classList.toggle('hidden', !isNativeApp);
  openModal(els.welcome);
  if (isNativeApp) void refreshAppPermissions();
  els.welcomeToken.focus();
}

els.welcomeStart.addEventListener('click', () => void submitWelcome());

// ---- Boot -----------------------------------------------------------------
// Everything the main page needs once there are credentials to use it with.
// Called straight away by an already-configured install, and by the welcome
// window the moment it becomes configured — so a first run lands on a populated
// page instead of an empty one waiting to be reloaded.
function startApp(): void {
  loadServerConfig();
  connectEvents();
  // Paint the last known page before the network answers, then reconcile it
  // (see hydrateFromCache). Only a cold client rebuilds the list outright.
  if (hydrateFromCache()) void softRefresh(true); else void loadItems(true);
  loadStats();
  if (getToken()) loadWebsites(); // per-site privacy-blur state for the home list
}

applyTheme();                // resolve theme before first paint work
window.i18n.apply(document); // localize the static markup before anything shows
renderThemePicker();
renderLangSelect();
renderFilterMenu();
setServerStatus(false);      // start red; SSE onopen flips it green when live
const welcoming = needsWelcome();
if (welcoming) openWelcome(); else startApp();
handleShareParam();
setupNativeShare();
// The welcome window asks for permissions itself — a prompt stacked on top of it
// would be the same question twice, in two windows.
if (!welcoming) setupAppPermissionRefresh();
setupDeepLinks();
