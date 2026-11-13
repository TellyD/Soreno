//! Kanban issues that agents request by writing a JSON file into their private directory, and
//! the HTML frames that design board agents, or coding agents linked to a board, write there.
use super::{
    codex_overrides::{add_developer_instructions, add_writable_roots},
    conversation::{self, ConversationProcess},
    conversations::{self, Provider},
    design, groups, kanban_issue_sessions, lock, require_session, AgentSessions, RemoteClipboard,
    Result, Runtime, Store,
};
use crate::{
    kanban::{self, KanbanIssueCreateInput, KanbanIssueInput, KanbanSource},
    linear,
};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

const REQUEST_PREFIX: &str = "kanban-issue-";
const REQUEST_SUFFIX: &str = ".json";
const REQUEST_STEM_LIMIT: usize = 100;
const REQUEST_LIMIT: usize = 64 * 1024;
const TITLE_LIMIT: usize = 255;
/// The agent may still be writing the file: invalid content is retried for this many scans.
const PARSE_ATTEMPTS: u8 = 3;
const APPEND_SYSTEM_PROMPT: &str = "--append-system-prompt";
const STOPPED: &str = "Session arrêtée avant le traitement de la demande.";
const NOT_REGULAR: &str = "[Kanban/requestNotRegular] La demande n’est pas un fichier ordinaire.";
const MISSING_SUMMARY: &str = "[Kanban/requestSummary] Une modification de description demande summary, une phrase courte sur ce qui a changé : rien n’a été modifié.";
// `![alt](image-N)`, `![alt](image-N.ext)` or `![alt](<image-N>)`, as the agent's prompt names
// the issue's images; the alt text may hold escaped brackets.
static IMAGE_PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(!\[(?:\\.|[^\\\]])*\]\()(?:<image-(\d+)(?:\.\w+)?>|image-(\d+)(?:\.\w+)?)([\s)])")
        .unwrap()
});

/// Launch-time instruction telling the agent how to ask Soreno to create or edit a Kanban issue.
pub(super) fn instruction(directory: &str) -> String {
    format!(
        "Soreno: only on explicit user request, never on your own initiative: to create a Kanban issue, write kanban-issue-<name>.json (name: letters, digits, . - _) into {directory} with title, optional description (Markdown), optional linear (true if user asks); update: true with title and/or description edits the linked issue (description replaces all text; keep image-N refs; summary: what changed, one sentence). Soreno replies with the result; report it to the user."
    )
}

/// The launch-time instruction of a session: the design board one, else the Kanban one.
pub(super) fn agent_instruction(design: bool, directory: &str) -> String {
    if design {
        design::instruction(directory, true)
    } else {
        instruction(directory)
    }
}

/// Adds the instruction to Claude and Codex launch `args`; the Pi/OMP bridge appends it itself.
/// A Kanban instruction is optional; a design session cannot work without its own, and its
/// agent is confined to its private directory.
pub(super) fn add_instruction(
    args: &mut Vec<String>,
    provider: Provider,
    directory: &str,
    design: bool,
    windows_local: bool,
) -> Result<()> {
    let text = match provider {
        Provider::Codex if design => design::instruction_pointer(directory),
        _ => agent_instruction(design, directory),
    };
    let options = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    match provider {
        Provider::Claude => add_claude_instruction(args, options, text),
        Provider::Codex => {
            if add_developer_instructions(args, &text, windows_local) {
                add_writable_roots(args, [directory.to_owned()], windows_local);
            } else if design {
                return Err("Impossible de transmettre la consigne Design à Codex : le chemin du dossier privé ou une option developer_instructions contient un caractère non pris en charge.".into());
            }
        }
        Provider::Pi | Provider::Omp => {}
    }
    if design {
        design::restrict_launch(args, provider, directory, windows_local)?;
    }
    Ok(())
}

/// Claude keeps only the last `--append-system-prompt`: the instruction joins that one.
fn add_claude_instruction(args: &mut Vec<String>, options: usize, text: String) {
    let existing = args[..options].iter().rposition(|arg| {
        arg == APPEND_SYSTEM_PROMPT
            || arg
                .strip_prefix(APPEND_SYSTEM_PROMPT)
                .is_some_and(|rest| rest.starts_with('='))
    });
    let target = match existing {
        Some(index) if args[index] != APPEND_SYSTEM_PROMPT => Some(index),
        Some(index) if index + 1 < options => Some(index + 1),
        _ => None,
    };
    match target {
        Some(index) => args[index] = format!("{}\n\n{text}", args[index]),
        None => {
            args.splice(0..0, [APPEND_SYSTEM_PROMPT.to_owned(), text]);
        }
    }
}

