use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_vaults_dir() -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();

    std::env::temp_dir().join(format!("soreno-vaults-test-{id}"))
}

#[test]
fn initialize_vault_state_migrates_legacy_database_and_attachments() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(dir.join(ATTACHMENTS_DIR_NAME)).expect("create legacy attachments");
    let conn = rusqlite::Connection::open(dir.join(DATABASE_FILE_NAME)).unwrap();
    conn.execute_batch("CREATE TABLE legacy (id INTEGER);")
        .unwrap();
    conn.close().unwrap();
    fs::write(dir.join(ATTACHMENTS_DIR_NAME).join("image.webp"), "image")
        .expect("write legacy attachment");

    let state = initialize_vault_state(&dir).expect("initialize vaults");
    let root = vault_root(&dir, DEFAULT_VAULT_ID).expect("vault root");

    assert_eq!(state.active_vault_id, DEFAULT_VAULT_ID);
    assert_eq!(state.vaults[0].name, DEFAULT_VAULT_NAME);
    assert!(root.join(DATABASE_FILE_NAME).exists());
    assert!(root.join(ATTACHMENTS_DIR_NAME).join("image.webp").exists());
    assert!(!dir.join(DATABASE_FILE_NAME).exists());
    assert!(dir.join(ATTACHMENTS_DIR_NAME).join("image.webp").exists());

    let _ = fs::remove_dir_all(dir);
}

#[test]
#[ignore = "subprocess fixture for migration_recovers_hot_rollback_journal_before_moving_database"]
fn legacy_hot_journal_child() {
    let Some(path) = std::env::var_os("SORENO_TEST_HOT_JOURNAL") else {
        return;
    };
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=DELETE; PRAGMA cache_size=10;
            CREATE TABLE entries (value BLOB); INSERT INTO entries VALUES ('committed');
            BEGIN IMMEDIATE;
            WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
            INSERT INTO entries SELECT zeroblob(4096) FROM n;",
    )
    .unwrap();
    std::process::exit(0); // Simulate a crash: do not run SQLite destructors.
}

