// Popup: first-launch welcome (server + token -> E2EE handshake), the Connection
// tab (edit connection + feature toggles), and the Website-management tab
// (per-site cookies, resolution/quality/format/subtitle/blur), all driven
// through the background over the same secure channel as the web UI.

import { iconEl, setIcon, type IconName } from '../lib/icons.js';
import { isPrivateHost, looksLikeMediaPage } from '../lib/net.js';
import type {
  BgResponse,
  FeatureFlags,
  Item,
  Status,
  StoredConfig,
  SubmitResult,
  Website,
} from '../lib/types.js';

// Mirror of the background's defaults, so the popup can paint straight from
// storage without a round-trip (see readStoredConfig).
const DEFAULT_FEATURES: FeatureFlags = {
  toolbarStatus: true,
  inpageButton: true,
  websiteManagement: true,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// Paint every declarative `data-ico="name"` slot with its lucide icon, and wire
// each password field's reveal (eye) toggle so a token can be viewed temporarily.
function initIcons(): void {
  for (const node of Array.from(document.querySelectorAll('[data-ico]')))
    setIcon(node, (node as HTMLElement).dataset.ico as IconName);
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.reveal-btn'))) {
    const input = document.getElementById(btn.dataset.reveal!) as HTMLInputElement | null;
    if (!input) continue;
    setIcon(btn, 'eye');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      setIcon(btn, show ? 'eyeOff' : 'eye');
      btn.title = show ? 'Hide token' : 'Show token';
      btn.setAttribute('aria-label', btn.title);
    });
  }
}

async function send<T>(msg: unknown): Promise<T> {
  const resp = (await browser.runtime.sendMessage(msg)) as BgResponse<T>;
  if (!resp.ok) {
    const e = new Error(resp.error) as Error & { status?: number };
    e.status = resp.status;
    throw e;
  }
  return resp.data;
}

interface ConfigView {
  base: string;
  welcomeDone: boolean;
  features: FeatureFlags;
  hasToken: boolean;
}

let cfg: ConfigView;

// ---- welcome ----

async function doConnect(serverId: string, tokenId: string, errId: string): Promise<boolean> {
  const base = ($(serverId) as HTMLInputElement).value.trim().replace(/\/+$/, '');
  const token = ($(tokenId) as HTMLInputElement).value.trim();
  const err = $(errId);
  err.textContent = '';
  if (!base) {
    err.textContent = 'Enter your Orca server URL.';
    return false;
  }
  if (!/^https?:\/\//.test(base)) {
    err.textContent = 'Server URL must start with http:// or https://.';
    return false;
  }
  if (!token) {
    err.textContent = 'Enter your API token.';
    return false;
  }
  err.textContent = 'Connecting…';
  try {
    const { result } = await send<{ result: string }>({ type: 'validate', base, token });
    if (result === 'token') {
      err.textContent = 'Invalid token.';
      return false;
    }
    if (result === 'network') {
      err.textContent = 'Could not reach the server.';
      return false;
    }
    if (result === 'server') {
      err.textContent = 'Server error — check the URL.';
      return false;
    }
    await send({ type: 'setConnection', base, token });
    err.textContent = '';
    return true;
  } catch (e) {
    err.textContent = (e as Error).message;
    return false;
  }
}

// ---- tabs ----

const TAB_NAMES = ['downloads', 'websites', 'connection'] as const;

function showTab(name: string): void {
  for (const t of Array.from(document.querySelectorAll('.tab')))
    t.classList.toggle('active', (t as HTMLElement).dataset.tab === name);
  for (const n of TAB_NAMES) $(`tab-${n}`).classList.toggle('hidden', n !== name);
  if (name === 'websites') void loadWebsites();
  if (name === 'downloads') void loadDownloads();
}

function initTabs(): void {
  for (const tab of Array.from(document.querySelectorAll('.tab')))
    tab.addEventListener('click', () => showTab((tab as HTMLElement).dataset.tab!));
}

// ---- connection tab ----

