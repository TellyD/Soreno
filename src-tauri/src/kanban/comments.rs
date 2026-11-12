use super::{
    claim_images, comment_row, issue_team, new_id, sql, touch, trimmed, update_description,
    KanbanComment, Result, EMPTY_COMMENT_MESSAGE,
};
use rusqlite::{Connection, OptionalExtension};

pub(crate) fn create_comment(db: &Connection, issue_id: &str, body: &str) -> Result<KanbanComment> {
    let body = trimmed(Some(body)).ok_or(EMPTY_COMMENT_MESSAGE)?;
    issue_team(db, issue_id)?;
    let comment_id = new_id(db)?;
    db.execute(
        "INSERT INTO kanban_comments(id, issue_id, body, created_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [&comment_id, issue_id, body],
    )
    .map_err(sql)?;
    touch(db, issue_id)?;
    claim_images(db, issue_id, body)?;
    comment(db, &comment_id)
}

/// Deleting a comment already gone succeeds: the user wanted it removed.
pub(crate) fn delete_comment(db: &Connection, issue_id: &str, comment_id: &str) -> Result<()> {
    issue_team(db, issue_id)?;
    let deleted = db
        .execute(
            "DELETE FROM kanban_comments WHERE id=?1 AND issue_id=?2",
            [comment_id, issue_id],
        )
        .map_err(sql)?;
    if deleted > 0 {
        touch(db, issue_id)?;
    }
    Ok(())
}

fn comment(db: &Connection, comment_id: &str) -> Result<KanbanComment> {
    db.query_row(
        "SELECT id, body, created_at FROM kanban_comments WHERE id=?1",
        [comment_id],
        comment_row,
    )
    .map_err(sql)
}

/// Replaces the description on an agent's behalf; `comment` says what changed.
pub(crate) fn replace_description(
    db: &Connection,
    issue_id: &str,
    description: &str,
    comment: &str,
) -> Result<()> {
    issue_team(db, issue_id)?;
    let previous: Option<String> = db
        .query_row(
            "SELECT description FROM kanban_issues WHERE id=?1",
            [issue_id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if update_description(db, issue_id, description)?.description != previous {
        create_comment(db, issue_id, comment)?;
    }
    Ok(())
}

/// The signed summary closes the comment, so the previous trailing signature is dropped.
pub(crate) fn appended_summary(existing: &str, summary: &str) -> String {
    let existing = existing.trim_end();
    let unsigned = existing
        .rsplit_once('\n')
        .filter(|(_, last)| last.trim_start().starts_with("— ") && last.ends_with(" via Soreno"))
        .map_or(existing, |(head, _)| head.trim_end());
    format!("{unsigned}\n\n---\n\n{}", summary.trim())
}

/// Extends the session's summary comment while it still exists, else creates one; `true` when created.
pub(crate) fn post_summary(
    db: &Connection,
    issue_id: &str,
    summary_comment_id: Option<&str>,
    summary: &str,
) -> Result<(KanbanComment, bool)> {
    let existing: Option<String> = match summary_comment_id {
        Some(comment_id) => db
            .query_row(
                "SELECT body FROM kanban_comments WHERE id=?1 AND issue_id=?2",
                [comment_id, issue_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?,
        None => None,
    };
    match (summary_comment_id, existing) {
        (Some(comment_id), Some(body)) => {
            if trimmed(Some(summary)).is_none() {
                return Err(EMPTY_COMMENT_MESSAGE.into());
            }
            db.execute(
                "UPDATE kanban_comments SET body=?2 WHERE id=?1",
                [comment_id, &appended_summary(&body, summary)],
            )
            .map_err(sql)?;
            touch(db, issue_id)?;
            claim_images(db, issue_id, summary)?;
            Ok((comment(db, comment_id)?, false))
        }
        _ => Ok((create_comment(db, issue_id, summary)?, true)),
    }
}
