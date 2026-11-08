use crate::{note_types, sqlite::table_column_exists};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub archived: bool,
    pub favorite: bool,
    pub id: String,
    pub kind: String,
    pub pinned: bool,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

enum NoteBooleanField {
    Archived,
    Pinned,
}

impl NoteBooleanField {
    fn update_statement(&self) -> &'static str {
        match self {
            Self::Archived => {
                "
                UPDATE notes
                SET archived = ?2,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "
            }
            Self::Pinned => {
                "
                UPDATE notes
                SET pinned = ?2,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "
            }
        }
    }
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    note_types::ensure_note_types_table(conn)?;
    note_types::seed_default_note_types(conn)?;
    ensure_notes_table(conn)?;
    ensure_kind_column(conn)?;
    remove_legacy_kind_check(conn)?;
    ensure_archived_column(conn)?;
    remove_inbox_column(conn)?;
    ensure_pinned_column(conn)?;
    ensure_favorite_column(conn)?;
    migrate_legacy_note_kinds(conn)?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes(updated_at DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS notes_kind_idx ON notes(kind)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS notes_archived_idx ON notes(archived)",
        [],
    )?;
    Ok(())
}

pub fn list_notes(conn: &Connection) -> rusqlite::Result<Vec<Note>> {
    let mut statement = conn.prepare(
        "
        SELECT id, kind, title, content, archived, pinned, favorite, created_at, updated_at
        FROM notes
        ORDER BY updated_at DESC
        ",
    )?;
    let rows = statement.query_map([], note_from_row)?;

    rows.collect()
}

pub fn create_note(conn: &Connection, id: &str, kind: &str) -> rusqlite::Result<Note> {
    note_types::ensure_note_type_exists(conn, kind)?;

    conn.execute(
        "
        INSERT INTO notes (id, kind, title, content, pinned, created_at, updated_at)
        VALUES (
            ?1,
            ?2,
            'Sans titre',
            '',
            0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
        ",
        params![id, kind],
    )?;

    find_note(conn, id)
}

pub fn update_note(
    conn: &Connection,
    id: &str,
    title: &str,
    content: &str,
) -> rusqlite::Result<Note> {
    let changed_rows = conn.execute(
        "
        UPDATE notes
        SET title = ?2,
            content = ?3,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        ",
        params![id, title, content],
    )?;

    if changed_rows == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    find_note(conn, id)
}

pub fn update_note_kind(conn: &Connection, id: &str, kind: &str) -> rusqlite::Result<Note> {
    note_types::ensure_note_type_exists(conn, kind)?;

    let changed_rows = conn.execute(
        "
        UPDATE notes
        SET kind = ?2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        ",
        params![id, kind],
    )?;

    if changed_rows == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    find_note(conn, id)
}

pub fn update_note_archived(conn: &Connection, id: &str, archived: bool) -> rusqlite::Result<Note> {
    update_note_boolean_field(conn, id, NoteBooleanField::Archived, archived)
}

pub fn update_note_pinned(conn: &Connection, id: &str, pinned: bool) -> rusqlite::Result<Note> {
    update_note_boolean_field(conn, id, NoteBooleanField::Pinned, pinned)
}

pub fn update_note_favorite(conn: &Connection, id: &str, favorite: bool) -> rusqlite::Result<Note> {
    let changed_rows = conn.execute(
        "UPDATE notes SET favorite = ?2 WHERE id = ?1",
        params![id, favorite],
    )?;

    if changed_rows == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    find_note(conn, id)
}

fn update_note_boolean_field(
    conn: &Connection,
    id: &str,
    field: NoteBooleanField,
    value: bool,
) -> rusqlite::Result<Note> {
    let field_value = if value { 1 } else { 0 };
    let changed_rows = conn.execute(field.update_statement(), params![id, field_value])?;

    if changed_rows == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    find_note(conn, id)
}

pub fn delete_note(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

fn ensure_notes_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL DEFAULT 'notes',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        ",
    )
}

fn ensure_kind_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "notes", "kind")? {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'notes'",
            [],
        )?;
    }

    Ok(())
}

fn ensure_archived_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "notes", "archived")? {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    Ok(())
}

fn remove_inbox_column(conn: &Connection) -> rusqlite::Result<()> {
    if table_column_exists(conn, "notes", "inbox")? {
        conn.execute("ALTER TABLE notes DROP COLUMN inbox", [])?;
    }

    Ok(())
}

fn ensure_pinned_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "notes", "pinned")? {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    Ok(())
}

fn ensure_favorite_column(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "notes", "favorite")? {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    Ok(())
}

