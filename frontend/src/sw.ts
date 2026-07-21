/// <reference lib="webworker" />

// Orca service worker. Built to ../web/sw.js by build.ts. Registered at the
// origin root (/sw.js) so its scope covers the whole app.
//
// Two jobs:
//  1. App-shell cache (offline-friendly, network-first for code edits).
//  2. The **media plane**. `<video>`/`<img>`/`<track>` can't attach auth headers
//     or decrypt bytes, so they point at same-origin `/__m/...` URLs this worker
//     owns. It fetches the encrypted media (adding the session id + a sealed
//     authenticator), decrypts the chunked AEAD stream, and answers the element
//     with plaintext — so Cloudflare only ever sees ciphertext. See src/api/emedia.rs.
export {};
declare const self: ServiceWorkerGlobalScope;

import { authenticator, decryptChunk, mediaKey, sessionFromRaw, MEDIA_TAG, type Session } from './e2ee';

const CACHE = 'orca-shell-v7';
// Persistent thumbnail store, separate from the shell cache so it survives across
// sessions and token changes. The in-RAM blobCache below is wiped whenever the
// session rotates (and dies with the worker), so once the token went bad every
// `/__m/thumb/...` refetch 401'd and the pictures vanished. This keeps the last
// decrypted copy on disk to serve when the live fetch can't (bad token, offline).
// Mirrors the native app's IndexedDB thumb cache (thumbcache.ts) and its security
// note: only low-sensitivity preview images are persisted, never full media.
const THUMB_CACHE = 'orca-thumb-v1';
const SHELL = [
  '/', '/index.html', '/app.js', '/theme.js', '/style.css',
  '/manifest.webmanifest', '/favicon.ico', '/icons/favicon-32.png',
  '/third-party-notices.txt', '/icons/192.png', '/icons/512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== THUMB_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim())
  );
});

// ---- Session hand-off from the app -----------------------------------------

let session: Session | null = null;
let waiters: Array<(s: Session) => void> = [];

// Per-session media caches. Both are keyed by the resource label and are only
// valid under the current session key, so they're cleared whenever the session
// rotates (a new key makes old derived keys and decrypted bytes useless — and
// dropping them keeps one session's plaintext from ever surfacing under another).
//
//  - `mediaKeyCache`: the derived+imported per-resource AES-GCM key. Deriving it
//    is HKDF + two `importKey`s; without this it was recomputed on *every* window
//    fetch (every thumbnail render, every video range).
//  - `blobCache`: decrypted small resources (thumbnails, subtitles). These are
//    re-requested constantly as the list re-renders/scrolls; caching the decrypted
//    bytes in RAM turns a re-render into a zero-cost hit — no server round-trip
//    (so no re-seal), no re-decrypt. Kept in memory only (never persisted to disk),
//    so it doesn't weaken forward secrecy, and bounded so it can't grow unbounded.
let mediaKeyCache = new Map<string, Promise<CryptoKey>>();
let blobCache = new Map<string, Uint8Array<ArrayBuffer>>();
const BLOB_CACHE_MAX = 96;

function resetMediaCaches(): void {
  mediaKeyCache = new Map();
  blobCache = new Map();
}

/// The per-resource media key, derived once per session and reused thereafter.
function streamKey(s: Session, resource: string): Promise<CryptoKey> {
  let p = mediaKeyCache.get(resource);
  if (!p) { p = mediaKey(s.key, resource); mediaKeyCache.set(resource, p); }
  return p;
}

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; base?: string; sid?: string; key?: string } | null;
  // Take control of an already-open, uncontrolled client on demand. `activate`
  // (where we call clients.claim()) runs only once per worker, so a page reloaded
  // while this worker is already active can end up uncontrolled — and then its
  // media plane is dead (`/__m/...` has no server route, the `?token=` fallback is
  // loopback-only). The app posts this when it boots uncontrolled; claiming fires
  // `controllerchange`, which re-renders the media URLs through the worker.
  if (data?.type === 'orca-claim') { void self.clients.claim(); return; }
  // `base` is '' for a same-origin app — check for presence, not truthiness.
  if (data?.type === 'orca-session' && typeof data.base === 'string' && data.sid && data.key) {
    void sessionFromRaw(data.base, data.sid, data.key).then((s) => {
      if (!session || session.sid !== s.sid) resetMediaCaches();
      session = s;
      waiters.splice(0).forEach((resolve) => resolve(s));
    });
  }
});

