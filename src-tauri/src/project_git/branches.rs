use super::{
    execute, mutations, oid_output, repository_state as repository, require_idle, setup,
    validate_oid, validate_ref_name, GitBranch, GitError, GitMutationResult, GitOperation,
    GitWorktree,
};
use crate::agent_sessions::{
    same_agent_environment, same_worktree_path, validate_project, validate_project_directory,
    AgentProject, AgentProjectWorktree, AgentSessions, GitOperationLease, SessionEnd,
    StoppedProjects, WorktreeDiscoveryFailure, HAS_AUTOMATION,
};
use serde::Deserialize;

#[derive(Debug)]
struct BranchRef {
    branch: GitBranch,
    reference: String,
    symbolic: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitWorktreeRequest {
    pub id: String,
    pub name: String,
    pub parent_path: String,
    pub folder_name: String,
    pub branch: String,
    pub remote: bool,
    #[serde(default)]
    pub create_branch: bool,
    pub version: String,
}

pub(crate) fn branches(project: &AgentProject) -> Result<Vec<GitBranch>, GitError> {
    super::version(project)?;
    Ok(list_rooted(project)?
        .into_iter()
        .filter(|entry| !entry.symbolic)
        .map(|entry| entry.branch)
        .collect())
}

pub(crate) fn worktrees(project: &AgentProject) -> Result<Vec<GitWorktree>, GitError> {
    Ok(worktree_layout(project)?.worktrees)
}

pub(crate) fn create_worktree(
    sessions: &AgentSessions,
    source_project_id: &str,
    request: GitWorktreeRequest,
) -> Result<AgentProject, GitError> {
    setup::validate_folder_name(&request.folder_name)?;
    validate_ref_name(&request.branch)?;
    validate_oid(&request.version)?;
    let (lease, source) = sessions
        .begin_git_operation_for_new_project_from(&request.id, source_project_id)
        .map_err(|message| GitError::new("busy", message))?;
    require_idle()?;
    validate_project_directory(&source.environment, &request.parent_path)
        .map_err(|message| GitError::new("invalidProject", message))?;
    let snapshot = repository(&source)?;
    if snapshot.availability != "ready" {
        return Err(GitError::new(
            "unavailable",
            "Cette opération exige un dépôt Git avec une copie de travail.",
        ));
    }
    if snapshot.version != request.version {
        return Err(GitError::new(
            "stale",
            "L’état Git a changé. Actualisez le panneau avant de réessayer.",
        ));
    }
    require_idle_snapshot(snapshot.operation.as_deref())?;
    let identity = snapshot
        .identity
        .ok_or_else(|| GitError::new("malformed", "Identité du dépôt Git absente."))?;
    let path = setup::logical_destination(
        &source.environment,
        &request.parent_path,
        &request.folder_name,
    )?;
    let project = AgentProject {
        id: request.id,
        name: request.name,
        path: path.clone(),
        environment: source.environment.clone(),
        icon_data_url: source.icon_data_url.clone(),
        icon: source.icon.clone(),
        color: source.color.clone(),
    };
    validate_project(&project).map_err(|message| GitError::new("invalidProject", message))?;
    let native_destination = setup::native_destination(
        &project.environment,
        &request.parent_path,
        &request.folder_name,
    )?;
    let rooted = AgentProject {
        path: identity.root,
        ..source
    };
    let refs = list_rooted(&rooted)?;
    let may_create_branch = request.create_branch || request.remote;
    let mut owned_args = vec!["worktree".to_owned(), "add".to_owned()];
    if request.create_branch {
        if request.remote {
            return Err(GitError::new(
                "invalidRef",
                "Une nouvelle branche de worktree doit être locale.",
            ));
        }
        let reference = format!("refs/heads/{}", request.branch);
        if is_symbolic_ref(&rooted, &reference)?
            || refs.iter().any(|entry| entry.reference == reference)
        {
            return Err(GitError::new(
                "branchExists",
                "Cette branche locale existe déjà.",
            ));
        }
        owned_args.extend(["-b".to_owned(), request.branch.clone(), path.clone()]);
    } else if request.remote {
        let reference = format!("refs/remotes/{}", request.branch);
        if !refs
            .iter()
            .any(|entry| entry.reference == reference && !entry.symbolic)
        {
            return Err(GitError::new(
                "missingBranch",
                "Cette branche distante n’existe plus.",
            ));
        }
        let local = tracking_local_name(&request.branch)?;
        let local_reference = format!("refs/heads/{local}");
        if is_symbolic_ref(&rooted, &local_reference)?
            || refs.iter().any(|entry| entry.reference == local_reference)
        {
            return Err(GitError::new(
                "branchExists",
                "La branche locale de suivi existe déjà.",
            ));
        }
        owned_args.extend([
            "--track".to_owned(),
            "-b".to_owned(),
            local.to_owned(),
            path.clone(),
            reference,
        ]);
    } else {
        let reference = format!("refs/heads/{}", request.branch);
        if !refs
            .iter()
            .any(|entry| entry.reference == reference && !entry.symbolic)
        {
            return Err(GitError::new(
                "missingBranch",
                "Cette branche locale n’existe plus.",
            ));
        }
        owned_args.extend([path.clone(), request.branch.clone()]);
    }
    let args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
    setup::create_destination(&project, native_destination.as_deref())
        .map_err(|error| error.with_path(&path))?;
    if let Err(mut error) = execute(&rooted, &args, GitOperation::LocalMutation, None) {
        setup::remove_empty_destination(&project, native_destination.as_deref());
        if may_create_branch {
            error.message.push_str(
                " La branche locale peut subsister. Actualisez le panneau, puis réessayez depuis cette branche.",
            );
        }
        return Err(error.with_path(&path));
    }
    lease.insert_project(project.clone()).map_err(|message| {
        GitError::new(
            "registrationFailed",
            format!("Le worktree a été créé, mais son enregistrement a échoué : {message}"),
        )
        .with_path(&path)
    })?;
    Ok(project)
}

struct WorktreeRemoval<'a> {
    lease: GitOperationLease<'a>,
    rooted: AgentProject,
    primary: Option<AgentProjectWorktree>,
    target: AgentProjectWorktree,
    stopped: StoppedProjects,
}

