use super::*;

#[test]
fn open_database_drops_retired_assistant_tables_and_keeps_notes() {
    let path = std::env::temp_dir().join(format!(
        "soreno-retired-assistant-{}.sqlite3",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "PRAGMA foreign_keys = ON;
            CREATE TABLE notes (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('notes')),
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE assistant_conversations (
                id TEXT PRIMARY KEY NOT NULL,
                note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
                title TEXT NOT NULL
            );
            CREATE TABLE assistant_messages (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
                content TEXT NOT NULL
            );
            INSERT INTO notes VALUES ('kept', 'notes', 'Kept note', 'Content', 'created', 'updated');
            INSERT INTO assistant_conversations VALUES ('conversation', 'kept', 'Conversation');
            INSERT INTO assistant_messages VALUES ('message', 'conversation', 'Hello');",
        )
        .unwrap();
    drop(legacy);

    let db = open_database(&path).unwrap();

    let retired_tables: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('assistant_conversations', 'assistant_messages')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retired_tables, 0);
    let notes = notes::list_notes(&db).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].id, "kept");
    assert_eq!(notes[0].content, "Content");
    drop(db);
    let _ = std::fs::remove_file(&path);
}
