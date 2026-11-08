use super::{
    get, groups, id, lock, require_project, text,
    worktrees::{discover_worktree_identity, list_project_worktrees, same_agent_environment},
    AgentProject, AgentProjectWorktreeSnapshot, AgentSessions, Result, Store,
};
use crate::{kanban::KanbanProjectRef, linear::ProjectLinks};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const UNLINKABLE_PROJECT_MESSAGE: &str = "Ce projet ne peut pas être lié à Linear.";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectLinearLink {
    pub project_id: String,
    pub linear_project_id: String,
}

pub(super) fn list_links(db: &Connection) -> Result<Vec<AgentProjectLinearLink>> {
    let mut statement = db
        .prepare(
            "SELECT project_id, linear_project_id FROM agent_project_linear_links ORDER BY rowid",
        )
        .map_err(|error| error.to_string())?;
    let links = statement
        .query_map([], |row| {
            Ok(AgentProjectLinearLink {
                project_id: row.get(0)?,
                linear_project_id: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())?;
    Ok(links)
}

fn require_linkable_project(store: &Store, project_id: &str) -> Result<AgentProject> {
    let project = require_project(store, project_id)?;
    if groups::group_project_ids(&store.db)?.contains(project_id) {
        return Err(UNLINKABLE_PROJECT_MESSAGE.into());
    }
    Ok(project)
}

/// Mirrors the Projects rail: only a worktree group's repository project stands for the repository.
fn is_worktree_project(snapshot: &AgentProjectWorktreeSnapshot, project_id: &str) -> bool {
    snapshot.groups.iter().any(|group| {
        group.repository_project_id != project_id
            && group.project_ids.iter().any(|member| member == project_id)
    })
}

impl AgentSessions {
    /// The Soreno projects Linear issues are shown in, by Linear project.
    pub fn linear_project_links(&self) -> Result<ProjectLinks> {
        let store = lock(&self.store)?;
        let links = store
            .db
            .prepare(
                "SELECT link.linear_project_id, project.id, COALESCE(json_extract(project.data, '$.name'), '')
                FROM agent_project_linear_links link JOIN agent_projects project ON project.id=link.project_id",
            )
            .map_err(|error| error.to_string())?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    KanbanProjectRef {
                        id: row.get(1)?,
                        name: row.get(2)?,
                    },
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|error| error.to_string())?;
        Ok(ProjectLinks::new(links))
    }

    pub fn set_project_linear_link(
        &self,
        project_id: &str,
        linear_project_id: Option<&str>,
    ) -> Result<()> {
        self.set_project_linear_link_with(project_id, linear_project_id, |target| {
            // Worktree groups never span environments, so other machines need no Git probe.
            self.worktree_groups_with(
                |project| {
                    if same_agent_environment(&project.environment, &target.environment) {
                        discover_worktree_identity(project)
                    } else {
                        Ok(None)
                    }
                },
                list_project_worktrees,
            )
        })
    }
    pub(super) fn set_project_linear_link_with(
        &self,
        project_id: &str,
        linear_project_id: Option<&str>,
        worktree_snapshot: impl FnOnce(&AgentProject) -> Result<AgentProjectWorktreeSnapshot>,
    ) -> Result<()> {
        id(project_id)?;
        let Some(linear_project_id) = linear_project_id else {
            let store = lock(&self.store)?;
            require_project(&store, project_id)?;
            store
                .db
                .execute(
                    "DELETE FROM agent_project_linear_links WHERE project_id=?1",
                    [project_id],
                )
                .map_err(|error| error.to_string())?;
            return Ok(());
        };
        text(linear_project_id, "Identifiant du projet Linear", 128)?;
        let project = require_linkable_project(&*lock(&self.store)?, project_id)?;
        if is_worktree_project(&worktree_snapshot(&project)?, project_id) {
            return Err(UNLINKABLE_PROJECT_MESSAGE.into());
        }
        let store = lock(&self.store)?;
        require_linkable_project(&store, project_id)?;
        let owner: Option<String> = store
            .db
            .query_row(
                "SELECT project_id FROM agent_project_linear_links WHERE linear_project_id=?1 AND project_id<>?2",
                [linear_project_id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(owner) = owner {
            let name = get::<AgentProject>(&store.db, "agent_projects", &owner)?
                .map_or(owner, |project| project.name);
            return Err(format!(
                "Ce projet Linear est déjà lié au projet « {name} »."
            ));
        }
        store
            .db
            .execute(
                "INSERT INTO agent_project_linear_links(project_id, linear_project_id) VALUES (?1, ?2) ON CONFLICT(project_id) DO UPDATE SET linear_project_id=excluded.linear_project_id",
                params![project_id, linear_project_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
