//! OMP conversation sessions: the user's `omp --mode rpc-ui`, driven through JSON lines over
//! pipes instead of a terminal; the view renders the conversation natively.
mod chunks;
mod history;
mod remote_group;
mod state;

use super::{
    attachments::{cleanup_attachment_directory, write_local_prompt_attachments},
    conversations::{history_files, AgentTurn, HistoryFile},
    dtach_history::{HistoryFraming, Segment},
    idle, lock, message_preview, remote_dtach,
    remote_host::{self, RemoteHost},
    AgentConversation, AgentEnvironment, AgentProject, AgentSessionStatus, PromptAttachment,
    RemoteClipboard, Result, MISSING_EXECUTABLE_EXIT_CODE,
};
use crate::process_owner::ProcessOwner;
use chunks::{reassemble, Chunks};
use history::{history_entry, validate_switch};
use remote_group::{stop_group_script, GroupScan, GROUP_MARKER};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock, TryLockError},
    thread,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;

pub(super) const KIND: &str = "conversation";
pub(super) const EXECUTABLE: &str = "omp-conversation";
const STOPPED: &str = "Conversation OMP arrêtée.";
const INSTRUCTION_FILENAME: &str = "soreno.ts";
const CONFIG_FILENAME: &str = "soreno.yml";
/// OMP's default continues an active goal only in its terminal view: `/goal` would never start.
const CONFIG: &str = "goal:\n  continuationModes:\n    - rpc\n";
const STDERR_LIMIT: usize = 16 * 1024;
/// Pasted images travel inline, base64-encoded, in the prompt record.
const COMMAND_LIMIT: usize = 32 * 1024 * 1024;
const HISTORY_TITLES: usize = 500;
/// Delivered messages stay well within OMP's 1 MiB inbound frame.
pub(super) const DELIVERY_LIMIT: usize = 512 * 1024;
const GRACEFUL_EXIT: Duration = Duration::from_secs(3);
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
const REMOTE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// A reattached run replays its recent output before taking input.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(30);
/// What dtach prints when its session ends; OMP's own stderr shares that terminal.
const DTACH_EOF: &str = "[EOF - dtach terminating]";
const POLL: Duration = Duration::from_millis(25);
/// Ids of the requests Soreno sends itself: the view may not use them, their responses stay here.
const HOST_PREFIX: &str = "soreno-host-";
const STATE_PREFIX: &str = "soreno-host-state-";
const DELIVERY_PREFIX: &str = "soreno-host-deliver-";
const TITLE_PREFIX: &str = "soreno-host-title-";
/// Follows each dialog answer to a run under dtach, which echoes no input: its response tells a
/// reattached host that the dialog is no longer pending.
const ANSWERED_PREFIX: &str = "soreno-host-answered-";
const HANDSHAKE: [&str; 4] = [
    r#"{"id":"soreno-host-protocol","type":"negotiate_protocol","protocolVersion":2}"#,
    r#"{"id":"soreno-host-ask","type":"set_ask_dialog","enabled":true}"#,
    // Delta updates: full snapshots repeat the whole partial reply in every `message_update`.
    r#"{"id":"soreno-host-filter","type":"set_event_filter","events":null,"messageUpdates":"delta"}"#,
    r#"{"id":"soreno-host-subagents","type":"set_subagent_subscription","level":"progress"}"#,
];
/// OMP RPC commands the view may send; anything else is refused.
const COMMANDS: &[&str] = &[
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "abort_and_restore_queue",
    "new_session",
    "switch_session",
    "get_state",
    "get_messages",
    "get_session_stats",
    "get_available_models",
    "get_available_commands",
    "set_model",
    "get_available_thinking_levels",
    "set_thinking_level",
    "get_subagents",
    "cancel_subagent",
    "extension_ui_response",
    "remove_queued_message",
    "set_session_name",
    "goal",
    "btw",
    "btw_cancel",
    "get_btw_history",
];
/// Extension UI requests that block OMP until answered: replayed to a late subscriber.
const DIALOGS: &[&str] = &["select", "confirm", "input", "editor", "ask"];
/// Presentation requests the view has no surface for.
const HIDDEN_UI: &[&str] = &["setStatus", "setWidget", "setTitle", "set_editor_text"];

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_omp_conversations (session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);",
    )
    .map_err(|error| error.to_string())
}

