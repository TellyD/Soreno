//! Linear issues of one team at a time, read and written through Linear's GraphQL API and
//! serialized in the local Kanban shapes. Each connected workspace has its own API key; nothing is
//! stored locally but those keys and the agent links.
use crate::kanban::{
    self, KanbanBoard, KanbanComment, KanbanIssue, KanbanIssueCreateInput,
    KanbanIssueDescriptionUpdate, KanbanIssueDetail, KanbanIssueInput, KanbanIssueUpdate,
    KanbanLabel, KanbanLinearFields, KanbanLinearProjectRef, KanbanProjectRef, KanbanPullRequest,
    KanbanSource, KanbanSubIssue, KanbanTeam,
};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

type Result<T, E = String> = std::result::Result<T, E>;

const LINEAR_GRAPHQL_URL: &str = "https://api.linear.app/graphql";
#[cfg(windows)]
const KEYRING_TARGET: &str = "soreno.linear_api_key";
const KEYRING_SERVICE: &str = "soreno";
const KEYRING_ACCOUNT: &str = "linear_api_key";
const MAX_ISSUE_PAGES: usize = 5;
const MAX_PAGES: usize = 20;
const LABEL_BATCH_SIZE: usize = 250;
// A keychain read can prompt on macOS, so the keys are read at most once per session;
// holding the lock across that read keeps concurrent first calls to a single prompt.
static WORKSPACES: Mutex<Option<Vec<StoredWorkspace>>> = Mutex::new(None);
/// The workspace id holding each issue, team, project, comment or upload URL met so far.
static OWNERS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

pub(crate) const MISSING_API_KEY_MESSAGE: &str =
    "[Kanban/linearMissingKey] Aucune clé d’API Linear n’est configurée.";
const AUTH_ERROR_MESSAGE: &str = "[Kanban/linearAuth] Linear a refusé la clé d’API.";
const FORBIDDEN_MESSAGE: &str =
    "[Kanban/linearForbidden] La clé d’API Linear n’a pas le droit de faire cette modification.";
const RATE_LIMIT_MESSAGE: &str =
    "[Kanban/linearRateLimit] Limite de requêtes Linear atteinte. Réessayez plus tard.";
const UNAVAILABLE_MESSAGE: &str =
    "[Kanban/linearUnavailable] Linear est injoignable. Réessayez plus tard.";
const NO_TEAM_MESSAGE: &str =
    "[Kanban/linearNoTeam] Aucune équipe Linear n’est accessible avec cette clé.";
const PROJECT_NOT_LINKED_MESSAGE: &str =
    "[Kanban/linearProjectNotLinked] Ce projet n’est lié à aucun projet Linear.";
const NOT_FOUND_MESSAGE: &str =
    "[Kanban/linearNotFound] Aucun workspace Linear connecté ne contient cet élément.";
const AMBIGUOUS_WORKSPACE_MESSAGE: &str = "[Kanban/linearWorkspaceAmbiguous] Plusieurs workspaces Linear sont connectés : liez le projet de cette session à un projet Linear.";

/// A connected workspace as the frontend lists it; its key never leaves the backend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearWorkspace {
    pub id: String,
    pub name: String,
}

/// No `Debug`: it holds the API key.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspace {
    /// Empty for the single key older versions stored, until another workspace is added.
    id: String,
    name: String,
    api_key: String,
}

impl StoredWorkspace {
    fn label(&self) -> &str {
        if self.name.is_empty() {
            "Linear"
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectSummary {
    pub id: String,
    pub name: String,
    pub teams: Vec<String>,
    pub workspace: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    #[serde(flatten)]
    pub team: KanbanTeam,
    pub workspace: String,
    #[serde(skip)]
    workspace_id: String,
}

/// One Linear team's board in the local board shape; `teams` lists every team the keys read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearKanbanBoard {
    #[serde(flatten)]
    pub board: KanbanBoard,
    pub teams: Vec<LinearTeam>,
    pub truncated: bool,
    /// The Soreno projects linked to a Linear project of the board's workspace.
    pub linked_project_ids: Vec<String>,
}

/// Soreno projects linked to Linear projects, keyed by Linear project id.
#[derive(Debug, Default)]
pub struct ProjectLinks(Vec<(String, KanbanProjectRef)>);

impl ProjectLinks {
    pub fn new(links: Vec<(String, KanbanProjectRef)>) -> Self {
        Self(links)
    }

    fn project(&self, linear_project: Option<&KanbanLinearProjectRef>) -> Option<KanbanProjectRef> {
        let linear_project = linear_project?;
        self.0
            .iter()
            .find(|(linear_id, _)| *linear_id == linear_project.id)
            .map(|(_, project)| project.clone())
    }

    fn linear_project_id(&self, project_id: &str) -> Result<String> {
        self.0
            .iter()
            .find(|(_, project)| project.id == project_id)
            .map(|(linear_id, _)| linear_id.clone())
            .ok_or_else(|| PROJECT_NOT_LINKED_MESSAGE.into())
    }

    fn linear_project_ids(&self) -> Vec<&str> {
        self.0
            .iter()
            .map(|(linear_id, _)| linear_id.as_str())
            .collect()
    }

    /// The Soreno projects whose Linear project is among `held`.
    fn project_ids_in(&self, held: &[&str]) -> Vec<String> {
        self.0
            .iter()
            .filter(|(linear_id, _)| held.contains(&linear_id.as_str()))
            .map(|(_, project)| project.id.clone())
            .collect()
    }
}

pub fn has_api_key() -> Result<bool> {
    Ok(!stored_workspaces()?.is_empty())
}

pub fn workspaces() -> Result<Vec<LinearWorkspace>> {
    Ok(stored_workspaces()?
        .into_iter()
        .map(|workspace| LinearWorkspace {
            id: workspace.id,
            name: workspace.name,
        })
        .collect())
}

/// Adds the key's workspace, or replaces the key a workspace already had.
pub async fn set_api_key(api_key: &str) -> Result<()> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(MISSING_API_KEY_MESSAGE.into());
    }

