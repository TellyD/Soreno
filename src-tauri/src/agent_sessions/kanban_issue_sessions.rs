use super::{
    closed_sessions, conversations::AgentTurn, id, lock, require_project, require_session, text,
    AgentSession, AgentSessions, Result,
};
use crate::kanban::{self, KanbanIssueCompletion, KanbanSource};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const SUMMARY_OPEN: &str = "<soreno-summary>";
const SUMMARY_CLOSE: &str = "</soreno-summary>";
pub(super) const NOT_LINKED_MESSAGE: &str =
    "[Kanban/sessionNotLinked] Cette session d’agent n’est liée à aucune issue.";
const ISSUE_HAS_SESSION_MESSAGE: &str =
    "[Kanban/issueHasSession] Cette issue a déjà une session d’agent.";
const SESSION_HAS_ISSUE_MESSAGE: &str =
    "[Kanban/sessionHasIssue] Cette session d’agent est déjà liée à une issue.";
const TRANSFER_LATE_COMMENT_MESSAGE: &str =
    "un commentaire a été ajouté pendant l’envoi, l’issue locale est conservée.";
const TRANSFER_DESCRIPTION_CHANGED_MESSAGE: &str =
    "la description a été modifiée pendant l’envoi, l’issue locale est conservée.";
/// Local links first, then Linear ones, each table in link order.
const LINK_TABLES: [&str; 2] = ["agent_kanban_issue_sessions", "agent_linear_issue_sessions"];

/// A summary the agent ended a turn with, not yet posted to its Kanban issue.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentIssueSummary {
    pub id: String,
    pub text: String,
}

/// A Linear summary reserved for posting: the session's earlier comment, if any, receives it.
#[derive(Debug, PartialEq)]
pub struct ClaimedIssueSummary {
    pub issue_id: String,
    pub comment_id: Option<String>,
}

/// A local comment as the transfer copied it to Linear.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferredComment {
    pub id: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionKanbanIssue {
    pub source: KanbanSource,
    pub issue_id: String,
    pub issue_identifier: String,
    pub session_id: Option<String>,
    pub session_name: String,
    pub executable: String,
    pub project_name: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub end_reason: Option<String>,
    pub merged_into: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum SessionEnd<'a> {
    Session,
    Project,
    Worktree,
    Merged(&'a str),
}

impl<'a> SessionEnd<'a> {
    fn reason(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Worktree => "worktree",
            Self::Merged(_) => "merged",
        }
    }
    fn merged_into(self) -> Option<&'a str> {
        match self {
            Self::Merged(branch) => Some(branch),
            _ => None,
        }
    }
}