function initConnection(): void {
  ($('c-server') as HTMLInputElement).value = cfg.base;
  const featureIds: (keyof FeatureFlags)[] = [
    'toolbarStatus',
    'inpageButton',
    'websiteManagement',
  ];
  for (const f of featureIds) {
    const box = $(`f-${f}`) as HTMLInputElement;
    box.checked = cfg.features[f];
    box.addEventListener('change', () => {
      void send({ type: 'setFeatures', features: { [f]: box.checked } });
      cfg.features[f] = box.checked;
      if (f === 'websiteManagement') applyFeatureVisibility();
    });
  }
  $('c-save').addEventListener('click', async () => {
    if (await doConnect('c-server', 'c-token', 'c-err')) {
      ($('c-err') as HTMLElement).textContent = 'Saved.';
      void refreshStatus();
    }
  });
}

function applyFeatureVisibility(): void {
  const tab = document.querySelector('.tab[data-tab="websites"]') as HTMLElement;
  tab.classList.toggle('hidden', !cfg.features.websiteManagement);
}

async function refreshStatus(): Promise<void> {
  const pill = $('conn-status');
  const label = $('conn-label');
  try {
    await send({ type: 'listWebsites' });
    pill.className = 'status up';
    label.textContent = 'connected';
  } catch {
    pill.className = 'status down';
    label.textContent = 'offline';
  }
}

// ---- websites tab ----

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let sites: Website[] = [];
let filter = '';

async function loadWebsites(): Promise<void> {
  try {
    const { websites } = await send<{ websites: Website[] }>({ type: 'listWebsites' });
    sites = websites;
    renderSites();
  } catch (e) {
    $('site-list').textContent = '';
    const p = el('p', 'empty', (e as Error).message);
    $('site-list').appendChild(p);
  }
}

async function patchSite(key: string, body: Record<string, unknown>): Promise<void> {
  await send({ type: 'upsertWebsite', key, body });
  await loadWebsites();
}

function cookieDotClass(w: Website): string {
  const c = w.cookie;
  if (!c || !c.present) return 'ck-dot';
  if (!c.enabled) return 'ck-dot disabled';
  const now = Date.now() / 1000;
  if (c.expires_at != null && c.expires_at < now) return 'ck-dot expired';
  if (c.expires_at != null && c.expires_at - now < 3 * 86400) return 'ck-dot expiring';
  return 'ck-dot present';
}

// Cookie-focused site card. The full per-site settings (resolution, format,
// subtitles, blur…) live in the web dashboard; the popup stays about cookies.
function cookieStatusText(w: Website): string {
  const c = w.cookie;
  if (!c || !c.present) return 'No cookies';
  const now = Date.now() / 1000;
  if (c.expires_at != null && c.expires_at < now) return 'Cookies expired';
  if (!c.enabled) return 'Cookies disabled';
  if (c.expires_at != null && c.expires_at - now < 3 * 86400) return 'Cookies expiring soon';
  return 'Cookies active';
}

// Close any open per-card overflow menu (a click anywhere else dismisses it).
function closeSiteMenus(except?: Element): void {
  for (const m of Array.from(document.querySelectorAll('.more-menu')))
    if (m !== except) m.classList.add('hidden');
}
document.addEventListener('click', () => closeSiteMenus());

