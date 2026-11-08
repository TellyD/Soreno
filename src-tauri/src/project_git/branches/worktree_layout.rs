use super::{
    execute, same_worktree_path, validate_oid, validate_ref_name, AgentProject, GitError,
    GitOperation, GitWorktree,
};

pub(super) fn require_worktree_list_version(version: &str) -> Result<(), GitError> {
    let parsed = super::super::parse_version(version)
        .ok_or_else(|| GitError::new("malformed", "Version Git invalide."))?;
    if parsed < (2, 36, 0) {
        return Err(GitError::new(
            "old",
            format!(
                "La liste des worktrees exige Git 2.36 ou plus récent (version détectée : {version})."
            ),
        ));
    }
    Ok(())
}

pub(super) struct WorktreeLayout {
    pub(super) root_path: String,
    pub(super) primary: Option<GitWorktree>,
    pub(super) worktrees: Vec<GitWorktree>,
}

enum WorktreeEntry {
    Bare(String),
    Linked(GitWorktree),
}

pub(super) fn worktree_layout(project: &AgentProject) -> Result<WorktreeLayout, GitError> {
    require_worktree_list_version(&super::super::version(project)?)?;
    let output = execute(
        project,
        &["worktree", "list", "--porcelain", "-z"],
        GitOperation::Read,
        None,
    )?;
    parse_worktree_layout(&output.stdout)
}

#[cfg(test)]
pub(super) fn parse_worktrees(bytes: &[u8]) -> Result<Vec<GitWorktree>, GitError> {
    Ok(parse_worktree_layout(bytes)?.worktrees)
}

pub(super) fn parse_worktree_layout(bytes: &[u8]) -> Result<WorktreeLayout, GitError> {
    #[derive(Default)]
    struct Pending {
        path: Option<String>,
        head: Option<String>,
        branch: Option<String>,
        bare: bool,
    }

    fn finish(pending: Pending) -> Result<WorktreeEntry, GitError> {
        let path = pending.path.ok_or_else(malformed_worktrees)?;
        if pending.bare {
            if pending.head.is_some() || pending.branch.is_some() {
                return Err(malformed_worktrees());
            }
            return Ok(WorktreeEntry::Bare(path));
        }
        Ok(WorktreeEntry::Linked(GitWorktree {
            path,
            head: pending.head.ok_or_else(malformed_worktrees)?,
            branch: pending.branch,
        }))
    }

    let mut entries = Vec::new();
    let mut pending: Option<Pending> = None;
    for field in bytes.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(value) = pending.take() {
                entries.push(finish(value)?);
            }
            continue;
        }
        let text = std::str::from_utf8(field)
            .map_err(|_| GitError::new("malformed", "Liste de worktrees Git non UTF-8."))?;
        if let Some(path) = text.strip_prefix("worktree ") {
            if pending.is_some() || path.is_empty() {
                return Err(malformed_worktrees());
            }
            pending = Some(Pending {
                path: Some(path.into()),
                ..Pending::default()
            });
        } else if let Some(head) = text.strip_prefix("HEAD ") {
            validate_oid(head)?;
            pending.as_mut().ok_or_else(malformed_worktrees)?.head = Some(head.into());
        } else if let Some(branch) = text.strip_prefix("branch refs/heads/") {
            validate_ref_name(branch)?;
            pending.as_mut().ok_or_else(malformed_worktrees)?.branch = Some(branch.into());
        } else if text == "bare" {
            pending.as_mut().ok_or_else(malformed_worktrees)?.bare = true;
        } else if text == "detached" || text.starts_with("locked") || text.starts_with("prunable") {
            pending.as_ref().ok_or_else(malformed_worktrees)?;
        } else {
            return Err(malformed_worktrees());
        }
    }
    if let Some(value) = pending {
        entries.push(finish(value)?);
    }
    let first = entries.first().ok_or_else(malformed_worktrees)?;
    let (root_path, primary) = match first {
        WorktreeEntry::Bare(path) => (path.clone(), None),
        WorktreeEntry::Linked(worktree) => (worktree.path.clone(), Some(worktree.clone())),
    };
    let mut worktrees = Vec::new();
    for (index, entry) in entries.into_iter().enumerate() {
        match entry {
            WorktreeEntry::Bare(_) if index == 0 && primary.is_none() => {}
            WorktreeEntry::Bare(_) => return Err(malformed_worktrees()),
            WorktreeEntry::Linked(worktree) => worktrees.push(worktree),
        }
    }
    Ok(WorktreeLayout {
        root_path,
        primary,
        worktrees,
    })
}

pub(super) fn plausible_worktree_alias(
    environment: &crate::agent_sessions::AgentEnvironment,
    project_path: &str,
    layout: &WorktreeLayout,
) -> bool {
    std::iter::once(layout.root_path.as_str())
        .chain(
            layout
                .worktrees
                .iter()
                .map(|worktree| worktree.path.as_str()),
        )
        .any(|root| {
            same_worktree_path(environment, root, project_path)
                || match environment.kind.as_str() {
                    "local" => std::path::Path::new(project_path).starts_with(root),
                    "wsl" | "ssh" => project_path
                        .strip_prefix(root.trim_end_matches('/'))
                        .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('/')),
                    _ => false,
                }
        })
}

fn malformed_worktrees() -> GitError {
    GitError::new(
        "malformed",
        "Git a retourné une liste de worktrees invalide.",
    )
}