    let client = linear_client()?;
    let organization = graphql::<OrganizationData>(&client, api_key, ORGANIZATION_QUERY, json!({}))
        .await?
        .organization;
    let mut workspaces = stored_workspaces()?;
    // An older single key is named first, so the same workspace is never listed twice.
    for workspace in workspaces
        .iter_mut()
        .filter(|workspace| workspace.id.is_empty())
    {
        match graphql::<OrganizationData>(
            &client,
            &workspace.api_key,
            ORGANIZATION_QUERY,
            json!({}),
        )
        .await
        {
            Ok(data) => {
                workspace.id = data.organization.id;
                workspace.name = data.organization.name;
            }
            // A revoked key is dropped, as connecting a key used to replace it; other failures keep it.
            Err(error) if error == AUTH_ERROR_MESSAGE => workspace.api_key.clear(),
            Err(_) => {}
        }
    }
    workspaces.retain(|workspace| !workspace.api_key.is_empty() && workspace.id != organization.id);
    workspaces.push(StoredWorkspace {
        id: organization.id,
        name: organization.name,
        api_key: api_key.to_owned(),
    });
    store_workspaces(&mut cached_workspaces(), workspaces)
}

pub fn clear_api_key(workspace_id: &str) -> Result<()> {
    let mut cached = cached_workspaces();
    let mut workspaces = load_workspaces(&mut cached)?;
    workspaces.retain(|workspace| workspace.id != workspace_id);
    store_workspaces(&mut cached, workspaces)
}

pub async fn load_board(
    team_id: Option<String>,
    links: &ProjectLinks,
) -> Result<LinearKanbanBoard> {
    let workspaces = stored_workspaces()?;
    if workspaces.is_empty() {
        return Err(MISSING_API_KEY_MESSAGE.into());
    }
    let client = linear_client()?;

    let mut teams = Vec::new();
    for workspace in &workspaces {
        let nodes = graphql::<TeamsData>(&client, &workspace.api_key, TEAMS_QUERY, json!({}))
            .await
            .map_err(|error| in_workspace(error, workspace.label()))?
            .teams
            .nodes;
        if workspaces.len() > 1 {
            remember(nodes.iter().map(|team| team.id.as_str()), &workspace.id);
        }
        teams.extend(nodes.into_iter().map(|team| LinearTeam {
            team,
            workspace: workspace.name.clone(),
            workspace_id: workspace.id.clone(),
        }));
    }
    sort_teams(&mut teams);
    let selected = select_team(&teams, team_id.as_deref()).ok_or(NO_TEAM_MESSAGE)?;
    let team = selected.team.clone();
    let api_key = workspaces
        .iter()
        .find(|workspace| workspace.id == selected.workspace_id)
        .map(|workspace| workspace.api_key.clone())
        .ok_or(NO_TEAM_MESSAGE)?;

    let mut states = None;
    let mut raw_issues = Vec::new();
    let mut after: Option<String> = None;
    let mut truncated = false;
    for page in 1..=MAX_ISSUE_PAGES {
        let variables = json!({ "id": team.id, "after": after });
        let board = graphql::<TeamBoardData>(&client, &api_key, TEAM_BOARD_QUERY, variables)
            .await?
            .team;
        if states.is_none() {
            states = Some(board.states.nodes);
        }
        raw_issues.extend(board.issues.nodes);

        let page_info = board.issues.page_info;
        if !page_info.has_next_page {
            break;
        }
        match page_info.end_cursor {
            Some(cursor) if page < MAX_ISSUE_PAGES => after = Some(cursor),
            _ => {
                truncated = true;
                break;
            }
        }
    }

    let mut states = states.unwrap_or_default();
    kanban::sort_states(&mut states);
    let labels = team_labels(&client, &api_key, &team.id).await?;
    complete_labels(
        &client,
        &api_key,
        raw_issues
            .iter_mut()
            .map(|raw| (raw.label_ids.as_slice(), &mut raw.labels.nodes))
            .collect(),
    )
    .await?;
    // Spares a probe request on the first action on each card.
    if workspaces.len() > 1 {
        remember(
            raw_issues.iter().map(|raw| raw.id.as_str()),
            &selected.workspace_id,
        );
    }
    let ids = links.linear_project_ids();
    // Links outlive a disconnected workspace, so even a single one is asked which it holds.
    let linked_project_ids = if ids.is_empty() {
        Vec::new()
    } else {
        let variables = json!({ "ids": ids });
        let held = graphql::<ProjectIdsData>(&client, &api_key, PROJECT_IDS_QUERY, variables)
            .await?
            .projects
            .nodes;
        links.project_ids_in(
            &held
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
        )
    };

    Ok(LinearKanbanBoard {
        board: KanbanBoard {
            source: KanbanSource::Linear,
            team,
            states,
            labels,
            issues: raw_issues
                .into_iter()
                .map(|raw| map_issue(raw, links))
                .collect(),
        },
        teams,
        truncated,
        linked_project_ids,
    })
}

