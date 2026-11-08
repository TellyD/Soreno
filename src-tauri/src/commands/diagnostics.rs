use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::log_file;

const WEBVIEW_ERROR_LIMIT: usize = 16 * 1024;

#[tauri::command]
pub(crate) async fn log_webview_error(app: AppHandle, message: String) -> Result<(), String> {
    let path = log_file::path(&app, log_file::CRASH_LOG_FILE)?;
    let version = app.package_info().version.to_string();
    let message: String = message
        .chars()
        .filter(|character| matches!(character, '\n' | '\t') || !character.is_control())
        .take(WEBVIEW_ERROR_LIMIT)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        log_file::append(&path, &format!("webview version={version} {message}"))
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn open_log_directory(app: AppHandle) -> Result<(), String> {
    let directory = log_file::directory(&app)?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}