fn remove_legacy_kind_check(conn: &Connection) -> rusqlite::Result<()> {
    let table_sql = conn
        .query_row(
            "
            SELECT sql
            FROM sqlite_master
            WHERE type = 'table' AND name = 'notes'
            ",
            [],
            |row| row.get::<_, String>("sql"),
        )
        .optional()?;

    let has_legacy_check = table_sql
        .as_deref()
        .map(|sql| sql.contains("CHECK (kind IN"))
        .unwrap_or(false);
    let has_partial_rebuild: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_legacy_kind_check')",
        [],
        |row| row.get(0),
    )?;

    if has_legacy_check && has_partial_rebuild {
        return Err(rusqlite::Error::InvalidParameterName(
            "Both legacy notes tables exist; manual recovery is required before rebuilding".into(),
        ));
    }
    if !has_legacy_check && !has_partial_rebuild {
        return Ok(());
    }
    if has_partial_rebuild && foreign_keys_reference_legacy_notes(conn)? {
        return Err(rusqlite::Error::InvalidParameterName(
            "Legacy notes recovery has foreign keys targeting notes_legacy_kind_check; manual recovery is required".into(),
        ));
    }

    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let rebuild_result = (|| {
        let transaction = conn.unchecked_transaction()?;
        let source_table = if has_legacy_check {
            transaction.execute_batch(
                "
                CREATE TABLE notes_without_legacy_kind_check (
                    id TEXT PRIMARY KEY NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'notes',
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                ",
            )?;
            "notes"
        } else {
            ensure_archived_column(&transaction)?;
            ensure_pinned_column(&transaction)?;
            ensure_favorite_column(&transaction)?;
            "notes_legacy_kind_check"
        };
        let columns = {
            let mut statement =
                transaction.prepare(&format!("PRAGMA table_info({source_table})"))?;
            let rows = statement.query_map([], |row| row.get::<_, String>("name"))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let flags = ["archived", "pinned", "favorite"]
            .map(|name| {
                if columns.iter().any(|column| column == name) {
                    name
                } else {
                    "0"
                }
            })
            .join(", ");
        let destination_table = if has_legacy_check {
            "notes_without_legacy_kind_check"
        } else {
            "notes"
        };
        transaction.execute_batch(&format!(
            "INSERT INTO {destination_table} (id, kind, title, content, archived, pinned, favorite, created_at, updated_at)
             SELECT id, kind, title, content, {flags}, created_at, updated_at
             FROM {source_table} WHERE true
             ON CONFLICT(id) DO NOTHING;"
        ))?;
        if has_legacy_check {
            transaction.execute_batch(
                "
                DROP TABLE notes;
                ALTER TABLE notes_without_legacy_kind_check RENAME TO notes;
                ",
            )?;
        } else {
            transaction.execute("DROP TABLE notes_legacy_kind_check", [])?;
        }
        let has_foreign_key_errors = {
            let mut statement = transaction.prepare("PRAGMA foreign_key_check")?;
            statement.exists([])?
        };
        if has_foreign_key_errors {
            return Err(rusqlite::Error::InvalidParameterName(
                "Notes rebuild failed foreign key validation".into(),
            ));
        }
        transaction.commit()
    })();
    let enable_result = conn.execute_batch("PRAGMA foreign_keys = ON;");

    match rebuild_result {
        Err(error) => {
            enable_result?;
            Err(error)
        }
        Ok(()) => enable_result,
    }
}

fn foreign_keys_reference_legacy_notes(conn: &Connection) -> rusqlite::Result<bool> {
    let mut statement = conn.prepare("PRAGMA foreign_key_list(tasks)")?;
    let targets = statement.query_map([], |row| row.get::<_, String>("table"))?;
    for target in targets {
        if target? == "notes_legacy_kind_check" {
            return Ok(true);
        }
    }

    Ok(false)
}

fn migrate_legacy_note_kinds(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET kind = 'notes' WHERE kind = 'note'", [])?;
    conn.execute(
        "UPDATE notes SET kind = 'projects' WHERE kind IN ('jinka', 'project')",
        [],
    )?;
    conn.execute(
        "UPDATE notes SET kind = 'personal' WHERE kind = 'family'",
        [],
    )?;
    conn.execute(
        "
        UPDATE notes
        SET kind = 'notes'
        WHERE kind NOT IN (SELECT id FROM note_types)
        ",
        [],
    )?;

    Ok(())
}

fn find_note(conn: &Connection, id: &str) -> rusqlite::Result<Note> {
    let mut statement = conn.prepare(
        "
        SELECT id, kind, title, content, archived, pinned, favorite, created_at, updated_at
        FROM notes
        WHERE id = ?1
        ",
    )?;

    statement.query_row(params![id], note_from_row)
}

fn note_from_row(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        archived: row.get("archived")?,
        favorite: row.get("favorite")?,
        id: row.get("id")?,
        kind: row.get("kind")?,
        pinned: row.get("pinned")?,
        title: row.get("title")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
#[path = "notes_tests.rs"]
mod tests;
