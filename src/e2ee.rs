//! Forward-secret application-layer secure channel (Orca Secure Channel, "OSC").
//! See docs/SECURITY.md.
//!
//! The transport (a Cloudflare Tunnel edge, or any TLS terminator) is treated as
//! an active man-in-the-middle: nothing it can log — URL path/query, headers,
//! bodies — may carry the token or any value reversible to it, and traffic it
//! captured today must stay secret even if the token later leaks. That rules out
//! the old static, token-derived encryption key: a session key is instead
//! established per connection by an ephemeral P-256 ECDH exchange with the token
//! mixed in as a pre-shared key (the mature Noise-`NNpsk0` / TLS-ECDHE-PSK
//! construction), so the wire carries only ephemeral public keys, an opaque
//! random session id, and ciphertext. This module holds the AEAD envelope, the
//! per-request authenticator, HKDF key schedule, and the chunked media cipher;
//! `src/session.rs` drives the handshake and session store.

use crate::error::{AppError, AppResult};
use aes_gcm::aead::{Aead, AeadCore, AeadInPlace, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::response::Response;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const HEADER_E2EE: &str = "x-orca-e2ee";
/// Opaque, server-issued session id. Replaces the old key id, which was a stable
/// `SHA256(SHA256(token))` — a per-token tracking handle and an offline-guessing
/// oracle. A session id is random, rotates every handshake, and reveals nothing.
pub const HEADER_SID: &str = "x-orca-sid";
pub const HEADER_ENCRYPTED_BODY: &str = "x-orca-encrypted-body";
/// Proof-of-possession authenticator. See [`verify_authenticator`].
pub const HEADER_AUTH: &str = "x-orca-auth";
/// Plaintext byte range the Service Worker wants (`"start-end"`, end inclusive,
/// or `"start-"` open). Sent as a custom header rather than HTTP `Range` so the
/// server↦SW hop stays a plain `200` — the transport never sees Range semantics
/// whose byte math wouldn't match the ciphertext body length.
pub const HEADER_RANGE_REQ: &str = "x-orca-range";
/// Response headers describing the encrypted-media layout to the Service Worker.
pub const HEADER_PLAIN_LEN: &str = "x-orca-plain-len";
pub const HEADER_CHUNK: &str = "x-orca-chunk";
/// Index of the first chunk in the response body, so the SW knows each chunk's
/// nonce and the plaintext offset the window starts at.
pub const HEADER_CHUNK_INDEX: &str = "x-orca-chunk-index";
const MAX_ENVELOPE_BYTES: usize = 3 * 1024 * 1024;

/// HKDF `info` domains — one per key role, so a session key and a media key can
/// never collide even off the same input.
const SESSION_INFO: &[u8] = b"orca-osc-v2-session\0";
const MEDIA_INFO: &[u8] = b"orca-osc-v2-media\0";

/// Plaintext bytes per media chunk. Each sealed chunk is this plus a 16-byte GCM
/// tag; the Service Worker and the media routes both hardcode it.
pub const MEDIA_CHUNK: usize = 65536;
/// AES-GCM tag length appended to every sealed chunk.
pub const MEDIA_TAG: usize = 16;

/// An authenticator older/newer than this is refused, bounding how long a
/// captured one stays replayable to the size of the nonce cache's memory.
const MAX_SKEW_SECS: i64 = 300;
/// A sealed authenticator is a handful of bytes; anything larger is not ours.
const MAX_AUTH_BYTES: usize = 1024;

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u8,
    n: String,
    c: String,
}

/// The plaintext inside an authenticator: a timestamp and a single-use nonce.
#[derive(Debug, Serialize, Deserialize)]
struct Authenticator {
    t: i64,
    n: String,
}