#[test]
fn migration_recovers_hot_rollback_journal_before_moving_database() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join(DATABASE_FILE_NAME);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "vaults::tests::legacy_hot_journal_child",
        ])
        .env("SORENO_TEST_HOT_JOURNAL", &source)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(dir.join("notes.sqlite3-journal").exists());
    initialize_vault_state(&dir).unwrap();
    let conn = rusqlite::Connection::open(database_path(&dir, DEFAULT_VAULT_ID).unwrap()).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM entries", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(conn);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn migration_refuses_busy_wal_and_invalid_database_without_moving_source() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join(DATABASE_FILE_NAME);
    let target = dir.join("destination.sqlite3");
    fs::write(&source, "invalid database").unwrap();
    assert!(move_if_missing(&source, &target).is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "invalid database");
    assert!(!target.exists());
    fs::remove_file(&source).unwrap();
    let writer = rusqlite::Connection::open(&source).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE entries (id INTEGER);")
        .unwrap();
    let reader = rusqlite::Connection::open(&source).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM entries;")
        .unwrap();
    writer
        .execute("INSERT INTO entries VALUES (1)", [])
        .unwrap();
    assert!(move_if_missing(&source, &target).is_err());
    assert!(source.exists());
    assert!(!target.exists());
    drop(reader);
    drop(writer);
    move_if_missing(&source, &target).unwrap();
    let conn = rusqlite::Connection::open(&target).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM entries", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(conn);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn attachment_migration_restarts_partial_copies_and_keeps_originals() {
    let dir = temp_vaults_dir();
    let source = dir.join("source");
    let target = dir.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(source.join("image"), "complete").unwrap();
    fs::write(target.join("image"), "part").unwrap();
    fs::create_dir_all(target.with_extension("migration-tmp")).unwrap();
    fs::write(target.with_extension("migration-tmp").join("image"), "pa").unwrap();
    copy_dir_if_missing(&source, &target).unwrap();
    assert_eq!(
        fs::read_to_string(target.join("image")).unwrap(),
        "complete"
    );
    assert_eq!(
        fs::read_to_string(source.join("image")).unwrap(),
        "complete"
    );
    assert_eq!(
        fs::read_to_string(target.with_extension("migration-backup").join("image")).unwrap(),
        "part"
    );
    copy_dir_if_missing(&source, &target).unwrap();
    assert_eq!(
        fs::read_to_string(target.join("image")).unwrap(),
        "complete"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_attachment_copy_does_not_promote_or_replace_existing_destination() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source");
    let target = dir.join("target");
    fs::write(&source, "not a directory").unwrap();
    assert!(copy_dir_if_missing(&source, &target).is_err());
    assert!(!target.exists());
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("existing"), "keep").unwrap();
    assert!(copy_dir_if_missing(&source, &target).is_err());
    assert_eq!(fs::read_to_string(target.join("existing")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(&source).unwrap(), "not a directory");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn write_vault_state_keeps_the_previous_catalog_as_backup() {
    let dir = temp_vaults_dir();
    let previous = default_vault_state();
    let (current, _) = add_vault(&previous, "Projet").expect("add vault");

    write_vault_state(&dir, &previous).expect("write previous catalog");
    write_vault_state(&dir, &current).expect("write current catalog");

    assert_eq!(
        read_valid_vault_state(&vault_state_path(&dir)).expect("read current catalog"),
        current
    );
    assert_eq!(
        read_valid_vault_state(&vault_state_backup_path(&dir)).expect("read backup catalog"),
        previous
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn initialize_vault_state_recovers_a_valid_backup_when_catalog_is_missing() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).expect("create app data directory");
    let (expected, vault_id) = add_vault(&default_vault_state(), "Projet").expect("add vault");
    let contents = serde_json::to_string_pretty(&expected).expect("serialize vault state");
    fs::write(vault_state_backup_path(&dir), contents).expect("write backup");

    let recovered = initialize_vault_state(&dir).expect("recover vault state");

    assert_eq!(recovered, expected);
    assert_eq!(
        read_valid_vault_state(&vault_state_path(&dir)).expect("read recovered catalog"),
        expected
    );
    assert!(vault_root(&dir, &vault_id).expect("vault root").exists());
    assert!(!vault_state_backup_path(&dir).exists());
    assert!(!vault_state_temp_path(&dir).exists());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn initialize_vault_state_prefers_a_valid_temporary_catalog_over_backup() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).expect("create app data directory");
    let backup = default_vault_state();
    let (temporary, _) = add_vault(&backup, "Projet").expect("add vault");
    fs::write(
        vault_state_backup_path(&dir),
        serde_json::to_string_pretty(&backup).expect("serialize backup"),
    )
    .expect("write backup");
    fs::write(
        vault_state_temp_path(&dir),
        serde_json::to_string_pretty(&temporary).expect("serialize temporary catalog"),
    )
    .expect("write temporary catalog");

    assert_eq!(
        initialize_vault_state(&dir).expect("recover vault state"),
        temporary
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn initialize_vault_state_uses_valid_backup_after_invalid_temporary_catalog() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).expect("create app data directory");
    let backup = default_vault_state();
    fs::write(vault_state_temp_path(&dir), "invalid").expect("write invalid temporary");
    fs::write(
        vault_state_backup_path(&dir),
        serde_json::to_string_pretty(&backup).expect("serialize backup"),
    )
    .expect("write backup");

    assert_eq!(
        initialize_vault_state(&dir).expect("recover backup"),
        backup
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn initialize_vault_state_preserves_an_invalid_recovery_candidate() {
    let dir = temp_vaults_dir();
    fs::create_dir_all(&dir).expect("create app data directory");
    let temporary_path = vault_state_temp_path(&dir);
    fs::write(&temporary_path, "invalid").expect("write invalid temporary");

    assert!(initialize_vault_state(&dir).is_err());
    assert_eq!(
        fs::read_to_string(temporary_path).expect("read temporary"),
        "invalid"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn add_vault_trims_name_and_makes_it_active() {
    let state = default_vault_state();

    let (next_state, vault_id) = add_vault(&state, "  Projet client  ").expect("add vault");

    assert_eq!(next_state.active_vault_id, vault_id);
    assert_eq!(
        next_state
            .vaults
            .iter()
            .find(|vault| vault.id == vault_id)
            .expect("created vault")
            .name,
        "Projet client"
    );
}

#[test]
fn rename_vault_rejects_empty_and_duplicate_names() {
    let (state, vault_id) = add_vault(&default_vault_state(), "Projet").expect("add vault");

    assert!(rename_vault(&state, &vault_id, " ").is_err());
    assert!(rename_vault(&state, &vault_id, DEFAULT_VAULT_NAME).is_err());
}

#[test]
fn rename_vault_updates_the_requested_vault() {
    let (state, vault_id) = add_vault(&default_vault_state(), "Projet").expect("add vault");

    let next_state = rename_vault(&state, &vault_id, "Archive").expect("rename vault");

    assert_eq!(
        next_state
            .vaults
            .iter()
            .find(|vault| vault.id == vault_id)
            .expect("renamed vault")
            .name,
        "Archive"
    );
}

#[test]
fn select_vault_rejects_unknown_vaults() {
    let state = default_vault_state();

    assert!(select_vault(&state, "missing").is_err());
}

#[test]
fn delete_vault_removes_non_active_vault_from_catalog_without_moving_data() {
    let dir = temp_vaults_dir();
    let (state, vault_id) = add_vault(&default_vault_state(), "Projet").expect("add vault");
    let state = select_vault(&state, DEFAULT_VAULT_ID).expect("select default vault");
    let source = vault_root(&dir, &vault_id).expect("vault root");
    fs::create_dir_all(&source).expect("create vault");
    fs::write(source.join(DATABASE_FILE_NAME), "db").expect("write database");

    let next_state = delete_vault(&state, &vault_id).expect("delete vault");

    assert_eq!(next_state.active_vault_id, DEFAULT_VAULT_ID);
    assert!(!next_state.vaults.iter().any(|vault| vault.id == vault_id));
    assert!(source.join(DATABASE_FILE_NAME).exists());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn delete_vault_switches_active_vault_when_needed() {
    let dir = temp_vaults_dir();
    let (state, vault_id) = add_vault(&default_vault_state(), "Projet").expect("add vault");
    let source = vault_root(&dir, &vault_id).expect("vault root");
    fs::create_dir_all(&source).expect("create vault");

    let next_state = delete_vault(&state, &vault_id).expect("prepare active vault deletion");

    assert_eq!(next_state.active_vault_id, DEFAULT_VAULT_ID);
    assert!(source.exists());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn delete_vault_rejects_last_and_unknown_vaults() {
    let state = default_vault_state();

    assert!(delete_vault(&state, DEFAULT_VAULT_ID).is_err());
    assert!(delete_vault(&state, "missing").is_err());
}

#[test]
fn vault_paths_reject_path_traversal_ids() {
    assert!(vault_root(Path::new("base"), "../outside").is_err());
    assert!(vault_root(Path::new("base"), "vault-ok_1").is_ok());
}