pub async fn update_issue(
    issue_id: &str,
    patch: KanbanIssueInput,
    links: &ProjectLinks,
) -> Result<KanbanIssueUpdate> {
    let input = issue_update_input(patch, links)?;
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let variables = json!({ "id": issue_id, "input": input });
    let mut update =
        graphql::<IssueUpdateData>(&client, &api_key, UPDATE_ISSUE_MUTATION, variables)
            .await?
            .issue_update;
    if let Some(issue) = update.issue.as_mut().filter(|_| update.success) {
        let labels = vec![(issue.label_ids.as_slice(), &mut issue.labels.nodes)];
        // The mutation is already applied: an error here would make the caller revert a saved change.
        let _ = complete_labels(&client, &api_key, labels).await;
    }
    applied_issue_update(update, links)
}

pub async fn update_issue_description(
    issue_id: &str,
    description: &str,
) -> Result<KanbanIssueDescriptionUpdate> {
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    // Sent as a GraphQL variable, never interpolated into the query.
    let variables = json!({ "id": issue_id, "description": description.trim() });
    let payload = graphql::<IssueDescriptionUpdateData>(
        &client,
        &api_key,
        UPDATE_ISSUE_DESCRIPTION_MUTATION,
        variables,
    )
    .await?
    .issue_update;
    applied_description_update(payload)
}

pub async fn create_issue(
    input: KanbanIssueCreateInput,
    links: &ProjectLinks,
) -> Result<KanbanIssue> {
    let team_id = input.team_id.clone();
    let input = issue_create_input(input, links)?;
    let client = linear_client()?;
    let api_key = api_key_for(&client, &team_id).await?;
    create(&client, &api_key, input, links).await
}

/// Creates an agent's issue in the team and Linear project of `linked_issue_id`, else in
/// `linear_project_id` and one of its teams, else in the team the board shows by default, which
/// needs a single connected workspace.
pub async fn create_requested_issue(
    linked_issue_id: Option<&str>,
    linear_project_id: Option<&str>,
    title: &str,
    description: Option<&str>,
) -> Result<KanbanIssue> {
    let title = kanban::required_title(title)?;
    let client = linear_client()?;
    let (api_key, team_id, project_id) = match (linked_issue_id, linear_project_id) {
        (Some(id), _) => {
            let api_key = api_key_for(&client, id).await?;
            let placement = graphql::<IssuePlacementData>(
                &client,
                &api_key,
                ISSUE_PLACEMENT_QUERY,
                json!({ "id": id }),
            )
            .await?
            .issue;
            (
                api_key,
                placement.team.id,
                placement.project.map(|project| project.id),
            )
        }
        (None, Some(id)) => {
            let api_key = api_key_for(&client, id).await?;
            let teams = graphql::<ProjectTeamsData>(
                &client,
                &api_key,
                PROJECT_TEAMS_QUERY,
                json!({ "id": id }),
            )
            .await?
            .project
            .teams
            .nodes;
            let team = teams.into_iter().next().ok_or(NO_TEAM_MESSAGE)?;
            (api_key, team.id, Some(id.to_owned()))
        }
        // shortcut: ignores the team picked on the board (a front-end preference), pass it here if several teams prove common.
        (None, None) => {
            let api_key = match stored_workspaces()?.as_slice() {
                [] => return Err(MISSING_API_KEY_MESSAGE.into()),
                [workspace] => workspace.api_key.clone(),
                _ => return Err(AMBIGUOUS_WORKSPACE_MESSAGE.into()),
            };
            let teams = graphql::<TeamsData>(&client, &api_key, TEAMS_QUERY, json!({}))
                .await?
                .teams
                .nodes;
            let team = teams
                .into_iter()
                .min_by(|left, right| kanban::compare_names(&left.name, &right.name))
                .ok_or(NO_TEAM_MESSAGE)?;
            (api_key, team.id, None)
        }
    };
    let mut input = json!({ "teamId": team_id, "title": title });
    if let Some(description) = kanban::trimmed(description) {
        input["description"] = json!(description);
    }
    if let Some(project_id) = project_id {
        input["projectId"] = json!(project_id);
    }
    create(&client, &api_key, input, &ProjectLinks::default()).await
}

