//! Token-derived application-layer encryption for authenticated JSON APIs.

use crate::error::{AppError, AppResult};
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::response::Response;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const HEADER_E2EE: &str = "x-orca-e2ee";
pub const HEADER_KEY_ID: &str = "x-orca-key-id";
pub const HEADER_ENCRYPTED_BODY: &str = "x-orca-encrypted-body";
/// Proof-of-possession authenticator. See [`verify_authenticator`].
pub const HEADER_AUTH: &str = "x-orca-auth";
const MAX_ENVELOPE_BYTES: usize = 3 * 1024 * 1024;
const KID_DOMAIN: &[u8] = b"orca-e2ee-kid-v1\0";
const KEY_DOMAIN: &[u8] = b"orca-e2ee-key-v1\0";

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

pub fn key_id(hash: &[u8; 32]) -> String {
    let digest = Sha256::new()
        .chain_update(KID_DOMAIN)
        .chain_update(hash)
        .finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn encryption_key(hash: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update(KEY_DOMAIN)
        .chain_update(hash)
        .finalize()
        .into()
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

    #[test]
    fn token_derivation_is_domain_separated_and_stable() {
        let hash = auth_hash("test-token");
        assert_eq!(key_id(&hash).len(), 64);
        assert_ne!(key_id(&hash).as_bytes(), encryption_key(&hash));
        assert_eq!(auth_hash_from_hex(&hex(&hash)), Some(hash));
    }

    #[test]
    fn aes_gcm_round_trip_binds_aad_and_rejects_tampering() {
        let key = encryption_key(&auth_hash("test-token"));
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
        let key = encryption_key(&auth_hash("test-token"));
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
        let payload = serde_json::to_vec(&Authenticator {
            t,
            n: nonce.into(),
        })
        .unwrap();
        STANDARD.encode(seal(key, &payload, &authenticator_aad(method, target)).unwrap())
    }

    #[test]
    fn authenticator_proves_key_possession_for_one_request() {
        let key = encryption_key(&auth_hash("test-token"));
        let now = 1_700_000_000;
        let auth = authenticator(&key, "DELETE", "/api/items/abc", now, "nonce-a");
        assert!(verify_authenticator(&key, &auth, "DELETE", "/api/items/abc", now).is_ok());
    }

    /// The regression this whole construction exists for: knowing the key id (a
    /// public, replayable value) must not be enough. Without the key, no valid
    /// authenticator can be produced, so a bodyless DELETE cannot be forged.
    #[test]
    fn authenticator_from_a_different_key_is_refused() {
        let owner = encryption_key(&auth_hash("test-token"));
        let attacker = encryption_key(&auth_hash("guessed-token"));
        let now = 1_700_000_000;
        let forged = authenticator(&attacker, "DELETE", "/api/items/abc", now, "nonce-b");
        assert!(verify_authenticator(&owner, &forged, "DELETE", "/api/items/abc", now).is_err());
    }

    #[test]
    fn authenticator_cannot_be_lifted_onto_another_route_or_method() {
        let key = encryption_key(&auth_hash("test-token"));
        let now = 1_700_000_000;
        let auth = authenticator(&key, "GET", "/api/health", now, "nonce-c");
        assert!(verify_authenticator(&key, &auth, "DELETE", "/api/items/abc", now).is_err());
        assert!(verify_authenticator(&key, &auth, "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, &auth, "POST", "/api/health", now).is_err());
    }

    #[test]
    fn authenticator_is_single_use_and_time_bound() {
        let key = encryption_key(&auth_hash("test-token"));
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
        let key = encryption_key(&auth_hash("test-token"));
        let now = 1_700_000_000;
        assert!(verify_authenticator(&key, "", "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, "not-base64!!", "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, &STANDARD.encode("{}"), "GET", "/api/items", now).is_err());
        assert!(verify_authenticator(&key, &"A".repeat(MAX_AUTH_BYTES + 1), "GET", "/api/items", now).is_err());
    }
}
