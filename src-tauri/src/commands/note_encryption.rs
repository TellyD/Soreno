use crate::{
    app_state::{ActiveVaultState, AppState},
    attachments, note_encryption, vaults,
};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub(crate) fn get_note_encryption_key(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let vault_state = state.lock_vaults()?;
    note_encryption::find_wrapped_key(&vault_state.db, &other_vault_db_paths(&vault_state)?)
}

#[tauri::command]
pub(crate) fn store_note_encryption_key(
    wrapped_key: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let vault_state = state.lock_vaults()?;
    note_encryption::store_wrapped_key(&vault_state.db, &wrapped_key)
}

#[tauri::command]
pub(crate) fn replace_note_encryption_key(
    previous: String,
    next: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault_state = state.lock_vaults()?;
    let other_db_paths = note_encryption::replacement_db_paths(
        &vault_state.app_data_dir,
        &vault_state.vault_state.active_vault_id,
        other_vault_db_paths(&vault_state)?,
    )?;
    note_encryption::replace_wrapped_key(&vault_state.db, &other_db_paths, &previous, &next)
}

#[tauri::command]
pub(crate) fn reset_note_encryption_key(
    wrapped_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault_state = state.lock_vaults()?;
    let app_data_dir = &vault_state.app_data_dir;
    let active_vault_id = &vault_state.vault_state.active_vault_id;
    let other_db_paths = note_encryption::replacement_db_paths(
        app_data_dir,
        active_vault_id,
        other_vault_db_paths(&vault_state)?,
    )?;
    note_encryption::reset_wrapped_key(
        &vault_state.db,
        &vaults::vault_root(app_data_dir, active_vault_id)?,
        &other_db_paths,
        &wrapped_key,
    )
}

#[tauri::command]
pub(crate) fn save_encrypted_attachment(
    name: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    attachments::save_encrypted_attachment(&active_vault_root(&state)?, &name, &data_base64)
}

#[tauri::command]
pub(crate) fn read_attachment_image(
    name: String,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    attachments::read_attachment_image(&active_vault_root(&state)?, &name)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) fn delete_attachment_image(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let vault_state = state.lock_vaults()?;
    note_encryption::delete_attachment_image(
        &vault_state.app_data_dir,
        &vault_state.vault_state.active_vault_id,
        &name,
    )
}

// shortcut: synchronous VACUUM briefly blocks the UI; fine for a notes-and-tasks database, move to spawn_blocking if vaults grow large.
#[tauri::command]
pub(crate) fn compact_vault_database(state: State<'_, AppState>) -> Result<(), String> {
    state.with_db(note_encryption::compact)
}

fn active_vault_root(state: &AppState) -> Result<PathBuf, String> {
    let vault_state = state.lock_vaults()?;
    vaults::vault_root(
        &vault_state.app_data_dir,
        &vault_state.vault_state.active_vault_id,
    )
}

fn other_vault_db_paths(vault_state: &ActiveVaultState) -> Result<Vec<PathBuf>, String> {
    let catalog = &vault_state.vault_state;
    catalog
        .vaults
        .iter()
        .filter(|vault| vault.id != catalog.active_vault_id)
        .map(|vault| vaults::database_path(&vault_state.app_data_dir, &vault.id))
        .collect()
}