/// Applies an agent's new title and/or description to its linked issue in one mutation.
pub async fn update_requested_issue(
    issue_id: &str,
    title: Option<&str>,
    description: Option<&str>,
) -> Result<()> {
    let mut input = json!({});
    if let Some(title) = title {
        input["title"] = json!(kanban::required_title(title)?);
    }
    if let Some(description) = description {
        input["description"] = json!(description.trim());
    }
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let variables = json!({ "id": issue_id, "input": input });
    let update = graphql::<IssueUpdateData>(&client, &api_key, UPDATE_ISSUE_MUTATION, variables)
        .await?
        .issue_update;
    applied_issue_update(update, &ProjectLinks::default()).map(drop)
}

async fn create(
    client: &reqwest::Client,
    api_key: &str,
    input: Value,
    links: &ProjectLinks,
) -> Result<KanbanIssue> {
    let mut payload = graphql::<IssueCreateData>(
        client,
        api_key,
        CREATE_ISSUE_MUTATION,
        json!({ "input": input }),
    )
    .await?
    .issue_create;
    if let Some(issue) = payload.issue.as_mut().filter(|_| payload.success) {
        let labels = vec![(issue.label_ids.as_slice(), &mut issue.labels.nodes)];
        // The issue already exists: an error here would invite a retry that creates a duplicate.
        let _ = complete_labels(client, api_key, labels).await;
    }
    created_issue(payload, links)
}

pub async fn create_comment(issue_id: &str, body: &str) -> Result<KanbanComment> {
    let input = comment_create_input(issue_id, body)?;
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let payload = graphql::<CommentCreateData>(
        &client,
        &api_key,
        CREATE_COMMENT_MUTATION,
        json!({ "input": input }),
    )
    .await?
    .comment_create;
    created_comment(payload)
}

pub async fn delete_comment(comment_id: &str) -> Result<()> {
    let client = linear_client()?;
    let api_key = api_key_for(&client, comment_id).await?;
    let payload = graphql::<CommentDeleteData>(
        &client,
        &api_key,
        DELETE_COMMENT_MUTATION,
        json!({ "id": comment_id }),
    )
    .await?
    .comment_delete;
    confirmed(payload, "Le commentaire n’a pas été supprimé.")
}

/// Extends the session's summary comment when Linear still lists it, else creates one; `true` when created.
pub async fn post_issue_summary(
    issue_id: &str,
    summary_comment_id: Option<&str>,
    summary: &str,
) -> Result<(KanbanComment, bool)> {
    if let Some(comment_id) = summary_comment_id {
        let client = linear_client()?;
        let api_key = api_key_for(&client, issue_id).await?;
        let existing = graphql::<IssueConnectionData<RawIssueComment>>(
            &client,
            &api_key,
            ISSUE_COMMENT_QUERY,
            json!({ "id": issue_id, "commentId": comment_id }),
        )
        .await?
        .issue
        .comments
        .nodes
        .pop();
        if let Some(existing) = existing {
            let body = kanban::appended_summary(&existing.body, summary);
            let payload = graphql::<CommentUpdateData>(
                &client,
                &api_key,
                UPDATE_COMMENT_MUTATION,
                json!({ "id": comment_id, "body": body }),
            )
            .await?
            .comment_update;
            return Ok((updated_comment(payload)?, false));
        }
    }
    Ok((create_comment(issue_id, summary).await?, true))
}

/// Moves the issue to its team's review state, if it has one and is not already done.
pub async fn move_issue_to_review(
    issue_id: &str,
    links: &ProjectLinks,
) -> Result<Option<KanbanIssueUpdate>> {
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let workflow = graphql::<IssueWorkflowData>(
        &client,
        &api_key,
        ISSUE_WORKFLOW_QUERY,
        json!({ "id": issue_id }),
    )
    .await?
    .issue;
    let Some(state_id) = kanban::review_state_id(
        &workflow.team.states.nodes,
        &workflow.state.id,
        &workflow.state.r#type,
    ) else {
        return Ok(None);
    };
    let patch = KanbanIssueInput {
        state_id: Some(state_id.into()),
        ..KanbanIssueInput::default()
    };
    Ok(Some(update_issue(issue_id, patch, links).await?))
}

pub async fn delete_issue(issue_id: &str) -> Result<()> {
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let payload = graphql::<IssueDeleteData>(
        &client,
        &api_key,
        DELETE_ISSUE_MUTATION,
        json!({ "id": issue_id }),
    )
    .await?
    .issue_delete;
    confirmed(payload, "L’issue n’a pas été supprimée.")
}

/// Reuses a team label of the same name, ignoring case, instead of creating a duplicate.
pub async fn create_label(team_id: &str, name: &str) -> Result<KanbanLabel> {
    let name = kanban::required_label_name(name)?;
    let client = linear_client()?;
    let api_key = api_key_for(&client, team_id).await?;
    let folded = name.to_lowercase();
    if let Some(label) = team_labels(&client, &api_key, team_id)
        .await?
        .into_iter()
        .find(|label| label.name.to_lowercase() == folded)
    {
        return Ok(label);
    }
    let payload = graphql::<LabelCreateData>(
        &client,
        &api_key,
        CREATE_LABEL_MUTATION,
        json!({ "input": { "teamId": team_id, "name": name } }),
    )
    .await?
    .issue_label_create;
    created_label(payload)
}