function renderSite(w: Website): HTMLElement {
  const card = el('div', 'site-card' + (w.enabled ? '' : ' disabled'));

  // Header: site identity on the left, the on/off switch right-aligned — the
  // control sits where the eye lands last, the way most settings lists do it.
  const head = el('div', 'site-head');
  const id = el('div', 'site-id');
  id.appendChild(el('div', 'site-name', w.name));
  id.appendChild(el('div', 'site-hosts', w.hosts.join(', ') || '—'));
  head.appendChild(id);
  const sw = el('button', 'switch' + (w.enabled ? ' on' : ''));
  sw.appendChild(el('span', 'knob'));
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(w.enabled));
  sw.title = w.enabled ? 'Disable site' : 'Enable site';
  sw.setAttribute('aria-label', sw.title);
  sw.addEventListener('click', () => void patchSite(w.key, { enabled: !w.enabled }));
  head.appendChild(sw);
  card.appendChild(head);

  // Cookie status line (+ compact enable/disable toggle when cookies are present).
  const ck = el('div', 'ck-row');
  ck.appendChild(el('span', cookieDotClass(w)));
  ck.appendChild(el('span', 'ck-status', cookieStatusText(w)));
  if (w.cookie?.present) {
    const t = el('button', 'switch switch-sm' + (w.cookie.enabled ? ' on' : ''));
    t.appendChild(el('span', 'knob'));
    t.setAttribute('role', 'switch');
    t.setAttribute('aria-checked', String(w.cookie.enabled));
    t.title = w.cookie.enabled ? 'Disable cookies' : 'Enable cookies';
    t.setAttribute('aria-label', t.title);
    t.addEventListener('click', async () => {
      await send({ type: 'toggleCookies', key: w.key, enabled: !w.cookie!.enabled });
      await loadWebsites();
    });
    ck.appendChild(t);
  }
  card.appendChild(ck);

  // Manual cookie import — a paste box that saves itself (on blur / paste), so
  // there's no separate Save button to hunt for.
  const paste = el('textarea', 'ck-paste hidden') as HTMLTextAreaElement;
  paste.rows = 3;
  paste.placeholder = 'Paste cookies (Netscape cookies.txt or a Cookie: header) — saved automatically.';
  let saving = false;
  const autoSave = async (): Promise<void> => {
    const value = paste.value.trim();
    if (!value || saving) return;
    saving = true;
    try {
      await send({ type: 'setCookies', key: w.key, cookies: paste.value });
      await loadWebsites(); // re-render reflects the new (green) cookie status
    } finally {
      saving = false;
    }
  };
  paste.addEventListener('blur', () => void autoSave());
  paste.addEventListener('paste', () => setTimeout(() => void autoSave(), 250));

  // Actions: the everyday one (import) up front; the rarer/destructive ones fold
  // into an overflow menu so the card stays quiet.
  const actions = el('div', 'card-actions');
  const importBtn = el('button', 'btn btn-soft', w.cookie?.present ? 'Replace cookies' : 'Manual import');
  importBtn.addEventListener('click', () => {
    const hidden = paste.classList.toggle('hidden');
    if (!hidden) paste.focus();
  });
  actions.appendChild(importBtn);
  actions.appendChild(el('span', 'flex-spacer'));

  const moreWrap = el('div', 'more-wrap');
  const moreBtn = el('button', 'icon-btn');
  moreBtn.appendChild(iconEl('more'));
  moreBtn.title = 'More actions';
  moreBtn.setAttribute('aria-label', 'More actions');
  const menu = el('div', 'more-menu hidden');
  const addItem = (label: string, icon: IconName, danger: boolean, onClick: () => void): void => {
    const b = el('button', 'more-item' + (danger ? ' danger' : ''));
    b.appendChild(iconEl(icon));
    b.appendChild(el('span', '', label));
    b.addEventListener('click', () => {
      menu.classList.add('hidden');
      onClick();
    });
    menu.appendChild(b);
  };
  if (w.login_url)
    addItem('Log in to site', 'login', false, () => window.open(w.login_url, '_blank', 'noopener'));
  if (w.cookie?.present)
    addItem('Forget cookies', 'cookie', true, () =>
      void send({ type: 'deleteCookies', key: w.key }).then(() => loadWebsites()),
    );
  addItem('Delete site', 'trash', true, () => {
    if (!confirm(`Delete site "${w.name}"?`)) return;
    void send({ type: 'deleteWebsite', key: w.key }).then(() => loadWebsites());
  });
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.classList.contains('hidden');
    closeSiteMenus();
    menu.classList.toggle('hidden', !willOpen);
  });
  moreWrap.appendChild(moreBtn);
  moreWrap.appendChild(menu);
  actions.appendChild(moreWrap);

  card.appendChild(actions);
  card.appendChild(paste);
  return card;
}

function renderSites(): void {
  const list = $('site-list');
  list.textContent = '';
  const f = filter.toLowerCase();
  const shown = sites.filter(
    (w) =>
      !f ||
      w.name.toLowerCase().includes(f) ||
      w.hosts.some((h) => h.toLowerCase().includes(f)),
  );
  $('site-empty').classList.toggle('hidden', shown.length > 0);
  for (const w of shown) list.appendChild(renderSite(w));
}

