use crate::codex_cli;

#[tauri::command]
pub(crate) fn get_codex_status() -> codex_cli::CodexStatus {
    codex_cli::check_cli()
}

#[tauri::command]
pub(crate) async fn check_codex_update() -> Result<codex_cli::CodexUpdateStatus, String> {
    codex_cli::check_update().await
}

#[tauri::command]
pub(crate) async fn update_codex_cli() -> Result<codex_cli::CodexStatus, String> {
    tauri::async_runtime::spawn_blocking(codex_cli::update_cli)
        .await
        .map_err(|_| "CODEX_UPDATE_FAILED: update task failed".to_string())?
}

#[tauri::command]
pub(crate) fn list_codex_models() -> Vec<codex_cli::CodexModel> {
    codex_cli::list_models()
}
