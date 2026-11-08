use super::*;

fn open_database(db_path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    init_schema(&conn)?;
    Ok(conn)
}

fn test_connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    init_schema(&conn).expect("initialize schema");
    conn
}

#[test]
fn reorder_note_types_persists_the_requested_order() {
    let mut conn = test_connection();

    let reordered_types = note_types::reorder_note_types(
        &mut conn,
        &[
            "projects".to_string(),
            "notes".to_string(),
            "personal".to_string(),
            "work".to_string(),
        ],
    )
    .expect("reorder note types");

    assert_eq!(
        reordered_types
            .iter()
            .map(|note_type| (note_type.id.as_str(), note_type.sort_order))
            .collect::<Vec<_>>(),
        vec![("projects", 0), ("notes", 1), ("personal", 2), ("work", 3)]
    );
    assert_eq!(
        note_types::list_note_types(&conn)
            .expect("list note types")
            .iter()
            .map(|note_type| note_type.id.as_str())
            .collect::<Vec<_>>(),
        vec!["projects", "notes", "personal", "work"]
    );
}

#[test]
fn reorder_note_types_rejects_invalid_orders() {
    let mut conn = test_connection();

    assert!(
        note_types::reorder_note_types(&mut conn, &["notes".to_string(), "work".to_string()],)
            .is_err()
    );
    assert!(note_types::reorder_note_types(
        &mut conn,
        &[
            "notes".to_string(),
            "work".to_string(),
            "personal".to_string(),
            "missing".to_string(),
        ],
    )
    .is_err());
    assert!(note_types::reorder_note_types(
        &mut conn,
        &[
            "notes".to_string(),
            "work".to_string(),
            "work".to_string(),
            "projects".to_string(),
        ],
    )
    .is_err());
    assert_eq!(
        note_types::list_note_types(&conn)
            .expect("list note types")
            .iter()
            .map(|note_type| note_type.id.as_str())
            .collect::<Vec<_>>(),
        vec!["notes", "work", "personal", "projects"]
    );
}

#[test]
fn create_note_persists_default_note_type() {
    let conn = test_connection();
    let note = create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    assert_eq!(note.id, "note-1");
    assert_eq!(note.kind, note_types::DEFAULT_NOTE_TYPE_ID);
    assert_eq!(list_notes(&conn).expect("list notes").len(), 1);
}

#[test]
fn create_note_persists_requested_type() {
    let conn = test_connection();
    let note = create_note(&conn, "note-1", "projects").expect("create note");

    assert_eq!(note.kind, "projects");
}

#[test]
fn create_note_rejects_unknown_type() {
    let conn = test_connection();

    assert!(create_note(&conn, "note-1", "missing").is_err());
}

#[test]
fn update_note_returns_the_updated_note() {
    let conn = test_connection();
    create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    let updated = update_note(&conn, "note-1", "Roadmap", "Ship the v1").expect("update note");

    assert_eq!(updated.title, "Roadmap");
    assert_eq!(updated.content, "Ship the v1");
}

#[test]
fn update_note_kind_persists_the_new_type() {
    let conn = test_connection();
    create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    let updated = update_note_kind(&conn, "note-1", "personal").expect("update kind");

    assert_eq!(updated.kind, "personal");
}

#[test]
fn update_note_archived_persists_the_archive_state() {
    let conn = test_connection();
    create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    let archived = update_note_archived(&conn, "note-1", true).expect("archive note");
    assert!(archived.archived);

    let restored = update_note_archived(&conn, "note-1", false).expect("restore note");
    assert!(!restored.archived);
}

#[test]
fn update_note_pinned_persists_the_pin_state() {
    let conn = test_connection();
    create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    let pinned = update_note_pinned(&conn, "note-1", true).expect("pin note");
    assert!(pinned.pinned);

    let unpinned = update_note_pinned(&conn, "note-1", false).expect("unpin note");
    assert!(!unpinned.pinned);
}

