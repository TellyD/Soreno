use super::agents::blocking;
use crate::agent_sessions::{transfer_incomplete, AgentSessions, TransferredComment};
use crate::kanban::{
    self, images, KanbanComment, KanbanIssue, KanbanIssueCreateInput, KanbanIssueDescriptionUpdate,
    KanbanIssueDetail, KanbanIssueInput, KanbanIssueUpdate, KanbanLabel,
};
use crate::linear::{self, LinearKanbanBoard, LinearProjectSummary, LinearWorkspace, ProjectLinks};
use tauri::{AppHandle, Manager};

pub(super) async fn project_links(app: &AppHandle) -> Result<ProjectLinks, String> {
    blocking(app.clone(), AgentSessions::linear_project_links).await
}

/// Linear cannot read local files, so local Kanban images are uploaded first, to the workspace
/// holding `owner_id`.
pub(super) async fn with_linear_images(
    app: &AppHandle,
    owner_id: &str,
    text: &str,
) -> Result<String, String> {
    let directory = app
        .state::<AgentSessions>()
        .kanban_images_directory()
        .to_owned();
    linear::images::upload_local_images(&directory, owner_id, text).await
}

// Keyring reads may wait on an OS unlock prompt; keep them off the main thread.
#[tauri::command]
pub(crate) async fn list_linear_workspaces() -> Result<Vec<LinearWorkspace>, String> {
    tauri::async_runtime::spawn_blocking(linear::workspaces)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn set_linear_api_key(api_key: String) -> Result<(), String> {
    linear::set_api_key(&api_key).await
}

#[tauri::command]
pub(crate) async fn clear_linear_api_key(workspace_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || linear::clear_api_key(&workspace_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn load_linear_board(
    app: AppHandle,
    team_id: Option<String>,
) -> Result<LinearKanbanBoard, String> {
    linear::load_board(team_id, &project_links(&app).await?).await
}

#[tauri::command]
pub(crate) async fn load_linear_issue(
    app: AppHandle,
    issue_id: String,
) -> Result<KanbanIssueDetail, String> {
    linear::load_issue(&issue_id, &project_links(&app).await?).await
}

/// Raw bytes: the webview cannot send the API key Linear's upload host requires.
#[tauri::command]
pub(crate) async fn load_linear_image(url: String) -> Result<tauri::ipc::Response, String> {
    linear::images::load_image(&url)
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) async fn create_linear_issue(
    app: AppHandle,
    mut input: KanbanIssueCreateInput,
) -> Result<KanbanIssue, String> {
    if let Some(description) = &input.description {
        input.description = Some(with_linear_images(&app, &input.team_id, description).await?);
    }
    linear::create_issue(input, &project_links(&app).await?).await
}

/// The local issue is deleted only once the Linear issue holds all its comments, so a failure
/// never loses anything.
#[tauri::command]
pub(crate) async fn transfer_kanban_issue_to_linear(
    app: AppHandle,
    issue_id: String,
    input: KanbanIssueCreateInput,
    mut comments: Vec<TransferredComment>,
    source_description: Option<String>,
) -> Result<KanbanIssue, String> {
    if input.parent_id.is_some() {
        return Err(kanban::TRANSFER_SUB_ISSUES_MESSAGE.into());
    }
    let local_id = issue_id.clone();
    blocking(app.clone(), move |state| {
        state.check_kanban_issue_transfer(&local_id)
    })
    .await?;
    let issue = create_linear_issue(app.clone(), input).await?;
    let (linear_id, identifier) = (issue.id.clone(), issue.identifier.clone());
    let incomplete = |error: String| transfer_incomplete(&identifier, &error);
    let (local_id, known) = (issue_id.clone(), comments.clone());
    // An agent summary posted or extended while Linear created the issue is not in its description.
    let late = blocking(app.clone(), move |state| {
        state.late_kanban_issue_comments(&local_id, &known)
    })
    .await
    .map_err(incomplete)?;
    if !late.is_empty() {
        let body = late
            .iter()
            .map(|comment| comment.body.as_str())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        create_linear_comment(app.clone(), linear_id.clone(), body)
            .await
            .map_err(incomplete)?;
        comments.extend(late);
    }
    let files = blocking(app.clone(), move |state| {
        state.transfer_kanban_issue_to_linear(
            &issue_id,
            &linear_id,
            &identifier,
            &comments,
            source_description.as_deref(),
        )
    })
    .await?;
    images::remove_files(
        app.state::<AgentSessions>().kanban_images_directory(),
        &files,
    );
    Ok(issue)
}

#[tauri::command]
pub(crate) async fn update_linear_issue(
    app: AppHandle,
    issue_id: String,
    patch: KanbanIssueInput,
) -> Result<KanbanIssueUpdate, String> {
    linear::update_issue(&issue_id, patch, &project_links(&app).await?).await
}

#[tauri::command]
pub(crate) async fn update_linear_issue_description(
    app: AppHandle,
    issue_id: String,
    description: String,
) -> Result<KanbanIssueDescriptionUpdate, String> {
    let description = with_linear_images(&app, &issue_id, &description).await?;
    linear::update_issue_description(&issue_id, &description).await
}

#[tauri::command]
pub(crate) async fn create_linear_comment(
    app: AppHandle,
    issue_id: String,
    body: String,
) -> Result<KanbanComment, String> {
    let body = with_linear_images(&app, &issue_id, &body).await?;
    linear::create_comment(&issue_id, &body).await
}

/// Linear deletes a comment by its id alone; the `issueId` argument the frontend sends is ignored.
#[tauri::command]
pub(crate) async fn delete_linear_comment(comment_id: String) -> Result<(), String> {
    linear::delete_comment(&comment_id).await
}

#[tauri::command]
pub(crate) async fn delete_linear_issue(app: AppHandle, issue_id: String) -> Result<(), String> {
    linear::delete_issue(&issue_id).await?;
    blocking(app, move |state| state.forget_linear_issue(&issue_id)).await
}

#[tauri::command]
pub(crate) async fn create_linear_label(
    team_id: String,
    name: String,
) -> Result<KanbanLabel, String> {
    linear::create_label(&team_id, &name).await
}

#[tauri::command]
pub(crate) async fn list_linear_projects() -> Result<Vec<LinearProjectSummary>, String> {
    linear::list_projects().await
}
