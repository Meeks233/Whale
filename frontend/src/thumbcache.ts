// Persistent thumbnail cache for the native app.
//
// The browser serves thumbnails through the service worker, which keeps decrypted
// bytes in an in-RAM, per-session cache (see sw.ts). The native WebView runs no
// controlling worker, so it fetched+decrypted every thumbnail itself and held the
// object URLs only in memory — meaning every cold app launch re-downloaded every
// thumbnail over the (often slow / metered) link. This module gives that path a
// durable store: decrypted thumbnail bytes in IndexedDB, keyed by slug, bounded by
// a ~1 GB budget with least-recently-used eviction.
//
// Security note: this writes decrypted preview images to the app's private,
// sandboxed storage on the user's own device. The OSC threat model treats the
// *transport* as the adversary (see e2ee.ts), not the trusted local device that
// already holds the session — and thumbnails are low-sensitivity previews — so a
// device-local cache is an acceptable trade for not re-fetching on every launch.
// Only thumbnails are persisted; full media never is.

const DB_NAME = 'orca-thumb-cache';
const STORE = 'thumbs';
export const THUMB_CACHE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB default budget

interface Row { slug: string; bytes: ArrayBuffer; size: number; ts: number; }

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'slug' });
        store.createIndex('ts', 'ts'); // LRU eviction walks oldest-first
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // storage disabled/unavailable — cache is best-effort
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/// Look up a cached thumbnail, refreshing its recency so eviction keeps the ones
/// actually being viewed. Returns null on a miss or any storage error.
export async function getCachedThumb(slug: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const row = await asPromise(store.get(slug)) as Row | undefined;
    if (!row) return null;
    row.ts = Date.now();
    store.put(row); // touch (fire-and-forget within this tx)
    return new Uint8Array(row.bytes);
  } catch {
    return null;
  }
}

/// Persist a decrypted thumbnail, then evict oldest entries if over budget.
export async function putCachedThumb(slug: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const db = await openDb();
  if (!db || !bytes.length) return;
  try {
    // Copy into a standalone ArrayBuffer (the source may be a view onto a larger
    // buffer that IndexedDB would otherwise clone in full).
    const buf = bytes.slice().buffer;
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    store.put({ slug, bytes: buf, size: buf.byteLength, ts: Date.now() } as Row);
    await evictIfOverBudget(db);
  } catch {
    /* best-effort */
  }
}

/// Sum stored sizes; if over budget, delete oldest-touched rows until back under.
async function evictIfOverBudget(db: IDBDatabase): Promise<void> {
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    let total = 0;
    const rows: Array<{ slug: string; size: number; ts: number }> = [];
    await new Promise<void>((resolve, reject) => {
      const cur = store.index('ts').openCursor(); // ascending ts = oldest first
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        const v = c.value as Row;
        total += v.size;
        rows.push({ slug: v.slug, size: v.size, ts: v.ts });
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    if (total <= THUMB_CACHE_MAX_BYTES) return;
    const del = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const r of rows) {
      if (total <= THUMB_CACHE_MAX_BYTES) break;
      del.delete(r.slug);
      total -= r.size;
    }
  } catch {
    /* best-effort */
  }
}
