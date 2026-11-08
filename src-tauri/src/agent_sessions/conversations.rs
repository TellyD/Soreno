mod arguments;
mod history;
mod hooks;
mod launch_files;
mod remote_metadata;
mod retention;
mod sidecar;
pub(super) use arguments::validate_group_args;
use history::{history_exists, verify_history};
pub(super) use history::{history_files, HistoryFile};
#[cfg(all(test, unix))]
use history::{history_files_script, parse_history_files};
#[cfg(test)]
use history::{HISTORY_HEAD, HISTORY_PAGE_LIMIT};
pub(super) use remote_metadata::RemoteMetadataParser;
pub(super) use retention::{
    purge_local as purge_local_launch_directories, referenced_runs, remove_launch_directories,
    remove_remote_launch_directories, session_launch_directories, session_remote_names,
};

#[cfg(windows)]
use super::probe_output;
use super::{AgentProject, AgentSession, Result};
use arguments::validate_args;
#[cfg(test)]
use base64::{engine::general_purpose::STANDARD, Engine};
use hooks::{
    codex_hook_args, hook_commands, hook_settings, windows_hook_script, write_claude_settings,
    POSIX_HOOK_SCRIPT, WINDOWS_HOOK_SCRIPT_VARIABLE,
};
#[cfg(any(windows, test))]
use launch_files::wsl_command;
use launch_files::{execution_path, remote_run_directory, upload_remote};
use remote_metadata::{
    parse_remote_sidecar, remote_channels, remote_sidecar_script, RemoteSidecarSync,
};
#[cfg(test)]
use remote_metadata::{LEGACY_OSC_PREFIX, OSC_PAYLOAD_LIMIT, OSC_PREFIX};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sidecar::{parse_sidecar, read_sidecar, store_sidecar};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const PREFIX_LIMIT: u64 = 64 * 1024;
const MISSING_LINK: &str = "Le lancement précédent n’a publié aucune liaison de conversation.";
const MISSING_HISTORY: &str = "L’historique Pi/OMP lié n’existe plus.";
const IDENTITY_ERROR: &str = "La conversation ouverte ne correspond pas à celle demandée.";
const SIDECAR_TOO_LARGE: &str = "Métadonnées de conversation trop volumineuses.";
pub(super) const INITIAL_PROMPT_MESSAGE: &str =
    "An initial prompt can only start a new agent conversation.";
const BRIDGE: &str = include_str!("pi_omp_bridge.mjs");