pub fn auth_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub fn auth_hash_from_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Derive the forward-secret session key both peers share after the handshake.
///
/// `shared_x` is the X coordinate of the ephemeral P-256 ECDH point — the only
/// high-entropy secret, and the source of forward secrecy: it exists only while
/// both ephemeral private keys do. The token-derived `psk` is mixed into the
/// HKDF `info` so only a token holder derives the same key (authentication),
/// while the nonces (`n_c`, `n_s`) as salt make each session key unique even for
/// a repeated ECDH point. An eavesdropper who never learns `shared_x` gains no
/// offline guessing oracle for the token from any of the public handshake values.
pub fn session_key(shared_x: &[u8; 32], n_c: &[u8], n_s: &[u8], psk: &[u8; 32]) -> [u8; 32] {
    let mut salt = Vec::with_capacity(n_c.len() + n_s.len());
    salt.extend_from_slice(n_c);
    salt.extend_from_slice(n_s);
    let mut info = Vec::with_capacity(SESSION_INFO.len() + psk.len());
    info.extend_from_slice(SESSION_INFO);
    info.extend_from_slice(psk);
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared_x)
        .expand(&info, &mut okm)
        .expect("32 is a valid HKDF-SHA256 output length");
    okm
}

/// Per-resource media sub-key, derived from the session key and a resource label.
/// Keeping media under its own key (and out of the JSON key's domain) lets a
/// chunk nonce be the plain chunk index: the `(stream_key, index)` pair never
/// repeats across different plaintext within a session, which is all AES-GCM
/// requires. `resource` must uniquely name the byte stream — e.g. `"file:<slug>"`
/// vs `"thumb:<slug>"` — so two streams that share a slug get independent keys and
/// their chunk-0 nonces never collide. The label is not secret.
pub fn media_stream_key(session_key: &[u8; 32], resource: &str) -> [u8; 32] {
    let mut info = Vec::with_capacity(MEDIA_INFO.len() + resource.len());
    info.extend_from_slice(MEDIA_INFO);
    info.extend_from_slice(resource.as_bytes());
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(None, session_key)
        .expand(&info, &mut okm)
        .expect("32 is a valid HKDF-SHA256 output length");
    okm
}

/// Build the AEAD cipher for a media stream once, so a multi-chunk window pays the
/// AES-256 key schedule a single time instead of once per 64 KiB chunk. Reused by
/// [`seal_into`] across every chunk of one response.
pub fn media_cipher(stream_key: &[u8; 32]) -> AppResult<Aes256Gcm> {
    Aes256Gcm::new_from_slice(stream_key)
        .map_err(|_| AppError::Internal("media cipher init failed".into()))
}

/// Seal one media chunk into `out` under an already-built `cipher`, with a
/// deterministic nonce = the chunk index (big-endian, right-aligned in the 12-byte
/// nonce). Safe because `stream_key` is unique per session+slug, so no
/// `(key, nonce)` pair is ever reused across differing plaintext.
///
/// The plaintext is appended to `out` and encrypted in place, then the 16-byte GCM
/// tag is appended — no per-chunk cipher construction, no per-chunk scratch `Vec`.
/// Appends exactly `plaintext.len() + 16` bytes.
pub fn seal_into(
    cipher: &Aes256Gcm,
    index: u64,
    plaintext: &[u8],
    out: &mut Vec<u8>,
) -> AppResult<()> {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&index.to_be_bytes());
    let start = out.len();
    out.extend_from_slice(plaintext);
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&nonce), &[], &mut out[start..])
        .map_err(|_| AppError::Internal("media chunk encryption failed".into()))?;
    out.extend_from_slice(&tag);
    Ok(())
}

/// Seal one standalone media chunk. Output is `plaintext.len() + 16` bytes. Thin
/// wrapper over [`media_cipher`] + [`seal_into`] for single-chunk callers/tests.
pub fn seal_chunk(stream_key: &[u8; 32], index: u64, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = media_cipher(stream_key)?;
    let mut out = Vec::with_capacity(plaintext.len() + MEDIA_TAG);
    seal_into(&cipher, index, plaintext, &mut out)?;
    Ok(out)
}

