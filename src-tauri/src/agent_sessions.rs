//! Local, explicitly started terminals. Metadata survives app exit; processes do not.
mod appearance;
#[cfg(test)]
use appearance::{PNG_DATA_URL_PREFIX, PROJECT_ICON_DATA_URL_LIMIT};
mod automations;
pub(crate) use automations::{AgentAutomation, AgentAutomationInput, HAS_AUTOMATION};
mod attachments;
mod closed_sessions;
mod codex_overrides;
#[cfg(windows)]
mod conpty;
mod conversation;
mod conversations;
mod design;
pub use design::{DesignBoard, DesignBoardSession, DesignFrame, DesignFrameSelection};
mod dtach_history;
mod environment;
pub(crate) mod grid;
mod grid_log;
pub(crate) use grid_log::{
    append as append_grid_log, enabled as grid_log_enabled, set_enabled as set_grid_log_enabled,
};
mod groups;
mod issue_requests;
mod kanban_issue_sessions;
mod keyframes;
mod linear_links;
mod messages;
mod omp_update;
mod output;
mod program_status;
mod remote_dtach;
mod remote_host;
mod remote_mobile;
pub(crate) use remote_mobile::{SshMobilePairing, SshMobileStatus};
mod validation;
pub(crate) use validation::validate_project;
use validation::{validate_initial_prompt, validate_launch_args, validate_session};
mod worktrees;
use attachments::{
    agent_local_path, attach_file_in, attach_file_to, attachment_directory, attachment_filename,
    attachment_root, cleanup_attachment_directory, clipboard_image_extension,
    create_unique_attachment_directory, prompt_with_attachments,
    reset_session_attachment_directory, validate_prompt_attachments, write_prompt_attachments,
    RemoteClipboard,
};
#[cfg(test)]
use attachments::{
    attachment_upload_script, powershell_literal, remote_clipboard_directory,
    terminal_attachment_path, uploaded_attachment_path, windows_attachment_filename,
    write_local_attachment,
};
pub use environment::environments;
#[cfg(test)]
use environment::filtered_wslenv;
#[cfg(windows)]
pub(crate) use environment::probe_output;
#[cfg(any(windows, test))]
pub(crate) use environment::{host_wslenv, wsl_root_script};
#[cfg(any(windows, test))]
use environment::{migrate_local_wsl_unc_projects, normalize_wsl_unc_environment};
#[cfg(test)]
use environment::{parse_wsl, parse_wsl_path_output, posix_directory_name, wsl_picker_directory};
pub(crate) use environment::{
    picker_default_directory, project_filesystem_directory, resolve_picked_project_directory,
    validate_environment, validate_project_directory,
};
#[cfg(windows)]
use environment::{require_wsl_distribution, resolve_wsl_host_path};
use environment::{validate_linux_path, validate_local_directory};
pub use grid::{AgentGridConfig, AgentGridFrame, AgentGridScroll, AgentGridSelect};
pub use groups::{
    AgentProjectGroup, AgentProjectGroupAppearance, AgentProjectGroupDeletion,
    AgentProjectGroupImport, AgentProjectGroupInput,
};
pub use issue_requests::{
    CreatedIssue, IssueRequestScan, IssueRequestWatcher, LinearIssueCreator, LinearIssueRequest,
};
pub(crate) use kanban_issue_sessions::{transfer_incomplete, SessionEnd, TransferredComment};
pub use kanban_issue_sessions::{AgentIssueSummary, AgentSessionKanbanIssue};
pub use linear_links::AgentProjectLinearLink;
pub use messages::{AgentSessionMessage, MessageDelivery};
use output::{Output, OutputPipeline};
#[cfg(test)]
use worktrees::{assemble_worktree_group, DiscoveredWorktreeGroup, DiscoveredWorktreeMember};
pub(crate) use worktrees::{same_agent_environment, same_worktree_path, WorktreeDiscoveryFailure};

