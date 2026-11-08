//! Local Kanban board stored in `agents.sqlite`, next to the agent sessions it links to.
use crate::sqlite::{random_id, table_column_exists};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[path = "kanban/branch_name.rs"]
mod branch_name;
#[path = "kanban/comments.rs"]
mod comments;
#[path = "kanban/images.rs"]
pub(crate) mod images;
#[path = "kanban/labels.rs"]
mod labels;
#[path = "kanban/pull_requests.rs"]
mod pull_requests;
#[path = "kanban/reading.rs"]
mod reading;

use branch_name::branch_name;
pub(crate) use comments::{appended_summary, create_comment, delete_comment, post_summary};
use labels::team_labels;
pub(crate) use labels::{create_label, required_label_name};
pub(crate) use pull_requests::extract_pull_requests;
use pull_requests::text_pull_requests;
use reading::{comment_row, load_summary, team_states};
pub(crate) use reading::{default_team_id, load_board, load_issue};

type Result<T, E = String> = std::result::Result<T, E>;

const MIGRATION: &str = "kanban_local_v1";
const TITLE_LIMIT: usize = 255;
const DEFAULT_TEAM_KEY: &str = "SOR";
const DEFAULT_TEAM_NAME: &str = "Soreno";
const DEFAULT_STATES: [(&str, &str, &str); 6] = [
    ("Backlog", "backlog", "#bec2c8"),
    ("Todo", "unstarted", "#e2e2e2"),
    ("In Progress", "started", "#f2c94c"),
    ("In Review", "started", "#4cb782"),
    ("Done", "completed", "#5e6ad2"),
    ("Canceled", "canceled", "#95a2b3"),
];

// The `[Kanban/<code>]` tag lets the interface show a localized message; the text stays for logs.
pub(crate) const ISSUE_NOT_FOUND: &str = "[Kanban/issueNotFound] Issue introuvable.";
const TEAM_NOT_FOUND: &str = "[Kanban/teamNotFound] Équipe introuvable.";
const STATE_NOT_FOUND: &str = "[Kanban/stateNotFound] État introuvable dans l’équipe de l’issue.";
const LABEL_NOT_FOUND: &str = "[Kanban/labelNotFound] Label introuvable dans l’équipe de l’issue.";
const PARENT_NOT_FOUND: &str =
    "[Kanban/parentNotFound] Issue parente introuvable dans l’équipe de l’issue.";
const PROJECT_NOT_FOUND: &str = "[Kanban/projectNotFound] Projet introuvable.";
pub(crate) const TRANSFER_SUB_ISSUES_MESSAGE: &str = "[Kanban/transferSubIssues] Une issue avec des sous-issues ou une issue parente ne peut pas être envoyée vers Linear.";
pub(crate) const TITLE_MESSAGE: &str =
    "[Kanban/invalidTitle] Titre de l’issue vide ou trop long (255 caractères maximum).";
pub(crate) const PRIORITY_MESSAGE: &str =
    "[Kanban/invalidPriority] La priorité doit être comprise entre 0 et 4.";
pub(crate) const EMPTY_COMMENT_MESSAGE: &str = "[Kanban/emptyComment] Le commentaire est vide.";
pub(crate) const EMPTY_UPDATE_MESSAGE: &str =
    "[Kanban/emptyUpdate] La modification de l’issue est vide.";
pub(crate) const LABEL_CONFLICT_MESSAGE: &str =
    "[Kanban/labelConflict] Un label ne peut pas être à la fois ajouté et retiré.";