/// Inverse of [`seal_chunk`]; used by tests (the browser Service Worker opens
/// chunks itself with WebCrypto).
#[cfg(test)]
pub fn open_chunk(stream_key: &[u8; 32], index: u64, ciphertext: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(stream_key)
        .map_err(|_| AppError::Internal("media cipher init failed".into()))?;
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&index.to_be_bytes());
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext)
        .map_err(|_| AppError::BadRequest("media chunk authentication failed".into()))
}

pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Internal("E2EE cipher initialization failed".into()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AppError::Internal("E2EE response encryption failed".into()))?;
    serde_json::to_vec(&Envelope {
        v: 1,
        n: STANDARD.encode(nonce),
        c: STANDARD.encode(ciphertext),
    })
    .map_err(|e| AppError::Internal(format!("E2EE envelope serialization failed: {e}")))
}

pub fn open(key: &[u8; 32], envelope: &[u8], aad: &[u8]) -> AppResult<Vec<u8>> {
    let envelope: Envelope = serde_json::from_slice(envelope)
        .map_err(|_| AppError::BadRequest("invalid encrypted envelope".into()))?;
    if envelope.v != 1 {
        return Err(AppError::BadRequest(
            "unsupported encrypted envelope version".into(),
        ));
    }
    let nonce = STANDARD
        .decode(envelope.n)
        .map_err(|_| AppError::BadRequest("invalid encrypted nonce".into()))?;
    let ciphertext = STANDARD
        .decode(envelope.c)
        .map_err(|_| AppError::BadRequest("invalid encrypted payload".into()))?;
    let nonce = Nonce::from_exact_iter(nonce)
        .ok_or_else(|| AppError::BadRequest("invalid encrypted nonce".into()))?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Internal("E2EE cipher initialization failed".into()))?
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| AppError::BadRequest("encrypted payload authentication failed".into()))
}

/// AAD binding an authenticator to the exact request it authorizes, so one
/// captured for `GET /api/health` cannot be lifted onto `DELETE /api/items/x`.
pub fn authenticator_aad(method: &str, target: &str) -> Vec<u8> {
    format!("orca-auth-v1\n{method}\n{target}").into_bytes()
}

/// Remember nonces for the length of the skew window and reject repeats. Bounded
/// by construction: an entry outside the window is unusable, so pruning expired
/// entries on every insert caps the map at the honest request rate × 300s.
fn nonce_is_fresh(nonce: &str, now: i64) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    let mut seen = SEEN
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    seen.retain(|_, t| now - *t <= MAX_SKEW_SECS);
    seen.insert(nonce.to_string(), now).is_none()
}

