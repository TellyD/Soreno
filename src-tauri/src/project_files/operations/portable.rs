use super::{
    case_only_rename, duplicate_names, exists, import_names, io_error, not_directory, not_file,
    split, symlink_error, ProjectFileKind,
};
use crate::project_files::{file_io_error, invalid_path, is_local_link, ProjectFileError};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

pub(super) fn create(
    root: &Path,
    path: &str,
    kind: ProjectFileKind,
) -> Result<(), ProjectFileError> {
    let target = parent(root, path, true)?.join(split(path).1);
    match kind {
        ProjectFileKind::File => create_new(&target).map(drop),
        ProjectFileKind::Directory => fs::create_dir(&target),
    }
    .map_err(|error| io_error(path, error))
}

pub(super) fn rename(
    root: &Path,
    from: &str,
    to: &str,
) -> Result<ProjectFileKind, ProjectFileError> {
    let source = parent(root, from, false)?.join(split(from).1);
    let metadata = existing(&source, from)?;
    let target = parent(root, to, true)?.join(split(to).1);
    // fs::rename replaces existing files on Windows, so refuse them up front.
    match fs::symlink_metadata(&target) {
        Ok(target_metadata) => {
            if is_local_link(&target_metadata)
                || !case_only_rename(from, to)
                || !same_file(&source, &target)
            {
                return Err(exists());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(to, error)),
    }
    fs::rename(&source, &target).map_err(|error| io_error(to, error))?;
    Ok(kind_of(&metadata))
}

pub(super) fn delete(root: &Path, path: &str) -> Result<(), ProjectFileError> {
    let target = parent(root, path, false)?.join(split(path).1);
    if existing(&target, path)?.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    }
    .map_err(|error| io_error(path, error))
}

pub(super) fn duplicate(
    root: &Path,
    path: &str,
) -> Result<(String, ProjectFileKind), ProjectFileError> {
    let parent_path = parent(root, path, false)?;
    let base = split(path).1;
    let source = parent_path.join(base);
    let metadata = existing(&source, path)?;
    let directory = metadata.is_dir();
    if !directory && !metadata.is_file() {
        return Err(not_file());
    }
    for candidate in duplicate_names(base, directory) {
        let target = parent_path.join(&candidate);
        let created = if directory {
            fs::create_dir(&target).map(|()| None)
        } else {
            create_new(&target).map(Some)
        };
        let copied = match created {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(path, error)),
            Ok(None) => copy_tree(&source, &target, path),
            Ok(Some(mut file)) => File::open(&source)
                .and_then(|mut source_file| io::copy(&mut source_file, &mut file))
                .and_then(|_| file.set_permissions(metadata.permissions()))
                .map_err(|error| io_error(path, error)),
        };
        if let Err(error) = copied {
            let _ = if directory {
                fs::remove_dir_all(&target)
            } else {
                fs::remove_file(&target)
            };
            return Err(error);
        }
        return Ok((candidate, kind_of(&metadata)));
    }
    Err(exists())
}

pub(super) fn import(
    root: &Path,
    path: &str,
    source: &mut File,
) -> Result<String, ProjectFileError> {
    let parent_path = parent(root, path, false)?;
    for candidate in import_names(split(path).1) {
        let target = parent_path.join(&candidate);
        let mut file = match create_new(&target) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(path, error)),
            Ok(file) => file,
        };
        if let Err(error) = io::copy(source, &mut file) {
            let _ = fs::remove_file(&target);
            return Err(io_error(path, error));
        }
        return Ok(candidate);
    }
    Err(exists())
}

fn create_new(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn kind_of(metadata: &fs::Metadata) -> ProjectFileKind {
    if metadata.is_dir() {
        ProjectFileKind::Directory
    } else {
        ProjectFileKind::File
    }
}

fn same_file(source: &Path, target: &Path) -> bool {
    matches!(
        (fs::canonicalize(source), fs::canonicalize(target)),
        (Ok(source), Ok(target)) if source == target
    )
}

/// Walks the parent components without links, creating missing ones when asked.
fn parent(root: &Path, path: &str, create: bool) -> Result<PathBuf, ProjectFileError> {
    let canonical_root = fs::canonicalize(root).map_err(|error| file_io_error("projet", error))?;
    let mut current = canonical_root.clone();
    for part in split(path).0.split('/').filter(|part| !part.is_empty()) {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => ensure_directory(&metadata)?,
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                if let Err(error) = fs::create_dir(&current) {
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(io_error(path, error));
                    }
                }
                ensure_directory(
                    &fs::symlink_metadata(&current).map_err(|error| io_error(path, error))?,
                )?;
            }
            Err(error) => return Err(io_error(path, error)),
        }
    }
    let canonical_parent = fs::canonicalize(&current).map_err(|error| io_error(path, error))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(invalid_path());
    }
    Ok(canonical_parent)
}

fn ensure_directory(metadata: &fs::Metadata) -> Result<(), ProjectFileError> {
    if is_local_link(metadata) {
        Err(symlink_error())
    } else if metadata.is_dir() {
        Ok(())
    } else {
        Err(not_directory())
    }
}

fn existing(target: &Path, path: &str) -> Result<fs::Metadata, ProjectFileError> {
    let metadata = fs::symlink_metadata(target).map_err(|error| io_error(path, error))?;
    if is_local_link(&metadata) {
        return Err(symlink_error());
    }
    Ok(metadata)
}

fn copy_tree(source: &Path, target: &Path, path: &str) -> Result<(), ProjectFileError> {
    for entry in fs::read_dir(source).map_err(|error| io_error(path, error))? {
        let entry = entry.map_err(|error| io_error(path, error))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| io_error(path, error))?;
        let destination = target.join(entry.file_name());
        if is_local_link(&metadata) {
            return Err(symlink_error());
        }
        if metadata.is_dir() {
            fs::create_dir(&destination).map_err(|error| io_error(path, error))?;
            copy_tree(&entry.path(), &destination, path)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &destination).map_err(|error| io_error(path, error))?;
        }
    }
    Ok(())
}
