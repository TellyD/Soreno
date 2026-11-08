use crate::{agent_sessions::AgentProject, process_owner::ProcessOwner};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::cell::Cell;
#[cfg(not(windows))]
use std::thread;
use std::{
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::RecvTimeoutError,
        Arc,
    },
    time::{Duration, Instant},
};

thread_local! {
    #[cfg(test)]
    static TEST_GIT_COMMANDS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_test_git_commands() {
    TEST_GIT_COMMANDS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn test_git_commands() -> usize {
    TEST_GIT_COMMANDS.with(Cell::get)
}

const DATA_LIMIT: usize = 8 * 1024 * 1024;
const LOG_LIMIT: usize = 256 * 1024;
const STDIN_LIMIT: usize = 8 * 1024 * 1024;
#[cfg(windows)]
const WSL_READONLY_STDIN_LIMIT: usize = STDIN_LIMIT;
const BRANCH_HINT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const COMPLETE_READ_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
const REMOTE_MUTATION_TIMEOUT: Duration = Duration::from_secs(300);
const GIT_OVERRIDES: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_REPLACE_REF_BASE",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_EXTERNAL_DIFF",
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertain: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl GitError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            uncertain: None,
            path: None,
        }
    }

    pub(crate) fn with_path(mut self, path: &str) -> Self {
        self.path = Some(path.into());
        self
    }

    fn command(code: &str, message: impl Into<String>, mutation: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            uncertain: mutation.then_some(true),
            path: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub root: String,
    pub git_dir: String,
    pub common_dir: String,
    #[serde(skip)]
    pub(crate) object_format: object_hash::ObjectFormat,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflict: bool,
    pub submodule: bool,
    pub actionable: bool,
    pub mode: String,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    pub availability: String,
    pub identity: Option<GitIdentity>,
    pub version: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub tracking_known: bool,
    pub operation: Option<String>,
    pub merge_message: Option<String>,
    pub files: Vec<GitFile>,
    pub limited: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitContent {
    pub text: Option<String>,
    pub oid: Option<String>,
    pub size: u64,
    pub mode: String,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictStage {
    pub stage: u8,
    pub content: GitContent,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitComparison {
    pub path: String,
    pub old_path: Option<String>,
    pub version: String,
    pub before: GitContent,
    pub after: GitContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_stages: Option<Vec<GitConflictStage>>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GitSide {
    Staged,
    Unstaged,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GitCommitReferenceKind {
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitReference {
    pub name: String,
    pub kind: GitCommitReferenceKind,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub references: Vec<GitCommitReference>,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    pub roots: Vec<String>,
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub oid: String,
    pub parent: Option<String>,
    pub files: Vec<GitFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub oid: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambiguous: Option<bool>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitMutationResult {
    pub oid: Option<String>,
    pub message: String,
    pub warning: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) enum GitOperation {
    Read,
    LocalMutation,
    RemoteMutation,
}

impl GitOperation {
    fn timeout(self) -> Duration {
        match self {
            Self::Read => READ_TIMEOUT,
            Self::LocalMutation => LOCAL_MUTATION_TIMEOUT,
            Self::RemoteMutation => REMOTE_MUTATION_TIMEOUT,
        }
    }

    fn mutation(self) -> bool {
        !matches!(self, Self::Read)
    }
}

#[derive(Debug)]
pub(crate) struct GitOutput {
    pub stdout: Vec<u8>,
    #[cfg(all(test, unix))]
    pub stderr: Vec<u8>,
}

pub(crate) fn unignored_files(project: &AgentProject) -> Result<Option<Vec<u8>>, GitError> {
    match execute(
        project,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "--deduplicate",
            "-z",
        ],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => Ok(Some(output.stdout)),
        Err(error) if error.code == "notRepo" => Ok(None),
        Err(error) => Err(error),
    }
}

fn ssh_connection(project: &AgentProject) -> Result<&crate::ssh::SshConnection, GitError> {
    project
        .environment
        .ssh
        .as_ref()
        .ok_or_else(|| GitError::new("inaccessible", "Connexion SSH absente."))
}

#[cfg(windows)]
pub(crate) fn run_wsl_readonly(
    project: &AgentProject,
    script: &str,
    stdin: &[u8],
) -> Result<Vec<u8>, GitError> {
    if stdin.len() > WSL_READONLY_STDIN_LIMIT {
        return Err(GitError::new(
            "inputTooLarge",
            "L’entrée WSL dépasse la limite de 8 Mio.",
        ));
    }
    let distribution = project
        .environment
        .distribution
        .as_deref()
        .filter(|distribution| !distribution.is_empty())
        .ok_or_else(|| GitError::new("wsl", "Distribution WSL absente."))?;
    run_command(
        wsl_readonly_command(distribution, script),
        READ_TIMEOUT,
        false,
        Some(stdin),
    )
    .map(|output| output.stdout)
}

#[cfg(not(windows))]
pub(crate) fn run_wsl_readonly(
    _project: &AgentProject,
    _script: &str,
    _stdin: &[u8],
) -> Result<Vec<u8>, GitError> {
    Err(GitError::new(
        "wsl",
        "L’exécution WSL est uniquement disponible sous Windows.",
    ))
}

pub(crate) fn execute(
    project: &AgentProject,
    args: &[&str],
    operation: GitOperation,
    stdin: Option<&[u8]>,
) -> Result<GitOutput, GitError> {
    if operation.mutation() {
        require_idle()?;
    }
    #[cfg(test)]
    TEST_GIT_COMMANDS.with(|count| count.set(count.get() + 1));
    let result = if project.environment.kind == "ssh" {
        ssh_git_execute(
            project,
            args,
            operation.timeout(),
            operation.mutation(),
            stdin,
        )
    } else {
        #[cfg(windows)]
        let accelerated = if matches!(operation, GitOperation::Read)
            || (matches!(operation, GitOperation::LocalMutation) && args.first() == Some(&"switch"))
        {
            wsl_read::execute_if_enabled(
                project,
                args,
                stdin,
                operation.timeout(),
                operation.mutation(),
                || {
                    run_command(
                        git_command(project, args)?,
                        operation.timeout(),
                        operation.mutation(),
                        stdin,
                    )
                },
            )
        } else {
            None
        };
        #[cfg(not(windows))]
        let accelerated: Option<Result<GitOutput, GitError>> = None;
        accelerated.unwrap_or_else(|| {
            run_command(
                git_command(project, args)?,
                operation.timeout(),
                operation.mutation(),
                stdin,
            )
        })
    };
    if result
        .as_ref()
        .is_err_and(|error| matches!(error.code.as_str(), "missing" | "old"))
    {
        invalidate_version(project);
    }
    result.map_err(|mut error| {
        if error.code == "nonFastForward"
            && args.contains(&"push")
            && args.contains(&"--porcelain")
            && args
                .iter()
                .position(|argument| *argument == "--set-upstream")
                .is_some_and(|index| index + 3 == args.len() && args[index + 2].contains(':'))
        {
            error.uncertain = None;
        }
        error
    })
}

const IO_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const MUTATION_SAFE: u8 = 0;
const MUTATION_UNCONFIRMED: u8 = 1;
const MUTATION_WSL_UNCONFIRMED: u8 = 2;
const MUTATION_SSH_UNCONFIRMED: u8 = 3;
static MUTATION_SAFETY: AtomicU8 = AtomicU8::new(MUTATION_SAFE);

pub(crate) fn require_idle() -> Result<(), GitError> {
    match MUTATION_SAFETY.load(Ordering::Acquire) {
        MUTATION_SAFE => Ok(()),
        MUTATION_WSL_UNCONFIRMED => Err(GitError::command(
            "uncertain",
            "Une commande Git WSL a expiré. Vérifiez sa terminaison hors de Soreno puis redémarrez l’application avant toute mutation.",
            true,
        )),
        MUTATION_SSH_UNCONFIRMED => Err(GitError::command(
            "uncertain",
            "Une commande Git SSH a expiré sans confirmation de sa terminaison distante. Vérifiez-la sur l’hôte puis redémarrez l’application avant toute mutation.",
            true,
        )),
        _ => Err(GitError::command(
            "uncertain",
            "La terminaison d’une commande Git expirée n’a pas pu être confirmée. Redémarrez l’application avant toute mutation.",
            true,
        )),
    }
}

fn block_mutations(wsl: bool, ssh: bool) {
    MUTATION_SAFETY.fetch_max(
        if ssh {
            MUTATION_SSH_UNCONFIRMED
        } else if wsl {
            MUTATION_WSL_UNCONFIRMED
        } else {
            MUTATION_UNCONFIRMED
        },
        Ordering::AcqRel,
    );
}

#[cfg(windows)]
fn is_wsl_command(command: &Command) -> bool {
    command
        .get_program()
        .to_string_lossy()
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|program| program.eq_ignore_ascii_case("wsl.exe"))
}

#[cfg(not(windows))]
fn is_wsl_command(_command: &Command) -> bool {
    false
}

fn is_ssh_command(command: &Command) -> bool {
    command.get_envs().any(|(name, value)| {
        name == "SORENO_GIT_SSH_COMMAND" && value.is_some_and(|value| value == "1")
    })
}

#[cfg(test)]
fn profile_command_label(command: &Command) -> String {
    let args = command
        .get_args()
        .map(|argument| argument.to_string_lossy())
        .collect::<Vec<_>>();
    let mut index = args
        .iter()
        .position(|argument| argument == "git")
        .map_or(0, |index| index + 1);
    let subcommand = loop {
        let Some(argument) = args.get(index) else {
            break "other";
        };
        match argument.as_ref() {
            "-c" | "-C" => index += 2,
            "--version" => break "version",
            argument if argument.starts_with('-') => index += 1,
            argument => {
                break match argument {
                    "branch" | "cat-file" | "config" | "diff" | "diff-files" | "diff-index"
                    | "diff-tree" | "for-each-ref" | "log" | "ls-files" | "ls-tree"
                    | "merge-base" | "remote" | "rev-list" | "rev-parse" | "show" | "stash"
                    | "status" => argument,
                    _ => "other",
                };
            }
        }
    };
    format!(
        "{}:{subcommand}",
        if is_ssh_command(command) {
            "ssh"
        } else if is_wsl_command(command) {
            "wsl"
        } else {
            "local"
        }
    )
}

#[cfg(all(test, unix))]
fn log_command_profile(
    label: &str,
    total: Duration,
    spawn: Duration,
    ownership: Duration,
    io_start: Duration,
    process_wait: Duration,
    io_receive: Duration,
    _owner: &ProcessOwner,
) {
    eprintln!(
        "GIT_PROFILE command={label} total={:.3}ms spawn={:.3}ms ownership={:.3}ms io_start={:.3}ms process_wait={:.3}ms io_receive={:.3}ms",
        total.as_secs_f64() * 1_000.0,
        spawn.as_secs_f64() * 1_000.0,
        ownership.as_secs_f64() * 1_000.0,
        io_start.as_secs_f64() * 1_000.0,
        process_wait.as_secs_f64() * 1_000.0,
        io_receive.as_secs_f64() * 1_000.0,
    );
}

#[cfg(all(test, windows))]
fn log_command_profile(
    label: &str,
    total: Duration,
    spawn: Duration,
    ownership: Duration,
    io_start: Duration,
    process_wait: Duration,
    io_receive: Duration,
    owner: &ProcessOwner,
) {
    eprintln!(
        "GIT_PROFILE command={label} total={:.3}ms spawn={:.3}ms ownership={:.3}ms ownership_job={:.3}ms ownership_snapshot={:.3}ms ownership_enumeration_resume={:.3}ms io_start={:.3}ms process_wait={:.3}ms io_receive={:.3}ms",
        total.as_secs_f64() * 1_000.0,
        spawn.as_secs_f64() * 1_000.0,
        ownership.as_secs_f64() * 1_000.0,
        owner.profile_job().as_secs_f64() * 1_000.0,
        owner.profile_snapshot().as_secs_f64() * 1_000.0,
        owner.profile_enumeration_resume().as_secs_f64() * 1_000.0,
        io_start.as_secs_f64() * 1_000.0,
        process_wait.as_secs_f64() * 1_000.0,
        io_receive.as_secs_f64() * 1_000.0,
    );
}

#[cfg(windows)]
fn wait_for_child_exit(child: &std::process::Child, deadline: Instant) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    let timeout = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .clamp(1, u32::MAX as u128) as u32;
    unsafe {
        WaitForSingleObject(child.as_raw_handle() as _, timeout);
    }
}

#[cfg(not(windows))]
fn wait_for_child_exit(_child: &std::process::Child, deadline: Instant) {
    thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now())));
}

fn kill_unowned_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let deadline = Instant::now() + IO_STOP_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => wait_for_child_exit(child, deadline),
        }
    }
}