fn prepare_worktree_removal<'a>(
    sessions: &'a AgentSessions,
    source_project_id: &str,
    path: &str,
    expected_head: &str,
    expected_branch: Option<&str>,
) -> Result<WorktreeRemoval<'a>, GitError> {
    validate_oid(expected_head)?;
    if let Some(branch) = expected_branch {
        validate_ref_name(branch)?;
    }
    let lease = sessions
        .begin_git_operation(source_project_id)
        .map_err(|message| GitError::new("busy", message))?;
    require_idle()?;
    validate_project_directory(&lease.project.environment, path)
        .map_err(|message| GitError::new("invalidProject", message))?;
    let source_identity = repository_identity(&lease.project)
        .map_err(|_| {
            GitError::new(
                "unavailable",
                "Impossible de vérifier le dépôt du projet source.",
            )
        })?
        .ok_or_else(|| GitError::new("unavailable", "Le projet source n’est plus un dépôt Git."))?;
    let layout = worktree_layout(&lease.project)?;
    let source_common_dir = source_identity.1.clone();
    // Only projects of the source repository can own the target worktree; probing the
    // others (possibly over SSH or WSL) would only slow the confirmation down.
    let snapshot = sessions
        .worktree_groups_with(
            |project| {
                if project.id == lease.project.id {
                    return Ok(Some(source_identity.clone()));
                }
                if !same_agent_environment(&project.environment, &lease.project.environment) {
                    return Ok(None);
                }
                match repository_identity(project) {
                    Ok(Some(identity)) if identity.1 == source_common_dir => Ok(Some(identity)),
                    Ok(_) => Ok(None),
                    Err(())
                        if plausible_worktree_alias(
                            &lease.project.environment,
                            &project.path,
                            &layout,
                        ) =>
                    {
                        Err(WorktreeDiscoveryFailure::Unknown)
                    }
                    Err(()) => Ok(None),
                }
            },
            |project| super::discover_worktrees(project).map_err(|_| ()),
        )
        .map_err(|message| GitError::new("project", message))?;
    if !snapshot.complete {
        return Err(GitError::new(
            "worktreeAssociationUnknown",
            "Impossible de vérifier complètement les projets associés à ce dépôt.",
        ));
    }
    let group = snapshot
        .groups
        .into_iter()
        .find(|group| {
            group.repository_project_id == source_project_id
                || group.project_ids.iter().any(|id| id == source_project_id)
                || group.worktrees.iter().any(|worktree| {
                    same_worktree_path(&lease.project.environment, &worktree.path, path)
                })
        })
        .ok_or_else(|| {
            GitError::new(
                "stale",
                "Ce dépôt n’est plus associé au projet. Actualisez la liste.",
            )
        })?;
    let primary = layout.primary.as_ref().and_then(|listed| {
        group
            .worktrees
            .iter()
            .find(|worktree| {
                same_worktree_path(&lease.project.environment, &worktree.path, &listed.path)
            })
            .cloned()
    });
    if layout.primary.is_some() && primary.is_none() {
        return Err(GitError::new(
            "malformed",
            "Git n’a pas permis d’identifier le worktree principal.",
        ));
    }
    if primary
        .as_ref()
        .is_some_and(|primary| same_worktree_path(&lease.project.environment, &primary.path, path))
    {
        return Err(GitError::new(
            "primaryWorktree",
            "Le worktree principal ne peut pas être supprimé depuis Soreno.",
        ));
    }
    let target = group
        .worktrees
        .into_iter()
        .find(|worktree| same_worktree_path(&lease.project.environment, &worktree.path, path))
        .ok_or_else(|| GitError::new("stale", "Ce worktree n’existe plus. Actualisez la liste."))?;
    if target.head != expected_head || target.branch.as_deref() != expected_branch {
        return Err(GitError::new(
            "stale",
            "Le worktree a changé. Actualisez la liste avant de le supprimer.",
        ));
    }
    let rooted = AgentProject {
        path: layout.root_path,
        ..lease.project.clone()
    };
    // Stopping afterwards could fail once the folder is gone, leaving an orphan project.
    let stopped = lease
        .stop_project_sessions(&target.project_ids)
        .map_err(|message| {
            let code = if message == HAS_AUTOMATION {
                "sessionHasAutomation"
            } else {
                "worktreeSessionsRunning"
            };
            GitError::new(code, format!("Le worktree n’a pas été modifié : {message}"))
        })?;
    Ok(WorktreeRemoval {
        lease,
        rooted,
        primary,
        target,
        stopped,
    })
}