#[test]
fn favorite_persists_without_changing_note_data_or_order() {
    let path = std::env::temp_dir().join(format!(
        "soreno-favorite-{}.sqlite3",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let conn = open_database(&path).unwrap();
    create_note(&conn, "older", "projects").unwrap();
    update_note(&conn, "older", "Roadmap", "Ship the v1").unwrap();
    conn.execute(
        "UPDATE notes SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'older'",
        [],
    )
    .unwrap();
    create_note(&conn, "newer", "notes").unwrap();
    let mut expected = find_note(&conn, "older").unwrap();
    assert!(!expected.favorite);
    drop(conn);

    for favorite in [true, false] {
        let conn = open_database(&path).unwrap();
        expected.favorite = favorite;
        assert_eq!(
            update_note_favorite(&conn, "older", favorite).unwrap(),
            expected
        );
        drop(conn);
        let conn = open_database(&path).unwrap();
        assert_eq!(find_note(&conn, "older").unwrap(), expected);
        let listed = list_notes(&conn).unwrap();
        assert_eq!(listed[0].id, "newer");
        assert_eq!(listed[1], expected);
        assert_eq!(
            serde_json::to_value(&expected).unwrap()["favorite"],
            favorite
        );
        assert!(matches!(
            update_note_favorite(&conn, "missing", favorite),
            Err(rusqlite::Error::QueryReturnedNoRows)
        ));
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn delete_note_removes_the_note() {
    let conn = test_connection();
    create_note(&conn, "note-1", note_types::DEFAULT_NOTE_TYPE_ID).expect("create note");

    delete_note(&conn, "note-1").expect("delete note");

    assert!(list_notes(&conn).expect("list notes").is_empty());
}

#[test]
fn create_update_and_delete_unused_note_type() {
    let conn = test_connection();
    let created = note_types::create_note_type(&conn, "client", " Client ", "folder", "#3366cc")
        .expect("create note type");

    assert_eq!(created.name, "Client");
    assert_eq!(created.sort_order, 4);

    let updated = note_types::update_note_type(&conn, "client", "Client A", "briefcase", "#cc6633")
        .expect("update note type");

    assert_eq!(updated.name, "Client A");
    assert_eq!(updated.icon, "briefcase");
    assert_eq!(updated.color, "#cc6633");

    note_types::delete_note_type(&conn, "client").expect("delete unused type");
    assert!(note_types::list_note_types(&conn)
        .expect("list note types")
        .iter()
        .all(|note_type| note_type.id != "client"));
}

#[test]
fn delete_note_type_rejects_used_type() {
    let conn = test_connection();
    create_note(&conn, "note-1", "projects").expect("create note");

    assert!(note_types::delete_note_type(&conn, "projects").is_err());
}

#[test]
fn init_schema_removes_inbox_without_changing_notes_or_task_links() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL DEFAULT 'notes',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            inbox INTEGER NOT NULL DEFAULT 1,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .unwrap();
    note_types::ensure_note_types_table(&conn).unwrap();
    note_types::seed_default_note_types(&conn).unwrap();
    note_types::create_note_type(&conn, "custom", "Custom", "folder", "#3366cc").unwrap();
    for inbox in 0..=1 {
        for archived in 0..=1 {
            for pinned in 0..=1 {
                let id = format!("note-{inbox}-{archived}-{pinned}");
                conn.execute(
                    "INSERT INTO notes VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        id,
                        if inbox == 0 { "projects" } else { "custom" },
                        format!("Titre {id}"),
                        format!("Contenu préservé\n{id}"),
                        archived,
                        inbox,
                        pinned,
                        "2026-06-28T10:00:00.000Z",
                        format!("2026-06-29T10:00:0{inbox}.000Z"),
                    ],
                )
                .unwrap();
            }
        }
    }
    crate::tasks::init_schema(&conn).unwrap();
    crate::tasks::create_task(&conn, "task", "Linked", "todo").unwrap();
    crate::tasks::update_task_attached_note(&conn, "task", Some("note-1-1-1")).unwrap();
    ensure_favorite_column(&conn).unwrap();
    update_note_favorite(&conn, "note-1-1-1", true).unwrap();
    let before = list_notes(&conn).unwrap();
    let tasks_before = crate::tasks::list_tasks(&conn).unwrap();

    for _ in 0..2 {
        init_schema(&conn).unwrap();
        assert!(!table_column_exists(&conn, "notes", "inbox").unwrap());
        let after = list_notes(&conn).unwrap();
        assert_eq!(after, before);
        assert!(after
            .iter()
            .all(|note| serde_json::to_value(note).unwrap().get("inbox").is_none()));
        assert_eq!(crate::tasks::list_tasks(&conn).unwrap(), tasks_before);
    }
    let created = create_note(&conn, "after-migration", "custom").unwrap();
    assert_eq!(created.kind, "custom");
    assert!(!created.archived);
    assert!(!created.pinned);
    assert_eq!(list_notes(&conn).unwrap().len(), before.len() + 1);
}

#[test]
fn init_schema_migrates_legacy_kind_column_and_check_constraint() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    conn.execute_batch(
        "
        CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'jinka', 'family', 'project')),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes (id, kind, title, content, created_at, updated_at)
        VALUES
            ('note-1', 'note', 'Legacy note', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z'),
            ('note-2', 'jinka', 'Legacy Jinka', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z'),
            ('note-3', 'family', 'Legacy family', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z'),
            ('note-4', 'project', 'Legacy project', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z');
        ",
    )
    .expect("create legacy table");

    init_schema(&conn).expect("migrate schema");
    let notes = list_notes(&conn).expect("list notes");
    assert!(notes.iter().all(|note| !note.favorite));

    assert_eq!(
        notes
            .iter()
            .map(|note| (note.id.as_str(), note.kind.as_str(), note.pinned))
            .collect::<Vec<_>>(),
        vec![
            ("note-1", "notes", false),
            ("note-2", "projects", false),
            ("note-3", "personal", false),
            ("note-4", "projects", false),
        ]
    );
    assert_eq!(
        create_note(&conn, "note-5", "personal")
            .expect("create dynamic type note")
            .kind,
        "personal"
    );
}

#[test]
fn legacy_kind_rebuild_preserves_links_and_foreign_keys() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('notes')),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes VALUES
            ('linked', 'notes', 'Linked note', 'Content', 1, 1, 1, 'created', 'updated');",
    )
    .unwrap();
    crate::tasks::init_schema(&conn).unwrap();
    crate::tasks::create_task(&conn, "task", "Linked task", "todo").unwrap();
    crate::tasks::update_task_attached_note(&conn, "task", Some("linked")).unwrap();

    for _ in 0..2 {
        init_schema(&conn).unwrap();
        let note = find_note(&conn, "linked").unwrap();
        assert!(note.archived);
        assert!(note.pinned);
        assert!(note.favorite);
        assert_eq!(
            crate::tasks::list_tasks(&conn).unwrap()[0].attached_note_id,
            Some("linked".into())
        );
        let target = conn
            .query_row("PRAGMA foreign_key_list(tasks)", [], |row| {
                row.get::<_, String>("table")
            })
            .unwrap();
        assert_eq!(target, "notes");
        assert!(!conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }

    crate::tasks::update_task_attached_note(&conn, "task", None).unwrap();
    assert_eq!(
        crate::tasks::list_tasks(&conn).unwrap()[0].attached_note_id,
        None
    );
    crate::tasks::update_task_attached_note(&conn, "task", Some("linked")).unwrap();
    assert_eq!(
        crate::tasks::list_tasks(&conn).unwrap()[0].attached_note_id,
        Some("linked".into())
    );

    delete_note(&conn, "linked").unwrap();
    assert_eq!(
        crate::tasks::list_tasks(&conn).unwrap()[0].attached_note_id,
        None
    );
}

#[test]
fn legacy_kind_rebuild_preserves_favorite() {
    for favorite in [false, true] {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('notes')),
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0,
                inbox INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, kind, title, content, favorite, created_at, updated_at)
             VALUES ('legacy', 'notes', 'Title', 'Content', ?1, 'created', 'updated')",
            params![favorite],
        )
        .unwrap();
        for _ in 0..2 {
            init_schema(&conn).unwrap();
            let note = find_note(&conn, "legacy").unwrap();
            assert_eq!(note.favorite, favorite);
            assert_eq!(note.title, "Title");
            assert_eq!(note.content, "Content");
            assert_eq!(note.kind, "notes");
            assert_eq!(note.created_at, "created");
            assert_eq!(note.updated_at, "updated");
            assert!(!table_column_exists(&conn, "notes", "inbox").unwrap());
        }
    }
}

