//! Web Push, sent straight to the push service a phone's browser subscribed with (Apple's,
//! Google's, Mozilla's). The payload is encrypted for that browser (RFC 8291, `aes128gcm`) and
//! the request is signed with tri-code's VAPID key (RFC 8292), so no server of ours is involved.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hmac::{Hmac, Mac};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::rand_core::OsRng;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// What a browser's `PushManager.subscribe()` returns, as `toJSON()` shapes it.
#[derive(Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: Keys,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Keys {
    pub p256dh: String,
    pub auth: String,
}

/// Why a push failed. `Gone` means the browser dropped the subscription, so forget it.
pub enum PushError {
    Gone,
    Other(String),
}

/// A VAPID key pair from its stored private scalar, or a new one.
pub fn vapid_key(stored: Option<&str>) -> SigningKey {
    stored
        .and_then(|s| B64.decode(s).ok())
        .and_then(|b| SigningKey::from_slice(&b).ok())
        .unwrap_or_else(|| SigningKey::random(&mut OsRng))
}

pub fn vapid_private(key: &SigningKey) -> String {
    B64.encode(key.to_bytes())
}

/// The public key the page passes to `subscribe()` as `applicationServerKey`.
pub fn vapid_public(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac takes any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// RFC 8291: the `aes128gcm` body for `ua_public` (65 bytes) and `auth` (16 bytes), from the
/// sender key pair and salt. Split out from `encrypt` so the RFC's test vector can check it.
fn encrypt_with(
    plaintext: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "bad p256dh key".to_string())?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());

    let prk_key = hmac(auth, &[shared.raw_secret_bytes()]);
    let ikm = hmac(&prk_key, &[b"WebPush: info\0", ua_public, as_public, &[1]]);
    let prk = hmac(salt, &[&ikm]);
    let cek = hmac(&prk, &[b"Content-Encoding: aes128gcm\0", &[1]]);
    let nonce = hmac(&prk, &[b"Content-Encoding: nonce\0", &[1]]);

    // One record: the payload, then the last-record delimiter.
    let mut record = plaintext.to_vec();
    record.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek[..16]).map_err(|e| e.to_string())?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce[..12]), record.as_slice())
        .map_err(|e| e.to_string())?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

fn encrypt(plaintext: &[u8], sub: &Subscription) -> Result<Vec<u8>, String> {
    let ua_public = B64.decode(sub.keys.p256dh.trim_end_matches('=')).map_err(|e| e.to_string())?;
    let auth = B64.decode(sub.keys.auth.trim_end_matches('=')).map_err(|e| e.to_string())?;
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    encrypt_with(plaintext, &ua_public, &auth, &SecretKey::random(&mut OsRng), &salt)
}

/// RFC 8292: the `Authorization` header for a push service's origin.
fn vapid_header(key: &SigningKey, endpoint: &str) -> Result<String, String> {
    let url = ureq::http::Uri::try_from(endpoint).map_err(|e| e.to_string())?;
    let aud = format!("{}://{}", url.scheme_str().unwrap_or("https"), url.authority().ok_or("bad endpoint")?);
    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + 12 * 3600;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    // Apple rejects a push whose `sub` is not a mailto: or https: URL.
    let claims = B64.encode(
        serde_json::json!({ "aud": aud, "exp": exp, "sub": "https://github.com/WaldoJoubert-GH/tri-code" }).to_string(),
    );
    let signed = format!("{header}.{claims}");
    let sig: Signature = key.sign(signed.as_bytes());
    Ok(format!("vapid t={signed}.{}, k={}", B64.encode(sig.to_bytes()), vapid_public(key)))
}

/// Send one push. Blocking: call it off the async runtime.
pub fn send(key: &SigningKey, sub: &Subscription, payload: &str) -> Result<(), PushError> {
    let body = encrypt(payload.as_bytes(), sub).map_err(PushError::Other)?;
    let auth = vapid_header(key, &sub.endpoint).map_err(PushError::Other)?;
    let config = ureq::config::Config::builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build();
    let res = ureq::Agent::new_with_config(config)
        .post(&sub.endpoint)
        .header("TTL", "86400")
        .header("Urgency", "high")
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", &auth)
        .send(&body[..])
        .map_err(|e| PushError::Other(e.to_string()))?;
    match res.status().as_u16() {
        200..=299 => Ok(()),
        404 | 410 => Err(PushError::Gone),
        code => {
            let text = res.into_body().read_to_string().unwrap_or_default();
            Err(PushError::Other(format!("push service said {code}: {text}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8291 §5: the example message, keys and salt, and the body they encrypt to.
    #[test]
    fn rfc8291_vector() {
        let d = |s: &str| B64.decode(s).unwrap();
        let as_private = d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        let as_secret = SecretKey::from_slice(&as_private).unwrap();
        let ua_public = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(b"When I grow up, I want to be a watermelon", &ua_public, &auth, &as_secret, &salt).unwrap();
        assert_eq!(
            B64.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }
}
