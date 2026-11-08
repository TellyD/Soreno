use super::{
    execute, oid_output, repository_state as repository, validate_oid, validate_relative_path,
    GitError, GitMutationResult, GitOperation, GitRepository,
};
use crate::agent_sessions::{AgentProject, AgentSessions};

const PATH_LIMIT: usize = 10_000;
const MESSAGE_LIMIT: usize = 64 * 1024;

pub(crate) fn with_mutation<T>(
    sessions: &AgentSessions,
    project_id: &str,
    version: &str,
    mutation: impl FnOnce(&AgentProject, &GitRepository) -> Result<T, GitError>,
) -> Result<T, GitError> {
    with_mutation_state(sessions, project_id, version, repository, mutation)
}

pub(crate) fn with_branch_switch_mutation<T>(
    sessions: &AgentSessions,
    project_id: &str,
    version: &str,
    mutation: impl FnOnce(&AgentProject, &GitRepository) -> Result<T, GitError>,
) -> Result<T, GitError> {
    #[cfg(windows)]
    {
        let project = sessions
            .project(project_id)
            .map_err(|error| GitError::new("busy", error.to_string()))?;
        with_mutation_state(
            sessions,
            project_id,
            version,
            |target| {
                super::wsl_read::with_foreground_transport(&project, || {
                    super::reading::branch_switch_state(target, version)
                })
            },
            |rooted, snapshot| {
                super::wsl_read::with_foreground_transport(&project, || mutation(rooted, snapshot))
            },
        )
    }
    #[cfg(not(windows))]
    {
        with_mutation_state(
            sessions,
            project_id,
            version,
            |project| super::reading::branch_switch_state(project, version),
            mutation,
        )
    }
}

fn with_mutation_state<T>(
    sessions: &AgentSessions,
    project_id: &str,
    version: &str,
    read_state: impl FnOnce(&AgentProject) -> Result<GitRepository, GitError>,
    mutation: impl FnOnce(&AgentProject, &GitRepository) -> Result<T, GitError>,
) -> Result<T, GitError> {
    let lease = sessions
        .begin_git_operation(project_id)
        .map_err(|message| GitError::new("busy", message))?;
    super::require_idle()?;
    validate_oid(version)?;
    let snapshot = read_state(&lease.project)?;
    if snapshot.availability != "ready" {
        return Err(GitError::new(
            if snapshot.availability == "notRepository" {
                "notRepo"
            } else {
                "unavailable"
            },
            "Cette opération exige un dépôt Git avec une copie de travail.",
        ));
    }
    if snapshot.limited {
        return Err(GitError::new(
            "limited",
            "Le dépôt contient trop de changements pour une mutation sûre.",
        ));
    }
    if snapshot.version != version {
        return Err(GitError::new(
            "stale",
            "L’état Git a changé. Actualisez le panneau avant de réessayer.",
        ));
    }
    if snapshot
        .operation
        .as_deref()
        .is_some_and(|operation| operation != "merge")
    {
        return Err(GitError::new(
            "operation",
            "Terminez ou annulez l’opération Git en cours avant cette mutation.",
        ));
    }
    let identity = snapshot
        .identity
        .as_ref()
        .ok_or_else(|| GitError::new("malformed", "Identité du dépôt Git absente."))?;
    let rooted = AgentProject {
        path: identity.root.clone(),
        ..lease.project.clone()
    };
    // ponytail: this optimistic token is not a transaction against external Git tools;
    // keep the lease local and require a fresh snapshot after every mutation.
    mutation(&rooted, &snapshot)
}

pub(crate) fn stage(
    sessions: &AgentSessions,
    project_id: &str,
    paths: Vec<String>,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    with_mutation(sessions, project_id, version, move |project, snapshot| {
        if paths.iter().any(|path| {
            snapshot
                .files
                .iter()
                .any(|file| file.path == *path && file.conflict)
        }) {
            return Err(GitError::new(
                "conflict",
                "Confirmez la résolution avant de préparer un fichier en conflit.",
            ));
        }
        stage_paths(project, snapshot, &paths)?;
        Ok(result("Fichiers préparés.", None, None))
    })
}

