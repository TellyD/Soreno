use super::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;

pub(super) const CHUNKED_LIMIT: usize = 64 * 1024 * 1024;

/// One `rpc_chunk` sequence being reassembled.
pub(super) struct Chunks {
    id: String,
    count: u64,
    byte_length: usize,
    next: u64,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkFrame {
    chunk_id: String,
    index: u64,
    count: u64,
    byte_length: usize,
    data: String,
}

/// Adds one frame to the sequence in `pending`; returns the object once complete. A refused
/// frame drops the whole sequence.
pub(super) fn reassemble(pending: &mut Option<Chunks>, frame: &Value) -> Result<Option<String>> {
    let result = add_chunk(pending, frame);
    if result.is_err() {
        *pending = None;
    }
    result
}

fn add_chunk(pending: &mut Option<Chunks>, frame: &Value) -> Result<Option<String>> {
    let frame = ChunkFrame::deserialize(frame).map_err(|error| error.to_string())?;
    if frame.count == 0 || frame.index >= frame.count || frame.byte_length > CHUNKED_LIMIT {
        return Err("Fragment RPC invalide.".into());
    }
    if frame.index == 0 {
        if pending.is_some() {
            return Err("Séquence de fragments RPC interrompue.".into());
        }
        *pending = Some(Chunks {
            id: frame.chunk_id.clone(),
            count: frame.count,
            byte_length: frame.byte_length,
            next: 0,
            bytes: Vec::new(),
        });
    }
    let chunks = pending.as_mut().ok_or("Fragment RPC hors séquence.")?;
    if chunks.id != frame.chunk_id
        || chunks.next != frame.index
        || chunks.count != frame.count
        || chunks.byte_length != frame.byte_length
    {
        return Err("Fragments RPC entrelacés ou incohérents.".into());
    }
    let bytes = STANDARD
        .decode(frame.data.as_bytes())
        .map_err(|_| "Fragment RPC illisible.")?;
    if chunks.bytes.len() + bytes.len() > chunks.byte_length {
        return Err("Fragments RPC plus longs qu’annoncé.".into());
    }
    chunks.bytes.extend_from_slice(&bytes);
    chunks.next += 1;
    if chunks.next < chunks.count {
        return Ok(None);
    }
    let chunks = pending.take().ok_or("Fragment RPC hors séquence.")?;
    if chunks.bytes.len() != chunks.byte_length {
        return Err("Fragments RPC de longueur inattendue.".into());
    }
    let text = String::from_utf8(chunks.bytes).map_err(|_| "Fragments RPC non UTF-8.")?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(_)) => Ok(Some(text)),
        _ => Err("Fragments RPC sans objet JSON.".into()),
    }
}