fn finish_worktree_removal(
    removal: WorktreeRemoval<'_>,
    path: &str,
    expected_branch_oid: &str,
    merged_into: Option<&str>,
    message: &str,
) -> Result<GitMutationResult, GitError> {
    let WorktreeRemoval {
        lease,
        rooted,
        target,
        stopped,
        ..
    } = removal;
    execute(
        &rooted,
        &["worktree", "remove", "--", &target.path],
        GitOperation::LocalMutation,
        None,
    )?;
    let warning = target.branch.as_deref().and_then(|branch| {
        delete_worktree_branch(&rooted, branch, expected_branch_oid, merged_into)
    });
    let end = merged_into.map_or(SessionEnd::Worktree, SessionEnd::Merged);
    lease.delete_projects(stopped, end).map_err(|message| {
        GitError::new(
            "registrationFailed",
            format!("Le worktree a été supprimé, mais son retrait de Soreno a échoué : {message}"),
        )
        .with_path(path)
    })?;
    Ok(GitMutationResult {
        oid: None,
        message: message.into(),
        warning,
    })
}

fn delete_worktree_branch(
    project: &AgentProject,
    branch: &str,
    expected_oid: &str,
    merged_into: Option<&str>,
) -> Option<String> {
    let reference = format!("refs/heads/{branch}");
    let refs = match list_rooted(project) {
        Ok(refs) => refs,
        Err(_) => {
            return Some(branch_retained_warning(
                branch,
                "son état n’a pas pu être vérifié.",
            ));
        }
    };
    let Some(entry) = refs.iter().find(|entry| entry.reference == reference) else {
        return Some(format!(
            "Le worktree a été supprimé, mais la branche « {branch} » n’existe plus ; Soreno n’a supprimé aucune référence."
        ));
    };
    if entry.symbolic {
        return Some(branch_retained_warning(
            branch,
            "la référence est devenue symbolique.",
        ));
    }
    if entry.branch.oid != expected_oid {
        return Some(branch_retained_warning(
            branch,
            &format!(
                "la référence a changé (OID attendu {expected_oid}, OID actuel {}).",
                entry.branch.oid
            ),
        ));
    }
    match worktree_layout(project) {
        Ok(layout)
            if layout
                .worktrees
                .iter()
                .any(|worktree| worktree.branch.as_deref() == Some(branch)) =>
        {
            return Some(branch_retained_warning(
                branch,
                "elle est utilisée par un autre worktree.",
            ));
        }
        Ok(_) => {}
        Err(_) => {
            return Some(branch_retained_warning(
                branch,
                "ses autres checkouts n’ont pas pu être vérifiés.",
            ));
        }
    }
    if let Some(base) = merged_into {
        let integrated = reference_oid(project, &format!("refs/heads/{base}"))
            .and_then(|base_oid| is_ancestor(project, expected_oid, &base_oid));
        match integrated {
            Ok(true) => {}
            Ok(false) => {
                return Some(branch_retained_warning(
                    branch,
                    &format!("elle n’est pas intégrée dans « {base} »."),
                ));
            }
            Err(_) => {
                return Some(branch_retained_warning(
                    branch,
                    &format!("son intégration dans « {base} » n’a pas pu être vérifiée."),
                ));
            }
        }
    }
    execute(
        project,
        &["update-ref", "--no-deref", "-d", &reference, expected_oid],
        GitOperation::LocalMutation,
        None,
    )
    .err()
    .map(|_| {
        branch_retained_warning(
            branch,
            "la suppression conditionnelle a été refusée ; la référence a changé, disparu ou est devenue symbolique.",
        )
    })
}