#[test]
fn recovers_partial_rebuild_without_overwriting_new_notes() {
    let path = std::env::temp_dir().join(format!(
        "soreno-notes-{}.sqlite3",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let conn = open_database(&path).unwrap();
    create_note(&conn, "shared", "notes").unwrap();
    update_note(&conn, "shared", "old", "old").unwrap();
    create_note(&conn, "legacy-only", "notes").unwrap();
    update_note_archived(&conn, "legacy-only", true).unwrap();
    update_note_pinned(&conn, "legacy-only", true).unwrap();
    update_note_favorite(&conn, "legacy-only", true).unwrap();
    let legacy_note = find_note(&conn, "legacy-only").unwrap();
    conn.execute_batch(
        "ALTER TABLE notes ADD COLUMN inbox INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE notes RENAME TO notes_legacy_kind_check;",
    )
    .unwrap();
    ensure_notes_table(&conn).unwrap();
    create_note(&conn, "shared", "notes").unwrap();
    update_note(&conn, "shared", "new", "new").unwrap();
    conn.execute(
        "ALTER TABLE notes ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .unwrap();
    let shared_note = find_note(&conn, "shared").unwrap();
    drop(conn);
    let conn = open_database(&path).unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(list_notes(&conn).unwrap().len(), 2);
    assert_eq!(find_note(&conn, "shared").unwrap(), shared_note);
    assert_eq!(find_note(&conn, "legacy-only").unwrap(), legacy_note);
    assert!(!table_column_exists(&conn, "notes", "inbox").unwrap());
    drop(conn);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn partial_rebuild_with_rewritten_foreign_keys_requires_manual_recovery() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
        CREATE TABLE notes_legacy_kind_check (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes_legacy_kind_check VALUES
            ('legacy', 'notes', 'Legacy', '', 'created', 'updated');
        CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY NOT NULL,
            attached_note_id TEXT REFERENCES notes_legacy_kind_check(id) ON DELETE SET NULL
        );
        INSERT INTO tasks VALUES ('task', 'legacy');
        PRAGMA foreign_keys = ON;",
    )
    .unwrap();

    let error = init_schema(&conn).unwrap_err().to_string();

    assert!(error.contains("manual recovery"));
    assert_eq!(
        conn.query_row("SELECT attached_note_id FROM tasks", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "legacy"
    );
    assert!(conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, bool>(0))
        .unwrap());
    for table in ["notes", "notes_legacy_kind_check"] {
        assert!(conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
    }
}

#[test]
fn conflicting_legacy_tables_are_preserved_without_rebuilding() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE notes (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('note')), title TEXT, content TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO notes VALUES ('current', 'note', 'Current', '', 'now', 'now');
        CREATE TABLE notes_legacy_kind_check AS SELECT * FROM notes;
        UPDATE notes_legacy_kind_check SET id='previous';").unwrap();
    let error = init_schema(&conn).unwrap_err().to_string();
    assert!(error.contains("manual recovery"));
    assert_eq!(
        conn.query_row("SELECT id FROM notes", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "current"
    );
    assert_eq!(
        conn.query_row("SELECT id FROM notes_legacy_kind_check", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "previous"
    );
}

#[test]
fn failed_rebuild_rolls_back_rename_and_retries() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE notes (
        id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('note')),
        title TEXT, content TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO notes VALUES ('old', 'note', NULL, '', 'now', 'now');",
    )
    .unwrap();
    assert!(init_schema(&conn).is_err());
    assert!(conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, bool>(0))
        .unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='notes_legacy_kind_check')",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    conn.execute("UPDATE notes SET title='repaired'", [])
        .unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(find_note(&conn, "old").unwrap().title, "repaired");
}

#[test]
fn init_schema_adds_kind_to_existing_notes_table() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    conn.execute_batch(
        "
        CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes (id, title, content, created_at, updated_at)
        VALUES ('note-1', 'Legacy', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z');
        ",
    )
    .expect("create legacy table");

    init_schema(&conn).expect("migrate schema");
    let notes = list_notes(&conn).expect("list notes");

    assert_eq!(notes[0].kind, note_types::DEFAULT_NOTE_TYPE_ID);
    assert!(!notes[0].favorite);
    assert!(!notes[0].archived);
    assert!(!notes[0].pinned);
}

#[test]
fn init_schema_adds_archived_to_existing_notes_table() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    conn.execute_batch(
        "
        CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL DEFAULT 'notes',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes (id, kind, title, content, created_at, updated_at)
        VALUES ('note-1', 'notes', 'Legacy', '', '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z');
        ",
    )
    .expect("create legacy table");

    init_schema(&conn).expect("migrate schema");
    let notes = list_notes(&conn).expect("list notes");

    assert!(!notes[0].archived);
    assert!(!notes[0].pinned);
    assert!(
        update_note_archived(&conn, "note-1", true)
            .expect("archive migrated note")
            .archived
    );
}

#[test]
fn init_schema_adds_pinned_to_existing_notes_table() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    conn.execute_batch(
        "
        CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL DEFAULT 'notes',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            inbox INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO notes (id, kind, title, content, archived, inbox, created_at, updated_at)
        VALUES ('note-1', 'notes', 'Legacy', '', 0, 0, '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z');
        ",
    )
    .expect("create legacy table");

    init_schema(&conn).expect("migrate schema");
    let notes = list_notes(&conn).expect("list notes");

    assert!(!notes[0].pinned);
    assert!(
        update_note_pinned(&conn, "note-1", true)
            .expect("pin migrated note")
            .pinned
    );
}
