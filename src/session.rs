//! Secure-channel handshake and session store. See docs/SECURITY.md and
//! `src/e2ee.rs`.
//!
//! A client opens a session with an ephemeral P-256 ECDH exchange
//! (`POST /api/session`). The server keeps the psk-independent ECDH point in a
//! *pending* slot keyed by an opaque random session id; the client's first
//! authenticated request proves which token it holds (see `api::auth`), at which
//! point the slot is *activated* with the derived session key. Everything is
//! in-memory and self-pruning — no persistence, no configuration.

use crate::error::{AppError, AppResult};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use p256::ecdh::EphemeralSecret;
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{EncodedPoint, PublicKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A pending slot lives only long enough for the client to send its first
/// request; anything older is a handshake that never completed.
const PENDING_TTL_SECS: i64 = 60;
/// An idle session past this is forgotten, forcing a fresh handshake (and fresh
/// forward-secret keys). The client re-handshakes transparently.
const IDLE_TTL_SECS: i64 = 30 * 60;
/// Backstop so a flood of half-open handshakes can't grow the map without bound.
const MAX_SESSIONS: usize = 4096;
/// A client nonce outside this range is not a real handshake.
const NONCE_LEN: usize = 16;
/// Uncompressed SEC1 P-256 public key length (`0x04` ‖ X ‖ Y).
const PUBKEY_LEN: usize = 65;

#[derive(Debug, Deserialize)]
pub struct HelloRequest {
    /// base64 uncompressed SEC1 client ephemeral public key.
    epk: String,
    /// base64 16-byte client nonce.
    n: String,
}

#[derive(Debug, Serialize)]
pub struct HelloResponse {
    /// base64 uncompressed SEC1 server ephemeral public key.
    epk: String,
    /// base64 16-byte server nonce.
    n: String,
    /// Opaque session id the client echoes in `X-Orca-Sid`.
    sid: String,
}

struct Pending {
    shared_x: [u8; 32],
    n_c: Vec<u8>,
    n_s: Vec<u8>,
    created: i64,
}

#[derive(Clone)]
struct Active {
    key: [u8; 32],
    client_id: Option<i64>,
    last: i64,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<String, Pending>,
    active: HashMap<String, Active>,
}

/// Cloneable handle to the in-memory session table.
#[derive(Clone)]
pub struct SessionStore(Arc<Mutex<Inner>>);

impl Default for SessionStore {
    fn default() -> Self {
        SessionStore(Arc::new(Mutex::new(Inner::default())))
    }
}

/// The material a pending session needs before its key can be derived: the shared
/// ECDH point and both nonces. `api::auth` combines these with a candidate psk to
/// derive and verify the session key on the first request.
pub struct PendingHandshake {
    pub shared_x: [u8; 32],
    pub n_c: Vec<u8>,
    pub n_s: Vec<u8>,
}

impl SessionStore {
    /// Run the server half of the handshake and register a pending session.
    pub fn hello(&self, req: &HelloRequest) -> AppResult<HelloResponse> {
        let epk_c = STANDARD
            .decode(req.epk.as_bytes())
            .ok()
            .filter(|b| b.len() == PUBKEY_LEN)
            .ok_or_else(|| AppError::BadRequest("invalid handshake public key".into()))?;
        let n_c = STANDARD
            .decode(req.n.as_bytes())
            .ok()
            .filter(|b| b.len() == NONCE_LEN)
            .ok_or_else(|| AppError::BadRequest("invalid handshake nonce".into()))?;

        let point = EncodedPoint::from_bytes(&epk_c)
            .map_err(|_| AppError::BadRequest("invalid handshake public key".into()))?;
        let client_pk = Option::<PublicKey>::from(PublicKey::from_encoded_point(&point))
            .ok_or_else(|| AppError::BadRequest("invalid handshake public key".into()))?;

        let esk = EphemeralSecret::random(&mut OsRng);
        let epk_s = esk.public_key().to_encoded_point(false).as_bytes().to_vec();
        let shared_x: [u8; 32] = esk.diffie_hellman(&client_pk).raw_secret_bytes()[..]
            .try_into()
            .expect("P-256 shared secret is 32 bytes");

        let mut n_s = vec![0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut n_s);
        let mut sid_bytes = [0u8; 18];
        OsRng.fill_bytes(&mut sid_bytes);
        let sid = URL_SAFE_NO_PAD.encode(sid_bytes);

        let now = crate::types::now_unix();
        {
            let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
            prune(&mut inner, now);
            if inner.pending.len() + inner.active.len() >= MAX_SESSIONS {
                return Err(AppError::Internal("too many active sessions".into()));
            }
            inner.pending.insert(
                sid.clone(),
                Pending {
                    shared_x,
                    n_c: n_c.clone(),
                    n_s: n_s.clone(),
                    created: now,
                },
            );
        }

        Ok(HelloResponse {
            epk: STANDARD.encode(&epk_s),
            n: STANDARD.encode(&n_s),
            sid,
        })
    }

    /// The derived key + identity for an already-active session, refreshing its
    /// idle timer. `None` if the sid is unknown, expired, or still pending.
    pub fn active_key(&self, sid: &str) -> Option<(Option<i64>, [u8; 32])> {
        let now = crate::types::now_unix();
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut inner, now);
        let session = inner.active.get_mut(sid)?;
        session.last = now;
        Some((session.client_id, session.key))
    }

    /// The pending handshake material for a sid awaiting its first request.
    pub fn pending(&self, sid: &str) -> Option<PendingHandshake> {
        let now = crate::types::now_unix();
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut inner, now);
        inner.pending.get(sid).map(|p| PendingHandshake {
            shared_x: p.shared_x,
            n_c: p.n_c.clone(),
            n_s: p.n_s.clone(),
        })
    }

    /// Promote a pending session to active once its first request has proven
    /// which token it holds. Moves the sid out of `pending`.
    pub fn activate(&self, sid: &str, key: [u8; 32], client_id: Option<i64>) {
        let now = crate::types::now_unix();
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending.remove(sid);
        inner.active.insert(
            sid.to_string(),
            Active {
                key,
                client_id,
                last: now,
            },
        );
    }
}

/// Drop expired pending and idle active sessions. Called on every access, so the
/// map is bounded by the honest handshake rate × the TTLs.
fn prune(inner: &mut Inner, now: i64) {
    inner.pending.retain(|_, p| now - p.created <= PENDING_TTL_SECS);
    inner.active.retain(|_, a| now - a.last <= IDLE_TTL_SECS);
}