fn branch_retained_warning(branch: &str, reason: &str) -> String {
    format!("Le worktree a été supprimé, mais la branche « {branch} » subsiste : {reason}")
}

pub(crate) fn remove_worktree(
    sessions: &AgentSessions,
    source_project_id: &str,
    path: String,
    expected_head: String,
    expected_branch: Option<String>,
) -> Result<GitMutationResult, GitError> {
    let removal = prepare_worktree_removal(
        sessions,
        source_project_id,
        &path,
        &expected_head,
        expected_branch.as_deref(),
    )?;
    finish_worktree_removal(removal, &path, &expected_head, None, "Worktree supprimé.")
}

pub(crate) fn merge_worktree(
    sessions: &AgentSessions,
    source_project_id: &str,
    path: String,
    expected_head: String,
    expected_branch: String,
    expected_base: String,
) -> Result<GitMutationResult, GitError> {
    validate_ref_name(&expected_base)?;
    let removal = prepare_worktree_removal(
        sessions,
        source_project_id,
        &path,
        &expected_head,
        Some(&expected_branch),
    )?;
    let base = expected_base;
    let primary = removal.primary.as_ref().ok_or_else(|| {
        GitError::new(
            "missingPrimaryWorktree",
            "Ce dépôt bare n’a pas de worktree principal dans lequel fusionner.",
        )
    })?;
    if primary.branch.as_deref() != Some(base.as_str()) {
        return Err(GitError::new(
            "stale",
            format!("Le worktree principal n’est plus sur « {base} ». Actualisez la liste avant de fusionner."),
        ));
    }
    let target_project = AgentProject {
        path: removal.target.path.clone(),
        ..removal.rooted.clone()
    };
    let target_state = repository(&target_project)?;
    if target_state.operation.as_deref() == Some("merge") {
        let conflicts = target_state
            .files
            .iter()
            .filter(|file| file.conflict)
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        let unresolved = !conflicts.is_empty()
            || target_state.truncated
                && !execute(
                    &target_project,
                    &["ls-files", "--unmerged", "-z"],
                    GitOperation::Read,
                    None,
                )?
                .stdout
                .is_empty();
        if unresolved {
            let location = if conflicts.is_empty() {
                format!("« {expected_branch} »")
            } else {
                format!("« {expected_branch} » : {}", conflicts.join(", "))
            };
            return Err(GitError::new(
                "mergeConflict",
                format!(
                    "Conflits non résolus dans {location}. La fusion de « {base} » reste en cours dans ce worktree : résolvez les conflits dans Changes, commitez la fusion, puis relancez « Fusionner dans {base} »."
                ),
            ));
        }
        return Err(GitError::new(
            "sourceMergePending",
            format!("Une fusion reste en cours dans le worktree « {expected_branch} » : commitez-la dans Changes, puis relancez « Fusionner dans {base} »."),
        ));
    }
    require_idle_snapshot(target_state.operation.as_deref())?;
    if !target_state.files.is_empty() {
        return Err(GitError::new(
            "worktreeDirty",
            "Commitez ou annulez les changements du worktree avant de le fusionner.",
        ));
    }
    if target_state.head.as_deref() != Some(expected_head.as_str())
        || target_state.branch.as_deref() != Some(expected_branch.as_str())
    {
        return Err(GitError::new(
            "stale",
            "Le worktree a changé. Actualisez la liste avant de fusionner.",
        ));
    }
    let base_head = primary.head.clone();
    require_primary_ready(&removal.rooted, &base, &base_head)?;
    let merged =
        base_head == expected_head || is_ancestor(&removal.rooted, &expected_head, &base_head)?;
    let mut branch_oid = expected_head.clone();
    if !merged {
        let linear = is_first_parent_ancestor(&removal.rooted, &base_head, &expected_head)?;
        let base_merge_options = merge_options_override(&removal.rooted, &base)?;
        let merge_head = if linear || is_ancestor(&removal.rooted, &base_head, &expected_head)? {
            expected_head.clone()
        } else {
            let source_merge_options = merge_options_override(&target_project, &expected_branch)?;
            let merge_head = merge_base_into_worktree(
                &target_project,
                &base,
                &base_head,
                &expected_branch,
                source_merge_options.as_deref(),
            )?;
            branch_oid = merge_head.clone();
            merge_head
        };
        require_primary_ready(&removal.rooted, &base, &base_head)?;
        if linear {
            merge_primary(
                &removal.rooted,
                base_merge_options.as_deref(),
                &[
                    "--ff-only",
                    "--commit",
                    "--no-squash",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "--no-edit",
                    &merge_head,
                ],
            )?;
            verify_primary_integration(&removal.rooted, &base, &merge_head, None)?;
        } else {
            let message = format!("Merge branch '{expected_branch}' into {base}");
            merge_primary(
                &removal.rooted,
                base_merge_options.as_deref(),
                &[
                    "--no-ff",
                    "--commit",
                    "--no-squash",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "-m",
                    &message,
                    &merge_head,
                ],
            )?;
            let integrated_head = head_oid(&removal.rooted)?;
            verify_primary_integration(
                &removal.rooted,
                &base,
                &integrated_head,
                Some((&base_head, &merge_head)),
            )?;
        }
    } else {
        require_primary_ready(&removal.rooted, &base, &base_head)?;
    }
    finish_worktree_removal(
        removal,
        &path,
        &branch_oid,
        Some(&base),
        "Worktree fusionné et supprimé.",
    )
    .map_err(|mut error| {
            if !merged && error.code != "registrationFailed" {
                error.message = format!(
                    "« {expected_branch} » a été fusionnée dans « {base} », mais le worktree n’a pas été supprimé : {}",
                    error.message
                );
            }
            error
        })
}