function initWebsites(): void {
  $('s-extract').addEventListener('click', async () => {
    const msg = $('s-extract-msg');
    const url = await currentTabUrl();
    if (!/^https?:\/\//.test(url)) {
      msg.textContent = 'Open a site page first.';
      msg.className = 'quick-msg err';
      return;
    }
    msg.textContent = 'Extracting cookies…';
    msg.className = 'quick-msg';
    try {
      const r = await send<{ key: string; name: string; count: number; created: boolean }>({
        type: 'extractCookies',
        url,
      });
      msg.textContent = `Imported ${r.count} cookies into ${r.name}${r.created ? ' (new site)' : ''}.`;
      msg.className = 'quick-msg ok';
      await loadWebsites();
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = 'quick-msg err';
    }
  });
  ($('s-search') as HTMLInputElement).addEventListener('input', (e) => {
    filter = (e.target as HTMLInputElement).value;
    renderSites();
  });
  $('s-add').addEventListener('click', () => $('site-add-form').classList.toggle('hidden'));
  $('sa-cancel').addEventListener('click', () => $('site-add-form').classList.add('hidden'));
  $('sa-save').addEventListener('click', async () => {
    const name = ($('sa-name') as HTMLInputElement).value.trim();
    const key = ($('sa-key') as HTMLInputElement).value.trim();
    const hosts = ($('sa-hosts') as HTMLTextAreaElement).value.trim();
    const err = $('sa-err');
    if (!/^[a-z0-9_]+$/.test(key)) {
      err.textContent = 'Key must be lowercase letters, digits, or underscore.';
      return;
    }
    err.textContent = '';
    try {
      await send({ type: 'upsertWebsite', key, body: { name: name || key, hosts, enabled: true } });
      ($('sa-name') as HTMLInputElement).value = '';
      ($('sa-key') as HTMLInputElement).value = '';
      ($('sa-hosts') as HTMLTextAreaElement).value = '';
      $('site-add-form').classList.add('hidden');
      await loadWebsites();
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  });
}

// ---- quick download (current tab) ----

async function currentTabUrl(): Promise<string> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url ?? '';
  } catch {
    return '';
  }
}

// Does the current-tab host already have usable (present, enabled, unexpired)
// cookies on file? If so there's nothing to offer for a non-video page.
async function siteHasValidCookies(host: string): Promise<boolean> {
  try {
    const { websites } = await send<{ websites: Website[] }>({ type: 'listWebsites' });
    const now = Date.now() / 1000;
    return websites.some((w) => {
      const c = w.cookie;
      if (!c?.present || !c.enabled) return false;
      if (c.expires_at != null && c.expires_at < now) return false;
      return w.hosts.some((h) => {
        const b = h.replace(/^\./, '');
        return host === b || host.endsWith('.' + b);
      });
    });
  } catch {
    return false;
  }
}

function wireDownload(btn: HTMLButtonElement, msg: HTMLElement, url: string): void {
  btn.onclick = async (): Promise<void> => {
    btn.disabled = true;
    msg.textContent = 'Submitting…';
    msg.className = 'quick-msg';
    try {
      const res = await send<SubmitResult>({ type: 'submit', url });
      msg.textContent = res.duplicate ? 'Already in your library.' : 'Queued for download.';
      msg.className = 'quick-msg ok';
      showTab('downloads');
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = 'quick-msg err';
    } finally {
      btn.disabled = false;
    }
  };
}

