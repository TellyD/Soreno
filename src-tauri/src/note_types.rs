use crate::sqlite::validation_error;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::collections::HashSet;

pub const DEFAULT_NOTE_TYPE_ID: &str = "notes";
const MAX_NOTE_TYPE_ID_LENGTH: usize = 80;
const MAX_NOTE_TYPE_NAME_LENGTH: usize = 40;
const MAX_NOTE_TYPE_ICON_LENGTH: usize = 48;
const MAX_NOTE_TYPE_COLOR_LENGTH: usize = 24;

struct DefaultNoteType {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    color: &'static str,
    sort_order: i64,
}

const DEFAULT_NOTE_TYPES: [DefaultNoteType; 4] = [
    DefaultNoteType {
        id: DEFAULT_NOTE_TYPE_ID,
        name: "Notes",
        icon: "book-open",
        color: "#608ef8",
        sort_order: 0,
    },
    DefaultNoteType {
        id: "work",
        name: "Travail",
        icon: "briefcase-business",
        color: "#8d6bd8",
        sort_order: 1,
    },
    DefaultNoteType {
        id: "personal",
        name: "Personnel",
        icon: "user-round",
        color: "#5da982",
        sort_order: 2,
    },
    DefaultNoteType {
        id: "projects",
        name: "Projets",
        icon: "sparkles",
        color: "#dc6595",
        sort_order: 3,
    },
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteType {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn ensure_note_types_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS note_types (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            color TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS note_types_name_idx
        ON note_types(name COLLATE NOCASE);
        ",
    )
}

pub fn seed_default_note_types(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM note_types", [], |row| row.get(0))?;

    if count > 0 {
        return Ok(());
    }

    for note_type in DEFAULT_NOTE_TYPES {
        conn.execute(
            "
            INSERT INTO note_types (id, name, icon, color, sort_order, created_at, updated_at)
            VALUES (
                ?1,
                ?2,
                ?3,
                ?4,
                ?5,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ",
            params![
                note_type.id,
                note_type.name,
                note_type.icon,
                note_type.color,
                note_type.sort_order
            ],
        )?;
    }

    Ok(())
}

pub fn list_note_types(conn: &Connection) -> rusqlite::Result<Vec<NoteType>> {
    let mut statement = conn.prepare(
        "
        SELECT id, name, icon, color, sort_order, created_at, updated_at
        FROM note_types
        ORDER BY sort_order ASC, name COLLATE NOCASE ASC
        ",
    )?;
    let rows = statement.query_map([], note_type_from_row)?;

    rows.collect::<Result<Vec<_>, _>>()
}

pub fn create_note_type(
    conn: &Connection,
    id: &str,
    name: &str,
    icon: &str,
    color: &str,
) -> rusqlite::Result<NoteType> {
    validate_note_type_id(id)?;
    let name = normalize_note_type_name(name)?;
    let icon = normalize_note_type_icon(icon)?;
    let color = normalize_note_type_color(color)?;
    ensure_unique_note_type_name(conn, &name, None)?;

    let sort_order = next_note_type_sort_order(conn)?;
    conn.execute(
        "
        INSERT INTO note_types (id, name, icon, color, sort_order, created_at, updated_at)
        VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
        ",
        params![id, name, icon, color, sort_order],
    )?;

    find_note_type(conn, id)
}

pub fn update_note_type(
    conn: &Connection,
    id: &str,
    name: &str,
    icon: &str,
    color: &str,
) -> rusqlite::Result<NoteType> {
    validate_note_type_id(id)?;
    let name = normalize_note_type_name(name)?;
    let icon = normalize_note_type_icon(icon)?;
    let color = normalize_note_type_color(color)?;
    ensure_unique_note_type_name(conn, &name, Some(id))?;

    let changed_rows = conn.execute(
        "
        UPDATE note_types
        SET name = ?2,
            icon = ?3,
            color = ?4,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        ",
        params![id, name, icon, color],
    )?;

    if changed_rows == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    find_note_type(conn, id)
}

pub fn reorder_note_types(
    conn: &mut Connection,
    ids: &[String],
) -> rusqlite::Result<Vec<NoteType>> {
    let current_note_types = list_note_types(conn)?;

    if ids.len() != current_note_types.len() {
        return Err(validation_error(
            "Note type order must include every note type",
        ));
    }

    let existing_ids = current_note_types
        .iter()
        .map(|note_type| note_type.id.as_str())
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();

    for id in ids {
        validate_note_type_id(id)?;

        if !existing_ids.contains(id.as_str()) {
            return Err(validation_error("Note type does not exist"));
        }

        if !seen_ids.insert(id.as_str()) {
            return Err(validation_error("Duplicate note type id"));
        }
    }

    let transaction = conn.transaction()?;

    for (sort_order, id) in ids.iter().enumerate() {
        transaction.execute(
            "
            UPDATE note_types
            SET sort_order = ?2
            WHERE id = ?1
            ",
            params![id, sort_order as i64],
        )?;
    }

    transaction.commit()?;

    list_note_types(conn)
}

pub fn delete_note_type(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    validate_note_type_id(id)?;
    ensure_note_type_exists(conn, id)?;

    let type_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM note_types", [], |row| row.get(0))?;
    if type_count <= 1 {
        return Err(validation_error("At least one note type is required"));
    }

    let note_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE kind = ?1",
        params![id],
        |row| row.get(0),
    )?;
    if note_count > 0 {
        return Err(validation_error("Note type is still used"));
    }

    conn.execute("DELETE FROM note_types WHERE id = ?1", params![id])?;

    Ok(())
}

pub fn ensure_note_type_exists(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    validate_note_type_id(id)?;

    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM note_types WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;

    if exists.is_none() {
        return Err(validation_error("Note type does not exist"));
    }

    Ok(())
}

fn find_note_type(conn: &Connection, id: &str) -> rusqlite::Result<NoteType> {
    let mut statement = conn.prepare(
        "
        SELECT id, name, icon, color, sort_order, created_at, updated_at
        FROM note_types
        WHERE id = ?1
        ",
    )?;

    statement.query_row(params![id], note_type_from_row)
}

fn note_type_from_row(row: &Row<'_>) -> rusqlite::Result<NoteType> {
    Ok(NoteType {
        id: row.get("id")?,
        name: row.get("name")?,
        icon: row.get("icon")?,
        color: row.get("color")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn ensure_unique_note_type_name(
    conn: &Connection,
    name: &str,
    ignored_id: Option<&str>,
) -> rusqlite::Result<()> {
    let duplicate_id: Option<String> = conn
        .query_row(
            "
            SELECT id
            FROM note_types
            WHERE name = ?1 COLLATE NOCASE
            ",
            params![name],
            |row| row.get(0),
        )
        .optional()?;

    if duplicate_id
        .as_deref()
        .is_some_and(|id| Some(id) != ignored_id)
    {
        return Err(validation_error("Note type name already exists"));
    }

    Ok(())
}

fn next_note_type_sort_order(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_types",
        [],
        |row| row.get(0),
    )
}

fn normalize_note_type_name(name: &str) -> rusqlite::Result<String> {
    let trimmed = name.trim();

    if trimmed.is_empty() {
        return Err(validation_error("Note type name is required"));
    }

    if trimmed.chars().count() > MAX_NOTE_TYPE_NAME_LENGTH {
        return Err(validation_error("Note type name is too long"));
    }

    Ok(trimmed.to_string())
}

fn normalize_note_type_icon(icon: &str) -> rusqlite::Result<String> {
    let trimmed = icon.trim();

    if trimmed.is_empty() || trimmed.chars().count() > MAX_NOTE_TYPE_ICON_LENGTH {
        return Err(validation_error("Invalid note type icon"));
    }

    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-'))
    {
        return Err(validation_error("Invalid note type icon"));
    }

    Ok(trimmed.to_string())
}

fn normalize_note_type_color(color: &str) -> rusqlite::Result<String> {
    let trimmed = color.trim();

    if trimmed.is_empty() || trimmed.chars().count() > MAX_NOTE_TYPE_COLOR_LENGTH {
        return Err(validation_error("Invalid note type color"));
    }

    if !trimmed.starts_with('#')
        || trimmed.len() != 7
        || !trimmed
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(validation_error("Invalid note type color"));
    }

    Ok(trimmed.to_ascii_lowercase())
}

fn validate_note_type_id(id: &str) -> rusqlite::Result<()> {
    if id.is_empty()
        || id.chars().count() > MAX_NOTE_TYPE_ID_LENGTH
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(validation_error("Invalid note type id"));
    }

    Ok(())
}
