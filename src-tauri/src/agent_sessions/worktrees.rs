use super::{
    disconnected_project_ids, environment_dormant, groups, id, list, lock, project_disconnected,
    same_ssh_target, validate_project, AgentEnvironment, AgentProject, AgentProjectBranch,
    AgentProjectWorktree, AgentProjectWorktreeGroup, AgentProjectWorktreeSnapshot,
    AgentServiceBranch, AgentServiceDirectory, AgentSessions, Result,
};
use std::collections::HashSet;

pub(super) struct DiscoveredWorktreeMember {
    pub(super) project_index: usize,
    pub(super) root: String,
}
pub(super) struct DiscoveredWorktreeGroup {
    pub(super) environment: AgentEnvironment,
    pub(super) common_dir: String,
    pub(super) members: Vec<DiscoveredWorktreeMember>,
}
pub(crate) enum WorktreeDiscoveryFailure {
    MissingDirectory,
    Unknown,
}

impl AgentSessions {
    pub fn branches(&self) -> Result<Vec<AgentProjectBranch>> {
        self.branches_with(project_branch)
    }
    pub fn service_branches(
        &self,
        project_id: &str,
        services: Vec<AgentServiceDirectory>,
    ) -> Result<Vec<AgentServiceBranch>> {
        if services.len() > 64 {
            return Err("Un projet ne peut pas déclarer plus de 64 services.".into());
        }
        let project = self.project(project_id)?;
        let mut ids = HashSet::with_capacity(services.len());
        services
            .into_iter()
            .map(|service| {
                id(&service.service_id)?;
                if !ids.insert(service.service_id.clone()) {
                    return Err(format!(
                        "Identifiant de service dupliqué : {}.",
                        service.service_id
                    ));
                }
                let service_project = AgentProject {
                    path: service.cwd,
                    ..project.clone()
                };
                validate_project(&service_project)?;
                let branch = self
                    .project_currently_connected(&service_project)?
                    .then(|| project_branch(&service_project))
                    .flatten();
                let branch = self
                    .project_currently_connected(&service_project)?
                    .then_some(branch)
                    .flatten();
                Ok(AgentServiceBranch {
                    service_id: service.service_id,
                    branch,
                })
            })
            .collect()
    }
    pub fn worktree_groups(&self) -> Result<AgentProjectWorktreeSnapshot> {
        self.worktree_groups_with(discover_worktree_identity, list_project_worktrees)
    }
    pub(crate) fn worktree_groups_with(
        &self,
        mut discover: impl FnMut(
            &AgentProject,
        ) -> std::result::Result<
            Option<(String, String)>,
            WorktreeDiscoveryFailure,
        >,
        mut list_worktrees: impl FnMut(
            &AgentProject,
        )
            -> std::result::Result<Vec<crate::project_git::GitWorktree>, ()>,
    ) -> Result<AgentProjectWorktreeSnapshot> {
        let (projects, disconnected_project_ids) = {
            let store = lock(&self.store)?;
            (
                repository_projects(&store.db)?,
                disconnected_project_ids(&store.db)?,
            )
        };
        let mut disconnected_project_indices: HashSet<usize> = projects
            .iter()
            .enumerate()
            .filter(|(_, project)| disconnected_project_ids.contains(&project.id))
            .map(|(index, _)| index)
            .collect();
        let mut discovered_project_indices = HashSet::new();
        let mut missing_project_ids = Vec::new();
        let mut groups: Vec<DiscoveredWorktreeGroup> = Vec::new();
        let mut complete = true;
        for (project_index, project) in projects.iter().enumerate() {
            if disconnected_project_indices.contains(&project_index)
                || !self.project_currently_connected(project)?
            {
                disconnected_project_indices.insert(project_index);
                continue;
            }
            let discovery = discover(project);
            if matches!(&discovery, Ok(Some(_))) {
                discovered_project_indices.insert(project_index);
            }
            if !self.project_currently_connected(project)? {
                disconnected_project_indices.insert(project_index);
                continue;
            }
            let (root, common_dir) = match discovery {
                Ok(Some(identity)) => identity,
                Ok(None) => continue,
                Err(WorktreeDiscoveryFailure::MissingDirectory) => {
                    missing_project_ids.push(project.id.clone());
                    continue;
                }
                Err(WorktreeDiscoveryFailure::Unknown) => {
                    complete = false;
                    continue;
                }
            };
            let member = DiscoveredWorktreeMember {
                project_index,
                root,
            };
            if let Some(group) = groups.iter_mut().find(|group| {
                same_agent_environment(&group.environment, &project.environment)
                    && group.common_dir == common_dir
            }) {
                group.members.push(member);
            } else {
                groups.push(DiscoveredWorktreeGroup {
                    environment: project.environment.clone(),
                    common_dir,
                    members: vec![member],
                });
            }
        }

        let mut result = Vec::new();
        for mut group in groups {
            let mut connected_members = Vec::new();
            for member in group.members {
                if self.project_currently_connected(&projects[member.project_index])? {
                    connected_members.push(member);
                } else {
                    disconnected_project_indices.insert(member.project_index);
                }
            }
            group.members = connected_members;
            let Some(source) = group
                .members
                .first()
                .map(|member| &projects[member.project_index])
            else {
                complete = false;
                continue;
            };
            let worktree_probe = list_worktrees(source);
            if !self.project_currently_connected(source)? {
                disconnected_project_indices.insert(group.members[0].project_index);
                complete = false;
                continue;
            }
            let worktrees = match worktree_probe {
                Ok(worktrees) => worktrees,
                Err(()) => {
                    complete = false;
                    continue;
                }
            };
            if uncertain_disconnected_worktree_association(
                &projects,
                &discovered_project_indices,
                &disconnected_project_indices,
                &group,
                &worktrees,
            ) {
                complete = false;
            }
            result.push(assemble_worktree_group(
                &projects,
                &discovered_project_indices,
                &disconnected_project_indices,
                &group,
                worktrees,
            ));
        }
        Ok(AgentProjectWorktreeSnapshot {
            groups: result,
            complete,
            missing_project_ids,
        })
    }
    /// Checks the captured snapshot, not the current row: a project deleted or
    /// retargeted mid-refresh must not let a stale dormant target be probed.
    fn project_currently_connected(&self, project: &AgentProject) -> Result<bool> {
        let store = lock(&self.store)?;
        Ok(!project_disconnected(&store.db, &project.id)?
            && !environment_dormant(&store, &project.environment))
    }
    pub(super) fn branches_with(
        &self,
        probe: impl Fn(&AgentProject) -> Option<String> + Sync,
    ) -> Result<Vec<AgentProjectBranch>> {
        let projects: Vec<AgentProject> = {
            let store = lock(&self.store)?;
            repository_projects(&store.db)?
        };
        // One lane per WSL distribution or SSH host: bounded Git load per target,
        // while a slow or unreachable host no longer delays every other project.
        let mut lanes: Vec<Vec<usize>> = Vec::new();
        for (index, project) in projects.iter().enumerate() {
            match lanes.iter_mut().find(|lane| {
                same_agent_environment(&projects[lane[0]].environment, &project.environment)
            }) {
                Some(lane) => lane.push(index),
                None => lanes.push(vec![index]),
            }
        }
        let branch_of = |index: usize| -> Result<(usize, AgentProjectBranch)> {
            let project = &projects[index];
            let branch = self
                .project_currently_connected(project)?
                .then(|| probe(project))
                .flatten();
            let connected = self.project_currently_connected(project)?;
            Ok((
                index,
                AgentProjectBranch {
                    branch: connected.then_some(branch).flatten(),
                    project_id: project.id.clone(),
                },
            ))
        };
        let mut branches = std::thread::scope(|scope| {
            let workers: Vec<_> = lanes
                .into_iter()
                .map(|lane| {
                    let branch_of = &branch_of;
                    scope.spawn(move || lane.into_iter().map(branch_of).collect::<Result<Vec<_>>>())
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Result<Vec<_>>>()
        })?
        .concat();
        branches.sort_unstable_by_key(|(index, _)| *index);
        Ok(branches.into_iter().map(|(_, branch)| branch).collect())
    }
}
pub(super) fn discover_worktree_identity(
    project: &AgentProject,
) -> std::result::Result<Option<(String, String)>, WorktreeDiscoveryFailure> {
    let repository = match crate::project_git::discover_repository(project) {
        Ok(repository) => repository,
        // A deleted folder belongs to no worktree; treating it as a probe failure keeps every snapshot partial.
        Err(error) if error.code == "missingDirectory" => {
            return Err(WorktreeDiscoveryFailure::MissingDirectory)
        }
        Err(_) => return Err(WorktreeDiscoveryFailure::Unknown),
    };
    if repository.availability != "ready" {
        return Ok(None);
    }
    repository
        .identity
        .map(|identity| Some((identity.root, identity.common_dir)))
        .ok_or(WorktreeDiscoveryFailure::Unknown)
}
pub(super) fn list_project_worktrees(
    project: &AgentProject,
) -> std::result::Result<Vec<crate::project_git::GitWorktree>, ()> {
    crate::project_git::worktrees(project).map_err(|_| ())
}

/// Group projects are Soreno folders, not repositories: probing them would cost an SSH call per poll.
fn repository_projects(db: &rusqlite::Connection) -> Result<Vec<AgentProject>> {
    let group_projects = groups::group_project_ids(db)?;
    Ok(list::<AgentProject>(db, "agent_projects")?
        .into_iter()
        .filter(|project| !group_projects.contains(&project.id))
        .collect())
}
pub(crate) fn same_agent_environment(left: &AgentEnvironment, right: &AgentEnvironment) -> bool {
    left.kind == right.kind
        && match left.kind.as_str() {
            "local" => true,
            "wsl" => left
                .distribution
                .as_deref()
                .zip(right.distribution.as_deref())
                .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right)),
            "ssh" => left
                .ssh
                .as_ref()
                .zip(right.ssh.as_ref())
                .is_some_and(|(left, right)| same_ssh_target(left, right)),
            _ => false,
        }
}
fn normalized_posix_worktree_path(path: &str) -> Option<&str> {
    path.starts_with('/').then(|| {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            "/"
        } else {
            trimmed
        }
    })
}
fn same_posix_worktree_path(left: &str, right: &str) -> bool {
    normalized_posix_worktree_path(left)
        .zip(normalized_posix_worktree_path(right))
        .is_some_and(|(left, right)| left == right)
}
fn posix_worktree_contains(root: &str, path: &str) -> bool {
    normalized_posix_worktree_path(root)
        .zip(normalized_posix_worktree_path(path))
        .is_some_and(|(root, path)| {
            root == "/"
                || path == root
                || path
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
}
pub(crate) fn same_worktree_path(environment: &AgentEnvironment, left: &str, right: &str) -> bool {
    match environment.kind.as_str() {
        "local" => std::fs::canonicalize(left)
            .ok()
            .zip(std::fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right),
        "wsl" | "ssh" => same_posix_worktree_path(left, right),
        _ => false,
    }
}
fn project_matches_worktree(
    projects: &[AgentProject],
    discovered_project_indices: &HashSet<usize>,
    disconnected_project_indices: &HashSet<usize>,
    group: &DiscoveredWorktreeGroup,
    project_index: usize,
    worktree_path: &str,
) -> bool {
    let project = &projects[project_index];
    if !same_agent_environment(&group.environment, &project.environment) {
        return false;
    }
    let project_path = match group
        .members
        .iter()
        .find(|member| member.project_index == project_index)
    {
        Some(member) => member.root.as_str(),
        None if !discovered_project_indices.contains(&project_index)
            || disconnected_project_indices.contains(&project_index) =>
        {
            &project.path
        }
        None => return false,
    };
    same_worktree_path(&group.environment, project_path, worktree_path)
}
fn uncertain_disconnected_worktree_association(
    projects: &[AgentProject],
    discovered_project_indices: &HashSet<usize>,
    disconnected_project_indices: &HashSet<usize>,
    group: &DiscoveredWorktreeGroup,
    listed: &[crate::project_git::GitWorktree],
) -> bool {
    projects.iter().enumerate().any(|(project_index, project)| {
        disconnected_project_indices.contains(&project_index)
            && same_agent_environment(&group.environment, &project.environment)
            && !listed.iter().any(|worktree| {
                project_matches_worktree(
                    projects,
                    discovered_project_indices,
                    disconnected_project_indices,
                    group,
                    project_index,
                    &worktree.path,
                )
            })
            && listed
                .iter()
                .any(|worktree| posix_worktree_contains(&worktree.path, &project.path))
    })
}
pub(super) fn assemble_worktree_group(
    projects: &[AgentProject],
    discovered_project_indices: &HashSet<usize>,
    disconnected_project_indices: &HashSet<usize>,
    group: &DiscoveredWorktreeGroup,
    listed: Vec<crate::project_git::GitWorktree>,
) -> AgentProjectWorktreeGroup {
    let repository_project_id = listed
        .first()
        .and_then(|primary| {
            group
                .members
                .iter()
                .find(|member| same_worktree_path(&group.environment, &member.root, &primary.path))
        })
        .unwrap_or(&group.members[0]);
    let repository_project_id = projects[repository_project_id.project_index].id.clone();
    let project_ids = projects
        .iter()
        .enumerate()
        .filter(|(project_index, _)| {
            listed.iter().any(|worktree| {
                project_matches_worktree(
                    projects,
                    discovered_project_indices,
                    disconnected_project_indices,
                    group,
                    *project_index,
                    &worktree.path,
                )
            })
        })
        .map(|(_, project)| project.id.clone())
        .collect();
    let worktrees = listed
        .into_iter()
        .map(|worktree| AgentProjectWorktree {
            project_ids: projects
                .iter()
                .enumerate()
                .filter(|(project_index, _)| {
                    project_matches_worktree(
                        projects,
                        discovered_project_indices,
                        disconnected_project_indices,
                        group,
                        *project_index,
                        &worktree.path,
                    )
                })
                .map(|(_, project)| project.id.clone())
                .collect(),
            path: worktree.path,
            head: worktree.head,
            branch: worktree.branch,
        })
        .collect();
    AgentProjectWorktreeGroup {
        repository_project_id,
        project_ids,
        worktrees,
    }
}
fn project_branch(project: &AgentProject) -> Option<String> {
    validate_project(project).ok()?;
    crate::project_git::branch_hint(project)
}