// The "Current page" card is adaptive and stays hidden until it knows what to
// offer (never a reckless flash of the wrong control):
//   • an identifiable single video → dedup + status: show its "already saved"
//     Play shortcut if downloaded, else a Download button;
//   • anything ambiguous (feed / home / playlist / search) → don't guess a
//     download. Offer cookie extraction instead — unless the site already has
//     valid cookies, in which case there's nothing to do and it stays hidden.
async function initCurrentPage(): Promise<void> {
  const quick = $('quick');
  const urlEl = $('quick-url');
  const labelEl = document.querySelector('#quick .quick-label') as HTMLElement;
  const btn = $('quick-dl') as HTMLButtonElement;
  const msg = $('quick-msg');
  const url = await currentTabUrl();
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL */
  }
  // Private / non-web page: nothing downloadable here — keep the card hidden.
  if (!/^https?:\/\//.test(url) || isPrivateHost(host)) return;

  if (looksLikeMediaPage(url)) {
    urlEl.textContent = url.replace(/^https?:\/\//, '');
    urlEl.title = url;
    let item: Item | null = null;
    try {
      ({ item } = await send<{ item: Item | null }>({ type: 'lookupItem', url }));
    } catch {
      /* offline — fall through to a plain Download button */
    }
    if (item) {
      labelEl.textContent = 'Already in your library';
      btn.textContent = 'Play';
      btn.disabled = false;
      btn.onclick = (): void => void send({ type: 'openWebItem', slug: item!.slug });
    } else {
      labelEl.textContent = 'Current page';
      btn.textContent = 'Download';
      btn.disabled = false;
      wireDownload(btn, msg, url);
    }
    quick.classList.remove('hidden');
    return;
  }

  // Ambiguous page — offer cookies unless the site is already covered.
  if (await siteHasValidCookies(host)) return;
  labelEl.textContent = 'Current page';
  urlEl.textContent = host;
  urlEl.title = url;
  btn.textContent = 'Extract cookies';
  btn.disabled = false;
  btn.onclick = async (): Promise<void> => {
    btn.disabled = true;
    msg.textContent = 'Extracting cookies…';
    msg.className = 'quick-msg';
    try {
      const r = await send<{ key: string; name: string; count: number; created: boolean }>({
        type: 'extractCookies',
        url,
      });
      msg.textContent = `Imported ${r.count} cookies into ${r.name}${r.created ? ' (new site)' : ''}.`;
      msg.className = 'quick-msg ok';
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = 'quick-msg err';
    } finally {
      btn.disabled = false;
    }
  };
  quick.classList.remove('hidden');
}

// ---- downloads list ----

const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  running: 'Downloading…',
  paused: 'Paused',
  canceled: 'Canceled',
  completed: 'Completed',
  failed: 'Failed',
  duplicate: 'Already saved',
};

// ---- privacy blur (mirrors the web app's tap-to-peek / hover-intent reveal) ----
//
// A download from a blur-on site (its host, or any related host in the same site
// group — the server tags the item's `blur` for us) shows blurred here too, and
// reveals with the SAME gesture as the web history: dwell to peek on pointer
// devices, tap to peek on touch, re-blurring the instant attention moves on.
const canHover = !!window.matchMedia && window.matchMedia('(hover: hover)').matches;
const BLUR_PEEK_INTENT_MS = 450;

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
function revealBlurred(elm: HTMLElement): void {
  reblurNow(); // collapse any prior peek first
  elm.classList.add('revealed');
  const timer = window.setTimeout(reblurNow, 2500); // short fallback auto-hide
  revealedPeek = { el: elm, timer };
  document.addEventListener('pointerdown', onOutsidePeek, true);
  window.addEventListener('scroll', reblurNow, true);
}

let hoverPeek: { row: HTMLElement; timer: number } | null = null;
function clearHoverPeek(): void {
  if (!hoverPeek) return;
  clearTimeout(hoverPeek.timer);
  hoverPeek.row.classList.remove('peek');
  hoverPeek = null;
}
function armHoverPeek(row: HTMLElement): void {
  if (hoverPeek?.row === row) return; // already dwelling on this row
  clearHoverPeek();
  const timer = window.setTimeout(() => row.classList.add('peek'), BLUR_PEEK_INTENT_MS);
  hoverPeek = { row, timer };
}
function initBlurPeek(): void {
  if (!canHover) return;
  const list = $('dl-list');
  list.addEventListener('mouseover', (e) => {
    const row = (e.target as HTMLElement).closest('.dl-row.blurred') as HTMLElement | null;
    if (!row) {
      clearHoverPeek();
      return;
    }
    armHoverPeek(row);
  });
  list.addEventListener('mouseout', (e) => {
    const row = (e.target as HTMLElement).closest('.dl-row.blurred') as HTMLElement | null;
    if (!row) return;
    const to = e.relatedTarget as Node | null;
    if (to && row.contains(to)) return; // still inside the row — keep peeking
    clearHoverPeek();
  });
}