/// A session that stops being a conversation forgets the one it held.
pub(super) fn forget(db: &Connection, session_id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM agent_omp_conversations WHERE session_id=?1",
        [session_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Conversation {
    session_id: String,
    session_file: Option<String>,
    name: Option<String>,
}
impl Conversation {
    /// OMP is trusted, but its paths reach the next launch: keep them plausible.
    fn validated(mut self) -> Option<Self> {
        let valid_id = !self.session_id.is_empty()
            && self.session_id.len() <= 128
            && !self.session_id.contains('\0');
        let valid_file = self.session_file.as_deref().is_none_or(|file| {
            file.len() <= 4096
                && !file.contains('\0')
                && (file.starts_with('/') || Path::new(file).is_absolute())
        });
        self.name = self.name.as_deref().and_then(clean_name);
        (valid_id && valid_file).then_some(self)
    }
}

/// First line, without control characters, of at most 512 characters.
fn clean_name(text: &str) -> Option<String> {
    let name: String = text
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn stored(db: &Connection, session_id: &str) -> Result<Option<Conversation>> {
    db.query_row(
        "SELECT data FROM agent_omp_conversations WHERE session_id=?1",
        [session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .map(|data| serde_json::from_str(&data).map_err(|error| error.to_string()))
    .transpose()
}

/// Persists the conversation the live run reports, then returns the latest known one.
pub(super) fn reconcile(
    db: &Connection,
    session_id: &str,
    runtime: Option<&ConversationProcess>,
) -> Result<Option<Conversation>> {
    let saved = stored(db, session_id)?;
    let live = match runtime {
        Some(runtime) => lock(&runtime.state)?.conversation.clone(),
        None => None,
    };
    match live {
        Some(live) if saved.as_ref() != Some(&live) => {
            db.execute(
                "INSERT INTO agent_omp_conversations(session_id, data) VALUES (?1, ?2)
                ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
                params![
                    session_id,
                    serde_json::to_string(&live).map_err(|error| error.to_string())?
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(Some(live))
        }
        _ => Ok(saved),
    }
}

pub(super) fn status(
    db: &Connection,
    session_id: &str,
    runtime: Option<&ConversationProcess>,
) -> Result<AgentSessionStatus> {
    let conversation = reconcile(db, session_id, runtime)?;
    let mut status = match runtime {
        Some(runtime) => runtime.run_status(session_id)?,
        None => idle(session_id),
    };
    let turn = match runtime {
        Some(runtime) => lock(&runtime.state)?.turn.clone(),
        None => None,
    };
    if let Some(turn) = turn {
        status.issue_summary = super::kanban_issue_sessions::pending_summary(db, session_id, turn)?;
    }
    let linked = conversation
        .as_ref()
        .is_some_and(|conversation| conversation.session_file.is_some());
    status.resume = if linked { "linked" } else { "new" }.into();
    status.conversation = conversation.map(|conversation| AgentConversation {
        provider: EXECUTABLE.into(),
        session_id: conversation.session_id,
        session_file: conversation.session_file,
        name: conversation.name,
    });
    Ok(status)
}

/// `cd`, the 209 exit of a missing `omp`, then `omp` itself; no positional parameters, which
/// fish lacks.
fn omp_script(directory: &str, resume: Option<&str>, launch_args: &[String]) -> String {
    let omp: String = launch_args
        .iter()
        .fold("exec omp --mode rpc-ui".into(), |omp, arg| {
            format!("{omp} {}", crate::ssh::quote(arg))
        });
    // OMP writes a conversation's file only with its first message: a conversation left
    // empty has none, and resuming it would fail, so it starts afresh instead.
    let resume = resume
        .map(|file| {
            let file = crate::ssh::quote(file);
            format!(" test -f {file} && {omp} --resume {file};")
        })
        .unwrap_or_default();
    format!(
        "cd -- {} || exit 1; command -v omp >/dev/null 2>&1 || exit {MISSING_EXECUTABLE_EXIT_CODE};{resume} {omp}",
        crate::ssh::quote(directory)
    )
}

/// `omp_script` in the user's login shell.
fn launch_script(directory: &str, resume: Option<&str>, launch_args: &[String]) -> String {
    crate::ssh::login_shell_script(&omp_script(directory, resume, launch_args))
}

/// `launch_args` plus an extension telling OMP to request Kanban issues through files in the run's
/// private directory, and, with `config`, the config overlay that lets a goal run; like terminal
/// agents, the run starts without them when they cannot be written. With `link` (run token,
/// metadata path), the extension also publishes the conversation's metadata. `attachments` go in
/// the same directory, which the returned `initial_prompt` names; they cannot be left out.
#[allow(clippy::too_many_arguments)]
fn with_instruction(
    environment: &AgentEnvironment,
    launch_args: &[String],
    local: Option<&Path>,
    remote: Option<&RemoteClipboard>,
    config: bool,
    link: Option<(&str, &str)>,
    initial_prompt: Option<&str>,
    attachments: &[PromptAttachment],
) -> Result<(Vec<String>, Option<String>)> {
    let files = |directory: &str| {
        let mut files = vec![PromptAttachment {
            filename: INSTRUCTION_FILENAME.into(),
            bytes: super::conversations::system_append_extension(
                &super::issue_requests::instruction(directory),
                link,
            )
            .into_bytes(),
        }];
        if config {
            files.push(PromptAttachment {
                filename: CONFIG_FILENAME.into(),
                bytes: CONFIG.into(),
            });
        }
        files
    };
    let prompt = match (local, remote) {
        (Some(directory), _) => directory
            .to_str()
            .ok_or_else(|| "Chemin temporaire local non UTF-8.".to_string())
            .and_then(|path| super::agent_local_path(environment, path.to_owned()))
            .and_then(|agent_directory| {
                write_local_prompt_attachments(
                    directory,
                    files(&agent_directory).iter().chain(attachments),
                )
            })
            .and_then(|prompt| super::agent_local_path(environment, prompt)),
        // Beside, not inside, the directory: a new dtach session recreates that one.
        (None, Some(remote)) => remote.ensure_directory().and_then(|directory| {
            remote.upload_prompt_files(files(&directory).iter().chain(attachments))
        }),
        (None, None) => Err("Dossier temporaire indisponible.".into()),
    };
    let initial_prompt = match (&prompt, initial_prompt) {
        (Ok(directory), Some(message)) if !attachments.is_empty() => Some(
            super::prompt_with_attachments(message, directory, attachments),
        ),
        (Err(error), Some(_)) if !attachments.is_empty() => return Err(error.clone()),
        (_, message) => message.map(str::to_owned),
    };
    let mut args = launch_args.to_vec();
    if let Ok(prompt) = prompt {
        args.extend(["-e".into(), format!("{prompt}/{INSTRUCTION_FILENAME}")]);
        if config {
            args.extend(["--config".into(), format!("{prompt}/{CONFIG_FILENAME}")]);
        }
    }
    Ok((args, initial_prompt))
}

/// `omp_script` in a raw terminal for a dtach run; the config overlay goes into the run's
/// `session` directory, which, unlike a prompt directory, lives as long as the run: OMP rereads
/// it after Soreno detaches.
fn detachable_script(
    session: Option<&str>,
    directory: &str,
    resume: Option<&str>,
    launch_args: &[String],
) -> String {
    let mut launch_args = launch_args.to_vec();
    let config = session
        .map(|session| {
            let path = format!("{session}/{CONFIG_FILENAME}");
            let write = format!(
                "printf %s {} > {} || exit 1; ",
                crate::ssh::quote(CONFIG),
                crate::ssh::quote(&path)
            );
            launch_args.extend(["--config".into(), path]);
            write
        })
        .unwrap_or_default();
    // Raw, the terminal passes JSON lines untouched: no echo, line limit or CR.
    format!(
        "stty raw -echo -iexten; {config}{}",
        omp_script(directory, resume, &launch_args)
    )
}

/// Starts `omp` in the project's environment, resuming `conversation` when it has a history.
/// `local_files` receives the files attached by path to a local or WSL run; `label` lists a
/// dtach run on the server. `attachments` accompany `initial_prompt`.
#[allow(clippy::too_many_arguments)]
pub(super) fn start(
    project: &AgentProject,
    session_id: &str,
    label: &str,
    conversation: Option<Conversation>,
    initial_prompt: Option<&str>,
    attachments: &[PromptAttachment],
    launch_args: &[String],
    run_token: String,
    local_files: Option<PathBuf>,
) -> Result<Arc<ConversationProcess>> {
    let directory = project.path.as_str();
    let local = project.environment.kind == "local";
    // A local history must still exist; a remote one is trusted.
    let conversation = conversation.filter(|conversation| {
        conversation
            .session_file
            .as_deref()
            .is_some_and(|file| !local || Path::new(file).is_file())
    });
    let resume = conversation
        .as_ref()
        .and_then(|conversation| conversation.session_file.as_deref());
    let (process, initial_prompt) = match project.environment.kind.as_str() {
        "ssh" => {
            crate::ssh::validate_path(directory)?;
            let connection = project
                .environment
                .ssh
                .as_ref()
                .ok_or("Connexion SSH manquante.")?;
            // An unsupported server keeps a run that ends with the connection.
            if let Some(dtach) = remote_dtach::ensure(connection)
                .ok()
                .filter(|dtach| remote_dtach::linux(dtach))
            {
                return start_detachable(
                    project,
                    session_id,
                    label,
                    &dtach,
                    conversation,
                    initial_prompt,
                    attachments,
                    launch_args,
                    run_token,
                );
            }
            let access = crate::ssh::begin_access(connection)?;
            let files = RemoteClipboard::new(connection.clone(), None);
            let (launch_args, initial_prompt) = with_instruction(
                &project.environment,
                launch_args,
                None,
                Some(&files),
                true,
                None,
                initial_prompt,
                attachments,
            )?;
            // Written before `exec`, the nonce never reaches OMP's environment or arguments.
            let nonce: String = rusqlite::Connection::open_in_memory()
                .and_then(|db| crate::sqlite::random_id(&db))
                .map_err(|error| error.to_string())?;
            let script = format!(
                "printf '{GROUP_MARKER}{nonce}:%s\\n' \"$(ps -o pgid= -p $$)\" >&2; {}",
                launch_script(directory, resume, &launch_args)
            );
            let command = crate::ssh::command(connection, &script)?;
            let process = ConversationProcess::spawn(
                command,
                run(run_token),
                access,
                Some((connection.clone(), nonce)),
            )?;
            let _ = process.remote_files.set(files);
            (process, initial_prompt)
        }
        "wsl" => {
            let (launch_args, initial_prompt) = with_instruction(
                &project.environment,
                launch_args,
                local_files.as_deref(),
                None,
                true,
                None,
                initial_prompt,
                attachments,
            )?;
            #[cfg(windows)]
            {
                let wsl = super::WslRun::prepare(project, directory)?;
                let mut command = crate::subscription_usage::wsl_command(
                    &wsl.distribution,
                    &format!("exec env {}", super::WSL_RUN_GATE),
                );
                command.args([
                    "soreno",
                    &wsl.directory,
                    &omp_script(directory, resume, &launch_args),
                ]);
                (
                    ConversationProcess::spawn(command, Some(wsl), (), None)?,
                    initial_prompt,
                )
            }
            #[cfg(not(windows))]
            {
                let _ = (launch_args, initial_prompt);
                return Err("WSL n’est disponible que sous Windows.".into());
            }
        }
        _ => {
            super::validate_local_directory(directory)?;
            let (launch_args, initial_prompt) = with_instruction(
                &project.environment,
                launch_args,
                local_files.as_deref(),
                None,
                true,
                None,
                initial_prompt,
                attachments,
            )?;
            #[cfg(unix)]
            let mut command = Command::new("/bin/sh");
            #[cfg(unix)]
            command.args(["-c", &launch_script(directory, resume, &launch_args)]);
            #[cfg(windows)]
            let mut command = Command::new("powershell.exe");
            #[cfg(windows)]
            {
                let args = ["--mode", "rpc-ui"]
                    .into_iter()
                    .map(String::from)
                    .chain(launch_args)
                    .chain(
                        resume
                            .into_iter()
                            .flat_map(|file| ["--resume".into(), file.into()]),
                    )
                    .collect::<Vec<String>>();
                let launcher = super::windows_launcher("omp", &args, true)?;
                command.args(["-NoLogo", "-EncodedCommand", &launcher]);
            }
            command.current_dir(directory);
            (
                ConversationProcess::spawn(command, run(run_token), (), None)?,
                initial_prompt,
            )
        }
    };
    lock(&process.state)?.conversation = conversation;
    *lock(&process.local_files)? = local_files;
    let started = HANDSHAKE
        .iter()
        .try_for_each(|line| process.write_line(line))
        .and_then(|()| process.request_state())
        .and_then(|()| match initial_prompt.as_deref() {
            Some(message) => process.send(&serde_json::json!({
                "type": "prompt",
                "message": message,
            })),
            None => Ok(()),
        });
    if let Err(error) = started {
        // A script that exited first (`omp` missing, say) shows its status instead.
        if process.wait_exit(KILL_TIMEOUT) {
            return Ok(process);
        }
        let _ = process.stop();
        return Err(error);
    }
    Ok(process)
}

/// Starts or reattaches an SSH run kept by dtach, which outlives Soreno and the connection.
#[allow(clippy::too_many_arguments)]
fn start_detachable(
    project: &AgentProject,
    session_id: &str,
    label: &str,
    dtach: &str,
    conversation: Option<Conversation>,
    initial_prompt: Option<&str>,
    attachments: &[PromptAttachment],
    launch_args: &[String],
    run_token: String,
) -> Result<Arc<ConversationProcess>> {
    let connection = project
        .environment
        .ssh
        .as_ref()
        .ok_or("Connexion SSH manquante.")?;
    let access = crate::ssh::begin_access(connection)?;
    let host = remote_host::probe(connection, remote_host::CONVERSATIONS, session_id)?;
    let live = host == RemoteHost::Live;
    let files = RemoteClipboard::new(
        connection.clone(),
        Some((remote_host::CONVERSATIONS, session_id.to_owned())),
    );
    // A live run keeps the arguments it started with.
    let (inner, initial_prompt) = if live {
        if !attachments.is_empty() {
            return Err("Une conversation OMP déjà lancée ne reçoit pas de pièces jointes.".into());
        }
        (String::new(), initial_prompt.map(str::to_owned))
    } else {
        let resume = conversation
            .as_ref()
            .and_then(|conversation| conversation.session_file.as_deref());
        let session = files.ensure_directory().ok();
        let session = session
            .as_deref()
            .and_then(|clipboard| clipboard.rsplit_once('/'))
            .map(|(session, _)| session);
        // In the session directory, where the mobile page finds it beside the socket.
        let metadata = session.map(|session| format!("{session}/metadata.json"));
        let (launch_args, initial_prompt) = with_instruction(
            &project.environment,
            launch_args,
            None,
            Some(&files),
            false,
            metadata
                .as_deref()
                .map(|metadata| (run_token.as_str(), metadata)),
            initial_prompt,
            attachments,
        )?;
        (
            detachable_script(session, &project.path, resume, &launch_args),
            initial_prompt,
        )
    };
    let command = crate::ssh::tty_command(
        connection,
        &remote_host::conversation_script(
            dtach,
            host,
            session_id,
            label,
            files.prompt_directory()?.as_deref(),
            &inner,
        ),
    )?;
    let process =
        ConversationProcess::launch(command, run(run_token), access, Transport::Dtach { live })?;
    files.hand_over_prompt_directory();
    let _ = process.remote_files.set(files);
    let opening = {
        let mut state = lock(&process.state)?;
        state.conversation = conversation;
        let mut opening: Vec<String> = HANDSHAKE.iter().map(|line| line.to_string()).collect();
        opening.push(
            serde_json::json!({ "id": state.next_id(STATE_PREFIX), "type": "get_state" })
                .to_string(),
        );
        if let Some(message) = initial_prompt {
            // A live run may be busy.
            opening.push(
                serde_json::json!({
                    "type": "prompt",
                    "message": message,
                    "streamingBehavior": "followUp",
                })
                .to_string(),
            );
        }
        opening
    };
    let opener = Arc::clone(&process);
    thread::spawn(move || opener.open(&opening));
    // The view, once subscribed, must find the dialogs the replay restored.
    if live && !process.wait_open(ATTACH_TIMEOUT) {
        let _ = process.stop();
        return Err("La conversation OMP du serveur SSH ne répond pas.".into());
    }
    Ok(process)
}

/// Text parts of a message, joined; `None` without any text.
fn message_text(message: &Value) -> Option<String> {
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// An assistant message's text, with its timestamp to tell identical replies apart.
fn reply(message: &Value) -> Option<(String, Value)> {
    let timestamp = message.get("timestamp").cloned().unwrap_or_default();
    message_text(message).map(|text| (text, timestamp))
}

/// Stable across a dtach replay, which handles the same `agent_end` again: a summary posts once.
// shortcut: two sessions ending on the same text at the same millisecond share an id, so the second summary is skipped; hash the Soreno session id too if that shows up.
fn turn_id(timestamp: &Value, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(timestamp.to_string());
    hash.update([0]);
    hash.update(text);
    format!("{:x}", hash.finalize())
}

fn has_role(message: &Value, role: &str) -> bool {
    message.get("role").and_then(Value::as_str) == Some(role)
}

/// A past OMP conversation of the project, for the view's resume picker.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryEntry {
    path: String,
    /// Its title slot, else its first user message; `None` when neither is in the first bytes.
    title: Option<String>,
    /// Milliseconds since the Unix epoch.
    modified: u64,
    /// The conversation OMP holds.
    current: bool,
}

/// One page of the resume picker.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct ConversationHistoryPage {
    entries: Vec<ConversationHistoryEntry>,
    /// Older conversations remain past this page.
    more: bool,
}

/// What the reader does with a record once the host saw it.
#[derive(Debug, PartialEq)]
struct Handling {
    forward: bool,
    /// Asks OMP for the conversation identity again.
    refresh: bool,
    /// Asks OMP to title the conversation.
    rename: bool,
}

/// OMP titles conversations only in its TUI: Soreno has `rpc-ui` do it as the TUI would.
#[derive(Default, Debug, PartialEq)]
enum Titling {
    /// Before this process's first `get_state`.
    #[default]
    Unknown,
    /// Named by the user, or by OMP before this run.
    Off,
    Untitled,
    /// Titled by Soreno: refreshed when the agent replans its todos.
    Generated,
}

/// When a run takes input. A run under dtach has a terminal, raw only once OMP runs in it.
#[derive(Default, Debug, PartialEq)]
enum Gate {
    /// A reattached run: input waits for the end of the replay.
    Replay,
    /// A new run: input waits for OMP's `ready`.
    Ready,
    /// The opening records go first.
    Opening,
    #[default]
    Open,
}

#[derive(Default)]
struct State {
    exited: bool,
    exit_code: Option<u32>,
    working: bool,
    conversation: Option<Conversation>,
    /// Process group of the remote run, from its `GROUP_MARKER` line.
    remote_group: Option<u32>,
    gate: Gate,
    /// Soreno ended its client: the run under dtach goes on, or `remote_host::stop` ends it.
    detached: bool,
    /// Name of the conversation until OMP reports one.
    first_message: Option<String>,
    /// Titles of the listed histories, by path: OMP leaves a resumed conversation unnamed.
    titles: HashMap<String, String>,
    /// The listed history the view asked to switch to, with its title.
    resuming: Option<(String, String)>,
    /// Text and timestamp of the latest assistant `message_end`: an oversized `agent_end` drops it.
    last_assistant: Option<(String, Value)>,
    last_message: Option<String>,
    /// The last finished turn, which may carry a Kanban issue summary.
    turn: Option<AgentTurn>,
    subscriber: Option<Channel<String>>,
    /// Unanswered dialog requests, by id, as received.
    dialogs: Vec<(String, String)>,
    stderr: String,
    requests: u64,
    /// Delivered prompts awaiting OMP's acceptance, by request id.
    acknowledgements: HashMap<String, mpsc::Sender<Result<()>>>,
    titling: Titling,
    /// Set by a user message, sent once the agent starts replying, as the TUI does.
    title_pending: bool,
    /// Soreno's `/rename` in flight: its `command_output` is not the user's.
    renaming: bool,
}

/// What the stop sweep targets: the Unix run token, or the Linux side of a WSL run.
#[cfg(unix)]
type Run = String;
#[cfg(windows)]
type Run = Option<super::WslRun>;

#[cfg(unix)]
fn run(token: String) -> Run {
    token
}
#[cfg(windows)]
fn run(_token: String) -> Run {
    None
}

/// How a run's records arrive.
enum Transport {
    /// Its own stdout; an SSH run's connection and the nonce of its group marker.
    Pipes(Option<(crate::ssh::SshConnection, String)>),
    /// The terminal of a dtach session, joined by a new client: `live` when it already ran.
    Dtach { live: bool },
}

/// One running `omp --mode rpc-ui`.
pub(super) struct ConversationProcess {
    stdin: Mutex<Option<ChildStdin>>,
    /// `None` when the run never started.
    process: Mutex<Option<(Child, ProcessOwner)>>,
    state: Mutex<State>,
    #[cfg(unix)]
    run_token: String,
    /// Serializes the stop's and the exit's sweeps: the second finds the run stopped.
    #[cfg(windows)]
    wsl: Mutex<Run>,
    /// The SSH connection of a remote run, to kill it on the server.
    remote: Option<crate::ssh::SshConnection>,
    /// Run under dtach: stopping it here only ends this client.
    persistent: bool,
    /// Where files attached by path go, until the run exits: a local or WSL run's directory,
    /// an SSH run's uploads.
    pub(super) local_files: Mutex<Option<PathBuf>>,
    pub(super) remote_files: OnceLock<RemoteClipboard>,
}

impl ConversationProcess {
    /// `run` marks every Unix descendant for the stop sweep; a Windows job owns the tree, and a
    /// WSL run its Linux processes. `access` (an SSH access guard) lives until the process exits.
    /// `remote` is an SSH run's connection and the nonce of its group marker.
    pub(super) fn spawn(
        command: Command,
        run: Run,
        access: impl Send + 'static,
        remote: Option<(crate::ssh::SshConnection, String)>,
    ) -> Result<Arc<Self>> {
        Self::launch(command, run, access, Transport::Pipes(remote))
    }

    fn launch(
        mut command: Command,
        run: Run,
        access: impl Send + 'static,
        transport: Transport,
    ) -> Result<Arc<Self>> {
        let (remote, mut scan, dtach) = match transport {
            Transport::Pipes(Some((connection, nonce))) => {
                (Some(connection), Some(GroupScan::new(&nonce)), None)
            }
            Transport::Pipes(None) => (None, None, None),
            Transport::Dtach { live } => (None, None, Some(live)),
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.env("SORENO_AGENT_RUN", &run);
        ProcessOwner::configure(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return Err(format!("Impossible de lancer omp : {error}")),
        };
        let owner = match ProcessOwner::new(&child) {
            Ok(owner) => owner,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Impossible de surveiller omp : {error}"));
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Sortie d’omp indisponible.")?;
        let mut stderr = child.stderr.take().ok_or("Erreurs d’omp indisponibles.")?;
        let process = Arc::new(Self {
            stdin: Mutex::new(stdin),
            process: Mutex::new(Some((child, owner))),
            state: Mutex::new(State {
                gate: match dtach {
                    Some(true) => Gate::Replay,
                    Some(false) => Gate::Ready,
                    None => Gate::Open,
                },
                ..State::default()
            }),
            #[cfg(unix)]
            run_token: run,
            #[cfg(windows)]
            wsl: Mutex::new(run),
            remote,
            persistent: dtach.is_some(),
            local_files: Mutex::new(None),
            remote_files: OnceLock::new(),
        });
        let reading = Arc::clone(&process);
        let reader = thread::spawn(move || {
            if let Some(live) = dtach {
                return reading.read_dtach(stdout, live);
            }
            let mut stdout = BufReader::new(stdout);
            let mut line = Vec::new();
            let mut chunks = None;
            loop {
                line.clear();
                match stdout.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Ok(text) = std::str::from_utf8(&line) {
                            reading.receive(
                                &mut chunks,
                                text.trim_end_matches(['\n', '\r']),
                                false,
                            );
                        }
                    }
                }
            }
        });
        let logging = Arc::clone(&process);
        let stderr_reader = thread::spawn(move || {
            let mut chunk = [0; 4096];
            while let Ok(count) = stderr.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let mut shown = &chunk[..count];
                let mut group = None;
                let rest;
                if let Some(groups) = &mut scan {
                    let (left, found) = groups.scan(shown);
                    if let Some(found) = found {
                        scan = None;
                        group = found;
                    }
                    rest = left;
                    shown = &rest;
                }
                if let Ok(mut state) = logging.state.lock() {
                    if group.is_some() {
                        state.remote_group = group;
                    }
                    state.append_stderr(&String::from_utf8_lossy(shown));
                }
            }
            if let (Some(scan), Ok(mut state)) = (scan, logging.state.lock()) {
                state.append_stderr(&String::from_utf8_lossy(&scan.line));
            }
        });
        let waiting = Arc::clone(&process);
        thread::spawn(move || {
            let exit_code = loop {
                if let Ok(mut process) = waiting.process.lock() {
                    let Some((child, _owner)) = &mut *process else {
                        break None;
                    };
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            // The Windows job outlives the process until terminated; on Unix the
                            // reaped group id may be reused, so `stop_unix_run` sweeps instead.
                            #[cfg(windows)]
                            _owner.terminate(child, KILL_TIMEOUT);
                            break status.code().map(|code| code as u32);
                        }
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                thread::sleep(POLL * 2);
            };
            let sweep = waiting.sweep();
            // Every record written before the exit is forwarded before the exit itself.
            let _ = reader.join();
            let _ = stderr_reader.join();
            // shortcut: quitting during an SSH upload longer than the stop timeouts leaves its
            // /tmp/soreno-agent-* directory on the server; wait for this cleanup in shutdown if seen.
            let cleanup = waiting.release_files();
            drop(access);
            if let Ok(mut state) = waiting.state.lock() {
                if let Err(error) = sweep.and(cleanup) {
                    state.append_stderr(&error);
                }
                state.exited = true;
                // A detached client is no crash, whatever its exit.
                state.exit_code = if state.detached { Some(0) } else { exit_code };
                state.working = false;
                state.dialogs.clear();
                state.acknowledgements.clear();
                let record = state.exit_record();
                state.forward(record);
            }
        });
        Ok(process)
    }

    /// Kills what the run left behind: Unix descendants by token, a WSL run's Linux processes.
    fn sweep(&self) -> Result<()> {
        #[cfg(unix)]
        return super::stop_unix_run(&self.run_token);
        #[cfg(windows)]
        return lock(&self.wsl)?
            .as_ref()
            .map_or(Ok(()), super::WslRun::stop);
    }

    /// Handles one stdout line and tells whether it was a record; other lines (shell banners)
    /// are dropped.
    fn receive(self: &Arc<Self>, chunks: &mut Option<Chunks>, line: &str, replayed: bool) -> bool {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if !record.is_object() {
            return false;
        }
        // The replay may begin inside a chunk sequence.
        let log = |error: &str| {
            if !replayed {
                self.log(error);
            }
        };
        if record.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
            match reassemble(chunks, &record) {
                Ok(Some(text)) => {
                    self.receive(chunks, &text, replayed);
                }
                Ok(None) => {}
                Err(error) => log(&error),
            }
            return true;
        }
        if chunks.take().is_some() {
            log("Séquence de fragments RPC interrompue.");
        }
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        let handling = state.handle(&record, line, replayed);
        if handling.forward {
            state.forward(line.to_owned());
        }
        drop(state);
        if handling.refresh || handling.rename {
            // Off the reader: a write may wait for OMP, which may wait for this reader.
            let process = Arc::clone(self);
            thread::spawn(move || {
                if handling.rename {
                    let _ = process.request_title();
                }
                if handling.refresh {
                    let _ = process.request_state();
                }
            });
        }
        true
    }

    /// Reads a dtach client's terminal: what it printed before the replay, the replay, then the
    /// run's output, where OMP's stderr shares the terminal with its records.
    fn read_dtach(self: &Arc<Self>, mut stdout: ChildStdout, live: bool) {
        let mut framing = HistoryFraming::new(true);
        // The client's screen clearing, or why it could not attach.
        let mut preamble = Some(Vec::new());
        let mut line = Vec::new();
        let mut line_replayed = false;
        let mut chunks = None;
        let mut buffer = vec![0; 64 * 1024];
        // Returns whether a replayed line is still incomplete.
        let mut take = |segment: Segment, chunks: &mut Option<Chunks>| {
            let (bytes, replayed) = match segment {
                Segment::Live(bytes) => match preamble.as_mut() {
                    Some(preamble) => {
                        preamble.extend(bytes);
                        return false;
                    }
                    None => (bytes, false),
                },
                // Without a previous client, the replay is this run's first output.
                Segment::History(bytes) => {
                    preamble = None;
                    (bytes, live)
                }
            };
            for piece in bytes.split_inclusive(|byte| *byte == b'\n') {
                if line.is_empty() {
                    line_replayed = replayed;
                }
                line.extend_from_slice(piece);
                if piece.ends_with(b"\n") {
                    self.take_line(chunks, &std::mem::take(&mut line), line_replayed);
                }
            }
            line_replayed && !line.is_empty()
        };
        let mut pending = false;
        loop {
            let count = match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            for segment in framing.push(&buffer[..count]) {
                pending = take(segment, &mut chunks);
            }
            // A dialog finishing after the opening would miss the subscriber's replay.
            if framing.replayed() && !pending {
                if let Ok(mut state) = self.state.lock() {
                    if state.gate == Gate::Replay {
                        state.gate = Gate::Opening;
                    }
                }
            }
        }
        for segment in framing.finish() {
            take(segment, &mut chunks);
        }
        if !line.is_empty() {
            self.take_line(&mut chunks, &line, line_replayed);
        }
        if let Some(preamble) = preamble {
            self.take_text(&String::from_utf8_lossy(&preamble));
        }
    }

    fn take_line(self: &Arc<Self>, chunks: &mut Option<Chunks>, line: &[u8], replayed: bool) {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end_matches(['\n', '\r']);
        let received = self.receive(chunks, text, replayed)
            // The login shell's output without newline can prefix OMP's first record.
            || (!replayed && self.receive(chunks, &crate::skills::strip_ansi(text), false));
        if !received && !replayed {
            self.take_text(text);
        }
    }

    /// Keeps terminal text for the exit report, as stderr.
    fn take_text(&self, text: &str) {
        for line in crate::skills::strip_ansi(text).lines() {
            let line = line.trim();
            if !line.is_empty() && line != DTACH_EOF {
                self.log(line);
            }
        }
    }

    fn log(&self, error: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.append_stderr(&format!("{error}\n"));
        }
    }

    fn request_state(&self) -> Result<()> {
        let id = lock(&self.state)?.next_id(STATE_PREFIX);
        self.write_line(&serde_json::json!({ "id": id, "type": "get_state" }).to_string())
    }

    /// OMP's `/rename` without a title generates one, even where OMP leaves conversations
    /// untitled; OMP then records it as the user's.
    fn request_title(&self) -> Result<()> {
        let id = lock(&self.state)?.next_id(TITLE_PREFIX);
        self.write_line(
            &serde_json::json!({ "id": id, "type": "prompt", "message": "/rename" }).to_string(),
        )
    }

    pub(super) fn exited(&self) -> bool {
        self.state.lock().map_or(true, |state| state.exited)
    }

    /// Writes `bytes` where OMP can read them and returns the path to give it.
    pub(super) fn attach_file(
        &self,
        environment: &AgentEnvironment,
        filename: &str,
        bytes: &[u8],
    ) -> Result<String> {
        if self.exited() {
            return Err(STOPPED.into());
        }
        super::attach_file_in(
            &self.local_files,
            self.remote_files.get(),
            environment,
            filename,
            bytes,
        )
    }

    /// Removes the attached files; the closed directories refuse later uploads.
    fn release_files(&self) -> Result<()> {
        let remote = self
            .remote_files
            .get()
            .map_or(Ok(()), RemoteClipboard::close);
        let local = lock(&self.local_files)?
            .take()
            .map_or(Ok(()), |directory| cleanup_attachment_directory(&directory));
        remote.and(local)
    }

    pub(super) fn run_status(&self, session_id: &str) -> Result<AgentSessionStatus> {
        let state = lock(&self.state)?;
        let mut status = idle(session_id);
        status.state = if state.exited { "exited" } else { "running" }.into();
        status.exit_code = state.exit_code;
        status.missing_executable =
            state.exited && state.exit_code == Some(MISSING_EXECUTABLE_EXIT_CODE);
        if !state.exited {
            status.working = Some(state.working);
            status.awaiting = !state.dialogs.is_empty();
            status.last_message = state.last_message.clone();
        }
        Ok(status)
    }

    /// Replaces the previous view's channel; pending dialogs and a past exit are replayed first.
    pub(super) fn subscribe(&self, channel: Channel<String>) -> Result<()> {
        let mut state = lock(&self.state)?;
        let mut replay: Vec<String> = state.dialogs.iter().map(|(_, line)| line.clone()).collect();
        if state.exited {
            replay.push(state.exit_record());
        }
        for line in replay {
            channel.send(line).map_err(|error| error.to_string())?;
        }
        state.subscriber = Some(channel);
        Ok(())
    }

    fn write_line(&self, line: &str) -> Result<()> {
        self.wait_gate(|gate| *gate == Gate::Open);
        self.write_raw(line)
    }

    /// Waits, without deadline, until the run takes this input or exits.
    fn wait_gate(&self, takes: impl Fn(&Gate) -> bool) {
        while let Ok(state) = self.state.lock() {
            if state.exited || takes(&state.gate) {
                return;
            }
            drop(state);
            thread::sleep(POLL);
        }
    }

    /// Sends the opening records once the run takes input, then lets the others through.
    fn open(&self, opening: &[String]) {
        self.wait_gate(|gate| *gate == Gate::Opening);
        for line in opening {
            if self.write_raw(line).is_err() {
                break;
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.gate = Gate::Open;
        }
    }

    /// Whether the opening records went, or the run exited, within `timeout`.
    fn wait_open(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if lock(&self.state).map_or(true, |state| state.exited || state.gate == Gate::Open) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(POLL);
        }
    }

    fn write_raw(&self, line: &str) -> Result<()> {
        let mut stdin = lock(&self.stdin)?;
        let stdin = stdin.as_mut().ok_or(STOPPED)?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|_| STOPPED.to_string())
    }

    pub(super) fn send(&self, record: &Value) -> Result<()> {
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| COMMANDS.contains(kind))
            .ok_or("Commande OMP non prise en charge.")?;
        let id = record.get("id").and_then(Value::as_str);
        if id.is_some_and(|id| id.starts_with(HOST_PREFIX)) {
            return Err("Identifiant de requête réservé à Soreno.".into());
        }
        if kind == "switch_session" {
            validate_switch(record, self.session_file()?.as_deref())?;
            let path = record.get("sessionPath").and_then(Value::as_str);
            lock(&self.state)?.resume(path.unwrap_or_default());
        }
        let line = serde_json::to_string(record).map_err(|error| error.to_string())?;
        if line.len() > COMMAND_LIMIT {
            return Err("Message OMP limité à 32 Mio.".into());
        }
        if self.exited() {
            return Err(STOPPED.into());
        }
        {
            let mut state = lock(&self.state)?;
            if let (Some(id), "extension_ui_response") = (id, kind) {
                state.dialogs.retain(|(dialog, _)| dialog != id);
            }
            state.sent(kind, record.get("message").and_then(Value::as_str));
        }
        match self.write_line(&line) {
            // The run ended meanwhile: its exit record, not one error per command, reports it.
            Err(error) if error == STOPPED => return Ok(()),
            result => result?,
        }
        if let (Some(id), "extension_ui_response", true) = (id, kind, self.persistent) {
            self.write_line(
                &serde_json::json!({ "id": format!("{ANSWERED_PREFIX}{id}"), "type": "get_state" })
                    .to_string(),
            )?;
        }
        Ok(())
    }

    fn session_file(&self) -> Result<Option<String>> {
        Ok(lock(&self.state)?
            .conversation
            .as_ref()
            .and_then(|conversation| conversation.session_file.clone()))
    }

    /// A page of the project's OMP conversations, newest first, and whether more follow: the
    /// folder of the one OMP holds, as it reported it, so its overrides of the sessions root
    /// need no reimplementation.
    pub(super) fn history(
        &self,
        project: &AgentProject,
        offset: usize,
        limit: usize,
    ) -> Result<ConversationHistoryPage> {
        let current = self.session_file()?;
        let Some(directory) = current
            .as_deref()
            .and_then(|file| Path::new(file).parent()?.to_str())
        else {
            return Ok(ConversationHistoryPage::default());
        };
        let (files, more) = history_files(project, directory, offset, limit)?;
        let mut entries: Vec<_> = files
            .into_iter()
            .filter_map(|file| history_entry(file, current.as_deref()))
            .collect();
        entries
            .sort_by(|left, right| (right.modified, &right.path).cmp(&(left.modified, &left.path)));
        let mut state = lock(&self.state)?;
        if state.titles.len() > HISTORY_TITLES {
            state.titles.clear();
        }
        state.titles.extend(
            entries
                .iter()
                .filter_map(|entry| Some((entry.path.clone(), entry.title.clone()?))),
        );
        Ok(ConversationHistoryPage { entries, more })
    }

    /// Queues `message` after the current run, or starts one when the agent is idle, and waits
    /// until OMP accepted or refused it; the run's exit drops the waiting sender.
    pub(super) fn deliver(&self, message: &str) -> Result<()> {
        let (sender, receiver) = mpsc::channel();
        let id = {
            let mut state = lock(&self.state)?;
            if state.exited {
                return Err(STOPPED.into());
            }
            let id = state.next_id(DELIVERY_PREFIX);
            state.acknowledgements.insert(id.clone(), sender);
            id
        };
        let line = serde_json::json!({
            "type": "prompt",
            "id": id,
            "message": message,
            "streamingBehavior": "followUp",
        })
        .to_string();
        let delivered = self
            .write_line(&line)
            .and_then(|()| receiver.recv().unwrap_or_else(|_| Err(STOPPED.into())));
        if let Ok(mut state) = self.state.lock() {
            state.acknowledgements.remove(&id);
        }
        delivered
    }

    fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while !self.exited() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(POLL);
        }
        true
    }

    /// Closing stdin lets OMP flush its history; a hung run is killed. A run under dtach only
    /// loses this client: no EOF crosses its terminal, and `remote_host::stop` ends it.
    pub(super) fn stop(&self) -> Result<()> {
        if self.persistent {
            lock(&self.state)?.detached = true;
        }
        // A writer blocked on a full pipe holds stdin: killing the run unblocks it.
        let closed = !self.persistent
            && match self.stdin.try_lock() {
                Ok(mut stdin) => {
                    stdin.take();
                    true
                }
                Err(TryLockError::Poisoned(stdin)) => {
                    stdin.into_inner().take();
                    true
                }
                Err(TryLockError::WouldBlock) => false,
            };
        if closed && self.wait_exit(GRACEFUL_EXIT) {
            // The exit's sweep may have failed (e.g. WSL timeout): retry it, idempotent once done.
            return self.sweep();
        }
        let group = self.state.lock().ok().and_then(|state| state.remote_group);
        if let (Some(connection), Some(group)) = (&self.remote, group) {
            // Killing the local client leaves the server's run going; a blocked or unreachable
            // connection skips this within its timeout.
            let _ = crate::ssh::run_output_with_timeout(
                connection,
                &stop_group_script(group),
                None,
                1024,
                REMOTE_STOP_TIMEOUT,
            );
        }
        if let Some((child, owner)) = &mut *lock(&self.process)? {
            // Once reaped, the group id may belong to another process: the token sweep stays safe.
            if !matches!(child.try_wait(), Ok(Some(_))) {
                owner.terminate(child, KILL_TIMEOUT);
            }
        }
        self.sweep()?;
        if self.wait_exit(KILL_TIMEOUT) {
            Ok(())
        } else {
            Err("La conversation OMP ne s’est pas arrêtée. Réessayez l’arrêt.".into())
        }
    }
}

#[cfg(test)]
#[path = "conversation_tests.rs"]
mod tests;
