use super::{
    commit_parents, execute, reference_oid, repository, require_idle_snapshot, validate_oid,
    AgentProject, GitError, GitOperation,
};

// The target worktree is verified clean, so a failed merge can be aborted without loss.
pub(super) fn merge_base_into_worktree(
    target: &AgentProject,
    base: &str,
    base_head: &str,
    branch: &str,
    merge_options: Option<&str>,
) -> Result<String, GitError> {
    let message = format!("Merge branch '{base}' into {branch}");
    if let Err(error) = execute_merge(
        target,
        merge_options,
        &[
            "--no-ff",
            "--commit",
            "--no-squash",
            "--no-autostash",
            "--no-overwrite-ignore",
            "-m",
            &message,
            base_head,
        ],
    ) {
        let state = repository(target)?;
        if state.operation.as_deref() != Some("merge") {
            return Err(error);
        }
        let conflicts = state
            .files
            .iter()
            .filter(|file| file.conflict)
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        if conflicts.is_empty() {
            let _ = execute(
                target,
                &["merge", "--abort"],
                GitOperation::LocalMutation,
                None,
            );
            return Err(error);
        }
        return Err(GitError::new(
            "mergeConflict",
            format!(
                "« {base} » a avancé et entre en conflit avec « {branch} » : {}. La fusion de « {base} » reste en cours dans ce worktree : résolvez les conflits dans Changes, commitez la fusion, puis relancez « Fusionner dans {base} ».",
                conflicts.join(", ")
            ),
        ));
    }
    head_oid(target)
}

pub(super) fn require_primary_ready(
    project: &AgentProject,
    base: &str,
    expected_head: &str,
) -> Result<(), GitError> {
    let state = repository(project)?;
    require_idle_snapshot(state.operation.as_deref())?;
    if !state.files.is_empty() {
        return Err(GitError::new(
            "primaryDirty",
            format!("Le worktree principal (« {base} ») doit être propre avant la fusion."),
        ));
    }
    if state.head.as_deref() != Some(expected_head)
        || state.branch.as_deref() != Some(base)
        || reference_oid(project, &format!("refs/heads/{base}"))? != expected_head
    {
        return Err(GitError::new(
            "stale",
            "Le worktree principal a changé. Actualisez la liste avant de fusionner.",
        ));
    }
    Ok(())
}

pub(super) fn merge_options_override(
    project: &AgentProject,
    branch: &str,
) -> Result<Option<String>, GitError> {
    let key = format!("branch.{branch}.mergeOptions");
    if !branch.contains('=') {
        return Ok(Some(format!("{key}=")));
    }
    match execute(
        project,
        &["config", "--get-all", &key],
        GitOperation::Read,
        None,
    ) {
        Ok(_) => Err(GitError::new(
            "mergeOptions",
            format!(
                "Supprimez la configuration « {key} » avant de fusionner cette branche avec Soreno."
            ),
        )),
        Err(error) if error.code == "failed" => {
            execute(
                project,
                &["config", "--null", "--list"],
                GitOperation::Read,
                None,
            )?;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn execute_merge(
    project: &AgentProject,
    merge_options: Option<&str>,
    args: &[&str],
) -> Result<(), GitError> {
    let mut command = Vec::with_capacity(args.len() + 3);
    if let Some(merge_options) = merge_options {
        command.extend(["-c", merge_options]);
    }
    command.push("merge");
    command.extend_from_slice(args);
    execute(project, &command, GitOperation::LocalMutation, None).map(|_| ())
}

pub(super) fn merge_primary(
    project: &AgentProject,
    merge_options: Option<&str>,
    args: &[&str],
) -> Result<(), GitError> {
    if let Err(mut error) = execute_merge(project, merge_options, args) {
        if repository(project).is_ok_and(|state| state.operation.as_deref() == Some("merge")) {
            if let Err(abort_error) = execute(
                project,
                &["merge", "--abort"],
                GitOperation::LocalMutation,
                None,
            ) {
                error.message.push_str(&format!(
                    " La fusion du worktree principal n’a pas pu être annulée : {}",
                    abort_error.message
                ));
            }
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn verify_primary_integration(
    project: &AgentProject,
    base: &str,
    expected_head: &str,
    expected_parents: Option<(&str, &str)>,
) -> Result<(), GitError> {
    let state = repository(project)?;
    let parents_valid = match expected_parents {
        Some((first, second)) => {
            let parents = commit_parents(project, expected_head)?;
            parents.len() == 2 && parents[0] == first && parents[1] == second
        }
        None => true,
    };
    let valid = state.operation.is_none()
        && state.files.is_empty()
        && state.head.as_deref() == Some(expected_head)
        && state.branch.as_deref() == Some(base)
        && reference_oid(project, &format!("refs/heads/{base}"))? == expected_head
        && parents_valid;
    if !valid {
        return Err(GitError::new(
            "mergeIncomplete",
            format!(
                "Impossible de confirmer l’intégration de la branche dans « {base} ». Le worktree est conservé."
            ),
        ));
    }
    Ok(())
}

pub(super) fn head_oid(project: &AgentProject) -> Result<String, GitError> {
    reference_oid(project, "HEAD")
}

pub(super) fn is_first_parent_ancestor(
    project: &AgentProject,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, GitError> {
    let output = execute(
        project,
        &["rev-list", "--first-parent", descendant],
        GitOperation::Read,
        None,
    )?;
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| GitError::new("malformed", "Historique Git non UTF-8."))?;
    for oid in text.lines() {
        validate_oid(oid)?;
        if oid == ancestor {
            return Ok(true);
        }
    }
    Ok(false)
}