pub(super) fn list_issue_sessions(db: &Connection) -> Result<Vec<AgentSessionKanbanIssue>> {
    let mut statement = db
        .prepare(
            "SELECT 0, link.rowid, link.issue_id, team.key || '-' || issue.number, link.session_id, link.session_name,
                link.executable, link.project_name, link.started_at, link.ended_at, link.end_reason, link.merged_into
            FROM agent_kanban_issue_sessions link
            JOIN kanban_issues issue ON issue.id=link.issue_id
            JOIN kanban_teams team ON team.id=issue.team_id
            WHERE link.session_id IS NOT NULL OR link.ended_at IS NOT NULL
            UNION ALL
            SELECT 1, rowid, linear_issue_id, linear_issue_identifier, session_id, session_name,
                executable, project_name, started_at, ended_at, end_reason, merged_into
            FROM agent_linear_issue_sessions
            WHERE session_id IS NOT NULL OR ended_at IS NOT NULL
            ORDER BY 1, 2",
        )
        .map_err(|error| error.to_string())?;
    let links = statement
        .query_map([], |row| {
            let linear: bool = row.get(0)?;
            Ok(AgentSessionKanbanIssue {
                source: if linear {
                    KanbanSource::Linear
                } else {
                    KanbanSource::Local
                },
                issue_id: row.get(2)?,
                issue_identifier: row.get(3)?,
                session_id: row.get(4)?,
                session_name: row.get(5)?,
                executable: row.get(6)?,
                project_name: row.get(7)?,
                started_at: row.get(8)?,
                ended_at: row.get(9)?,
                end_reason: row.get(10)?,
                merged_into: row.get(11)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())?;
    Ok(links)
}

pub(super) fn end_issue_sessions(
    db: &Connection,
    sessions: &[AgentSession],
    end: SessionEnd<'_>,
) -> Result<()> {
    for table in LINK_TABLES {
        let mut statement = db
            .prepare(&format!(
                "UPDATE {table} SET session_id=NULL, ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), end_reason=?2, merged_into=?3, session_name=?4, executable=?5
                WHERE session_id=?1"
            ))
            .map_err(|error| error.to_string())?;
        for session in sessions {
            statement
                .execute(params![
                    session.id,
                    end.reason(),
                    end.merged_into(),
                    session.display_name(),
                    session.executable
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn has_live_link(db: &Connection, session_id: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_kanban_issue_sessions WHERE session_id=?1)
            OR EXISTS(SELECT 1 FROM agent_linear_issue_sessions WHERE session_id=?1)",
        [session_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// The Linear issue the session works on, if any.
pub(super) fn linked_linear_issue(db: &Connection, session_id: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT linear_issue_id FROM agent_linear_issue_sessions WHERE session_id=?1",
        [session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// Comments of the issue, oldest first, whose (id, body) is not in `known`: new or edited since.
pub(super) fn late_comments(
    db: &Connection,
    issue_id: &str,
    known: &[TransferredComment],
) -> Result<Vec<TransferredComment>> {
    let mut statement = db
        .prepare(
            "SELECT id, body FROM kanban_comments WHERE issue_id=?1 ORDER BY created_at, rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([issue_id], |row| {
            Ok(TransferredComment {
                id: row.get(0)?,
                body: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut late = Vec::new();
    for comment in rows {
        let comment = comment.map_err(|error| error.to_string())?;
        if !known.contains(&comment) {
            late.push(comment);
        }
    }
    Ok(late)
}

/// The Linear issue exists but the local one is kept as is.
pub(crate) fn transfer_incomplete(linear_issue_identifier: &str, error: &str) -> String {
    format!("[Kanban/transferIncomplete] {linear_issue_identifier} : {error}")
}

/// A session works on one issue at a time across both sources, and an issue has one live session.
fn ensure_linkable(
    db: &Connection,
    table: &str,
    issue_column: &str,
    issue_id: &str,
    session_id: &str,
) -> Result<()> {
    let existing: Option<bool> = db
        .query_row(
            &format!(
                "SELECT {issue_column}=?1 FROM {table}
                WHERE session_id IS NOT NULL AND ({issue_column}=?1 OR session_id=?2)
                ORDER BY {issue_column}=?1 DESC"
            ),
            [issue_id, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match existing {
        Some(true) => Err(ISSUE_HAS_SESSION_MESSAGE.into()),
        Some(false) => Err(SESSION_HAS_ISSUE_MESSAGE.into()),
        None if has_live_link(db, session_id)? => Err(SESSION_HAS_ISSUE_MESSAGE.into()),
        None => Ok(()),
    }
}

/// The block must end the message, so a marker quoted or discussed earlier is ignored.
fn summary_text(message: &str) -> Option<&str> {
    let body = message.trim_end().strip_suffix(SUMMARY_CLOSE)?;
    let start = body.rfind(SUMMARY_OPEN)? + SUMMARY_OPEN.len();
    Some(body[start..].trim()).filter(|text| !text.is_empty())
}

pub(super) fn pending_summary(
    db: &Connection,
    session_id: &str,
    turn: AgentTurn,
) -> Result<Option<AgentIssueSummary>> {
    let Some(text) = turn.message.as_deref().and_then(summary_text) else {
        return Ok(None);
    };
    let pending: bool = db
        .query_row(
            "SELECT (EXISTS(SELECT 1 FROM agent_kanban_issue_sessions WHERE session_id=?1)
                    OR EXISTS(SELECT 1 FROM agent_linear_issue_sessions WHERE session_id=?1))
                AND NOT EXISTS(SELECT 1 FROM agent_kanban_issue_summaries WHERE summary_id=?2)
                AND NOT EXISTS(SELECT 1 FROM agent_linear_issue_summaries WHERE summary_id=?2)",
            [session_id, &turn.id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(pending.then(|| AgentIssueSummary {
        text: text.into(),
        id: turn.id,
    }))
}

impl AgentSessions {
    pub fn link_session_kanban_issue(&self, session_id: &str, issue_id: &str) -> Result<()> {
        id(session_id)?;
        text(issue_id, "Identifiant de l’issue", 128)?;
        let store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        let project = require_project(&store, &session.project_id)?;
        let issue_exists: bool = store
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM kanban_issues WHERE id=?1)",
                [issue_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !issue_exists {
            return Err(kanban::ISSUE_NOT_FOUND.into());
        }
        ensure_linkable(
            &store.db,
            "agent_kanban_issue_sessions",
            "issue_id",
            issue_id,
            session_id,
        )?;
        store
            .db
            .execute(
                "INSERT INTO agent_kanban_issue_sessions(issue_id, session_id, session_name, executable, project_name, started_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(issue_id) DO UPDATE SET session_id=excluded.session_id,
                    session_name=excluded.session_name, executable=excluded.executable, project_name=excluded.project_name, started_at=excluded.started_at,
                    ended_at=NULL, end_reason=NULL, merged_into=NULL, summary_comment_id=NULL",
                params![
                    issue_id,
                    session_id,
                    session.display_name(),
                    session.executable,
                    project.name,
                    session.created_at
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// The Linear issue lives on Linear only: its identifier is kept for when it is not loaded.
    pub fn link_session_linear_issue(
        &self,
        session_id: &str,
        issue_id: &str,
        issue_identifier: &str,
    ) -> Result<()> {
        id(session_id)?;
        text(issue_id, "Identifiant de l’issue", 128)?;
        text(issue_identifier, "Référence de l’issue", 128)?;
        let store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        let project = require_project(&store, &session.project_id)?;
        ensure_linkable(
            &store.db,
            "agent_linear_issue_sessions",
            "linear_issue_id",
            issue_id,
            session_id,
        )?;
        store
            .db
            .execute(
                "INSERT INTO agent_linear_issue_sessions(linear_issue_id, linear_issue_identifier, session_id, session_name, executable, project_name, started_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(linear_issue_id) DO UPDATE SET linear_issue_identifier=excluded.linear_issue_identifier, session_id=excluded.session_id,
                    session_name=excluded.session_name, executable=excluded.executable, project_name=excluded.project_name, started_at=excluded.started_at,
                    ended_at=NULL, end_reason=NULL, merged_into=NULL, summary_comment_id=NULL",
                params![
                    issue_id,
                    issue_identifier,
                    session_id,
                    session.display_name(),
                    session.executable,
                    project.name,
                    session.created_at
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    // shortcut: a summary the agent ends its current turn with after an unlink and relink goes to the new issue; tie summaries to the link if users relink mid-turn.
    // shortcut: deleting (or forgetting) the old issue cascades its summary claims away, so after a restart its last summary can reach the relinked issue; keep claims per session if users hit it.
    /// Detaches the session from its live link, local or Linear; the issue, its comments and its
    /// claimed summaries stay, so a summary already posted is never offered to the next issue.
    pub fn unlink_session_issue(&self, session_id: &str) -> Result<()> {
        id(session_id)?;
        let store = lock(&self.store)?;
        let mut removed = 0;
        for table in LINK_TABLES {
            removed += store
                .db
                .execute(
                    &format!("UPDATE {table} SET session_id=NULL, summary_comment_id=NULL WHERE session_id=?1"),
                    [session_id],
                )
                .map_err(|error| error.to_string())?;
        }
        if removed == 0 {
            return Err(NOT_LINKED_MESSAGE.into());
        }
        // A closed session the issue kept returns to the tabs, as when the issue is deleted.
        closed_sessions::reopen_unkept_sessions(&store.db)
    }

    /// The issue's closed session reopens unless it is a favorite.
    pub fn delete_kanban_issue(&self, issue_id: &str) -> Result<Vec<String>> {
        self.kanban(|db, _| {
            let files = kanban::delete_issue(db, issue_id)?;
            closed_sessions::reopen_unkept_sessions(db)?;
            Ok(files)
        })
    }

    /// Linear would lose the hierarchy, so only an issue without parent or sub-issue moves there.
    pub fn check_kanban_issue_transfer(&self, issue_id: &str) -> Result<()> {
        let store = lock(&self.store)?;
        let (has_parent, has_children): (bool, bool) = store
            .db
            .query_row(
                "SELECT parent_id IS NOT NULL, EXISTS(SELECT 1 FROM kanban_issues WHERE parent_id=?1)
                FROM kanban_issues WHERE id=?1",
                [issue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or(kanban::ISSUE_NOT_FOUND)?;
        if has_parent || has_children {
            return Err(kanban::TRANSFER_SUB_ISSUES_MESSAGE.into());
        }
        Ok(())
    }

    pub fn late_kanban_issue_comments(
        &self,
        issue_id: &str,
        known: &[TransferredComment],
    ) -> Result<Vec<TransferredComment>> {
        late_comments(&lock(&self.store)?.db, issue_id, known)
    }

    /// Moves the issue's session link and claimed summaries to the Linear issue created from it,
    /// then deletes it like `delete_kanban_issue`, unless it has a comment outside `known` (those
    /// the Linear issue holds) or a description other than `source_description` (the one copied).
    /// Returns the image files to remove; any error leaves it intact.
    pub fn transfer_kanban_issue_to_linear(
        &self,
        issue_id: &str,
        linear_issue_id: &str,
        linear_issue_identifier: &str,
        known: &[TransferredComment],
        source_description: Option<&str>,
    ) -> Result<Vec<String>> {
        self.kanban(|db, _| {
            if !late_comments(db, issue_id, known)?.is_empty() {
                return Err(TRANSFER_LATE_COMMENT_MESSAGE.into());
            }
            let stored: Option<Option<String>> = db
                .query_row(
                    "SELECT description FROM kanban_issues WHERE id=?1",
                    [issue_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            // shortcut: a state change during the transfer (e.g. a first agent summary moving it to review) is not checked, so the Linear issue keeps the state sent; compare the source state too if it happens.
            if stored.is_some_and(|stored| stored.as_deref() != source_description) {
                return Err(TRANSFER_DESCRIPTION_CHANGED_MESSAGE.into());
            }
            db.execute(
                "INSERT INTO agent_linear_issue_sessions(linear_issue_id, linear_issue_identifier, session_id, session_name, executable, project_name, started_at, ended_at, end_reason, merged_into)
                SELECT ?2, ?3, session_id, session_name, executable, project_name, started_at, ended_at, end_reason, merged_into
                FROM agent_kanban_issue_sessions WHERE issue_id=?1",
                params![issue_id, linear_issue_id, linear_issue_identifier],
            )
            .map_err(|error| error.to_string())?;
            db.execute(
                "INSERT INTO agent_linear_issue_summaries(summary_id, linear_issue_id)
                SELECT summary_id, ?2 FROM agent_kanban_issue_summaries WHERE issue_id=?1
                ON CONFLICT(summary_id) DO NOTHING",
                params![issue_id, linear_issue_id],
            )
            .map_err(|error| error.to_string())?;
            let files = kanban::delete_issue(db, issue_id)?;
            closed_sessions::reopen_unkept_sessions(db)?;
            Ok(files)
        })
        .map_err(|error| transfer_incomplete(linear_issue_identifier, &error))
    }

    /// Forgets a Linear issue deleted on Linear; its closed session reopens unless it is a favorite.
    pub fn forget_linear_issue(&self, issue_id: &str) -> Result<()> {
        self.kanban(|db, _| {
            db.execute(
                "DELETE FROM agent_linear_issue_sessions WHERE linear_issue_id=?1",
                [issue_id],
            )
            .map_err(|error| error.to_string())?;
            closed_sessions::reopen_unkept_sessions(db)
        })
    }

    pub fn session_linear_issue(&self, session_id: &str) -> Result<Option<String>> {
        id(session_id)?;
        linked_linear_issue(&lock(&self.store)?.db, session_id)
    }

    /// Posts the summary only for its first claim, so polls and restarts never post twice; the
    /// session's first summary comment receives the later ones and moves the issue to review.
    pub fn complete_kanban_issue(
        &self,
        session_id: &str,
        summary_id: &str,
        summary: &str,
    ) -> Result<Option<KanbanIssueCompletion>> {
        id(session_id)?;
        text(summary_id, "Identifiant du résumé", 64)?;
        let mut store = lock(&self.store)?;
        let tx = store.db.transaction().map_err(|error| error.to_string())?;
        let (issue_id, comment_id): (String, Option<String>) = tx
            .query_row(
                "SELECT issue_id, summary_comment_id FROM agent_kanban_issue_sessions WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or(NOT_LINKED_MESSAGE)?;
        let claimed = tx
            .execute(
                "INSERT INTO agent_kanban_issue_summaries(summary_id, issue_id) VALUES (?1, ?2)
                ON CONFLICT(summary_id) DO NOTHING",
                params![summary_id, issue_id],
            )
            .map_err(|error| error.to_string())?;
        if claimed == 0 {
            return Ok(None);
        }
        let (comment, created) =
            kanban::post_summary(&tx, &issue_id, comment_id.as_deref(), summary)?;
        let update = if created {
            tx.execute(
                "UPDATE agent_kanban_issue_sessions SET summary_comment_id=?2 WHERE session_id=?1",
                params![session_id, comment.id],
            )
            .map_err(|error| error.to_string())?;
            kanban::move_issue_to_review(&tx, &issue_id)?
        } else {
            None
        };
        tx.commit().map_err(|error| error.to_string())?;
        Ok(Some(KanbanIssueCompletion { comment, update }))
    }

    /// Returns the Linear issue to complete only for the first claim: polls and restarts never post twice.
    pub fn claim_linear_issue_summary(
        &self,
        session_id: &str,
        summary_id: &str,
    ) -> Result<Option<ClaimedIssueSummary>> {
        id(session_id)?;
        text(summary_id, "Identifiant du résumé", 64)?;
        let store = lock(&self.store)?;
        let (issue_id, comment_id): (String, Option<String>) = store
            .db
            .query_row(
                "SELECT linear_issue_id, summary_comment_id FROM agent_linear_issue_sessions WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or(NOT_LINKED_MESSAGE)?;
        let claimed = store
            .db
            .execute(
                "INSERT INTO agent_linear_issue_summaries(summary_id, linear_issue_id) VALUES (?1, ?2)
                ON CONFLICT(summary_id) DO NOTHING",
                params![summary_id, issue_id],
            )
            .map_err(|error| error.to_string())?;
        Ok((claimed == 1).then_some(ClaimedIssueSummary {
            issue_id,
            comment_id,
        }))
    }

    /// Ignored once the session left the issue: a later session starts its own comment.
    pub fn record_linear_issue_summary_comment(
        &self,
        session_id: &str,
        issue_id: &str,
        comment_id: &str,
    ) -> Result<()> {
        id(session_id)?;
        text(comment_id, "Identifiant du commentaire", 128)?;
        let store = lock(&self.store)?;
        store
            .db
            .execute(
                "UPDATE agent_linear_issue_sessions SET summary_comment_id=?3 WHERE session_id=?1 AND linear_issue_id=?2",
                params![session_id, issue_id, comment_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