/// Files a watcher picks in its run's private directory: `<prefix><stem><suffix>`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Requests {
    Kanban,
    DesignFrames,
}

impl Requests {
    fn affixes(self) -> (&'static str, &'static str) {
        match self {
            Self::Kanban => (REQUEST_PREFIX, REQUEST_SUFFIX),
            Self::DesignFrames => (design::FRAME_PREFIX, design::FRAME_SUFFIX),
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Kanban => REQUEST_LIMIT,
            Self::DesignFrames => design::FRAME_LIMIT,
        }
    }

    /// The stem of a valid name: letters, digits, `.`, `_` or `-`.
    fn stem(self, name: &str) -> Option<&str> {
        let (prefix, suffix) = self.affixes();
        name.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .filter(|stem| design::valid_frame_id(stem))
    }

    /// An invalid content may be a file still being written; an oversized one never completes.
    fn complete(self, bytes: &[u8]) -> bool {
        bytes.len() > self.limit()
            || match self {
                Self::Kanban => parse_request(bytes).is_ok(),
                Self::DesignFrames => design::parse_frame(bytes).is_ok(),
            }
    }
}

#[derive(Deserialize)]
struct RequestFile {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    linear: bool,
    #[serde(default)]
    update: bool,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    summary: Option<String>,
}

struct IssueContent {
    title: String,
    description: Option<String>,
    linear: bool,
    /// The group member the issue concerns, as the group prompt names it.
    project: Option<String>,
}

/// New title and/or description of the session's linked issue; an empty description clears it.
/// `summary` says what the description change does.
struct IssueEdit {
    title: Option<String>,
    description: Option<String>,
    summary: String,
}

enum Request {
    Create(IssueContent),
    Update(IssueEdit),
}

fn valid_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > TITLE_LIMIT || title.contains('\0') {
        return Err(kanban::TITLE_MESSAGE.into());
    }
    Ok(title.to_owned())
}

fn parse_request(bytes: &[u8]) -> Result<Request> {
    if bytes.len() > REQUEST_LIMIT {
        return Err("[Kanban/requestTooLarge] Demande trop volumineuse (64 Kio maximum).".into());
    }
    let file: RequestFile = serde_json::from_slice(bytes)
        .map_err(|error| format!("[Kanban/requestInvalidJson] JSON invalide ({error})."))?;
    let description = file
        .description
        .map(|description| description.trim().to_owned());
    if file.update {
        if file.title.is_none() && description.is_none() {
            return Err(kanban::EMPTY_UPDATE_MESSAGE.into());
        }
        let summary = file.summary.as_deref().map(str::trim).unwrap_or_default();
        if description.is_some() && summary.is_empty() {
            return Err(MISSING_SUMMARY.into());
        }
        return Ok(Request::Update(IssueEdit {
            title: file.title.as_deref().map(valid_title).transpose()?,
            description,
            summary: summary.to_owned(),
        }));
    }
    Ok(Request::Create(IssueContent {
        title: valid_title(file.title.as_deref().unwrap_or_default())?,
        description: description.filter(|description| !description.is_empty()),
        linear: file.linear,
        project: file.project,
    }))
}

/// Puts back the original target of each image placeholder the agent kept from its prompt.
fn resolve_image_placeholders(text: &str, targets: &[String]) -> Result<String> {
    let mut resolved = String::with_capacity(text.len());
    let mut copied = 0;
    for found in IMAGE_PLACEHOLDER.captures_iter(text) {
        let number = found.get(2).or_else(|| found.get(3)).unwrap();
        let target = number
            .as_str()
            .parse::<usize>()
            .ok()
            .and_then(|number| targets.get(number.checked_sub(1)?))
            .ok_or_else(|| {
                format!(
                    "[Kanban/requestImagePlaceholder] L’image « image-{} » est inconnue de cette session : rien n’a été modifié.",
                    number.as_str()
                )
            })?;
        let start = found.get(1).unwrap().end();
        resolved.push_str(&text[copied..start]);
        // Always bracketed, as the front writes images: bare targets stop at `'` or `(`.
        resolved.push_str(&format!("<{target}>"));
        // The closing character after the target stays in place.
        copied = found.get(4).unwrap().start();
    }
    resolved.push_str(&text[copied..]);
    Ok(resolved)
}

/// Follows one run of a session; failure counts belong to that run only.
pub struct IssueRequestWatcher {
    session_id: String,
    run: WatchedRun,
    /// The board's hidden session, which writes design frames only.
    design: bool,
    failures: HashMap<String, u8>,
    /// Requests whose file could not be claimed: handling them again would duplicate the issue.
    skipped: HashSet<String>,
    /// Original target of `image-N` at index N-1, as the launch prompt replaced it.
    image_targets: Vec<String>,
    /// A run whose design board mirror is not written yet.
    mirror_pending: bool,
}

