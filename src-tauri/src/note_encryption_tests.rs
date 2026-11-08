use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("soreno-note-encryption-test-{id}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    TempDir(dir)
}

fn vault_db(dir: &Path, name: &str, key: Option<&str>) -> PathBuf {
    let path = dir.join(format!("{name}.db"));
    let db = Connection::open(&path).expect("open db");
    if let Some(key) = key {
        init_schema(&db).expect("schema");
        store_wrapped_key(&db, key).expect("store");
    }
    path
}

fn stored_key(path: &Path) -> Option<String> {
    read_wrapped_key(&Connection::open(path).expect("open db")).expect("read")
}

#[test]
fn find_prefers_active_then_falls_back_to_other_vaults_in_order() {
    let dir = temp_dir();
    let active = Connection::open_in_memory().unwrap();
    init_schema(&active).unwrap();
    let others = [
        dir.0.join("missing.db"),
        vault_db(&dir.0, "no-table", None),
        vault_db(&dir.0, "first", Some("key-first")),
        vault_db(&dir.0, "second", Some("key-second")),
    ];

    assert_eq!(
        find_wrapped_key(&active, &others).unwrap().as_deref(),
        Some("key-first")
    );

    store_wrapped_key(&active, "key-active").unwrap();
    assert_eq!(
        find_wrapped_key(&active, &others).unwrap().as_deref(),
        Some("key-active")
    );
}

#[test]
fn store_keeps_existing_key_and_rejects_empty() {
    let db = Connection::open_in_memory().unwrap();
    init_schema(&db).unwrap();

    assert_eq!(store_wrapped_key(&db, "first").unwrap(), "first");
    assert_eq!(store_wrapped_key(&db, "second").unwrap(), "first");
    assert!(store_wrapped_key(&db, "").is_err());
}

#[test]
fn replace_only_updates_vaults_holding_the_previous_key() {
    let dir = temp_dir();
    let active = Connection::open_in_memory().unwrap();
    init_schema(&active).unwrap();
    store_wrapped_key(&active, "old").unwrap();
    let matching = vault_db(&dir.0, "matching", Some("old"));
    let other_key = vault_db(&dir.0, "other-key", Some("foreign"));
    let no_table = vault_db(&dir.0, "no-table", None);
    let others = [
        matching.clone(),
        other_key.clone(),
        no_table.clone(),
        dir.0.join("missing.db"),
    ];

    replace_wrapped_key(&active, &others, "old", "new").unwrap();

    assert_eq!(read_wrapped_key(&active).unwrap().as_deref(), Some("new"));
    assert_eq!(stored_key(&matching).as_deref(), Some("new"));
    assert_eq!(stored_key(&other_key).as_deref(), Some("foreign"));
    assert_eq!(stored_key(&no_table), None);
    assert!(!dir.0.join("missing.db").exists());
}

#[test]
fn replacement_reaches_retained_vault_dirs_missing_from_catalog() {
    let dir = temp_dir();
    let db_in = |vault_id: &str, key: &str| {
        let root = vaults::vault_root(&dir.0, vault_id).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let path = vault_db(&root, "notes", Some(key));
        let target = root.join(vaults::DATABASE_FILE_NAME);
        std::fs::rename(&path, &target).unwrap();
        target
    };
    let active = Connection::open(db_in("local", "old")).unwrap();
    let catalog = db_in("listed", "old");
    let deleted = db_in("deleted", "old");
    let foreign = db_in("foreign", "other");

    let paths = replacement_db_paths(&dir.0, "local", vec![catalog.clone()]).unwrap();
    assert_eq!(paths.iter().filter(|path| **path == catalog).count(), 1);
    assert!(!paths.contains(&vaults::database_path(&dir.0, "local").unwrap()));

    replace_wrapped_key(&active, &paths, "old", "new").unwrap();

    assert_eq!(read_wrapped_key(&active).unwrap().as_deref(), Some("new"));
    assert_eq!(stored_key(&catalog).as_deref(), Some("new"));
    assert_eq!(stored_key(&deleted).as_deref(), Some("new"));
    assert_eq!(stored_key(&foreign).as_deref(), Some("other"));
}

