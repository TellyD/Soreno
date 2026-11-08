use crate::{
    agent_sessions::{self, AgentProject, AgentSessions},
    app_state::app_data_dir,
    project_git::{
        self, GitBranch, GitCloneRequest, GitCommitDetail, GitComparison, GitError, GitHistory,
        GitMutationResult, GitRemote, GitRepository, GitSide, GitWorktree, GitWorktreeRequest,
    },
    settings,
};
use std::time::Instant;
use tauri::{AppHandle, Manager};

pub(super) async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, GitError> + Send + 'static,
) -> Result<T, GitError> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|error| GitError::new("internal", error.to_string()))?
}

pub(super) fn load_project(app: &AppHandle, project_id: &str) -> Result<AgentProject, GitError> {
    app.state::<AgentSessions>()
        .project(project_id)
        .map_err(|message| GitError::new("project", message))
}

fn git_codex_options(
    app: &AppHandle,
) -> Result<(Option<String>, bool, settings::CommitMessageStyle), GitError> {
    app_data_dir(app)
        .and_then(|directory| settings::read_settings(&directory))
        .map(|settings| {
            (
                settings.git_codex_model().map(str::to_owned),
                settings.codex_git_fast_mode,
                settings.codex_git_commit_style,
            )
        })
        .map_err(|message| GitError::new("settings", message))
}