fn run_command(
    mut command: Command,
    timeout: Duration,
    mutation: bool,
    stdin: Option<&[u8]>,
) -> Result<GitOutput, GitError> {
    if stdin.is_some_and(|data| data.len() > STDIN_LIMIT) {
        return Err(GitError::new(
            "inputTooLarge",
            "L’entrée Git dépasse la limite de 8 Mio.",
        ));
    }
    let read_deadline = if mutation {
        None
    } else {
        check_read_deadline()?;
        read_deadline()
    };
    #[cfg(test)]
    let profile = std::env::var_os("SORENO_PROFILE_GIT").is_some();
    #[cfg(test)]
    let profile_label = profile.then(|| profile_command_label(&command));
    #[cfg(test)]
    let profile_total_started = Instant::now();
    let wsl = is_wsl_command(&command);
    let ssh = is_ssh_command(&command);
    ProcessOwner::configure(&mut command);
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(test)]
    let profile_spawn_started = Instant::now();
    let mut child = command.spawn().map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "inaccessible"
        };
        GitError::command(
            code,
            format!("Impossible de lancer Git : {error}"),
            mutation,
        )
    })?;
    #[cfg(test)]
    let profile_spawn = profile_spawn_started.elapsed();
    #[cfg(test)]
    let profile_ownership_started = Instant::now();
    let mut owner = ProcessOwner::new(&child).map_err(|error| {
        kill_unowned_child(&mut child);
        block_mutations(wsl, ssh);
        GitError::command(
            "inaccessible",
            format!("Impossible d’isoler le processus Git : {error}"),
            mutation,
        )
    })?;
    #[cfg(test)]
    let profile_ownership = profile_ownership_started.elapsed();
    #[cfg(test)]
    let profile_io_start_started = Instant::now();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GitError::command("io", "Sortie standard Git indisponible.", mutation))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| GitError::command("io", "Sortie d’erreur Git indisponible.", mutation))?;
    let writer = if stdin.is_some() {
        Some(child.stdin.take().ok_or_else(|| {
            GitError::command("io", "Entrée standard Git indisponible.", mutation)
        })?)
    } else {
        None
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let stdout_cancelled = Arc::clone(&cancelled);
    let stderr_cancelled = Arc::clone(&cancelled);
    let mut stdout_task = spawn_io(stdout, move |stdout| {
        drain_pipe(stdout, DATA_LIMIT, &stdout_cancelled)
    });
    let mut stderr_task = spawn_io(stderr, move |stderr| {
        drain_pipe(stderr, LOG_LIMIT, &stderr_cancelled)
    });
    let input = stdin.map(Vec::from);
    let mut stdin_task = writer.map(|writer| {
        let cancelled = Arc::clone(&cancelled);
        spawn_io(writer, move |writer| {
            write_pipe(writer, input.as_deref().unwrap_or_default(), &cancelled)
        })
    });
    #[cfg(test)]
    let profile_io_start = profile_io_start_started.elapsed();

    let command_deadline = Instant::now() + timeout;
    let (deadline, read_budget_expires_first) =
        bounded_by_read_deadline(read_deadline, command_deadline);
    #[cfg(test)]
    let profile_process_wait_started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => wait_for_child_exit(&child, deadline),
            result => {
                let wait_error = result.err();
                let terminated = owner.terminate(&mut child, IO_STOP_TIMEOUT);
                cancelled.store(true, Ordering::Release);
                let io_deadline = Instant::now() + IO_STOP_TIMEOUT;
                let streams_stopped = stop_io(&mut stdout_task, io_deadline)
                    & stop_io(&mut stderr_task, io_deadline)
                    & stdin_task
                        .as_mut()
                        .is_none_or(|task| stop_io(task, io_deadline));
                if mutation && (ssh || wsl || !terminated || !streams_stopped) {
                    block_mutations(wsl, ssh);
                }
                let detail = wait_error
                    .as_ref()
                    .map(|error| format!(" ({error})"))
                    .unwrap_or_default();
                return Err(if wait_error.is_none() && read_budget_expires_first {
                    read_timeout_error()
                } else {
                    GitError::command(
                        if wait_error.is_some() {
                            "io"
                        } else {
                            "timeout"
                        },
                        format!("Git a dépassé son délai d’exécution{detail}."),
                        mutation,
                    )
                });
            }
        }
    };
    if ssh && mutation && (status.code() == Some(255) || status.code().is_none()) {
        block_mutations(wsl, ssh);
    }
    #[cfg(test)]
    let profile_process_wait = profile_process_wait_started.elapsed();
    #[cfg(test)]
    let profile_io_receive_started = Instant::now();

    let stdin_result = stdin_task
        .as_mut()
        .map(|task| receive_io(task, deadline, "Impossible d’écrire vers Git", mutation))
        .transpose();
    let stdout_result = receive_io(
        &mut stdout_task,
        deadline,
        "Impossible de lire la sortie Git",
        mutation,
    );
    let stderr_result = receive_io(
        &mut stderr_task,
        deadline,
        "Impossible de lire la sortie Git",
        mutation,
    );
    #[cfg(test)]
    let profile_io_receive = profile_io_receive_started.elapsed();
    if stdin_result.is_err() || stdout_result.is_err() || stderr_result.is_err() {
        let terminated = owner.terminate(&mut child, IO_STOP_TIMEOUT);
        cancelled.store(true, Ordering::Release);
        let io_deadline = Instant::now() + IO_STOP_TIMEOUT;
        let streams_stopped = stop_io(&mut stdout_task, io_deadline)
            & stop_io(&mut stderr_task, io_deadline)
            & stdin_task
                .as_mut()
                .is_none_or(|task| stop_io(task, io_deadline));
        if mutation && (ssh || wsl || !terminated || !streams_stopped) {
            block_mutations(wsl, ssh);
        }
    }
    if read_budget_expires_first
        && Instant::now() >= deadline
        && (stdin_result
            .as_ref()
            .is_err_and(|error| error.code == "timeout")
            || stdout_result
                .as_ref()
                .is_err_and(|error| error.code == "timeout")
            || stderr_result
                .as_ref()
                .is_err_and(|error| error.code == "timeout"))
    {
        return Err(read_timeout_error());
    }
    #[cfg(test)]
    if let Some(label) = profile_label.as_deref() {
        log_command_profile(
            label,
            profile_total_started.elapsed(),
            profile_spawn,
            profile_ownership,
            profile_io_start,
            profile_process_wait,
            profile_io_receive,
            &owner,
        );
    }
    let stdout = stdout_result?;
    let stderr = stderr_result?;
    if stdout.truncated {
        return Err(GitError::command(
            "outputTooLarge",
            "La sortie Git dépasse la limite de 8 Mio.",
            mutation,
        ));
    }
    if !status.success() {
        return Err(command_failure(status, stderr, stdout.bytes, mutation));
    }
    stdin_result?;
    Ok(GitOutput {
        stdout: stdout.bytes,
        #[cfg(all(test, unix))]
        stderr: stderr.bytes,
    })
}

