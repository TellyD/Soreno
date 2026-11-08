use super::{
    execute, remotes, repository_state as repository, require_idle, validate_oid, GitError,
    GitMutationResult, GitOperation,
};
use crate::agent_sessions::{
    picker_default_directory, validate_project, validate_project_directory, AgentEnvironment,
    AgentProject, AgentSessions,
};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCloneRequest {
    pub id: String,
    pub name: String,
    pub environment: AgentEnvironment,
    pub parent_path: String,
    pub folder_name: String,
    pub url: String,
}

pub(crate) fn init(
    sessions: &AgentSessions,
    project_id: &str,
    version: &str,
) -> Result<GitMutationResult, GitError> {
    let lease = sessions
        .begin_git_operation(project_id)
        .map_err(|message| GitError::new("busy", message))?;
    require_idle()?;
    validate_oid(version)?;
    let snapshot = repository(&lease.project)?;
    if snapshot.availability != "notRepository" {
        return Err(GitError::new(
            "repositoryExists",
            "Ce dossier appartient déjà à un dépôt Git ou constitue un dépôt bare.",
        ));
    }
    if snapshot.version != version {
        return Err(GitError::new(
            "stale",
            "L’état Git a changé. Actualisez le panneau avant de réessayer.",
        ));
    }
    execute(
        &lease.project,
        &["init", "--initial-branch=main"],
        GitOperation::LocalMutation,
        None,
    )?;
    Ok(GitMutationResult {
        oid: None,
        message: "Dépôt Git initialisé.".into(),
        warning: None,
    })
}

pub(crate) fn clone(
    sessions: &AgentSessions,
    request: GitCloneRequest,
) -> Result<AgentProject, GitError> {
    validate_folder_name(&request.folder_name)?;
    remotes::validate_remote_url(&request.url)?;
    validate_project_directory(&request.environment, &request.parent_path)
        .map_err(|message| GitError::new("invalidProject", message))?;

    let path = logical_destination(
        &request.environment,
        &request.parent_path,
        &request.folder_name,
    )?;
    let project = AgentProject {
        id: request.id,
        name: request.name,
        path: path.clone(),
        environment: request.environment,
        icon_data_url: None,
        icon: None,
        color: None,
    };
    validate_project(&project).map_err(|message| GitError::new("invalidProject", message))?;
    let parent = AgentProject {
        path: request.parent_path,
        ..project.clone()
    };
    let native_destination =
        native_destination(&project.environment, &parent.path, &request.folder_name)?;

    let lease = sessions
        .begin_git_operation_for_new_project(&project.id)
        .map_err(|message| GitError::new("busy", message))?;
    require_idle()?;
    let resolved_url = remotes::resolve_candidate(&parent, &request.url)?;
    remotes::validate_remote_url(&resolved_url)?;
    if resolved_url != request.url {
        return Err(GitError::new(
            "rewrittenUrl",
            "L’URL distante est réécrite par la configuration Git. Utilisez directement l’URL résolue pour confirmer cette destination.",
        ));
    }
    create_destination(&project, native_destination.as_deref())?;

    let mut args = remotes::NETWORK_CONFIG.to_vec();
    args.extend([
        "clone",
        "--no-recurse-submodules",
        request.url.as_str(),
        project.path.as_str(),
    ]);
    execute(&parent, &args, GitOperation::RemoteMutation, None)
        .map_err(remotes::redact_error)
        .map_err(|error| error.with_path(&path))?;
    lease.insert_project(project.clone()).map_err(|message| {
        GitError::new(
            "registrationFailed",
            format!("Le dépôt a été cloné, mais son enregistrement a échoué : {message}"),
        )
        .with_path(&path)
    })?;
    Ok(project)
}

pub(super) fn native_destination(
    environment: &AgentEnvironment,
    parent_path: &str,
    folder_name: &str,
) -> Result<Option<PathBuf>, GitError> {
    if environment.kind == "ssh" {
        return Ok(None);
    }
    let parent = picker_default_directory(environment, Some(parent_path))
        .map_err(|message| GitError::new("invalidProject", message))?
        .ok_or_else(|| GitError::new("invalidProject", "Le dossier parent doit être absolu."))?;
    Ok(Some(parent.join(folder_name)))
}

pub(super) fn create_destination(
    project: &AgentProject,
    local_path: Option<&Path>,
) -> Result<(), GitError> {
    if project.environment.kind == "ssh" {
        let connection = super::ssh_connection(project)?;
        crate::ssh::validate_path(&project.path)
            .map_err(|message| GitError::new("invalidPath", message))?;
        let path = crate::ssh::quote(&project.path);
        let script = format!(
            "if mkdir {path}; then printf created; elif [ -e {path} ] || [ -L {path} ]; then printf exists; else printf inaccessible; fi"
        );
        return match crate::ssh::run(connection, &script, None, 32)
            .map_err(|message| GitError::new("inaccessible", message))?
            .as_slice()
        {
            b"created" => Ok(()),
            b"exists" => Err(GitError::new(
                "destinationExists",
                "Le dossier de destination existe déjà.",
            )),
            _ => Err(GitError::new(
                "inaccessible",
                "Impossible de créer le dossier de destination distant.",
            )),
        };
    }
    let path =
        local_path.ok_or_else(|| GitError::new("invalidPath", "Destination locale absente."))?;
    std::fs::create_dir(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            GitError::new(
                "destinationExists",
                "Le dossier de destination existe déjà.",
            )
        } else {
            GitError::new(
                "inaccessible",
                format!("Impossible de créer le dossier de destination : {error}"),
            )
        }
    })
}

pub(super) fn remove_empty_destination(project: &AgentProject, local_path: Option<&Path>) {
    if project.environment.kind == "ssh" {
        if let Some(connection) = project.environment.ssh.as_ref() {
            let _ = crate::ssh::run(
                connection,
                &format!("rmdir {}", crate::ssh::quote(&project.path)),
                None,
                32,
            );
        }
    } else if let Some(path) = local_path {
        let _ = std::fs::remove_dir(path);
    }
}

pub(super) fn logical_destination(
    environment: &AgentEnvironment,
    parent: &str,
    folder_name: &str,
) -> Result<String, GitError> {
    if matches!(environment.kind.as_str(), "wsl" | "ssh") {
        if environment.kind == "ssh" {
            crate::ssh::validate_path(parent)
                .map_err(|message| GitError::new("invalidPath", message))?;
        }
        let destination = format!("{}/{}", parent.trim_end_matches('/'), folder_name);
        if environment.kind == "ssh" {
            crate::ssh::validate_path(&destination)
                .map_err(|message| GitError::new("invalidPath", message))?;
        }
        return Ok(destination);
    }
    PathBuf::from(parent)
        .join(folder_name)
        .into_os_string()
        .into_string()
        .map_err(|_| GitError::new("invalidPath", "Le chemin de destination n’est pas Unicode."))
}

pub(super) fn validate_folder_name(value: &str) -> Result<(), GitError> {
    let stem = value.split('.').next().unwrap_or_default();
    let windows_reserved = matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    let valid_component = matches!(
        Path::new(value).components().collect::<Vec<_>>().as_slice(),
        [Component::Normal(_)]
    );
    if value.is_empty()
        || value.len() > 255
        || matches!(value, "." | "..")
        || value.eq_ignore_ascii_case(".git")
        || value.ends_with([' ', '.'])
        || value
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
        || windows_reserved
        || !valid_component
    {
        return Err(GitError::new(
            "invalidFolderName",
            "Le nom du dossier de destination est invalide.",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
