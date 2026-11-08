use tauri::{AppHandle, Manager};

use crate::desktop_attention::{self, AgentNotification, MAIN_WINDOW};

#[tauri::command]
pub(crate) async fn show_agent_notification(
    app: AppHandle,
    notification: AgentNotification,
) -> Result<(), String> {
    // macOS waits for the user's answer to the authorization prompt on first use.
    tauri::async_runtime::spawn_blocking(move || {
        let attention = match app.get_webview_window(MAIN_WINDOW) {
            Some(window) => desktop_attention::request_attention(&window),
            None => Ok(()),
        };
        desktop_attention::show_notification(&app, &notification)?;
        attention
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn set_agent_attention_badge(app: AppHandle, count: u32) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "Fenêtre principale introuvable.".to_string())?;
    desktop_attention::set_badge(&window, count)
}

#[tauri::command]
pub(crate) fn take_agent_notification_activation() -> Option<String> {
    desktop_attention::take_activation()
}