/// Verify a client's proof that it holds the encryption key.
///
/// The key id is *not* a credential: it is derived from the token by a public
/// function and travels in cleartext on every request (and in the SSE query
/// string), so anyone who can see one request can replay it. Authenticating on
/// the key id alone therefore let an eavesdropper drive every side-effecting
/// route that needs no request body — `DELETE /api/items/:slug`, `POST
/// /api/items/:slug/retry`, client trust/revoke — because the encrypted response
/// they couldn't read was the only thing standing in their way, and a delete
/// doesn't care whether you read the receipt.
///
/// So the key id now only *selects* a candidate key, and possession is proven the
/// one way that doesn't leak: the client seals a fresh timestamp and nonce under
/// that key, AAD-bound to this exact method and target. Opening it authenticates
/// the request (only a key holder can produce a valid seal), the timestamp bounds
/// the replay window, and the nonce cache closes it entirely. This is the
/// standard signed-request construction — AWS SigV4 and RFC 9421 HTTP Message
/// Signatures both bind (method, target, timestamp, nonce) the same way.
pub fn verify_authenticator(
    key: &[u8; 32],
    header_value: &str,
    method: &str,
    target: &str,
    now: i64,
) -> AppResult<()> {
    if header_value.len() > MAX_AUTH_BYTES {
        return Err(AppError::Unauthorized);
    }
    let envelope = STANDARD
        .decode(header_value)
        .map_err(|_| AppError::Unauthorized)?;
    let aad = authenticator_aad(method, target);
    // A failure here is an authentication failure, not a client error: the seal
    // is the credential, so report it as such and say nothing about which check
    // it tripped.
    let plaintext = open(key, &envelope, &aad).map_err(|_| AppError::Unauthorized)?;
    let auth: Authenticator =
        serde_json::from_slice(&plaintext).map_err(|_| AppError::Unauthorized)?;
    if (now - auth.t).abs() > MAX_SKEW_SECS {
        return Err(AppError::Unauthorized);
    }
    if auth.n.is_empty() || !nonce_is_fresh(&auth.n, now) {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

pub async fn decrypt_request(request: Request, key: &[u8; 32], aad: &[u8]) -> AppResult<Request> {
    let (mut parts, body) = request.into_parts();
    let encrypted = to_bytes(body, MAX_ENVELOPE_BYTES)
        .await
        .map_err(|_| AppError::BadRequest("encrypted request body is too large".into()))?;
    let plaintext = if encrypted.is_empty() {
        Vec::new()
    } else {
        open(key, &encrypted, aad)?
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    if !plaintext.is_empty() {
        parts.headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
    }
    Ok(Request::from_parts(parts, Body::from(plaintext)))
}

pub async fn encrypt_response(
    response: Response,
    key: &[u8; 32],
    aad: &[u8],
) -> AppResult<Response> {
    let (mut parts, body) = response.into_parts();
    let plaintext = to_bytes(body, MAX_ENVELOPE_BYTES)
        .await
        .map_err(|_| AppError::Internal("E2EE response body is too large".into()))?;
    let encrypted = seal(key, &plaintext, aad)?;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.orca.e2ee+json"),
    );
    parts.headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    parts
        .headers
        .insert(HEADER_E2EE, HeaderValue::from_static("1"));
    Ok(Response::from_parts(parts, Body::from(encrypted)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic session key standing in for a completed handshake.
    fn test_key() -> [u8; 32] {
        let psk = auth_hash("test-token");
        session_key(&[7u8; 32], b"nonce-c-16-bytes", b"nonce-s-16-bytes", &psk)
    }

    #[test]
    fn session_key_binds_psk_nonces_and_ecdh_point() {
        let psk = auth_hash("test-token");
        let base = session_key(&[7u8; 32], b"nc", b"ns", &psk);
        // Different token, ECDH point, or nonces all yield a different key.
        assert_ne!(base, session_key(&[7u8; 32], b"nc", b"ns", &auth_hash("other")));
        assert_ne!(base, session_key(&[9u8; 32], b"nc", b"ns", &psk));
        assert_ne!(base, session_key(&[7u8; 32], b"nX", b"ns", &psk));
        // Stable for identical inputs (both peers must land on the same key).
        assert_eq!(base, session_key(&[7u8; 32], b"nc", b"ns", &psk));
        assert_eq!(auth_hash_from_hex(&hex(&psk)), Some(psk));
    }

    #[test]
    fn media_chunks_round_trip_and_are_index_bound() {
        let stream = media_stream_key(&test_key(), "abc123");
        let chunk = b"the quick brown fox".repeat(1000);
        let sealed = seal_chunk(&stream, 5, &chunk).unwrap();
        assert_eq!(sealed.len(), chunk.len() + MEDIA_TAG);
        assert_eq!(open_chunk(&stream, 5, &sealed).unwrap(), chunk);
        // A chunk sealed at index 5 must not open at index 6 (reorder/splice guard).
        assert!(open_chunk(&stream, 6, &sealed).is_err());
        // A different item's stream key can't open it either.
        let other = media_stream_key(&test_key(), "xyz789");
        assert!(open_chunk(&other, 5, &sealed).is_err());
    }

    #[test]
    fn aes_gcm_round_trip_binds_aad_and_rejects_tampering() {
        let key = test_key();
        let sealed = seal(&key, br#"{"ok":true}"#, b"GET\n/api/items").unwrap();
        assert_eq!(
            open(&key, &sealed, b"GET\n/api/items").unwrap(),
            br#"{"ok":true}"#
        );
        assert!(open(&key, &sealed, b"GET\n/api/settings").is_err());
        let mut tampered = sealed;
        let pos = tampered.len() - 3;
        tampered[pos] ^= 1;
        assert!(open(&key, &tampered, b"GET\n/api/items").is_err());
    }

    #[tokio::test]
    async fn encrypted_response_is_marked_for_clients() {
        let key = test_key();
        let response = Response::new(Body::from(r#"{"ok":true}"#));
        let response = encrypt_response(response, &key, b"200\n/api/test")
            .await
            .unwrap();
        assert_eq!(response.headers().get(HEADER_E2EE).unwrap(), "1");
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/vnd.orca.e2ee+json"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Build the authenticator a legitimate client would send.
    fn authenticator(key: &[u8; 32], method: &str, target: &str, t: i64, nonce: &str) -> String {
        let payload = serde_json::to_vec(&Authenticator { t, n: nonce.into() }).unwrap();
        STANDARD.encode(seal(key, &payload, &authenticator_aad(method, target)).unwrap())
    }

    #[test]
    fn authenticator_proves_key_possession_for_one_request() {
        let key = test_key();
        let now = 1_700_000_000;
        let auth = authenticator(&key, "DELETE", "/api/items/abc", now, "nonce-a");
        assert!(verify_authenticator(&key, &auth, "DELETE", "/api/items/abc", now).is_ok());
    }

    /// The regression this whole construction exists for: knowing the key id (a
    /// public, replayable value) must not be enough. Without the key, no valid
    /// authenticator can be produced, so a bodyless DELETE cannot be forged.
    #[test]
    fn authenticator_from_a_different_key_is_refused() {
        let owner = test_key();
        let attacker = session_key(&[7u8; 32], b"nonce-c-16-bytes", b"nonce-s-16-bytes", &auth_hash("guessed-token"));
        let now = 1_700_000_000;
        let forged = authenticator(&attacker, "DELETE", "/api/items/abc", now, "nonce-b");
        assert!(verify_authenticator(&owner, &forged, "DELETE", "/api/items/abc", now).is_err());
    }

    #[test]
    fn authenticator_cannot_be_lifted_onto_another_route_or_method() {
        let key = test_key();
        let now = 1_700_000_000;
        let auth = authenticator(&key, "GET", "/api/health", now, "nonce-c");
        assert!(verify_authenticator(&key, &auth, "DELETE", "/api/items/abc", now).is_err());
        assert!(verify_authenticator(&key, &auth, "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, &auth, "POST", "/api/health", now).is_err());
    }

    #[test]
    fn authenticator_is_single_use_and_time_bound() {
        let key = test_key();
        let now = 1_700_000_000;
        let auth = authenticator(&key, "POST", "/api/items/x/retry", now, "nonce-d");
        assert!(verify_authenticator(&key, &auth, "POST", "/api/items/x/retry", now).is_ok());
        // Replaying the captured header is refused by the nonce cache.
        assert!(verify_authenticator(&key, &auth, "POST", "/api/items/x/retry", now).is_err());

        // And one from outside the skew window never gets that far.
        let stale = authenticator(&key, "POST", "/api/items/x/retry", now, "nonce-e");
        let later = now + MAX_SKEW_SECS + 1;
        assert!(verify_authenticator(&key, &stale, "POST", "/api/items/x/retry", later).is_err());
    }

    #[test]
    fn malformed_authenticators_are_refused() {
        let key = test_key();
        let now = 1_700_000_000;
        assert!(verify_authenticator(&key, "", "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, "not-base64!!", "GET", "/api/items", now).is_err());
        assert!(
            verify_authenticator(&key, &STANDARD.encode("{}"), "GET", "/api/items", now).is_err()
        );
        assert!(verify_authenticator(
            &key,
            &"A".repeat(MAX_AUTH_BYTES + 1),
            "GET",
            "/api/items",
            now
        )
        .is_err());
    }
}
