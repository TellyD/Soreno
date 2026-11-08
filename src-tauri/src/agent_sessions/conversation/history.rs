use super::{clean_name, has_role, message_text, ConversationHistoryEntry, HistoryFile, Result};
use serde_json::Value;
use std::path::{Component, Path};

/// `None` for a file without an OMP session header.
pub(super) fn history_entry(
    file: HistoryFile,
    current: Option<&str>,
) -> Option<ConversationHistoryEntry> {
    let mut session = false;
    let mut title = None;
    // The last line may be cut: it then fails to parse and is skipped.
    for line in file.head.split(|byte| *byte == b'\n') {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("title") if !session => {
                title = record
                    .get("title")
                    .and_then(Value::as_str)
                    .and_then(clean_name);
            }
            // shortcut: older histories with their title in the session header (no `title` line) show their first message; read `session.title` if such files turn up.
            Some("session") => session = true,
            Some("message") if session => {
                let message = record.get("message").unwrap_or(&Value::Null);
                if has_role(message, "user") {
                    title = title.or_else(|| message_text(message).as_deref().and_then(clean_name));
                    break;
                }
            }
            _ => {}
        }
        if session && title.is_some() {
            break;
        }
    }
    session.then(|| ConversationHistoryEntry {
        current: current == Some(file.path.as_str()),
        path: file.path,
        title,
        modified: file.modified,
    })
}

/// OMP keeps every conversation of a directory in one folder: the view may only switch to a
/// history beside the one OMP holds, never open an arbitrary file.
pub(super) fn validate_switch(record: &Value, current: Option<&str>) -> Result<()> {
    let directory = current
        .and_then(|file| Path::new(file).parent())
        .ok_or("La conversation OMP n’est pas encore identifiée.")?;
    let path = Path::new(
        record
            .get("sessionPath")
            .and_then(Value::as_str)
            .ok_or("Chemin de conversation OMP manquant.")?,
    );
    let inside = path.parent() == Some(directory)
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        && !path
            .components()
            .any(|component| component == Component::ParentDir);
    if inside {
        Ok(())
    } else {
        Err("Cette conversation n’appartient pas aux conversations OMP du projet.".into())
    }
}