fn receive_io<T>(
    task: &mut IoThread<T>,
    deadline: Instant,
    context: &str,
    mutation: bool,
) -> Result<T, GitError> {
    match task.receive(deadline) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(GitError::command(
            "io",
            format!("{context} : {error}"),
            mutation,
        )),
        Err(RecvTimeoutError::Timeout) => Err(GitError::command(
            "timeout",
            "Git a dépassé son délai pendant la fermeture de ses flux.",
            mutation,
        )),
        Err(RecvTimeoutError::Disconnected) => Err(GitError::command(
            "io",
            format!("{context} : tâche interrompue"),
            mutation,
        )),
    }
}

#[path = "project_git/branches.rs"]
mod branches;
#[path = "project_git/command_builder.rs"]
mod command_builder;
#[path = "project_git/command_error.rs"]
mod command_error;
#[path = "project_git/commit_message.rs"]
mod commit_message;
#[path = "project_git/discovery.rs"]
mod discovery;
#[path = "project_git/facade.rs"]
mod facade;
#[path = "project_git/history.rs"]
mod history;
#[path = "project_git/mutations.rs"]
pub(crate) mod mutations;
#[path = "project_git/object_hash.rs"]
pub(crate) mod object_hash;
#[path = "project_git/process_io.rs"]
mod process_io;
#[path = "project_git/read_budget.rs"]
mod read_budget;
#[path = "project_git/reading.rs"]
mod reading;
#[path = "project_git/remotes.rs"]
mod remotes;
#[path = "project_git/requests.rs"]
mod requests;
#[path = "project_git/restore.rs"]
mod restore;
#[path = "project_git/setup.rs"]
mod setup;
#[path = "project_git/ssh_transport.rs"]
mod ssh_transport;
#[cfg(test)]
#[path = "project_git/test_fixtures.rs"]
pub(crate) mod test_fixtures;
#[path = "project_git/validation.rs"]
mod validation;
#[cfg(windows)]
#[path = "project_git/wsl_read.rs"]
mod wsl_read;

