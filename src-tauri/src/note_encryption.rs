use crate::sqlite::table_column_exists;
use crate::{attachments, vaults};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};

pub(crate) fn init_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_encryption (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            wrapped_key TEXT NOT NULL
        );",
    )
}

pub(crate) fn find_wrapped_key(
    active_db: &Connection,
    other_db_paths: &[PathBuf],
) -> Result<Option<String>, String> {
    if let Some(key) = read_wrapped_key(active_db).map_err(|error| error.to_string())? {
        return Ok(Some(key));
    }
    for path in other_db_paths {
        let Some(db) = open_other(path, OpenFlags::SQLITE_OPEN_READ_ONLY)? else {
            continue;
        };
        if let Some(key) = read_wrapped_key(&db).map_err(|error| error.to_string())? {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

pub(crate) fn store_wrapped_key(db: &Connection, wrapped_key: &str) -> Result<String, String> {
    if wrapped_key.is_empty() {
        return Err("Wrapped key is empty".to_string());
    }
    db.execute(
        "INSERT INTO note_encryption (id, wrapped_key) VALUES (1, ?1) ON CONFLICT(id) DO NOTHING",
        params![wrapped_key],
    )
    .map_err(|error| error.to_string())?;
    read_wrapped_key(db)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Wrapped key was not stored".to_string())
}

pub(crate) fn delete_attachment_image(
    app_data_dir: &Path,
    vault_id: &str,
    name: &str,
) -> Result<(), String> {
    let vault_root = vaults::vault_root(app_data_dir, vault_id)?;
    attachments::delete_attachment_image(&vault_root, name)?;
    // Legacy migration copied <app_data>/attachments into the default vault but kept the originals,
    // and a retried migration renames the previous copy to attachments.migration-backup[-N].
    if vaults::is_default_vault(vault_id) {
        attachments::delete_attachment_image(app_data_dir, name)?;
        for backup in read_dir_or_empty(&vault_root)? {
            let backup = backup.map_err(|error| error.to_string())?;
            let file_name = backup.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name == "attachments.migration-backup"
                || file_name.starts_with("attachments.migration-backup-")
            {
                attachments::delete_image_in(&backup.path().join("images"), name)?;
            }
        }
    }
    Ok(())
}

// Deleted vaults keep their directory and DB: the old wrapped key there would still unlock the master key.
pub(crate) fn replacement_db_paths(
    app_data_dir: &Path,
    active_vault_id: &str,
    mut paths: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, String> {
    let active = vaults::database_path(app_data_dir, active_vault_id)?;
    for entry in read_dir_or_empty(&vaults::vaults_root(app_data_dir))? {
        let path = entry
            .map_err(|error| error.to_string())?
            .path()
            .join(vaults::DATABASE_FILE_NAME);
        if path != active && !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn read_dir_or_empty(dir: &Path) -> Result<Vec<std::io::Result<std::fs::DirEntry>>, String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(entries.collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

// shortcut: per-vault updates are not atomic; a failed write leaves that vault on the old passphrase. Use ATTACH + one transaction if it is reported.
pub(crate) fn replace_wrapped_key(
    active_db: &Connection,
    other_db_paths: &[PathBuf],
    previous: &str,
    next: &str,
) -> Result<(), String> {
    if next.is_empty() {
        return Err("Wrapped key is empty".to_string());
    }
    let mut first_error = update_matching_key(active_db, previous, next).err();
    for path in other_db_paths {
        let result = open_other(path, OpenFlags::SQLITE_OPEN_READ_WRITE).and_then(|db| match db {
            Some(db) => update_matching_key(&db, previous, next),
            None => Ok(()),
        });
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    // shortcut: a busy checkpoint (WAL vault plus another open reader) reports failure although the new key is saved; return a distinct outcome if it is reported.
    if let Err(error) = checkpoint_wal(active_db) {
        first_error.get_or_insert(error);
    }
    first_error.map_or(Ok(()), Err)
}

// Without its passphrase the key is gone for good: drop it with the notes and images it sealed.
// shortcut: per-vault resets are not atomic; a failed vault keeps its key and notes until a retry. Use ATTACH + one transaction if it is reported.
pub(crate) fn reset_wrapped_key(
    active_db: &Connection,
    active_root: &Path,
    other_db_paths: &[PathBuf],
    wrapped_key: &str,
) -> Result<(), String> {
    let mut first_error = reset_vault(active_db, active_root, wrapped_key).err();
    for path in other_db_paths {
        let result = open_other(path, OpenFlags::SQLITE_OPEN_READ_WRITE).and_then(|db| {
            match (db, path.parent()) {
                (Some(db), Some(root)) => reset_vault(&db, root, wrapped_key),
                _ => Ok(()),
            }
        });
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

// A vault holding another key keeps its notes: that key may still open with its own passphrase.
fn reset_vault(db: &Connection, vault_root: &Path, wrapped_key: &str) -> Result<(), String> {
    if read_wrapped_key(db)
        .map_err(|error| error.to_string())?
        .as_deref()
        != Some(wrapped_key)
    {
        return Ok(());
    }
    // Connections to other vaults start without it, and tasks must drop their link to deleted notes.
    db.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if table_column_exists(&transaction, "notes", "content").map_err(|error| error.to_string())? {
        transaction
            .execute(
                "DELETE FROM notes WHERE content GLOB 'soreno-enc:v1:*'
                    AND rtrim(substr(content, 15), '=') <> ''
                    AND rtrim(substr(content, 15), '=') NOT GLOB '*[^A-Za-z0-9+/]*'
                    AND length(content) - length(rtrim(content, '=')) <= 2
                    AND instr(content, char(0)) = 0",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "DELETE FROM note_encryption WHERE wrapped_key = ?1",
            params![wrapped_key],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    // shortcut: an image that fails to delete stays as an orphan .enc file, since the key is already gone and a retry skips this vault; delete images before the commit if it is reported.
    let images_dir = attachments::attachment_images_root(vault_root);
    for entry in read_dir_or_empty(&images_dir)? {
        let name = entry.map_err(|error| error.to_string())?.file_name();
        let name = name.to_string_lossy();
        if attachments::is_encrypted_attachment_name(&name) {
            attachments::delete_image_in(&images_dir, &name)?;
        }
    }
    Ok(())
}

// VACUUM alone leaves old plaintext pages in the -wal file of a WAL-mode vault.
pub(crate) fn compact(db: &Connection) -> Result<(), String> {
    db.execute_batch("VACUUM")
        .map_err(|error| error.to_string())?;
    checkpoint_wal(db)
}

// Rollback-journal mode returns (0, -1, -1), which passes.
fn checkpoint_wal(db: &Connection) -> Result<(), String> {
    let (busy, frames, checkpointed): (i64, i64, i64) = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    if busy != 0 || frames != checkpointed {
        return Err("Database is busy; the write-ahead log was not cleared".into());
    }
    Ok(())
}

fn read_wrapped_key(db: &Connection) -> rusqlite::Result<Option<String>> {
    if !table_column_exists(db, "note_encryption", "wrapped_key")? {
        return Ok(None);
    }
    db.query_row(
        "SELECT wrapped_key FROM note_encryption WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .optional()
}

// Only rows still holding `previous` move: another vault may hold a different master key.
fn update_matching_key(db: &Connection, previous: &str, next: &str) -> Result<(), String> {
    if !table_column_exists(db, "note_encryption", "wrapped_key")
        .map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    db.execute(
        "UPDATE note_encryption SET wrapped_key = ?2 WHERE wrapped_key = ?1",
        params![previous, next],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn open_other(path: &Path, flags: OpenFlags) -> Result<Option<Connection>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "note_encryption_tests.rs"]
mod tests;
