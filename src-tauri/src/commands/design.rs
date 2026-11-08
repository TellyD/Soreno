use super::agents::{blocking, notify_reply};
use crate::agent_sessions::{AgentSessionMessage, DesignBoard, DesignFrame};
use tauri::AppHandle;

#[tauri::command]
pub(crate) async fn design_boards(app: AppHandle) -> Result<Vec<DesignBoard>, String> {
    blocking(app, |state| state.design_boards()).await
}

#[tauri::command]
pub(crate) async fn design_create_board(
    app: AppHandle,
    name: String,
    project_id: Option<String>,
    executable: String,
) -> Result<DesignBoard, String> {
    blocking(app, move |state| {
        state.create_design_board(&name, project_id.as_deref(), &executable)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_rename_board(
    app: AppHandle,
    board_id: String,
    name: String,
) -> Result<DesignBoard, String> {
    blocking(app, move |state| {
        state.rename_design_board(&board_id, &name)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_delete_board(app: AppHandle, board_id: String) -> Result<(), String> {
    blocking(app, move |state| state.delete_design_board(&board_id)).await
}

#[tauri::command]
pub(crate) async fn design_frames(
    app: AppHandle,
    board_id: String,
) -> Result<Vec<DesignFrame>, String> {
    blocking(app, move |state| state.design_frames(&board_id)).await
}

#[tauri::command]
pub(crate) async fn design_update_frame(
    app: AppHandle,
    board_id: String,
    frame_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z: i64,
) -> Result<DesignFrame, String> {
    blocking(app, move |state| {
        state.update_design_frame(&board_id, &frame_id, x, y, width, height, z)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_duplicate_frame(
    app: AppHandle,
    board_id: String,
    frame_id: String,
) -> Result<DesignFrame, String> {
    blocking(app, move |state| {
        state.duplicate_design_frame(&board_id, &frame_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_delete_frame(
    app: AppHandle,
    board_id: String,
    frame_id: String,
) -> Result<DesignFrame, String> {
    blocking(app, move |state| {
        state.delete_design_frame(&board_id, &frame_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_restore_frame(
    app: AppHandle,
    frame: DesignFrame,
) -> Result<DesignFrame, String> {
    blocking(app, move |state| state.restore_design_frame(frame)).await
}

#[tauri::command]
pub(crate) async fn design_link_session(
    app: AppHandle,
    session_id: String,
    board_id: String,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.link_design_session(&session_id, &board_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn design_unlink_session(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    blocking(app, move |state| state.unlink_design_session(&session_id)).await
}

#[tauri::command]
pub(crate) async fn design_send_to_session(
    app: AppHandle,
    session_id: String,
    board_id: String,
    frame_ids: Option<Vec<String>>,
    update: bool,
) -> Result<AgentSessionMessage, String> {
    let worker_app = app.clone();
    let worker_session = session_id.clone();
    let (message, start_worker) = blocking(app, move |state| {
        state.send_design_to_session(&session_id, &board_id, frame_ids.as_deref(), update)
    })
    .await?;
    notify_reply(&worker_app, &worker_session, true, start_worker);
    Ok(message)
}
