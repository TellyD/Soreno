use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const VAULTS_FILE_NAME: &str = "vaults.json";
const VAULTS_TEMP_FILE_NAME: &str = "vaults.json.tmp";
const VAULTS_BACKUP_FILE_NAME: &str = "vaults.json.bak";
const VAULTS_DIR_NAME: &str = "vaults";
pub(crate) const DATABASE_FILE_NAME: &str = "notes.sqlite3";
const ATTACHMENTS_DIR_NAME: &str = "attachments";
const DEFAULT_VAULT_ID: &str = "local";
const DEFAULT_VAULT_NAME: &str = "Coffre local";
const MAX_VAULT_NAME_LENGTH: usize = 60;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    pub active_vault_id: String,
    pub vaults: Vec<Vault>,
}

pub fn initialize_vault_state(app_data_dir: &Path) -> Result<VaultState, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;

    let state_path = vault_state_path(app_data_dir);

    if state_path.try_exists().map_err(|error| error.to_string())? {
        let state = read_valid_vault_state(&state_path)?;
        cleanup_vault_state_temp(app_data_dir);
        ensure_vault_dir(app_data_dir, &state.active_vault_id)?;

        return Ok(state);
    }

    if let Some(state) = recover_vault_state(app_data_dir)? {
        ensure_vault_dir(app_data_dir, &state.active_vault_id)?;

        return Ok(state);
    }

    let state = default_vault_state();
    migrate_legacy_storage(app_data_dir, DEFAULT_VAULT_ID)?;
    write_vault_state(app_data_dir, &state)?;

    Ok(state)
}

pub(crate) fn is_default_vault(vault_id: &str) -> bool {
    vault_id == DEFAULT_VAULT_ID
}

pub fn active_vault(state: &VaultState) -> Result<Vault, String> {
    state
        .vaults
        .iter()
        .find(|vault| vault.id == state.active_vault_id)
        .cloned()
        .ok_or_else(|| "Active vault does not exist".to_string())
}

pub(crate) fn vaults_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(VAULTS_DIR_NAME)
}

pub fn vault_root(app_data_dir: &Path, vault_id: &str) -> Result<PathBuf, String> {
    validate_vault_id(vault_id)?;

    Ok(vaults_root(app_data_dir).join(vault_id))
}

pub fn database_path(app_data_dir: &Path, vault_id: &str) -> Result<PathBuf, String> {
    Ok(vault_root(app_data_dir, vault_id)?.join(DATABASE_FILE_NAME))
}

pub fn ensure_vault_dir(app_data_dir: &Path, vault_id: &str) -> Result<PathBuf, String> {
    let root = vault_root(app_data_dir, vault_id)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    Ok(root)
}

pub fn add_vault(state: &VaultState, name: &str) -> Result<(VaultState, String), String> {
    let vault_name = normalize_vault_name(name)?;
    ensure_unique_vault_name(&vault_name, &state.vaults, None)?;

    let now = current_timestamp();
    let id = next_vault_id(state);
    let vault = Vault {
        id: id.clone(),
        name: vault_name,
        created_at: now.clone(),
        updated_at: now,
    };

    let mut next_state = state.clone();
    next_state.active_vault_id = id.clone();
    next_state.vaults.push(vault);

    Ok((next_state, id))
}

pub fn rename_vault(state: &VaultState, id: &str, name: &str) -> Result<VaultState, String> {
    validate_vault_id(id)?;

    let vault_name = normalize_vault_name(name)?;
    ensure_unique_vault_name(&vault_name, &state.vaults, Some(id))?;

    let mut next_state = state.clone();
    let vault = next_state
        .vaults
        .iter_mut()
        .find(|vault| vault.id == id)
        .ok_or_else(|| "Vault does not exist".to_string())?;

    vault.name = vault_name;
    vault.updated_at = current_timestamp();

    Ok(next_state)
}

pub fn select_vault(state: &VaultState, id: &str) -> Result<VaultState, String> {
    validate_vault_id(id)?;

    if !state.vaults.iter().any(|vault| vault.id == id) {
        return Err("Vault does not exist".to_string());
    }

    let mut next_state = state.clone();
    next_state.active_vault_id = id.to_string();

    Ok(next_state)
}

