use super::project_git::{blocking, load_project};
use crate::{
    agent_sessions::AgentSessions,
    forge::{
        self, ForgeRemote, MergeMethod, RequestAction, RequestDetail, RequestFilter, RequestHead,
        RequestSummary,
    },
    project_git::{GitCheckoutBranch, GitComparison, GitError, GitRangeChanges},
};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) async fn project_forge_remote(
    app: AppHandle,
    project_id: String,
) -> Result<ForgeRemote, GitError> {
    blocking(move || forge::remote(&load_project(&app, &project_id)?)).await
}

#[tauri::command]
pub(crate) async fn project_forge_requests(
    app: AppHandle,
    project_id: String,
    filter: RequestFilter,
    search: String,
) -> Result<Vec<RequestSummary>, GitError> {
    blocking(move || forge::requests(&load_project(&app, &project_id)?, filter, &search)).await
}

#[tauri::command]
pub(crate) async fn project_forge_request(
    app: AppHandle,
    project_id: String,
    number: u64,
) -> Result<RequestDetail, GitError> {
    blocking(move || forge::request(&load_project(&app, &project_id)?, number)).await
}

#[tauri::command]
pub(crate) async fn project_forge_changes(
    app: AppHandle,
    project_id: String,
    repository: String,
    number: u64,
    head: RequestHead,
) -> Result<GitRangeChanges, GitError> {
    blocking(move || {
        forge::changes(
            &app.state::<AgentSessions>(),
            &project_id,
            &repository,
            number,
            &head,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_forge_comparison(
    app: AppHandle,
    project_id: String,
    base: String,
    head: String,
    path: String,
) -> Result<GitComparison, GitError> {
    blocking(move || forge::comparison(&load_project(&app, &project_id)?, &base, &head, &path))
        .await
}

#[tauri::command]
pub(crate) async fn project_forge_merge(
    app: AppHandle,
    project_id: String,
    repository: String,
    number: u64,
    method: MergeMethod,
    head_oid: String,
) -> Result<(), GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        forge::merge(&project, &repository, number, method, &head_oid)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_forge_update(
    app: AppHandle,
    project_id: String,
    repository: String,
    number: u64,
    action: RequestAction,
) -> Result<(), GitError> {
    blocking(move || {
        forge::update(
            &load_project(&app, &project_id)?,
            &repository,
            number,
            action,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_forge_checkout(
    app: AppHandle,
    project_id: String,
    repository: String,
    number: u64,
    version: String,
    head: RequestHead,
) -> Result<GitCheckoutBranch, GitError> {
    blocking(move || {
        let sessions = app.state::<AgentSessions>();
        forge::checkout(&sessions, &project_id, &repository, number, &version, head)
    })
    .await
}