impl IssueRequestWatcher {
    /// Lets the run's description edits keep the issue images its launch prompt named `image-N`.
    pub fn with_image_targets(mut self, image_targets: Vec<String>) -> Self {
        self.image_targets = image_targets;
        self
    }

    /// Moves the file out of the scanned names, then reads it; `None` when another watcher
    /// sharing the directory claimed it first.
    fn claim(&mut self, request: &IssueRequest, message_id: &str) -> Option<Result<Vec<u8>>> {
        let name = &request.name;
        let claimed = self
            .run
            .upgrade()
            .ok_or_else(|| STOPPED.to_owned())
            .and_then(|run| {
                claim_request(
                    &run,
                    request.requests,
                    name,
                    &format!("{name}.{message_id}.claimed"),
                )
            });
        match claimed {
            Ok(bytes) => bytes,
            Err(error) => {
                self.skipped.insert(name.to_owned());
                Some(Err(format!(
                    "[Kanban/requestClaimFailed] Impossible de prendre en charge la demande ({error})."
                )))
            }
        }
    }
}

enum WatchedRun {
    Terminal(Weak<Runtime>),
    Conversation(Weak<ConversationProcess>),
}

impl WatchedRun {
    fn upgrade(&self) -> Option<Run> {
        match self {
            Self::Terminal(run) => run.upgrade().map(Run::Terminal),
            Self::Conversation(run) => run.upgrade().map(Run::Conversation),
        }
    }
}

pub(super) enum Run {
    Terminal(Arc<Runtime>),
    Conversation(Arc<ConversationProcess>),
}

impl Run {
    /// The session's current run, exited or not.
    pub(super) fn current(store: &Store, session_id: &str) -> Option<Self> {
        match store.runtimes.get(session_id) {
            Some(run) => Some(Self::Terminal(run.clone())),
            None => store
                .omp_conversations
                .get(session_id)
                .map(|run| Self::Conversation(run.clone())),
        }
    }

    pub(super) fn exited(&self) -> Result<bool> {
        Ok(match self {
            Self::Terminal(run) => lock(&run.output)?.exited,
            Self::Conversation(run) => run.exited(),
        })
    }

    /// The run's private directory: local, else on the SSH server.
    pub(super) fn files(&self) -> (&Mutex<Option<PathBuf>>, Option<&RemoteClipboard>) {
        match self {
            Self::Terminal(run) => (
                &run.local_attachment_directory,
                run.remote_clipboard.as_ref(),
            ),
            Self::Conversation(run) => (&run.local_files, run.remote_files.get()),
        }
    }
}

/// A request ready to handle; its payload is read again once claimed.
pub struct IssueRequest {
    name: String,
    requests: Requests,
    /// The board a design frame was scanned for: it is not saved once the session draws elsewhere.
    board_id: Option<String>,
}

impl IssueRequest {
    /// A design frame: it goes to `handle_design_frame`.
    pub fn is_design(&self) -> bool {
        self.requests == Requests::DesignFrames
    }
}