pub fn delete_vault(state: &VaultState, id: &str) -> Result<VaultState, String> {
    validate_vault_state(state)?;
    validate_vault_id(id)?;

    if state.vaults.len() <= 1 {
        return Err("Cannot delete the last vault".to_string());
    }

    if !state.vaults.iter().any(|vault| vault.id == id) {
        return Err("Vault does not exist".to_string());
    }

    let vaults = state
        .vaults
        .iter()
        .filter(|vault| vault.id != id)
        .cloned()
        .collect::<Vec<_>>();
    let active_vault_id = if state.active_vault_id == id {
        vaults
            .first()
            .map(|vault| vault.id.clone())
            .ok_or_else(|| "At least one vault is required".to_string())?
    } else {
        state.active_vault_id.clone()
    };
    let next_state = VaultState {
        active_vault_id,
        vaults,
    };

    validate_vault_state(&next_state)?;

    Ok(next_state)
}

pub fn write_vault_state(app_data_dir: &Path, state: &VaultState) -> Result<(), String> {
    validate_vault_state(state)?;
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;

    let contents = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    let state_path = vault_state_path(app_data_dir);
    let temp_path = vault_state_temp_path(app_data_dir);
    let backup_path = vault_state_backup_path(app_data_dir);
    let had_catalog = state_path.try_exists().map_err(|error| error.to_string())?;

    write_synced_file(&temp_path, contents.as_bytes())?;

    if had_catalog {
        if backup_path
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }

        if let Err(error) = fs::rename(&state_path, &backup_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(error.to_string());
        }
        best_effort_sync_parent_directory(&state_path);
    }

    if let Err(promotion_error) = fs::rename(&temp_path, &state_path) {
        let restore_error = if had_catalog {
            fs::rename(&backup_path, &state_path).err()
        } else {
            None
        };

        if had_catalog && restore_error.is_none() {
            best_effort_sync_parent_directory(&state_path);
            let _ = fs::remove_file(&temp_path);
        }

        return match restore_error {
            Some(error) => Err(format!(
                "Failed to promote vault catalog: {promotion_error}; failed to restore backup: {error}"
            )),
            None => Err(promotion_error.to_string()),
        };
    }

    best_effort_sync_parent_directory(&state_path);
    Ok(())
}

fn default_vault_state() -> VaultState {
    let now = current_timestamp();

    VaultState {
        active_vault_id: DEFAULT_VAULT_ID.to_string(),
        vaults: vec![Vault {
            id: DEFAULT_VAULT_ID.to_string(),
            name: DEFAULT_VAULT_NAME.to_string(),
            created_at: now.clone(),
            updated_at: now,
        }],
    }
}

fn read_vault_state(path: &Path) -> Result<VaultState, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;

    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn read_valid_vault_state(path: &Path) -> Result<VaultState, String> {
    let state = read_vault_state(path)?;
    validate_vault_state(&state)?;
    Ok(state)
}

fn recover_vault_state(app_data_dir: &Path) -> Result<Option<VaultState>, String> {
    let state_path = vault_state_path(app_data_dir);
    let mut candidate_error = None;

    for recovery_path in [
        vault_state_temp_path(app_data_dir),
        vault_state_backup_path(app_data_dir),
    ] {
        let contents = match fs::read_to_string(&recovery_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                candidate_error.get_or_insert_with(|| {
                    format!("Failed to read {}: {error}", recovery_path.display())
                });
                continue;
            }
        };
        let state = match serde_json::from_str::<VaultState>(&contents)
            .map_err(|error| error.to_string())
            .and_then(|state| {
                validate_vault_state(&state)?;
                Ok(state)
            }) {
            Ok(state) => state,
            Err(error) => {
                candidate_error.get_or_insert_with(|| {
                    format!("Invalid vault catalog {}: {error}", recovery_path.display())
                });
                continue;
            }
        };

        fs::rename(&recovery_path, &state_path).map_err(|error| error.to_string())?;
        best_effort_sync_parent_directory(&state_path);
        cleanup_vault_state_temp(app_data_dir);
        return Ok(Some(state));
    }

    match candidate_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

fn write_synced_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    file.write_all(contents)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn cleanup_vault_state_temp(app_data_dir: &Path) {
    let _ = fs::remove_file(vault_state_temp_path(app_data_dir));
}

pub(crate) fn best_effort_sync_parent_directory(path: &Path) {
    #[cfg(target_os = "linux")]
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }

    #[cfg(not(target_os = "linux"))]
    let _ = path;
}