/// The error without its `[Kanban/<code>]` tag, for readers that do not localize it.
pub(crate) fn untagged_error(error: &str) -> &str {
    error
        .strip_prefix("[Kanban/")
        .and_then(|rest| rest.split_once("] "))
        .map_or(error, |(_, text)| text)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KanbanSource {
    Local,
    Linear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanWorkflowState {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub color: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanLabel {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanProjectRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanUserRef {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanLinearProjectRef {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// Fields only a Linear issue has, serialized next to the shared ones.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanLinearFields {
    pub url: String,
    pub assignee: Option<KanbanUserRef>,
    pub linear_project: Option<KanbanLinearProjectRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanPullRequest {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssue {
    pub source: KanbanSource,
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub priority: u8,
    pub state_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub project: Option<KanbanProjectRef>,
    pub labels: Vec<KanbanLabel>,
    pub pull_requests: Vec<KanbanPullRequest>,
    #[serde(flatten)]
    pub linear: Option<KanbanLinearFields>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBoard {
    pub source: KanbanSource,
    pub team: KanbanTeam,
    pub states: Vec<KanbanWorkflowState>,
    pub labels: Vec<KanbanLabel>,
    pub issues: Vec<KanbanIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssueUpdate {
    pub id: String,
    pub title: String,
    pub state_id: String,
    pub priority: u8,
    pub project: Option<KanbanProjectRef>,
    pub labels: Vec<KanbanLabel>,
    pub updated_at: String,
    #[serde(flatten)]
    pub linear: Option<KanbanLinearFields>,
}

impl From<KanbanIssue> for KanbanIssueUpdate {
    fn from(issue: KanbanIssue) -> Self {
        Self {
            id: issue.id,
            title: issue.title,
            state_id: issue.state_id,
            priority: issue.priority,
            project: issue.project,
            labels: issue.labels,
            updated_at: issue.updated_at,
            linear: issue.linear,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssueDescriptionUpdate {
    pub id: String,
    pub description: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KanbanIssueInput {
    pub state_id: Option<String>,
    pub priority: Option<u8>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub project_id: Option<Option<String>>,
    #[serde(default)]
    pub added_label_ids: Vec<String>,
    #[serde(default)]
    pub removed_label_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KanbanIssueCreateInput {
    pub team_id: String,
    pub title: String,
    pub description: Option<String>,
    pub state_id: Option<String>,
    pub priority: Option<u8>,
    pub project_id: Option<String>,
    #[serde(default)]
    pub label_ids: Vec<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanComment {
    pub id: String,
    pub body: String,
    pub created_at: String,
    /// Linear only; `Some(None)` is a comment whose author Linear does not show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<Option<KanbanUserRef>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanSubIssueState {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanSubIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub state: KanbanSubIssueState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssueDetail {
    pub source: KanbanSource,
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub branch_name: String,
    pub priority: u8,
    pub state_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub project: Option<KanbanProjectRef>,
    pub labels: Vec<KanbanLabel>,
    pub children: Vec<KanbanSubIssue>,
    pub comments: Vec<KanbanComment>,
    pub pull_requests: Vec<KanbanPullRequest>,
    /// Linear only: a local issue's team is the single default one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(flatten)]
    pub linear: Option<KanbanLinearFields>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanIssueCompletion {
    pub comment: KanbanComment,
    pub update: Option<KanbanIssueUpdate>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}

/// Runs after the agent tables exist: issues reference projects and sessions.
pub(crate) fn initialize(db: &mut Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS kanban_teams (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, next_issue_number INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS kanban_states (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES kanban_teams(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('backlog','unstarted','started','completed','canceled')), color TEXT NOT NULL, position REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS kanban_issues (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES kanban_teams(id) ON DELETE CASCADE, number INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4), state_id TEXT NOT NULL REFERENCES kanban_states(id), project_id TEXT REFERENCES agent_projects(id) ON DELETE SET NULL, parent_id TEXT REFERENCES kanban_issues(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(team_id, number));
        CREATE TABLE IF NOT EXISTS kanban_labels (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES kanban_teams(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kanban_issue_labels (issue_id TEXT NOT NULL REFERENCES kanban_issues(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES kanban_labels(id) ON DELETE CASCADE, PRIMARY KEY(issue_id, label_id));
        CREATE TABLE IF NOT EXISTS kanban_comments (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES kanban_issues(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kanban_images (id TEXT PRIMARY KEY, issue_id TEXT REFERENCES kanban_issues(id) ON DELETE CASCADE, file_name TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_kanban_issue_sessions (issue_id TEXT PRIMARY KEY REFERENCES kanban_issues(id) ON DELETE CASCADE, session_id TEXT UNIQUE REFERENCES agent_sessions(id) ON DELETE SET NULL, session_name TEXT NOT NULL, executable TEXT NOT NULL, project_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT CHECK (end_reason IN ('session','project','worktree','merged')), merged_into TEXT, summary_comment_id TEXT REFERENCES kanban_comments(id) ON DELETE SET NULL);
        CREATE TABLE IF NOT EXISTS agent_kanban_issue_summaries (summary_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES agent_kanban_issue_sessions(issue_id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS agent_linear_issue_sessions (linear_issue_id TEXT PRIMARY KEY, linear_issue_identifier TEXT NOT NULL, session_id TEXT UNIQUE REFERENCES agent_sessions(id) ON DELETE SET NULL, session_name TEXT NOT NULL, executable TEXT NOT NULL, project_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT CHECK (end_reason IN ('session','project','worktree','merged')), merged_into TEXT, summary_comment_id TEXT);
        CREATE TABLE IF NOT EXISTS agent_linear_issue_summaries (summary_id TEXT PRIMARY KEY, linear_issue_id TEXT NOT NULL REFERENCES agent_linear_issue_sessions(linear_issue_id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS agent_project_linear_links (project_id TEXT PRIMARY KEY REFERENCES agent_projects(id) ON DELETE CASCADE, linear_project_id TEXT NOT NULL UNIQUE);
        CREATE INDEX IF NOT EXISTS kanban_issues_parent ON kanban_issues(parent_id);
        CREATE INDEX IF NOT EXISTS kanban_comments_issue ON kanban_comments(issue_id);
        CREATE INDEX IF NOT EXISTS kanban_images_issue ON kanban_images(issue_id);",
    )
    .map_err(sql)?;
    let tx = db.transaction().map_err(sql)?;
    // Links of the former, pre-Linear-project schema.
    tx.execute_batch("DROP TABLE IF EXISTS agent_session_linear_issues;")
        .map_err(sql)?;
    // Closing a session was first recorded on its issue link, and older versions recreate the
    // Linear one that way; it now belongs to the session.
    for table in ["agent_kanban_issue_sessions", "agent_linear_issue_sessions"] {
        if table_column_exists(&tx, table, "closed").map_err(sql)? {
            tx.execute_batch(&format!(
                "UPDATE agent_sessions SET closed=1
                    WHERE id IN (SELECT session_id FROM {table} WHERE closed=1);
                ALTER TABLE {table} DROP COLUMN closed;"
            ))
            .map_err(sql)?;
        }
    }
    // Soreno 0.4.2 and older created the Linear link table without it.
    if !table_column_exists(&tx, "agent_linear_issue_sessions", "summary_comment_id")
        .map_err(sql)?
    {
        tx.execute_batch(
            "ALTER TABLE agent_linear_issue_sessions ADD COLUMN summary_comment_id TEXT;",
        )
        .map_err(sql)?;
    }
    let migrated: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_schema_migrations WHERE name=?1)",
            [MIGRATION],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if migrated {
        return tx.commit().map_err(sql);
    }
    let team_id = new_id(&tx)?;
    tx.execute(
        "INSERT INTO kanban_teams(id, key, name) VALUES (?1, ?2, ?3)",
        params![team_id, DEFAULT_TEAM_KEY, DEFAULT_TEAM_NAME],
    )
    .map_err(sql)?;
    for (position, (name, kind, color)) in DEFAULT_STATES.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO kanban_states(id, team_id, name, type, color, position)
            VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
            params![team_id, name, kind, color, position as f64],
        )
        .map_err(sql)?;
    }
    tx.execute(
        "INSERT INTO agent_schema_migrations(name) VALUES (?1)",
        [MIGRATION],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)
}

fn new_id(db: &Connection) -> Result<String> {
    random_id(db).map_err(sql)
}

pub(crate) fn compare_names(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| left.cmp(right))
}

fn state_type_rank(state_type: &str) -> u8 {
    match state_type {
        "triage" => 0,
        "backlog" => 1,
        "unstarted" => 2,
        "started" => 3,
        "completed" => 4,
        "canceled" => 5,
        _ => 6,
    }
}

pub(crate) fn sort_states(states: &mut [KanbanWorkflowState]) {
    states.sort_by(|left, right| {
        state_type_rank(&left.r#type)
            .cmp(&state_type_rank(&right.r#type))
            .then_with(|| left.position.total_cmp(&right.position))
    });
}

pub(crate) fn required_title(title: &str) -> Result<&str> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > TITLE_LIMIT || title.contains('\0') {
        return Err(TITLE_MESSAGE.into());
    }
    Ok(title)
}

pub(crate) fn validate_priority(priority: u8) -> Result<u8> {
    if priority > 4 {
        return Err(PRIORITY_MESSAGE.into());
    }
    Ok(priority)
}

pub(crate) fn trimmed(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

fn exists(db: &Connection, query: &str, values: impl rusqlite::Params) -> Result<bool> {
    db.query_row(query, values, |row| row.get(0)).map_err(sql)
}

fn require_team(db: &Connection, team_id: &str) -> Result<()> {
    if !exists(
        db,
        "SELECT EXISTS(SELECT 1 FROM kanban_teams WHERE id=?1)",
        [team_id],
    )? {
        return Err(TEAM_NOT_FOUND.into());
    }
    Ok(())
}

fn issue_team(db: &Connection, issue_id: &str) -> Result<String> {
    db.query_row(
        "SELECT team_id FROM kanban_issues WHERE id=?1",
        [issue_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql)?
    .ok_or_else(|| ISSUE_NOT_FOUND.into())
}

fn require_state(db: &Connection, team_id: &str, state_id: &str) -> Result<()> {
    if !exists(
        db,
        "SELECT EXISTS(SELECT 1 FROM kanban_states WHERE id=?1 AND team_id=?2)",
        [state_id, team_id],
    )? {
        return Err(STATE_NOT_FOUND.into());
    }
    Ok(())
}

fn require_labels(db: &Connection, team_id: &str, label_ids: &[String]) -> Result<()> {
    for label_id in label_ids {
        if !exists(
            db,
            "SELECT EXISTS(SELECT 1 FROM kanban_labels WHERE id=?1 AND team_id=?2)",
            [label_id, team_id],
        )? {
            return Err(LABEL_NOT_FOUND.into());
        }
    }
    Ok(())
}

fn require_project(db: &Connection, project_id: &str) -> Result<()> {
    if !exists(
        db,
        "SELECT EXISTS(SELECT 1 FROM agent_projects WHERE id=?1)",
        [project_id],
    )? {
        return Err(PROJECT_NOT_FOUND.into());
    }
    Ok(())
}

/// `updated_at` versions the issue for the frontend: it must grow on every write,
/// even within one millisecond or after the clock steps back.
fn touch(db: &Connection, issue_id: &str) -> Result<()> {
    db.execute(
        "UPDATE kanban_issues SET updated_at=max(
            strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
        ) WHERE id=?1",
        [issue_id],
    )
    .map_err(sql)?;
    Ok(())
}

/// Uploaded images belong to the first issue whose text references them.
fn claim_images(db: &Connection, issue_id: &str, text: &str) -> Result<()> {
    db.execute(
        "UPDATE kanban_images SET issue_id=?1 WHERE issue_id IS NULL AND instr(?2, file_name) > 0",
        params![issue_id, text],
    )
    .map_err(sql)?;
    Ok(())
}

/// The first unstarted state, else the first state of the workflow.
fn default_state(db: &Connection, team_id: &str) -> Result<String> {
    let states = team_states(db, team_id)?;
    states
        .iter()
        .find(|state| state.r#type == "unstarted")
        .or(states.first())
        .map(|state| state.id.clone())
        .ok_or_else(|| STATE_NOT_FOUND.into())
}

pub(crate) fn create_issue(db: &Connection, input: KanbanIssueCreateInput) -> Result<KanbanIssue> {
    let title = required_title(&input.title)?;
    require_team(db, &input.team_id)?;
    let state_id = match input.state_id {
        Some(state_id) => {
            require_state(db, &input.team_id, &state_id)?;
            state_id
        }
        None => default_state(db, &input.team_id)?,
    };
    let priority = input.priority.map(validate_priority).transpose()?;
    if let Some(project_id) = &input.project_id {
        require_project(db, project_id)?;
    }
    if let Some(parent_id) = &input.parent_id {
        let parent_team: Option<String> = db
            .query_row(
                "SELECT team_id FROM kanban_issues WHERE id=?1",
                [parent_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        if parent_team.as_ref() != Some(&input.team_id) {
            return Err(PARENT_NOT_FOUND.into());
        }
    }
    require_labels(db, &input.team_id, &input.label_ids)?;
    let description = trimmed(input.description.as_deref());
    let number: i64 = db
        .query_row(
            "UPDATE kanban_teams SET next_issue_number=next_issue_number+1 WHERE id=?1 RETURNING next_issue_number-1",
            [&input.team_id],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let issue_id = new_id(db)?;
    db.execute(
        "INSERT INTO kanban_issues(id, team_id, number, title, description, priority, state_id, project_id, parent_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            issue_id,
            input.team_id,
            number,
            title,
            description,
            priority.unwrap_or(0),
            state_id,
            input.project_id,
            input.parent_id
        ],
    )
    .map_err(sql)?;
    for label_id in &input.label_ids {
        db.execute(
            "INSERT OR IGNORE INTO kanban_issue_labels(issue_id, label_id) VALUES (?1, ?2)",
            [&issue_id, label_id],
        )
        .map_err(sql)?;
    }
    if let Some(description) = description {
        claim_images(db, &issue_id, description)?;
    }
    load_summary(db, &issue_id)
}

pub(crate) fn update_issue(
    db: &Connection,
    issue_id: &str,
    patch: KanbanIssueInput,
) -> Result<KanbanIssueUpdate> {
    if patch.state_id.is_none()
        && patch.priority.is_none()
        && patch.title.is_none()
        && patch.project_id.is_none()
        && patch.added_label_ids.is_empty()
        && patch.removed_label_ids.is_empty()
    {
        return Err(EMPTY_UPDATE_MESSAGE.into());
    }
    if patch
        .added_label_ids
        .iter()
        .any(|id| patch.removed_label_ids.contains(id))
    {
        return Err(LABEL_CONFLICT_MESSAGE.into());
    }
    let team_id = issue_team(db, issue_id)?;
    if let Some(state_id) = &patch.state_id {
        require_state(db, &team_id, state_id)?;
    }
    let priority = patch.priority.map(validate_priority).transpose()?;
    let title = patch.title.as_deref().map(required_title).transpose()?;
    if let Some(Some(project_id)) = &patch.project_id {
        require_project(db, project_id)?;
    }
    require_labels(db, &team_id, &patch.added_label_ids)?;
    require_labels(db, &team_id, &patch.removed_label_ids)?;

    if let Some(state_id) = &patch.state_id {
        db.execute(
            "UPDATE kanban_issues SET state_id=?2 WHERE id=?1",
            [issue_id, state_id],
        )
        .map_err(sql)?;
    }
    if let Some(priority) = priority {
        db.execute(
            "UPDATE kanban_issues SET priority=?2 WHERE id=?1",
            params![issue_id, priority],
        )
        .map_err(sql)?;
    }
    if let Some(title) = title {
        db.execute(
            "UPDATE kanban_issues SET title=?2 WHERE id=?1",
            [issue_id, title],
        )
        .map_err(sql)?;
    }
    if let Some(project_id) = &patch.project_id {
        db.execute(
            "UPDATE kanban_issues SET project_id=?2 WHERE id=?1",
            params![issue_id, project_id],
        )
        .map_err(sql)?;
    }
    for label_id in &patch.added_label_ids {
        db.execute(
            "INSERT OR IGNORE INTO kanban_issue_labels(issue_id, label_id) VALUES (?1, ?2)",
            [issue_id, label_id],
        )
        .map_err(sql)?;
    }
    for label_id in &patch.removed_label_ids {
        db.execute(
            "DELETE FROM kanban_issue_labels WHERE issue_id=?1 AND label_id=?2",
            [issue_id, label_id],
        )
        .map_err(sql)?;
    }
    touch(db, issue_id)?;
    Ok(load_summary(db, issue_id)?.into())
}

pub(crate) fn update_description(
    db: &Connection,
    issue_id: &str,
    description: &str,
) -> Result<KanbanIssueDescriptionUpdate> {
    issue_team(db, issue_id)?;
    let description = trimmed(Some(description));
    db.execute(
        "UPDATE kanban_issues SET description=?2 WHERE id=?1",
        params![issue_id, description],
    )
    .map_err(sql)?;
    touch(db, issue_id)?;
    if let Some(description) = description {
        claim_images(db, issue_id, description)?;
    }
    db.query_row(
        "SELECT id, description, updated_at FROM kanban_issues WHERE id=?1",
        [issue_id],
        |row| {
            Ok(KanbanIssueDescriptionUpdate {
                id: row.get(0)?,
                description: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .map_err(sql)
}

/// Returns the file names of the issue's images no other issue references, to delete once the
/// deletion is committed.
pub(crate) fn delete_issue(db: &Connection, issue_id: &str) -> Result<Vec<String>> {
    issue_team(db, issue_id)?;
    // An image whose Markdown was copied elsewhere moves to the oldest issue still showing it.
    db.execute(
        "UPDATE kanban_images SET issue_id=COALESCE((
            SELECT i.id FROM kanban_issues i
            WHERE i.id<>?1 AND (instr(COALESCE(i.description, ''), kanban_images.file_name) > 0
                OR EXISTS(SELECT 1 FROM kanban_comments c
                    WHERE c.issue_id=i.id AND instr(c.body, kanban_images.file_name) > 0))
            ORDER BY i.created_at, i.id LIMIT 1), issue_id)
        WHERE issue_id=?1",
        [issue_id],
    )
    .map_err(sql)?;
    let files = db
        .prepare("SELECT file_name FROM kanban_images WHERE issue_id=?1")
        .map_err(sql)?
        .query_map([issue_id], |row| row.get(0))
        .map_err(sql)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql)?;
    db.execute("DELETE FROM kanban_issues WHERE id=?1", [issue_id])
        .map_err(sql)?;
    Ok(files)
}

/// Linear has no review state type: review is the first started state named so.
/// Settled issues and issues already there stay put.
pub(crate) fn review_state_id<'a>(
    states: &'a [KanbanWorkflowState],
    current_id: &str,
    current_type: &str,
) -> Option<&'a str> {
    if matches!(current_type, "completed" | "canceled") {
        return None;
    }
    states
        .iter()
        .filter(|state| {
            let name = state.name.to_lowercase();
            state.r#type == "started" && (name.contains("review") || name.contains("revue"))
        })
        .min_by(|left, right| left.position.total_cmp(&right.position))
        .map(|state| state.id.as_str())
        .filter(|id| *id != current_id)
}

pub(crate) fn move_issue_to_review(
    db: &Connection,
    issue_id: &str,
) -> Result<Option<KanbanIssueUpdate>> {
    let (team_id, state_id, state_type): (String, String, String) = db
        .query_row(
            "SELECT i.team_id, s.id, s.type FROM kanban_issues i JOIN kanban_states s ON s.id=i.state_id WHERE i.id=?1",
            [issue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or(ISSUE_NOT_FOUND)?;
    let states = team_states(db, &team_id)?;
    let Some(review) = review_state_id(&states, &state_id, &state_type) else {
        return Ok(None);
    };
    let patch = KanbanIssueInput {
        state_id: Some(review.to_owned()),
        ..KanbanIssueInput::default()
    };
    update_issue(db, issue_id, patch).map(Some)
}

#[cfg(test)]
#[path = "kanban_tests.rs"]
mod tests;