pub(crate) fn resolve(
    sessions: &AgentSessions,
    project_id: &str,
    paths: Vec<String>,
    version: &str,
    allow_markers: bool,
) -> Result<GitMutationResult, GitError> {
    with_mutation(sessions, project_id, version, move |project, snapshot| {
        for path in &paths {
            validate_relative_path(path)?;
            let file = snapshot
                .files
                .iter()
                .find(|file| file.path == *path)
                .filter(|file| file.actionable && file.conflict && !file.submodule)
                .ok_or_else(|| {
                    GitError::new(
                        "stalePath",
                        format!("Ce chemin n’est plus un conflit résoluble : {path}"),
                    )
                })?;
            if !allow_markers {
                let preview = super::comparison(project, &file.path, super::GitSide::Unstaged)?;
                if preview
                    .after
                    .text
                    .as_deref()
                    .is_some_and(has_conflict_markers)
                {
                    return Err(GitError::new(
                        "markers",
                        format!("Des marqueurs de conflit subsistent dans : {path}"),
                    ));
                }
            }
        }
        stage_paths(project, snapshot, &paths)?;
        Ok(result("Conflits marqués comme résolus.", None, None))
    })
}

fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with("<<<<<<<") || line.starts_with("=======") || line.starts_with(">>>>>>>")
    })
}