fn repository_identity(project: &AgentProject) -> Result<Option<(String, String)>, ()> {
    let repository = super::discover_repository(project).map_err(|_| ())?;
    if repository.availability != "ready" && repository.availability != "bare" {
        return Ok(None);
    }
    repository
        .identity
        .map(|identity| Some((identity.root, identity.common_dir)))
        .ok_or(())
}

fn reference_oid(project: &AgentProject, reference: &str) -> Result<String, GitError> {
    let output = execute(
        project,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
        GitOperation::Read,
        None,
    )?;
    oid_output(&output.stdout, "référence Git")
}

fn commit_parents(project: &AgentProject, commit: &str) -> Result<Vec<String>, GitError> {
    let output = execute(
        project,
        &["show", "--no-show-signature", "-s", "--format=%P", commit],
        GitOperation::Read,
        None,
    )?;
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| GitError::new("malformed", "Parents Git non UTF-8."))?;
    text.split_whitespace()
        .map(|oid| {
            validate_oid(oid)?;
            Ok(oid.to_owned())
        })
        .collect()
}

pub(super) fn is_ancestor(
    project: &AgentProject,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, GitError> {
    match execute(
        project,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        GitOperation::Read,
        None,
    ) {
        Ok(_) => Ok(true),
        Err(error) if error.code == "failed" => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn create_branch(
    sessions: &AgentSessions,
    project_id: &str,
    name: String,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_ref_name(&name)?;
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_idle_snapshot(snapshot.operation.as_deref())?;
        let oid = snapshot
            .head
            .clone()
            .ok_or_else(|| GitError::new("unborn", "Créez un premier commit avant une branche."))?;
        if list_rooted(project)?
            .iter()
            .any(|entry| entry.reference == format!("refs/heads/{name}"))
        {
            return Err(GitError::new(
                "branchExists",
                "Cette branche locale existe déjà.",
            ));
        }
        execute(
            project,
            &["branch", &name, "HEAD"],
            GitOperation::LocalMutation,
            None,
        )?;
        Ok(result("Branche créée.", Some(oid)))
    })
}

pub(crate) fn remove_branch(
    sessions: &AgentSessions,
    project_id: &str,
    name: String,
    expected_oid: &str,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_ref_name(&name)?;
    validate_oid(expected_oid)?;
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_idle_snapshot(snapshot.operation.as_deref())?;
        let reference = format!("refs/heads/{name}");
        let branch = list_rooted(project)?
            .into_iter()
            .find(|entry| entry.reference == reference && !entry.symbolic)
            .ok_or_else(|| {
                GitError::new(
                    "missingBranch",
                    "Cette branche locale n’existe plus. Actualisez la liste.",
                )
            })?;
        if branch.branch.current {
            return Err(GitError::new(
                "currentBranch",
                "La branche courante ne peut pas être supprimée.",
            ));
        }
        if branch.branch.oid != expected_oid {
            return Err(GitError::new(
                "stale",
                "La branche a changé. Actualisez la liste avant de la supprimer.",
            ));
        }
        if let Err(error) = execute(
            project,
            &["branch", "-d", "--", &name],
            GitOperation::LocalMutation,
            None,
        ) {
            // Git refuses before touching the ref; the read-back proves nothing changed.
            let refused_unmerged = error.code == "failed"
                && error.message.contains("not fully merged")
                && list_rooted(project).is_ok_and(|refs| {
                    refs.iter().any(|entry| {
                        entry.reference == reference && entry.branch.oid == expected_oid
                    })
                });
            return Err(if refused_unmerged {
                GitError::new(
                    "notMerged",
                    "Git refuse de supprimer une branche dont les commits ne sont pas fusionnés.",
                )
            } else {
                error
            });
        }
        Ok(result("Branche supprimée.", None))
    })
}