// A row is "unblurred" while it's peeked (hover-intent) or revealed (tapped) —
// the only states in which a blurred item is allowed to open.
function isUnblurred(row: HTMLElement): boolean {
  return row.classList.contains('peek') || row.classList.contains('revealed');
}

// Decrypted-thumbnail cache, keyed by slug. `url` is the data URL (null = looked
// up, no preview); `ar` is its measured aspect ratio, kept so a re-render can
// reserve the exact box up-front and the list never reflows (a viewport-drift
// source). The cache is seeded from — and written back to — local storage, so
// re-opening the popup paints previews from disk instead of re-fetching +
// re-decrypting every one over the E2EE channel. See loadThumbCache / persistThumbCache.
interface ThumbEntry {
  url: string | null;
  ar?: number;
}
const thumbCache = new Map<string, ThumbEntry>();
const THUMB_STORE_KEY = 'orcaThumbs';
const THUMB_CACHE_MAX = 48;

async function loadThumbCache(): Promise<void> {
  try {
    const raw = (await browser.storage.local.get(THUMB_STORE_KEY)) as {
      orcaThumbs?: { base: string; entries: [string, ThumbEntry][] };
    };
    const store = raw.orcaThumbs;
    if (store && store.base === cfg.base && Array.isArray(store.entries))
      for (const [slug, e] of store.entries) if (e.url) thumbCache.set(slug, e);
  } catch {
    /* unreadable — start cold */
  }
}

let thumbPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistThumbCache(): void {
  if (thumbPersistTimer) return; // debounce a burst of image loads into one write
  thumbPersistTimer = setTimeout(() => {
    thumbPersistTimer = null;
    // Keep only real previews, most-recent last (insertion order), capped.
    const entries = [...thumbCache.entries()]
      .filter(([, e]) => e.url)
      .slice(-THUMB_CACHE_MAX);
    void browser.storage.local.set({ [THUMB_STORE_KEY]: { base: cfg.base, entries } });
  }, 400);
}

// Fetch + decrypt the item's preview through the background, then paint it. A
// missing preview collapses the card back to a plain row. The container's aspect
// ratio follows the image so portrait shorts stay tall and landscape videos wide.
async function loadThumb(
  slug: string,
  img: HTMLImageElement,
  thumb: HTMLElement,
  row: HTMLElement,
): Promise<void> {
  let entry = thumbCache.get(slug);
  // Apply the known aspect ratio immediately, before the image decodes, so the
  // card holds its final size from the first paint (no late reflow → no drift).
  if (entry?.ar) thumb.style.aspectRatio = `${entry.ar}`;
  if (entry === undefined) {
    let url: string | null;
    try {
      url = (await send<{ dataUrl: string | null }>({ type: 'thumb', slug })).dataUrl;
    } catch {
      url = null;
    }
    entry = { url };
    thumbCache.set(slug, entry);
  }
  if (!entry.url) {
    thumb.remove();
    row.classList.remove('has-thumb');
    return;
  }
  const cached = entry;
  img.addEventListener('load', () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w > 0 && h > 0) {
      const ar = Math.min(1.9, Math.max(0.62, w / h));
      thumb.style.aspectRatio = `${ar}`;
      cached.ar = ar;
    }
    thumb.classList.add('ready');
    persistThumbCache();
  });
  img.src = entry.url;
}

// One quick-action icon button on a download row (cancel / retry / delete). All
// lucide icons, matching the web dashboard's own row actions.
function dlActionBtn(
  icon: IconName,
  title: string,
  danger: boolean,
  handler: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = el('button', 'icon-btn dl-act' + (danger ? ' danger' : ''));
  b.appendChild(iconEl(icon));
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', handler);
  return b;
}

