const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;

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

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function derive(token: string): Promise<{ keyId: string; key: CryptoKey }> {
  const authHash = await sha256(encoder.encode(token));
  const keyIdDomain = encoder.encode('orca-e2ee-kid-v1\0');
  const keyDomain = encoder.encode('orca-e2ee-key-v1\0');
  const keyIdInput = new Uint8Array(keyIdDomain.length + authHash.length);
  keyIdInput.set(keyIdDomain, 0);
  keyIdInput.set(authHash, keyIdDomain.length);
  const keyInput = new Uint8Array(keyDomain.length + authHash.length);
  keyInput.set(keyDomain, 0);
  keyInput.set(authHash, keyDomain.length);
  const [keyIdBytes, keyBytes] = await Promise.all([sha256(keyIdInput), sha256(keyInput)]);
  return {
    keyId: hex(keyIdBytes),
    key: await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
}

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

/// Prove possession of the derived key for exactly this request. The key id is
/// public and replayable, so it only names the key — this seal is the credential.
/// Bound to the method and target, stamped, and nonced, so it cannot be lifted
/// onto another route or replayed. Mirrors `verify_authenticator` in src/e2ee.rs.
async function authenticator(key: CryptoKey, method: string, path: string): Promise<string> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = JSON.stringify({ t: Math.floor(Date.now() / 1000), n: nonce });
  const envelope = await seal(key, encoder.encode(payload), `orca-auth-v1\n${method}\n${path}`);
  return btoa(envelope);
}

export async function encryptedFetch(url: string, path: string, token: string, opts: RequestInit): Promise<Response> {
  const { keyId, key } = await derive(token);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers);
  headers.set('X-Orca-E2EE', '1');
  headers.set('X-Orca-Key-Id', keyId);
  headers.set('X-Orca-Auth', await authenticator(key, method, path));
  const body = opts.body == null ? undefined : await seal(key, encoder.encode(String(opts.body)), `${method}\n${path}`);
  if (body !== undefined) {
    headers.set('X-Orca-Encrypted-Body', '1');
    headers.set('Content-Type', 'text/plain');
  }
  const encrypted = await fetch(url, { ...opts, headers, body });
  if (encrypted.status === 401 || encrypted.headers.get('X-Orca-E2EE') !== '1') return encrypted;
  const plaintext = await open(key, await encrypted.text(), `${encrypted.status}\n${path}`);
  const responseHeaders = new Headers(encrypted.headers);
  responseHeaders.delete('Content-Length');
  responseHeaders.delete('Content-Encoding');
  responseHeaders.delete('X-Orca-E2EE');
  responseHeaders.set('Content-Type', 'application/json');
  return new Response(plaintext, {
    status: encrypted.status,
    statusText: encrypted.statusText,
    headers: responseHeaders,
  });
}

export async function encryptedEventSourceUrl(baseUrl: string, token: string): Promise<{ url: string; key: CryptoKey }> {
  const derived = await derive(token);
  const separator = baseUrl.includes('?') ? '&' : '?';
  // EventSource cannot set headers, so the authenticator rides in the query like
  // the key id does. Its AAD is the fixed route rather than the real target,
  // which would otherwise have to contain the authenticator itself.
  const auth = await authenticator(derived.key, 'GET', '/api/events');
  const query = `key_id=${encodeURIComponent(derived.keyId)}&auth=${encodeURIComponent(auth)}`;
  return { url: `${baseUrl}${separator}${query}`, key: derived.key };
}

export async function decryptEvent(key: CryptoKey, data: string): Promise<string> {
  return decoder.decode(await open(key, data, 'event\nprogress'));
}