pub async fn load_issue(issue_id: &str, links: &ProjectLinks) -> Result<KanbanIssueDetail> {
    let client = linear_client()?;
    let api_key = api_key_for(&client, issue_id).await?;
    let variables = json!({ "id": issue_id });
    let mut raw = graphql::<IssueDetailData>(&client, &api_key, ISSUE_DETAIL_QUERY, variables)
        .await?
        .issue;

    let mut children_after = raw.children.page_info.take_next_cursor();
    let mut more_children = Vec::new();
    let mut comments_after = raw.comments.page_info.take_next_cursor();
    let mut more_comments = Vec::new();
    for _ in 1..MAX_PAGES {
        if children_after.is_none() && comments_after.is_none() {
            break;
        }
        if let Some(after) = children_after.take() {
            let variables = json!({ "id": issue_id, "after": after });
            let mut page = graphql::<IssueConnectionData<RawIssueChildren>>(
                &client,
                &api_key,
                ISSUE_CHILDREN_QUERY,
                variables,
            )
            .await?
            .issue
            .children;
            more_children.extend(page.nodes);
            children_after = page.page_info.take_next_cursor();
        }
        if let Some(after) = comments_after.take() {
            let variables = json!({ "id": issue_id, "after": after });
            let mut page = graphql::<IssueConnectionData<RawIssueComments>>(
                &client,
                &api_key,
                ISSUE_COMMENTS_QUERY,
                variables,
            )
            .await?
            .issue
            .comments;
            more_comments.extend(page.nodes);
            comments_after = page.page_info.take_next_cursor();
        }
    }

    let labels = vec![(raw.label_ids.as_slice(), &mut raw.labels.nodes)];
    complete_labels(&client, &api_key, labels).await?;
    Ok(map_issue_detail(raw, more_children, more_comments, links))
}

/// The projects of every connected workspace, each named with its workspace.
pub async fn list_projects() -> Result<Vec<LinearProjectSummary>> {
    let workspaces = stored_workspaces()?;
    if workspaces.is_empty() {
        return Err(MISSING_API_KEY_MESSAGE.into());
    }
    let client = linear_client()?;
    let mut pages = Vec::new();

    for workspace in &workspaces {
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let variables = json!({ "after": after });
            let mut page =
                graphql::<ProjectsData>(&client, &workspace.api_key, PROJECTS_QUERY, variables)
                    .await
                    .map_err(|error| in_workspace(error, workspace.label()))?
                    .projects;
            let next_cursor = page.page_info.take_next_cursor();
            if workspaces.len() > 1 {
                remember(page.nodes.iter().map(|raw| raw.id.as_str()), &workspace.id);
            }
            pages.push(
                page.nodes
                    .into_iter()
                    .map(|raw| raw.summary(&workspace.name))
                    .collect(),
            );
            match next_cursor {
                Some(cursor) => after = Some(cursor),
                None => break,
            }
        }
    }

    Ok(sorted_projects(pages))
}

/// The team's labels and the workspace ones, without label groups, sorted by name.
async fn team_labels(
    client: &reqwest::Client,
    api_key: &str,
    team_id: &str,
) -> Result<Vec<KanbanLabel>> {
    let mut variables = json!({ "teamId": team_id });
    let mut raw_labels = Vec::new();
    for _ in 0..MAX_PAGES {
        let mut page =
            graphql::<IssueLabelsData>(client, api_key, TEAM_LABELS_QUERY, variables.clone())
                .await?
                .issue_labels;
        raw_labels.extend(page.nodes);
        match page.page_info.take_next_cursor() {
            Some(cursor) => variables["after"] = json!(cursor),
            None => break,
        }
    }
    Ok(plain_labels(raw_labels))
}

fn plain_labels(raw_labels: Vec<RawLabel>) -> Vec<KanbanLabel> {
    let mut labels: Vec<_> = raw_labels
        .into_iter()
        .filter(|label| !label.is_group)
        .map(|label| KanbanLabel {
            id: label.id,
            name: label.name,
            color: label.color,
        })
        .collect();
    labels.sort_by(|left, right| kanban::compare_names(&left.name, &right.name));
    labels
}

/// Label connections are windowed while `labelIds` is exhaustive, so absent labels are fetched by id.
async fn complete_labels(
    client: &reqwest::Client,
    api_key: &str,
    issues: Vec<(&[String], &mut Vec<KanbanLabel>)>,
) -> Result<()> {
    let missing = missing_label_ids(issues.iter().map(|(ids, labels)| (*ids, labels.as_slice())));
    if missing.is_empty() {
        return Ok(());
    }
    let mut fetched = Vec::with_capacity(missing.len());
    for ids in missing.chunks(LABEL_BATCH_SIZE) {
        let variables = json!({ "ids": ids, "first": LABEL_BATCH_SIZE });
        let data =
            graphql::<LabelNodesData>(client, api_key, LABELS_BY_ID_QUERY, variables).await?;
        fetched.extend(data.issue_labels.nodes);
    }
    add_fetched_labels(issues, &fetched);
    Ok(())
}

