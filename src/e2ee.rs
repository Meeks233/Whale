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
const MAX_ENVELOPE_BYTES: usize = 3 * 1024 * 1024;
const KID_DOMAIN: &[u8] = b"orca-e2ee-kid-v1\0";
const KEY_DOMAIN: &[u8] = b"orca-e2ee-key-v1\0";

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u8,
    n: String,
    c: String,
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
}