pub(crate) fn switch_branch(
    sessions: &AgentSessions,
    project_id: &str,
    name: String,
    remote: bool,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_ref_name(&name)?;
    mutations::with_branch_switch_mutation(
        sessions,
        project_id,
        version,
        move |project, snapshot| {
            require_idle_snapshot(snapshot.operation.as_deref())?;
            if !snapshot.files.is_empty() {
                return Err(GitError::new(
                "dirty",
                "La copie de travail et l’index doivent être propres avant de changer de branche.",
            ));
            }
            if remote {
                let refs = list_rooted(project)?;
                let reference = format!("refs/remotes/{name}");
                if !refs
                    .iter()
                    .any(|entry| entry.reference == reference && !entry.symbolic)
                {
                    return Err(GitError::new(
                        "missingBranch",
                        "Cette branche distante n’existe plus.",
                    ));
                }
                let local = tracking_local_name(&name)?;
                if refs
                    .iter()
                    .any(|entry| entry.reference == format!("refs/heads/{local}"))
                {
                    return Err(GitError::new(
                        "branchExists",
                        "La branche locale de suivi existe déjà.",
                    ));
                }
                execute(
                    project,
                    &[
                        "switch",
                        "--no-overwrite-ignore",
                        "--track",
                        "-c",
                        local,
                        &reference,
                    ],
                    GitOperation::LocalMutation,
                    None,
                )?;
            } else {
                // Git valide la référence et refuse nativement une branche déjà utilisée
                // par une autre worktree, sans lecture préparatoire redondante.
                execute(
                    project,
                    &["switch", "--no-overwrite-ignore", "--no-guess", &name],
                    GitOperation::LocalMutation,
                    None,
                )?;
            }
            Ok(result("Branche active changée.", None))
        },
    )
}

