use super::{
    duplicate_names, exists, import_names, io_error, not_file, split, symlink_error,
    ProjectFileKind,
};
use crate::project_files::{
    file_io_error,
    windows_handles::{
        delete_windows_file, ensure_windows_handle_in_root, open_windows_at, open_windows_root,
        reject_windows_reparse_point, rename_windows_file,
    },
    ProjectFileError,
};
use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io,
    mem::size_of,
    os::windows::{ffi::OsStringExt, fs::MetadataExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    },
    Win32::{
        Foundation::{ERROR_NO_MORE_FILES, GENERIC_READ, GENERIC_WRITE},
        Storage::FileSystem::{
            FileFullDirectoryInfo, FileFullDirectoryRestartInfo, GetFileInformationByHandleEx,
            DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FULL_DIR_INFO, FILE_LIST_DIRECTORY,
            FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
        },
    },
};

const READ: u32 = GENERIC_READ | SYNCHRONIZE;
const RENAME: u32 = DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const REMOVE: u32 =
    DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE;
const CREATED: u32 = GENERIC_WRITE | REMOVE;
/// Either a file or a directory.
const ANY: u32 = 0;

pub(super) fn create(
    root: &Path,
    path: &str,
    kind: ProjectFileKind,
) -> Result<(), ProjectFileError> {
    let (parent, name, _) = open_parent(root, path, true)?;
    let options = match kind {
        ProjectFileKind::File => FILE_NON_DIRECTORY_FILE,
        ProjectFileKind::Directory => FILE_DIRECTORY_FILE,
    };
    open_windows_at(
        &parent,
        OsStr::new(name),
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_CREATE,
        options,
    )
    .map(drop)
    .map_err(|error| io_error(path, error))
}

pub(super) fn rename(
    root: &Path,
    from: &str,
    to: &str,
) -> Result<ProjectFileKind, ProjectFileError> {
    let (source_parent, source_name, root_path) = open_parent(root, from, false)?;
    let source = open_entry(&source_parent, source_name, from, RENAME, &root_path)?;
    let kind = kind_of(&metadata(&source, from)?);
    let (target_parent, target_name, _) = open_parent(root, to, true)?;
    // Without replacement an existing target fails atomically; NTFS still allows case-only renames.
    rename_windows_file(&source, &target_parent, target_name, false)
        .map_err(|error| io_error(to, error))?;
    Ok(kind)
}

pub(super) fn delete(root: &Path, path: &str) -> Result<(), ProjectFileError> {
    let (parent, name, root_path) = open_parent(root, path, false)?;
    let target = open_entry(&parent, name, path, REMOVE, &root_path)?;
    remove(target).map_err(|error| io_error(path, error))
}

pub(super) fn duplicate(
    root: &Path,
    path: &str,
) -> Result<(String, ProjectFileKind), ProjectFileError> {
    let (parent, name, root_path) = open_parent(root, path, false)?;
    let source = open_entry(&parent, name, path, READ, &root_path)?;
    let source_metadata = metadata(&source, path)?;
    let directory = source_metadata.is_dir();
    if !directory && !source_metadata.is_file() {
        return Err(not_file());
    }
    for candidate in duplicate_names(split(path).1, directory) {
        let target = match open_windows_at(
            &parent,
            OsStr::new(&candidate),
            CREATED,
            FILE_CREATE,
            type_option(directory),
        ) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(path, error)),
            Ok(target) => target,
        };
        if let Err(error) = copy_into(&source, &target, &source_metadata, path) {
            let _ = remove(target);
            return Err(error);
        }
        return Ok((candidate, kind_of(&source_metadata)));
    }
    Err(exists())
}

pub(super) fn import(
    root: &Path,
    path: &str,
    source: &mut File,
) -> Result<String, ProjectFileError> {
    let (parent, name, _) = open_parent(root, path, false)?;
    for candidate in import_names(name) {
        let target = match open_windows_at(
            &parent,
            OsStr::new(&candidate),
            CREATED,
            FILE_CREATE,
            type_option(false),
        ) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(path, error)),
            Ok(target) => target,
        };
        if let Err(error) = io::copy(source, &mut &target) {
            let _ = remove(target);
            return Err(io_error(path, error));
        }
        return Ok(candidate);
    }
    Err(exists())
}