/// The bridge for `omp --mode rpc-ui`: with `link` (run token, metadata path) it also publishes
/// the conversation's metadata, else it only appends `text` to the system prompt.
pub(super) fn system_append_extension(text: &str, link: Option<(&str, &str)>) -> String {
    let config = match link {
        Some((run_id, metadata_path)) => serde_json::json!({
            "version": 1,
            "provider": "omp",
            "runId": run_id,
            "metadataPath": metadata_path,
            "mode": "rpc",
            "systemAppend": text,
        }),
        None => serde_json::json!({ "systemAppend": text }),
    };
    format!("const soreno = {config};\n{BRIDGE}")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConversation {
    pub provider: String,
    pub session_id: String,
    #[serde(default)]
    pub session_file: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Provider {
    Pi,
    Omp,
    Claude,
    Codex,
}
impl Provider {
    const ALL: [Self; 4] = [Self::Pi, Self::Omp, Self::Claude, Self::Codex];

    fn as_str(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.as_str() == name)
    }

    fn requires_history(self) -> bool {
        matches!(self, Self::Pi | Self::Omp)
    }

    pub(super) fn uses_hooks(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationRecord {
    provider: String,
    #[serde(default)]
    conversation: Option<AgentConversation>,
    resume: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    metadata_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_metadata_path: Option<String>,
    #[serde(default)]
    conversation_error: Option<String>,
    #[serde(default)]
    pending: bool,
    #[serde(default)]
    history_verified: bool,
    #[serde(default)]
    requested_session_id: Option<String>,
}

impl ConversationRecord {
    fn new(provider: Provider, resume: &str) -> Self {
        Self {
            provider: provider.as_str().into(),
            conversation: None,
            resume: resume.into(),
            run_id: None,
            metadata_path: None,
            remote_metadata_path: None,
            conversation_error: None,
            pending: false,
            history_verified: false,
            requested_session_id: None,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ConversationFields {
    pub conversation: Option<AgentConversation>,
    pub resume: String,
    pub error: Option<String>,
    pending: bool,
}

impl ConversationFields {
    fn unlinked(resume: &str, error: Option<String>) -> Self {
        Self {
            conversation: None,
            resume: resume.into(),
            error,
            pending: false,
        }
    }
}

/// A finished turn and its final assistant message, which may carry an issue summary; `id` is unique per turn.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentTurn {
    pub id: String,
    pub message: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub(super) struct Activity {
    pub working: Option<bool>,
    pub awaiting: bool,
    pub turn: Option<AgentTurn>,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_conversations (
            session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
            data TEXT NOT NULL
        );",
    )
    .map_err(|error| error.to_string())
}

pub(super) fn provider(executable: &str) -> Option<Provider> {
    let name = executable.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".ps1"))
        .unwrap_or(&name);
    Provider::from_name(name)
}

fn get_data(db: &Connection, session_id: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT data FROM agent_conversations WHERE session_id=?1",
        [session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn get(db: &Connection, session_id: &str) -> Result<Option<ConversationRecord>> {
    get_data(db, session_id)?
        .map(|data| serde_json::from_str(&data).map_err(|error| error.to_string()))
        .transpose()
}

pub(super) fn has_run(db: &Connection, session_id: &str) -> Result<bool> {
    Ok(get(db, session_id)?.is_some_and(|record| record.run_id.is_some()))
}

fn put(db: &Connection, session_id: &str, record: &ConversationRecord) -> Result<()> {
    db.execute(
        "INSERT INTO agent_conversations(session_id,data) VALUES (?1,?2)
         ON CONFLICT(session_id) DO UPDATE SET data=excluded.data
         WHERE agent_conversations.data <> excluded.data",
        params![
            session_id,
            serde_json::to_string(record).map_err(|error| error.to_string())?
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn session_saved(
    db: &Connection,
    previous: Option<&AgentSession>,
    session: &AgentSession,
) -> Result<()> {
    if session.kind == "service" {
        db.execute(
            "DELETE FROM agent_conversations WHERE session_id=?1",
            [&session.id],
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let next_provider = provider(&session.executable);
    let record = get(db, &session.id)?;
    if let Some(conversation) = record
        .as_ref()
        .and_then(|record| record.conversation.as_ref())
    {
        if next_provider.map(Provider::as_str) != Some(conversation.provider.as_str()) {
            return Err(
                "Cette session est liée à une conversation. Son exécutable ne peut pas changer de fournisseur."
                    .into(),
            );
        }
    }
    match (previous, next_provider, record) {
        (None, Some(provider), None) => {
            put(db, &session.id, &ConversationRecord::new(provider, "new"))
        }
        (Some(_), Some(provider), Some(mut record))
            if record.conversation.is_none() && record.provider != provider.as_str() =>
        {
            record.provider = provider.as_str().into();
            record.resume = "select".into();
            record.run_id = None;
            record.metadata_path = None;
            record.remote_metadata_path = None;
            record.conversation_error = None;
            record.pending = false;
            record.requested_session_id = None;
            put(db, &session.id, &record)
        }
        _ => Ok(()),
    }
}

fn set_error(
    db: &Connection,
    session_id: &str,
    mut record: ConversationRecord,
    error: String,
) -> Result<()> {
    record.conversation_error = Some(error);
    put(db, session_id, &record)
}

fn reset_unmaterialized(
    db: &Connection,
    session_id: &str,
    mut record: ConversationRecord,
    process_active: bool,
) -> Result<()> {
    record.conversation = None;
    record.resume = "new".into();
    record.conversation_error = None;
    record.pending = process_active;
    record.history_verified = false;
    if !process_active {
        record.run_id = None;
        record.metadata_path = None;
        record.remote_metadata_path = None;
    }
    put(db, session_id, &record)
}

fn forget_run(db: &Connection, session_id: &str, mut record: ConversationRecord) -> Result<()> {
    if record.conversation.is_some() {
        record.resume = "linked".into();
    }
    record.run_id = None;
    record.metadata_path = None;
    record.remote_metadata_path = None;
    record.requested_session_id = None;
    record.conversation_error = None;
    record.pending = false;
    put(db, session_id, &record)
}

pub(super) fn forget_codex_update_run(
    db: &Connection,
    session: &AgentSession,
    restart_requested: impl FnOnce() -> bool,
) -> Result<()> {
    if provider(&session.executable) != Some(Provider::Codex) {
        return Ok(());
    }
    let Ok(Some(record)) = get(db, &session.id) else {
        return Ok(());
    };
    let Some(path) = record.metadata_path.as_deref() else {
        return Ok(());
    };
    if !record.pending
        || record.provider != Provider::Codex.as_str()
        || !matches!(Path::new(path).try_exists(), Ok(false))
        || !restart_requested()
    {
        return Ok(());
    }
    forget_run(db, &session.id, record)
}

// ConPTY may replace spaces with cursor moves.
pub(super) fn codex_requested_restart(output: impl IntoIterator<Item = u8>) -> bool {
    const BANNER: &[u8] = b"Updateransuccessfully!PleaserestartCodex.";
    let mut text = Vec::new();
    let mut bytes = output.into_iter();
    while let Some(byte) = bytes.next() {
        if byte != 0x1b {
            if !byte.is_ascii_whitespace() {
                text.push(byte);
            }
            continue;
        }
        match bytes.next() {
            Some(b'[') => {
                bytes.find(|byte| (0x40..=0x7e).contains(byte));
            }
            Some(b']') => {
                let mut escape = false;
                bytes.find(|&byte| {
                    let end = byte == 0x07 || escape && byte == b'\\';
                    escape = byte == 0x1b;
                    end
                });
            }
            _ => {}
        }
    }
    text.windows(BANNER.len()).any(|window| window == BANNER)
}

fn validate_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn absolute_for_environment(path: &str, project: &AgentProject) -> bool {
    if matches!(project.environment.kind.as_str(), "wsl" | "ssh") {
        crate::ssh::validate_path(path).is_ok()
    } else {
        Path::new(path).is_absolute()
    }
}

pub(super) fn reconcile(
    db: &Connection,
    session: &AgentSession,
    project: &AgentProject,
    process_active: bool,
) -> Result<Activity> {
    reconcile_with_remote_history(db, session, project, process_active, true)
}

pub(super) fn reconcile_cached(
    db: &Connection,
    session: &AgentSession,
    project: &AgentProject,
    process_active: bool,
) -> Result<Activity> {
    reconcile_with_remote_history(db, session, project, process_active, false)
}

fn reconcile_with_remote_history(
    db: &Connection,
    session: &AgentSession,
    project: &AgentProject,
    process_active: bool,
    allow_remote_history: bool,
) -> Result<Activity> {
    if session.kind == "service" {
        return Ok(Activity::default());
    }
    let record = match get(db, &session.id) {
        Ok(Some(record)) => record,
        Ok(None) | Err(_) => return Ok(Activity::default()),
    };
    let Some(path) = record.metadata_path.as_deref() else {
        return Ok(Activity::default());
    };
    let data = match read_sidecar(Path::new(path)) {
        Ok(Some(data)) => data,
        Ok(None) if record.pending && !process_active => {
            let record_provider = Provider::from_name(&record.provider);
            let interrupted_first_claude = record_provider == Some(Provider::Claude)
                && record.resume == "new"
                && record.conversation.is_none()
                && record.requested_session_id.is_none();
            let exact_hook_resume = record_provider.is_some_and(Provider::uses_hooks)
                && record
                    .requested_session_id
                    .as_ref()
                    .zip(record.conversation.as_ref())
                    .is_some_and(|(requested, conversation)| requested == &conversation.session_id);
            if interrupted_first_claude || exact_hook_resume {
                forget_run(db, &session.id, record)?;
            } else {
                set_error(db, &session.id, record, MISSING_LINK.into())?;
            }
            return Ok(Activity::default());
        }
        Ok(None) => return Ok(Activity::default()),
        Err(error) => {
            set_error(db, &session.id, record, error)?;
            return Ok(Activity::default());
        }
    };
    let sidecar = match parse_sidecar(&data) {
        Ok(sidecar) => sidecar,
        Err(error) => {
            set_error(
                db,
                &session.id,
                record,
                format!("Métadonnées de conversation invalides : {error}"),
            )?;
            return Ok(Activity::default());
        }
    };
    let parsed_provider = Provider::from_name(&sidecar.provider);
    let invalid = sidecar.version != 1
        || Some(sidecar.run_id.as_str()) != record.run_id.as_deref()
        || sidecar.provider != record.provider
        || parsed_provider.is_none()
        || sidecar.source.as_ref().is_some_and(|source| {
            !["startup", "resume", "clear", "compact", "fork"].contains(&source.as_str())
        })
        || parsed_provider.is_some_and(Provider::uses_hooks)
            && sidecar.cwd.as_ref().is_none_or(|cwd| {
                cwd.len() > 4096 || cwd.contains('\0') || !absolute_for_environment(cwd, project)
            })
        || sidecar
            .name
            .as_ref()
            .is_some_and(|name| name.chars().count() > 512 || name.chars().any(char::is_control))
        || sidecar
            .error
            .as_ref()
            .is_some_and(|error| error.len() > 4096);
    if invalid {
        set_error(
            db,
            &session.id,
            record,
            "Métadonnées de conversation incompatibles (version, exécution ou fournisseur).".into(),
        )?;
        return Ok(Activity::default());
    }
    let provider = parsed_provider.unwrap();
    if let Some(error) = sidecar.error {
        let mut record = record;
        record.pending = false;
        set_error(
            db,
            &session.id,
            record,
            format!("Pont de conversation : {error}"),
        )?;
        return Ok(Activity::default());
    }
    let Some(session_id) = sidecar.session_id else {
        let mut record = record;
        record.pending = false;
        set_error(
            db,
            &session.id,
            record,
            "Métadonnées de conversation incomplètes : identité absente.".into(),
        )?;
        return Ok(Activity::default());
    };
    let valid_file = sidecar.session_file.as_ref().is_none_or(|session_file| {
        session_file.len() <= 4096
            && !session_file.contains('\0')
            && absolute_for_environment(session_file, project)
    });
    if !validate_uuid(&session_id)
        || !valid_file
        || provider.requires_history() && sidecar.session_file.is_none()
    {
        let mut record = record;
        record.pending = false;
        set_error(
            db,
            &session.id,
            record,
            "Métadonnées de conversation invalides : identité ou chemin de session incorrect."
                .into(),
        )?;
        return Ok(Activity::default());
    }
    if provider.uses_hooks() {
        let identity_changed = record
            .conversation
            .as_ref()
            .is_some_and(|linked| linked.session_id != session_id);
        let unrequested_resume =
            sidecar.source.as_deref() == Some("resume") && record.requested_session_id.is_none();
        if identity_changed
            && !unrequested_resume
            && !matches!(sidecar.source.as_deref(), Some("clear" | "fork"))
        {
            let mut record = record;
            record.pending = false;
            set_error(db, &session.id, record, IDENTITY_ERROR.into())?;
            return Ok(Activity::default());
        }
        if sidecar.source.is_none() && record.conversation_error.as_deref() == Some(IDENTITY_ERROR)
        {
            return Ok(Activity::default());
        }
    }
    let activity = Activity {
        working: process_active.then_some(sidecar.working).flatten(),
        awaiting: process_active && sidecar.awaiting,
        turn: sidecar.turn.filter(|turn| valid_turn_id(&turn.id)),
    };
    let conversation = AgentConversation {
        provider: sidecar.provider,
        session_id,
        session_file: sidecar.session_file,
        name: sidecar.name,
    };
    let already_verified = record.history_verified
        && record.conversation.as_ref().is_some_and(|linked| {
            linked.provider == conversation.provider
                && linked.session_id == conversation.session_id
                && linked.session_file == conversation.session_file
        });
    if provider.requires_history() {
        if !sidecar.materialized {
            if already_verified {
                set_error(db, &session.id, record, MISSING_HISTORY.into())?;
            } else {
                reset_unmaterialized(db, &session.id, record, process_active)?;
            }
            return Ok(activity);
        }
        if !already_verified {
            if project.environment.kind == "ssh" && !allow_remote_history {
                let mut record = record;
                record.conversation = Some(conversation);
                record.resume = "linked".into();
                record.conversation_error = None;
                record.pending = false;
                record.history_verified = false;
                put(db, &session.id, &record)?;
                return Ok(activity);
            }
            let session_file = conversation.session_file.as_deref().unwrap();
            match history_exists(project, session_file) {
                Ok(true) => {}
                Ok(false) => {
                    reset_unmaterialized(db, &session.id, record, process_active)?;
                    return Ok(activity);
                }
                Err(error) => {
                    set_error(db, &session.id, record, error)?;
                    return Ok(activity);
                }
            }
            if let Err(error) = verify_history(project, &conversation) {
                set_error(db, &session.id, record, error)?;
                return Ok(activity);
            }
        }
    }
    let mut record = record;
    record.conversation = Some(conversation);
    record.resume = "linked".into();
    record.conversation_error = None;
    record.pending = false;
    record.history_verified = true;
    put(db, &session.id, &record)?;
    Ok(activity)
}

fn valid_turn_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) fn fields(db: &Connection, session: &AgentSession) -> Result<ConversationFields> {
    if session.kind == "service" {
        return Ok(ConversationFields::unlinked("unsupported", None));
    }
    let Some(provider) = provider(&session.executable) else {
        return Ok(ConversationFields::unlinked("unsupported", None));
    };
    let record = match get(db, &session.id) {
        Ok(Some(record)) => record,
        Ok(None) => return Ok(ConversationFields::unlinked("select", None)),
        Err(error) => {
            return Ok(ConversationFields::unlinked(
                "select",
                Some(format!(
                    "Métadonnées de conversation internes invalides : {error}"
                )),
            ))
        }
    };
    let linked = record.conversation.is_some();
    let provider_error = (record.provider != provider.as_str()).then(|| {
        "Les métadonnées de conversation appartiennent à un autre fournisseur.".to_string()
    });
    let error = provider_error.or(record.conversation_error);
    Ok(ConversationFields {
        conversation: record.conversation,
        resume: if provider == Provider::Codex && error.as_deref() == Some(MISSING_LINK) {
            "approval".into()
        } else if record.resume == "new" && record.provider == provider.as_str() {
            "new".into()
        } else if linked {
            "linked".into()
        } else {
            "select".into()
        },
        error,
        pending: record.pending,
    })
}

#[derive(Debug)]
pub(super) struct PreparedLaunch {
    pub session: AgentSession,
    pub environment: Vec<(String, String)>,
    previous_data: Option<Option<String>>,
    metadata_parser: Option<RemoteMetadataParser>,
    remote_sidecar_sync: Option<RemoteSidecarSync>,
    remote_directory: Option<String>,
    /// `Some(separator_needed)` only when this launch starts a new conversation.
    new_conversation: Option<bool>,
}

impl std::ops::Deref for PreparedLaunch {
    type Target = AgentSession;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl PreparedLaunch {
    fn unchanged(session: &AgentSession) -> Self {
        Self {
            session: session.clone(),
            environment: Vec::new(),
            previous_data: None,
            metadata_parser: None,
            remote_sidecar_sync: None,
            remote_directory: None,
            new_conversation: None,
        }
    }

    pub(super) fn take_metadata_parser(&mut self) -> Option<RemoteMetadataParser> {
        self.metadata_parser.take()
    }

    pub(super) fn remote_sidecar_generation(&self) -> Option<Arc<Mutex<u64>>> {
        self.remote_sidecar_sync
            .as_ref()
            .map(|sync| Arc::clone(&sync.generation))
    }

    pub(super) fn take_remote_sidecar_sync(&mut self) -> Option<RemoteSidecarSync> {
        self.remote_sidecar_sync.take()
    }

    pub(super) fn remote_directory(&self) -> Option<&str> {
        self.remote_directory.as_deref()
    }

    /// One-shot positional message: never stored, so later resumes cannot replay it.
    pub(super) fn append_initial_prompt(&mut self, prompt: &str) -> Result<()> {
        let separator_needed = self.new_conversation.ok_or(INITIAL_PROMPT_MESSAGE)?;
        if separator_needed {
            self.session.args.push("--".into());
        }
        self.session.args.push(prompt.into());
        Ok(())
    }

    pub(super) fn rollback<T>(&self, db: &Connection, launch_error: String) -> Result<T> {
        let Some(previous_data) = &self.previous_data else {
            return Err(launch_error);
        };
        let restored = match previous_data {
            Some(data) => db
                .execute(
                    "INSERT INTO agent_conversations(session_id,data) VALUES (?1,?2)
                     ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
                    params![self.session.id, data],
                )
                .map(|_| ()),
            None => db
                .execute(
                    "DELETE FROM agent_conversations WHERE session_id=?1",
                    [&self.session.id],
                )
                .map(|_| ()),
        };
        match restored {
            Ok(()) => Err(launch_error),
            Err(error) => Err(format!(
                "{launch_error} Restauration de la conversation impossible : {error}"
            )),
        }
    }
}

fn attach_generation(generation: Option<Arc<Mutex<u64>>>) -> Result<Arc<Mutex<u64>>> {
    let generation = generation.unwrap_or_else(|| Arc::new(Mutex::new(0)));
    {
        let mut current = generation
            .lock()
            .map_err(|_| "État des métadonnées distant indisponible (verrou empoisonné).")?;
        *current = current.wrapping_add(1);
    }
    Ok(generation)
}

pub(super) fn prepare_attach(
    db: &Connection,
    session: &AgentSession,
    project: &AgentProject,
    generation: Option<Arc<Mutex<u64>>>,
) -> Result<PreparedLaunch> {
    let (metadata_parser, remote_sidecar_sync, remote_directory) = match get(db, &session.id)? {
        Some(ConversationRecord {
            provider,
            run_id: Some(run_id),
            metadata_path: Some(metadata_path),
            remote_metadata_path: Some(remote_metadata_path),
            ..
        }) if session.kind != "service" => {
            let generation = attach_generation(generation)?;
            crate::ssh::validate_path(&remote_metadata_path)?;
            let data = parse_remote_sidecar(crate::ssh::run(
                project
                    .environment
                    .ssh
                    .as_ref()
                    .ok_or("Connexion SSH manquante.")?,
                &remote_sidecar_script(&remote_metadata_path),
                None,
                PREFIX_LIMIT as usize + 1,
            )?)?;
            if let Some(data) = data {
                store_sidecar(Path::new(&metadata_path), &run_id, Some(&provider), &data)?;
                reconcile(db, session, project, true)?;
                if let Some(error) = fields(db, session)?.error {
                    return Err(format!(
                        "Métadonnées de conversation distantes invalides : {error}"
                    ));
                }
            }
            let remote_directory = remote_metadata_path
                .strip_suffix("/metadata.json")
                .map(str::to_owned);
            let (parser, sync) = remote_channels(
                project,
                provider,
                run_id,
                PathBuf::from(metadata_path),
                remote_metadata_path,
                generation,
            )?;
            (Some(parser), Some(sync), remote_directory)
        }
        Some(ConversationRecord {
            run_id: Some(_),
            metadata_path: Some(_),
            ..
        }) if session.kind != "service" => {
            return Err("Chemin du sidecar distant absent pour cette exécution SSH.".into())
        }
        _ => (None, None, None),
    };
    Ok(PreparedLaunch {
        metadata_parser,
        remote_sidecar_sync,
        remote_directory,
        ..PreparedLaunch::unchanged(session)
    })
}

/// `system_append` is text the Pi/OMP bridge appends to the agent's system prompt.
pub(super) fn prepare_launch(
    db: &Connection,
    links_dir: &Path,
    session: &AgentSession,
    project: &AgentProject,
    system_append: Option<&str>,
) -> Result<PreparedLaunch> {
    if session.kind == "service" {
        return Ok(PreparedLaunch::unchanged(session));
    }
    let Some(provider) = provider(&session.executable) else {
        return Ok(PreparedLaunch::unchanged(session));
    };
    reconcile(db, session, project, false)?;
    let mut fields = fields(db, session)?;
    if provider.requires_history() {
        if let Some(conversation) = &fields.conversation {
            let session_file = conversation.session_file.as_deref().unwrap();
            if !history_exists(project, session_file)? {
                let record =
                    get(db, &session.id)?.ok_or("Métadonnées Pi/OMP internes absentes.")?;
                if record.history_verified {
                    return Err(MISSING_HISTORY.into());
                }
                reset_unmaterialized(db, &session.id, record, false)?;
                fields = self::fields(db, session)?;
            } else {
                verify_history(project, conversation)?;
                let mut record =
                    get(db, &session.id)?.ok_or("Métadonnées Pi/OMP internes absentes.")?;
                if !record.history_verified {
                    record.history_verified = true;
                    put(db, &session.id, &record)?;
                }
            }
        }
    }
    if let Some(error) = &fields.error {
        let missing_hook_link = provider.uses_hooks() && error == MISSING_LINK;
        if !missing_hook_link
            && (fields.conversation.is_some() || !fields.pending || error != MISSING_LINK)
        {
            return Err(format!(
                "La conversation liée ne peut pas être reprise : {error}"
            ));
        }
    }
    let separator = validate_args(&session.args, provider, fields.resume != "new")?;

    let run_id = crate::sqlite::random_id(db).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(links_dir).map_err(|error| {
        format!("Impossible de créer le dossier des liens de conversation : {error}")
    })?;
    let run_dir = links_dir.join(&run_id);
    std::fs::create_dir(&run_dir)
        .map_err(|error| format!("Impossible de créer le lien de conversation : {error}"))?;
    let metadata_path = run_dir.join("metadata.json");
    let bridge_path = run_dir.join("soreno.ts");
    let hook_path = run_dir.join("conversation-hook.sh");
    let remote = project.environment.kind == "ssh";
    let remote_dir = remote
        .then(|| remote_run_directory(db, project))
        .transpose()?;
    let (execution_metadata_path, execution_bridge_path, execution_hook_path) =
        if let Some(directory) = &remote_dir {
            (
                format!("{directory}/metadata.json"),
                format!("{directory}/soreno.ts"),
                format!("{directory}/conversation-hook.sh"),
            )
        } else {
            (
                execution_path(project, &metadata_path)?,
                execution_path(project, &bridge_path)?,
                execution_path(project, &hook_path)?,
            )
        };
    let windows_local = cfg!(windows) && project.environment.kind == "local";
    let hook_commands = provider.uses_hooks().then(|| hook_commands(windows_local));
    if provider.uses_hooks() && !windows_local {
        if remote {
            upload_remote(project, &execution_hook_path, POSIX_HOOK_SCRIPT.as_bytes())?;
        } else {
            std::fs::write(&hook_path, POSIX_HOOK_SCRIPT).map_err(|error| {
                format!("Impossible d’écrire le hook de conversation : {error}")
            })?;
        }
    }
    let claude_settings = if provider == Provider::Claude {
        let commands = hook_commands.as_ref().unwrap();
        if windows_local {
            let path = run_dir.join("claude-settings.json");
            write_claude_settings(&path, commands)?;
            Some(execution_path(project, &path)?)
        } else {
            Some(hook_settings(commands).to_string())
        }
    } else {
        None
    };
    let create_config =
        if provider == Provider::Omp && fields.conversation.is_none() && fields.resume == "new" {
            if let Some(directory) = &remote_dir {
                let path = format!("{directory}/create.yml");
                upload_remote(project, &path, b"autoResume: false\n")?;
                Some(path)
            } else {
                let path = run_dir.join("create.yml");
                std::fs::write(&path, "autoResume: false\n").map_err(|error| {
                    format!("Impossible d’écrire la configuration OMP : {error}")
                })?;
                Some(execution_path(project, &path)?)
            }
        } else {
            None
        };
    if !provider.uses_hooks() {
        let descriptor = serde_json::json!({
            "version": 1,
            "runId": run_id,
            "metadataPath": execution_metadata_path,
            "provider": provider.as_str(),
            "expectedSessionId": fields.conversation.as_ref().map(|conversation| &conversation.session_id),
            "remote": remote,
            "systemAppend": system_append,
        });
        let bridge = format!("const soreno = {};\n{BRIDGE}", descriptor);
        if remote {
            upload_remote(project, &execution_bridge_path, bridge.as_bytes())?;
        } else {
            std::fs::write(&bridge_path, bridge)
                .map_err(|error| format!("Impossible d’écrire le pont Pi/OMP : {error}"))?;
        }
    }

    let previous_data = get_data(db, &session.id)?;
    let mut record = previous_data
        .as_deref()
        .map(|data| serde_json::from_str(data).map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or_else(|| ConversationRecord::new(provider, "select"));
    record.provider = provider.as_str().into();
    record.run_id = Some(run_id.clone());
    record.remote_metadata_path = remote.then(|| execution_metadata_path.clone());
    record.metadata_path = Some(
        metadata_path
            .to_str()
            .ok_or("Le chemin du sidecar de conversation n’est pas Unicode.")?
            .into(),
    );
    record.resume = if fields.conversation.is_some() {
        "linked".into()
    } else if provider.uses_hooks() && fields.resume == "new" {
        "new".into()
    } else {
        "select".into()
    };
    record.requested_session_id = fields
        .conversation
        .as_ref()
        .map(|conversation| conversation.session_id.clone());
    record.conversation_error = None;
    record.pending = true;
    put(db, &session.id, &record)?;

    let mut launch = session.clone();
    if let Some(config) = create_config {
        let index = separator.unwrap_or(launch.args.len());
        launch
            .args
            .splice(index..index, ["--config".into(), config]);
    }
    let resume = fields.conversation.as_ref().map(|conversation| {
        if provider.requires_history() {
            conversation.session_file.as_ref().unwrap()
        } else {
            &conversation.session_id
        }
    });
    let mut integration_args = match (resume, provider) {
        (Some(value), Provider::Pi) => vec!["--session".into(), value.clone()],
        (Some(value), Provider::Omp | Provider::Claude) => {
            vec!["--resume".into(), value.clone()]
        }
        (Some(value), Provider::Codex) => vec!["resume".into(), value.clone()],
        (None, Provider::Codex) if matches!(fields.resume.as_str(), "select" | "approval") => {
            vec!["resume".into()]
        }
        (None, _) if fields.resume == "select" => vec!["--resume".into()],
        _ => Vec::new(),
    };
    let mut environment = if provider.uses_hooks() {
        vec![
            ("SORENO_CONVERSATION_RUN_ID".into(), run_id.clone()),
            (
                "SORENO_CONVERSATION_PROVIDER".into(),
                provider.as_str().into(),
            ),
            (
                "SORENO_CONVERSATION_METADATA".into(),
                execution_metadata_path,
            ),
            ("SORENO_CONVERSATION_HOOK".into(), execution_hook_path),
            (
                "SORENO_CONVERSATION_REMOTE".into(),
                if remote { "1" } else { "0" }.into(),
            ),
        ]
    } else {
        integration_args.extend(["-e".into(), execution_bridge_path]);
        Vec::new()
    };
    if windows_local && provider.uses_hooks() {
        environment.push((WINDOWS_HOOK_SCRIPT_VARIABLE.into(), windows_hook_script()));
    }
    if provider == Provider::Claude {
        integration_args.splice(0..0, ["--settings".into(), claude_settings.unwrap()]);
    } else if provider == Provider::Codex {
        integration_args.splice(
            0..0,
            codex_hook_args(hook_commands.as_ref().unwrap(), windows_local),
        );
    }
    integration_args.append(&mut launch.args);
    launch.args = integration_args;
    let (metadata_parser, remote_sidecar_sync) = record
        .remote_metadata_path
        .clone()
        .map(|remote_path| {
            remote_channels(
                project,
                provider.as_str().into(),
                run_id,
                metadata_path,
                remote_path,
                Arc::new(Mutex::new(0)),
            )
        })
        .transpose()?
        .unzip();
    Ok(PreparedLaunch {
        session: launch,
        environment,
        previous_data: Some(previous_data),
        metadata_parser,
        remote_sidecar_sync,
        remote_directory: remote_dir,
        new_conversation: (fields.conversation.is_none() && fields.resume == "new")
            .then_some(separator.is_none()),
    })
}

#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
