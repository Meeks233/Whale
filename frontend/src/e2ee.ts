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
  const keyIdDomain = encoder.encode('whale-e2ee-kid-v1\0');
  const keyDomain = encoder.encode('whale-e2ee-key-v1\0');
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

export async function encryptedFetch(url: string, path: string, token: string, opts: RequestInit): Promise<Response> {
  const { keyId, key } = await derive(token);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers);
  headers.set('X-Whale-E2EE', '1');
  headers.set('X-Whale-Key-Id', keyId);
  const body = opts.body == null ? undefined : await seal(key, encoder.encode(String(opts.body)), `${method}\n${path}`);
  if (body !== undefined) {
    headers.set('X-Whale-Encrypted-Body', '1');
    headers.set('Content-Type', 'text/plain');
  }
  const encrypted = await fetch(url, { ...opts, headers, body });
  if (encrypted.status === 401 || encrypted.headers.get('X-Whale-E2EE') !== '1') return encrypted;
  const plaintext = await open(key, await encrypted.text(), `${encrypted.status}\n${path}`);
  const responseHeaders = new Headers(encrypted.headers);
  responseHeaders.delete('Content-Length');
  responseHeaders.delete('Content-Encoding');
  responseHeaders.delete('X-Whale-E2EE');
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
  return { url: `${baseUrl}${separator}key_id=${encodeURIComponent(derived.keyId)}`, key: derived.key };
}

export async function decryptEvent(key: CryptoKey, data: string): Promise<string> {
  return decoder.decode(await open(key, data, 'event\nprogress'));
}