fn type_option(directory: bool) -> u32 {
    if directory {
        FILE_DIRECTORY_FILE
    } else {
        FILE_NON_DIRECTORY_FILE
    }
}

fn kind_of(metadata: &Metadata) -> ProjectFileKind {
    if metadata.is_dir() {
        ProjectFileKind::Directory
    } else {
        ProjectFileKind::File
    }
}

fn metadata(file: &File, path: &str) -> Result<Metadata, ProjectFileError> {
    file.metadata().map_err(|error| file_io_error(path, error))
}

fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Walks the parent components from the root handle, creating missing ones when asked.
fn open_parent<'a>(
    root: &Path,
    path: &'a str,
    create: bool,
) -> Result<(File, &'a str, PathBuf), ProjectFileError> {
    let (mut parent, root_path) = open_windows_root(root)?;
    let (directory, name) = split(path);
    for part in directory.split('/').filter(|part| !part.is_empty()) {
        let part = OsStr::new(part);
        let open =
            |disposition| open_windows_at(&parent, part, READ, disposition, FILE_DIRECTORY_FILE);
        let next = match open(FILE_OPEN) {
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                match open(FILE_CREATE) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => open(FILE_OPEN),
                    created => created,
                }
            }
            opened => opened,
        }
        .map_err(|error| io_error(path, error))?;
        reject_windows_reparse_point(&next)?;
        ensure_windows_handle_in_root(&next, &root_path)?;
        parent = next;
    }
    Ok((parent, name, root_path))
}

fn open_entry(
    parent: &File,
    name: &str,
    path: &str,
    access: u32,
    root_path: &Path,
) -> Result<File, ProjectFileError> {
    let file = open_windows_at(parent, OsStr::new(name), access, FILE_OPEN, ANY)
        .map_err(|error| io_error(path, error))?;
    reject_windows_reparse_point(&file)?;
    ensure_windows_handle_in_root(&file, root_path)?;
    Ok(file)
}

/// Names in `directory`, read from its handle (restart, then continue) before any change.
fn entries(directory: &File) -> io::Result<Vec<OsString>> {
    let mut buffer = vec![0_u64; 8 * 1024];
    let mut class = FileFullDirectoryRestartInfo;
    let mut names = Vec::new();
    loop {
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * size_of::<u64>()) as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                return Ok(names);
            }
            return Err(error);
        }
        class = FileFullDirectoryInfo;
        let base = buffer.as_ptr().cast::<u8>();
        let mut offset = 0;
        loop {
            let (name, next) = unsafe {
                let info = base.add(offset).cast::<FILE_FULL_DIR_INFO>();
                let name = std::slice::from_raw_parts(
                    std::ptr::addr_of!((*info).FileName).cast::<u16>(),
                    (*info).FileNameLength as usize / size_of::<u16>(),
                );
                (name, (*info).NextEntryOffset as usize)
            };
            if !matches!(name, [46] | [46, 46]) {
                names.push(OsString::from_wide(name));
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
}

/// Deletes through handles; a reparse point inside is deleted itself, never followed.
fn remove(file: File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if metadata.is_dir() && !is_reparse_point(&metadata) {
        for name in entries(&file)? {
            remove(open_windows_at(&file, &name, REMOVE, FILE_OPEN, ANY)?)?;
        }
    }
    delete_windows_file(&file)
}

fn copy_into(
    source: &File,
    target: &File,
    source_metadata: &Metadata,
    path: &str,
) -> Result<(), ProjectFileError> {
    if !source_metadata.is_dir() {
        io::copy(&mut &*source, &mut &*target)
            .and_then(|_| target.set_permissions(source_metadata.permissions()))
            .map_err(|error| io_error(path, error))?;
        return Ok(());
    }
    for name in entries(source).map_err(|error| io_error(path, error))? {
        let child = open_windows_at(source, &name, READ, FILE_OPEN, ANY)
            .map_err(|error| io_error(path, error))?;
        let child_metadata = metadata(&child, path)?;
        if is_reparse_point(&child_metadata) {
            return Err(symlink_error());
        }
        let directory = child_metadata.is_dir();
        if !directory && !child_metadata.is_file() {
            continue;
        }
        let created = open_windows_at(target, &name, CREATED, FILE_CREATE, type_option(directory))
            .map_err(|error| io_error(path, error))?;
        copy_into(&child, &created, &child_metadata, path)?;
    }
    Ok(())
}
