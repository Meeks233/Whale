'use strict';

// ---- Token persistence ----------------------------------------------------
const TOKEN_KEY = 'whale_token';
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---- Server base URL ------------------------------------------------------
// Empty in a browser (same-origin, unchanged). The native app (Tauri) sets this
// to the remote Whale server so the identical UI can talk to it cross-origin.
const BASE_KEY = 'whale_api_base';
function apiBase() { return (localStorage.getItem(BASE_KEY) || '').replace(/\/+$/, ''); }
function setApiBase(b) {
  b = (b || '').trim().replace(/\/+$/, '');
  if (b) localStorage.setItem(BASE_KEY, b);
  else localStorage.removeItem(BASE_KEY);
}
// Prefix an app-relative path (starting with `/`) with the configured base.
function apiUrl(path) { return apiBase() + path; }

// ---- DOM refs -------------------------------------------------------------
const els = {
  settings: document.getElementById('settings'),
  settingsToggle: document.getElementById('settings-toggle'),
  cookies: document.getElementById('cookies'),
  cookiesToggle: document.getElementById('cookies-toggle'),
  cookieList: document.getElementById('cookie-list'),
  token: document.getElementById('token'),
  tokenSave: document.getElementById('token-save'),
  tokenHint: document.getElementById('token-hint'),
  server: document.getElementById('server'),
  serverSave: document.getElementById('server-save'),
  sealArchive: document.getElementById('seal-archive'),
  sealImport: document.getElementById('seal-import'),
  submitForm: document.getElementById('submit-form'),
  url: document.getElementById('url'),
  submitBtn: document.getElementById('submit-btn'),
  filters: document.getElementById('filters'),
  search: document.getElementById('search'),
  history: document.getElementById('history'),
  empty: document.getElementById('empty'),
  loadMore: document.getElementById('load-more'),
  toasts: document.getElementById('toasts'),
  ptr: document.getElementById('ptr'),
  player: document.getElementById('player'),
  playerVideo: document.getElementById('player-video'),
  playerClose: document.getElementById('player-close'),
};

// ---- List state -----------------------------------------------------------
const state = {
  status: '',       // filter chip
  q: '',            // search query
  cursor: null,     // next before_id
  loading: false,
  rows: new Map(),  // id -> <li> element
};

// ---- Toast ----------------------------------------------------------------
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' toast-' + kind : '');
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); }, 3200);
  setTimeout(() => { t.remove(); }, 3600);
}