use crate::ssh::SshConnection;
use base64::{engine::general_purpose::STANDARD, Engine};
pub use conversation::ConversationHistoryPage;
pub use conversations::AgentConversation;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use remote_host::RemoteHost;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(all(windows, test))]
use std::collections::VecDeque;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime},
};
type Result<T> = std::result::Result<T, String>;
/// Twice dtach's 1 MiB replay, so a reattached history survives the redraw that follows it.
const BUFFER_LIMIT: usize = 2 * 1024 * 1024;
/// A Pi/OMP full redraw repaints the whole transcript (about 2 MB after a few hours): the
/// buffer keeps the latest one and what follows so a new grid engine starts from a full screen.
const KEYFRAME_LIMIT: usize = 32 * 1024 * 1024;
/// A TUI must read the grown size before the restore, as dtach's FORCE_REDRAW does.
const REPAINT_SETTLE: Duration = Duration::from_millis(300);
const REMOTE_CLIPBOARD_IMAGE_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) const AGENT_ATTACHMENT_LIMIT: usize = 32 * 1024 * 1024;
const NORMALIZE_DISCONNECTED_SSH_GROUPS_MIGRATION: &str = "normalize_disconnected_ssh_groups_v1";

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "État des agents indisponible (verrou empoisonné).".into())
}
fn text(value: &str, label: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!(
            "{label} vide, trop long ou contenant un caractère nul."
        ));
    }
    Ok(())
}
fn id(value: &str) -> Result<()> {
    text(value, "Identifiant", 128)
}
fn validate_reconnected_project_directory(
    environment: &AgentEnvironment,
    path: &str,
    wait_ready: impl FnOnce(&SshConnection) -> Result<()>,
    validate_directory: impl FnOnce(&AgentEnvironment, &str) -> Result<Option<String>>,
) -> Result<Option<String>> {
    wait_ready(environment.ssh.as_ref().ok_or("Connexion SSH manquante.")?)?;
    validate_directory(environment, path)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEnvironment {
    pub kind: String,
    pub distribution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConnection>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectDirectory {
    pub path: String,
    pub suggested_name: Option<String>,
    pub environment: AgentEnvironment,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub environment: AgentEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
/// Field absent keeps the stored value, `null` clears it, a string sets it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProjectAppearanceChange {
    #[serde(default, deserialize_with = "deserialize_some")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub icon_data_url: Option<Option<String>>,
}
impl AgentProjectAppearanceChange {
    fn apply(
        self,
        icon: &mut Option<String>,
        color: &mut Option<String>,
        icon_data_url: &mut Option<String>,
    ) {
        if let Some(value) = self.icon {
            *icon = value;
        }
        if let Some(value) = self.color {
            *color = value;
        }
        if let Some(value) = self.icon_data_url {
            *icon_data_url = value;
        }
    }
}
fn deserialize_some<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectBranch {
    pub project_id: String,
    pub branch: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentServiceDirectory {
    pub service_id: String,
    pub cwd: String,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentServiceBranch {
    pub service_id: String,
    pub branch: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub project_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectWorktreeGroup {
    pub repository_project_id: String,
    pub project_ids: Vec<String>,
    pub worktrees: Vec<AgentProjectWorktree>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectWorktreeSnapshot {
    pub groups: Vec<AgentProjectWorktreeGroup>,
    pub complete: bool,
    pub missing_project_ids: Vec<String>,
}
fn default_session_kind() -> String {
    "terminal".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSession {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// Manual name; when set, it takes precedence over names reported by the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    #[serde(default = "default_session_kind")]
    pub kind: String,
    #[serde(default)]
    pub service_id: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    /// Empty with no arguments selects the default interactive shell.
    pub executable: String,
    pub args: Vec<String>,
    pub created_at: String,
    /// A favorite survives its tab being closed, to be reopened later.
    #[serde(default)]
    pub favorite: bool,
    /// Hidden agent of a design board; immutable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub design: bool,
}
impl AgentSession {
    pub(crate) fn display_name(&self) -> &str {
        self.custom_name.as_deref().unwrap_or(&self.name)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStatus {
    pub session_id: String,
    pub state: String,
    pub exit_code: Option<u32>,
    pub working: Option<bool>,
    /// Running and waiting for a user reply (permission prompt or question).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub awaiting: bool,
    pub conversation: Option<AgentConversation>,
    pub resume: String,
    pub conversation_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_summary: Option<AgentIssueSummary>,
    /// Preview of the final assistant message of the last finished turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing_executable: bool,
    /// Claude Code or Codex too old to report its activity through OSC 7501.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outdated_cli: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub projects: Vec<AgentProject>,
    pub sessions: Vec<AgentSession>,
    pub statuses: Vec<AgentSessionStatus>,
    /// Projects without automatic SSH access, dormant ones included.
    pub disconnected_project_ids: Vec<String>,
    /// Not reached since launch; starting a session or connecting them reaches the server.
    pub dormant_project_ids: Vec<String>,
    pub groups: Vec<AgentProjectGroup>,
    pub kanban_issue_sessions: Vec<AgentSessionKanbanIssue>,
    pub design_board_sessions: Vec<DesignBoardSession>,
    pub linear_project_links: Vec<AgentProjectLinearLink>,
    /// Kept without a tab, until reopened.
    pub closed_session_ids: Vec<String>,
    /// Sessions an automation runs in; closing their tab keeps them.
    pub automation_session_ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnvironments {
    pub local_label: String,
    pub distributions: Vec<String>,
    pub wsl_error: Option<String>,
}
/// A file written before launch; the initial prompt names its directory.
pub struct PromptAttachment {
    pub filename: String,
    pub bytes: Vec<u8>,
}
/// Removes a local staging directory unless a constructed runtime takes it over.
struct StagedAttachmentDirectory(Option<PathBuf>);
impl Drop for StagedAttachmentDirectory {
    fn drop(&mut self) {
        if let Some(directory) = self.0.take() {
            let _ = cleanup_attachment_directory(&directory);
        }
    }
}
struct Runtime {
    output: Mutex<Output>,
    grid: Mutex<Option<grid::GridHandle>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    size: Mutex<PtySize>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    remote_clipboard: Option<RemoteClipboard>,
    local_attachment_directory: Mutex<Option<PathBuf>>,
    remote_sidecar_generation: Option<Arc<Mutex<u64>>>,
    #[cfg(windows)]
    wsl: Option<WslRun>,
    #[cfg(windows)]
    process_handle: usize,
    #[cfg(unix)]
    run_token: String,
}
impl Runtime {
    fn replace_remote_clipboard_connection(&self, connection: SshConnection) -> Result<()> {
        if !lock(&self.output)?.exited {
            return Err("Arrêtez la session active avant cette opération.".into());
        }
        if let Some(remote_clipboard) = &self.remote_clipboard {
            remote_clipboard.replace_connection(connection)?;
        }
        Ok(())
    }
    /// Node TUIs repaint only on a real size change: grow by a row, then restore.
    fn repaint(self: Arc<Self>) {
        thread::spawn(move || {
            let _ = (|| -> Result<()> {
                let size = lock(&self.size)?;
                {
                    let master = lock(&self.master)?;
                    master
                        .as_ref()
                        .ok_or("Session arrêtée.")?
                        .resize(PtySize {
                            rows: size.rows.saturating_add(1),
                            ..*size
                        })
                        .map_err(|error| error.to_string())?;
                }
                thread::sleep(REPAINT_SETTLE);
                let master = lock(&self.master)?;
                master
                    .as_ref()
                    .ok_or("Session arrêtée.")?
                    .resize(*size)
                    .map_err(|error| error.to_string())
            })();
        });
    }
    /// The size lock is held throughout, so resizes queue their offsets in order; the grid
    /// barrier is queued before the master can emit bytes drawn for the new size.
    fn resize(&self, size: PtySize) -> Result<()> {
        let mut current = lock(&self.size)?;
        lock(&self.output)?.resize_grid(size.cols, size.rows);
        *current = size;
        if let Some(master) = lock(&self.master)?.as_ref() {
            master.resize(size).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn stop(&self) -> Result<()> {
        // Serialize signaling with wait/reaping: never signal a recycled process id.
        let _killer = lock(&self.killer)?;
        #[cfg(windows)]
        let result = {
            let wsl_result = self.wsl.as_ref().map(WslRun::stop).unwrap_or(Ok(()));
            let process_result = if lock(&self.output)?.exited {
                Ok(())
            } else {
                kill_windows_process(self.process_handle)
            };
            wsl_result.and(process_result)
        };
        #[cfg(unix)]
        let result = stop_unix_run(&self.run_token);
        // Do not wait on a writer blocked by a full PTY. Its worker releases the
        // handle after process termination; unrelated sessions stay responsive.
        if let Ok(mut writer) = self.writer.try_lock() {
            writer.take();
        }
        lock(&self.master)?.take();
        let remote_cleanup = self
            .remote_clipboard
            .as_ref()
            .map(RemoteClipboard::close)
            .unwrap_or(Ok(()));
        let local_cleanup = lock(&self.local_attachment_directory)?
            .take()
            .as_deref()
            .map(cleanup_attachment_directory)
            .unwrap_or(Ok(()));
        result.and(remote_cleanup).and(local_cleanup)
    }
}
#[cfg(windows)]
fn kill_windows_process(handle: usize) -> Result<()> {
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess};
    // portable-pty 0.9's WinChildKiller inverts TerminateProcess's return code.
    // This handle stays owned by Child; the killer lock prevents Child from
    // being reaped/dropped during this call. Closing ConPTY terminates clients.
    let handle = handle as windows_sys::Win32::Foundation::HANDLE;
    if unsafe { TerminateProcess(handle, 1) } != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    let mut code = 259; // STILL_ACTIVE
    if unsafe { GetExitCodeProcess(handle, &mut code) } != 0 && code != 259 {
        Ok(())
    } else {
        Err(format!(
            "Impossible d’arrêter le processus Windows : {error}"
        ))
    }
}
#[cfg(unix)]
fn unix_processes(processes: sysinfo::ProcessesToUpdate<'_>) -> sysinfo::System {
    // A fresh snapshot prevents cached environments/start times from authorizing
    // a signal to a recycled PID. No Linux-only process inspection here.
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        processes,
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .without_tasks()
            .with_environ(sysinfo::UpdateKind::Always),
    );
    system
}
#[cfg(unix)]
fn unix_run_member(process: &sysinfo::Process, token: &std::ffi::OsStr) -> bool {
    process.status() != sysinfo::ProcessStatus::Zombie
        && process.environ().iter().any(|entry| entry == token)
}
/// Marks every process of one run for the Unix stop sweep.
fn run_token(db: &Connection) -> Result<String> {
    crate::sqlite::random_id(db).map_err(|e| e.to_string())
}
#[cfg(unix)]
fn stop_unix_run(run_token: &str) -> Result<()> {
    use std::time::{Duration, Instant};
    use sysinfo::{Pid, ProcessesToUpdate};
    let token = std::ffi::OsString::from(format!("SORENO_AGENT_RUN={run_token}"));
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut empty_scans = 0;
    // Descendants may detach/reparent or fork during a scan. Retry, but never
    // block shutdown indefinitely. Processes deliberately clearing the inherited
    // token (or hiding their environment via privileges) are outside this contract.
    for _ in 0..40 {
        let system = unix_processes(ProcessesToUpdate::All);
        if system.process(Pid::from_u32(std::process::id())).is_none() {
            return Err("Impossible d’inspecter les processus Unix pour arrêter l’agent.".into());
        }
        let members: Vec<_> = system
            .processes()
            .values()
            .filter(|process| unix_run_member(process, &token))
            .map(|process| (process.pid(), process.start_time()))
            .collect();
        empty_scans = if members.is_empty() {
            empty_scans + 1
        } else {
            0
        };
        if empty_scans == 2 {
            return Ok(());
        }
        let mut errors = Vec::new();
        for (pid, start_time) in members {
            // Re-read BOTH token and birth time immediately before each signal.
            // Runtime's killer lock additionally protects the unreaped PTY leader.
            let verified = unix_processes(ProcessesToUpdate::Some(&[pid]));
            if let Some(process) = verified.process(pid) {
                if process.start_time() == start_time
                    && unix_run_member(process, &token)
                    && !process.kill()
                {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        errors.push(format!("{pid} : {error}"));
                    }
                }
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "Impossible d’arrêter les processus de l’agent : {}",
                errors.join(", ")
            ));
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(
        "Délai de nettoyage Unix dépassé : des processus de l’agent subsistent. Réessayez l’arrêt."
            .into(),
    )
}
struct Store {
    db: Connection,
    links_dir: PathBuf,
    attachment_instance_directory: PathBuf,
    runtimes: HashMap<String, Arc<Runtime>>,
    omp_conversations: HashMap<String, Arc<conversation::ConversationProcess>>,
    // Conversations launching outside the store lock: they count as running until published.
    starting_conversations: HashSet<String>,
    session_operations: HashMap<String, Arc<Mutex<()>>>,
    closing: bool,
    git_busy: bool,
    // Projects whose sessions the current Git lease stopped; only these refuse to start.
    git_stopped_projects: HashSet<String>,
    message_workers: HashSet<String>,
    message_deliveries: HashMap<String, Instant>,
    // Sessions whose queued messages a start failed; their worker reports the change.
    messages_failed_at_start: HashSet<String>,
    // Connections not reached since launch: any SSH access starts a stopped Ona environment.
    dormant_ssh: HashSet<SshConnection>,
}
pub struct AgentSessions {
    store: Mutex<Store>,
    connection_changes: Mutex<()>,
    kanban_images_directory: PathBuf,
    /// Orders design mirror writes: each reads the stored HTML under it, so the latest wins.
    design_mirror: Mutex<()>,
}
pub(crate) struct GitOperationLease<'a> {
    owner: &'a AgentSessions,
    pub project: AgentProject,
}
pub(crate) struct NewProjectGitOperationLease<'a> {
    owner: &'a AgentSessions,
    project_id: String,
}
/// Proof that every session of these projects was stopped under the current Git lease.
pub(crate) struct StoppedProjects {
    project_ids: Vec<String>,
}
impl Drop for GitOperationLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut store) = self.owner.store.lock() {
            store.git_busy = false;
            store.git_stopped_projects.clear();
        }
    }
}
impl Drop for NewProjectGitOperationLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut store) = self.owner.store.lock() {
            store.git_busy = false;
        }
    }
}
struct StartingConversation<'a> {
    owner: &'a AgentSessions,
    session_id: &'a str,
}
impl Drop for StartingConversation<'_> {
    fn drop(&mut self) {
        if let Ok(mut store) = self.owner.store.lock() {
            store.starting_conversations.remove(self.session_id);
        }
    }
}
impl GitOperationLease<'_> {
    /// Runs before an irreversible Git mutation: sessions cannot start again while the lease is held.
    pub(crate) fn stop_project_sessions(&self, project_ids: &[String]) -> Result<StoppedProjects> {
        let _connection_change = lock(&self.owner.connection_changes)?;
        let mut store = lock(&self.owner.store)?;
        if !store.git_busy {
            return Err("La réservation Git du projet a expiré.".into());
        }
        stop_project_sessions_locked(&store, project_ids)?;
        store
            .git_stopped_projects
            .extend(project_ids.iter().cloned());
        Ok(StoppedProjects {
            project_ids: project_ids.to_vec(),
        })
    }
    pub(crate) fn delete_projects(
        self,
        stopped: StoppedProjects,
        end: SessionEnd<'_>,
    ) -> Result<()> {
        let _connection_change = lock(&self.owner.connection_changes)?;
        let mut store = lock(&self.owner.store)?;
        if !store.git_busy {
            return Err("La réservation Git du projet a expiré.".into());
        }
        let (blocked, unblocked, orphaned) =
            remove_stopped_projects_locked(&mut store, &stopped.project_ids, end)?;
        drop(store);
        apply_connection_changes(blocked, unblocked, orphaned);
        Ok(())
    }
}
impl NewProjectGitOperationLease<'_> {
    pub(crate) fn insert_project(self, project: AgentProject) -> Result<()> {
        if project.id != self.project_id {
            return Err("L’identifiant du projet ne correspond pas à la réservation Git.".into());
        }
        let project = normalize_project(project)?;
        validate_project(&project)?;
        let mut store = lock(&self.owner.store)?;
        if !store.git_busy {
            return Err("La réservation Git du projet a expiré.".into());
        }
        capacity(&store.db, "agent_projects", 128)?;
        validate_project_directory(&project.environment, &project.path)?;
        store
            .db
            .execute(
                "INSERT INTO agent_projects(id,data) VALUES (?1,?2)",
                params![
                    project.id,
                    serde_json::to_string(&project).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        wake_environment(&mut store, &project.environment);
        Ok(())
    }
}
fn delete_projects_locked(
    store: &mut Store,
    project_ids: &[String],
    end: SessionEnd<'_>,
) -> Result<(Vec<SshConnection>, Vec<SshConnection>, Vec<SshConnection>)> {
    stop_project_sessions_locked(store, project_ids)?;
    remove_stopped_projects_locked(store, project_ids, end)
}
fn require_projects(store: &Store, project_ids: &[String]) -> Result<Vec<AgentProject>> {
    project_ids
        .iter()
        .map(|project_id| {
            id(project_id)?;
            require_project(store, project_id)
        })
        .collect()
}
fn project_sessions(store: &Store, project_ids: &[String]) -> Result<Vec<AgentSession>> {
    Ok(list::<AgentSession>(&store.db, "agent_sessions")?
        .into_iter()
        .filter(|session| project_ids.contains(&session.project_id))
        .collect())
}
fn stop_project_sessions_locked(store: &Store, project_ids: &[String]) -> Result<()> {
    let projects = require_projects(store, project_ids)?;
    let sessions = project_sessions(store, project_ids)?;
    automations::ensure_none(
        &store.db,
        &sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
    )?;
    for session in &sessions {
        ensure_stopped(store, &session.id)?;
    }
    let mut remote_sessions: HashMap<SshConnection, Vec<&str>> = HashMap::new();
    for project in &projects {
        if let Some(connection) = connected_ssh(store, project)? {
            remote_sessions.entry(connection).or_default().extend(
                sessions
                    .iter()
                    .filter(|session| session.project_id == project.id)
                    .map(|session| session.id.as_str()),
            );
        }
    }
    for (connection, session_ids) in &remote_sessions {
        stop_remote_sessions_before_delete(connection, session_ids)?;
    }
    Ok(())
}
fn remove_stopped_projects_locked(
    store: &mut Store,
    project_ids: &[String],
    end: SessionEnd<'_>,
) -> Result<(Vec<SshConnection>, Vec<SshConnection>, Vec<SshConnection>)> {
    let connections_before = referenced_ssh_connections(&store.db)?;
    let projects = require_projects(store, project_ids)?;
    let blocked_before = blocked_ssh_connections(&store.db)?;
    let sessions = project_sessions(store, project_ids)?;
    for session in &sessions {
        ensure_stopped(store, &session.id)?;
    }
    let session_ids = sessions
        .iter()
        .map(|session| session.id.as_str())
        .collect::<Vec<_>>();
    let launch_directories =
        conversations::session_launch_directories(&store.db, &store.links_dir, &session_ids);
    let mut remote_launch_directories: HashMap<SshConnection, Vec<String>> = HashMap::new();
    for project in &projects {
        if let Some(connection) = connected_ssh(store, project)? {
            let project_session_ids = sessions
                .iter()
                .filter(|session| session.project_id == project.id)
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>();
            remote_launch_directories
                .entry(connection)
                .or_default()
                .extend(conversations::session_remote_names(
                    &store.db,
                    &project_session_ids,
                ));
        }
    }
    let tx = store.db.transaction().map_err(|error| error.to_string())?;
    kanban_issue_sessions::end_issue_sessions(&tx, &sessions, end)?;
    for project_id in project_ids {
        tx.execute(
            "DELETE FROM agent_sessions WHERE project_id=?1",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM agent_projects WHERE id=?1", [project_id])
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    conversations::remove_launch_directories(&launch_directories);
    for (connection, names) in &remote_launch_directories {
        conversations::remove_remote_launch_directories(connection, names);
    }
    for session in sessions {
        store.runtimes.remove(&session.id);
        store.omp_conversations.remove(&session.id);
        store.session_operations.remove(&session.id);
    }
    let blocked_after = blocked_ssh_connections(&store.db)?;
    let connections_after = referenced_ssh_connections(&store.db)?;
    Ok((
        blocked_after.difference(&blocked_before).cloned().collect(),
        blocked_before.difference(&blocked_after).cloned().collect(),
        connections_before
            .difference(&connections_after)
            .cloned()
            .collect(),
    ))
}
pub(crate) fn same_ssh_target(left: &SshConnection, right: &SshConnection) -> bool {
    left.host == right.host && left.user == right.user && left.port == right.port
}

fn apply_connection_changes(
    blocked: Vec<SshConnection>,
    unblocked: Vec<SshConnection>,
    orphaned: Vec<SshConnection>,
) {
    for connection in blocked {
        crate::ssh::block(&connection);
        crate::ssh::close(&connection);
    }
    for connection in unblocked {
        crate::ssh::unblock(&connection);
    }
    for connection in orphaned {
        crate::ssh::close(&connection);
    }
}
impl AgentSessions {
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        let links_dir = app_data_dir.join("agent-session-links");
        Self::from_connection_at(
            Connection::open(app_data_dir.join("agents.sqlite")).map_err(|e| e.to_string())?,
            links_dir,
            crate::kanban::images::directory(app_data_dir),
        )
    }
    #[cfg(test)]
    fn from_connection(db: Connection) -> Result<Self> {
        Self::from_connection_at(
            db,
            std::env::temp_dir().join("soreno-agent-session-test-links"),
            std::env::temp_dir().join("soreno-agent-session-test-kanban-images"),
        )
    }
    fn from_connection_at(
        mut db: Connection,
        links_dir: PathBuf,
        kanban_images_directory: PathBuf,
    ) -> Result<Self> {
        db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS agent_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_project_groups (id TEXT PRIMARY KEY, group_project_id TEXT UNIQUE REFERENCES agent_projects(id) ON DELETE SET NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_project_group_members (group_id TEXT NOT NULL REFERENCES agent_project_groups(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES agent_projects(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY (group_id, project_id));
            CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES agent_projects(id), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_disconnected_projects (project_id TEXT PRIMARY KEY REFERENCES agent_projects(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS agent_schema_migrations (name TEXT PRIMARY KEY);")
            .map_err(|e| e.to_string())?;
        conversations::initialize(&db)?;
        conversation::initialize(&db)?;
        messages::initialize(&db)?;
        closed_sessions::initialize(&db)?;
        automations::initialize(&db)?;
        design::initialize(&db)?;
        crate::kanban::initialize(&mut db)?;
        crate::kanban::images::purge_abandoned_uploads(&mut db, &kanban_images_directory)?;
        remove_chat_sessions(&mut db)?;
        #[cfg(windows)]
        migrate_local_wsl_unc_projects(&mut db)?;
        normalize_disconnected_ssh_groups(&mut db)?;
        for connection in blocked_ssh_connections(&db)? {
            crate::ssh::block(&connection);
        }
        let dormant_ssh = dormant_ssh_connections(&db)?;
        purge_launch_directories(&db, &links_dir);
        let attachment_root = attachment_root(&links_dir);
        std::fs::create_dir_all(&attachment_root).map_err(|error| error.to_string())?;
        // ponytail: crash leftovers stay isolated; add owner locks before scavenging them.
        let attachment_instance_directory =
            create_unique_attachment_directory(&attachment_root, "instance")?;
        Ok(Self {
            store: Mutex::new(Store {
                db,
                links_dir,
                attachment_instance_directory,
                runtimes: HashMap::new(),
                omp_conversations: HashMap::new(),
                starting_conversations: HashSet::new(),
                session_operations: HashMap::new(),
                closing: false,
                git_busy: false,
                git_stopped_projects: HashSet::new(),
                message_workers: HashSet::new(),
                message_deliveries: HashMap::new(),
                messages_failed_at_start: HashSet::new(),
                dormant_ssh,
            }),
            connection_changes: Mutex::new(()),
            kanban_images_directory,
            design_mirror: Mutex::new(()),
        })
    }
    pub(crate) fn usage_environments(&self) -> Result<Vec<AgentEnvironment>> {
        let store = lock(&self.store)?;
        let projects: Vec<AgentProject> = list(&store.db, "agent_projects")?;
        let disconnected: HashSet<String> =
            disconnected_project_ids(&store.db)?.into_iter().collect();
        let mut environments: Vec<AgentEnvironment> = Vec::new();
        for project in projects {
            let environment = project.environment;
            if environment.kind == "local"
                || disconnected.contains(&project.id)
                || environment_dormant(&store, &environment)
                || environment.ssh.as_ref().is_some_and(crate::ssh::is_blocked)
                || environments
                    .iter()
                    .any(|known| same_agent_environment(known, &environment))
            {
                continue;
            }
            environments.push(environment);
        }
        Ok(environments)
    }
    pub fn workspace(&self) -> Result<AgentWorkspace> {
        let store = lock(&self.store)?;
        let projects: Vec<AgentProject> = list(&store.db, "agent_projects")?;
        let sessions: Vec<AgentSession> = list(&store.db, "agent_sessions")?;
        let disconnected_project_ids = disconnected_project_ids(&store.db)?;
        let dormant_project_ids = projects
            .iter()
            .filter(|project| {
                !disconnected_project_ids.contains(&project.id)
                    && environment_dormant(&store, &project.environment)
            })
            .map(|project| project.id.clone())
            .collect::<Vec<_>>();
        let statuses = sessions
            .iter()
            .map(|session| {
                let disconnected = disconnected_project_ids.contains(&session.project_id);
                session_status(&store, session, disconnected)
            })
            .collect::<Result<_>>()?;
        Ok(AgentWorkspace {
            projects,
            sessions,
            statuses,
            disconnected_project_ids: disconnected_project_ids
                .into_iter()
                .chain(dormant_project_ids.iter().cloned())
                .collect(),
            dormant_project_ids,
            groups: groups::list_groups(&store.db)?,
            kanban_issue_sessions: kanban_issue_sessions::list_issue_sessions(&store.db)?,
            design_board_sessions: design::list_board_sessions(&store.db)?,
            linear_project_links: linear_links::list_links(&store.db)?,
            closed_session_ids: closed_sessions::closed_session_ids(&store.db)?,
            automation_session_ids: list::<AgentAutomation>(&store.db, "agent_automations")?
                .into_iter()
                .map(|automation| automation.input.session_id)
                .collect(),
        })
    }
    /// Runs `action` in one transaction of the agents database, committed only when it succeeds.
    pub(crate) fn kanban<T>(
        &self,
        action: impl FnOnce(&Connection, &Path) -> Result<T>,
    ) -> Result<T> {
        let mut store = lock(&self.store)?;
        let tx = store.db.transaction().map_err(|error| error.to_string())?;
        let value = action(&tx, &self.kanban_images_directory)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(value)
    }
    pub(crate) fn kanban_images_directory(&self) -> &Path {
        &self.kanban_images_directory
    }
    pub fn statuses(&self) -> Result<Vec<AgentSessionStatus>> {
        Ok(self.workspace()?.statuses)
    }
    pub fn project(&self, project_id: &str) -> Result<AgentProject> {
        id(project_id)?;
        let project = {
            let store = lock(&self.store)?;
            require_project_connected(&store, project_id)?
        };
        validate_project(&project)?;
        Ok(project)
    }
    fn with_project_ssh_connection<T>(
        &self,
        project_id: &str,
        operation: impl FnOnce(&SshConnection) -> Result<T>,
    ) -> Result<T> {
        let _connection_change = lock(&self.connection_changes)?;
        let project = self.project(project_id)?;
        if project.environment.kind != "ssh" {
            return Err("Cette action est réservée aux projets SSH.".into());
        }
        operation(
            project
                .environment
                .ssh
                .as_ref()
                .ok_or("Connexion SSH manquante.")?,
        )
    }
    pub(crate) fn ssh_forward_list(
        &self,
        project_id: &str,
    ) -> Result<Vec<crate::ssh::SshPortForward>> {
        self.with_project_ssh_connection(project_id, crate::ssh::forward_list)
    }
    pub(crate) fn ssh_forward_start(
        &self,
        project_id: &str,
        ports: &str,
    ) -> Result<crate::ssh::SshPortForwardStart> {
        self.with_project_ssh_connection(project_id, |connection| {
            crate::ssh::forward_start(connection, ports)
        })
    }
    pub(crate) fn ssh_forward_stop(&self, project_id: &str) -> Result<()> {
        self.with_project_ssh_connection(project_id, |connection| {
            crate::ssh::forward_stop(connection);
            Ok(())
        })
    }
    pub(crate) fn omp_update_available(&self, project_id: &str) -> Result<Option<String>> {
        omp_update::available(&self.project(project_id)?)
    }
    pub(crate) fn update_omp(&self, project_id: &str) -> Result<()> {
        omp_update::install(&self.project(project_id)?)
    }
    pub(crate) fn ssh_mobile_status(&self, project_id: &str) -> Result<SshMobileStatus> {
        self.with_project_ssh_connection(project_id, remote_mobile::status)
    }
    pub(crate) fn ssh_mobile_enable(&self, project_id: &str) -> Result<SshMobileStatus> {
        self.with_project_ssh_connection(project_id, remote_mobile::enable)
    }
    pub(crate) fn ssh_mobile_pair(&self, project_id: &str) -> Result<SshMobilePairing> {
        self.with_project_ssh_connection(project_id, remote_mobile::pair)
    }
    pub(crate) fn ssh_mobile_revoke(
        &self,
        project_id: &str,
        device_id: &str,
    ) -> Result<SshMobileStatus> {
        self.with_project_ssh_connection(project_id, |connection| {
            remote_mobile::revoke(connection, device_id)
        })
    }
    pub(crate) fn ssh_mobile_disable(&self, project_id: &str) -> Result<SshMobileStatus> {
        self.with_project_ssh_connection(project_id, remote_mobile::disable)
    }
    pub(crate) fn begin_git_operation(&self, project_id: &str) -> Result<GitOperationLease<'_>> {
        id(project_id)?;
        let mut store = lock(&self.store)?;
        if store.closing {
            return Err("L’application est en cours de fermeture.".into());
        }
        if store.git_busy {
            return Err("Une opération Git est déjà en cours.".into());
        }
        let project = require_project_connected(&store, project_id)?;
        validate_project(&project)?;
        store.git_busy = true;
        Ok(GitOperationLease {
            owner: self,
            project,
        })
    }
    pub(crate) fn begin_git_operation_for_new_project(
        &self,
        project_id: &str,
    ) -> Result<NewProjectGitOperationLease<'_>> {
        self.reserve_new_git_project(project_id, None)
            .map(|(lease, _)| lease)
    }
    pub(crate) fn begin_git_operation_for_new_project_from(
        &self,
        project_id: &str,
        source_project_id: &str,
    ) -> Result<(NewProjectGitOperationLease<'_>, AgentProject)> {
        let (lease, source) = self.reserve_new_git_project(project_id, Some(source_project_id))?;
        Ok((lease, source.expect("source requested")))
    }
    fn reserve_new_git_project(
        &self,
        project_id: &str,
        source_project_id: Option<&str>,
    ) -> Result<(NewProjectGitOperationLease<'_>, Option<AgentProject>)> {
        id(project_id)?;
        if let Some(source_project_id) = source_project_id {
            id(source_project_id)?;
        }
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        if store.closing {
            return Err("L’application est en cours de fermeture.".into());
        }
        if store.git_busy {
            return Err("Une opération Git est déjà en cours.".into());
        }
        if get::<AgentProject>(&store.db, "agent_projects", project_id)?.is_some() {
            return Err("Un projet avec cet identifiant existe déjà.".into());
        }
        let source = source_project_id
            .map(|id| require_project_connected(&store, id))
            .transpose()?;
        if let Some(source) = &source {
            validate_project(source)?;
        }
        store.git_busy = true;
        Ok((
            NewProjectGitOperationLease {
                owner: self,
                project_id: project_id.into(),
            },
            source,
        ))
    }
    pub fn update_project_appearance(
        &self,
        project_id: &str,
        appearance: AgentProjectAppearanceChange,
    ) -> Result<AgentProject> {
        id(project_id)?;
        let store = lock(&self.store)?;
        let mut project = require_project(&store, project_id)?;
        if groups::group_project_ids(&store.db)?.contains(&project.id) {
            return Err("Ce projet est géré par son groupe.".into());
        }
        appearance.apply(
            &mut project.icon,
            &mut project.color,
            &mut project.icon_data_url,
        );
        validate_project(&project)?;
        store.db.execute("INSERT INTO agent_projects(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![project.id, serde_json::to_string(&project).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(project)
    }
    pub fn save_project(&self, project: AgentProject) -> Result<()> {
        let project = normalize_project(project)?;
        validate_project(&project)?;
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        if store.git_busy {
            return Err("Une opération Git est en cours.".into());
        }
        let blocked_before = blocked_ssh_connections(&store.db)?;
        let connections_before = referenced_ssh_connections(&store.db)?;
        let previous: Option<AgentProject> = get(&store.db, "agent_projects", &project.id)?;
        if groups::group_project_ids(&store.db)?.contains(&project.id) {
            return Err("Ce projet est géré par son groupe.".into());
        }
        if let Some(previous) = &previous {
            if !same_agent_environment(&previous.environment, &project.environment)
                && groups::group_of_project_member(&store.db, &project.id)?.is_some()
            {
                return Err("Retirez d'abord ce projet du groupe pour changer sa machine.".into());
            }
        }
        let disconnected = previous.is_some() && project_disconnected(&store.db, &project.id)?;
        let was_dormant = previous
            .as_ref()
            .is_some_and(|previous| environment_dormant(&store, &previous.environment));
        let target_changed = previous
            .as_ref()
            .is_none_or(|previous| !same_project_target(previous, &project));
        if let Some(previous) = &previous {
            let sessions: Vec<AgentSession> = list(&store.db, "agent_sessions")?;
            let sessions = sessions
                .iter()
                .filter(|session| session.project_id == project.id)
                .collect::<Vec<_>>();
            if !sessions.is_empty() && target_changed {
                return Err("Supprimez les sessions avant de changer le dossier, le serveur, l’utilisateur ou le port du projet.".into());
            }
            if !sessions.is_empty() && previous.environment != project.environment {
                for session in sessions {
                    if let (Some(runtime), Some(connection)) = (
                        store.runtimes.get(&session.id),
                        project.environment.ssh.as_ref(),
                    ) {
                        runtime.replace_remote_clipboard_connection(connection.clone())?;
                    }
                    ensure_stopped(&store, &session.id)?;
                }
            }
        } else {
            capacity(&store.db, "agent_projects", 128)?;
        }
        let reconnect_locally = disconnected && project.environment.kind != "ssh";
        let validated = target_changed && !(disconnected && project.environment.kind == "ssh");
        if validated {
            validate_project_directory(&project.environment, &project.path)?;
        }
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO agent_projects(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![project.id, serde_json::to_string(&project).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        if reconnect_locally {
            tx.execute(
                "DELETE FROM agent_disconnected_projects WHERE project_id=?1",
                [&project.id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if validated {
            wake_environment(&mut store, &project.environment);
        } else if was_dormant {
            // Only a connection already reachable before the save keeps its state.
            if let Some(connection) = project.environment.ssh.as_ref().filter(|connection| {
                !connections_before.contains(*connection) || blocked_before.contains(*connection)
            }) {
                store.dormant_ssh.insert(connection.clone());
            }
        }
        let blocked_after = blocked_ssh_connections(&store.db)?;
        let connections_after = referenced_ssh_connections(&store.db)?;
        let blocked = blocked_after.difference(&blocked_before).cloned().collect();
        let unblocked = blocked_before.difference(&blocked_after).cloned().collect();
        let orphaned = connections_before
            .difference(&connections_after)
            .cloned()
            .collect();
        drop(store);
        apply_connection_changes(blocked, unblocked, orphaned);
        Ok(())
    }
    pub fn set_project_connected(&self, project_id: &str, connected: bool) -> Result<()> {
        self.set_project_connected_using(
            project_id,
            connected,
            |environment, path| {
                validate_reconnected_project_directory(
                    environment,
                    path,
                    crate::ssh::wait_ready,
                    validate_project_directory,
                )
            },
            remote_host::stop,
        )
    }
    #[cfg(test)]
    fn set_project_connected_with(
        &self,
        project_id: &str,
        connected: bool,
        validate_directory: impl FnOnce(&AgentEnvironment, &str) -> Result<Option<String>>,
    ) -> Result<()> {
        self.set_project_connected_using(project_id, connected, validate_directory, |_, _| Ok(()))
    }
    fn set_project_connected_using(
        &self,
        project_id: &str,
        connected: bool,
        validate_directory: impl FnOnce(&AgentEnvironment, &str) -> Result<Option<String>>,
        stop_remote_sessions: impl FnOnce(&SshConnection, &[&str]) -> Result<()>,
    ) -> Result<()> {
        id(project_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        let project = require_project(&store, project_id)?;
        validate_project(&project)?;
        if project.environment.kind != "ssh" {
            return Err("Seuls les projets SSH peuvent être déconnectés.".into());
        }
        if store.closing {
            return Err("L’application est en cours de fermeture.".into());
        }
        if store.git_busy {
            return Err("Une opération Git est en cours.".into());
        }
        let connection = project
            .environment
            .ssh
            .as_ref()
            .ok_or("Connexion SSH manquante.")?
            .clone();
        let project_ids = list::<AgentProject>(&store.db, "agent_projects")?
            .into_iter()
            .filter(|candidate| {
                candidate.environment.kind == "ssh"
                    && candidate.environment.ssh.as_ref() == Some(&connection)
            })
            .map(|candidate| candidate.id)
            .collect::<HashSet<_>>();
        if connected {
            let was_disconnected = project_disconnected(&store.db, project_id)?;
            let connection_was_blocked =
                was_disconnected && blocked_ssh_connections(&store.db)?.contains(&connection);
            if connection_was_blocked {
                crate::ssh::unblock(&connection);
            }
            drop(store);
            if let Err(error) = validate_directory(&project.environment, &project.path) {
                if connection_was_blocked {
                    crate::ssh::block(&connection);
                    crate::ssh::close(&connection);
                }
                return Err(error);
            }
            let mut store = match lock(&self.store) {
                Ok(store) => store,
                Err(error) => {
                    if connection_was_blocked {
                        crate::ssh::block(&connection);
                        crate::ssh::close(&connection);
                    }
                    return Err(error);
                }
            };
            if store.closing {
                if connection_was_blocked {
                    crate::ssh::block(&connection);
                    crate::ssh::close(&connection);
                }
                return Err("L’application est en cours de fermeture.".into());
            }
            let update = (|| {
                let tx = store.db.transaction().map_err(|error| error.to_string())?;
                for project_id in &project_ids {
                    tx.execute(
                        "DELETE FROM agent_disconnected_projects WHERE project_id=?1",
                        [project_id],
                    )
                    .map_err(|error| error.to_string())?;
                }
                tx.commit().map_err(|error| error.to_string())
            })();
            if let Err(error) = update {
                if connection_was_blocked {
                    crate::ssh::block(&connection);
                    crate::ssh::close(&connection);
                }
                return Err(error);
            }
            store.dormant_ssh.remove(&connection);
            return Ok(());
        }

        // A blocked relay cannot reach the server; its sessions were stopped at disconnection.
        let was_disconnected = project_disconnected(&store.db, project_id)?;
        let sessions: Vec<AgentSession> = list::<AgentSession>(&store.db, "agent_sessions")?
            .into_iter()
            .filter(|session| project_ids.contains(&session.project_id))
            .collect();
        let group_session_ids = sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        for project_id in &project_ids {
            tx.execute(
                "INSERT OR IGNORE INTO agent_disconnected_projects(project_id) VALUES (?1)",
                [project_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        store.dormant_ssh.remove(&connection);
        let runtimes = sessions
            .iter()
            .filter_map(|session| {
                store
                    .runtimes
                    .get(&session.id)
                    .cloned()
                    .map(|runtime| (session.id.clone(), runtime))
            })
            .collect::<Vec<_>>();
        let conversations = sessions
            .iter()
            .filter_map(|session| {
                store
                    .omp_conversations
                    .get(&session.id)
                    .cloned()
                    .map(|omp| (session.id.clone(), omp))
            })
            .collect::<Vec<_>>();
        drop(store);

        let mut errors = Vec::new();
        // A conversation holds the connection open against `ssh::block` until it exits; it goes
        // first, as a run under dtach ended before its client would report a crash.
        thread::scope(|scope| {
            let stops = conversations
                .iter()
                .map(|(session_id, omp)| (session_id, scope.spawn(move || omp.stop())))
                .collect::<Vec<_>>();
            for (session_id, stop) in stops {
                if let Err(error) = stop
                    .join()
                    .unwrap_or_else(|_| Err("arrêt interrompu".into()))
                {
                    errors.push(format!("conversation {session_id} : {error}"));
                }
            }
        });
        if !was_disconnected {
            if let Err(error) = stop_remote_sessions(
                &connection,
                &group_session_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            ) {
                errors.push(format!("sessions distantes : {error}"));
            }
        }
        for (session_id, runtime) in &runtimes {
            if let Err(error) = runtime.stop() {
                errors.push(format!("session {session_id} : {error}"));
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        for (session_id, runtime) in runtimes {
            loop {
                let exited = match lock(&runtime.output) {
                    Ok(output) => output.exited,
                    Err(error) => {
                        errors.push(format!("session {session_id} : {error}"));
                        break;
                    }
                };
                if exited {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    errors.push(format!("session {session_id} : délai d’arrêt dépassé"));
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        crate::ssh::block(&connection);
        crate::ssh::close(&connection);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Projet déconnecté, mais certaines opérations d’arrêt ont échoué : {}",
                errors.join("; ")
            ))
        }
    }
    pub fn save_session(&self, session: AgentSession) -> Result<()> {
        validate_session(&session)?;
        let mut store = lock(&self.store)?;
        let project = require_project(&store, &session.project_id)?;
        let previous: Option<AgentSession> = get(&store.db, "agent_sessions", &session.id)?;
        if let Some(previous) = &previous {
            if previous.project_id != session.project_id
                || previous.created_at != session.created_at
                || previous.design != session.design
            {
                return Err("L’identité d’une session existante ne peut pas être modifiée.".into());
            }
            // Renaming metadata must not interrupt a live process. Launch changes still require a stop.
            if previous.executable != session.executable
                || previous.args != session.args
                || previous.kind != session.kind
                || previous.service_id != session.service_id
                || previous.working_directory != session.working_directory
            {
                ensure_stopped(&store, &session.id)?;
                if let Some(connection) = connected_ssh(&store, &project)? {
                    let root = if previous.kind == conversation::KIND {
                        remote_host::CONVERSATIONS
                    } else {
                        remote_host::TERMINALS
                    };
                    if remote_host::probe(&connection, root, &session.id)? == RemoteHost::Live {
                        return Err("Cette session tourne encore sur le serveur SSH. Ouvrez-la puis arrêtez-la avant de modifier son lancement.".into());
                    }
                }
            }
        } else {
            capacity(&store.db, "agent_sessions", 512)?;
        }
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO agent_sessions(id,project_id,data) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![session.id, session.project_id, serde_json::to_string(&session).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        conversations::session_saved(&tx, previous.as_ref(), &session)?;
        let kind_changed = previous
            .as_ref()
            .is_some_and(|previous| previous.kind != session.kind);
        if kind_changed && session.kind != conversation::KIND {
            conversation::forget(&tx, &session.id)?;
        }
        closed_sessions::reopen_unkept_sessions(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        if kind_changed {
            if session.kind == conversation::KIND {
                store.runtimes.remove(&session.id);
            } else {
                store.omp_conversations.remove(&session.id);
            }
        }
        Ok(())
    }
    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        id(session_id)?;
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        ensure_stopped(&store, session_id)?;
        automations::ensure_none(&store.db, &[session_id])?;
        let project = require_project(&store, &session.project_id)?;
        let connection = connected_ssh(&store, &project)?;
        if let Some(connection) = &connection {
            stop_remote_sessions_before_delete(connection, &[session_id])?;
        }
        let launch_directories =
            conversations::session_launch_directories(&store.db, &store.links_dir, &[session_id]);
        let remote_launch_directories = connection.map(|connection| {
            (
                connection,
                conversations::session_remote_names(&store.db, &[session_id]),
            )
        });
        let tx = store.db.transaction().map_err(|e| e.to_string())?;
        kanban_issue_sessions::end_issue_sessions(
            &tx,
            std::slice::from_ref(&session),
            SessionEnd::Session,
        )?;
        tx.execute("DELETE FROM agent_sessions WHERE id=?1", [session_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        conversations::remove_launch_directories(&launch_directories);
        if let Some((connection, names)) = &remote_launch_directories {
            conversations::remove_remote_launch_directories(connection, names);
        }
        store.runtimes.remove(session_id);
        store.omp_conversations.remove(session_id);
        store.session_operations.remove(session_id);
        store.message_deliveries.remove(session_id);
        Ok(())
    }
    pub fn delete_project(&self, project_id: &str) -> Result<()> {
        let _connection_change = lock(&self.connection_changes)?;
        let mut store = lock(&self.store)?;
        if store.git_busy {
            return Err("Une opération Git est en cours.".into());
        }
        if groups::group_project_ids(&store.db)?.contains(project_id) {
            return Err("Supprimez le groupe pour supprimer ce projet.".into());
        }
        let (blocked, unblocked, orphaned) =
            delete_projects_locked(&mut store, &[project_id.to_owned()], SessionEnd::Project)?;
        drop(store);
        apply_connection_changes(blocked, unblocked, orphaned);
        Ok(())
    }
    pub fn start(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        initial_prompt: Option<&str>,
    ) -> Result<()> {
        self.start_using(
            session_id,
            cols,
            rows,
            initial_prompt,
            &[],
            remote_host::prepare,
        )
    }
    pub fn start_with_attachments(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        initial_prompt: &str,
        attachments: &[PromptAttachment],
    ) -> Result<()> {
        self.start_using(
            session_id,
            cols,
            rows,
            Some(initial_prompt),
            attachments,
            remote_host::prepare,
        )
    }
    #[cfg(test)]
    fn start_with(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        initial_prompt: Option<&str>,
        prepare_remote: impl FnOnce(
            &str,
            Option<&SshConnection>,
            &str,
        ) -> Result<(Option<RemoteHost>, Option<String>)>,
    ) -> Result<()> {
        self.start_using(session_id, cols, rows, initial_prompt, &[], prepare_remote)
    }
    fn start_using(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        initial_prompt: Option<&str>,
        attachments: &[PromptAttachment],
        prepare_remote: impl FnOnce(
            &str,
            Option<&SshConnection>,
            &str,
        ) -> Result<(Option<RemoteHost>, Option<String>)>,
    ) -> Result<()> {
        id(session_id)?;
        let size = size(cols, rows)?;
        let initial_prompt = initial_prompt.filter(|prompt| !prompt.trim().is_empty());
        if !attachments.is_empty() && initial_prompt.is_none() {
            return Err("Les pièces jointes accompagnent un prompt initial.".into());
        }
        let operation = self.session_operation(session_id)?;
        let _operation = lock(&operation)?;
        let connection_change = lock(&self.connection_changes)?;
        let (kind, ssh, grouped) = {
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            let project = require_project(&store, &session.project_id)?;
            let grouped = groups::group_by_group_project(&store.db, &project.id)?.is_some();
            (session.kind, project.environment.kind == "ssh", grouped)
        };
        // Only SSH relays and group folders need launches ordered with project changes.
        let _connection_change = (ssh || grouped).then_some(connection_change);
        if kind == conversation::KIND {
            return self.start_conversation(session_id, initial_prompt, attachments);
        }
        let (prepared_project, prepared_session, local_attachment_directory) = {
            let mut store = lock(&self.store)?;
            if store.closing {
                return Err("L’application est en cours de fermeture.".into());
            }
            let session = require_session(&store, session_id)?;
            if store.git_stopped_projects.contains(&session.project_id) {
                return Err("[Git/busy] Une opération Git est en cours sur ce projet.".into());
            }
            wake_project(&mut store, &session.project_id)?;
            let project = require_project_connected(&store, &session.project_id)?;
            validate_project(&project)?;
            ensure_stopped(&store, session_id)?;
            closed_sessions::ensure_not_closed(&store.db, session_id)?;
            validate_session(&session)?;
            let local_attachment_directory = (project.environment.kind != "ssh")
                .then(|| attachment_directory(&store.attachment_instance_directory, session_id));
            (project, session, local_attachment_directory)
        };
        let (remote_host, remote_dtach) = prepare_remote(
            &prepared_project.environment.kind,
            prepared_project.environment.ssh.as_ref(),
            session_id,
        )?;
        // Files and uploads happen before the store lock so they never block other sessions.
        let mut staged_attachment_directory = StagedAttachmentDirectory(local_attachment_directory);
        if let Some(directory) = &staged_attachment_directory.0 {
            reset_session_attachment_directory(directory)?;
        }
        let remote_clipboard = prepared_project.environment.ssh.clone().map(|connection| {
            RemoteClipboard::new(
                connection,
                matches!(remote_host, Some(RemoteHost::Absent | RemoteHost::Live))
                    .then(|| (remote_host::TERMINALS, session_id.to_owned())),
            )
        });
        let agent_provider = (prepared_session.kind != "service"
            && remote_host != Some(RemoteHost::Live))
        .then(|| conversations::provider(&prepared_session.executable))
        .flatten();
        // Every agent may ask for Kanban issues through files in this directory.
        let private_directory = agent_provider
            .is_some()
            .then(
                || match (&staged_attachment_directory.0, &remote_clipboard) {
                    (Some(directory), _) => directory
                        .to_str()
                        .ok_or_else(|| "Chemin temporaire local non UTF-8.".to_string())
                        .and_then(|path| {
                            agent_local_path(&prepared_project.environment, path.to_owned())
                        }),
                    (None, Some(remote)) => remote.ensure_directory(),
                    (None, None) => Err("Dossier des messages indisponible.".into()),
                },
            )
            .and_then(|directory| directory.ok());
        // Claude asks before reading outside its folders; message files land in this directory.
        let message_directory_args = private_directory
            .clone()
            .filter(|_| agent_provider == Some(conversations::Provider::Claude))
            .map(|directory| vec!["--add-dir".to_owned(), directory])
            .unwrap_or_default();
        let initial_prompt = match initial_prompt {
            Some(prompt) if !attachments.is_empty() => {
                validate_initial_prompt(&prepared_session, prompt, remote_host)?;
                let directory = write_prompt_attachments(
                    &prepared_project.environment,
                    staged_attachment_directory.0.as_deref(),
                    remote_clipboard.as_ref(),
                    attachments,
                )?;
                Some(prompt_with_attachments(prompt, &directory, attachments))
            }
            prompt => prompt.map(str::to_owned),
        };
        let initial_prompt = initial_prompt.as_deref();
        let remote_prompt = match &remote_clipboard {
            Some(clipboard) => clipboard.prompt_directory()?,
            None => None,
        };
        #[cfg(windows)]
        let wsl = (prepared_project.environment.kind == "wsl")
            .then(|| {
                if grouped {
                    groups::create_group_directory(
                        &prepared_project.environment,
                        &prepared_project.path,
                    )?;
                }
                WslRun::prepare(
                    &prepared_project,
                    prepared_session
                        .working_directory
                        .as_deref()
                        .unwrap_or(&prepared_project.path),
                )
            })
            .transpose()?;
        let mut store = lock(&self.store)?;
        if store.closing {
            return Err("L’application est en cours de fermeture.".into());
        }
        let session = require_session(&store, session_id)?;
        #[cfg(windows)]
        if wsl.is_some() && session.working_directory != prepared_session.working_directory {
            return Err(
                "Le dossier de la session a changé pendant son lancement. Relancez-la.".into(),
            );
        }
        if store.git_stopped_projects.contains(&session.project_id) {
            return Err("[Git/busy] Une opération Git est en cours sur ce projet.".into());
        }
        let project = require_project_connected(&store, &session.project_id)?;
        validate_project(&project)?;
        ensure_stopped(&store, session_id)?;
        closed_sessions::ensure_not_closed(&store.db, session_id)?;
        messages::fail_previous_run_messages(&mut store, session_id)?;
        validate_session(&session)?;
        if let Some(prompt) = initial_prompt {
            validate_initial_prompt(&session, prompt, remote_host)?;
        }
        let group = groups::group_by_group_project(&store.db, &project.id)?;
        #[cfg(windows)]
        conpty::ensure_loaded()?;
        let ssh = project.environment.ssh.as_ref();
        let group_launch = match &group {
            Some(group) if remote_host != Some(RemoteHost::Live) && session.kind != "service" => {
                groups::create_group_directory(&project.environment, &project.path)?;
                let members = groups::group_members(&store.db, group)?;
                groups::link_members(&project.environment, &project.path, &members);
                match conversations::provider(&session.executable) {
                    Some(provider) => {
                        conversations::validate_group_args(&session.args)?;
                        Some((provider, group, members))
                    }
                    None => None,
                }
            }
            _ => None,
        };
        if remote_host != Some(RemoteHost::Live) {
            forget_codex_update_run(&store, &session)?;
        }
        let mut launch_session = if remote_host == Some(RemoteHost::Live) {
            let generation = store
                .runtimes
                .get(session_id)
                .and_then(|runtime| runtime.remote_sidecar_generation.clone());
            conversations::prepare_attach(&store.db, &session, &project, generation)?
        } else {
            // Pi/OMP ignore APPEND_SYSTEM.md once the flag is given: their bridge appends the text.
            let system_append = match (agent_provider, &private_directory) {
                (
                    Some(conversations::Provider::Pi | conversations::Provider::Omp),
                    Some(directory),
                ) => Some(issue_requests::agent_instruction(session.design, directory)),
                _ => None,
            };
            let mut prepared = conversations::prepare_launch(
                &store.db,
                &store.links_dir,
                &session,
                &project,
                system_append.as_deref(),
            )?;
            let windows_local = cfg!(windows) && project.environment.kind == "local";
            if let Some((provider, group, members)) = &group_launch {
                groups::add_launch_args(
                    &mut prepared.session.args,
                    *provider,
                    &group.name,
                    members,
                    windows_local,
                );
            }
            prepared.session.args.splice(0..0, message_directory_args);
            if let (Some(provider), Some(directory)) = (agent_provider, &private_directory) {
                issue_requests::add_instruction(
                    &mut prepared.session.args,
                    provider,
                    directory,
                    session.design,
                    windows_local,
                )
                .or_else(|error| prepared.rollback(&store.db, error))?;
            }
            if let Some(prompt) = initial_prompt {
                prepared
                    .append_initial_prompt(prompt)
                    .or_else(|error| prepared.rollback(&store.db, error))?;
            }
            prepared
        };
        #[cfg(unix)]
        let run_token =
            run_token(&store.db).or_else(|error| launch_session.rollback(&store.db, error))?;
        #[cfg(unix)]
        let command = {
            let mut command = local_command_with_environment(
                &project,
                &launch_session,
                &launch_session.environment,
                remote_host,
                remote_dtach.as_deref(),
                launch_session.remote_directory(),
                remote_prompt.as_deref(),
            )
            .or_else(|error| launch_session.rollback(&store.db, error))?;
            command.env("SORENO_AGENT_RUN", &run_token);
            command
        };
        #[cfg(windows)]
        let command = if let Some(wsl) = &wsl {
            wsl.command(&project, &launch_session, &launch_session.environment)
        } else {
            local_command_with_environment(
                &project,
                &launch_session,
                &launch_session.environment,
                remote_host,
                remote_dtach.as_deref(),
                launch_session.remote_directory(),
                remote_prompt.as_deref(),
            )
            .or_else(|error| launch_session.rollback(&store.db, error))?
        };
        #[cfg(windows)]
        ensure_windows_command_line(&command, group.is_some())
            .or_else(|error| launch_session.rollback(&store.db, error))?;
        let metadata_parser = launch_session.take_metadata_parser();
        let remote_sidecar_generation = launch_session.remote_sidecar_generation();
        let remote_sidecar_sync = launch_session.take_remote_sidecar_sync();
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("Impossible d’ouvrir le terminal : {e}"))
            .or_else(|error| launch_session.rollback(&store.db, error))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())
            .or_else(|error| launch_session.rollback(&store.db, error))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| e.to_string())
            .or_else(|error| launch_session.rollback(&store.db, error))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| {
                format!("Lancement impossible : {e}. Vérifiez le shell et l’exécutable installé.")
            })
            .or_else(|error| launch_session.rollback(&store.db, error))?;
        drop(pair.slave);
        if let Some(clipboard) = &remote_clipboard {
            clipboard.hand_over_prompt_directory();
        }
        #[cfg(windows)]
        let process_handle = child
            .as_raw_handle()
            .ok_or("Handle du processus Windows indisponible.")?
            as usize;
        let runtime = Arc::new(Runtime {
            output: Mutex::new(Output::default()),
            grid: Mutex::new(None),
            writer: Mutex::new(Some(writer)),
            size: Mutex::new(size),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            remote_clipboard,
            local_attachment_directory: Mutex::new(staged_attachment_directory.0.take()),
            remote_sidecar_generation,
            #[cfg(windows)]
            wsl,
            #[cfg(windows)]
            process_handle,
            #[cfg(unix)]
            run_token,
        });
        remote_host::schedule_redraw(Arc::downgrade(&runtime), ssh, remote_host, session_id);
        if let Some(sync) = remote_sidecar_sync {
            let watching = Arc::downgrade(&runtime);
            thread::spawn(move || loop {
                thread::sleep(std::time::Duration::from_secs(2));
                let Some(runtime) = watching.upgrade() else {
                    break;
                };
                if runtime.output.lock().map_or(true, |output| output.exited) {
                    break;
                }
                // dtach may miss a private OSC frame; the remote sidecar remains canonical.
                let _ = sync.refresh_if_working();
            });
        }
        let reading = Arc::clone(&runtime);
        let mut pipeline = OutputPipeline {
            // Only SSH sessions run under Soreno's dtach, which frames its replay.
            history: remote_host
                .map(|host| dtach_history::HistoryFraming::new(host == RemoteHost::Live)),
            metadata: metadata_parser,
            program_status: Default::default(),
        };
        thread::spawn(move || {
            let mut chunk = [0; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => {
                        pipeline.finish(&reading);
                        break;
                    }
                    Ok(count) => pipeline.push(&chunk[..count], &reading),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        pipeline.finish(&reading);
                        if let Ok(mut output) = reading.output.lock() {
                            if !output.exited {
                                output.append(
                                    format!("\r\n[Erreur terminal : {error}]\r\n").as_bytes(),
                                );
                            }
                        }
                        break;
                    }
                }
            }
        });
        let waiting = Arc::clone(&runtime);
        thread::spawn(move || {
            // Polling under the killer lock keeps stop and process reaping atomic
            // without holding any lock through a blocking child.wait().
            loop {
                if let Ok(_killer) = waiting.killer.lock() {
                    match child.try_wait() {
                        Ok(None) => {}
                        result => {
                            #[cfg(unix)]
                            if let Err(error) = stop_unix_run(&waiting.run_token) {
                                if let Ok(mut output) = waiting.output.lock() {
                                    output.append(
                                        format!("\r\n[Arrêt Unix : {error}]\r\n").as_bytes(),
                                    );
                                }
                            }
                            #[cfg(windows)]
                            if let Some(wsl) = &waiting.wsl {
                                if let Err(error) = wsl.stop() {
                                    if let Ok(mut output) = waiting.output.lock() {
                                        output.append(
                                            format!("\r\n[Arrêt WSL : {error}]\r\n").as_bytes(),
                                        );
                                    }
                                }
                            }
                            if let Some(remote_clipboard) = &waiting.remote_clipboard {
                                if let Err(error) = remote_clipboard.close() {
                                    if let Ok(mut output) = waiting.output.lock() {
                                        output.append(
                                            format!("\r\n[Nettoyage SSH : {error}]\r\n").as_bytes(),
                                        );
                                    }
                                }
                            }
                            let local_cleanup = waiting
                                .local_attachment_directory
                                .lock()
                                .ok()
                                .and_then(|mut directory| directory.take())
                                .map(|directory| cleanup_attachment_directory(&directory));
                            if let Some(Err(error)) = local_cleanup {
                                if let Ok(mut output) = waiting.output.lock() {
                                    output.append(
                                        format!("\r\n[Nettoyage des pièces jointes : {error}]\r\n")
                                            .as_bytes(),
                                    );
                                }
                            }
                            if let Ok(mut output) = waiting.output.lock() {
                                match result {
                                    Ok(Some(exit)) => output.exit_code = Some(exit.exit_code()),
                                    Err(error) => output.append(
                                        format!("\r\n[Erreur processus : {error}]\r\n").as_bytes(),
                                    ),
                                    _ => {}
                                }
                                output.exited = true;
                                output.publish();
                            }
                            break;
                        }
                    }
                }
                thread::sleep(std::time::Duration::from_millis(30));
            }
            if let Ok(mut master) = waiting.master.lock() {
                master.take();
            }
            if let Ok(mut writer) = waiting.writer.lock() {
                writer.take();
            }
        });
        store.runtimes.insert(session_id.into(), runtime);
        Ok(())
    }
    /// Runs under the session operation lock `start_using` holds.
    fn start_conversation(
        &self,
        session_id: &str,
        initial_prompt: Option<&str>,
        attachments: &[PromptAttachment],
    ) -> Result<()> {
        let (label, project, resumed, launch_args, token, local_files, _starting) = {
            let mut store = lock(&self.store)?;
            if store.closing {
                return Err("L’application est en cours de fermeture.".into());
            }
            let session = require_session(&store, session_id)?;
            if store.git_stopped_projects.contains(&session.project_id) {
                return Err("[Git/busy] Une opération Git est en cours sur ce projet.".into());
            }
            wake_project(&mut store, &session.project_id)?;
            let project = require_project_connected(&store, &session.project_id)?;
            validate_project(&project)?;
            validate_session(&session)?;
            validate_prompt_attachments(&project.environment, attachments)?;
            ensure_stopped(&store, session_id)?;
            closed_sessions::ensure_not_closed(&store.db, session_id)?;
            messages::fail_previous_run_messages(&mut store, session_id)?;
            let mut launch_args = Vec::new();
            if let Some(group) = groups::group_by_group_project(&store.db, &project.id)? {
                groups::create_group_directory(&project.environment, &project.path)?;
                let members = groups::group_members(&store.db, &group)?;
                groups::link_members(&project.environment, &project.path, &members);
                groups::add_launch_args(
                    &mut launch_args,
                    conversations::Provider::Omp,
                    &group.name,
                    &members,
                    cfg!(windows) && project.environment.kind == "local",
                );
            }
            // The run being replaced may hold a conversation not yet persisted.
            let previous = store.omp_conversations.get(session_id).map(Arc::as_ref);
            let resumed = conversation::reconcile(&store.db, session_id, previous)?;
            let local_files = (project.environment.kind != "ssh")
                .then(|| attachment_directory(&store.attachment_instance_directory, session_id));
            let token = run_token(&store.db)?;
            store.starting_conversations.insert(session_id.into());
            (
                format!("{} · {}", project.name, session.display_name()),
                project,
                resumed,
                launch_args,
                token,
                local_files,
                StartingConversation {
                    owner: self,
                    session_id,
                },
            )
        };
        if let Some(directory) = &local_files {
            reset_session_attachment_directory(directory)?;
        }
        // shortcut: a launch failing before OMP runs leaves the issue attachments in this private directory until the next launch or Soreno closes; stage it like terminal launches if that matters.
        // Started outside the store lock: the handshake writes to the new process.
        let runtime = conversation::start(
            &project,
            session_id,
            &label,
            resumed,
            initial_prompt,
            attachments,
            &launch_args,
            token,
            local_files,
        )?;
        let mut store = lock(&self.store)?;
        let closing = store.closing;
        let published = if closing {
            Err("L’application est en cours de fermeture.".to_string())
        } else {
            // A save may have turned it into another kind while it was starting; a disconnection
            // that began meanwhile did not stop it, and its SSH access would hold `block` forever.
            require_session(&store, session_id).and_then(|session| {
                if session.kind != conversation::KIND {
                    return Err("La session n’est plus une conversation OMP.".into());
                }
                require_project_connected(&store, &session.project_id).map(|_| ())
            })
        };
        if let Err(error) = published {
            drop(store);
            let _ = runtime.stop();
            // Closing Soreno leaves an SSH run under dtach going; nothing else should.
            if let Some(connection) = project.environment.ssh.as_ref().filter(|_| !closing) {
                let _ = remote_host::stop(connection, &[session_id]);
            }
            return Err(error);
        }
        store.omp_conversations.insert(session_id.into(), runtime);
        Ok(())
    }
    fn conversation_runtime(
        &self,
        session_id: &str,
    ) -> Result<Arc<conversation::ConversationProcess>> {
        id(session_id)?;
        let store = lock(&self.store)?;
        require_session(&store, session_id)?;
        store
            .omp_conversations
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Démarrez la conversation OMP avant cette opération.".into())
    }
    pub fn conversation_subscribe(
        &self,
        session_id: &str,
        on_record: tauri::ipc::Channel<String>,
    ) -> Result<()> {
        self.conversation_runtime(session_id)?.subscribe(on_record)
    }
    pub fn conversation_send(&self, session_id: &str, record: &serde_json::Value) -> Result<()> {
        self.conversation_runtime(session_id)?.send(record)
    }
    pub fn conversation_history(
        &self,
        session_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ConversationHistoryPage> {
        let runtime = self.conversation_runtime(session_id)?;
        let project = {
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            require_project_connected(&store, &session.project_id)?
        };
        // Outside the store lock: an SSH listing may take seconds.
        runtime.history(&project, offset, limit)
    }
    fn session_operation(&self, session_id: &str) -> Result<Arc<Mutex<()>>> {
        let mut store = lock(&self.store)?;
        require_session(&store, session_id)?;
        Ok(store
            .session_operations
            .entry(session_id.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }
    fn runtime(&self, session_id: &str) -> Result<Option<Arc<Runtime>>> {
        id(session_id)?;
        let store = lock(&self.store)?;
        require_session(&store, session_id)?;
        Ok(store.runtimes.get(session_id).cloned())
    }
    pub fn stop(&self, session_id: &str) -> Result<()> {
        self.stop_using(session_id, remote_host::stop)
    }
    #[cfg(test)]
    fn stop_with(
        &self,
        session_id: &str,
        stop_remote: impl FnOnce(&SshConnection, &[&str]) -> Result<()>,
    ) -> Result<()> {
        self.stop_using(session_id, stop_remote)
    }
    fn stop_using(
        &self,
        session_id: &str,
        stop_remote: impl FnOnce(&SshConnection, &[&str]) -> Result<()>,
    ) -> Result<()> {
        id(session_id)?;
        let operation = self.session_operation(session_id)?;
        let _operation = lock(&operation)?;
        let (connection, runtime, omp) = {
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            let project = require_project(&store, &session.project_id)?;
            (
                connected_ssh(&store, &project)?,
                store.runtimes.get(session_id).cloned(),
                store.omp_conversations.get(session_id).cloned(),
            )
        };
        // First: a conversation under dtach whose run ends before its client would report a crash.
        let omp_result = omp.map_or(Ok(()), |omp| {
            let stopped = omp.stop();
            let store = lock(&self.store)?;
            if store
                .omp_conversations
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &omp))
            {
                conversation::reconcile(&store.db, session_id, Some(omp.as_ref()))?;
            }
            stopped
        });
        let remote_result = connection
            .as_ref()
            .map_or(Ok(()), |connection| stop_remote(connection, &[session_id]));
        let local_result = runtime.map_or(Ok(()), |runtime| runtime.stop());
        remote_result.and(local_result).and(omp_result)
    }
    pub fn grid_subscribe(
        &self,
        session_id: &str,
        config: AgentGridConfig,
        visible: bool,
        on_frame: tauri::ipc::Channel<AgentGridFrame>,
        log: Option<PathBuf>,
    ) -> Result<()> {
        let theme = grid::GridTheme::parse(&config)?;
        match self.runtime(session_id)? {
            Some(runtime) => runtime.grid_subscribe(session_id, theme, visible, on_frame, log),
            None => on_frame
                .send(AgentGridFrame::idle())
                .map_err(|error| error.to_string()),
        }
    }
    pub fn grid_ack(&self, session_id: &str, channel_id: u32, apply_micros: u64) -> Result<()> {
        self.grid_command(
            session_id,
            channel_id,
            grid::GridCommand::Ack { apply_micros },
        )
    }
    pub fn grid_unsubscribe(&self, session_id: &str, channel_id: u32) -> Result<()> {
        match self.runtime(session_id)? {
            Some(runtime) => runtime.grid_unsubscribe(channel_id),
            None => Ok(()),
        }
    }
    pub fn grid_configure(
        &self,
        session_id: &str,
        channel_id: u32,
        config: AgentGridConfig,
    ) -> Result<()> {
        let theme = grid::GridTheme::parse(&config)?;
        self.grid_command(session_id, channel_id, grid::GridCommand::Configure(theme))
    }
    pub fn grid_scroll(
        &self,
        session_id: &str,
        channel_id: u32,
        scroll: AgentGridScroll,
    ) -> Result<()> {
        self.grid_command(session_id, channel_id, grid::GridCommand::Scroll(scroll))
    }
    pub fn grid_select(
        &self,
        session_id: &str,
        channel_id: u32,
        select: AgentGridSelect,
    ) -> Result<()> {
        self.grid_command(session_id, channel_id, grid::GridCommand::Select(select))
    }
    pub fn grid_visibility(&self, session_id: &str, channel_id: u32, visible: bool) -> Result<()> {
        self.grid_command(
            session_id,
            channel_id,
            grid::GridCommand::Visibility(visible),
        )
    }
    pub fn grid_text(&self, session_id: &str, channel_id: u32) -> Result<String> {
        match self.runtime(session_id)? {
            Some(runtime) => runtime.grid_text(channel_id),
            None => Err("Terminal Rust indisponible.".into()),
        }
    }
    fn grid_command(
        &self,
        session_id: &str,
        channel_id: u32,
        command: grid::GridCommand,
    ) -> Result<()> {
        match self.runtime(session_id)? {
            Some(runtime) => runtime.grid_command(channel_id, command),
            None => Ok(()),
        }
    }
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        if data.len() > 64 * 1024 {
            return Err("Entrée terminal limitée à 64 Kio par envoi.".into());
        }
        let runtime = self
            .runtime(session_id)?
            .ok_or("Démarrez la session avant de saisir du texte.")?;
        if lock(&runtime.output)?.exited {
            return Err("Cette session est terminée.".into());
        }
        let mut writer = lock(&runtime.writer)?;
        let writer = writer.as_mut().ok_or("Terminal fermé.")?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())?;
        // Updated under the writer lock: a message line checks it there before typing.
        // shortcut: the phone writes to dtach directly, so its Enter leaves a desktop draft
        // holding messages until the next desktop Enter; report remote submits if that annoys.
        let mut output = lock(&runtime.output)?;
        output.draft = messages::holds_draft(output.draft, data);
        Ok(())
    }
    pub fn upload_clipboard_image(
        &self,
        session_id: &str,
        mime_type: &str,
        data_base64: &str,
    ) -> Result<String> {
        if data_base64.len() > ((REMOTE_CLIPBOARD_IMAGE_LIMIT + 2) / 3) * 4 {
            return Err("Image du presse-papiers limitée à 4 Mio.".into());
        }
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|_| "Image du presse-papiers non base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > REMOTE_CLIPBOARD_IMAGE_LIMIT {
            return Err("Image du presse-papiers vide ou supérieure à 4 Mio.".into());
        }
        let extension = clipboard_image_extension(mime_type, &bytes)?;
        let runtime = self
            .runtime(session_id)?
            .ok_or("Démarrez la session avant de coller une image.")?;
        if lock(&runtime.output)?.exited {
            return Err("Cette session est terminée.".into());
        }
        runtime
            .remote_clipboard
            .as_ref()
            .ok_or_else(|| "Le transfert d’image est réservé aux projets SSH.".to_string())?
            .upload(extension, &bytes)
    }
    pub fn attach_command(&self, session_id: &str) -> Result<String> {
        id(session_id)?;
        let store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        let project = require_project(&store, &session.project_id)?;
        match (project.environment.kind.as_str(), &project.environment.ssh) {
            ("ssh", Some(connection)) => Ok(remote_host::attach_command(connection, session_id)),
            _ => {
                Err("Le rattachement depuis un autre terminal est réservé aux projets SSH.".into())
            }
        }
    }
    /// Never reaches a disconnected, dormant or deleted project.
    pub fn set_remote_label(&self, session_id: &str, label: &str) -> Result<()> {
        id(session_id)?;
        // Held until the label is sent so that removing the project cannot revive its SSH relay.
        let _connection_change = lock(&self.connection_changes)?;
        let (root, connection) = {
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            let project = require_project_connected(&store, &session.project_id)?;
            let (root, exited) = if session.kind == conversation::KIND {
                let conversation = store
                    .omp_conversations
                    .get(session_id)
                    .ok_or("Démarrez la session avant de la renommer.")?;
                (remote_host::CONVERSATIONS, conversation.exited())
            } else {
                let runtime = store
                    .runtimes
                    .get(session_id)
                    .ok_or("Démarrez la session avant de la renommer.")?;
                (remote_host::TERMINALS, lock(&runtime.output)?.exited)
            };
            if exited {
                return Err("Cette session est terminée.".into());
            }
            let connection = connected_ssh(&store, &project)?
                .ok_or("Le libellé distant est réservé aux projets SSH.")?;
            (root, connection)
        };
        remote_host::set_label(&connection, root, session_id, label)
    }
    pub fn attach_file(&self, session_id: &str, filename: &str, bytes: &[u8]) -> Result<String> {
        attachment_filename(filename)?;
        let (runtime, environment) = {
            id(session_id)?;
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            let project = require_project_connected(&store, &session.project_id)?;
            validate_project(&project)?;
            if session.kind == conversation::KIND {
                let conversation = store
                    .omp_conversations
                    .get(session_id)
                    .cloned()
                    .ok_or("Démarrez la conversation avant de joindre un fichier.")?;
                drop(store);
                return conversation.attach_file(&project.environment, filename, bytes);
            }
            let runtime = store
                .runtimes
                .get(session_id)
                .cloned()
                .ok_or("Démarrez la session avant de joindre un fichier.")?;
            (runtime, project.environment)
        };
        attach_file_to(&runtime, &environment, filename, bytes)
    }
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let size = size(cols, rows)?;
        if let Some(runtime) = self.runtime(session_id)? {
            runtime.resize(size)?;
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        let (runtimes, omp_conversations, attachment_instance_directory) = match self.store.lock() {
            Ok(mut store) => {
                let sessions: Vec<AgentSession> =
                    list(&store.db, "agent_sessions").unwrap_or_default();
                for session in sessions {
                    if let Ok(project) = require_project(&store, &session.project_id) {
                        if project.environment.kind == "ssh"
                            && project_disconnected(&store.db, &project.id).unwrap_or(true)
                        {
                            continue;
                        }
                        // A detached SSH session may still run on the server.
                        let process_active = project.environment.kind == "ssh"
                            && process_may_be_active(&store, &session, &project).unwrap_or(true);
                        if !process_active {
                            let _ = forget_codex_update_run(&store, &session);
                        }
                        let _ = conversations::reconcile_cached(
                            &store.db,
                            &session,
                            &project,
                            process_active,
                        );
                    }
                }
                store.closing = true;
                for (session_id, omp) in &store.omp_conversations {
                    let _ = conversation::reconcile(&store.db, session_id, Some(omp.as_ref()));
                }
                (
                    store.runtimes.values().cloned().collect::<Vec<_>>(),
                    store
                        .omp_conversations
                        .values()
                        .cloned()
                        .collect::<Vec<_>>(),
                    store.attachment_instance_directory.clone(),
                )
            }
            Err(_) => return,
        };
        // Each conversation may take its graceful delay: stop them together.
        thread::scope(|scope| {
            for omp in &omp_conversations {
                scope.spawn(move || {
                    if let Err(error) = omp.stop() {
                        eprintln!("Arrêt de conversation OMP : {error}");
                    }
                });
            }
        });
        for runtime in runtimes {
            if let Err(error) = runtime.stop() {
                eprintln!("Arrêt agent : {error}");
            }
        }
        if let Err(error) = cleanup_attachment_directory(&attachment_instance_directory) {
            eprintln!("Nettoyage des pièces jointes locales : {error}");
        }
    }
}
impl Drop for AgentSessions {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn session_status(
    store: &Store,
    session: &AgentSession,
    disconnected: bool,
) -> Result<AgentSessionStatus> {
    if session.kind == conversation::KIND {
        let runtime = store.omp_conversations.get(&session.id).map(Arc::as_ref);
        return conversation::status(&store.db, &session.id, runtime);
    }
    let mut activity = if disconnected {
        conversations::Activity::default()
    } else {
        let project = require_project(store, &session.project_id)?;
        let process_active = process_may_be_active(store, session, &project)?;
        if !process_active {
            forget_codex_update_run(store, session)?;
        }
        conversations::reconcile_cached(&store.db, session, &project, process_active)?
    };
    let mut status = status(store, session)?;
    let last_message = activity
        .turn
        .as_ref()
        .and_then(|turn| turn.message.as_deref())
        .and_then(message_preview);
    if let Some(turn) = activity.turn.take() {
        status.issue_summary =
            kanban_issue_sessions::pending_summary(&store.db, &session.id, turn)?;
    }
    if status.state == "running" {
        status.last_message = last_message;
        if let (Some(provider), Some(runtime)) = (
            conversations::provider(&session.executable),
            store.runtimes.get(&session.id),
        ) {
            if let Ok(output) = lock(&runtime.output) {
                output.report_activity(provider, &activity, &mut status);
            }
        }
    }
    Ok(status)
}
/// One line of at most 200 characters, for notifications.
fn message_preview(message: &str) -> Option<String> {
    const LIMIT: usize = 200;
    let mut chars = message
        .split(char::is_whitespace)
        .map(|word| word.chars().filter(|c| !c.is_control()).peekable())
        .filter_map(|mut word| word.peek().is_some().then_some(word))
        .enumerate()
        .flat_map(|(index, word)| (index > 0).then_some(' ').into_iter().chain(word));
    let mut preview: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        preview = preview.chars().take(LIMIT - 1).collect();
        preview.truncate(preview.trim_end().len());
        preview.push('…');
    }
    (!preview.is_empty()).then_some(preview)
}
fn idle(session_id: &str) -> AgentSessionStatus {
    AgentSessionStatus {
        session_id: session_id.into(),
        state: "idle".into(),
        exit_code: None,
        working: None,
        awaiting: false,
        conversation: None,
        resume: "unsupported".into(),
        conversation_error: None,
        issue_summary: None,
        last_message: None,
        missing_executable: false,
        outdated_cli: false,
    }
}
fn process_may_be_active(
    store: &Store,
    session: &AgentSession,
    project: &AgentProject,
) -> Result<bool> {
    if store
        .runtimes
        .get(&session.id)
        .is_some_and(|runtime| lock(&runtime.output).map_or(true, |output| !output.exited))
    {
        return Ok(true);
    }
    if project.environment.kind != "ssh" || !conversations::has_run(&store.db, &session.id)? {
        return Ok(false);
    }
    // Workspace/status refreshes must never wait on SSH while holding the store.
    Ok(true)
}
fn runtime_status(store: &Store, session_id: &str) -> Result<AgentSessionStatus> {
    if let Some(omp) = store.omp_conversations.get(session_id) {
        return omp.run_status(session_id);
    }
    match store.runtimes.get(session_id) {
        Some(runtime) => Ok(lock(&runtime.output)?.status(session_id)),
        None => Ok(idle(session_id)),
    }
}
fn forget_codex_update_run(store: &Store, session: &AgentSession) -> Result<()> {
    const TAIL: usize = 16 * 1024;
    let Some(runtime) = store.runtimes.get(&session.id) else {
        return Ok(());
    };
    let output = lock(&runtime.output)?;
    if !output.exited {
        return Ok(());
    }
    conversations::forget_codex_update_run(&store.db, session, || {
        let start = output.bytes.len().saturating_sub(TAIL);
        conversations::codex_requested_restart(output.bytes.range(start..).copied())
    })
}
fn status(store: &Store, session: &AgentSession) -> Result<AgentSessionStatus> {
    let mut status = runtime_status(store, &session.id)?;
    let fields = conversations::fields(&store.db, session)?;
    status.conversation = fields.conversation;
    status.resume = fields.resume;
    status.conversation_error = fields.error;
    status.missing_executable = !session.executable.is_empty()
        && status.state == "exited"
        && status.exit_code == Some(MISSING_EXECUTABLE_EXIT_CODE);
    Ok(status)
}
fn ensure_stopped(store: &Store, session_id: &str) -> Result<()> {
    if store.starting_conversations.contains(session_id)
        || runtime_status(store, session_id)?.state == "running"
    {
        return Err("Arrêtez la session active avant cette opération.".into());
    }
    // Do not discard the only run identity if natural-exit cleanup failed.
    // shortcut: an OMP conversation's failed exit sweep is not retried here, so rare leftover tool
    // processes may outlive a delete or restart; call its `stop()` too if that is ever reported.
    if let Some(runtime) = store.runtimes.get(session_id) {
        runtime.stop()?;
    }
    Ok(())
}
fn list<T: serde::de::DeserializeOwned>(db: &Connection, table: &str) -> Result<Vec<T>> {
    // Table names are internal constants, never IPC data.
    let mut stmt = db
        .prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}
fn get<T: serde::de::DeserializeOwned>(
    db: &Connection,
    table: &str,
    id: &str,
) -> Result<Option<T>> {
    let data: Option<String> = db
        .query_row(
            &format!("SELECT data FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    data.map(|data| serde_json::from_str(&data).map_err(|e| e.to_string()))
        .transpose()
}
fn capacity(db: &Connection, table: &str, limit: i64) -> Result<()> {
    let count: i64 = db
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count >= limit {
        return Err(format!("Limite de {limit} entrées atteinte."));
    }
    Ok(())
}
fn require_project(store: &Store, project_id: &str) -> Result<AgentProject> {
    get(&store.db, "agent_projects", project_id)?.ok_or("Projet introuvable.".into())
}
fn project_disconnected(db: &Connection, project_id: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_disconnected_projects WHERE project_id=?1)",
        [project_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}
fn connected_ssh(store: &Store, project: &AgentProject) -> Result<Option<SshConnection>> {
    if project.environment.kind != "ssh" || project_disconnected(&store.db, &project.id)? {
        return Ok(None);
    }
    Ok(project.environment.ssh.clone())
}
/// The frontend recognizes this marker to offer deleting through a disconnection.
const REMOTE_STOP_FAILED: &str = "[SSH/remoteStopFailed]";
fn stop_remote_sessions_before_delete(
    connection: &SshConnection,
    session_ids: &[&str],
) -> Result<()> {
    remote_host::stop(connection, session_ids).map_err(|error| {
        format!("{REMOTE_STOP_FAILED}\nImpossible d’arrêter la session sur le serveur SSH : {error}. Déconnectez le projet pour la supprimer sans contacter le serveur.")
    })
}
/// Startup sees no launch in progress here; the retention period covers other instances.
fn purge_launch_directories(db: &Connection, links_dir: &Path) {
    let referenced = match conversations::referenced_runs(db) {
        Ok(referenced) => referenced,
        Err(error) => return eprintln!("Purge des dossiers de lancement : {error}"),
    };
    let links_dir = links_dir.to_owned();
    thread::spawn(move || {
        if let Err(error) = conversations::purge_local_launch_directories(
            &links_dir,
            &referenced,
            SystemTime::now(),
        ) {
            eprintln!("Purge des dossiers de lancement : {error}");
        }
    });
}
fn disconnected_project_ids(db: &Connection) -> Result<Vec<String>> {
    let mut stmt = db
        .prepare("SELECT project_id FROM agent_disconnected_projects ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}
/// The built-in chat is gone: its sessions and conversations would only stay broken.
fn remove_chat_sessions(db: &mut Connection) -> Result<()> {
    let tx = db.transaction().map_err(|error| error.to_string())?;
    tx.execute_batch("DROP TABLE IF EXISTS agent_chat_conversations;")
        .map_err(|error| error.to_string())?;
    let chats = list::<AgentSession>(&tx, "agent_sessions")?
        .into_iter()
        .filter(|session| session.kind == "chat")
        .collect::<Vec<_>>();
    kanban_issue_sessions::end_issue_sessions(&tx, &chats, SessionEnd::Session)?;
    for session in &chats {
        tx.execute("DELETE FROM agent_sessions WHERE id=?1", [&session.id])
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}
fn normalize_disconnected_ssh_groups(db: &mut Connection) -> Result<()> {
    let tx = db.transaction().map_err(|error| error.to_string())?;
    let migrated: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_schema_migrations WHERE name=?1)",
            [NORMALIZE_DISCONNECTED_SSH_GROUPS_MIGRATION],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if migrated {
        return tx.commit().map_err(|error| error.to_string());
    }
    let disconnected = disconnected_project_ids(&tx)?
        .into_iter()
        .collect::<HashSet<_>>();
    let projects = list::<AgentProject>(&tx, "agent_projects")?;
    let connections = projects
        .iter()
        .filter(|project| disconnected.contains(&project.id))
        .filter_map(|project| project.environment.ssh.clone())
        .collect::<HashSet<_>>();
    for project in projects {
        if project
            .environment
            .ssh
            .is_some_and(|connection| connections.contains(&connection))
        {
            tx.execute(
                "INSERT OR IGNORE INTO agent_disconnected_projects(project_id) VALUES (?1)",
                [project.id],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO agent_schema_migrations(name) VALUES (?1)",
        [NORMALIZE_DISCONNECTED_SSH_GROUPS_MIGRATION],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}
fn referenced_ssh_connections(db: &Connection) -> Result<HashSet<SshConnection>> {
    Ok(list::<AgentProject>(db, "agent_projects")?
        .into_iter()
        .filter_map(|project| project.environment.ssh)
        .collect())
}
fn blocked_ssh_connections(db: &Connection) -> Result<HashSet<SshConnection>> {
    let disconnected = disconnected_project_ids(db)?
        .into_iter()
        .collect::<HashSet<_>>();
    let projects = list::<AgentProject>(db, "agent_projects")?;
    Ok(projects
        .iter()
        .filter(|project| disconnected.contains(&project.id))
        .filter_map(|project| project.environment.ssh.as_ref())
        .filter(|connection| {
            projects.iter().all(|project| {
                project.environment.ssh.as_ref() != Some(connection)
                    || disconnected.contains(&project.id)
            })
        })
        .cloned()
        .collect())
}
fn dormant_ssh_connections(db: &Connection) -> Result<HashSet<SshConnection>> {
    let blocked = blocked_ssh_connections(db)?;
    Ok(referenced_ssh_connections(db)?
        .into_iter()
        .filter(|connection| !blocked.contains(connection))
        .collect())
}
fn environment_dormant(store: &Store, environment: &AgentEnvironment) -> bool {
    environment
        .ssh
        .as_ref()
        .is_some_and(|connection| store.dormant_ssh.contains(connection))
}
fn wake_environment(store: &mut Store, environment: &AgentEnvironment) {
    if let Some(connection) = &environment.ssh {
        store.dormant_ssh.remove(connection);
    }
}
/// Starting a session is the explicit action that may reach, and start, the server.
fn wake_project(store: &mut Store, project_id: &str) -> Result<()> {
    let project = require_project(store, project_id)?;
    wake_environment(store, &project.environment);
    Ok(())
}
fn require_project_connected(store: &Store, project_id: &str) -> Result<AgentProject> {
    let project = require_project(store, project_id)?;
    if project_disconnected(&store.db, project_id)? {
        Err("Ce projet SSH est déconnecté. Reconnectez-le avant cette opération.".into())
    } else if environment_dormant(store, &project.environment) {
        Err("Ce projet SSH n’est pas encore connecté. Connectez-le ou lancez une session avant cette opération.".into())
    } else {
        Ok(project)
    }
}
fn require_session(store: &Store, session_id: &str) -> Result<AgentSession> {
    get(&store.db, "agent_sessions", session_id)?.ok_or("Session introuvable.".into())
}
fn same_project_target(previous: &AgentProject, next: &AgentProject) -> bool {
    if previous.path != next.path {
        return false;
    }
    match (
        previous.environment.kind.as_str(),
        previous.environment.ssh.as_ref(),
        next.environment.kind.as_str(),
        next.environment.ssh.as_ref(),
    ) {
        ("ssh", Some(previous_connection), "ssh", Some(next_connection)) => {
            previous.environment.distribution == next.environment.distribution
                && same_ssh_target(previous_connection, next_connection)
        }
        _ => previous.environment == next.environment,
    }
}

fn normalize_project(project: AgentProject) -> Result<AgentProject> {
    #[cfg(windows)]
    {
        let (environment, path) =
            normalize_wsl_unc_environment(&project.environment, &project.path)?;
        Ok(AgentProject {
            environment,
            path,
            ..project
        })
    }
    #[cfg(not(windows))]
    Ok(project)
}

fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if !(1..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Dimensions terminal invalides (1–500 colonnes, 1–300 lignes).".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}
/// Launcher exit when the executable is not found; an agent exiting with it is misread as absent.
const MISSING_EXECUTABLE_EXIT_CODE: u32 = 209;
fn posix_command_with_environment(
    session: &AgentSession,
    environment: &[(String, String)],
    notice: Option<&str>,
) -> String {
    let notice = notice
        .map(|notice| format!("printf '%s\\r\\n' {}; ", crate::ssh::quote(notice)))
        .unwrap_or_default();
    // Clear the startup display after login/cd hooks, before any CLI output; the grid moves a
    // cleared screen into history, so `3J` drops it too (no scrollbar while the CLI starts).
    if session.executable.is_empty() {
        return format!(
            "printf '\\033[H\\033[2J\\033[3J'; {notice}exec \"${{SHELL:-/bin/bash}}\" -il"
        );
    }
    let remote_conversation = environment
        .iter()
        .any(|(key, value)| key == "SORENO_CONVERSATION_REMOTE" && value == "1");
    let exports = environment
        .iter()
        .map(|(key, value)| format!("export {key}={}; ", crate::ssh::quote(value)))
        .collect::<String>();
    let command = std::iter::once(&session.executable)
        .chain(&session.args)
        .map(|word| crate::ssh::quote(word))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "command -v {} >/dev/null 2>&1 || exit {MISSING_EXECUTABLE_EXIT_CODE}; printf '\\033[H\\033[2J\\033[3J'; {notice}{exports}{}exec {command}",
        crate::ssh::quote(&session.executable),
        if remote_conversation {
            "SORENO_CONVERSATION_OUTPUT=$(tty) || exit; export SORENO_CONVERSATION_OUTPUT; "
        } else {
            ""
        }
    )
}
#[cfg(test)]
fn posix_command(session: &AgentSession) -> String {
    posix_command_with_environment(session, &[], None)
}
fn posix_command_in_with_environment(
    directory: &str,
    session: &AgentSession,
    environment: &[(String, String)],
    notice: Option<&str>,
) -> String {
    format!(
        "cd -- {} || exit; {}",
        crate::ssh::quote(directory),
        posix_command_with_environment(session, environment, notice)
    )
}
#[cfg(all(test, unix))]
fn posix_command_in(directory: &str, session: &AgentSession) -> String {
    posix_command_in_with_environment(directory, session, &[], None)
}
fn local_command_with_environment(
    project: &AgentProject,
    session: &AgentSession,
    environment: &[(String, String)],
    remote_host: Option<RemoteHost>,
    remote_dtach: Option<&str>,
    remote_agent: Option<&str>,
    remote_prompt: Option<&str>,
) -> Result<CommandBuilder> {
    let directory = session
        .working_directory
        .as_deref()
        .unwrap_or(&project.path);
    if project.environment.kind == "ssh" {
        crate::ssh::validate_path(directory)?;
        let connection = project
            .environment
            .ssh
            .as_ref()
            .ok_or("Connexion SSH manquante.")?;
        let script = remote_host::session_script(
            remote_dtach,
            remote_host,
            &session.id,
            &format!("{} · {}", project.name, session.display_name()),
            remote_agent,
            remote_prompt,
            &posix_command_in_with_environment(directory, session, environment, None),
            session.executable.is_empty(),
        )?;
        return crate::ssh::terminal_command(connection, &script);
    }
    validate_local_directory(directory)?;
    #[cfg(unix)]
    let mut command = {
        let defaults = CommandBuilder::new("/bin/bash");
        let shell = defaults
            .get_env("SHELL")
            .unwrap_or_else(|| std::ffi::OsStr::new("/bin/bash"));
        let mut command = CommandBuilder::new(shell);
        command.args([
            "-ilc",
            &posix_command_in_with_environment(directory, session, environment, None),
        ]);
        command.env("TERM", "xterm-256color");
        command
    };
    #[cfg(windows)]
    let mut command = windows_command(session)?;
    #[cfg(windows)]
    for (key, value) in environment {
        command.env(key, value);
    }
    command.cwd(directory);
    Ok(command)
}
#[cfg(all(test, unix))]
fn local_command(project: &AgentProject, session: &AgentSession) -> Result<CommandBuilder> {
    local_command_with_environment(
        project,
        session,
        &[],
        Some(RemoteHost::Absent),
        Some("/tmp/dtach"),
        None,
        None,
    )
}

/// After `exec env [VAR=value…]`: records the run's pid in the control directory `$1`, then
/// runs `$2` in the login shell under the run token. A stopped run's gate refuses the launch.
#[cfg(windows)]
const WSL_RUN_GATE: &str = r#""SORENO_AGENT_RUN=$1" sh -c 'printf "%s\n" "$$" > "$1/pid" || exit; exec "${SHELL:-/bin/bash}" -ilc "$2"' soreno "$1" "$2""#;
#[cfg(windows)]
struct WslRun {
    distribution: String,
    directory: String,
    stopped: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    stop_results: Option<Mutex<VecDeque<Result<()>>>>,
}
#[cfg(windows)]
impl WslRun {
    fn prepare(project: &AgentProject, directory: &str) -> Result<Self> {
        let distribution = project
            .environment
            .distribution
            .as_deref()
            .ok_or("Choisissez une distribution WSL.")?;
        require_wsl_distribution(distribution)?;
        validate_linux_path(directory)?;
        let mut probe = std::process::Command::new("wsl.exe");
        probe.args(["--distribution", distribution, "--cd", directory, "--exec", "sh", "-c",
            "test -d \"$1\" && test \"$(pwd -P)\" = \"$(cd -- \"$1\" && pwd -P)\" && test -x /bin/kill && mktemp -d /tmp/soreno-agent.XXXXXXXXXXXX", "soreno", directory]);
        let directory = String::from_utf8(probe_output(probe)?)
            .map_err(|e| e.to_string())?
            .trim()
            .to_owned();
        if !directory.starts_with("/tmp/soreno-agent.")
            || directory.chars().any(char::is_whitespace)
        {
            return Err(
                "WSL : création du répertoire de contrôle impossible. Vérifiez /bin/kill et /tmp."
                    .into(),
            );
        }
        Ok(Self {
            distribution: distribution.into(),
            directory,
            stopped: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            stop_results: None,
        })
    }
    fn command(
        &self,
        project: &AgentProject,
        session: &AgentSession,
        environment: &[(String, String)],
    ) -> CommandBuilder {
        let directory = session
            .working_directory
            .as_deref()
            .unwrap_or(&project.path);
        let mut command = CommandBuilder::new("wsl.exe");
        command.env("WSLENV", host_wslenv());
        command.env_remove("WSL_UTF8");
        // Keep WSL's controlling terminal; setsid would detach it. The private
        // run token identifies this CLI and its descendants across Linux groups.
        command.args([
            "--distribution",
            &self.distribution,
            "--cd",
            directory,
            "--exec",
            "sh",
            "-c",
            &format!("exec env TERM=xterm-256color {WSL_RUN_GATE}"),
            "soreno",
            &self.directory,
            &posix_command_in_with_environment(directory, session, environment, None),
        ]);
        command
    }
    fn stop(&self) -> Result<()> {
        use std::sync::atomic::Ordering;
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(results) = &self.stop_results {
            lock(results)?.pop_front().unwrap_or(Ok(()))?;
            self.stopped.store(true, Ordering::Release);
            return Ok(());
        }
        let mut command = std::process::Command::new("wsl.exe");
        command.args(["--distribution", &self.distribution, "--exec", "sh", "-c", r#"
# Atomic rename closes the launch gate before looking for processes. A delayed
# launch cannot write its pidfile and must exit without executing the CLI.
if [ -d "$1" ]; then mv -- "$1" "$1.stopping" || exit 1; fi
[ -d "$1.stopping" ] || exit 0
if [ -s "$1.stopping/pid" ]; then
  read -r pid < "$1.stopping/pid"
  case "$pid" in ''|*[!0-9]*) exit 1;; esac
  # Verify identity before signaling: a naturally exited PID may be reused.
  if [ -r "/proc/$pid/environ" ] && tr '\000' '\n' < "/proc/$pid/environ" | grep -Fxq "SORENO_AGENT_RUN=$1"; then
    /bin/kill -KILL -- "$pid" 2>/dev/null || true
  fi
fi
# Catch remaining descendants even when the CLI already exited or a job changed
# process groups. Only processes inheriting this private run token are targeted.
for proc in /proc/[0-9]*; do
  if grep -zFxq "SORENO_AGENT_RUN=$1" "$proc/environ" 2>/dev/null; then
    /bin/kill -KILL -- "${proc##*/}" 2>/dev/null || true
  fi
done
rm -f -- "$1.stopping/pid"; rmdir -- "$1.stopping"
"#, "soreno", &self.directory]);
        probe_output(command)?;
        self.stopped.store(true, Ordering::Release);
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for WslRun {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("Nettoyage WSL : {error}");
        }
    }
}

#[cfg(any(windows, test))]
fn windows_quote(word: &str) -> String {
    // Windows CRT argv encoding, including trailing slashes and literal quotes.
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in word.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
#[cfg(any(windows, test))]
fn legacy_powershell_args_safe(args: &[String]) -> bool {
    // Windows PowerShell 5.1 shims re-serialize @args before calling a native CLI.
    // These values cannot round-trip reliably; the direct .exe path uses CRT quoting.
    args.iter().all(|arg| {
        !arg.is_empty()
            && !arg.contains('"')
            && !(arg.ends_with('\\') && arg.chars().any(char::is_whitespace))
    })
}
#[cfg(any(windows, test))]
fn windows_command(session: &AgentSession) -> Result<CommandBuilder> {
    if session.executable.is_empty() {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        return Ok(command);
    }
    let mut command = CommandBuilder::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-EncodedCommand",
        &windows_launcher(&session.executable, &session.args, false)?,
    ]);
    Ok(command)
}
/// `-EncodedCommand` resolving `executable` like a shell (.exe or .ps1), exiting 209 if absent.
/// `piped` keeps stdout clean and UTF-8 for a JSON stream instead of clearing a terminal.
#[cfg(any(windows, test))]
pub(crate) fn windows_launcher(executable: &str, args: &[String], piped: bool) -> Result<String> {
    let payload = STANDARD.encode(serde_json::to_vec(&serde_json::json!({ "executable": executable, "args": args, "ps1ArgsSafe": legacy_powershell_args_safe(args), "nativeArgs": args.iter().map(|s| windows_quote(s)).collect::<Vec<_>>().join(" ") })).map_err(|e| e.to_string())?);
    let prelude = if piped {
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false"
    } else {
        "[Console]::Write(([string][char]27) + '[H' + ([string][char]27) + '[2J' + ([string][char]27) + '[3J')"
    };
    // Payload is base64, not PowerShell source. No execution-policy bypass.
    // .cmd/.bat require cmd's second parser: reject rather than risk injection.
    let script = format!(
        r#"$ErrorActionPreference='Stop'; try {{
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}')) | ConvertFrom-Json
$c = Get-Command -Name ([Management.Automation.WildcardPattern]::Escape($p.executable)) -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) {{ exit {MISSING_EXECUTABLE_EXIT_CODE} }}
$ext = [IO.Path]::GetExtension($c.Path)
if ($ext -in '.cmd','.bat') {{ throw 'Utilisez le lanceur .ps1 ou .exe, pas .cmd/.bat (arguments non sûrs via cmd).' }}
{prelude}
if ($ext -eq '.ps1') {{
  if (-not $p.ps1ArgsSafe) {{ throw 'Arguments non représentables via .ps1 sous Windows PowerShell 5.1 (vide, guillemet double ou espace avec antislash final). Utilisez un exécutable .exe direct ou WSL.' }}
  $a = @($p.args); & $c.Path @a; if ($null -eq $LASTEXITCODE) {{ exit 0 }}; exit $LASTEXITCODE
}}
$i = New-Object Diagnostics.ProcessStartInfo
$i.FileName = $c.Path; $i.Arguments = $p.nativeArgs; $i.UseShellExecute = $false; $i.WorkingDirectory = (Get-Location).Path
$child = [Diagnostics.Process]::Start($i); $child.WaitForExit(); exit $child.ExitCode
}} catch {{ [Console]::Error.WriteLine($_); exit 1 }}"#
    );
    Ok(powershell_encoded_command(&script))
}
/// `-EncodedCommand` takes base64 of UTF-16LE.
fn powershell_encoded_command(script: &str) -> String {
    STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}
/// CreateProcessW rejects command lines above 32 767 UTF-16 units, terminator included.
#[cfg(any(windows, test))]
const WINDOWS_COMMAND_LINE_LIMIT: usize = 32_767;
#[cfg(any(windows, test))]
fn ensure_windows_command_line(command: &CommandBuilder, group: bool) -> Result<()> {
    // The program is resolved to a full path at spawn: reserve MAX_PATH for it.
    let length = 260
        + command
            .get_argv()
            .iter()
            .skip(1)
            .map(|arg| windows_quote(&arg.to_string_lossy()).encode_utf16().count() + 1)
            .sum::<usize>();
    if length < WINDOWS_COMMAND_LINE_LIMIT {
        return Ok(());
    }
    Err(if group {
        "La commande de l’agent de groupe dépasse la limite de Windows (32 767 caractères). Retirez des dépôts du groupe ou raccourcissez leurs chemins."
    } else {
        "La commande de lancement dépasse la limite de Windows (32 767 caractères). Raccourcissez les arguments de la session."
    }
    .into())
}

#[cfg(test)]
#[path = "agent_sessions_tests.rs"]
pub(crate) mod tests;
