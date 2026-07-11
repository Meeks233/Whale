'use strict';

// ---- Token persistence ----------------------------------------------------
const TOKEN_KEY = 'whale_token';
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

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
  submitForm: document.getElementById('submit-form'),
  url: document.getElementById('url'),
  submitBtn: document.getElementById('submit-btn'),
  filters: document.getElementById('filters'),
  search: document.getElementById('search'),
  history: document.getElementById('history'),
  empty: document.getElementById('empty'),
  loadMore: document.getElementById('load-more'),
  toasts: document.getElementById('toasts'),
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
  const res = await fetch(path, Object.assign({}, opts, { headers }));
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
  return '/api/items/' + id + '/file?token=' + t + (download ? '&download=1' : '');
}

// Tokenless public link, keyed by the item's random slug (not its id, so it
// can't be guessed by enumeration).
function publicUrl(slug) {
  return location.origin + '/api/p/' + slug;
}

function actionsHtml(item) {
  if (item.status !== 'completed' || !item.filepath) return '';
  const local = !!item.local_available;
  const pub = !!item.public;
  // Local file present: play/download it directly, and allow public sharing.
  // Local file gone (backed away): the <video> src is resolved on demand from
  // upstream via /stream-url (see resolveCloudVideo); no download/share.
  const video = local
    ? `<video class="video" controls preload="none" playsinline src="${fileUrl(item.id)}"></video>`
    : `<video class="video" controls preload="none" playsinline data-cloud="1" data-id="${item.id}"></video>`;
  const localActions = local
    ? `<a class="act" href="${fileUrl(item.id, true)}" download>⬇ Download</a>
      <button class="act ${pub ? 'act-on' : ''}" data-act="public" data-id="${item.id}" data-public="${pub ? '1' : '0'}">${pub ? '🌐 Public' : '🔒 Private'}</button>
      ${pub && item.public_slug ? `<button class="act" data-act="copy" data-slug="${item.public_slug}">🔗 Copy link</button>` : ''}`
    : `<span class="act act-cloud" title="Local copy is gone — plays from source">☁ Cloud only</span>`;
  return `
    <div class="actions">
      <details class="player">
        <summary class="act">▶ Play</summary>
        ${video}
      </details>
      ${localActions}
    </div>`;
}

// Cloud-file corner badge for the thumbnail: shown when an item is completed but
// its local copy is gone, signalling playback will stream from source.
const CLOUD_BADGE = `<span class="cloud-badge" title="Cloud only — plays from source"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 18H6a4 4 0 0 1-.7-7.94A5.5 5.5 0 0 1 16.5 9H17a3.5 3.5 0 0 1 2 6.37V18Z"/></svg></span>`;

function rowHtml(item) {
  const thumb = item.thumbnail_url
    ? `<img class="thumb" src="${esc(item.thumbnail_url)}" alt="" loading="lazy">`
    : `<div class="thumb thumb-empty"></div>`;
  const dur = item.duration ? `<span class="dur">${esc(fmtDuration(item.duration))}</span>` : '';
  const cloud = item.status === 'completed' && item.filepath && !item.local_available ? CLOUD_BADGE : '';
  const uploader = item.uploader ? `<div class="uploader">${esc(item.uploader)}</div>` : '';
  const active = item.status === 'queued' || item.status === 'running';
  const bar = `<div class="progress ${active ? '' : 'hidden'}"><div class="progress-fill" style="width:0%"></div></div>`;
  const meta = item.error ? `<div class="err">${esc(item.error)}</div>` : '';
  return `
    <a class="thumb-wrap" href="${esc(item.webpage_url)}" target="_blank" rel="noopener">${thumb}${dur}${cloud}</a>
    <div class="body">
      <div class="title">${esc(item.title)}</div>
      ${uploader}
      <div class="statusline">
        <span class="badge badge-${esc(item.status)}">${esc(item.status)}</span>
        <span class="speed"></span>
        <span class="eta"></span>
      </div>
      ${bar}
      ${meta}
      ${actionsHtml(item)}
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
  const li = state.rows.get(ev.id);
  if (!li) return; // unknown row; will appear on next list load
  const badge = li.querySelector('.badge');
  if (badge) {
    badge.textContent = ev.status;
    badge.className = 'badge badge-' + ev.status;
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
    if (speed) speed.textContent = '';
    if (eta) eta.textContent = '';
    // A just-completed item gains a file: refetch to render play/download/share.
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
  es = new EventSource('/api/events?token=' + encodeURIComponent(token));
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
  if (!els.settings.classList.contains('hidden')) els.token.value = getToken();
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

// Delegated actions on cards (public toggle, copy link). <summary> play toggle
// is native — it carries no data-act, so it falls through here untouched.
els.history.addEventListener('click', (e) => {
  // Opening a cloud-only player: lazily resolve an upstream stream URL. The
  // native <summary> toggle proceeds regardless (no data-act on it).
  const summary = e.target.closest('.player > summary');
  if (summary) resolveCloudVideo(summary);

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'public') togglePublic(id, btn.dataset.public !== '1');
  else if (btn.dataset.act === 'copy') copyPublicLink(btn.dataset.slug);
});

// For a cloud-only item (local file gone), fetch a fresh upstream stream URL and
// set it as the <video> source. Runs once per player; no-op if already resolved.
function resolveCloudVideo(summary) {
  const details = summary.closest('details.player');
  const video = details && details.querySelector('video[data-cloud]');
  if (!video || video.src || video.dataset.loading) return;
  video.dataset.loading = '1';
  apiFetch('/api/items/' + video.dataset.id + '/stream-url')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.url) { video.src = d.url; video.load(); }
      else toast('Could not resolve stream from source', 'error');
    })
    .catch(() => { /* auth/network handled by apiFetch */ })
    .finally(() => { delete video.dataset.loading; });
}

// ---- Share target: ?url= / ?text= -----------------------------------------
function handleShareParam() {
  const p = new URLSearchParams(location.search);
  const shared = p.get('url') || p.get('text') || '';
  if (!shared) return;
  els.url.value = shared;
  // Clean the URL so a reload doesn't resubmit.
  history.replaceState(null, '', location.pathname);
  if (getToken()) submitUrl(shared);
  else { showTokenField(false); toast('Set your token to submit', 'info'); }
}

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
