use tauri::Manager;

use crate::{
    agent_sessions,
    app_state::app_data_dir,
    settings::{self, AppSettings},
};

#[tauri::command]
pub(crate) fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    settings::read_settings(&app_data_dir(&app)?)
}

#[tauri::command]
pub(crate) fn update_app_settings(
    app: tauri::AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = settings::write_settings(&app_data_dir(&app)?, settings)?;
    agent_sessions::set_grid_log_enabled(saved.terminal_log_enabled);
    Ok(saved)
}

#[tauri::command]
pub(crate) async fn reset_window_sizes(app: tauri::AppHandle) -> Result<(), String> {
    for config in &app.config().app.windows {
        if let Some(window) = app.get_webview_window(&config.label) {
            window
                .set_fullscreen(false)
                .map_err(|err| err.to_string())?;
            window.unmaximize().map_err(|err| err.to_string())?;
            window
                .set_size(tauri::LogicalSize::new(config.width, config.height))
                .map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}