// Contextual quick actions for a download row: cancel an outstanding one, retry a
// failed/canceled one, delete anything that's no longer in flight. Each stops the
// row's play-on-click and re-loads the list so the row reflects its new state.
function buildDlActions(it: Item): HTMLElement | null {
  const wrap = el('div', 'dl-actions');
  const act =
    (type: 'cancelItem' | 'retryItem' | 'deleteItem', confirmMsg?: string) =>
    async (e: MouseEvent): Promise<void> => {
      e.stopPropagation();
      if (confirmMsg && !confirm(confirmMsg)) return;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        await send({ type, slug: it.slug });
      } catch {
        /* leave the row; the list reload below reflects the true state */
      }
      await loadDownloads();
    };
  const s = it.status;
  if (s === 'queued' || s === 'running' || s === 'paused')
    wrap.appendChild(dlActionBtn('x', 'Cancel download', false, act('cancelItem')));
  if (s === 'failed' || s === 'canceled')
    wrap.appendChild(dlActionBtn('refresh', 'Retry download', false, act('retryItem')));
  if (s !== 'running' && s !== 'queued')
    wrap.appendChild(
      dlActionBtn('trash', 'Delete', true, act('deleteItem', `Delete “${it.title || it.slug}”?`)),
    );
  return wrap.childElementCount ? wrap : null;
}

function renderDownload(it: Item): HTMLElement {
  const row = el('div', 'dl-row');
  if (it.blur) row.classList.add('blurred');

  // Preview card: a decrypted thumbnail (E2EE, via the background) with a dynamic
  // aspect ratio. Only items that recorded a thumbnail get one; loadThumb removes
  // the card again if the preview turns out to be unavailable.
  if (it.thumbnail_url) {
    row.classList.add('has-thumb');
    const thumb = el('div', 'dl-thumb');
    const img = el('img') as HTMLImageElement;
    img.alt = '';
    img.decoding = 'async';
    thumb.appendChild(img);
    if (it.status === 'completed') {
      const badge = el('span', 'dl-play');
      badge.appendChild(iconEl('play'));
      thumb.appendChild(badge);
    }
    row.appendChild(thumb);
    void loadThumb(it.slug, img, thumb, row);
  }

  const info = el('div', 'dl-info');
  info.appendChild(el('span', `dl-dot ${it.status}`));
  const main = el('div', 'dl-main');
  main.appendChild(el('div', 'dl-name', it.title || it.url || it.slug));
  const meta = (it.site_name ? `${it.site_name} · ` : '') + (STATUS_LABEL[it.status] ?? it.status);
  main.appendChild(el('div', 'dl-sub', meta));
  info.appendChild(main);
  const actions = buildDlActions(it);
  if (actions) info.appendChild(actions);
  row.appendChild(info);

  if (it.status === 'completed') {
    row.classList.add('clickable');
    row.title = 'Play in Orca';
    row.addEventListener('click', () => {
      // A blurred item is opened only from an unblurred state: the first click
      // peeks/reveals it (same spoiler gesture as the web history) instead of
      // navigating; a click while already unblurred opens the player.
      if (row.classList.contains('blurred') && !isUnblurred(row)) {
        revealBlurred(row);
        return;
      }
      void send({ type: 'openWebItem', slug: it.slug });
    });
  }
  return row;
}

// Signature of the currently-painted list. The 3s poll (and tab re-entry) only
// rebuilds the DOM when this changes — an identical list is left exactly as-is, so
// browsing the Downloads tab no longer jumps/scrolls under you every refresh.
const ITEMS_STORE_KEY = 'orcaItemsCache';
let lastItemsSig = '';

function itemsSig(items: Item[]): string {
  return items.map((it) => `${it.slug}:${it.status}:${it.thumbnail_url ? 1 : 0}:${it.blur ? 1 : 0}`).join(',');
}

function renderDownloadsList(items: Item[]): void {
  const list = $('dl-list');
  lastItemsSig = itemsSig(items);
  list.textContent = '';
  $('dl-empty').classList.toggle('hidden', items.length > 0);
  for (const it of items) list.appendChild(renderDownload(it));
}

function persistItemsCache(items: Item[]): void {
  try {
    void browser.storage.local.set({
      [ITEMS_STORE_KEY]: { base: cfg.base, items: items.slice(0, 20) },
    });
  } catch {
    /* over quota / unavailable — cache is best-effort */
  }
}

// Paint the last-seen list straight from storage so a re-opened popup shows its
// downloads instantly instead of an empty flash while the network load runs.
async function renderCachedDownloads(): Promise<void> {
  try {
    const raw = (await browser.storage.local.get(ITEMS_STORE_KEY)) as {
      orcaItemsCache?: { base: string; items: Item[] };
    };
    const store = raw.orcaItemsCache;
    if (store && store.base === cfg.base && Array.isArray(store.items) && store.items.length)
      renderDownloadsList(store.items);
  } catch {
    /* unreadable — the network load will fill it in */
  }
}