/// The current session, asking the app for one (and waiting briefly) if absent.
async function getSession(): Promise<Session> {
  if (session) return session;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'orca-need-session' }));
  return new Promise<Session>((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => {
      waiters = waiters.filter((w) => w !== resolve);
      reject(new Error('no session'));
    }, 5000);
  });
}

// ---- Media plane ------------------------------------------------------------

const CHUNK = 65536;

interface Target { apiPath: string; resource: string; kind: 'video' | 'blob' | 'download'; }

/// Map a `/__m/...` URL to its backend route, stream key label, and delivery mode.
function route(parts: string[]): Target | null {
  const [kind, slug, extra] = parts;
  if (!slug) return null;
  const s = decodeURIComponent(slug);
  switch (kind) {
    case 'file': return { apiPath: `/api/items/${encodeURIComponent(s)}/file`, resource: `file:${s}`, kind: 'video' };
    case 'stream': return { apiPath: `/api/stream/${encodeURIComponent(s)}`, resource: `stream:${s}`, kind: 'video' };
    case 'dl': return { apiPath: `/api/items/${encodeURIComponent(s)}/file`, resource: `file:${s}`, kind: 'download' };
    case 'thumb': return { apiPath: `/api/items/${encodeURIComponent(s)}/thumb`, resource: `thumb:${s}`, kind: 'blob' };
    case 'subs': {
      if (!extra) return null;
      const lang = decodeURIComponent(extra);
      return { apiPath: `/api/items/${encodeURIComponent(s)}/subs/${encodeURIComponent(lang)}`, resource: `subs:${s}:${lang}`, kind: 'blob' };
    }
    default: return null;
  }
}

interface WindowData { plainLen: number; windowStart: number; plaintext: Uint8Array<ArrayBuffer>; }

