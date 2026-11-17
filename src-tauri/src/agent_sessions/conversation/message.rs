use serde_json::Value;
use sha2::{Digest, Sha256};

/// Text parts of a message, joined; `None` without any text.
pub(super) fn message_text(message: &Value) -> Option<String> {
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// An assistant message's text, with its timestamp to tell identical replies apart.
pub(super) fn reply(message: &Value) -> Option<(String, Value)> {
    let timestamp = message.get("timestamp").cloned().unwrap_or_default();
    message_text(message).map(|text| (text, timestamp))
}

/// Stable across a dtach replay, which handles the same `agent_end` again: a summary posts once.
// shortcut: two sessions ending on the same text at the same millisecond share an id, so the second summary is skipped; hash the Soreno session id too if that shows up.
pub(super) fn turn_id(timestamp: &Value, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(timestamp.to_string());
    hash.update([0]);
    hash.update(text);
    format!("{:x}", hash.finalize())
}

pub(super) fn has_role(message: &Value, role: &str) -> bool {
    message.get("role").and_then(Value::as_str) == Some(role)
}
