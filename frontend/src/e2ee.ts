// Orca Secure Channel (OSC) client. See docs/SECURITY.md and src/e2ee.rs.
//
// The transport (a Cloudflare Tunnel edge, or any TLS terminator) is treated as
// an active eavesdropper: nothing it can log may carry the token or a value
// reversible to it. So the token is never sent — a forward-secret session key is
// established by an ephemeral P-256 ECDH handshake with the token mixed in as a
// pre-shared key, and every request rides an opaque session id plus a sealed,
// single-use authenticator. This module is imported by both the app and the
// service worker (which decrypts the media plane).

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;

const SESSION_INFO = 'orca-osc-v2-session\0';
const MEDIA_INFO = 'orca-osc-v2-media\0';
/// Plaintext bytes per media chunk — must match `e2ee::MEDIA_CHUNK`.
export const MEDIA_CHUNK = 65536;
export const MEDIA_TAG = 16;

function bytesToBase64(bytes: Bytes): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function base64ToBytes(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/// HKDF-SHA256 → `length` bytes of key material.
async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function gcmKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/// The public shape of an established session. `key` is the raw 32-byte session
/// key; it is re-imported per role (authenticator GCM key, media HKDF).
export interface Session {
  base: string;
  sid: string;
  key: Bytes;
  gcm: CryptoKey;
}

// ---- AEAD envelope (JSON bodies, authenticators, SSE events) ----------------

async function seal(key: CryptoKey, plaintext: Bytes, aad: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(aad) },
    key,
    plaintext,
  ));
  return JSON.stringify({ v: 1, n: bytesToBase64(nonce), c: bytesToBase64(ciphertext) });
}

async function open(key: CryptoKey, envelope: string, aad: string): Promise<Bytes> {
  const parsed = JSON.parse(envelope) as { v?: number; n?: string; c?: string };
  if (parsed.v !== 1 || !parsed.n || !parsed.c) throw new Error('Invalid encrypted response');
  const nonce = base64ToBytes(parsed.n);
  const ciphertext = base64ToBytes(parsed.c);
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted response');
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(aad) },
    key,
    ciphertext,
  ));
}

/// Prove possession of the session key for exactly this request. The sid names a
/// session but proves nothing; this seal — bound to method+target, stamped, and
/// nonced — is the credential. Mirrors `verify_authenticator` in src/e2ee.rs.
export async function authenticator(gcm: CryptoKey, method: string, path: string): Promise<string> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = JSON.stringify({ t: Math.floor(Date.now() / 1000), n: nonce });
  const envelope = await seal(gcm, encoder.encode(payload), `orca-auth-v1\n${method}\n${path}`);
  return btoa(envelope);
}

// ---- Handshake + session cache ---------------------------------------------

let cached: Session | null = null;
let pending: Promise<Session> | null = null;

/// Run the ECDH handshake against `base`, deriving the forward-secret session key
/// from the shared point and `SHA256(token)` as the pre-shared key.
async function handshake(base: string, token: string): Promise<Session> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epkC = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const nC = crypto.getRandomValues(new Uint8Array(16));

  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epk: bytesToBase64(epkC), n: bytesToBase64(nC) }),
  });
  if (!res.ok) throw new Error(`handshake failed: ${res.status}`);
  const body = await res.json() as { epk: string; n: string; sid: string };
  const epkS = base64ToBytes(body.epk);
  const nS = base64ToBytes(body.n);

  const serverPub = await crypto.subtle.importKey('raw', epkS, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedX = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, pair.privateKey, 256));
  const psk = await sha256(encoder.encode(token));
  const info = concat(encoder.encode(SESSION_INFO), psk);
  const key = await hkdf(sharedX, concat(nC, nS), info, 32);
  return { base, sid: body.sid, key, gcm: await gcmKey(key) };
}

/// The current session, handshaking (once, even under concurrent callers) if
/// there is none or the base/token changed. `force` discards a stale session
/// (e.g. after a 401) and re-handshakes.
export async function ensureSession(base: string, token: string, force = false): Promise<Session> {
  if (!force && cached && cached.base === base) return cached;
  if (pending) return pending;
  cached = null;
  pending = handshake(base, token)
    .then((s) => { cached = s; notifyWorker(s); return s; })
    .finally(() => { pending = null; });
  return pending;
}