// The UI only shows a localized cause; the troubleshooting log keeps Git's own text.
fn log_read_error<T>(
    app: &AppHandle,
    project_id: &str,
    read: &str,
    result: Result<T, GitError>,
) -> Result<T, GitError> {
    if let Err(error) = &result {
        if agent_sessions::grid_log_enabled() {
            if let Ok(path) = super::agents::grid_log_path(app) {
                agent_sessions::append_grid_log(
                    &path,
                    "git",
                    &format!(
                        "{read} failed project={project_id} code={} message={:?}",
                        error.code, error.message
                    ),
                );
            }
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn project_git_init(
    app: AppHandle,
    project_id: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || project_git::init(&app.state::<AgentSessions>(), &project_id, &version)).await
}

#[tauri::command]
pub(crate) async fn project_git_clone(
    app: AppHandle,
    request: GitCloneRequest,
) -> Result<AgentProject, GitError> {
    blocking(move || project_git::clone(&app.state::<AgentSessions>(), request)).await
}

#[tauri::command]
pub(crate) async fn project_git_repository(
    app: AppHandle,
    project_id: String,
) -> Result<GitRepository, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        let started = Instant::now();
        let repository = log_read_error(
            &app,
            &project_id,
            "snapshot",
            project_git::repository(&project),
        )?;
        if agent_sessions::grid_log_enabled() {
            if let (Some(stats), Ok(path)) = (
                project_git::take_snapshot_stats(),
                super::agents::grid_log_path(&app),
            ) {
                agent_sessions::append_grid_log(
                    &path,
                    "git",
                    &format!(
                        "snapshot project={project_id} env={} total_ms={:.1} {stats}",
                        project.environment.kind,
                        started.elapsed().as_secs_f64() * 1_000.0
                    ),
                );
            }
        }
        Ok(repository)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_history(
    app: AppHandle,
    project_id: String,
    roots: Option<Vec<String>>,
    offset: usize,
    path: Option<String>,
) -> Result<GitHistory, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::history(&project, roots.as_deref(), offset, path.as_deref())
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_path_prefix(
    app: AppHandle,
    project_id: String,
) -> Result<Option<String>, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::path_prefix(&project)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_commit_detail(
    app: AppHandle,
    project_id: String,
    oid: String,
) -> Result<GitCommitDetail, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::commit_detail(&project, &oid)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_commit_comparison(
    app: AppHandle,
    project_id: String,
    oid: String,
    path: String,
) -> Result<GitComparison, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::commit_comparison(&project, &oid, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_branches(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<GitBranch>, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::branches(&project)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_worktrees(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<GitWorktree>, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::worktrees(&project)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_create_worktree(
    app: AppHandle,
    project_id: String,
    request: GitWorktreeRequest,
) -> Result<AgentProject, GitError> {
    blocking(move || {
        project_git::create_worktree(&app.state::<AgentSessions>(), &project_id, request)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_remove_worktree(
    app: AppHandle,
    project_id: String,
    path: String,
    expected_head: String,
    expected_branch: Option<String>,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::remove_worktree(
            &app.state::<AgentSessions>(),
            &project_id,
            path,
            expected_head,
            expected_branch,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_merge_worktree(
    app: AppHandle,
    project_id: String,
    path: String,
    expected_head: String,
    expected_branch: String,
    expected_base: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::merge_worktree(
            &app.state::<AgentSessions>(),
            &project_id,
            path,
            expected_head,
            expected_branch,
            expected_base,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_remotes(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<GitRemote>, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        project_git::remotes(&project)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_fetch(
    app: AppHandle,
    project_id: String,
    remote: String,
    expected_url: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::fetch(
            &app.state::<AgentSessions>(),
            &project_id,
            remote,
            expected_url,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_pull(
    app: AppHandle,
    project_id: String,
    remote: String,
    expected_url: String,
    version: String,
    rebase: bool,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::pull(
            &app.state::<AgentSessions>(),
            &project_id,
            remote,
            expected_url,
            &version,
            rebase,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_push(
    app: AppHandle,
    project_id: String,
    remote: String,
    branch: String,
    expected_url: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::push(
            &app.state::<AgentSessions>(),
            &project_id,
            remote,
            branch,
            expected_url,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_create_branch(
    app: AppHandle,
    project_id: String,
    name: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::create_branch(&app.state::<AgentSessions>(), &project_id, name, &version)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_remove_branch(
    app: AppHandle,
    project_id: String,
    name: String,
    expected_oid: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::remove_branch(
            &app.state::<AgentSessions>(),
            &project_id,
            name,
            &expected_oid,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_switch_branch(
    app: AppHandle,
    project_id: String,
    name: String,
    remote: bool,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::switch_branch(
            &app.state::<AgentSessions>(),
            &project_id,
            name,
            remote,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_comparison(
    app: AppHandle,
    project_id: String,
    path: String,
    side: GitSide,
    version: Option<String>,
) -> Result<GitComparison, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        log_read_error(
            &app,
            &project_id,
            "comparison",
            project_git::preview_comparison(&project, &path, side, version.as_deref()),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_stage(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::stage(&app.state::<AgentSessions>(), &project_id, paths, &version)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_resolve(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
    version: String,
    allow_markers: bool,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::resolve(
            &app.state::<AgentSessions>(),
            &project_id,
            paths,
            &version,
            allow_markers,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_unstage(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::unstage(&app.state::<AgentSessions>(), &project_id, paths, &version)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_generate_commit_message(
    app: AppHandle,
    project_id: String,
    version: String,
) -> Result<String, GitError> {
    blocking(move || {
        let project = load_project(&app, &project_id)?;
        let (model, fast_mode, style) = git_codex_options(&app)?;
        project_git::generate(&project, &version, model.as_deref(), fast_mode, style)
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_commit(
    app: AppHandle,
    project_id: String,
    message: String,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::commit(
            &app.state::<AgentSessions>(),
            &project_id,
            message,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_quick_commit(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        // Checked before staging: a missing CLI must not leave the index changed.
        if crate::codex_cli::cli_missing() {
            return Err(GitError::new("codexMissing", "Codex CLI introuvable."));
        }
        let (model, fast_mode, style) = git_codex_options(&app)?;
        project_git::quick_commit(
            &app.state::<AgentSessions>(),
            &project_id,
            paths,
            &version,
            |project, version| {
                project_git::generate(project, version, model.as_deref(), fast_mode, style)
            },
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_set_identity(
    app: AppHandle,
    project_id: String,
    name: String,
    email: String,
    global: bool,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::set_identity(
            &app.state::<AgentSessions>(),
            &project_id,
            name,
            email,
            global,
            &version,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_git_restore(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
    version: String,
) -> Result<GitMutationResult, GitError> {
    blocking(move || {
        project_git::restore(&app.state::<AgentSessions>(), &project_id, paths, &version)
    })
    .await
}