// ---- Auth-aware fetch ------------------------------------------------------
async function apiFetch(path, opts) {
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

function showTokenField(invalid) {
  els.settings.classList.remove('hidden');
  els.tokenHint.classList.toggle('hidden', !invalid);
  els.token.value = getToken();
  els.token.focus();
}

// ---- Rendering ------------------------------------------------------------
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function fmtDuration(sec) {
  if (sec == null) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

const TERMINAL = { completed: 1, failed: 1, duplicate: 1 };

// Direct media link. `download` forces a browser save; otherwise it streams
// (used as the <video> source). Token rides in the query since <video>/<a>
// can't send an Authorization header.
function fileUrl(id, download) {
  const t = encodeURIComponent(getToken());
  return apiUrl('/api/items/' + id + '/file?token=' + t + (download ? '&download=1' : ''));
}

// Tokenless public link, keyed by the item's random slug (not its id, so it
// can't be guessed by enumeration). Points at the server, not the app origin.
function publicUrl(slug) {
  return (apiBase() || location.origin) + '/api/p/' + slug;
}

// Save icon (Lucide "download"): borderless glyph, sized to sit inline on the
// completed status row. No outer chrome — just the currentColor stroke.
const DOWNLOAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;

function actionsHtml(item) {
  if (item.status !== 'completed' || !item.filepath) return '';
  const local = !!item.local_available;
  const pub = !!item.public;
  // Rendered inline on the status row (see rowHtml), pushed to the right. Local
  // file present: Save (download icon) + share controls. Local file gone (backed
  // away): plays from upstream, no save/share.
  const localActions = local
    ? `<a class="act act-icon act-save" href="${fileUrl(item.id, true)}" download aria-label="Save" title="Save">${DOWNLOAD_SVG}</a>
      <button class="act ${pub ? 'act-on' : ''}" data-act="public" data-id="${item.id}" data-public="${pub ? '1' : '0'}">${pub ? '🌐 Public' : '🔒 Private'}</button>
      ${pub && item.public_slug ? `<button class="act" data-act="copy" data-slug="${item.public_slug}">🔗 Copy link</button>` : ''}`
    : `<span class="act act-cloud" title="Local copy is gone — plays from source">☁ Cloud only</span>`;
  return `<div class="actions">${localActions}</div>`;
}

// Cloud-file corner badge for the thumbnail: shown when an item is completed but
// its local copy is gone, signalling playback will stream from source.
const CLOUD_BADGE = `<span class="cloud-badge" title="Cloud only — plays from source"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 18H6a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 16.5 9H17a3.5 3.5 0 0 1 2 6.37V18Z"/></svg></span>`;
// Play affordance shown on a finished thumbnail (bottom-right). Tapping the
// thumbnail opens the in-app fullscreen player (see openPlayer).
const PLAY_BADGE = `<span class="play-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span>`;

// A completed item with a file is playable in-app (local file or cloud fallback).
function isPlayable(item) {
  return item.status === 'completed' && !!item.filepath;
}

// Friendly platform name from yt-dlp's extractor id (e.g. "youtube:tab" → YouTube).
function sourceLabel(extractor) {
  if (!extractor) return '';
  const base = String(extractor).split(/[:_]/)[0].toLowerCase();
  const NAMES = {
    youtube: 'YouTube', twitter: 'X', x: 'X', bilibili: 'Bilibili', tiktok: 'TikTok',
    instagram: 'Instagram', soundcloud: 'SoundCloud', vimeo: 'Vimeo', twitch: 'Twitch',
    facebook: 'Facebook', reddit: 'Reddit', weibo: 'Weibo', niconico: 'Niconico',
    dailymotion: 'Dailymotion', pornhub: 'Pornhub', generic: 'Web',
  };
  return NAMES[base] || (base.charAt(0).toUpperCase() + base.slice(1));
}

// Per-site logo asset (web/icons/sites/*.svg) for the extractor id. Falls back
// to a neutral globe. Maps yt-dlp extractor bases/aliases → bundled slug.
const SITE_ICONS = {
  youtube: 'youtube', twitter: 'x', x: 'x', bilibili: 'bilibili', tiktok: 'tiktok',
  instagram: 'instagram', soundcloud: 'soundcloud', vimeo: 'vimeo', twitch: 'twitch',
  facebook: 'facebook', reddit: 'reddit', weibo: 'weibo', niconico: 'niconico',
  nicovideo: 'niconico', dailymotion: 'dailymotion',
};
function sourceLogoHtml(extractor) {
  const base = String(extractor || '').split(/[:_]/)[0].toLowerCase();
  const slug = SITE_ICONS[base] || 'generic';
  const name = sourceLabel(extractor) || 'Source';
  return `<img class="src-logo" src="/icons/sites/${slug}.svg" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}

// Thumbnail block. Playable items become a play button (tap → fullscreen player);
// everything else keeps the link out to the source page. Overlays: cloud
// (top-right), duration (bottom-left), play (bottom-right). The source is now
// shown as a logo before the title (see rowHtml), not on the thumbnail.
function thumbHtml(item, thumb, dur, cloud) {
  const overlays = `${thumb}${dur}${cloud}`;
  if (isPlayable(item)) {
    const cloudOnly = !item.local_available ? '1' : '';
    return `<div class="thumb-wrap thumb-play" role="button" tabindex="0" aria-label="Play"
      data-play="1" data-id="${item.id}" data-cloud="${cloudOnly}">${overlays}${PLAY_BADGE}</div>`;
  }
  return `<a class="thumb-wrap" href="${esc(item.webpage_url)}" target="_blank" rel="noopener">${overlays}</a>`;
}

function rowHtml(item) {
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
  return `
    ${thumbHtml(item, thumb, dur, cloud)}
    <div class="body">
      <div class="title">${logo}<span>${esc(item.title)}</span></div>
      ${uploader}
      <div class="statusline">
        <span class="badge badge-${esc(item.status)}">${esc(item.status)}</span>
        <span class="phase"></span>
        <span class="speed"></span>
        <span class="eta"></span>
        ${actionsHtml(item)}
      </div>
      ${bar}
      ${meta}
    </div>`;
}

function upsertRow(item, prepend) {
  let li = state.rows.get(item.id);
  if (!li) {
    li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = item.id;
    state.rows.set(item.id, li);
    if (prepend) els.history.prepend(li);
    else els.history.appendChild(li);
  }
  li.innerHTML = rowHtml(item);
  els.empty.classList.add('hidden');
  return li;
}

// Patch a row in place from a ProgressEvent (does not rebuild full row).
function patchRow(ev) {
  notifyProgress(ev); // native download notification (mobile only; no-op elsewhere)
  const li = state.rows.get(ev.id);
  if (!li) return; // unknown row; will appear on next list load
  const badge = li.querySelector('.badge');
  if (badge) {
    badge.textContent = ev.status;
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
  const fill = li.querySelector('.progress-fill');
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
async function loadItems(reset) {
  if (state.loading) return;
  state.loading = true;
  els.loadMore.disabled = true;
  if (reset) {
    state.cursor = null;
    state.rows.clear();
    els.history.innerHTML = '';
  }
  const params = new URLSearchParams();
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  if (state.cursor != null) params.set('before_id', state.cursor);
  try {
    const res = await apiFetch('/api/items?' + params.toString());
    if (!res.ok) { toast('Failed to load history', 'error'); return; }
    const data = await res.json();
    (data.items || []).forEach((it) => upsertRow(it, false));
    state.cursor = data.next_cursor;
    els.loadMore.classList.toggle('hidden', data.next_cursor == null);
    const isEmpty = state.rows.size === 0;
    els.empty.classList.toggle('hidden', !isEmpty);
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    state.loading = false;
    els.loadMore.disabled = false;
  }
}

// ---- Submit ---------------------------------------------------------------
async function submitUrl(url) {
  if (!url) return;
  if (!getToken()) { showTokenField(false); toast('Set your token first', 'error'); return; }
  els.submitBtn.disabled = true;
  try {
    const res = await apiFetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, options: {} }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 422 || (data && data.error === 'probe_failed')) {
      toast(data.message || 'Probe failed', 'error');
      return;
    }
    if (!res.ok) {
      toast((data && (data.message || data.error)) || 'Submit failed', 'error');
      return;
    }
    // Accept both single {item} and batch {items} shapes.
    if (Array.isArray(data.items)) {
      data.items.forEach((it) => upsertRow(it, true));
      const dupes = data.duplicates || 0;
      toast(`Queued ${data.items.length} item(s)` + (dupes ? `, ${dupes} already downloaded` : ''),
        dupes ? 'info' : 'ok');
    } else if (data.item) {
      upsertRow(data.item, true);
      toast(data.duplicate ? 'Already downloaded' : 'Queued', data.duplicate ? 'info' : 'ok');
    } else {
      toast('Queued', 'ok');
    }
    els.url.value = '';
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  } finally {
    els.submitBtn.disabled = false;
  }
}

// ---- SSE ------------------------------------------------------------------
let es = null;
function connectEvents() {
  const token = getToken();
  if (!token) return;
  if (es) { es.close(); es = null; }
  es = new EventSource(apiUrl('/api/events?token=' + encodeURIComponent(token)));
  es.addEventListener('progress', (e) => {
    try { patchRow(JSON.parse(e.data)); } catch (_) { /* ignore */ }
  });
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---- Cookies --------------------------------------------------------------
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function cookieRowHtml(p) {
  const statusLabel = !p.present
    ? '<span class="ck-status ck-none">Not set</span>'
    : p.enabled
      ? `<span class="ck-status ck-on">Active · ${esc(fmtBytes(p.bytes))}</span>`
      : `<span class="ck-status ck-off">Disabled · ${esc(fmtBytes(p.bytes))}</span>`;
  const actions = p.present
    ? `<button class="ck-btn" data-act="toggle" data-enabled="${p.enabled ? 'false' : 'true'}">${p.enabled ? 'Disable' : 'Enable'}</button>
       <button class="ck-btn ck-danger" data-act="delete">Delete</button>`
    : '';
  return `
    <div class="ck-head">
      <span class="ck-name">${esc(p.name)}</span>
      ${statusLabel}
    </div>
    <div class="ck-body">
      <a class="ck-btn" href="${esc(p.login_url)}" target="_blank" rel="noopener">Log in ↗</a>
      <button class="ck-btn" data-act="paste">${p.present ? 'Replace cookies' : 'Paste cookies'}</button>
      ${actions}
      <textarea class="ck-paste hidden" placeholder="Paste Netscape cookies.txt here…" rows="4"></textarea>
      <div class="ck-paste-actions hidden">
        <button class="ck-btn ck-primary" data-act="save">Save</button>
        <button class="ck-btn" data-act="cancel">Cancel</button>
      </div>
    </div>`;
}

async function loadCookies() {
  if (!getToken()) { showTokenField(false); toast('Set your token first', 'error'); return; }
  try {
    const res = await apiFetch('/api/cookies');
    if (!res.ok) { toast('Failed to load cookies', 'error'); return; }
    const data = await res.json();
    els.cookieList.innerHTML = '';
    (data.platforms || []).forEach((p) => {
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

async function cookieAction(key, act, el) {
  const item = el.closest('.cookie-item');
  const paste = item.querySelector('.ck-paste');
  const pasteActions = item.querySelector('.ck-paste-actions');
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
    let res;
    if (act === 'save') {
      const text = paste.value.trim();
      if (!text) { toast('Paste cookies first', 'error'); return; }
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || 'Cookie update failed', 'error'); return; }
    if (act === 'save') toast('Cookies saved', 'ok');
    if (act === 'delete') toast('Cookies removed', 'info');
    loadCookies();
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  }
}

// ---- Public toggle / share ------------------------------------------------
async function togglePublic(id, makePublic) {
  try {
    const res = await apiFetch('/api/items/' + id + '/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: makePublic }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast((data && (data.message || data.error)) || 'Update failed', 'error'); return; }
    upsertRow(data, false); // re-render row with new public state + copy button
    toast(makePublic ? 'Public — anyone with the link can watch' : 'Now private',
      makePublic ? 'ok' : 'info');
  } catch (e) {
    if (!e || !e.unauthorized) toast('Network error', 'error');
  }
}

function copyPublicLink(slug) {
  const link = publicUrl(slug);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(
      () => toast('Public link copied', 'ok'),
      () => toast(link, 'info'));
  } else {
    toast(link, 'info');
  }
}

// ---- Debounce -------------------------------------------------------------
function debounce(fn, ms) {
  let h;
  return function () {
    const args = arguments;
    clearTimeout(h);
    h = setTimeout(() => fn.apply(null, args), ms);
  };
}

// ---- Wire up UI -----------------------------------------------------------
els.settingsToggle.addEventListener('click', () => {
  els.settings.classList.toggle('hidden');
  if (!els.settings.classList.contains('hidden')) {
    els.token.value = getToken();
    if (els.server) els.server.value = apiBase();
  }
});

els.cookiesToggle.addEventListener('click', () => {
  const opening = els.cookies.classList.contains('hidden');
  els.cookies.classList.toggle('hidden');
  els.settings.classList.add('hidden');
  if (opening) loadCookies();
});

els.cookieList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = btn.closest('.cookie-item');
  if (!item) return;
  cookieAction(item.dataset.key, btn.dataset.act, btn);
});

els.tokenSave.addEventListener('click', () => {
  setToken(els.token.value.trim());
  els.tokenHint.classList.add('hidden');
  els.settings.classList.add('hidden');
  connectEvents();
  loadItems(true);
});

// Server URL (app only): persist, then reconnect the SSE + reload against it.
if (els.serverSave) {
  els.serverSave.addEventListener('click', () => {
    setApiBase(els.server.value);
    els.settings.classList.add('hidden');
    connectEvents();
    loadItems(true);
  });
}

// Import a Seal / yt-dlp download archive → seed dedup "already have this" keys.
if (els.sealImport) {
  els.sealImport.addEventListener('click', async () => {
    const text = (els.sealArchive.value || '').trim();
    if (!text) { toast('Paste your Seal / yt-dlp archive first', 'error'); return; }
    els.sealImport.disabled = true;
    try {
      const res = await apiFetch('/api/archive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast((data && (data.message || data.error)) || 'Import failed', 'error'); return; }
      toast(`Imported ${data.added} item(s)` + (data.skipped ? `, skipped ${data.skipped}` : ''),
        'ok');
      els.sealArchive.value = '';
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

els.filters.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  els.filters.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  state.status = chip.dataset.status || '';
  loadItems(true);
});

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value.trim();
  loadItems(true);
}, 300));

els.loadMore.addEventListener('click', () => loadItems(false));

// Delegated actions on cards: thumbnail play, public toggle, copy link.
els.history.addEventListener('click', (e) => {
  const play = e.target.closest('.thumb-play');
  if (play) { e.preventDefault(); openPlayer(Number(play.dataset.id), play.dataset.cloud === '1'); return; }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'public') togglePublic(id, btn.dataset.public !== '1');
  else if (btn.dataset.act === 'copy') copyPublicLink(btn.dataset.slug);
});

// Keyboard access for the play thumbnail (it's a role="button").
els.history.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const play = e.target.closest('.thumb-play');
  if (!play) return;
  e.preventDefault();
  openPlayer(Number(play.dataset.id), play.dataset.cloud === '1');
});

// ---- Fullscreen in-app player ---------------------------------------------
// Tapping a finished thumbnail opens a fullscreen overlay instead of navigating
// away (a new page/tab fights the mobile app's single-task model). We push a
// history entry so the Android back button pops the player back to the list
// rather than exiting the app.
function openPlayer(id, cloud) {
  const v = els.playerVideo;
  els.player.classList.remove('hidden');
  els.player.setAttribute('aria-hidden', 'false');
  document.body.classList.add('player-open');
  if (!(history.state && history.state.player)) history.pushState({ player: true }, '');
  const play = () => v.play().catch(() => { /* autoplay may need a tap */ });
  if (cloud) {
    v.removeAttribute('src');
    v.dataset.loading = '1';
    apiFetch('/api/items/' + id + '/stream-url')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.url) { v.src = d.url; v.load(); play(); }
        else { toast('Could not resolve stream from source', 'error'); closePlayer(true); }
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
function closePlayer(pop) {
  if (els.player.classList.contains('hidden')) return;
  const v = els.playerVideo;
  v.pause();
  v.removeAttribute('src');
  v.load();
  els.player.classList.add('hidden');
  els.player.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('player-open');
  if (pop && history.state && history.state.player) history.back();
}

els.playerClose.addEventListener('click', () => closePlayer(true));
// Android hardware back / browser back: pop the player, don't leave the app.
window.addEventListener('popstate', () => {
  if (!els.player.classList.contains('hidden')) closePlayer(false);
});

// ---- Share target: ?url= / ?text= (browser/PWA) ---------------------------
function handleShareParam() {
  const p = new URLSearchParams(location.search);
  const shared = p.get('url') || p.get('text') || '';
  if (!shared) return;
  // Clean the URL so a reload doesn't resubmit.
  history.replaceState(null, '', location.pathname);
  handleSharedText(shared);
}

// Pull the first http(s) URL out of arbitrary shared text ("Watch this https://…").
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : (text || '').trim();
}

// Common entry for a shared URL from any source: fill the box and submit.
function handleSharedText(shared) {
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
  else { showTokenField(false); toast('Set your token to submit', 'info'); }
}

// ---- Android/iOS share target (native app) --------------------------------
// The mobile-sharetarget plugin queues ACTION_SEND intents; drain them on
// launch and whenever the app regains focus. No-op outside the Tauri app.
async function drainSharedIntents() {
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
function drainSoon() {
  drainSharedIntents();
  setTimeout(drainSharedIntents, 250);
  setTimeout(drainSharedIntents, 700);
}

function setupNativeShare() {
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
const notif = { granted: false, last: new Map() };

async function setupNotifications() {
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
function notifyProgress(ev) {
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

// ---- Boot -----------------------------------------------------------------
if (!getToken()) showTokenField(false);
connectEvents();
loadItems(true);
handleShareParam();
setupNativeShare();
setupNotifications();
