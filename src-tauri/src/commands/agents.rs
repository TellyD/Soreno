use crate::agent_sessions::{
    self, AgentAutomation, AgentAutomationInput, AgentEnvironment, AgentEnvironments,
    AgentGridConfig, AgentGridFrame, AgentGridScroll, AgentGridSelect, AgentProject,
    AgentProjectAppearanceChange, AgentProjectBranch, AgentProjectDirectory,
    AgentProjectGroupAppearance, AgentProjectGroupDeletion, AgentProjectGroupImport,
    AgentProjectGroupInput, AgentProjectWorktreeSnapshot, AgentServiceBranch,
    AgentServiceDirectory, AgentSession, AgentSessionMessage, AgentSessionStatus, AgentSessions,
    AgentWorkspace, ConversationHistoryPage, CreatedIssue, DesignFrameSelection, IssueRequestScan,
    IssueRequestWatcher, LinearIssueCreator, LinearIssueRequest, MessageDelivery, PromptAttachment,
    AGENT_ATTACHMENT_LIMIT,
};
use crate::kanban::{images, KanbanIssueCompletion, KanbanSource};
use crate::linear;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{path::PathBuf, thread, time::Duration};
use tauri::{
    ipc::{Channel, InvokeBody, Request},
    AppHandle, Emitter, Manager, Window,
};
use tauri_plugin_dialog::DialogExt;

const MESSAGES_EVENT: &str = "agent-session-messages";
const MESSAGE_POLL: Duration = Duration::from_secs(1);
const ISSUE_REQUESTS_EVENT: &str = "kanban-issue-request";
const DESIGN_FRAMES_EVENT: &str = "design-frames-changed";
const ISSUE_REQUEST_POLL: Duration = Duration::from_secs(2);
const GRID_LOG_FILE: &str = "terminal-grid.log";
// Mirrors ISSUE_FILENAME in src/domain/kanbanAgent.ts.
const KANBAN_ISSUE_FILENAME: &str = "issue.md";