fn missing_label_ids<'a>(
    issues: impl IntoIterator<Item = (&'a [String], &'a [KanbanLabel])>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for (ids, labels) in issues {
        for id in ids {
            if !labels.iter().any(|label| &label.id == id) && seen.insert(id.as_str()) {
                missing.push(id.clone());
            }
        }
    }
    missing
}

fn add_fetched_labels(issues: Vec<(&[String], &mut Vec<KanbanLabel>)>, fetched: &[KanbanLabel]) {
    let fetched: HashMap<&str, &KanbanLabel> = fetched
        .iter()
        .map(|label| (label.id.as_str(), label))
        .collect();
    for (ids, labels) in issues {
        for id in ids {
            if labels.iter().any(|label| &label.id == id) {
                continue;
            }
            if let Some(label) = fetched.get(id.as_str()) {
                labels.push((*label).clone());
            }
        }
    }
}

fn linear_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(request_failed)
}

async fn graphql<T: DeserializeOwned>(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    variables: Value,
) -> Result<T> {
    let response = client
        .post(LINEAR_GRAPHQL_URL)
        .header(AUTHORIZATION, authorization_header(api_key)?)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| unavailable())?;

    parse_graphql_response(status, &body)
}

fn authorization_header(api_key: &str) -> Result<HeaderValue> {
    let mut authorization =
        HeaderValue::from_str(api_key).map_err(|_| AUTH_ERROR_MESSAGE.to_string())?;
    authorization.set_sensitive(true);
    Ok(authorization)
}

fn parse_graphql_response<T: DeserializeOwned>(status: u16, body: &str) -> Result<T> {
    if let Some(error) = classify_response_error(status, body) {
        return Err(error);
    }

    serde_json::from_str::<GraphqlResponse<T>>(body)
        .map_err(|error| request_failed(format!("Réponse inattendue de Linear ({error}).")))?
        .data
        .ok_or_else(|| request_failed("Réponse vide de Linear."))
}

fn classify_response_error(status: u16, body: &str) -> Option<String> {
    let payload = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let errors = payload
        .get("errors")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let has_code = |code: &str| {
        errors
            .iter()
            .any(|error| error.pointer("/extensions/code").and_then(Value::as_str) == Some(code))
    };

    if status == 401 || has_code("AUTHENTICATION_ERROR") {
        return Some(AUTH_ERROR_MESSAGE.into());
    }
    if status == 429 || has_code("RATELIMITED") {
        return Some(RATE_LIMIT_MESSAGE.into());
    }
    if status == 403 || has_code("FORBIDDEN") {
        return Some(FORBIDDEN_MESSAGE.into());
    }
    if (500..600).contains(&status) {
        return Some(unavailable());
    }
    if (200..300).contains(&status) && errors.is_empty() {
        return None;
    }

    let detail = errors
        .iter()
        .find_map(|error| error.get("message").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"));
    Some(request_failed(detail))
}

/// The text after the tag is shown to the user as is.
fn request_failed(detail: impl std::fmt::Display) -> String {
    format!("[Kanban/linearRequest] {detail}")
}

fn unavailable() -> String {
    UNAVAILABLE_MESSAGE.into()
}

fn sorted_projects(pages: Vec<Vec<LinearProjectSummary>>) -> Vec<LinearProjectSummary> {
    let mut projects: Vec<_> = pages.into_iter().flatten().collect();
    projects.sort_by(|left, right| kanban::compare_names(&left.name, &right.name));
    projects
}

/// Grouped by workspace, so the board's team picker lists each workspace's teams together.
fn sort_teams(teams: &mut [LinearTeam]) {
    teams.sort_by(|left, right| {
        kanban::compare_names(&left.workspace, &right.workspace)
            .then_with(|| kanban::compare_names(&left.team.name, &right.team.name))
    });
}

fn select_team<'a>(teams: &'a [LinearTeam], team_id: Option<&str>) -> Option<&'a LinearTeam> {
    team_id
        .and_then(|team_id| teams.iter().find(|team| team.team.id == team_id))
        .or_else(|| teams.first())
}

fn attachment_pull_requests(attachments: &[RawAttachment]) -> Vec<KanbanPullRequest> {
    // API-created attachments can point into a PR (e.g. a comment) without being that PR.
    kanban::extract_pull_requests(
        attachments
            .iter()
            .filter(|attachment| {
                matches!(attachment.source_type.as_deref(), Some("github" | "gitlab"))
            })
            .map(|attachment| attachment.url.as_str()),
    )
}

fn sorted_labels(mut labels: Vec<KanbanLabel>) -> Vec<KanbanLabel> {
    labels.sort_by(|left, right| kanban::compare_names(&left.name, &right.name));
    labels
}

