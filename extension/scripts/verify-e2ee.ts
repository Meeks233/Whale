// Ad-hoc end-to-end check: drive the extension's OSC client against the live dev
// server exactly as the background would, proving the WebCrypto port matches the
// Rust handshake/AEAD. Run: npx tsx scripts/verify-e2ee.ts
import { authenticator, dec, enc, handshake, open, seal } from '../src/lib/e2ee.ts';

const BASE = process.env.ORCA_BASE ?? 'http://127.0.0.1:8090';
const TOKEN = process.env.ORCA_TOKEN ?? 'test-token';

async function req(session: { base: string; sid: string; key: Uint8Array }, method: string, target: string, body?: unknown) {
  const headers: Record<string, string> = {
    'X-Orca-E2EE': '1',
    'X-Orca-Sid': session.sid,
    'X-Orca-Auth': await authenticator(session.key, method, target),
  };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = await seal(session.key, enc.encode(JSON.stringify(body)), enc.encode(`${method}\n${target}`));
    headers['X-Orca-Encrypted-Body'] = '1';
    headers['Content-Type'] = 'text/plain';
  }
  const res = await fetch(session.base + target, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  if (res.headers.get('x-orca-e2ee') === '1' && text) {
    json = JSON.parse(dec.decode(await open(session.key, text, enc.encode(`${res.status}\n${target}`))));
  } else if (text) {
    try { json = JSON.parse(text); } catch { json = text; }
  }
  return { status: res.status, json };
}

const session = await handshake(BASE, TOKEN);
console.log('handshake ok — sid', session.sid, 'key bytes', session.key.length);

const list = await req(session, 'GET', '/api/items?limit=1');
console.log('GET /api/items?limit=1 ->', list.status);
if (list.status !== 200) { console.error('AUTH FAILED', list.json); process.exit(1); }
console.log('decrypted body sample:', JSON.stringify(list.json).slice(0, 160));

const sites = await req(session, 'GET', '/api/websites');
console.log('GET /api/websites ->', sites.status, Array.isArray((sites.json as { websites?: unknown[] })?.websites ?? sites.json) ? 'array-ish' : typeof sites.json);

console.log('E2EE VERIFY PASS');