pub(crate) use branches::{
    create_branch, create_worktree, merge_worktree, remove_branch, remove_worktree, switch_branch,
    GitWorktreeRequest,
};
pub(crate) use command_builder::git_command;
#[cfg(any(windows, test))]
use command_builder::wsl_readonly_command;
use command_error::{command_failure, failure_code};
pub(crate) use commit_message::generate;
pub(crate) use discovery::discover_repository;
#[cfg(test)]
pub(crate) use discovery::reset_test_git_version;
use discovery::{empty_repository, invalidate_version, parse_version, version};
#[cfg(test)]
use discovery::{environment_key, parse_fast_metadata, read_text, version_cache};
pub(crate) use facade::{
    branch_hint, branches, commit_comparison, commit_detail, comparison, discover_worktrees,
    first_remote_url, history, path_prefix, preview_comparison, range_comparison, remotes,
    repository, repository_state, worktrees,
};
#[cfg(test)]
use facade::{branch_hint_from, branch_hint_read};
pub(crate) use mutations::{commit, quick_commit, resolve, set_identity, stage, unstage};
#[cfg(test)]
use process_io::drain;
use process_io::{drain_pipe, spawn_io, stop_io, write_pipe, Captured, IoThread};
#[cfg(any(windows, test))]
use read_budget::with_read_deadline;
use read_budget::{
    bounded_by_read_deadline, check_read_deadline, read_deadline, read_timeout_error,
    with_read_budget, READ_DEADLINE,
};
pub(crate) use reading::take_snapshot_stats;
pub(crate) use remotes::{fetch, pull, push};
pub(crate) use requests::{
    request_changes, request_checkout, GitCheckoutBranch, GitRangeChanges, RequestSource,
};
pub(crate) use restore::restore;
pub(crate) use setup::{clone, init, GitCloneRequest};
use ssh_transport::ssh_git_execute;
#[cfg(test)]
use ssh_transport::ssh_transport_error_code;
pub(super) use validation::remote_path_is_directory;
pub(crate) use validation::{oid_output, validate_oid, validate_ref_name, validate_relative_path};

#[cfg(test)]
#[path = "project_git_tests.rs"]
mod tests;
