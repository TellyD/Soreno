#[cfg(windows)]
use super::wsl_read;
use super::{
    execute, with_read_budget, AgentProject, GitBranch, GitCommitDetail, GitComparison, GitError,
    GitFile, GitHistory, GitOperation, GitRemote, GitRepository, GitSide, GitWorktree,
    BRANCH_HINT_TIMEOUT, COMPLETE_READ_TIMEOUT,
};

// Display-only transport opt-in. Mutation validation deliberately uses neither this
// scope nor its queues: repository_state() and comparison() stay on the fresh runner.
pub(super) fn display_read<T>(
    project: &AgentProject,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    #[cfg(windows)]
    {
        wsl_read::with_display_reads(project, read)
    }
    #[cfg(not(windows))]
    {
        let _ = project;
        with_read_budget(COMPLETE_READ_TIMEOUT, read)
    }
}

pub(super) fn branch_hint_read<T>(
    project: &AgentProject,
    read: impl FnOnce() -> Result<T, GitError>,
) -> Result<T, GitError> {
    with_read_budget(BRANCH_HINT_TIMEOUT, || {
        #[cfg(windows)]
        {
            wsl_read::with_background_display_reads(project, read)
        }
        #[cfg(not(windows))]
        {
            let _ = project;
            read()
        }
    })
}

fn branch_hint_output(bytes: Vec<u8>) -> Result<Option<String>, GitError> {
    let output = String::from_utf8(bytes)
        .map_err(|_| GitError::new("malformed", "Branche Git non UTF-8."))?;
    let output = output.trim();
    Ok((!output.is_empty()).then(|| output.to_owned()))
}

pub(super) fn branch_hint_from(
    mut read: impl FnMut(&[&str]) -> Result<Vec<u8>, GitError>,
) -> Result<Option<String>, GitError> {
    let branch = match read(&["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(output) => branch_hint_output(output)?,
        Err(error) if error.code == "failed" => None,
        Err(error) => return Err(error),
    };
    if branch.is_some() {
        return Ok(branch);
    }
    Ok(
        branch_hint_output(read(&["rev-parse", "--short", "HEAD"])?)?
            .map(|sha| format!("HEAD @ {sha}")),
    )
}

pub(crate) fn branch_hint(project: &AgentProject) -> Option<String> {
    branch_hint_read(project, || {
        branch_hint_from(|args| {
            execute(project, args, GitOperation::Read, None).map(|output| output.stdout)
        })
    })
    .ok()
    .flatten()
}

pub(crate) fn branches(project: &AgentProject) -> Result<Vec<GitBranch>, GitError> {
    display_read(project, || super::branches::branches(project))
}

pub(crate) fn worktrees(project: &AgentProject) -> Result<Vec<GitWorktree>, GitError> {
    display_read(project, || super::branches::worktrees(project))
}

pub(crate) fn discover_worktrees(project: &AgentProject) -> Result<Vec<GitWorktree>, GitError> {
    super::branches::worktrees(project)
}

pub(crate) fn history(
    project: &AgentProject,
    roots: Option<&[String]>,
    offset: usize,
    path: Option<&str>,
) -> Result<GitHistory, GitError> {
    display_read(project, || {
        super::history::history(project, roots, offset, path)
    })
}

pub(crate) fn path_prefix(project: &AgentProject) -> Result<Option<String>, GitError> {
    display_read(project, || super::history::path_prefix(project))
}

pub(crate) fn commit_detail(
    project: &AgentProject,
    oid: &str,
) -> Result<GitCommitDetail, GitError> {
    display_read(project, || super::history::commit_detail(project, oid))
}

pub(crate) fn commit_comparison(
    project: &AgentProject,
    oid: &str,
    path: &str,
) -> Result<GitComparison, GitError> {
    display_read(project, || {
        super::history::commit_comparison(project, oid, path)
    })
}

pub(crate) fn range_files(
    project: &AgentProject,
    base: &str,
    head: &str,
) -> Result<Vec<GitFile>, GitError> {
    display_read(project, || super::reading::range_files(project, base, head))
}

pub(crate) fn range_comparison(
    project: &AgentProject,
    base: &str,
    head: &str,
    path: &str,
) -> Result<GitComparison, GitError> {
    display_read(project, || {
        super::version(project)?;
        super::reading::range_comparison(project, base, head, path)?.ok_or_else(|| {
            GitError::new(
                "stalePath",
                "Ce chemin ne figure pas dans les changements de cette demande.",
            )
        })
    })
}

pub(crate) fn remotes(project: &AgentProject) -> Result<Vec<GitRemote>, GitError> {
    display_read(project, || super::remotes::remotes(project))
}

pub(crate) fn first_remote_url(
    project: &AgentProject,
    names: &[&str],
) -> Result<Option<(String, String)>, GitError> {
    display_read(project, || super::remotes::first_remote_url(project, names))
}

pub(crate) fn repository(project: &AgentProject) -> Result<GitRepository, GitError> {
    display_read(project, || super::reading::repository(project))
}

pub(crate) fn repository_state(project: &AgentProject) -> Result<GitRepository, GitError> {
    with_read_budget(COMPLETE_READ_TIMEOUT, || {
        super::reading::repository_state(project)
    })
}

pub(crate) fn comparison(
    project: &AgentProject,
    path: &str,
    side: GitSide,
) -> Result<GitComparison, GitError> {
    with_read_budget(COMPLETE_READ_TIMEOUT, || {
        super::reading::comparison(project, path, side)
    })
}

pub(crate) fn preview_comparison(
    project: &AgentProject,
    path: &str,
    side: GitSide,
    version: Option<&str>,
) -> Result<GitComparison, GitError> {
    display_read(project, || {
        super::reading::preview_comparison(project, path, side, version)
    })
}