fn is_symbolic_ref(project: &AgentProject, reference: &str) -> Result<bool, GitError> {
    match execute(
        project,
        &["symbolic-ref", "--quiet", reference],
        GitOperation::Read,
        None,
    ) {
        Ok(_) => Ok(true),
        Err(error) if error.code == "failed" => Ok(false),
        Err(error) => Err(error),
    }
}

fn tracking_local_name(remote_branch: &str) -> Result<&str, GitError> {
    let local = remote_branch
        .split_once('/')
        .map(|(_, local)| local)
        .filter(|local| !local.is_empty())
        .ok_or_else(|| GitError::new("invalidRef", "Branche distante invalide."))?;
    validate_ref_name(local)?;
    Ok(local)
}

fn list_rooted(project: &AgentProject) -> Result<Vec<BranchRef>, GitError> {
    let output = execute(
        project,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
        GitOperation::Read,
        None,
    )?;
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| GitError::new("malformed", "Liste de branches non UTF-8."))?;
    let mut result = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(GitError::new(
                "malformed",
                "Git a retourné une liste de branches invalide.",
            ));
        }
        let (name, remote) = if let Some(name) = fields[0].strip_prefix("refs/heads/") {
            (name, false)
        } else if let Some(name) = fields[0].strip_prefix("refs/remotes/") {
            (name, true)
        } else {
            return Err(GitError::new("malformed", "Référence de branche invalide."));
        };
        validate_ref_name(name)?;
        let symbolic = !fields[4].is_empty();
        if remote && symbolic {
            continue;
        }
        validate_oid(fields[1])?;
        let upstream = (!fields[2].is_empty()).then(|| fields[2].to_owned());
        if let Some(upstream) = &upstream {
            validate_ref_name(upstream)?;
        }
        result.push(BranchRef {
            branch: GitBranch {
                name: name.into(),
                oid: fields[1].into(),
                remote,
                current: !remote && fields[3] == "*",
                upstream,
            },
            reference: fields[0].into(),
            symbolic,
        });
    }
    Ok(result)
}

fn require_idle_snapshot(operation: Option<&str>) -> Result<(), GitError> {
    if operation.is_some() {
        return Err(GitError::new(
            "operation",
            "Terminez ou annulez l’opération Git en cours avant de changer les branches.",
        ));
    }
    Ok(())
}

fn result(message: &str, oid: Option<String>) -> GitMutationResult {
    GitMutationResult {
        oid,
        message: message.into(),
        warning: None,
    }
}

#[path = "branches/worktree_layout.rs"]
mod worktree_layout;
#[cfg(test)]
use worktree_layout::{parse_worktree_layout, parse_worktrees, require_worktree_list_version};
use worktree_layout::{plausible_worktree_alias, worktree_layout};
#[path = "branches/merge.rs"]
mod merge;
use merge::{
    head_oid, is_first_parent_ancestor, merge_base_into_worktree, merge_options_override,
    merge_primary, require_primary_ready, verify_primary_integration,
};

#[cfg(test)]
#[path = "branches_tests.rs"]
mod tests;