fn stage_paths(
    project: &AgentProject,
    snapshot: &GitRepository,
    paths: &[String],
) -> Result<(), GitError> {
    let input = selected_paths(snapshot, paths, ChangeSide::Unstaged)?;
    ensure_no_pathspec_collision(project, snapshot, &input)?;
    execute(
        project,
        &[
            "--literal-pathspecs",
            "add",
            "-A",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        GitOperation::LocalMutation,
        Some(&input),
    )?;
    Ok(())
}

pub(crate) fn unstage(
    sessions: &AgentSessions,
    project_id: &str,
    paths: Vec<String>,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    with_mutation(sessions, project_id, version, move |project, snapshot| {
        let input = selected_paths(snapshot, &paths, ChangeSide::Staged)?;
        ensure_no_pathspec_collision(project, snapshot, &input)?;
        let args = if snapshot.head.is_some() {
            [
                "--literal-pathspecs",
                "restore",
                "--staged",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .as_slice()
        } else {
            [
                "--literal-pathspecs",
                "rm",
                "--cached",
                "-f",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .as_slice()
        };
        execute(project, args, GitOperation::LocalMutation, Some(&input))?;
        Ok(result("Fichiers retirés de la préparation.", None, None))
    })
}

pub(crate) fn commit(
    sessions: &AgentSessions,
    project_id: &str,
    message: String,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    if message.trim().is_empty() || message.len() > MESSAGE_LIMIT || message.contains('\0') {
        return Err(GitError::new(
            "invalidMessage",
            "Le message de commit doit contenir entre 1 octet et 64 Kio, sans caractère nul.",
        ));
    }
    with_mutation(sessions, project_id, version, move |project, snapshot| {
        if snapshot.branch.is_none() {
            return Err(GitError::new(
                "detached",
                "Un commit depuis un HEAD détaché n’est pas autorisé.",
            ));
        }
        if snapshot.files.iter().any(|file| file.conflict) {
            return Err(GitError::new(
                "conflict",
                "Résolvez tous les conflits avant de créer le commit.",
            ));
        }
        if snapshot.head.is_none()
            && !snapshot
                .files
                .iter()
                .any(|file| file.index_status != "." && file.index_status != "?")
        {
            return Err(GitError::new(
                "empty",
                "Aucun changement préparé à committer.",
            ));
        }
        require_identity(project)?;
        let preview_tree = oid_output(
            &execute(project, &["write-tree"], GitOperation::LocalMutation, None)?.stdout,
            "OID arbre d’index",
        )?;
        if snapshot.operation.as_deref() != Some("merge")
            && snapshot.head.is_some()
            && read_oid(project, &["rev-parse", "HEAD^{tree}"])? == preview_tree
        {
            return Err(GitError::new(
                "empty",
                "Aucun changement préparé à committer.",
            ));
        }
        let previous_head = snapshot.head.clone();
        if let Err(mut error) = execute(
            project,
            &["commit", "-F", "-"],
            GitOperation::LocalMutation,
            Some(message.as_bytes()),
        ) {
            if error.code == "timeout" {
                error.message = match read_optional_oid(project, "HEAD") {
                    Ok(head) if head != previous_head => "Le commit a expiré mais HEAD a changé. Examinez le nouveau commit avant toute nouvelle tentative.".into(),
                    _ => "Le commit a expiré et son résultat est incertain. Vérifiez HEAD avant toute nouvelle tentative.".into(),
                };
                error.uncertain = Some(true);
            }
            return Err(error);
        }
        let (oid, committed_tree) = read_commit_oids(project)?;
        let warning = (committed_tree != preview_tree).then(|| {
            "Un hook a modifié l’arbre préparé pendant le commit ; vérifiez son contenu.".into()
        });
        Ok(result("Commit créé.", Some(oid), warning))
    })
}

pub(crate) fn quick_commit(
    sessions: &AgentSessions,
    project_id: &str,
    paths: Vec<String>,
    version: &str,
    generate: impl FnOnce(&AgentProject, &str) -> Result<String, GitError>,
) -> Result<GitMutationResult, GitError> {
    let project = sessions
        .project(project_id)
        .map_err(|message| GitError::new("project", message))?;
    // Fail before staging so the identity dialog still matches the panel snapshot.
    require_identity(&project)?;
    let version = if paths.is_empty() {
        version.to_owned()
    } else {
        stage(sessions, project_id, paths, version)?;
        repository(&project)?.version
    };
    let message = generate(&project, &version)?;
    commit(sessions, project_id, message, &version)
}

pub(crate) fn set_identity(
    sessions: &AgentSessions,
    project_id: &str,
    name: String,
    email: String,
    global: bool,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    validate_identity_value(&name, "nom")?;
    validate_identity_value(&email, "adresse e-mail")?;
    // shortcut: an empty or invalid local user.* still masks a global write, so the dialog returns on the next commit; clear it here if this gets reported.
    let scope = if global { "--global" } else { "--local" };
    with_mutation(sessions, project_id, version, move |project, _| {
        execute(
            project,
            &["config", scope, "user.name", &name],
            GitOperation::LocalMutation,
            None,
        )?;
        execute(
            project,
            &["config", scope, "user.email", &email],
            GitOperation::LocalMutation,
            None,
        )?;
        Ok(result(
            if global {
                "Identité Git globale enregistrée."
            } else {
                "Identité Git locale enregistrée."
            },
            None,
            None,
        ))
    })
}

#[derive(Clone, Copy)]
pub(super) enum ChangeSide {
    Staged,
    Unstaged,
}

pub(super) fn selected_paths(
    repository: &GitRepository,
    requested: &[String],
    side: ChangeSide,
) -> Result<Vec<u8>, GitError> {
    if requested.is_empty() || requested.len() > PATH_LIMIT {
        return Err(GitError::new(
            "invalidPaths",
            "Sélectionnez entre 1 et 10 000 chemins Git.",
        ));
    }
    let mut selected = Vec::<&str>::new();
    for path in requested {
        validate_relative_path(path)?;
        let file = repository
            .files
            .iter()
            .find(|file| file.path == *path)
            .filter(|file| {
                file.actionable
                    && match side {
                        ChangeSide::Staged => file.index_status != "." && file.index_status != "?",
                        ChangeSide::Unstaged => {
                            file.worktree_status != "." || file.index_status == "?"
                        }
                    }
            })
            .ok_or_else(|| {
                GitError::new(
                    "stalePath",
                    format!("Le chemin n’est plus modifiable dans cet état Git : {path}"),
                )
            })?;
        let old_path = match side {
            ChangeSide::Staged if matches!(file.index_status.as_str(), "R" | "C") => {
                file.old_path.as_deref()
            }
            ChangeSide::Unstaged if matches!(file.worktree_status.as_str(), "R" | "C") => {
                file.old_path.as_deref()
            }
            _ => None,
        };
        for candidate in [Some(file.path.as_str()), old_path].into_iter().flatten() {
            validate_relative_path(candidate)?;
            if !selected.contains(&candidate) {
                selected.push(candidate);
            }
        }
    }
    let mut input = Vec::new();
    for path in selected {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    Ok(input)
}

pub(super) fn decoded_paths(input: &[u8]) -> impl Iterator<Item = Result<&str, GitError>> {
    input
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            std::str::from_utf8(path)
                .map_err(|_| GitError::new("invalidPath", "Chemin Git non Unicode."))
        })
}

fn ensure_no_pathspec_collision(
    project: &AgentProject,
    repository: &GitRepository,
    input: &[u8],
) -> Result<(), GitError> {
    let selected = decoded_paths(input).collect::<Result<Vec<_>, _>>()?;
    for path in selected {
        let prefix = format!("{path}/");
        let related_gitlink = repository.files.iter().any(|file| {
            file.submodule && (file.path == path || file.old_path.as_deref() == Some(path))
        });
        let has_descendant = repository.files.iter().any(|file| {
            let same_entry = file.path == path || file.old_path.as_deref() == Some(path);
            !same_entry
                && (file.path.starts_with(&prefix)
                    || file
                        .old_path
                        .as_ref()
                        .is_some_and(|old_path| old_path.starts_with(&prefix)))
        });
        let is_directory = if project.environment.kind == "local" {
            std::fs::symlink_metadata(std::path::Path::new(&project.path).join(path))
                .is_ok_and(|metadata| metadata.file_type().is_dir())
        } else if project.environment.kind == "ssh" {
            super::remote_path_is_directory(project, path)?
        } else {
            false
        };
        if !related_gitlink && (has_descendant || is_directory) {
            return Err(GitError::new(
                "pathCollision",
                format!(
                    "Le chemin sélectionné est devenu un dossier ; sélectionnez ses fichiers individuellement : {path}"
                ),
            ));
        }
    }
    Ok(())
}

fn validate_identity_value(value: &str, label: &str) -> Result<(), GitError> {
    if value.trim().is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(GitError::new(
            "invalidIdentity",
            format!("Le {label} Git est vide, trop long ou contient un caractère de contrôle."),
        ));
    }
    Ok(())
}

fn require_identity(project: &AgentProject) -> Result<(), GitError> {
    let output = execute(
        project,
        &["config", "--null", "--get-regexp", "^user\\.(name|email)$"],
        GitOperation::Read,
        None,
    )
    .map_err(|_| GitError::new("identity", "Configurez un nom et une adresse e-mail Git."))?;
    validate_identity_output(output.stdout)
}

fn validate_identity_output(output: Vec<u8>) -> Result<(), GitError> {
    let (mut name, mut email) = (None, None);
    for entry in output.split(|byte| *byte == 0) {
        let Some(separator) = entry.iter().position(|byte| *byte == b'\n') else {
            continue;
        };
        let (key, value) = (&entry[..separator], &entry[separator + 1..]);
        match key {
            b"user.name" => name = Some(value),
            b"user.email" => email = Some(value),
            _ => {}
        }
    }
    let [Some(name), Some(email)] = [name, email] else {
        return Err(GitError::new(
            "identity",
            "Configurez un nom et une adresse e-mail Git.",
        ));
    };
    let name = std::str::from_utf8(name)
        .map_err(|_| GitError::new("malformed", "Identité Git non UTF-8."))?;
    let email = std::str::from_utf8(email)
        .map_err(|_| GitError::new("malformed", "Identité Git non UTF-8."))?;
    if [name, email]
        .into_iter()
        .any(|value| value.trim().is_empty() || value.chars().any(char::is_control))
    {
        return Err(GitError::new(
            "identity",
            "Configurez un nom et une adresse e-mail Git valides.",
        ));
    }
    Ok(())
}

fn read_commit_oids(project: &AgentProject) -> Result<(String, String), GitError> {
    let output = execute(
        project,
        &["rev-parse", "HEAD", "HEAD^{tree}"],
        GitOperation::Read,
        None,
    )?
    .stdout;
    let output = String::from_utf8(output)
        .map_err(|_| GitError::new("malformed", "OID révision non UTF-8."))?;
    let mut values = output.split_whitespace();
    let (Some(oid), Some(tree), None) = (values.next(), values.next(), values.next()) else {
        return Err(GitError::new("invalidOid", "OID Git invalide."));
    };
    validate_oid(oid)?;
    validate_oid(tree)?;
    Ok((oid.into(), tree.into()))
}

fn read_oid(project: &AgentProject, args: &[&str]) -> Result<String, GitError> {
    oid_output(
        &execute(project, args, GitOperation::Read, None)?.stdout,
        "OID révision",
    )
}

fn read_optional_oid(project: &AgentProject, reference: &str) -> Result<Option<String>, GitError> {
    match execute(
        project,
        &["rev-parse", "--verify", "-q", reference],
        GitOperation::Read,
        None,
    ) {
        Ok(output) => oid_output(&output.stdout, "OID révision").map(Some),
        Err(error) if error.code == "failed" => Ok(None),
        Err(error) => Err(error),
    }
}

fn result(message: &str, oid: Option<String>, warning: Option<String>) -> GitMutationResult {
    GitMutationResult {
        oid,
        message: message.into(),
        warning,
    }
}

#[cfg(test)]
#[path = "mutations_tests.rs"]
mod tests;
