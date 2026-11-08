use super::{
    branch_name, compare_names, sort_states, sql, team_labels, text_pull_requests, KanbanBoard,
    KanbanComment, KanbanIssue, KanbanIssueDetail, KanbanLabel, KanbanProjectRef, KanbanSource,
    KanbanSubIssue, KanbanSubIssueState, KanbanTeam, KanbanWorkflowState, Result, ISSUE_NOT_FOUND,
    TEAM_NOT_FOUND,
};
use rusqlite::{Connection, OptionalExtension, Row};
use std::collections::HashMap;

fn default_team(db: &Connection) -> Result<KanbanTeam> {
    db.query_row(
        "SELECT id, key, name FROM kanban_teams ORDER BY rowid LIMIT 1",
        [],
        |row| {
            Ok(KanbanTeam {
                id: row.get(0)?,
                key: row.get(1)?,
                name: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(sql)?
    .ok_or_else(|| TEAM_NOT_FOUND.into())
}

pub(crate) fn default_team_id(db: &Connection) -> Result<String> {
    Ok(default_team(db)?.id)
}

pub(super) fn team_states(db: &Connection, team_id: &str) -> Result<Vec<KanbanWorkflowState>> {
    let mut states = db
        .prepare("SELECT id, name, type, color, position FROM kanban_states WHERE team_id=?1")
        .map_err(sql)?
        .query_map([team_id], |row| {
            Ok(KanbanWorkflowState {
                id: row.get(0)?,
                name: row.get(1)?,
                r#type: row.get(2)?,
                color: row.get(3)?,
                position: row.get(4)?,
            })
        })
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    sort_states(&mut states);
    Ok(states)
}

/// Issues matching `filter` (an SQL condition on `i` with one parameter), latest updates first.
fn query_issues(db: &Connection, filter: &str, value: &str) -> Result<Vec<KanbanIssue>> {
    let mut labels: HashMap<String, Vec<KanbanLabel>> = HashMap::new();
    let mut statement = db
        .prepare(&format!(
            "SELECT il.issue_id, l.id, l.name, l.color FROM kanban_issue_labels il
            JOIN kanban_labels l ON l.id=il.label_id JOIN kanban_issues i ON i.id=il.issue_id
            WHERE {filter}"
        ))
        .map_err(sql)?;
    let mut rows = statement.query([value]).map_err(sql)?;
    while let Some(row) = rows.next().map_err(sql)? {
        let label = KanbanLabel {
            id: row.get(1).map_err(sql)?,
            name: row.get(2).map_err(sql)?,
            color: row.get(3).map_err(sql)?,
        };
        labels
            .entry(row.get(0).map_err(sql)?)
            .or_default()
            .push(label);
    }
    let mut comments: HashMap<String, Vec<String>> = HashMap::new();
    let mut statement = db
        .prepare(&format!(
            "SELECT c.issue_id, c.body FROM kanban_comments c JOIN kanban_issues i ON i.id=c.issue_id
            WHERE {filter} ORDER BY c.created_at, c.rowid"
        ))
        .map_err(sql)?;
    let mut rows = statement.query([value]).map_err(sql)?;
    while let Some(row) = rows.next().map_err(sql)? {
        comments
            .entry(row.get(0).map_err(sql)?)
            .or_default()
            .push(row.get(1).map_err(sql)?);
    }
    let mut statement = db
        .prepare(&format!(
            "SELECT i.id, t.key || '-' || i.number, i.title, i.priority, i.state_id, i.created_at, i.updated_at,
                p.id, COALESCE(json_extract(p.data, '$.name'), ''), i.description
            FROM kanban_issues i JOIN kanban_teams t ON t.id=i.team_id
            LEFT JOIN agent_projects p ON p.id=i.project_id
            WHERE {filter} ORDER BY i.updated_at DESC, i.rowid DESC"
        ))
        .map_err(sql)?;
    let issues = statement
        .query_map([value], |row| {
            let project_id: Option<String> = row.get(7)?;
            let project = match project_id {
                Some(id) => Some(KanbanProjectRef {
                    id,
                    name: row.get(8)?,
                }),
                None => None,
            };
            let description: Option<String> = row.get(9)?;
            Ok((
                KanbanIssue {
                    source: KanbanSource::Local,
                    id: row.get(0)?,
                    identifier: row.get(1)?,
                    title: row.get(2)?,
                    priority: row.get(3)?,
                    state_id: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    project,
                    labels: Vec::new(),
                    pull_requests: Vec::new(),
                    linear: None,
                },
                description,
            ))
        })
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    Ok(issues
        .into_iter()
        .map(|(mut issue, description)| {
            let issue_comments = comments.remove(&issue.id).unwrap_or_default();
            issue.pull_requests = text_pull_requests(
                description
                    .as_deref()
                    .into_iter()
                    .chain(issue_comments.iter().map(String::as_str)),
            );
            issue.labels = labels.remove(&issue.id).unwrap_or_default();
            issue
                .labels
                .sort_by(|left, right| compare_names(&left.name, &right.name));
            issue
        })
        .collect())
}

pub(super) fn load_summary(db: &Connection, issue_id: &str) -> Result<KanbanIssue> {
    query_issues(db, "i.id=?1", issue_id)?
        .pop()
        .ok_or_else(|| ISSUE_NOT_FOUND.into())
}

pub(crate) fn load_board(db: &Connection) -> Result<KanbanBoard> {
    let team = default_team(db)?;
    Ok(KanbanBoard {
        source: KanbanSource::Local,
        states: team_states(db, &team.id)?,
        labels: team_labels(db, &team.id)?,
        issues: query_issues(db, "i.team_id=?1", &team.id)?,
        team,
    })
}

fn issue_comments(db: &Connection, issue_id: &str) -> Result<Vec<KanbanComment>> {
    db.prepare(
        "SELECT id, body, created_at FROM kanban_comments WHERE issue_id=?1 ORDER BY created_at, rowid",
    )
    .map_err(sql)?
    .query_map([issue_id], comment_row)
    .map_err(sql)?
    .collect::<rusqlite::Result<_>>()
    .map_err(sql)
}

pub(super) fn comment_row(row: &Row<'_>) -> rusqlite::Result<KanbanComment> {
    Ok(KanbanComment {
        id: row.get(0)?,
        body: row.get(1)?,
        created_at: row.get(2)?,
        user: None,
    })
}

pub(crate) fn load_issue(db: &Connection, issue_id: &str) -> Result<KanbanIssueDetail> {
    let issue = load_summary(db, issue_id)?;
    let (key, number, description): (String, u64, Option<String>) = db
        .query_row(
            "SELECT t.key, i.number, i.description FROM kanban_issues i JOIN kanban_teams t ON t.id=i.team_id WHERE i.id=?1",
            [issue_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sql)?;
    let children = db
        .prepare(
            "SELECT c.id, t.key || '-' || c.number, c.title, s.id, s.name, s.type, s.color
            FROM kanban_issues c JOIN kanban_teams t ON t.id=c.team_id JOIN kanban_states s ON s.id=c.state_id
            WHERE c.parent_id=?1 ORDER BY c.number",
        )
        .map_err(sql)?
        .query_map([issue_id], |row| {
            Ok(KanbanSubIssue {
                id: row.get(0)?,
                identifier: row.get(1)?,
                title: row.get(2)?,
                state: KanbanSubIssueState {
                    id: row.get(3)?,
                    name: row.get(4)?,
                    r#type: row.get(5)?,
                    color: row.get(6)?,
                },
            })
        })
        .map_err(sql)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql)?;
    Ok(KanbanIssueDetail {
        source: KanbanSource::Local,
        branch_name: branch_name(&key, number, &issue.title),
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description,
        priority: issue.priority,
        state_id: issue.state_id,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        project: issue.project,
        labels: issue.labels,
        children,
        comments: issue_comments(db, issue_id)?,
        pull_requests: issue.pull_requests,
        team_id: None,
        linear: None,
    })
}
