use crate::{
    app_state::{open_active_database, sync_attachment_asset_scope, AppState},
    vaults::{self, Vault, VaultState},
};
use tauri::State;

fn replace_active_vault(
    app: &tauri::AppHandle,
    state: State<'_, AppState>,
    next_vault_state: VaultState,
) -> Result<VaultState, String> {
    let mut runtime = state.lock_vaults()?;
    let db = open_active_database(&runtime.app_data_dir, &next_vault_state)?;
    let active_vault_root =
        vaults::vault_root(&runtime.app_data_dir, &next_vault_state.active_vault_id)?;

    sync_attachment_asset_scope(app, &active_vault_root)?;
    vaults::write_vault_state(&runtime.app_data_dir, &next_vault_state)?;
    runtime.db = db;
    runtime.vault_state = next_vault_state.clone();

    Ok(next_vault_state)
}

#[tauri::command]
pub(crate) fn list_vaults(state: State<'_, AppState>) -> Result<Vec<Vault>, String> {
    let vault_state = state.lock_vaults()?;

    Ok(vault_state.vault_state.vaults.clone())
}

#[tauri::command]
pub(crate) fn get_active_vault(state: State<'_, AppState>) -> Result<Vault, String> {
    let vault_state = state.lock_vaults()?;

    vaults::active_vault(&vault_state.vault_state)
}

#[tauri::command]
pub(crate) fn create_vault(
    app: tauri::AppHandle,
    name: String,
    state: State<'_, AppState>,
) -> Result<VaultState, String> {
    let next_vault_state = {
        let runtime = state.lock_vaults()?;
        let (next_state, vault_id) = vaults::add_vault(&runtime.vault_state, &name)?;
        vaults::ensure_vault_dir(&runtime.app_data_dir, &vault_id)?;
        next_state
    };

    replace_active_vault(&app, state, next_vault_state)
}

#[tauri::command]
pub(crate) fn rename_vault(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<VaultState, String> {
    let mut runtime = state.lock_vaults()?;
    let next_vault_state = vaults::rename_vault(&runtime.vault_state, &id, &name)?;

    vaults::write_vault_state(&runtime.app_data_dir, &next_vault_state)?;
    runtime.vault_state = next_vault_state.clone();

    Ok(next_vault_state)
}

#[tauri::command]
pub(crate) fn select_vault(
    app: tauri::AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<VaultState, String> {
    let next_vault_state = {
        let runtime = state.lock_vaults()?;
        vaults::select_vault(&runtime.vault_state, &id)?
    };

    replace_active_vault(&app, state, next_vault_state)
}

#[tauri::command]
pub(crate) fn delete_vault(
    app: tauri::AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<VaultState, String> {
    let next_vault_state = {
        let runtime = state.lock_vaults()?;
        vaults::delete_vault(&runtime.vault_state, &id)?
    };

    replace_active_vault(&app, state, next_vault_state)
}
