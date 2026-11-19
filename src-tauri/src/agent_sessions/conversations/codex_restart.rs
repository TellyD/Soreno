use super::{forget_run, get, provider, AgentSession, Provider, Result};
use rusqlite::Connection;
use std::path::Path;

pub(in crate::agent_sessions) fn forget_codex_update_run(
    db: &Connection,
    session: &AgentSession,
    restart_requested: impl FnOnce() -> bool,
) -> Result<()> {
    if provider(&session.executable) != Some(Provider::Codex) {
        return Ok(());
    }
    let Ok(Some(record)) = get(db, &session.id) else {
        return Ok(());
    };
    let Some(path) = record.metadata_path.as_deref() else {
        return Ok(());
    };
    if !record.pending
        || record.provider != Provider::Codex.as_str()
        || !matches!(Path::new(path).try_exists(), Ok(false))
        || !restart_requested()
    {
        return Ok(());
    }
    forget_run(db, &session.id, record)
}

// ConPTY may replace spaces with cursor moves.
pub(in crate::agent_sessions) fn codex_requested_restart(
    output: impl IntoIterator<Item = u8>,
) -> bool {
    const BANNER: &[u8] = b"Updateransuccessfully!PleaserestartCodex.";
    let mut text = Vec::new();
    let mut bytes = output.into_iter();
    while let Some(byte) = bytes.next() {
        if byte != 0x1b {
            if !byte.is_ascii_whitespace() {
                text.push(byte);
            }
            continue;
        }
        match bytes.next() {
            Some(b'[') => {
                bytes.find(|byte| (0x40..=0x7e).contains(byte));
            }
            Some(b']') => {
                let mut escape = false;
                bytes.find(|&byte| {
                    let end = byte == 0x07 || escape && byte == b'\\';
                    escape = byte == 0x1b;
                    end
                });
            }
            _ => {}
        }
    }
    text.windows(BANNER.len()).any(|window| window == BANNER)
}