/// Base URL for a full request URL that ends in `path` — `url` is `base + path`.
function baseOf(url: string, path: string): string {
  return url.endsWith(path) ? url.slice(0, url.length - path.length) : new URL(url).origin;
}

/// Encrypted JSON fetch. Establishes/reuses a session, seals the request body,
/// authenticates, and decrypts the response. Re-handshakes once on a 401 (a
/// server-side session expiry looks like one).
export async function encryptedFetch(url: string, path: string, token: string, opts: RequestInit): Promise<Response> {
  const base = baseOf(url, path);
  const method = (opts.method || 'GET').toUpperCase();

  const attempt = async (session: Session): Promise<Response> => {
    const headers = new Headers(opts.headers);
    headers.set('X-Orca-E2EE', '1');
    headers.set('X-Orca-Sid', session.sid);
    headers.set('X-Orca-Auth', await authenticator(session.gcm, method, path));
    const body = opts.body == null
      ? undefined
      : await seal(session.gcm, encoder.encode(String(opts.body)), `${method}\n${path}`);
    if (body !== undefined) {
      headers.set('X-Orca-Encrypted-Body', '1');
      headers.set('Content-Type', 'text/plain');
    }
    const res = await fetch(url, { ...opts, headers, body });
    if (res.headers.get('X-Orca-E2EE') !== '1') return res;
    const plaintext = await open(session.gcm, await res.text(), `${res.status}\n${path}`);
    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete('Content-Length');
    responseHeaders.delete('Content-Encoding');
    responseHeaders.delete('X-Orca-E2EE');
    responseHeaders.set('Content-Type', 'application/json');
    return new Response(plaintext, { status: res.status, statusText: res.statusText, headers: responseHeaders });
  };

  let session = await ensureSession(base, token);
  let res = await attempt(session);
  if (res.status === 401) {
    session = await ensureSession(base, token, true);
    res = await attempt(session);
  }
  return res;
}

/// Build an `EventSource` URL carrying the sid + a sealed authenticator (SSE can't
/// set headers), and return the session key for decrypting the sealed events.
export async function encryptedEventSourceUrl(baseUrl: string, path: string, token: string): Promise<{ url: string; session: Session }> {
  const base = baseOf(baseUrl, path);
  const session = await ensureSession(base, token);
  const separator = baseUrl.includes('?') ? '&' : '?';
  const auth = await authenticator(session.gcm, 'GET', '/api/events');
  const query = `sid=${encodeURIComponent(session.sid)}&auth=${encodeURIComponent(auth)}`;
  return { url: `${baseUrl}${separator}${query}`, session };
}

export async function decryptEvent(session: Session, data: string): Promise<string> {
  return decoder.decode(await open(session.gcm, data, 'event\nprogress'));
}

// ---- Media plane primitives (used by the service worker) --------------------

/// Per-resource media stream key: HKDF(sessionKey, info=MEDIA_INFO‖resource).
/// `resource` must match the server's label (`file:<slug>`, `thumb:<slug>`, …).
export async function mediaKey(sessionKey: Bytes, resource: string): Promise<CryptoKey> {
  const info = concat(encoder.encode(MEDIA_INFO), encoder.encode(resource));
  return gcmKey(await hkdf(sessionKey, new Uint8Array(0), info, 32));
}

/// Decrypt one media chunk sealed by `e2ee::seal_chunk`: nonce = 12 bytes, last 8
/// the big-endian chunk index, no AAD.
export async function decryptChunk(key: CryptoKey, index: number, ciphertext: Bytes): Promise<Bytes> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index));
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
}

// ---- Service-worker session hand-off ----------------------------------------

/// Push the current session to the controlling service worker so it can decrypt
/// the media plane. Called after every (re)handshake; the SW also asks for it.
function notifyWorker(s: Session): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'orca-session', base: s.base, sid: s.sid, key: bytesToBase64(s.key),
    });
  } catch { /* no controller yet */ }
}

/// Re-push the session on demand (the SW posts `orca-need-session` when it has a
/// media request but no session yet, e.g. right after activation).
export function pushSessionToWorker(): void {
  if (cached) notifyWorker(cached);
}

/// Rebuild a `Session` from the raw material handed to the service worker over
/// `postMessage` (the SW never handshakes itself).
export async function sessionFromRaw(base: string, sid: string, keyB64: string): Promise<Session> {
  const key = base64ToBytes(keyB64);
  return { base, sid, key, gcm: await gcmKey(key) };
}
