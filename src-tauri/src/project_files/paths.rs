use super::{
    errors::{invalid_path, symlink_error},
    file_io_error, ProjectFileError,
};
use crate::agent_sessions::{project_filesystem_directory, AgentProject};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

pub(super) fn validate_relative_path(
    path: &str,
    allow_empty: bool,
) -> Result<(), ProjectFileError> {
    if path.len() > 4096 || path.contains('\0') || path.contains('\\') || path.starts_with('/') {
        return Err(invalid_path());
    }
    if path.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err(invalid_path())
        };
    }
    if path.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
    }) {
        return Err(invalid_path());
    }
    Ok(())
}

pub(super) fn filesystem_root(project: &AgentProject) -> Result<PathBuf, ProjectFileError> {
    project_filesystem_directory(&project.environment, Some(&project.path))
        .map_err(|message| ProjectFileError::new("project", message))?
        .ok_or_else(|| ProjectFileError::new("project", project.path.clone()))
}

pub(super) fn is_local_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return true;
    }
    false
}

pub(super) fn resolve_local(root: &Path, relative: &str) -> Result<PathBuf, ProjectFileError> {
    let canonical_root = fs::canonicalize(root).map_err(|error| file_io_error("projet", error))?;
    if relative.is_empty() {
        return Ok(canonical_root);
    }
    let mut target = root.to_path_buf();
    for part in relative.split('/') {
        target.push(part);
        let metadata =
            fs::symlink_metadata(&target).map_err(|error| file_io_error(relative, error))?;
        if is_local_link(&metadata) {
            return Err(symlink_error());
        }
    }
    let canonical_target =
        fs::canonicalize(&target).map_err(|error| file_io_error(relative, error))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(invalid_path());
    }
    Ok(canonical_target)
}
