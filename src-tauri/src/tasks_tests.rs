use super::*;

fn test_connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL)", [])
        .unwrap();
    init_schema(&conn).unwrap();
    conn
}

fn assert_no_label_storage(conn: &Connection) {
    for column in ["label_id", "label", "label_color"] {
        assert!(!table_column_exists(conn, "tasks", column).unwrap());
    }
    let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema
                 WHERE name = 'task_labels' OR tbl_name = 'task_labels' OR name = 'tasks_label_id_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(count, 0);
    let foreign_keys: Vec<(String, String, String)> = conn
        .prepare("SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('tasks')")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        foreign_keys,
        vec![("notes".into(), "attached_note_id".into(), "SET NULL".into())]
    );
    assert!(!conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}

fn seed_current_schema(conn: &Connection) {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
             CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);
             INSERT INTO notes VALUES ('note-1');
             CREATE TABLE task_labels (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
                 name_key TEXT NOT NULL, color TEXT NOT NULL);
             CREATE UNIQUE INDEX task_labels_name_key_idx ON task_labels(name_key);
             INSERT INTO task_labels VALUES ('label-1', 'Work', 'work', '#608ef8');
             CREATE TABLE tasks (
                 id TEXT PRIMARY KEY NOT NULL,
                 attached_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
                 label_id TEXT REFERENCES task_labels(id) ON DELETE SET NULL,
                 title TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
                 priority INTEGER NOT NULL DEFAULT 4 CHECK (priority IN (1, 2, 3, 4)),
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE INDEX tasks_label_id_idx ON tasks(label_id);
             CREATE INDEX tasks_status_idx ON tasks(status);
             CREATE INDEX tasks_title_custom_idx ON tasks(title DESC);
             INSERT INTO tasks VALUES ('task-1', 'note-1', 'label-1', ' One ', 'doing', 2,
                 '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z');
             INSERT INTO tasks VALUES ('task-2', NULL, NULL, 'Two', 'done', 1,
                 '2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z');",
    )
    .unwrap();
}

#[test]
fn removes_current_and_hybrid_labels_preserving_tasks_and_indexes() {
    for hybrid in [false, true] {
        let conn = Connection::open_in_memory().unwrap();
        seed_current_schema(&conn);
        if hybrid {
            conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN label TEXT;
                     ALTER TABLE tasks ADD COLUMN label_color TEXT;
                     UPDATE tasks SET label = 'Legacy', label_color = '#8d6bd8';",
            )
            .unwrap();
        }
        let before = list_tasks(&conn).unwrap();
        let indexes_before: Vec<(String, String)> = conn
                .prepare("SELECT name, sql FROM sqlite_schema WHERE name IN ('tasks_status_idx', 'tasks_title_custom_idx') ORDER BY name")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
        for _ in 0..2 {
            init_schema(&conn).unwrap();
            assert_eq!(list_tasks(&conn).unwrap(), before);
            assert_no_label_storage(&conn);
            for (name, sql) in &indexes_before {
                assert_eq!(
                    conn.query_row(
                        "SELECT sql FROM sqlite_schema WHERE name = ?1",
                        [name],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                    *sql
                );
            }
        }
        conn.execute("DELETE FROM notes WHERE id = 'note-1'", [])
            .unwrap();
        assert!(find_task(&conn, "task-1")
            .unwrap()
            .attached_note_id
            .is_none());
    }
}

#[test]
fn removes_legacy_labels_and_adds_missing_task_columns() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);
             INSERT INTO notes VALUES ('note-1');
             CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, label TEXT, label_color TEXT,
                 title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO tasks VALUES ('task-1', 'Work', '#608ef8', ' One ', 'doing', 'created', 'updated');
             INSERT INTO tasks VALUES ('task-2', NULL, NULL, 'Two', 'done', 'older', 'old');",
        )
        .unwrap();
    for _ in 0..2 {
        init_schema(&conn).unwrap();
        assert_no_label_storage(&conn);
        assert_eq!(
            list_tasks(&conn).unwrap(),
            vec![
                Task {
                    id: "task-1".into(),
                    attached_note_id: None,
                    priority: 4,
                    title: " One ".into(),
                    status: "doing".into(),
                    created_at: "created".into(),
                    updated_at: "updated".into()
                },
                Task {
                    id: "task-2".into(),
                    attached_note_id: None,
                    priority: 4,
                    title: "Two".into(),
                    status: "done".into(),
                    created_at: "older".into(),
                    updated_at: "old".into()
                },
            ]
        );
    }
    update_task_attached_note(&conn, "task-1", Some("note-1")).unwrap();
    conn.execute("DELETE FROM notes WHERE id = 'note-1'", [])
        .unwrap();
    assert!(find_task(&conn, "task-1")
        .unwrap()
        .attached_note_id
        .is_none());
    assert_eq!(
        update_task_priority(&conn, "task-1", 1).unwrap().priority,
        1
    );
    create_task(&conn, "task-3", " New ", "todo").unwrap();
    delete_task(&conn, "task-3").unwrap();
    assert_eq!(list_tasks(&conn).unwrap().len(), 2);
}

