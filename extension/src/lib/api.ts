// Orca API client for the extension background context.
//
// Speaks the same OSC v2 secure channel the web UI uses: one handshake per
// session (re-run lazily on expiry or 401), every request sealed and
// authenticated, responses opened, and the SSE progress stream parsed from a
// streaming fetch (works in both a Firefox background script and a Chrome
// service worker, unlike EventSource).

import {
  authenticator,
  b64encode,
  dec,
  enc,
  handshake,
  joinUrl,
  MEDIA_CHUNK,
  MEDIA_TAG,
  mediaStreamKey,
  open,
  openMediaChunk,
  seal,
  type Session,
} from './e2ee.js';
import type { Item, ProgressEvent, SubmitResult, Website } from './types.js';

export interface EventsHandle {
  close(): void;
}

function concatChunks(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Sniff a decrypted image's MIME from its magic bytes, so the <img> data URL is
// tagged correctly (the sealed transport carries no content type). Returns null
// for anything we don't recognise, so a non-image never becomes a broken preview.
function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp';
  return null;
}

export class OrcaClient {
  readonly base: string;
  readonly token: string;
  private session: Session | null = null;
  private handshaking: Promise<Session> | null = null;

  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    if (!this.handshaking) {
      this.handshaking = handshake(this.base, this.token)
        .then((s) => {
          this.session = s;
          return s;
        })
        .finally(() => {
          this.handshaking = null;
        });
    }
    return this.handshaking;
  }

  // One sealed request. `target` is the request path (with query if any). Returns
  // the parsed JSON (or null for empty bodies). Throws with .status on non-2xx.
  async request<T = unknown>(
    method: string,
    target: string,
    bodyObj?: unknown,
    retried = false,
  ): Promise<T> {
    const session = await this.ensureSession();
    const headers: Record<string, string> = {
      'X-Orca-E2EE': '1',
      'X-Orca-Sid': session.sid,
      'X-Orca-Auth': await authenticator(session.key, method, target),
    };

    let body: string | undefined;
    if (bodyObj !== undefined) {
      const aad = enc.encode(`${method}\n${target}`);
      body = await seal(session.key, enc.encode(JSON.stringify(bodyObj)), aad);
      headers['X-Orca-Encrypted-Body'] = '1';
      headers['Content-Type'] = 'text/plain';
    }

    const res = await fetch(joinUrl(this.base, target), { method, headers, body });

    if (res.status === 401 && !retried) {
      this.session = null; // session expired — re-handshake once and retry.
      return this.request<T>(method, target, bodyObj, true);
    }

    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      const opened = await this.maybeOpen(res, target, text);
      const payload = (opened ?? this.tryParse(text)) as { error?: string; message?: string } | null;
      if (payload) msg = payload.message || payload.error || msg;
      const err = new Error(msg) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    if (text.length === 0) return null as T;
    const opened = await this.maybeOpen(res, target, text);
    return (opened ?? this.tryParse(text)) as T;
  }

  private tryParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private async maybeOpen(res: Response, target: string, text: string): Promise<unknown> {
    const ct = res.headers.get('content-type') || '';
    if (res.headers.get('x-orca-e2ee') === '1' || ct.includes('e2ee')) {
      if (!this.session) return null;
      const aad = enc.encode(`${res.status}\n${target}`);
      const plaintext = await open(this.session.key, text, aad);
      if (plaintext.length === 0) return null;
      return JSON.parse(dec.decode(plaintext));
    }
    return null;
  }

  // Submit a URL. Normalizes the single- and multi-item response into one item.
  async submit(url: string, maxHeight?: number): Promise<SubmitResult> {
    const options = maxHeight === undefined ? undefined : { max_height: maxHeight };
    const body: Record<string, unknown> = { url };
    if (options) body.options = options;
    const res = await this.request<
      | SubmitResult
      | { items: SubmitResult['item'][]; duplicates: number }
    >('POST', '/api/items', body);
    if ('items' in res) {
      const first = res.items[0];
      if (!first) throw new Error('empty playlist');
      return { item: first, duplicate: res.duplicates > 0 };
    }
    return res;
  }

  getItem(slug: string): Promise<SubmitResult['item']> {
    return this.request('GET', `/api/items/${encodeURIComponent(slug)}`);
  }

  // Stop an outstanding (queued/running/paused) download; discards its partial.
  cancelItem(slug: string): Promise<unknown> {
    return this.request('POST', `/api/items/${encodeURIComponent(slug)}/cancel`);
  }

  // Re-queue a failed or canceled item from scratch.
  retryItem(slug: string): Promise<unknown> {
    return this.request('POST', `/api/items/${encodeURIComponent(slug)}/retry`);
  }

  // Permanently remove an item and its downloaded file(s).
  deleteItem(slug: string): Promise<unknown> {
    return this.request('DELETE', `/api/items/${encodeURIComponent(slug)}`);
  }

  // Has this URL already been downloaded? Returns the matching completed item, or
  // null. Cheap (no probe) — the in-page button uses it to mount its "already
  // saved" tick instead of the download glyph. `any` widens the match to the
  // latest item in ANY state (canceled/failed/running/…) so the overlay button
  // can render retry / the live ring instead of a plain download glyph.
  async lookupByUrl(url: string, any = false): Promise<Item | null> {
    const res = await this.request<{ item: Item | null }>(
      'GET',
      `/api/lookup?url=${encodeURIComponent(url)}${any ? '&any=true' : ''}`,
    );
    return res.item;
  }

  // The registry endpoint wraps the array as `{ websites: [...] }`; unwrap it so
  // callers get a real array (an object here is what fed the `x.filter is not a
  // function` crash in the popup).
  async listWebsites(): Promise<Website[]> {
    const res = await this.request<{ websites: Website[] } | Website[]>('GET', '/api/websites');
    return Array.isArray(res) ? res : (res?.websites ?? []);
  }

  // Recent items for the popup's Downloads view. Same wrapper-unwrap shape.
  async listItems(limit = 20): Promise<Item[]> {
    const res = await this.request<{ items: Item[] } | Item[]>(
      'GET',
      `/api/items?limit=${limit}`,
    );
    return Array.isArray(res) ? res : (res?.items ?? []);
  }

  // Fetch and decrypt an item's thumbnail over the secure channel, returning a
  // `data:` URL for an <img>, or null when there's no preview / the fetch fails.
  //
  // The `/thumb` route seals the image as media chunks (not the JSON envelope):
  // per-resource key = mediaStreamKey(session, "thumb:<slug>"), body = each 64 KiB
  // plaintext chunk sealed to ciphertext||tag, sized from the X-Orca-* headers.
  // A thumbnail is decorative, so any failure resolves to null rather than throwing.
  async fetchThumb(slug: string): Promise<string | null> {
    const session = await this.ensureSession();
    const target = `/api/items/${encodeURIComponent(slug)}/thumb`;
    const res = await fetch(joinUrl(this.base, target), {
      headers: {
        'X-Orca-Sid': session.sid,
        'X-Orca-Auth': await authenticator(session.key, 'GET', target),
      },
    });
    if (!res.ok) {
      if (res.status === 401) this.session = null; // let the next call re-handshake
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    let bytes: Uint8Array;
    if (res.headers.get('x-orca-e2ee') === '1') {
      const chunkSize = Number(res.headers.get('x-orca-chunk')) || MEDIA_CHUNK;
      let index = Number(res.headers.get('x-orca-chunk-index')) || 0;
      let plainLen = Number(res.headers.get('x-orca-plain-len'));
      if (!Number.isFinite(plainLen) || plainLen <= 0) return null;
      const key = await mediaStreamKey(session.key, `thumb:${slug}`);
      const parts: Uint8Array[] = [];
      let off = 0;
      try {
        while (plainLen > 0 && off < buf.length) {
          const plainThis = Math.min(plainLen, chunkSize);
          const sealed = buf.subarray(off, off + plainThis + MEDIA_TAG);
          parts.push(await openMediaChunk(key, index, sealed));
          off += plainThis + MEDIA_TAG;
          plainLen -= plainThis;
          index += 1;
        }
      } catch {
        return null;
      }
      bytes = parts.length === 1 ? parts[0]! : concatChunks(parts);
    } else {
      bytes = buf;
    }
    const mime = sniffImage(bytes);
    return mime ? `data:${mime};base64,${b64encode(bytes)}` : null;
  }

  upsertWebsite(key: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/api/websites/${encodeURIComponent(key)}`, body);
  }

  deleteWebsite(key: string): Promise<unknown> {
    return this.request('DELETE', `/api/websites/${encodeURIComponent(key)}`);
  }

  setCookies(key: string, cookies: string): Promise<unknown> {
    return this.request('POST', `/api/websites/${encodeURIComponent(key)}/cookies`, { cookies });
  }

  toggleCookies(key: string, enabled: boolean): Promise<unknown> {
    return this.request('PATCH', `/api/websites/${encodeURIComponent(key)}/cookies`, { enabled });
  }

  deleteCookies(key: string): Promise<unknown> {
    return this.request('DELETE', `/api/websites/${encodeURIComponent(key)}/cookies`);
  }

  // Liveness probe used by the welcome/connection validation (maps 401 distinctly).
  async validate(): Promise<'' | 'token' | 'network' | 'server'> {
    try {
      await this.request('GET', '/api/items?limit=1');
      return '';
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) return 'token';
      if (status === undefined) return 'network';
      return 'server';
    }
  }

  // Open the sealed SSE progress stream. Calls onEvent for each decrypted
  // ProgressEvent. Returns a handle whose .close() aborts the stream.
  async openEvents(
    onEvent: (ev: ProgressEvent) => void,
    onError?: (e: unknown) => void,
  ): Promise<EventsHandle> {
    const session = await this.ensureSession();
    const auth = await authenticator(session.key, 'GET', '/api/events');
    const url =
      joinUrl(this.base, '/api/events') +
      `?sid=${encodeURIComponent(session.sid)}&auth=${encodeURIComponent(auth)}`;

    const ctrl = new AbortController();
    const key = session.key;
    void (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
        const reader = res.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            await this.handleSseChunk(chunk, key, onEvent);
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted && onError) onError(e);
      }
    })();

    return { close: () => ctrl.abort() };
  }

  private async handleSseChunk(
    chunk: string,
    key: Uint8Array,
    onEvent: (ev: ProgressEvent) => void,
  ): Promise<void> {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (event !== 'progress' || dataLines.length === 0) return;
    try {
      const plaintext = await open(key, dataLines.join('\n'), enc.encode('event\nprogress'));
      onEvent(JSON.parse(dec.decode(plaintext)) as ProgressEvent);
    } catch {
      /* ignore keep-alive / malformed frames */
    }
  }
}