/// Fetch and decrypt one encrypted window starting at plaintext byte `start`.
async function fetchWindow(s: Session, t: Target, start: number, end?: number, query = ''): Promise<WindowData> {
  // The authenticator is bound to the path only (never the query), matching the
  // server; `query` (e.g. a `?h=` resolution cap) rides the fetch URL alone.
  const auth = await authenticator(s.gcm, 'GET', t.apiPath);
  const res = await fetch(`${s.base}${t.apiPath}${query}`, {
    headers: {
      'X-Orca-Sid': s.sid,
      'X-Orca-Auth': auth,
      'X-Orca-Range': `${start}-${end == null ? '' : end}`,
    },
  });
  if (res.status === 401) { session = null; throw new Error('session expired'); }
  if (!res.ok || res.headers.get('X-Orca-E2EE') !== '1') throw new Error(`media fetch ${res.status}`);

  const plainLen = Number(res.headers.get('X-Orca-Plain-Len') || '0');
  const i0 = Number(res.headers.get('X-Orca-Chunk-Index') || '0');
  const body = new Uint8Array(await res.arrayBuffer());
  const key = await streamKey(s, t.resource);

  const out: Uint8Array[] = [];
  let off = 0;
  let idx = i0;
  while (off < body.length) {
    const ptLen = Math.min(CHUNK, plainLen - idx * CHUNK);
    const ctLen = ptLen + MEDIA_TAG;
    const ct = body.subarray(off, off + ctLen) as Uint8Array<ArrayBuffer>;
    out.push(await decryptChunk(key, idx, ct));
    off += ctLen;
    idx += 1;
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  const plaintext = new Uint8Array(total);
  let p = 0;
  for (const c of out) { plaintext.set(c, p); p += c.length; }
  return { plainLen, windowStart: i0 * CHUNK, plaintext };
}

/// Serve a seekable `<video>` range: one decrypted window as a `206`.
async function serveVideo(s: Session, t: Target, range: string | null, ct: string, query = ''): Promise<Response> {
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : undefined;
  const w = await fetchWindow(s, t, start, end, query);
  if (w.plainLen === 0) return new Response(null, { status: 200, headers: { 'Content-Type': ct } });

  // Slice the decrypted window to exactly what the element asked for.
  const from = Math.max(0, start - w.windowStart);
  const to = end == null ? w.plaintext.length : Math.min(w.plaintext.length, end + 1 - w.windowStart);
  const slice = w.plaintext.slice(from, Math.max(from, to));
  const first = w.windowStart + from;
  const last = first + slice.length - 1;
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': ct,
      'Content-Range': `bytes ${first}-${last}/${w.plainLen}`,
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}

// A thumbnail's persistent key. Keyed by resource label (`thumb:<slug>`) under a
// synthetic same-origin URL the media plane never actually requests.
function thumbCacheKey(resource: string): Request {
  return new Request(`${self.location.origin}/__thumbcache/${encodeURIComponent(resource)}`);
}

// Stash a freshly decrypted thumbnail for later offline / bad-token fallback.
async function persistThumb(resource: string, bytes: Uint8Array, ct: string): Promise<void> {
  try {
    const cache = await caches.open(THUMB_CACHE);
    await cache.put(thumbCacheKey(resource), new Response(bytes.slice(), {
      headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' },
    }));
  } catch { /* best-effort: private mode / quota */ }
}

// The last-good decrypted thumbnail, if one was ever stored.
async function thumbFromCache(resource: string): Promise<Response | null> {
  try {
    const cache = await caches.open(THUMB_CACHE);
    return (await cache.match(thumbCacheKey(resource))) || null;
  } catch { return null; }
}

/// Serve a whole small resource (thumbnail, subtitle) as one decrypted blob,
/// from the in-RAM cache when we've already decrypted it this session.
async function serveBlob(s: Session, t: Target, ct: string): Promise<Response> {
  let bytes = blobCache.get(t.resource);
  if (bytes) {
    // Touch for LRU recency.
    blobCache.delete(t.resource);
    blobCache.set(t.resource, bytes);
  } else {
    bytes = (await fetchWindow(s, t, 0)).plaintext;
    if (blobCache.size >= BLOB_CACHE_MAX) {
      const oldest = blobCache.keys().next().value;
      if (oldest !== undefined) blobCache.delete(oldest);
    }
    blobCache.set(t.resource, bytes);
  }
  const isThumb = t.resource.startsWith('thumb:');
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  headers['Content-Type'] = t.resource.startsWith('subs:')
    ? 'text/vtt; charset=utf-8'
    : (ct || sniffImage(bytes));
  // Persist thumbnails to disk so a later bad-token/offline refetch can still paint.
  if (isThumb && bytes.length) void persistThumb(t.resource, bytes, headers['Content-Type']);
  return new Response(bytes, { status: 200, headers });
}

/// Serve a full file as a decrypted download, streaming window by window so a
/// multi-gigabyte file never buffers whole in memory.
async function serveDownload(s: Session, t: Target, name: string | null): Promise<Response> {
  const first = await fetchWindow(s, t, 0);
  const plainLen = first.plainLen;
  let next = first.plaintext.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(first.plaintext); },
    async pull(controller) {
      if (next >= plainLen) { controller.close(); return; }
      try {
        const w = await fetchWindow(s, t, next);
        if (w.plaintext.length === 0) { controller.close(); return; }
        controller.enqueue(w.plaintext);
        next += w.plaintext.length;
      } catch (e) { controller.error(e); }
    },
  });
  const disposition = name ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}` : 'attachment';
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(plainLen),
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
    },
  });
}

function sniffImage(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[8] === 0x57) return 'image/webp';
  return 'application/octet-stream';
}

async function handleMedia(req: Request, parts: string[], url: URL): Promise<Response> {
  const t = route(parts);
  if (!t) return new Response('bad media path', { status: 400 });
  const isThumb = t.resource.startsWith('thumb:');
  try {
    const s = await getSession();
    const ct = url.searchParams.get('ct') || '';
    if (t.kind === 'download') return await serveDownload(s, t, url.searchParams.get('name'));
    if (t.kind === 'blob') return await serveBlob(s, t, ct);
    // A `?h=` resolution cap only applies to the online-stream resolve.
    const h = t.resource.startsWith('stream:') ? url.searchParams.get('h') : null;
    return await serveVideo(s, t, req.headers.get('Range'), ct || 'video/mp4', h ? `?h=${encodeURIComponent(h)}` : '');
  } catch {
    // Live fetch failed (no session yet, expiry, bad token, offline). A thumbnail
    // we decrypted before is still on disk — paint that instead of a broken image.
    if (isThumb) {
      const cached = await thumbFromCache(t.resource);
      if (cached) return cached;
    }
    // A transient failure — let the element retry.
    return new Response('media unavailable', { status: 503 });
  }
}

// ---- Fetch routing ----------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Encrypted media plane.
  if (url.pathname.startsWith('/__m/')) {
    const parts = url.pathname.slice('/__m/'.length).split('/');
    event.respondWith(handleMedia(req, parts, url));
    return;
  }

  if (req.method !== 'GET') return;

  // Bypass the worker for API traffic — SSE (`/api/events`) and any direct API
  // call go straight to the network (routing long-lived responses through
  // respondWith stalls the worker; see the thumbnail-load regression).
  if (url.pathname.startsWith('/api/')) return;

  // App shell: network-first so code edits load immediately; fall back offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || Response.error()))
  );
});