fn map_issue(raw: RawIssue, links: &ProjectLinks) -> KanbanIssue {
    KanbanIssue {
        source: KanbanSource::Linear,
        pull_requests: attachment_pull_requests(&raw.attachments.nodes),
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        priority: normalize_priority(raw.priority),
        state_id: raw.state.id,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: sorted_labels(raw.labels.nodes),
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

fn map_update(raw: RawUpdatedIssue, links: &ProjectLinks) -> KanbanIssueUpdate {
    KanbanIssueUpdate {
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        title: raw.title,
        state_id: raw.state.id,
        priority: normalize_priority(raw.priority),
        labels: sorted_labels(raw.labels.nodes),
        updated_at: raw.updated_at,
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

fn map_issue_detail(
    raw: RawIssueDetail,
    more_children: Vec<KanbanSubIssue>,
    more_comments: Vec<RawComment>,
    links: &ProjectLinks,
) -> KanbanIssueDetail {
    let mut children = raw.children.nodes;
    children.extend(more_children);
    let mut comments: Vec<KanbanComment> = raw
        .comments
        .nodes
        .into_iter()
        .chain(more_comments)
        .map(KanbanComment::from)
        .collect();
    // Linear returns uniform ISO-8601 UTC timestamps, so string order is chronological.
    comments.sort_by(|left, right| left.created_at.cmp(&right.created_at));

    KanbanIssueDetail {
        source: KanbanSource::Linear,
        pull_requests: attachment_pull_requests(&raw.attachments.nodes),
        team_id: Some(raw.team.id),
        project: links.project(raw.project.as_ref()),
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        description: raw.description,
        branch_name: raw.branch_name,
        priority: normalize_priority(raw.priority),
        state_id: raw.state.id,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: sorted_labels(raw.labels.nodes),
        children,
        comments,
        linear: Some(KanbanLinearFields {
            url: raw.url,
            assignee: raw.assignee,
            linear_project: raw.project,
        }),
    }
}

fn normalize_priority(priority: f64) -> u8 {
    priority.round().clamp(0.0, 4.0) as u8
}

fn stored_workspaces() -> Result<Vec<StoredWorkspace>> {
    load_workspaces(&mut cached_workspaces())
}

fn load_workspaces(cached: &mut Option<Vec<StoredWorkspace>>) -> Result<Vec<StoredWorkspace>> {
    if let Some(workspaces) = cached.as_ref() {
        return Ok(workspaces.clone());
    }
    let workspaces = read_stored_workspaces()?;
    *cached = Some(workspaces.clone());
    Ok(workspaces)
}

fn cached_workspaces() -> MutexGuard<'static, Option<Vec<StoredWorkspace>>> {
    WORKSPACES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_stored_workspaces() -> Result<Vec<StoredWorkspace>> {
    match keyring_entry()?.get_password() {
        Ok(stored) => Ok(parse_stored_workspaces(&stored)),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(error) => Err(request_failed(format!(
            "Impossible de lire la clé d’API Linear ({}).",
            storage_detail(&error)
        ))),
    }
}

/// Older versions stored a single bare key.
fn parse_stored_workspaces(stored: &str) -> Vec<StoredWorkspace> {
    serde_json::from_str(stored).unwrap_or_else(|_| {
        vec![StoredWorkspace {
            id: String::new(),
            name: String::new(),
            api_key: stored.to_owned(),
        }]
    })
}

// shortcut: all keys share one keychain entry (a single unlock prompt), which Windows caps at 1280 characters, about 9 workspaces; split it per workspace if users reach that.
fn store_workspaces(
    cached: &mut Option<Vec<StoredWorkspace>>,
    workspaces: Vec<StoredWorkspace>,
) -> Result<()> {
    *cached = None;
    let entry = keyring_entry()?;
    if workspaces.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(request_failed(format!(
                    "Impossible de supprimer la clé d’API Linear ({}).",
                    storage_detail(&error)
                )))
            }
        }
    } else {
        let stored = serde_json::to_string(&workspaces).map_err(request_failed)?;
        entry.set_password(&stored).map_err(|error| {
            request_failed(format!(
                "Impossible d’enregistrer la clé d’API Linear ({}).",
                storage_detail(&error)
            ))
        })?;
        if read_stored_workspaces()? != workspaces {
            return Err(request_failed(
                "La clé d’API Linear enregistrée n’a pas pu être vérifiée.",
            ));
        }
    }
    *cached = Some(workspaces);
    Ok(())
}

/// The key of the workspace holding `id`: an issue, team, project or comment.
async fn api_key_for(client: &reqwest::Client, id: &str) -> Result<String> {
    let (workspaces, known) = workspaces_for(id)?;
    if known || workspaces.len() == 1 {
        return Ok(workspaces[0].api_key.clone());
    }
    try_workspaces(id, workspaces, |workspace| async move {
        let data =
            graphql::<OwnerData>(client, &workspace.api_key, OWNER_QUERY, json!({ "id": id }))
                .await?;
        Ok(data.holds().then_some(workspace.api_key))
    })
    .await
}

/// The connected workspaces, the one remembered for `id` first; `true` when one is.
fn workspaces_for(id: &str) -> Result<(Vec<StoredWorkspace>, bool)> {
    let mut workspaces = stored_workspaces()?;
    if workspaces.is_empty() {
        return Err(MISSING_API_KEY_MESSAGE.into());
    }
    let known = remembered_first(id, &mut workspaces);
    Ok((workspaces, known))
}

fn remembered_first(id: &str, workspaces: &mut [StoredWorkspace]) -> bool {
    let owners = OWNERS.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(index) = owners.get(id).and_then(|owner| {
        workspaces
            .iter()
            .position(|workspace| &workspace.id == owner)
    }) else {
        return false;
    };
    workspaces[..=index].rotate_right(1);
    true
}

fn remember<'a>(ids: impl IntoIterator<Item = &'a str>, workspace_id: &str) {
    let mut owners = OWNERS.lock().unwrap_or_else(PoisonError::into_inner);
    for id in ids {
        if owners.get(id).map(String::as_str) != Some(workspace_id) {
            owners.insert(id.to_owned(), workspace_id.to_owned());
        }
    }
}

