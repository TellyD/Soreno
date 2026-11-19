use super::{
    claim_images, comment_row, issue_team, new_id, sql, touch, trimmed, update_description,
    KanbanComment, Result, EMPTY_COMMENT_MESSAGE,
};
use rusqlite::Connection;

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

/// Replaces the session's summary comment while it still exists, else creates one; `true` when created.
pub(crate) fn post_summary(
    db: &Connection,
    issue_id: &str,
    summary_comment_id: Option<&str>,
    summary: &str,
) -> Result<(KanbanComment, bool)> {
    let Some(comment_id) = summary_comment_id else {
        return Ok((create_comment(db, issue_id, summary)?, true));
    };
    let body = trimmed(Some(summary)).ok_or(EMPTY_COMMENT_MESSAGE)?;
    let replaced = db
        .execute(
            "UPDATE kanban_comments SET body=?3 WHERE id=?1 AND issue_id=?2",
            [comment_id, issue_id, body],
        )
        .map_err(sql)?;
    if replaced == 0 {
        return Ok((create_comment(db, issue_id, summary)?, true));
    }
    touch(db, issue_id)?;
    claim_images(db, issue_id, body)?;
    Ok((comment(db, comment_id)?, false))
}
