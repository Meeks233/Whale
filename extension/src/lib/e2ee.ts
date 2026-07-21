// Orca Secure Channel (OSC v2) — browser-extension client.
//
// A faithful WebCrypto port of the handshake and AEAD envelope implemented in
// the backend `src/e2ee.rs` / `src/session.rs`, and mirrored by the web UI's
// `Ot`/`ao`/`qs`/`zs` helpers. The transport is treated as an active MITM:
// nothing on the wire carries the token or any value reversible to it. A
// forward-secret session key is established per connection by an ephemeral
// P-256 ECDH exchange with SHA256(token) mixed in as a pre-shared key, then all
// request/response bodies (and SSE events) travel sealed under AES-256-GCM.
//
// Key schedule (must match the Rust side byte-for-byte):
//   shared_x    = ECDH(client_eph_priv, server_eph_pub)  -> 32-byte P-256 X
//   psk         = SHA256(token)
//   session_key = HKDF-SHA256(ikm=shared_x, salt=n_c||n_s,
//                             info="orca-osc-v2-session\0"||psk, len=32)
//   media_key   = HKDF-SHA256(ikm=session_key, salt=none,
//                             info="orca-osc-v2-media\0"||resource, len=32)

const enc = new TextEncoder();
const dec = new TextDecoder();

function strBytes(s: string): Uint8Array {
  return enc.encode(s);
}

const SESSION_INFO = strBytes('orca-osc-v2-session\0');
const MEDIA_INFO = strBytes('orca-osc-v2-media\0');

/** Plaintext bytes per sealed media chunk (mirrors `MEDIA_CHUNK` in e2ee.rs). */
export const MEDIA_CHUNK = 65536;
/** AES-GCM tag length appended to each sealed media chunk. */
export const MEDIA_TAG = 16;

export interface Session {
  base: string;
  sid: string;
  key: Uint8Array;
}

export function b64encode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin);
}

export function b64decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

// TS 5.7+ made Uint8Array generic over its backing buffer; WebCrypto's
// BufferSource params want an ArrayBuffer-backed view specifically. Our arrays
// always are, so narrow at the crypto boundary.
const ab = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ab(bytes)));
}

// HKDF-SHA256 -> `len` bytes, matching Hkdf::<Sha256>::new(salt, ikm).expand(info).
async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  len = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

// AES-256-GCM seal producing the Rust `Envelope` {v:1, n:<b64 iv>, c:<b64 ct||tag>}.
// Returns the JSON envelope as a UTF-8 string (the exact bytes Rust `seal` emits).
export async function seal(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', ab(keyBytes), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ab(aad) }, key, ab(plaintext)),
  );
  return JSON.stringify({ v: 1, n: b64encode(iv), c: b64encode(ct) });
}

// Inverse of seal: opens an envelope JSON string back to plaintext bytes.
export async function open(
  keyBytes: Uint8Array,
  envelopeJson: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const env = JSON.parse(envelopeJson) as { v: number; n: string; c: string };
  if (env.v !== 1 || !env.n || !env.c) throw new Error('invalid envelope');
  const iv = b64decode(env.n);
  const ct = b64decode(env.c);
  if (iv.length !== 12 || ct.length < 16) throw new Error('invalid envelope');
  const key = await crypto.subtle.importKey('raw', ab(keyBytes), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) },
    key,
    ab(ct),
  );
  return new Uint8Array(pt);
}

// Decrypt one sealed media chunk: 12-byte nonce = big-endian index in the low 8
// bytes, empty AAD (mirrors `seal_into`/`open_chunk` in e2ee.rs).
export async function openMediaChunk(
  mediaKey: Uint8Array,
  index: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index));
  const key = await crypto.subtle.importKey('raw', ab(mediaKey), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ab(ciphertext));
  return new Uint8Array(pt);
}

// Per-resource media sub-key. `resource` is e.g. "stream:<slug>" or "file:<slug>".
export async function mediaStreamKey(
  sessionKey: Uint8Array,
  resource: string,
): Promise<Uint8Array> {
  return hkdfSha256(sessionKey, new Uint8Array(0), concatBytes(MEDIA_INFO, strBytes(resource)), 32);
}

// Run the client half of the handshake against `<base>/api/session`.
export async function handshake(base: string, token: string): Promise<Session> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // Uncompressed SEC1 point (0x04 || X || Y) == WebCrypto "raw" export.
  const epkC = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const nC = crypto.getRandomValues(new Uint8Array(16));

  const res = await fetch(joinUrl(base, '/api/session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epk: b64encode(epkC), n: b64encode(nC) }),
  });
  if (!res.ok) throw new Error(`handshake failed: HTTP ${res.status}`);
  const hello = (await res.json()) as { epk: string; n: string; sid: string };

  const serverPub = await crypto.subtle.importKey(
    'raw',
    ab(b64decode(hello.epk)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const nS = b64decode(hello.n);
  // deriveBits with ECDH P-256 yields the 32-byte X coordinate == Rust raw_secret_bytes.
  const sharedX = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, kp.privateKey, 256),
  );

  const psk = await sha256(strBytes(token));
  const key = await hkdfSha256(sharedX, concatBytes(nC, nS), concatBytes(SESSION_INFO, psk), 32);
  return { base: base.replace(/\/+$/, ''), sid: hello.sid, key };
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

// Build the sealed proof-of-possession authenticator (base64 envelope) for one
// request. Nonce is a hex string to match the web client's `zs`.
export async function authenticator(
  key: Uint8Array,
  method: string,
  target: string,
): Promise<string> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const t = Math.floor(Date.now() / 1000);
  const aad = strBytes(`orca-auth-v1\n${method}\n${target}`);
  const env = await seal(key, strBytes(JSON.stringify({ t, n: nonce })), aad);
  return btoa(env);
}

export { enc, dec, strBytes };