// Consecutive load failures, used to back the poll off while disconnected so we
// don't hammer the (possibly unreachable) server every 3s and flood the network.
let dlFailStreak = 0;

async function loadDownloads(): Promise<void> {
  const list = $('dl-list');
  try {
    const { items } = await send<{ items: Item[] }>({ type: 'listItems', limit: 20 });
    dlFailStreak = 0;
    persistItemsCache(items);
    // Nothing changed since the last paint → leave the DOM (and the scroll
    // position) untouched. Rebuilding an identical list is what made the view drift.
    if (itemsSig(items) === lastItemsSig && list.childElementCount) return;
    renderDownloadsList(items);
  } catch (e) {
    dlFailStreak++;
    // Keep whatever we're already showing (cached or last-good list) instead of
    // wiping every card to a bare error line — a dropped connection shouldn't
    // blank the view. Only when there's nothing to preserve do we surface the
    // error text, so a genuine first-load failure still tells the user why.
    if (!list.childElementCount) {
      lastItemsSig = '';
      $('dl-empty').classList.add('hidden');
      list.appendChild(el('p', 'empty', (e as Error).message));
    }
  }
}

function initDownloads(): void {
  initBlurPeek();
  $('dl-refresh').addEventListener('click', () => { dlFailStreak = 0; void loadDownloads(); });
  // The dashboard is our existing web management UI (PWA); the background opens it
  // at its own origin and auto-logs-in via a one-time setup token.
  $('open-dash').addEventListener('click', () => void send({ type: 'openDashboard' }));
  // Live-ish refresh while the popup is open and the Downloads tab is visible.
  // Ticks every 3s, but once loads start failing we skip ticks (capped ~30s) so a
  // server that's gone away isn't polled on every beat — the streak resets the
  // moment a load succeeds or the user taps refresh.
  let tick = 0;
  setInterval(() => {
    tick++;
    if ($('tab-downloads').classList.contains('hidden')) return;
    if (dlFailStreak > 0 && tick % Math.min(dlFailStreak + 1, 10) !== 0) return;
    void loadDownloads();
  }, 3000);
}

// ---- boot ----

// Read the persisted config straight from local storage for the first paint.
// This is what makes the popup feel instant and never "fail to open": it's a
// fast local read that doesn't have to wake the background worker or wait on the
// E2EE handshake before we can show *any* UI. The background is still the sole
// owner of the token/session for every actual API call. Falls back to the
// background round-trip only if storage is somehow unreadable.
async function readStoredConfig(): Promise<ConfigView> {
  try {
    const raw = (await browser.storage.local.get('orcaConfig')) as { orcaConfig?: StoredConfig };
    const c = raw.orcaConfig;
    if (c)
      return {
        base: c.base ?? '',
        welcomeDone: c.welcomeDone ?? false,
        features: { ...DEFAULT_FEATURES, ...(c.features ?? {}) },
        hasToken: !!c.token,
      };
  } catch {
    /* fall through to the background */
  }
  return send<ConfigView>({ type: 'getConfig' });
}

async function boot(): Promise<void> {
  initIcons();
  cfg = await readStoredConfig();

  if (!cfg.welcomeDone || !cfg.hasToken) {
    $('welcome').classList.remove('hidden');
    ($('w-server') as HTMLInputElement).value = cfg.base;
    $('w-connect').addEventListener('click', async () => {
      if (await doConnect('w-server', 'w-token', 'w-err')) location.reload();
    });
    return;
  }

  $('app').classList.remove('hidden');
  initTabs();
  initConnection();
  initWebsites();
  initDownloads();
  void initCurrentPage();
  applyFeatureVisibility();
  // Seed the persistent caches and paint the last-seen list BEFORE anything kicks
  // off a network load, so a re-opened popup resumes on its previous content
  // instantly instead of flashing empty. showTab() then refreshes it from the
  // network; the signature guard leaves the DOM untouched when nothing changed.
  await loadThumbCache();
  await renderCachedDownloads();
  showTab('downloads');
  void refreshStatus();
}

void boot();
