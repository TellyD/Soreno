use super::{
    connected_ssh, ensure_stopped, id, kanban_issue_sessions, lock, require_project,
    require_session, stop_remote_sessions_before_delete, AgentSessions, Result,
};
use crate::sqlite::table_column_exists;
use rusqlite::{params, Connection};

const NOT_KEPT_MESSAGE: &str =
    "Seule une session favorite ou liée à une issue peut être fermée sans être supprimée.";
const CLOSED_MESSAGE: &str = "Rouvrez cette session avant de la démarrer.";

pub(super) fn initialize(db: &Connection) -> Result<()> {
    if !table_column_exists(db, "agent_sessions", "closed").map_err(|error| error.to_string())? {
        db.execute(
            "ALTER TABLE agent_sessions ADD COLUMN closed INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn closed_session_ids(db: &Connection) -> Result<Vec<String>> {
    db.prepare("SELECT id FROM agent_sessions WHERE closed=1 ORDER BY rowid")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

pub(super) fn ensure_not_closed(db: &Connection, session_id: &str) -> Result<()> {
    let closed: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE closed=1 AND id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if closed {
        return Err(CLOSED_MESSAGE.into());
    }
    Ok(())
}

/// A session stays closed only while a favorite or an issue keeps it reachable.
pub(super) fn reopen_unkept_sessions(db: &Connection) -> Result<()> {
    db.execute(
        "UPDATE agent_sessions SET closed=0 WHERE closed=1
            AND NOT COALESCE(json_extract(data, '$.favorite'), 0)
            AND NOT EXISTS(SELECT 1 FROM agent_kanban_issue_sessions link WHERE link.session_id=agent_sessions.id)
            AND NOT EXISTS(SELECT 1 FROM agent_linear_issue_sessions link WHERE link.session_id=agent_sessions.id)",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

impl AgentSessions {
    pub fn set_session_closed(&self, session_id: &str, closed: bool) -> Result<()> {
        id(session_id)?;
        let operation = self.session_operation(session_id)?;
        let _operation = lock(&operation)?;
        let store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        if closed {
            if !session.favorite && !kanban_issue_sessions::has_live_link(&store.db, session_id)? {
                return Err(NOT_KEPT_MESSAGE.into());
            }
            ensure_stopped(&store, session_id)?;
            let project = require_project(&store, &session.project_id)?;
            if let Some(connection) = connected_ssh(&store, &project)? {
                stop_remote_sessions_before_delete(&connection, &[session_id])?;
            }
        }
        store
            .db
            .execute(
                "UPDATE agent_sessions SET closed=?2 WHERE id=?1",
                params![session_id, closed],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
