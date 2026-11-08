use super::{
    execute, mutations, repository_state as repository, validate_oid, GitError, GitFile,
    GitMutationResult, GitOperation, GitRepository,
};
use crate::agent_sessions::{AgentProject, AgentSessions};
use chrono::{SecondsFormat, Utc};
use std::collections::HashSet;

pub(crate) fn restore(
    sessions: &AgentSessions,
    project_id: &str,
    paths: Vec<String>,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    mutations::with_mutation(sessions, project_id, version, move |project, snapshot| {
        require_idle_snapshot(snapshot)?;
        if snapshot.head.is_none() {
            return Err(GitError::new(
                "unborn",
                "Créez un premier commit avant de restaurer des fichiers.",
            ));
        }
        for path in &paths {
            let file = snapshot.files.iter().find(|file| file.path == *path);
            if file.is_some_and(|file| file.conflict || file.submodule) {
                return Err(GitError::new(
                    "unsupportedPath",
                    format!("Ce chemin en conflit ou gitlink ne peut pas être restauré : {path}"),
                ));
            }
        }
        let input = mutations::selected_paths(snapshot, &paths, mutations::ChangeSide::Unstaged)?;
        let selected = mutations::decoded_paths(&input)
            .map(|path| path.map(str::to_owned))
            .collect::<Result<HashSet<_>, _>>()?;
        ensure_no_pathspec_collision(snapshot, &selected)?;
        let before_index = index_state(project)?;
        let before_rest = files_except(snapshot, &selected);
        let before_stashes = list_backup_oids(project)?;
        let message = format!(
            "Soreno · restauration · {}",
            Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
        );
        let stash_error = execute(
            project,
            &[
                "--literal-pathspecs",
                "stash",
                "push",
                "--keep-index",
                "--include-untracked",
                "--message",
                &message,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            GitOperation::LocalMutation,
            Some(&input),
        )
        .err();
        let backup_oid = match created_stash(project, &before_stashes) {
            Ok(Some(oid)) => oid,
            Ok(None) => {
                return Err(stash_error.unwrap_or_else(|| {
                    GitError::new(
                        "failed",
                        "Git n’a pas créé la sauvegarde de restauration attendue.",
                    )
                }));
            }
            Err(error) => return Err(stash_error.unwrap_or(error)),
        };
        let after_index = index_state(project).map_err(|error| backup_error(error, &backup_oid))?;
        if after_index != before_index {
            return Err(invariant_error(
                &backup_oid,
                "L’index Git a changé pendant la restauration.",
            ));
        }
        let after = repository(project).map_err(|error| backup_error(error, &backup_oid))?;
        if files_except(&after, &selected) != before_rest {
            return Err(invariant_error(
                &backup_oid,
                "Des fichiers non sélectionnés ont changé pendant la restauration.",
            ));
        }
        if after
            .files
            .iter()
            .filter(|file| file_selected(file, &selected))
            .any(|file| file.worktree_status != "." || file.index_status == "?")
        {
            return Err(invariant_error(
                &backup_oid,
                "Les changements sélectionnés n’ont pas tous été restaurés.",
            ));
        }
        Ok(GitMutationResult {
                message: "Fichiers restaurés avec une sauvegarde Git.".into(),
                oid: Some(backup_oid),
                warning: Some(
                    "La sauvegarde de restauration peut aussi inclure des changements préparés dans l’index."
                        .into(),
                ),
            })
    })
}

fn list_backup_oids(project: &AgentProject) -> Result<Vec<String>, GitError> {
    // La classe empêche Git d’ajouter `/*` à un glob sans métacaractère.
    let output = execute(
        project,
        &[
            "log",
            "--no-show-signature",
            "-g",
            "--format=%H",
            "--glob=refs/stas[h]",
        ],
        GitOperation::Read,
        None,
    )?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| GitError::new("malformed", "Liste de sauvegardes non UTF-8."))?;
    text.lines()
        .map(|oid| {
            validate_oid(oid)?;
            Ok(oid.to_owned())
        })
        .collect()
}

fn require_idle_snapshot(snapshot: &GitRepository) -> Result<(), GitError> {
    if snapshot.operation.is_some() {
        return Err(GitError::new(
            "operation",
            "Terminez ou annulez l’opération Git en cours avant cette mutation.",
        ));
    }
    Ok(())
}

fn index_state(project: &AgentProject) -> Result<Vec<u8>, GitError> {
    Ok(execute(
        project,
        &["ls-files", "--stage", "-z"],
        GitOperation::Read,
        None,
    )?
    .stdout)
}

fn file_selected(file: &GitFile, selected: &HashSet<String>) -> bool {
    selected.contains(&file.path)
        || file
            .old_path
            .as_ref()
            .is_some_and(|path| selected.contains(path))
}

fn ensure_no_pathspec_collision(
    repository: &GitRepository,
    selected: &HashSet<String>,
) -> Result<(), GitError> {
    for path in selected {
        let prefix = format!("{path}/");
        if repository.files.iter().any(|file| {
            !file_selected(file, selected)
                && (file.path.starts_with(&prefix)
                    || file
                        .old_path
                        .as_ref()
                        .is_some_and(|old_path| old_path.starts_with(&prefix)))
        }) {
            return Err(GitError::new(
                "pathCollision",
                format!(
                    "Le chemin sélectionné est devenu un dossier contenant des changements non sélectionnés : {path}"
                ),
            ));
        }
    }
    Ok(())
}

fn files_except(repository: &GitRepository, selected: &HashSet<String>) -> Vec<GitFile> {
    let mut files = repository
        .files
        .iter()
        .filter(|file| !file_selected(file, selected))
        .cloned()
        .collect::<Vec<_>>();
    files.sort_by(|left, right| (&left.path, &left.old_path).cmp(&(&right.path, &right.old_path)));
    files
}

fn created_stash(project: &AgentProject, before: &[String]) -> Result<Option<String>, GitError> {
    let after = list_backup_oids(project)?;
    let top = after.first().cloned();
    Ok(
        (after.len() > before.len() || top.as_ref() != before.first())
            .then_some(top)
            .flatten(),
    )
}

fn backup_error(mut error: GitError, oid: &str) -> GitError {
    error
        .message
        .push_str(&format!("\nSauvegarde Git conservée : {oid}."));
    error
}

fn invariant_error(oid: &str, message: &str) -> GitError {
    backup_error(GitError::new("invariant", message), oid)
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod tests;