pub enum IssueRequestScan {
    Stopped,
    Idle,
    Request(IssueRequest),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedIssue {
    pub id: String,
    pub identifier: String,
    pub source: KanbanSource,
}

/// A Linear request: an issue to create next to the session's linked Linear issue, else in the
/// Linear project linked to the request's project; or an edit of the session's linked issue.
#[derive(Debug, PartialEq)]
pub enum LinearIssueRequest {
    Create {
        linked_issue_id: Option<String>,
        linear_project_id: Option<String>,
        title: String,
        description: Option<String>,
    },
    Update {
        issue: CreatedIssue,
        title: Option<String>,
        description: Option<String>,
    },
}

/// Returns the created or edited issue.
pub type LinearIssueCreator<'a> = &'a dyn Fn(LinearIssueRequest) -> Result<CreatedIssue>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssueRequestEvent {
    pub session_id: String,
    pub session_name: String,
    pub title: String,
    /// The request edits the session's linked issue instead of creating one.
    pub updated: bool,
    pub issue: Option<CreatedIssue>,
    pub error: Option<String>,
}

pub struct IssueRequestOutcome {
    pub event: KanbanIssueRequestEvent,
    /// The reply was queued to the session.
    pub queued: bool,
    /// The caller starts the session's delivery worker.
    pub start_worker: bool,
}

pub struct DesignFrameOutcome {
    pub session_id: String,
    /// The board whose frames changed; `None` when the error was replied to the agent.
    pub board_id: Option<String>,
    /// The error reply was queued to the session.
    pub queued: bool,
    /// The caller starts the session's delivery worker.
    pub start_worker: bool,
}

/// The project of the session's linked issue, else the session's own project unless it is a
/// group project, whose member is the one the agent `named`.
pub(super) fn request_project(
    db: &Connection,
    session_id: &str,
    project_id: &str,
    named: Option<&str>,
) -> Result<Option<String>> {
    let linked: Option<String> = db
        .query_row(
            "SELECT issue.project_id FROM agent_kanban_issue_sessions link
            JOIN kanban_issues issue ON issue.id=link.issue_id WHERE link.session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if linked.is_some() {
        return Ok(linked);
    }
    let Some(group) = groups::group_by_group_project(db, project_id)? else {
        return Ok(Some(project_id.to_owned()));
    };
    let Some(named) = named else {
        return Ok(None);
    };
    let members = named_members(db, &group)?;
    // shortcut: members with the same name (case aside) resolve to the first one, which the agent cannot tell apart either; reject the ambiguity if groups with homonym projects show up.
    members
        .iter()
        .find(|(_, name)| name.trim().to_lowercase() == named.trim().to_lowercase())
        .map(|(id, _)| Some(id.clone()))
        .ok_or_else(|| project_choice(&members))
}

fn named_members(
    db: &Connection,
    group: &groups::AgentProjectGroup,
) -> Result<Vec<(String, String)>> {
    Ok(group
        .project_ids
        .iter()
        .cloned()
        .zip(
            groups::group_members(db, group)?
                .into_iter()
                .map(|(name, _)| name),
        )
        .collect())
}

fn project_choice(members: &[(String, String)]) -> String {
    let names = members
        .iter()
        .map(|(_, name)| name.as_str())
        .collect::<Vec<_>>();
    format!("[Kanban/requestProject] project: {}", names.join(", "))
}

fn linear_link(db: &Connection, project_id: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT linear_project_id FROM agent_project_linear_links WHERE project_id=?1",
        [project_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// A group session that named no member gets its only member linked to Linear; with several,
/// the agent must name one.
// shortcut: a worktree session reads its own project's link, which worktrees never have, so its Linear issue gets no project; resolve the repository project if worktree users report it.
pub(super) fn request_linear_project(
    db: &Connection,
    session_id: &str,
    project_id: &str,
    named: Option<&str>,
) -> Result<Option<String>> {
    if let Some(project) = request_project(db, session_id, project_id, named)? {
        return linear_link(db, &project);
    }
    let Some(group) = groups::group_by_group_project(db, project_id)? else {
        return Ok(None);
    };
    let mut linked = Vec::new();
    for (id, name) in named_members(db, &group)? {
        if let Some(link) = linear_link(db, &id)? {
            linked.push((link, name));
        }
    }
    match linked.as_slice() {
        [] => Ok(None),
        [(link, _)] => Ok(Some(link.clone())),
        _ => Err(project_choice(&linked)),
    }
}

/// The issue the session works on, local or Linear.
fn linked_issue(db: &Connection, session_id: &str) -> Result<CreatedIssue> {
    db.query_row(
        "SELECT 0, link.issue_id, team.key || '-' || issue.number
        FROM agent_kanban_issue_sessions link
        JOIN kanban_issues issue ON issue.id=link.issue_id
        JOIN kanban_teams team ON team.id=issue.team_id
        WHERE link.session_id=?1
        UNION ALL
        SELECT 1, linear_issue_id, linear_issue_identifier
        FROM agent_linear_issue_sessions WHERE session_id=?1",
        [session_id],
        |row| {
            let linear: bool = row.get(0)?;
            Ok(CreatedIssue {
                id: row.get(1)?,
                identifier: row.get(2)?,
                source: if linear {
                    KanbanSource::Linear
                } else {
                    KanbanSource::Local
                },
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| kanban_issue_sessions::NOT_LINKED_MESSAGE.into())
}

fn reply(title: &str, updated: bool, result: &Result<CreatedIssue>) -> String {
    match (result, updated) {
        (Ok(issue), false) => format!(
            "Soreno: Kanban issue {} \"{title}\" created.",
            issue.identifier
        ),
        (Ok(issue), true) => format!("Soreno: Kanban issue {} updated.", issue.identifier),
        (Err(error), false) => {
            let error = kanban::untagged_error(error);
            format!("Soreno: the Kanban issue \"{title}\" could not be created: {error}")
        }
        (Err(error), true) => {
            let error = kanban::untagged_error(error);
            format!("Soreno: the linked Kanban issue could not be updated: {error}")
        }
    }
}

fn read_local_request(
    directory: &Path,
    requests: Requests,
    skipped: &HashSet<String>,
) -> Result<Option<(String, Vec<u8>)>> {
    let mut names = std::fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| requests.stem(name).is_some() && !skipped.contains(name))
        .collect::<Vec<_>>();
    names.sort();
    let Some(name) = names.into_iter().next() else {
        return Ok(None);
    };
    let bytes = read_local_file(&directory.join(&name), requests.limit())
        .map_err(|error| error.to_string())?;
    Ok(Some((name, bytes)))
}

/// Reads at most one byte past the limit of a regular file, never through a symlink.
fn read_local_file(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(
        &mut options,
        libc::O_NOFOLLOW | libc::O_NONBLOCK,
    );
    // Opens a symlink itself rather than its target, so the check below rejects it.
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(
        &mut options,
        windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
    );
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    let reparse_point = std::os::windows::fs::MetadataExt::file_attributes(&metadata)
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0;
    #[cfg(not(windows))]
    let reparse_point = false;
    if !metadata.is_file() || reparse_point {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            NOT_REGULAR,
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(super) fn remote_request_script(
    directory: &str,
    requests: Requests,
    skipped: &HashSet<String>,
) -> String {
    let (prefix, suffix) = requests.affixes();
    let skipped = skipped
        .iter()
        .map(|name| {
            format!(
                "  case $f in {}) continue ;; esac\n",
                crate::ssh::quote(name)
            )
        })
        .collect::<String>();
    format!(
        "cd -- {} 2>/dev/null || exit 0\nfor f in {prefix}*{suffix}; do\n  case $f in *[!A-Za-z0-9._-]*) continue ;; esac\n{skipped}  [ -f \"$f\" ] && [ ! -h \"$f\" ] && [ ${{#f}} -gt {} ] && [ ${{#f}} -le {} ] || continue\n  printf '%s\\n' \"$f\"\n  exec head -c {} -- \"$f\"\ndone\n",
        crate::ssh::quote(directory),
        prefix.len() + suffix.len(),
        prefix.len() + REQUEST_STEM_LIMIT + suffix.len(),
        requests.limit() + 1,
    )
}

impl RemoteClipboard {
    fn read_issue_request(
        &self,
        requests: Requests,
        skipped: &HashSet<String>,
    ) -> Result<Option<(String, Vec<u8>)>> {
        let mut state = lock(&self.state)?;
        let directory = Self::directory(&mut state)?;
        let output = crate::ssh::run(
            &state.connection,
            &remote_request_script(&directory, requests, skipped),
            None,
            requests.limit() + 256,
        )?;
        let Some(split) = output.iter().position(|byte| *byte == b'\n') else {
            return Ok(None);
        };
        let name = std::str::from_utf8(&output[..split])
            .ok()
            .filter(|name| requests.stem(name).is_some())
            .ok_or("Nom de demande d’issue distante invalide.")?;
        Ok(Some((name.to_owned(), output[split + 1..].to_vec())))
    }

    fn claim_issue_request(
        &self,
        requests: Requests,
        name: &str,
        claimed: &str,
    ) -> Result<Option<Result<Vec<u8>>>> {
        let mut state = lock(&self.state)?;
        let directory = Self::directory(&mut state)?;
        let output = crate::ssh::run(
            &state.connection,
            &remote_claim_script(&directory, requests, name, claimed),
            None,
            requests.limit() + 256,
        )?;
        if output.is_empty() {
            return Ok(None);
        }
        if let Some(bytes) = output.strip_prefix(b"claimed\n") {
            return Ok(Some(Ok(bytes.to_vec())));
        }
        if output == b"irregular\n" {
            return Ok(Some(Err(NOT_REGULAR.into())));
        }
        Err("Réponse de prise en charge distante invalide.".into())
    }
}

/// Prints `claimed` then the claimed content, or `irregular` for a non-regular file, and deletes
/// it; prints nothing when the request is already gone.
pub(super) fn remote_claim_script(
    directory: &str,
    requests: Requests,
    name: &str,
    claimed: &str,
) -> String {
    let (name, claimed) = (crate::ssh::quote(name), crate::ssh::quote(claimed));
    format!(
        "cd -- {} || exit 1\nif mv -- {name} {claimed}; then\n  status=0\n  if [ -f {claimed} ] && [ ! -h {claimed} ]; then\n    echo claimed\n    head -c {} -- {claimed} || status=1\n  else\n    echo irregular\n  fi\n  rm -f -- {claimed}\n  exit $status\nelif [ -e {name} ] || [ -h {name} ]; then\n  exit 1\nfi\n",
        crate::ssh::quote(directory),
        requests.limit() + 1,
    )
}

fn read_request(
    run: &Run,
    requests: Requests,
    skipped: &HashSet<String>,
) -> Result<Option<(String, Vec<u8>)>> {
    let (local, remote) = run.files();
    if let Some(directory) = lock(local)?.clone() {
        return read_local_request(&directory, requests, skipped);
    }
    match remote {
        Some(remote) => remote.read_issue_request(requests, skipped),
        None => Ok(None),
    }
}

/// Renames the request out of the scanned names so a single watcher handles it, then reads and
/// deletes the claimed file: the name may now hold a newer request than the scanned one.
/// `None`: another watcher sharing the directory already claimed it; the inner error: the claimed
/// file could not be read.
fn claim_request(
    run: &Run,
    requests: Requests,
    name: &str,
    claimed: &str,
) -> Result<Option<Result<Vec<u8>>>> {
    let (local, remote) = run.files();
    if let Some(directory) = lock(local)?.clone() {
        let claimed = directory.join(claimed);
        return match std::fs::rename(directory.join(name), &claimed) {
            Ok(()) => {
                let bytes =
                    read_local_file(&claimed, requests.limit()).map_err(|error| error.to_string());
                // A leftover claimed file is never scanned again.
                let _ = std::fs::remove_file(claimed);
                Ok(Some(bytes))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        };
    }
    match remote {
        Some(remote) => remote.claim_issue_request(requests, name, claimed),
        None => Err(STOPPED.into()),
    }
}

impl AgentSessions {
    /// Watches the session's current run when it is an agent; `None` for terminals and services.
    pub fn issue_request_watcher(&self, session_id: &str) -> Result<Option<IssueRequestWatcher>> {
        let store = lock(&self.store)?;
        let session = require_session(&store, session_id)?;
        let run = if session.kind == conversation::KIND {
            store
                .omp_conversations
                .get(session_id)
                .map(|run| WatchedRun::Conversation(Arc::downgrade(run)))
        } else if session.kind == "service"
            || conversations::provider(&session.executable).is_none()
        {
            return Ok(None);
        } else {
            store
                .runtimes
                .get(session_id)
                .map(|run| WatchedRun::Terminal(Arc::downgrade(run)))
        };
        Ok(run.map(|run| IssueRequestWatcher {
            session_id: session_id.to_owned(),
            run,
            design: session.design,
            failures: HashMap::new(),
            skipped: HashSet::new(),
            image_targets: Vec::new(),
            mirror_pending: true,
        }))
    }

    /// Writes the run's design board mirror once; retried on each scan until it succeeds, since an
    /// SSH dtach launch only creates its directory once its remote script ran.
    pub fn sync_design_mirror(&self, watcher: &mut IssueRequestWatcher) {
        if !watcher.mirror_pending {
            return;
        }
        let Some(run) = watcher.run.upgrade() else {
            return;
        };
        let (local, remote) = run.files();
        match self.write_design_mirror(&watcher.session_id, local, remote) {
            Ok(_) => watcher.mirror_pending = false,
            Err(error) => eprintln!("Miroir des cadres Design : {error}"),
        }
    }

    /// Removes the design frame files the session's live run left unclaimed; bounded so an agent
    /// still writing cannot keep it looping, and fails if frames remain so the link is not switched.
    pub(super) fn discard_design_frames(&self, session_id: &str) -> Result<()> {
        let Some(run) = Run::current(&*lock(&self.store)?, session_id) else {
            return Ok(());
        };
        if run.exited()? {
            return Ok(());
        }
        let (local, remote) = run.files();
        for _ in 0..design::FRAME_CAPACITY {
            let Some((name, _)) = read_request(&run, Requests::DesignFrames, &HashSet::new())?
            else {
                return Ok(());
            };
            design::write_private(local, remote, false, &name, None)?;
        }
        if read_request(&run, Requests::DesignFrames, &HashSet::new())?.is_some() {
            return Err(
                "Trop de cadres Design en attente : réessayez une fois l’agent arrêté.".into(),
            );
        }
        Ok(())
    }

    /// Looks for one request file; unreadable directories are retried on the next scan.
    pub fn scan_issue_request(
        &self,
        watcher: &mut IssueRequestWatcher,
    ) -> Result<IssueRequestScan> {
        let Some(run) = watcher.run.upgrade() else {
            return Ok(IssueRequestScan::Stopped);
        };
        if !self.is_watched_run(&watcher.session_id, &run)? {
            return Ok(IssueRequestScan::Stopped);
        }
        self.sync_design_mirror(watcher);
        // A coding session draws in its linked board, if any, beside its Kanban requests.
        let board_id = design::session_board(&lock(&self.store)?.db, &watcher.session_id)?;
        let kinds: &[Requests] = match (watcher.design, &board_id) {
            (true, _) => &[Requests::DesignFrames],
            (false, Some(_)) => &[Requests::Kanban, Requests::DesignFrames],
            (false, None) => &[Requests::Kanban],
        };
        let Some((requests, name, bytes)) = kinds.iter().find_map(|&requests| {
            let found = read_request(&run, requests, &watcher.skipped).ok()??;
            Some((requests, found.0, found.1))
        }) else {
            return Ok(IssueRequestScan::Idle);
        };
        let board_id = (requests == Requests::DesignFrames)
            .then_some(board_id)
            .flatten();
        if requests.complete(&bytes) {
            watcher.failures.remove(&name);
            return Ok(IssueRequestScan::Request(IssueRequest {
                name,
                requests,
                board_id,
            }));
        }
        let failures = watcher.failures.entry(name.clone()).or_default();
        *failures += 1;
        if *failures < PARSE_ATTEMPTS {
            return Ok(IssueRequestScan::Idle);
        }
        watcher.failures.remove(&name);
        Ok(IssueRequestScan::Request(IssueRequest {
            name,
            requests,
            board_id,
        }))
    }

    /// Claims the request file, creates or edits the issue and queues the reply; `None` when
    /// another watcher sharing the directory claimed it first. A request asking for Linear, or
    /// from a session linked to a Linear issue, goes to `linear`, which is `Ok(None)` while
    /// Soreno holds no Linear key and the key read error when the keychain fails.
    pub fn handle_issue_request(
        &self,
        watcher: &mut IssueRequestWatcher,
        request: IssueRequest,
        linear: Result<Option<LinearIssueCreator<'_>>>,
    ) -> Result<Option<IssueRequestOutcome>> {
        let (session_name, project_id, linked_linear_issue, message_id, agent) = {
            let store = lock(&self.store)?;
            let session = require_session(&store, &watcher.session_id)?;
            let message_id =
                crate::sqlite::random_id(&store.db).map_err(|error| error.to_string())?;
            // Signs the agent's comments as the front reads them; watched runs are always agents.
            let agent = if session.kind == conversation::KIND {
                conversation::EXECUTABLE
            } else {
                conversations::provider(&session.executable).map_or("agent", Provider::as_str)
            };
            (
                session.display_name().to_owned(),
                session.project_id,
                kanban_issue_sessions::linked_linear_issue(&store.db, &watcher.session_id)?,
                message_id,
                agent,
            )
        };
        let content = match watcher.claim(&request, &message_id) {
            None => return Ok(None),
            Some(bytes) => bytes.and_then(|bytes| parse_request(&bytes)),
        };
        let (title, updated) = match &content {
            Ok(Request::Create(content)) => (content.title.clone(), false),
            Ok(Request::Update(edit)) => (
                edit.title.clone().unwrap_or_else(|| request.name.clone()),
                true,
            ),
            // shortcut: an invalid `update` request (no field, blank title) is reported as a failed creation, though its error names the cause; keep the flag through validation if agents get confused.
            Err(_) => (request.name.clone(), false),
        };
        let result = content.and_then(|content| match content {
            Request::Create(content) => self.create_requested_issue(
                &watcher.session_id,
                &project_id,
                linked_linear_issue,
                content,
                linear,
            ),
            Request::Update(edit) => self.update_linked_issue(
                &watcher.session_id,
                agent,
                edit,
                &watcher.image_targets,
                linear,
            ),
        });
        let sent = self.send_message(
            &watcher.session_id,
            &message_id,
            &reply(&title, updated, &result),
        );
        let (issue, error) = match result {
            Ok(issue) => (Some(issue), None),
            Err(error) => (None, Some(error)),
        };
        Ok(Some(IssueRequestOutcome {
            event: KanbanIssueRequestEvent {
                session_id: watcher.session_id.clone(),
                session_name,
                title,
                updated,
                issue,
                error,
            },
            queued: sent.is_ok(),
            start_worker: sent.is_ok_and(|(_, start_worker)| start_worker),
        }))
    }

    /// Claims the frame file and stores it in the session's board; only an error is replied.
    pub fn handle_design_frame(
        &self,
        watcher: &mut IssueRequestWatcher,
        request: IssueRequest,
    ) -> Result<Option<DesignFrameOutcome>> {
        let message_id = {
            let store = lock(&self.store)?;
            crate::sqlite::random_id(&store.db).map_err(|error| error.to_string())?
        };
        let frame_id = Requests::DesignFrames
            .stem(&request.name)
            .ok_or("Nom de cadre invalide.")?
            .to_owned();
        let Some(bytes) = watcher.claim(&request, &message_id) else {
            return Ok(None);
        };
        let result = bytes
            .and_then(|bytes| design::parse_frame(&bytes))
            .and_then(|frame| {
                let board_id = request.board_id.clone().ok_or(design::BOARD_CHANGED)?;
                self.kanban(|db, _| {
                    design::ingest_frame(db, &watcher.session_id, &board_id, &frame_id, frame)
                })?;
                Ok(board_id)
            });
        let (board_id, sent) = match result {
            Ok(board_id) => {
                self.sync_design_frame(&board_id, &frame_id);
                (Some(board_id), None)
            }
            Err(error) => (
                None,
                Some(self.send_message(
                    &watcher.session_id,
                    &message_id,
                    &format!(
                        "Soreno: the design frame \"{frame_id}\" was not saved: {}",
                        kanban::untagged_error(&error)
                    ),
                )),
            ),
        };
        Ok(Some(DesignFrameOutcome {
            session_id: watcher.session_id.clone(),
            board_id,
            queued: sent.as_ref().is_some_and(Result::is_ok),
            start_worker: sent.is_some_and(|sent| sent.is_ok_and(|(_, start_worker)| start_worker)),
        }))
    }

    fn create_requested_issue(
        &self,
        session_id: &str,
        project_id: &str,
        linked_linear_issue: Option<String>,
        content: IssueContent,
        create_linear: Result<Option<LinearIssueCreator<'_>>>,
    ) -> Result<CreatedIssue> {
        let linear = content.linear || linked_linear_issue.is_some();
        let named = content.project.as_deref();
        match create_linear {
            Ok(Some(create_linear)) if linear => create_linear(LinearIssueRequest::Create {
                // Linear places an issue next to the linked one, whatever project this names.
                linear_project_id: match linked_linear_issue {
                    Some(_) => None,
                    None => self.kanban(|db, _| {
                        request_linear_project(db, session_id, project_id, named)
                    })?,
                },
                linked_issue_id: linked_linear_issue,
                title: content.title,
                description: content.description,
            }),
            Err(error) if linear => Err(error),
            // A linked session falls back to a local issue; an explicit Linear request does not.
            Ok(None) if content.linear => Err(linear::MISSING_API_KEY_MESSAGE.into()),
            _ => self.kanban(|db, _| {
                let issue = kanban::create_issue(
                    db,
                    KanbanIssueCreateInput {
                        team_id: kanban::default_team_id(db)?,
                        title: content.title,
                        description: content.description,
                        project_id: request_project(db, session_id, project_id, named)?,
                        ..KanbanIssueCreateInput::default()
                    },
                )?;
                Ok(CreatedIssue {
                    id: issue.id,
                    identifier: issue.identifier,
                    source: KanbanSource::Local,
                })
            }),
        }
    }

    /// A Linear issue is never edited locally: without a Linear key the edit fails.
    fn update_linked_issue(
        &self,
        session_id: &str,
        agent: &str,
        edit: IssueEdit,
        image_targets: &[String],
        update_linear: Result<Option<LinearIssueCreator<'_>>>,
    ) -> Result<CreatedIssue> {
        let description = edit
            .description
            .map(|description| resolve_image_placeholders(&description, image_targets))
            .transpose()?;
        let issue = self.kanban(|db, _| linked_issue(db, session_id))?;
        if issue.source == KanbanSource::Linear {
            let update_linear = update_linear?.ok_or(linear::MISSING_API_KEY_MESSAGE)?;
            return update_linear(LinearIssueRequest::Update {
                issue,
                title: edit.title,
                description,
            });
        }
        self.kanban(|db, _| {
            if let Some(title) = edit.title {
                kanban::update_issue(
                    db,
                    &issue.id,
                    KanbanIssueInput {
                        title: Some(title),
                        ..KanbanIssueInput::default()
                    },
                )?;
            }
            if let Some(description) = description {
                // A local issue keeps no history: the signed comment says what the agent changed.
                kanban::replace_description(
                    db,
                    &issue.id,
                    &description,
                    &format!("{}\n\n— {agent} via Soreno", edit.summary),
                )?;
            }
            Ok(issue)
        })
    }

    fn is_watched_run(&self, session_id: &str, run: &Run) -> Result<bool> {
        let store = lock(&self.store)?;
        Ok(match run {
            Run::Terminal(run) => {
                store
                    .runtimes
                    .get(session_id)
                    .is_some_and(|current| Arc::ptr_eq(current, run))
                    && !lock(&run.output)?.exited
            }
            Run::Conversation(run) => {
                store
                    .omp_conversations
                    .get(session_id)
                    .is_some_and(|current| Arc::ptr_eq(current, run))
                    && !run.exited()
            }
        })
    }
}
