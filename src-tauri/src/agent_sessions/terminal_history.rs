//! Output and working directory of a local shell, which its next start restores.
use super::{lock, Result, Runtime, BUFFER_LIMIT};
use rusqlite::{params, Connection, OptionalExtension};

/// Ends what the previous run may have left on: alternate screen, mouse and focus reports,
/// bracketed paste, application keys, scroll region, disabled autowrap, hidden cursor and colors.
/// The scroll region reset moves the cursor home, so DECSC/DECRC keep it after the history.
const RESET: &[u8] = b"\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b7\x1b[r\x1b8\x1b[?7h\x1b[?25h\x1b[0m";

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute(
        "CREATE TABLE IF NOT EXISTS agent_terminal_history (session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE, directory TEXT, output BLOB NOT NULL)",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn save(db: &Connection, session_id: &str, runtime: &Runtime) -> Result<()> {
    let (state, bytes) = {
        let output = lock(&runtime.output)?;
        let state = (output.end, output.directory.clone());
        if output.saved_history.as_ref() == Some(&state) {
            return Ok(());
        }
        let start = output.bytes.len().saturating_sub(BUFFER_LIMIT);
        (
            state,
            output.bytes.range(start..).copied().collect::<Vec<_>>(),
        )
    };
    db.execute(
        "INSERT INTO agent_terminal_history(session_id,directory,output) VALUES (?1,?2,?3)
         ON CONFLICT(session_id) DO UPDATE SET directory=excluded.directory, output=excluded.output",
        params![session_id, state.1, bytes],
    )
    .map_err(|error| error.to_string())?;
    lock(&runtime.output)?.saved_history = Some(state);
    Ok(())
}

/// The saved directory and output, empty when the session has none.
pub(super) fn load(db: &Connection, session_id: &str) -> Result<(Option<String>, Vec<u8>)> {
    Ok(db
        .query_row(
            "SELECT directory, output FROM agent_terminal_history WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default())
}

/// The saved output, followed by a dim rule across the terminal above the new run.
pub(super) fn replay(mut output: Vec<u8>, cols: u16) -> Vec<u8> {
    output.extend_from_slice(RESET);
    output.extend_from_slice(b"\r\n\x1b[2m");
    output.extend("─".repeat(cols.into()).bytes());
    output.extend_from_slice(b"\x1b[0m\r\n");
    output
}
