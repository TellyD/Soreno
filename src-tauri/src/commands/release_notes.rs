use crate::{app_state::app_data_dir, release_notes};

#[tauri::command]
pub(crate) fn last_seen_version(app: tauri::AppHandle) -> Result<Option<String>, String> {
    release_notes::last_seen_version(&app_data_dir(&app)?)
}

#[tauri::command]
pub(crate) fn mark_version_seen(app: tauri::AppHandle) -> Result<(), String> {
    release_notes::mark_version_seen(
        &app_data_dir(&app)?,
        &app.package_info().version.to_string(),
    )
}