pub(super) async fn blocking<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&AgentSessions) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(&app.state::<AgentSessions>()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn agent_workspace(app: AppHandle) -> Result<AgentWorkspace, String> {
    blocking(app, AgentSessions::workspace).await
}
#[tauri::command]
pub(crate) async fn agent_environments() -> Result<AgentEnvironments, String> {
    tauri::async_runtime::spawn_blocking(agent_sessions::environments)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn agent_ssh_scan(
    connection: crate::ssh::SshConnection,
) -> Result<Vec<crate::ssh::SshHostKey>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ssh::scan(&connection))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn agent_ssh_browse(
    connection: crate::ssh::SshConnection,
    path: Option<String>,
) -> Result<crate::ssh::SshDirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ssh::browse(&connection, path.as_deref()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn agent_ssh_forward_list(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<crate::ssh::SshPortForward>, String> {
    blocking(app, move |state| state.ssh_forward_list(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_forward_start(
    app: AppHandle,
    project_id: String,
    ports: String,
) -> Result<crate::ssh::SshPortForwardStart, String> {
    blocking(app, move |state| {
        state.ssh_forward_start(&project_id, &ports)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_ssh_forward_stop(
    app: AppHandle,
    project_id: String,
) -> Result<(), String> {
    blocking(app, move |state| state.ssh_forward_stop(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_omp_update_available(
    app: AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    blocking(app, move |state| state.omp_update_available(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_update_omp(app: AppHandle, project_id: String) -> Result<(), String> {
    blocking(app, move |state| state.update_omp(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_mobile_status(
    app: AppHandle,
    project_id: String,
) -> Result<crate::agent_sessions::SshMobileStatus, String> {
    blocking(app, move |state| state.ssh_mobile_status(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_mobile_enable(
    app: AppHandle,
    project_id: String,
) -> Result<crate::agent_sessions::SshMobileStatus, String> {
    blocking(app, move |state| state.ssh_mobile_enable(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_mobile_pair(
    app: AppHandle,
    project_id: String,
) -> Result<crate::agent_sessions::SshMobilePairing, String> {
    blocking(app, move |state| state.ssh_mobile_pair(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_mobile_revoke(
    app: AppHandle,
    project_id: String,
    device_id: String,
) -> Result<crate::agent_sessions::SshMobileStatus, String> {
    blocking(app, move |state| {
        state.ssh_mobile_revoke(&project_id, &device_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_ssh_mobile_disable(
    app: AppHandle,
    project_id: String,
) -> Result<crate::agent_sessions::SshMobileStatus, String> {
    blocking(app, move |state| state.ssh_mobile_disable(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_ssh_pick_identity(
    app: AppHandle,
    window: Window,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("Choisir une clé privée SSH")
            .blocking_pick_file()
            .map(|selected| {
                selected
                    .into_path()
                    .map_err(|_| "Le sélecteur n’a pas retourné un fichier local.".to_string())?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Le chemin de la clé SSH n’est pas Unicode.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn agent_pick_project_directory(
    app: AppHandle,
    window: Window,
    environment: AgentEnvironment,
    current_path: Option<String>,
    title: String,
) -> Result<Option<AgentProjectDirectory>, String> {
    if title.trim().is_empty() || title.len() > 256 || title.contains('\0') {
        return Err("Titre vide, trop long ou contenant un caractère nul.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let directory =
            agent_sessions::picker_default_directory(&environment, current_path.as_deref())?;
        let mut picker = app.dialog().file().set_parent(&window).set_title(title);
        if let Some(directory) = directory {
            picker = picker.set_directory(directory);
        }
        picker
            .blocking_pick_folder()
            .map(|selected| {
                selected
                    .into_path()
                    .map_err(|_| "Le sélecteur n’a pas retourné un chemin local.".to_string())
                    .and_then(|path| {
                        agent_sessions::resolve_picked_project_directory(&environment, path)
                    })
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn agent_save_project(
    app: AppHandle,
    project: AgentProject,
) -> Result<(), String> {
    blocking(app, move |state| state.save_project(project)).await
}
#[tauri::command]
pub(crate) async fn agent_update_project_appearance(
    app: AppHandle,
    project_id: String,
    appearance: AgentProjectAppearanceChange,
) -> Result<AgentProject, String> {
    blocking(app, move |state| {
        state.update_project_appearance(&project_id, appearance)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    blocking(app, move |state| state.delete_project(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_save_project_group(
    app: AppHandle,
    group: AgentProjectGroupInput,
) -> Result<(), String> {
    blocking(app, move |state| state.save_group(group)).await
}
#[tauri::command]
pub(crate) async fn agent_import_project_groups(
    app: AppHandle,
    groups: Vec<AgentProjectGroupInput>,
) -> Result<AgentProjectGroupImport, String> {
    blocking(app, move |state| state.import_groups(groups)).await
}
#[tauri::command]
pub(crate) async fn agent_update_project_group_appearance(
    app: AppHandle,
    group_id: String,
    appearance: AgentProjectAppearanceChange,
) -> Result<AgentProjectGroupAppearance, String> {
    blocking(app, move |state| {
        state.update_group_appearance(&group_id, appearance)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_prepare_group_project(
    app: AppHandle,
    group_id: String,
) -> Result<AgentProject, String> {
    blocking(app, move |state| state.prepare_group_project(&group_id)).await
}
#[tauri::command]
pub(crate) async fn agent_delete_project_group(
    app: AppHandle,
    group_id: String,
    delete_projects: bool,
) -> Result<AgentProjectGroupDeletion, String> {
    blocking(app, move |state| {
        state.delete_group(&group_id, delete_projects)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_set_project_connected(
    app: AppHandle,
    project_id: String,
    connected: bool,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.set_project_connected(&project_id, connected)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_link_session_kanban_issue(
    app: AppHandle,
    session_id: String,
    issue_id: String,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.link_session_kanban_issue(&session_id, &issue_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_link_session_linear_issue(
    app: AppHandle,
    session_id: String,
    issue_id: String,
    issue_identifier: String,
    issue_title: String,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.link_session_linear_issue(&session_id, &issue_id, &issue_identifier, &issue_title)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_unlink_session_issue(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    blocking(app, move |state| state.unlink_session_issue(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_set_project_linear_link(
    app: AppHandle,
    project_id: String,
    linear_project_id: Option<String>,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.set_project_linear_link(&project_id, linear_project_id.as_deref())
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_set_session_closed(
    app: AppHandle,
    session_id: String,
    closed: bool,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.set_session_closed(&session_id, closed)
    })
    .await
}
/// Serializes Linear summary completions so concurrent ones never read the same stored comment id.
static LINEAR_SUMMARY_LOCK: tauri::async_runtime::Mutex<()> =
    tauri::async_runtime::Mutex::const_new(());
/// Routes by the session's link. A Linear summary is claimed before posting: a failed Linear call
/// is reported, never retried into a duplicate comment.
#[tauri::command]
pub(crate) async fn agent_complete_kanban_issue(
    app: AppHandle,
    session_id: String,
    summary_id: String,
    summary: String,
) -> Result<Option<KanbanIssueCompletion>, String> {
    let linked = blocking(app.clone(), {
        let session_id = session_id.clone();
        move |state| state.session_linear_issue(&session_id)
    })
    .await?;
    if linked.is_none() {
        return blocking(app, move |state| {
            state.complete_kanban_issue(&session_id, &summary_id, &summary)
        })
        .await;
    }
    let _guard = LINEAR_SUMMARY_LOCK.lock().await;
    let claimed = blocking(app.clone(), {
        let session_id = session_id.clone();
        move |state| state.claim_linear_issue_summary(&session_id, &summary_id)
    })
    .await?;
    let Some(claim) = claimed else {
        return Ok(None);
    };
    let (comment, created) =
        linear::post_issue_summary(&claim.issue_id, claim.comment_id.as_deref(), &summary).await?;
    let mut update = None;
    if created {
        let comment_id = comment.id.clone();
        let issue_id = claim.issue_id.clone();
        // Recorded before the state move: a failed move must not orphan the posted comment.
        if let Err(error) = blocking(app.clone(), move |state| {
            state.record_linear_issue_summary_comment(&session_id, &issue_id, &comment_id)
        })
        .await
        {
            eprintln!("Résumé Linear : {error}");
        }
        let links = super::linear::project_links(&app).await?;
        update = linear::move_issue_to_review(&claim.issue_id, &links).await?;
    }
    Ok(Some(KanbanIssueCompletion { comment, update }))
}
#[tauri::command]
pub(crate) async fn agent_save_session(
    app: AppHandle,
    session: AgentSession,
) -> Result<(), String> {
    blocking(app, move |state| state.save_session(session)).await
}
#[tauri::command]
pub(crate) async fn agent_delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    blocking(app, move |state| state.delete_session(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_automations(app: AppHandle) -> Result<Vec<AgentAutomation>, String> {
    blocking(app, AgentSessions::automations).await
}
#[tauri::command]
pub(crate) async fn agent_save_automation(
    app: AppHandle,
    automation: AgentAutomationInput,
) -> Result<AgentAutomation, String> {
    blocking(app, move |state| state.save_automation(automation)).await
}
#[tauri::command]
pub(crate) async fn agent_delete_automation(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    blocking(app, move |state| state.delete_automation(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_run_automation(
    app: AppHandle,
    session_id: String,
) -> Result<AgentAutomation, String> {
    blocking(app, move |state| state.run_automation(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_refresh_automations(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AgentAutomation>, String> {
    blocking(app, move |state| state.refresh_automations(&project_id)).await
}
#[tauri::command]
pub(crate) async fn agent_mark_automation_seen(
    app: AppHandle,
    session_id: String,
) -> Result<AgentAutomation, String> {
    blocking(app, move |state| state.mark_automation_seen(&session_id)).await
}
#[tauri::command]
// Each argument is one IPC key the frontend sends.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn agent_start(
    app: AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
    initial_prompt: Option<String>,
    issue_image_names: Vec<String>,
    issue_file: Option<String>,
    mut issue_image_urls: Vec<String>,
    mut issue_image_targets: Vec<String>,
    design_frames: Option<DesignFrameSelection>,
) -> Result<(), String> {
    let local_images = issue_image_names.len().min(images::MAX_PROMPT_IMAGES);
    issue_image_urls.truncate(images::MAX_PROMPT_IMAGES - local_images);
    issue_image_targets.truncate(images::MAX_PROMPT_IMAGES);
    let linear_images = linear::images::download_prompt_images(&issue_image_urls).await;
    let watcher_app = app.clone();
    let (watcher, start_worker) = blocking(app, move |state| {
        let mut attachments = kanban_prompt_attachments(
            state.kanban_images_directory(),
            &issue_image_names,
            linear_images,
        );
        if let Some(issue) = issue_file {
            attachments.push(PromptAttachment {
                filename: KANBAN_ISSUE_FILENAME.into(),
                bytes: issue.into_bytes(),
            });
        }
        if let Some(selection) = &design_frames {
            attachments.extend(state.design_prompt_attachments(selection)?);
        }
        match initial_prompt.as_deref() {
            Some(prompt) if !attachments.is_empty() => {
                state.start_with_attachments(&session_id, cols, rows, prompt, &attachments)
            }
            prompt => state.start(&session_id, cols, rows, prompt),
        }?;
        Ok((
            state.issue_request_watcher(&session_id)?.map(|watcher| {
                let mut watcher = watcher.with_image_targets(issue_image_targets);
                state.sync_design_mirror(&mut watcher);
                watcher
            }),
            state
                .release_start_messages(&session_id)?
                .then_some(session_id),
        ))
    })
    .await?;
    if let Some(session_id) = start_worker {
        let _ = watcher_app.emit(MESSAGES_EVENT, &session_id);
        let worker_app = watcher_app.clone();
        thread::spawn(move || deliver_messages(worker_app, session_id));
    }
    if let Some(watcher) = watcher {
        thread::spawn(move || watch_issue_requests(watcher_app, watcher));
    }
    Ok(())
}
/// Creates or edits the Kanban issues, or stores the design frames, this run's agent requests
/// until the run ends.
fn watch_issue_requests(app: AppHandle, mut watcher: IssueRequestWatcher) {
    let state = app.state::<AgentSessions>();
    loop {
        thread::sleep(ISSUE_REQUEST_POLL);
        let request = match state.scan_issue_request(&mut watcher) {
            Ok(IssueRequestScan::Request(request)) => request,
            Ok(IssueRequestScan::Idle) => continue,
            Ok(IssueRequestScan::Stopped) => return,
            Err(error) => {
                eprintln!("Demandes d’issues Kanban : {error}");
                return;
            }
        };
        if request.is_design() {
            match state.handle_design_frame(&mut watcher, request) {
                Ok(Some(outcome)) => {
                    notify_reply(
                        &app,
                        &outcome.session_id,
                        outcome.queued,
                        outcome.start_worker,
                    );
                    if let Some(board_id) = outcome.board_id {
                        let _ = app.emit(
                            DESIGN_FRAMES_EVENT,
                            serde_json::json!({ "boardId": board_id }),
                        );
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("Cadre Design : {error}"),
            }
            continue;
        }
        // shortcut: a local request also waits on this keychain read, which may prompt on macOS; resolve it only for Linear requests if that delay is reported.
        let linear_request = |request| linear_issue_request(&app, request);
        let linear = linear::has_api_key()
            .map(|has_key| has_key.then_some(&linear_request as LinearIssueCreator));
        let outcome = match state.handle_issue_request(&mut watcher, request, linear) {
            Ok(Some(outcome)) => outcome,
            // Another watcher of the same directory handles it.
            Ok(None) => continue,
            Err(error) => {
                eprintln!("Demande d’issue Kanban : {error}");
                continue;
            }
        };
        notify_reply(
            &app,
            &outcome.event.session_id,
            outcome.queued,
            outcome.start_worker,
        );
        let _ = app.emit(ISSUE_REQUESTS_EVENT, &outcome.event);
    }
}
pub(super) fn notify_reply(app: &AppHandle, session_id: &str, queued: bool, start_worker: bool) {
    if queued {
        let _ = app.emit(MESSAGES_EVENT, session_id);
    }
    if start_worker {
        let worker_app = app.clone();
        let worker_session = session_id.to_owned();
        thread::spawn(move || deliver_messages(worker_app, worker_session));
    }
}
/// Blocks the watcher thread: requests of one session are handled in order anyway.
fn linear_issue_request(
    app: &AppHandle,
    request: LinearIssueRequest,
) -> Result<CreatedIssue, String> {
    match request {
        LinearIssueRequest::Create {
            linked_issue_id,
            linear_project_id,
            title,
            description,
        } => tauri::async_runtime::block_on(linear::create_requested_issue(
            linked_issue_id.as_deref(),
            linear_project_id.as_deref(),
            &title,
            description.as_deref(),
        ))
        .map(|issue| CreatedIssue {
            id: issue.id,
            identifier: issue.identifier,
            source: KanbanSource::Linear,
        }),
        LinearIssueRequest::Update {
            issue,
            title,
            description,
        } => tauri::async_runtime::block_on(async {
            // shortcut: after a mid-session transfer to Linear, a kept `image-N` still names the deleted local file, so the edit is refused (nothing lost); map targets to the transferred uploads if users hit it.
            let description = match description {
                Some(description) => {
                    Some(super::linear::with_linear_images(app, &issue.id, &description).await?)
                }
                None => None,
            };
            linear::update_requested_issue(&issue.id, title.as_deref(), description.as_deref())
                .await
        })
        .map(|()| issue),
    }
}
/// `image-N` matches the placeholder the prompt gives the N-th Kanban image (local ones, then
/// Linear ones); failed ones are left out without shifting the others.
fn kanban_prompt_attachments(
    directory: &std::path::Path,
    names: &[String],
    linear_images: Vec<Result<(&'static str, Vec<u8>), String>>,
) -> Vec<PromptAttachment> {
    let local = names
        .iter()
        .map(|name| images::read_prompt_image(directory, name));
    let linear = linear_images
        .into_iter()
        .map(|image| image.map(|(extension, bytes)| (extension.to_owned(), bytes)));
    local
        .chain(linear)
        .take(images::MAX_PROMPT_IMAGES)
        .enumerate()
        .filter_map(|(index, image)| match image {
            Ok((extension, bytes)) => Some(PromptAttachment {
                filename: format!("image-{}.{extension}", index + 1),
                bytes,
            }),
            Err(error) => {
                eprintln!("Image Kanban {} ignorée : {error}", index + 1);
                None
            }
        })
        .collect()
}
#[tauri::command]
pub(crate) async fn agent_stop(app: AppHandle, session_id: String) -> Result<(), String> {
    blocking(app, move |state| state.stop(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_conversation_subscribe(
    app: AppHandle,
    session_id: String,
    on_record: Channel<String>,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.conversation_subscribe(&session_id, on_record)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_conversation_send(
    app: AppHandle,
    session_id: String,
    record: serde_json::Value,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.conversation_send(&session_id, &record)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_conversation_history(
    app: AppHandle,
    session_id: String,
    offset: usize,
    limit: usize,
) -> Result<ConversationHistoryPage, String> {
    blocking(app, move |state| {
        state.conversation_history(&session_id, offset, limit)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_statuses(app: AppHandle) -> Result<Vec<AgentSessionStatus>, String> {
    blocking(app, AgentSessions::statuses).await
}
#[tauri::command]
pub(crate) async fn agent_branches(app: AppHandle) -> Result<Vec<AgentProjectBranch>, String> {
    blocking(app, AgentSessions::branches).await
}
#[tauri::command]
pub(crate) async fn agent_service_branches(
    app: AppHandle,
    project_id: String,
    services: Vec<AgentServiceDirectory>,
) -> Result<Vec<AgentServiceBranch>, String> {
    blocking(app, move |state| {
        state.service_branches(&project_id, services)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_worktrees(
    app: AppHandle,
) -> Result<AgentProjectWorktreeSnapshot, String> {
    blocking(app, AgentSessions::worktree_groups).await
}
#[tauri::command]
pub(crate) async fn agent_grid_subscribe(
    app: AppHandle,
    session_id: String,
    config: AgentGridConfig,
    visible: bool,
    on_frame: Channel<AgentGridFrame>,
) -> Result<(), String> {
    let log = grid_log_path(&app).ok();
    blocking(app, move |state| {
        state.grid_subscribe(&session_id, config, visible, on_frame, log)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_ack(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
    apply_micros: u64,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_ack(&session_id, channel_id, apply_micros)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_unsubscribe(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_unsubscribe(&session_id, channel_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_configure(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
    config: AgentGridConfig,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_configure(&session_id, channel_id, config)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_scroll(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
    scroll: AgentGridScroll,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_scroll(&session_id, channel_id, scroll)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_select(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
    select: AgentGridSelect,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_select(&session_id, channel_id, select)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_visibility(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
    visible: bool,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.grid_visibility(&session_id, channel_id, visible)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_grid_text(
    app: AppHandle,
    session_id: String,
    channel_id: u32,
) -> Result<String, String> {
    blocking(app, move |state| state.grid_text(&session_id, channel_id)).await
}
#[tauri::command]
pub(crate) fn agent_grid_log_path(app: AppHandle) -> Result<String, String> {
    grid_log_path(&app).map(|path| path.to_string_lossy().into_owned())
}
/// Appends one webview measurement line to the grid diagnostics log.
#[tauri::command]
pub(crate) async fn agent_grid_diagnostic(
    app: AppHandle,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let path = grid_log_path(&app)?;
    let message: String = message
        .chars()
        .filter(|character| !character.is_control())
        .take(2000)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        agent_sessions::append_grid_log(&path, &session_id, &format!("webview {message}"))
    })
    .await
    .map_err(|error| error.to_string())
}
pub(crate) fn grid_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::log_file::path(app, GRID_LOG_FILE)
}
#[tauri::command]
pub(crate) async fn agent_write(
    app: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    blocking(app, move |state| state.write(&session_id, &data)).await
}
#[tauri::command]
pub(crate) async fn agent_session_messages(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<AgentSessionMessage>, String> {
    blocking(app, move |state| state.session_messages(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_send_message(
    app: AppHandle,
    session_id: String,
    message_id: String,
    body: String,
) -> Result<AgentSessionMessage, String> {
    let worker_app = app.clone();
    let worker_session = session_id.clone();
    let (message, start_worker) = blocking(app, move |state| {
        state.send_message(&session_id, &message_id, &body)
    })
    .await?;
    let _ = worker_app.emit(MESSAGES_EVENT, &worker_session);
    if start_worker {
        thread::spawn(move || deliver_messages(worker_app, worker_session));
    }
    Ok(message)
}
/// One worker per session with queued messages; it stops once none remain queued.
fn deliver_messages(app: AppHandle, session_id: String) {
    let state = app.state::<AgentSessions>();
    loop {
        let delivery = state.deliver_messages(&session_id).or_else(|error| {
            state
                .abandon_message_delivery(&session_id, &error)
                .map(|()| MessageDelivery::Finished { changed: true })
        });
        let (changed, finished) = match delivery {
            Ok(MessageDelivery::Waiting) => (false, false),
            Ok(MessageDelivery::Changed) => (true, false),
            Ok(MessageDelivery::Finished { changed }) => (changed, true),
            Err(error) => {
                eprintln!("Livraison des messages de {session_id} : {error}");
                return;
            }
        };
        if changed {
            let _ = app.emit(MESSAGES_EVENT, &session_id);
        }
        if finished {
            return;
        }
        thread::sleep(MESSAGE_POLL);
    }
}
#[tauri::command]
pub(crate) async fn agent_upload_clipboard_image(
    app: AppHandle,
    session_id: String,
    mime_type: String,
    data_base64: String,
) -> Result<String, String> {
    blocking(app, move |state| {
        state.upload_clipboard_image(&session_id, &mime_type, &data_base64)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_attach_command(
    app: AppHandle,
    session_id: String,
) -> Result<String, String> {
    blocking(app, move |state| state.attach_command(&session_id)).await
}
#[tauri::command]
pub(crate) async fn agent_set_remote_label(
    app: AppHandle,
    session_id: String,
    label: String,
) -> Result<(), String> {
    blocking(app, move |state| {
        state.set_remote_label(&session_id, &label)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_attach_file(
    app: AppHandle,
    request: Request<'_>,
) -> Result<String, String> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .ok_or_else(|| format!("En-tête {name} manquant."))?
            .to_str()
            .map(str::to_owned)
            .map_err(|_| format!("En-tête {name} invalide."))
    };
    let session_id = header("x-soreno-session-id")?;
    let filename = String::from_utf8(
        STANDARD
            .decode(header("x-soreno-file-name")?)
            .map_err(|_| "Nom de pièce jointe non base64.".to_string())?,
    )
    .map_err(|_| "Nom de pièce jointe non UTF-8.".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= AGENT_ATTACHMENT_LIMIT => bytes.clone(),
        InvokeBody::Raw(_) => return Err("Pièce jointe locale limitée à 32 Mio.".into()),
        _ => return Err("Corps de pièce jointe binaire requis.".into()),
    };
    blocking(app, move |state| {
        state.attach_file(&session_id, &filename, &bytes)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_resize(
    app: AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    blocking(app, move |state| state.resize(&session_id, cols, rows)).await
}