#[test]
fn migration_persists_after_reopening() {
    let path = std::env::temp_dir().join(format!(
        "soreno-remove-task-labels-{}-{}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let conn = Connection::open(&path).unwrap();
    seed_current_schema(&conn);
    let before = list_tasks(&conn).unwrap();
    init_schema(&conn).unwrap();
    drop(conn);
    let conn = Connection::open(&path).unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(list_tasks(&conn).unwrap(), before);
    assert_no_label_storage(&conn);
    drop(conn);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn label_removal_rolls_back_all_drops_on_failure() {
    let conn = Connection::open_in_memory().unwrap();
    seed_current_schema(&conn);
    conn.execute_batch(
        "ALTER TABLE tasks ADD COLUMN label TEXT;
             ALTER TABLE tasks ADD COLUMN label_color TEXT;
             UPDATE tasks SET label = 'Legacy', label_color = '#8d6bd8';
             CREATE INDEX blocking_label_color_idx ON tasks(label_color);",
    )
    .unwrap();
    let before = list_tasks(&conn).unwrap();
    assert!(init_schema(&conn).is_err());
    assert_eq!(list_tasks(&conn).unwrap(), before);
    assert_eq!(
        conn.query_row(
            "SELECT label_id, label, label_color FROM tasks WHERE id = 'task-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }
        )
        .unwrap(),
        ("label-1".into(), "Legacy".into(), "#8d6bd8".into())
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM task_labels", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name = 'tasks_label_id_idx'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    conn.execute("DROP INDEX blocking_label_color_idx", [])
        .unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(list_tasks(&conn).unwrap(), before);
    assert_no_label_storage(&conn);
}

#[test]
fn keeps_existing_task_behaviors() {
    let conn = test_connection();
    assert_no_label_storage(&conn);
    conn.execute("INSERT INTO notes (id) VALUES ('note-1')", [])
        .unwrap();
    let task = create_task(&conn, "task-1", "   ", DEFAULT_TASK_STATUS).unwrap();
    assert_eq!(task.title, DEFAULT_TASK_TITLE);
    assert_eq!(task.priority, DEFAULT_TASK_PRIORITY);
    assert_eq!(task.created_at, task.updated_at);
    assert!(task.attached_note_id.is_none());
    assert!(create_task(&conn, "task-1", "Duplicate", "todo").is_err());
    assert!(create_task(&conn, "bad", "Task", "blocked").is_err());
    let long_title = "é".repeat(MAX_TASK_TITLE_LENGTH + 1);
    assert!(create_task(&conn, "bad", &long_title, "todo").is_err());
    assert!(update_task_title(&conn, "task-1", &long_title).is_err());
    assert_eq!(
        update_task_title(&conn, "task-1", " Updated ")
            .unwrap()
            .title,
        "Updated"
    );
    assert!(update_task_priority(&conn, "task-1", 0).is_err());
    assert!(update_task_priority(&conn, "task-1", 5).is_err());
    assert_eq!(
        update_task_priority(&conn, "task-1", 2).unwrap().priority,
        2
    );
    assert_eq!(
        update_task_attached_note(&conn, "task-1", Some(" note-1 "))
            .unwrap()
            .attached_note_id
            .as_deref(),
        Some("note-1")
    );
    assert!(update_task_attached_note(&conn, "task-1", Some("missing")).is_err());
    for note_id in [None, Some("   ")] {
        assert!(update_task_attached_note(&conn, "task-1", note_id)
            .unwrap()
            .attached_note_id
            .is_none());
    }
    update_task_attached_note(&conn, "task-1", Some("note-1")).unwrap();
    conn.execute("DELETE FROM notes WHERE id = 'note-1'", [])
        .unwrap();
    assert!(find_task(&conn, "task-1")
        .unwrap()
        .attached_note_id
        .is_none());
    assert_eq!(
        update_task_status(&conn, "task-1", "done").unwrap().status,
        "done"
    );
    assert!(update_task_status(&conn, "task-1", "blocked").is_err());
    assert!(matches!(
        update_task_title(&conn, "missing", "Title"),
        Err(rusqlite::Error::QueryReturnedNoRows)
    ));
    let before = list_tasks(&conn).unwrap();
    init_schema(&conn).unwrap();
    assert_eq!(list_tasks(&conn).unwrap(), before);
    assert_no_label_storage(&conn);
    delete_task(&conn, "task-1").unwrap();
    assert!(list_tasks(&conn).unwrap().is_empty());
}
