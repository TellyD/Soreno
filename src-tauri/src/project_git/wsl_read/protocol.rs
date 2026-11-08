use super::{transport_error, GitError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::Read;

pub(super) const RESPONSE_FRAME_LIMIT: usize = 12 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireRequest<'a> {
    pub(super) v: u8,
    pub(super) id: u64,
    pub(super) args: &'a [String],
    pub(super) stdin: Option<String>,
    pub(super) timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireResponse {
    pub(super) v: u8,
    pub(super) id: Option<u64>,
    pub(super) kind: String,
    pub(super) status: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) stderr_truncated: bool,
    pub(super) terminated: bool,
    pub(super) message: Option<String>,
}

pub(super) fn read_response_frame(stream: &mut impl Read) -> Result<WireResponse, String> {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("Impossible de lire l’en-tête du relais Git WSL : {error}"))?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > RESPONSE_FRAME_LIMIT {
        return Err("Taille de réponse du relais Git WSL invalide.".into());
    }
    let mut payload = vec![0; size];
    stream
        .read_exact(&mut payload)
        .map_err(|error| format!("Réponse tronquée du relais Git WSL : {error}"))?;
    serde_json::from_slice(&payload)
        .map_err(|error| format!("Réponse JSON du relais Git WSL invalide : {error}"))
}

pub(super) fn decode_capture(encoded: &str, limit: usize) -> Result<Vec<u8>, GitError> {
    if encoded.len() > ((limit + 2) / 3) * 4 {
        return Err(transport_error(
            "Capture base64 du relais Git WSL trop volumineuse.",
        ));
    }
    BASE64
        .decode(encoded)
        .map_err(|_| transport_error("Capture base64 du relais Git WSL invalide."))
        .and_then(|bytes| {
            if bytes.len() <= limit {
                Ok(bytes)
            } else {
                Err(transport_error(
                    "Capture du relais Git WSL trop volumineuse.",
                ))
            }
        })
}
