use crate::{attachments, note_encryption, notes, tasks, vaults};
use rusqlite::Connection;
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::Manager;
use vaults::VaultState;

pub(crate) struct AppState {
    pub(crate) vaults: Mutex<ActiveVaultState>,
    _vault_lock: File,
}

impl AppState {
    pub(crate) fn lock_vaults(&self) -> Result<MutexGuard<'_, ActiveVaultState>, String> {
        self.vaults.lock().map_err(|error| error.to_string())
    }

    pub(crate) fn with_db<T, E: ToString>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, String> {
        let vault_state = self.lock_vaults()?;
        operation(&vault_state.db).map_err(|error| error.to_string())
    }
}

pub(crate) struct ActiveVaultState {
    pub(crate) app_data_dir: PathBuf,
    pub(crate) db: Connection,
    pub(crate) vault_state: VaultState,
}

pub(crate) fn init_app_state(app: &tauri::App) -> Result<AppState, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    let vault_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(app_dir.join("vaults.lock"))
        .map_err(|error| format!("Failed to open vault catalog lock: {error}"))?;
    match vault_lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err("Vault catalog is already locked by another process".to_string());
        }
        Err(TryLockError::Error(error)) => {
            return Err(format!("Failed to lock vault catalog: {error}"));
        }
    }

    let vault_state = vaults::initialize_vault_state(&app_dir)?;
    let db = open_active_database(&app_dir, &vault_state)?;

    Ok(AppState {
        vaults: Mutex::new(ActiveVaultState {
            app_data_dir: app_dir,
            db,
            vault_state,
        }),
        _vault_lock: vault_lock,
    })
}

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

pub(crate) fn sync_attachment_asset_scope(
    app: &tauri::AppHandle,
    app_data_dir: &Path,
) -> Result<(), String> {
    let attachments_root = attachments::attachments_root(app_data_dir);
    fs::create_dir_all(&attachments_root).map_err(|error| error.to_string())?;

    app.asset_protocol_scope()
        .allow_directory(&attachments_root, true)
        .map_err(|error| error.to_string())
}

pub(crate) fn open_active_database(
    app_data_dir: &Path,
    vault_state: &VaultState,
) -> Result<Connection, String> {
    let active_vault = vaults::active_vault(vault_state)?;
    vaults::ensure_vault_dir(app_data_dir, &active_vault.id)?;
    let db_path = vaults::database_path(app_data_dir, &active_vault.id)?;

    open_database(&db_path).map_err(|error| error.to_string())
}

fn open_database(db_path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(db_path)?;
    // Zeroes freed pages so plaintext replaced by ciphertext does not linger in the file.
    db.pragma_update(None, "secure_delete", true)?;
    // Before the notes migration, whose legacy rebuild rejects foreign keys it does not know.
    db.execute_batch(
        "
        DROP TABLE IF EXISTS assistant_messages;
        DROP TABLE IF EXISTS assistant_conversations;
        ",
    )?;
    notes::init_schema(&db)?;
    tasks::init_schema(&db)?;
    note_encryption::init_schema(&db)?;
    Ok(db)
}

#[cfg(test)]
#[path = "app_state_tests.rs"]
mod tests;
