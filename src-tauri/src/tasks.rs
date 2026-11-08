use crate::sqlite::{table_column_exists, validation_error};

use rusqlite::{params, Connection, Row};
use serde::Serialize;

pub const DEFAULT_TASK_STATUS: &str = "todo";

const DEFAULT_TASK_PRIORITY: i64 = 4;
const DEFAULT_TASK_TITLE: &str = "Sans titre";
const MAX_TASK_TITLE_LENGTH: usize = 200;
const TASK_PRIORITIES: [i64; 4] = [1, 2, 3, DEFAULT_TASK_PRIORITY];
const TASK_STATUSES: [&str; 3] = [DEFAULT_TASK_STATUS, "doing", "done"];

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub attached_note_id: Option<String>,
    pub priority: i64,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY NOT NULL,
            attached_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
            priority INTEGER NOT NULL DEFAULT 4 CHECK (priority IN (1, 2, 3, 4)),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        ",
    )?;

    ensure_priority_column(conn)?;
    ensure_attached_note_id_column(conn)?;
    let transaction = conn.unchecked_transaction()?;
    transaction.execute("DROP INDEX IF EXISTS tasks_label_id_idx", [])?;
    for column in ["label_id", "label", "label_color"] {
        if table_column_exists(&transaction, "tasks", column)? {
            transaction.execute(&format!("ALTER TABLE tasks DROP COLUMN {column}"), [])?;
        }
    }
    transaction.execute("DROP TABLE IF EXISTS task_labels", [])?;
    transaction.commit()?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at DESC);
        CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
        CREATE INDEX IF NOT EXISTS tasks_attached_note_id_idx ON tasks(attached_note_id);
        ",
    )?;

    Ok(())
}

pub fn list_tasks(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let mut statement = conn.prepare(
        "
        SELECT id, attached_note_id, priority, title, status, created_at, updated_at
        FROM tasks
        ORDER BY priority ASC, updated_at DESC, title ASC
        ",
    )?;
    let rows = statement.query_map([], task_from_row)?;
    rows.collect::<Result<Vec<_>, _>>()
}

pub fn create_task(
    conn: &Connection,
    id: &str,
    title: &str,
    status: &str,
) -> rusqlite::Result<Task> {
    validate_task_status(status)?;
    let normalized_title = normalize_task_title(title)?;
    conn.execute(
        "INSERT INTO tasks (id, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![id, normalized_title, status],
    )?;
    find_task(conn, id)
}

pub fn update_task_title(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<Task> {
    let normalized_title = normalize_task_title(title)?;
    update_task_field(
        conn,
        "UPDATE tasks SET title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, normalized_title],
        id,
    )
}

pub fn update_task_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<Task> {
    validate_task_status(status)?;
    update_task_field(
        conn,
        "UPDATE tasks SET status = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, status],
        id,
    )
}

pub fn update_task_priority(conn: &Connection, id: &str, priority: i64) -> rusqlite::Result<Task> {
    validate_task_priority(priority)?;
    update_task_field(
        conn,
        "UPDATE tasks SET priority = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, priority],
        id,
    )
}

pub fn update_task_attached_note(
    conn: &Connection,
    id: &str,
    note_id: Option<&str>,
) -> rusqlite::Result<Task> {
    let note_id = note_id.map(str::trim).filter(|value| !value.is_empty());
    update_task_field(
        conn,
        "UPDATE tasks SET attached_note_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![id, note_id],
        id,
    )
}

pub fn delete_task(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    Ok(())
}

fn update_task_field<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
    id: &str,
) -> rusqlite::Result<Task> {
    if conn.execute(sql, params)? == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    find_task(conn, id)
}

fn find_task(conn: &Connection, id: &str) -> rusqlite::Result<Task> {
    conn.query_row(
        "SELECT id, attached_note_id, priority, title, status, created_at, updated_at
         FROM tasks WHERE id = ?1",
        params![id],
        task_from_row,
    )
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        attached_note_id: row.get("attached_note_id")?,
        priority: row.get("priority")?,
        title: row.get("title")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn normalize_task_title(title: &str) -> rusqlite::Result<String> {
    let trimmed = title.trim();
    let normalized = if trimmed.is_empty() {
        DEFAULT_TASK_TITLE
    } else {
        trimmed
    };
    if normalized.chars().count() > MAX_TASK_TITLE_LENGTH {
        return Err(validation_error("Task title is too long"));
    }
    Ok(normalized.to_string())
}

fn validate_task_status(status: &str) -> rusqlite::Result<()> {
    if TASK_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(validation_error("Invalid task status"))
    }
}

fn validate_task_priority(priority: i64) -> rusqlite::Result<()> {
    if TASK_PRIORITIES.contains(&priority) {
        Ok(())
    } else {
        Err(validation_error("Invalid task priority"))
    }
}

fn ensure_priority_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "tasks", "priority")? {
        conn.execute("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 4 CHECK (priority IN (1, 2, 3, 4))", [])?;
    }
    Ok(())
}

fn ensure_attached_note_id_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "tasks", "attached_note_id")? {
        conn.execute("ALTER TABLE tasks ADD COLUMN attached_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL", [])?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "tasks_tests.rs"]
mod tests;