/// Tries each workspace in turn until one holds `id`, and remembers it. A failing workspace does
/// not hide the others; its error is returned when none holds `id`.
async fn try_workspaces<T, F, Fut>(
    id: &str,
    workspaces: Vec<StoredWorkspace>,
    mut attempt: F,
) -> Result<T>
where
    F: FnMut(StoredWorkspace) -> Fut,
    Fut: Future<Output = Result<Option<T>>>,
{
    let mut failure = None;
    for workspace in workspaces {
        let (workspace_id, label) = (workspace.id.clone(), workspace.label().to_owned());
        match attempt(workspace).await {
            Ok(Some(found)) => {
                remember([id], &workspace_id);
                return Ok(found);
            }
            Ok(None) => {}
            Err(error) => {
                failure.get_or_insert_with(|| in_workspace(error, &label));
            }
        }
    }
    Err(failure.unwrap_or_else(|| NOT_FOUND_MESSAGE.into()))
}

/// Names the workspace whose key Linear refused, so the user knows which one to replace.
fn in_workspace(error: String, workspace: &str) -> String {
    if error == AUTH_ERROR_MESSAGE {
        format!("[Kanban/linearWorkspaceAuth] {workspace}")
    } else {
        error
    }
}

fn keyring_entry() -> Result<keyring::Entry> {
    // macOS reads `target` as a keychain domain (User/System/…) and the Secret Service as a
    // collection to create: only the Windows credential manager takes it as a name.
    #[cfg(not(windows))]
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT);
    #[cfg(windows)]
    let entry = keyring::Entry::new_with_target(KEYRING_TARGET, KEYRING_SERVICE, KEYRING_ACCOUNT);
    entry.map_err(|error| {
        request_failed(format!(
            "Impossible d’ouvrir le stockage sécurisé ({error})."
        ))
    })
}

fn storage_detail(error: &keyring::Error) -> String {
    #[cfg(target_os = "linux")]
    if matches!(
        error,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    ) {
        return format!(
            "aucun trousseau Secret Service accessible : installez ou déverrouillez GNOME Keyring ou KWallet. {error}"
        );
    }
    error.to_string()
}

#[path = "linear/images.rs"]
pub(crate) mod images;
#[path = "linear/mutations.rs"]
mod mutations;
#[path = "linear/queries.rs"]
mod queries;
#[path = "linear/responses.rs"]
mod responses;

use mutations::{
    applied_description_update, applied_issue_update, comment_create_input, confirmed,
    created_comment, created_issue, created_label, issue_create_input, issue_update_input,
    updated_comment,
};
use queries::{
    CREATE_COMMENT_MUTATION, CREATE_ISSUE_MUTATION, CREATE_LABEL_MUTATION, DELETE_COMMENT_MUTATION,
    DELETE_ISSUE_MUTATION, ISSUE_CHILDREN_QUERY, ISSUE_COMMENTS_QUERY, ISSUE_COMMENT_QUERY,
    ISSUE_DETAIL_QUERY, ISSUE_PLACEMENT_QUERY, ISSUE_WORKFLOW_QUERY, LABELS_BY_ID_QUERY,
    ORGANIZATION_QUERY, OWNER_QUERY, PROJECTS_QUERY, PROJECT_IDS_QUERY, PROJECT_TEAMS_QUERY,
    TEAMS_QUERY, TEAM_BOARD_QUERY, TEAM_LABELS_QUERY, UPDATE_COMMENT_MUTATION,
    UPDATE_ISSUE_DESCRIPTION_MUTATION, UPDATE_ISSUE_MUTATION,
};
use responses::{
    CommentCreateData, CommentDeleteData, CommentUpdateData, GraphqlResponse, IssueConnectionData,
    IssueCreateData, IssueDeleteData, IssueDescriptionUpdateData, IssueDetailData, IssueLabelsData,
    IssuePlacementData, IssueUpdateData, IssueWorkflowData, LabelCreateData, LabelNodesData,
    OrganizationData, OwnerData, ProjectIdsData, ProjectTeamsData, ProjectsData, RawAttachment,
    RawComment, RawIssue, RawIssueChildren, RawIssueComment, RawIssueComments, RawIssueDetail,
    RawLabel, RawUpdatedIssue, TeamBoardData, TeamsData,
};

#[cfg(test)]
#[path = "linear_tests.rs"]
mod tests;
