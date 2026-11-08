use super::agents::blocking;
use crate::kanban::{
    self, images, KanbanBoard, KanbanComment, KanbanIssue, KanbanIssueCreateInput,
    KanbanIssueDescriptionUpdate, KanbanIssueDetail, KanbanIssueInput, KanbanIssueUpdate,
    KanbanLabel,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle,
};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub(crate) async fn load_kanban_board(app: AppHandle) -> Result<KanbanBoard, String> {
    blocking(app, |state| state.kanban(|db, _| kanban::load_board(db))).await
}

#[tauri::command]
pub(crate) async fn load_kanban_issue(
    app: AppHandle,
    issue_id: String,
) -> Result<KanbanIssueDetail, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::load_issue(db, &issue_id))
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_kanban_issue(
    app: AppHandle,
    input: KanbanIssueCreateInput,
) -> Result<KanbanIssue, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::create_issue(db, input))
    })
    .await
}

#[tauri::command]
pub(crate) async fn update_kanban_issue(
    app: AppHandle,
    issue_id: String,
    patch: KanbanIssueInput,
) -> Result<KanbanIssueUpdate, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::update_issue(db, &issue_id, patch))
    })
    .await
}

#[tauri::command]
pub(crate) async fn update_kanban_issue_description(
    app: AppHandle,
    issue_id: String,
    description: String,
) -> Result<KanbanIssueDescriptionUpdate, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::update_description(db, &issue_id, &description))
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_kanban_comment(
    app: AppHandle,
    issue_id: String,
    body: String,
) -> Result<KanbanComment, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::create_comment(db, &issue_id, &body))
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_kanban_comment(
    app: AppHandle,
    issue_id: String,
    comment_id: String,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::delete_comment(db, &issue_id, &comment_id))
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_kanban_issue(app: AppHandle, issue_id: String) -> Result<(), String> {
    blocking(app, move |state| {
        let files = state.delete_kanban_issue(&issue_id)?;
        images::remove_files(state.kanban_images_directory(), &files);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_kanban_label(
    app: AppHandle,
    team_id: String,
    name: String,
) -> Result<KanbanLabel, String> {
    blocking(app, move |state| {
        state.kanban(|db, _| kanban::create_label(db, &team_id, &name))
    })
    .await
}

/// The raw body is the image; its type comes from its bytes.
#[tauri::command]
pub(crate) async fn upload_kanban_image(
    app: AppHandle,
    request: Request<'_>,
) -> Result<String, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= images::MAX_IMAGE_BYTES => bytes.clone(),
        InvokeBody::Raw(_) => return Err(images::IMAGE_TOO_LARGE_MESSAGE.into()),
        _ => return Err("Binary image body required.".into()),
    };
    let path = blocking(app, move |state| {
        state.kanban(|db, directory| images::save_upload(db, directory, &bytes))
    })
    .await?;
    path.into_os_string()
        .into_string()
        .map_err(|_| "Chemin d’image non UTF-8.".into())
}

#[tauri::command]
pub(crate) async fn open_kanban_image(app: AppHandle, name: String) -> Result<(), String> {
    let opener = app.clone();
    blocking(app, move |state| {
        let path = images::image_path(state.kanban_images_directory(), &name)?;
        if !path.is_file() {
            return Err(images::IMAGE_NOT_FOUND_MESSAGE.into());
        }
        opener
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| error.to_string())
    })
    .await
}