#[test]
fn reset_drops_notes_and_images_sealed_by_the_key_only() {
    let dir = temp_dir();
    let image = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.enc";
    let vault_in = |vault_id: &str, key: &str| {
        let root = vaults::vault_root(&dir.0, vault_id).unwrap();
        let images = attachments::attachment_images_root(&root);
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join(image), b"cipher").unwrap();
        std::fs::write(images.join("clear.png"), b"clear").unwrap();
        let path = vault_db(&root, "notes", Some(key));
        let target = root.join(vaults::DATABASE_FILE_NAME);
        std::fs::rename(&path, &target).unwrap();
        Connection::open(&target)
            .unwrap()
            .execute_batch(
                "CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT NOT NULL);
                 CREATE TABLE tasks (id TEXT PRIMARY KEY,
                     attached_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL);
                 INSERT INTO notes VALUES ('sealed', 'soreno-enc:v1:QUJD+/=='),
                     ('clear', 'plain'), ('lookalike', 'soreno-enc:v1: not base64'),
                     ('empty', 'soreno-enc:v1:'), ('inner', 'soreno-enc:v1:a=b'),
                     ('padded', 'soreno-enc:v1:QUJD==='),
                     ('nul', 'soreno-enc:v1:QUJD' || char(0) || 'plain');
                 INSERT INTO tasks VALUES ('task', 'sealed');",
            )
            .unwrap();
        (root, target)
    };
    let (active_root, active_path) = vault_in("local", "old");
    let (deleted_root, deleted) = vault_in("deleted", "old");
    let (foreign_root, foreign) = vault_in("foreign", "other");
    let active = Connection::open(&active_path).unwrap();
    let note_ids = |path: &Path| -> Vec<String> {
        let db = Connection::open(path).unwrap();
        let mut statement = db.prepare("SELECT id FROM notes ORDER BY id").unwrap();
        let ids = statement.query_map([], |row| row.get(0)).unwrap();
        ids.collect::<Result<_, _>>().unwrap()
    };
    let has_image = |root: &Path| {
        attachments::attachment_images_root(root)
            .join(image)
            .exists()
    };

    let paths = replacement_db_paths(&dir.0, "local", Vec::new()).unwrap();
    reset_wrapped_key(&active, &active_root, &paths, "old").unwrap();

    for (root, path) in [(&active_root, &active_path), (&deleted_root, &deleted)] {
        assert_eq!(stored_key(path), None);
        assert_eq!(
            note_ids(path),
            ["clear", "empty", "inner", "lookalike", "nul", "padded"]
        );
        assert!(!has_image(root));
        assert!(attachments::attachment_images_root(root)
            .join("clear.png")
            .exists());
        let task_note: Option<String> = Connection::open(path)
            .unwrap()
            .query_row("SELECT attached_note_id FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_note, None);
    }
    assert_eq!(stored_key(&foreign).as_deref(), Some("other"));
    assert_eq!(
        note_ids(&foreign),
        [
            "clear",
            "empty",
            "inner",
            "lookalike",
            "nul",
            "padded",
            "sealed"
        ]
    );
    assert!(has_image(&foreign_root));
}

#[test]
fn delete_image_removes_legacy_copy_only_for_default_vault() {
    let dir = temp_dir();
    let name = "image.png";
    let legacy = attachments::attachment_images_root(&dir.0).join(name);
    let image_in = |vault_id: &str| {
        let path =
            attachments::attachment_images_root(&vaults::vault_root(&dir.0, vault_id).unwrap())
                .join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"clear").unwrap();
        path
    };
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, b"clear").unwrap();

    let other = image_in("other");
    delete_attachment_image(&dir.0, "other", name).unwrap();
    assert!(!other.exists());
    assert!(legacy.exists());

    let default = image_in("local");
    let vault_root = vaults::vault_root(&dir.0, "local").unwrap();
    let backups = [
        "attachments.migration-backup",
        "attachments.migration-backup-2",
    ]
    .map(|backup| {
        let path = vault_root.join(backup).join("images").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"clear").unwrap();
        path
    });
    delete_attachment_image(&dir.0, "local", name).unwrap();
    assert!(!default.exists());
    assert!(!legacy.exists());
    assert!(backups.iter().all(|path| !path.exists()));
    delete_attachment_image(&dir.0, "local", name).unwrap();
}

fn contains(path: &Path, marker: &[u8]) -> bool {
    std::fs::read(path).map_or(false, |bytes| {
        bytes.windows(marker.len()).any(|w| w == marker)
    })
}

#[test]
fn compact_clears_old_plaintext_from_wal_while_connection_stays_open() {
    let dir = temp_dir();
    let path = dir.0.join("wal.db");
    let wal = dir.0.join("wal.db-wal");
    let db = Connection::open(&path).unwrap();
    let mode: String = db
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    db.execute_batch(
        "CREATE TABLE notes (body TEXT);
         INSERT INTO notes VALUES ('plaintext-marker-1234');
         UPDATE notes SET body = 'ciphertext';",
    )
    .unwrap();
    assert!(contains(&wal, b"plaintext-marker-1234"));

    compact(&db).unwrap();

    assert_eq!(std::fs::metadata(&wal).map_or(0, |m| m.len()), 0);
    assert!(!contains(&path, b"plaintext-marker-1234"));
    assert!(!contains(&wal, b"plaintext-marker-1234"));
}

#[test]
fn compact_accepts_rollback_journal_database() {
    let dir = temp_dir();
    let db = Connection::open(vault_db(&dir.0, "rollback", Some("key"))).unwrap();
    compact(&db).unwrap();
}