fn migrate_legacy_storage(app_data_dir: &Path, vault_id: &str) -> Result<(), String> {
    let root = ensure_vault_dir(app_data_dir, vault_id)?;
    move_if_missing(
        &app_data_dir.join(DATABASE_FILE_NAME),
        &root.join(DATABASE_FILE_NAME),
    )?;
    copy_dir_if_missing(
        &app_data_dir.join(ATTACHMENTS_DIR_NAME),
        &root.join(ATTACHMENTS_DIR_NAME),
    )
}

fn move_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() || target.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    // Opening and reading at the original path recovers any hot rollback journal.
    let conn =
        rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|error| error.to_string())?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|error| error.to_string())?;
    let (busy, frames, checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    if busy != 0 || frames != checkpointed {
        return Err("Legacy database is busy; migration was not performed".into());
    }
    conn.close().map_err(|(_, error)| error.to_string())?;
    fs::rename(source, target).map_err(|error| error.to_string())
}

fn copy_dir_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let temporary = target.with_extension("migration-tmp");
    if temporary.try_exists().map_err(|error| error.to_string())? {
        fs::remove_dir_all(&temporary).map_err(|error| error.to_string())?;
    }
    copy_dir_all(source, &temporary)?;
    // A pre-fix interrupted copy may already occupy the destination. Keep it intact.
    if target.try_exists().map_err(|error| error.to_string())? {
        let mut backup = target.with_extension("migration-backup");
        let mut suffix = 0;
        while backup.try_exists().map_err(|error| error.to_string())? {
            suffix += 1;
            backup = target.with_extension(format!("migration-backup-{suffix}"));
        }
        fs::rename(target, &backup).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, target).map_err(|error| error.to_string())
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;

    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_type = entry.file_type().map_err(|error| error.to_string())?;
        let target_path = target.join(entry.file_name());

        if entry_type.is_dir() {
            copy_dir_all(&entry.path(), &target_path)?;
        } else if entry_type.is_file() {
            fs::copy(entry.path(), &target_path).map_err(|error| error.to_string())?;
            OpenOptions::new()
                .write(true)
                .open(&target_path)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
        } else {
            return Err(format!(
                "Unsupported legacy attachment: {}",
                entry.path().display()
            ));
        }
    }

    Ok(())
}

fn vault_state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(VAULTS_FILE_NAME)
}

fn vault_state_temp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(VAULTS_TEMP_FILE_NAME)
}

fn vault_state_backup_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(VAULTS_BACKUP_FILE_NAME)
}

fn normalize_vault_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();

    if trimmed.is_empty() {
        return Err("Vault name is required".to_string());
    }

    if trimmed.chars().count() > MAX_VAULT_NAME_LENGTH {
        return Err("Vault name is too long".to_string());
    }

    Ok(trimmed.to_string())
}

fn ensure_unique_vault_name(
    name: &str,
    vaults: &[Vault],
    ignored_id: Option<&str>,
) -> Result<(), String> {
    let has_duplicate = vaults
        .iter()
        .any(|vault| Some(vault.id.as_str()) != ignored_id && vault.name == name);

    if has_duplicate {
        return Err("Vault name already exists".to_string());
    }

    Ok(())
}

fn validate_vault_state(state: &VaultState) -> Result<(), String> {
    if state.vaults.is_empty() {
        return Err("At least one vault is required".to_string());
    }

    let mut ids = Vec::new();

    for vault in &state.vaults {
        validate_vault_id(&vault.id)?;
        normalize_vault_name(&vault.name)?;

        if ids.iter().any(|id| id == &vault.id) {
            return Err("Vault ids must be unique".to_string());
        }

        ids.push(vault.id.clone());
    }

    if !state
        .vaults
        .iter()
        .any(|vault| vault.id == state.active_vault_id)
    {
        return Err("Active vault does not exist".to_string());
    }

    Ok(())
}

fn validate_vault_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid vault id".to_string());
    }

    Ok(())
}

fn next_vault_id(state: &VaultState) -> String {
    let base = format!("vault-{}", Utc::now().format("%Y%m%d%H%M%S%3f"));

    if !state.vaults.iter().any(|vault| vault.id == base) {
        return base;
    }

    for suffix in 2..=999 {
        let candidate = format!("{base}-{suffix}");

        if !state.vaults.iter().any(|vault| vault.id == candidate) {
            return candidate;
        }
    }

    format!(
        "{base}-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

fn current_timestamp() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
#[path = "vaults_tests.rs"]
mod tests;
