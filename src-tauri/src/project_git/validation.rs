use super::GitError;
use crate::agent_sessions::AgentProject;
use std::path::{Component, Path};

pub(crate) fn validate_relative_path(value: &str) -> Result<(), GitError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(GitError::new("invalidPath", "Chemin Git invalide."));
    }
    let bytes = value.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    if value.starts_with(['/', '\\'])
        || windows_absolute
        || value.split(['/', '\\']).any(|part| {
            part == ".." || part == "." || part.eq_ignore_ascii_case(".git") || part.is_empty()
        })
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(GitError::new(
            "invalidPath",
            "Le chemin doit être relatif, normalisé, sans traversée ni composant .git.",
        ));
    }
    Ok(())
}

fn remote_path(project: &AgentProject, relative: &str) -> Result<String, GitError> {
    validate_relative_path(relative)?;
    crate::ssh::validate_path(&project.path)
        .map_err(|message| GitError::new("invalidPath", message))?;
    let path = format!("{}/{}", project.path.trim_end_matches('/'), relative);
    crate::ssh::validate_path(&path).map_err(|message| GitError::new("invalidPath", message))?;
    Ok(path)
}

pub(crate) fn remote_path_is_directory(
    project: &AgentProject,
    relative: &str,
) -> Result<bool, GitError> {
    let connection = super::ssh_connection(project)?;
    let path = crate::ssh::quote(&remote_path(project, relative)?);
    let output = crate::ssh::run(
        connection,
        &format!("if [ -d {path} ] && [ ! -L {path} ]; then printf 1; else printf 0; fi"),
        None,
        1,
    )
    .map_err(|message| GitError::new("inaccessible", message))?;
    Ok(output == b"1")
}

pub(crate) fn validate_ref_name(value: &str) -> Result<(), GitError> {
    let invalid = value.is_empty()
        || value.len() > 1024
        || value == "@"
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with(['/', '.'])
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with(".lock")
                || part.ends_with('.')
        })
        || value
            .chars()
            .any(|character| character.is_control() || " ~^:?*[\\".contains(character));
    if invalid {
        return Err(GitError::new("invalidRef", "Référence Git invalide."));
    }
    Ok(())
}

pub(crate) fn validate_oid(value: &str) -> Result<(), GitError> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::new("invalidOid", "OID Git invalide."));
    }
    Ok(())
}

pub(crate) fn oid_output(bytes: &[u8], subject: &str) -> Result<String, GitError> {
    let oid = std::str::from_utf8(bytes)
        .map_err(|_| GitError::new("malformed", format!("{subject} non UTF-8.")))?
        .trim();
    validate_oid(oid)?;
    Ok(oid.to_owned())
}
