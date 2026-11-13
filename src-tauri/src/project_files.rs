use crate::agent_sessions::AgentProject;
use serde::Serialize;
use std::{fs::OpenOptions, sync::atomic::Ordering};
use std::{
    fs::{self, File},
    io::{Read, Write},
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Mutex},
};

#[cfg(unix)]
use std::os::unix::{
    fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    io::AsRawFd,
};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const FILE_LIMIT: u64 = 1024 * 1024;
const DIRECTORY_LIMIT: usize = 2_000;
const SEARCH_RESULT_LIMIT: usize = 100;
const FALLBACK_SEARCH_SCAN_LIMIT: usize = 20_000;
const SEARCH_DEPTH_LIMIT: usize = 64;
const REMOTE_GIT_FILTER_BATCH_COUNT: usize = 100;
const REMOTE_GIT_FILTER_BATCH_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileError {
    pub code: String,
    pub message: String,
}

impl ProjectFileError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub editable: bool,
    pub previewable: bool,
    pub symlink: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileListing {
    pub entries: Vec<ProjectFileEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchResult {
    pub entries: Vec<ProjectFileEntry>,
    pub truncated: bool,
    /// Number of leading `entries` taken from the recently opened files.
    pub recent_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileContent {
    pub path: String,
    pub content: String,
    pub version: String,
    pub media_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileWriteResult {
    pub version: String,
}

pub fn list(
    project: &AgentProject,
    directory: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    validate_relative_path(directory, true)?;
    if project.environment.kind == "ssh" {
        list_remote(project, directory)
    } else {
        list_local(project, directory)
    }
}

#[cfg(test)]
fn search(
    project: &AgentProject,
    query: &str,
) -> Result<ProjectFileSearchResult, ProjectFileError> {
    search_with_refresh(project, query, false, &[])
}

/// `recent` lists recently opened files, most recent first: they are matched even when Git
/// ignores them, because the caller already opened them.
pub fn search_with_refresh(
    project: &AgentProject,
    query: &str,
    refresh: bool,
    recent: &[String],
) -> Result<ProjectFileSearchResult, ProjectFileError> {
    let query = query.trim();
    if query.is_empty() && !refresh {
        return Ok(ProjectFileSearchResult::default());
    }
    let found = search_inventory(project, query, refresh)?;
    Ok(with_recent_files(found, query, recent))
}

fn search_inventory(
    project: &AgentProject,
    query: &str,
    refresh: bool,
) -> Result<ProjectFileListing, ProjectFileError> {
    let Some((paths, truncated)) = git_inventory(project, refresh)? else {
        if query.is_empty() {
            return Ok(ProjectFileListing::default());
        }
        return if project.environment.kind == "ssh" {
            search_remote(project, query)
        } else {
            search_local(project, query)
        };
    };

    if query.is_empty() {
        return Ok(ProjectFileListing::default());
    }
    let candidates = git_search_candidates(&paths, query);
    if project.environment.kind == "ssh" {
        search_git_remote(project, &candidates, truncated)
    } else if project.environment.kind == "wsl" {
        Ok(search_git_wsl(&candidates, truncated))
    } else {
        search_git_local(project, &candidates, truncated)
    }
}

pub fn read(project: &AgentProject, path: &str) -> Result<ProjectFileContent, ProjectFileError> {
    validate_relative_path(path, false)?;
    let bytes = if project.environment.kind == "ssh" {
        read_remote(project, path)?
    } else {
        read_local(&filesystem_root(project)?, path)?
    };
    content_from_bytes(path, bytes)
}

/// Writes through a temporary sibling, so a failed copy leaves no truncated file, even over the source.
pub fn download(
    project: &AgentProject,
    path: &str,
    destination: &Path,
) -> Result<(), ProjectFileError> {
    validate_relative_path(path, false)?;
    let label = destination.to_string_lossy();
    let remote = project.environment.kind == "ssh";
    let (bytes, mut source, source_permissions) = if remote {
        (download_remote(project, path)?, None, None)
    } else {
        let file = open_local(&filesystem_root(project)?, path)?;
        let metadata = file
            .metadata()
            .map_err(|error| file_io_error(path, error))?;
        if !metadata.is_file() {
            return Err(not_file());
        }
        #[cfg(unix)]
        let permissions = fs::Permissions::from_mode(metadata.mode() & 0o777);
        #[cfg(not(unix))]
        let permissions = metadata.permissions();
        (Vec::new(), Some(file), Some(permissions))
    };
    // A replaced file keeps its mode; a new SSH-sourced file stays private (temp is 0600).
    let permissions = fs::metadata(destination)
        .map(|metadata| metadata.permissions())
        .ok()
        .or(source_permissions);
    let (temp_path, mut temp) = create_portable_temp(destination, &label)?;
    let copied = match source.as_mut() {
        Some(file) => std::io::copy(file, &mut temp).map(drop),
        None => temp.write_all(&bytes),
    }
    .and_then(|()| permissions.map_or(Ok(()), |permissions| temp.set_permissions(permissions)))
    .and_then(|()| temp.sync_all());
    drop((source, temp));
    let result = copied.and_then(|()| fs::rename(&temp_path, destination));
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(|error| file_io_error(&label, error))
}

pub fn write(
    project: &AgentProject,
    path: &str,
    content: String,
    expected_version: &str,
) -> Result<ProjectFileWriteResult, ProjectFileError> {
    validate_relative_path(path, false)?;
    if content.len() as u64 > FILE_LIMIT {
        return Err(too_large());
    }
    if content.as_bytes().contains(&0) {
        return Err(ProjectFileError::new(
            "binary",
            "Les fichiers contenant des octets nuls ne sont pas éditables.",
        ));
    }

    // ponytail: one process-wide lock keeps the complete compare-and-replace atomic for in-app
    // writers; use per-project locks only if unrelated writes become measurably contended.
    let _write_guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if project.environment.kind == "ssh" {
        let current = read_remote(project, path)?;
        validate_text_bytes(&current)?;
        ensure_expected_version(&current, expected_version)?;
        write_remote(project, path, content.as_bytes(), expected_version)?;
    } else {
        let root = filesystem_root(project)?;
        write_local(&root, path, content.as_bytes(), expected_version)?;
    }

    Ok(ProjectFileWriteResult {
        version: version(content.as_bytes()),
    })
}

fn list_local(
    project: &AgentProject,
    directory: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    let root = filesystem_root(project)?;
    let target = resolve_local(&root, directory)?;
    if !target.is_dir() {
        return Err(not_directory());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&target).map_err(|error| file_io_error(directory, error))? {
        let entry = entry.map_err(|error| file_io_error(directory, error))?;
        let Some((name, path, metadata)) = visible_local_entry(&entry)? else {
            continue;
        };
        let symlink = is_local_link(&metadata);
        // A link's target only picks its icon: the explorer never follows links.
        let kind = if symlink {
            if fs::metadata(&path).is_ok_and(|target| target.is_dir()) {
                "directory"
            } else {
                "file"
            }
        } else if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            continue;
        };
        if entries.len() == DIRECTORY_LIMIT {
            truncated = true;
            break;
        }
        entries.push(if symlink {
            link_entry_value(directory, name, kind)
        } else {
            entry_value(directory, name, kind)
        });
    }
    sort_entries(&mut entries);
    Ok(ProjectFileListing { entries, truncated })
}

fn visible_local_entry(
    entry: &fs::DirEntry,
) -> Result<Option<(String, PathBuf, fs::Metadata)>, ProjectFileError> {
    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
        return Ok(None);
    };
    if name.eq_ignore_ascii_case(".git") || name.contains(['/', '\\']) {
        return Ok(None);
    }
    let path = entry.path();
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        // The entry vanished between read_dir and stat (temp files): skip it.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(file_io_error(&name, error)),
    };
    Ok(Some((name, path, metadata)))
}

fn search_local(
    project: &AgentProject,
    query: &str,
) -> Result<ProjectFileListing, ProjectFileError> {
    let root = resolve_local(&filesystem_root(project)?, "")?;
    let query = query.to_lowercase();
    let mut entries = Vec::new();
    let mut result_limit_reached = false;
    let walk_truncated = walk_local_files(root, |relative| {
        if !relative.to_lowercase().contains(&query) {
            return ControlFlow::Continue(());
        }
        if entries.len() == SEARCH_RESULT_LIMIT {
            result_limit_reached = true;
            return ControlFlow::Break(());
        }
        entries.push(search_entry(relative));
        ControlFlow::Continue(())
    })?;

    sort_search_entries(&mut entries);
    Ok(ProjectFileListing {
        entries,
        truncated: walk_truncated || result_limit_reached,
    })
}

/// Visits regular files depth-first in name order; returns whether the scan or depth limit cut the walk short.
fn walk_local_files(
    root: PathBuf,
    mut visit: impl FnMut(String) -> ControlFlow<()>,
) -> Result<bool, ProjectFileError> {
    let mut directories = vec![(root, String::new(), 0usize)];
    let mut scanned = 0usize;
    let mut truncated = false;

    while let Some((directory, relative_directory, depth)) = directories.pop() {
        let mut children = Vec::new();
        let mut scan_limit_reached = false;
        for child in
            fs::read_dir(&directory).map_err(|error| file_io_error(&relative_directory, error))?
        {
            if scanned == FALLBACK_SEARCH_SCAN_LIMIT {
                truncated = true;
                scan_limit_reached = true;
                break;
            }
            scanned += 1;
            let child = child.map_err(|error| file_io_error(&relative_directory, error))?;
            if let Some(child) = visible_local_entry(&child)? {
                if !is_local_link(&child.2) {
                    children.push(child);
                }
            }
        }
        children.sort_by(|left, right| {
            left.0
                .to_lowercase()
                .cmp(&right.0.to_lowercase())
                .then_with(|| left.0.cmp(&right.0))
        });

        let mut child_directories = Vec::new();
        for (name, path, metadata) in children {
            let relative = if relative_directory.is_empty() {
                name
            } else {
                format!("{relative_directory}/{name}")
            };
            if metadata.is_dir() {
                if depth == SEARCH_DEPTH_LIMIT {
                    truncated = true;
                } else {
                    child_directories.push((path, relative, depth + 1));
                }
            } else if metadata.is_file() && visit(relative).is_break() {
                return Ok(truncated);
            }
        }
        if scan_limit_reached {
            break;
        }
        directories.extend(child_directories.into_iter().rev());
    }
    Ok(truncated)
}

fn git_search_candidates<'a>(inventory: &'a [GitInventoryPath], query: &str) -> Vec<&'a str> {
    let query = query.to_lowercase();
    let mut matches: Vec<_> = inventory
        .iter()
        .filter_map(|path| {
            search_score(&path.normalized, &query)
                .map(|score| (score, path.normalized.as_str(), path.original.as_str()))
        })
        .collect();
    matches.sort();
    matches
        .into_iter()
        .map(|(_, _, original)| original)
        .collect()
}

fn search_git_local(
    project: &AgentProject,
    candidates: &[&str],
    mut truncated: bool,
) -> Result<ProjectFileListing, ProjectFileError> {
    let root = filesystem_root(project)?;
    let mut entries = Vec::new();
    for &relative in candidates {
        let Ok(path) = resolve_local(&root, relative) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(path) else {
            continue;
        };
        if is_local_link(&metadata) || !metadata.is_file() {
            continue;
        }
        if entries.len() == SEARCH_RESULT_LIMIT {
            truncated = true;
            break;
        }
        entries.push(search_entry(relative.to_owned()));
    }
    Ok(ProjectFileListing { entries, truncated })
}

fn search_git_remote(
    project: &AgentProject,
    candidates: &[&str],
    truncated: bool,
) -> Result<ProjectFileListing, ProjectFileError> {
    let script = remote_git_filter_script(&project.path);
    search_git_posix(candidates, truncated, |input| {
        remote_run(project, &script, Some(input), REMOTE_GIT_FILTER_BATCH_BYTES)
    })
}

fn search_git_wsl(candidates: &[&str], inventory_truncated: bool) -> ProjectFileListing {
    ProjectFileListing {
        entries: candidates
            .iter()
            .take(SEARCH_RESULT_LIMIT)
            .map(|path| search_entry((*path).to_owned()))
            .collect(),
        truncated: inventory_truncated || candidates.len() > SEARCH_RESULT_LIMIT,
    }
}

fn validate_wsl_git_inventory(
    project: &AgentProject,
    inventory: (Vec<GitInventoryPath>, bool),
) -> Result<(Vec<GitInventoryPath>, bool), ProjectFileError> {
    let script = remote_git_filter_script(&project.path);
    validate_git_inventory_posix(inventory, |input| {
        crate::project_git::run_wsl_readonly(project, &script, input).map_err(wsl_filter_error)
    })
}

fn validate_git_inventory_posix(
    (paths, inventory_truncated): (Vec<GitInventoryPath>, bool),
    run: impl FnOnce(&[u8]) -> Result<Vec<u8>, ProjectFileError>,
) -> Result<(Vec<GitInventoryPath>, bool), ProjectFileError> {
    if paths.is_empty() {
        return Ok((paths, inventory_truncated));
    }
    let mut input = Vec::with_capacity(paths.iter().map(|path| path.original.len() + 1).sum());
    for path in paths {
        input.extend_from_slice(path.original.as_bytes());
        input.push(0);
    }
    let (validated, output_truncated) = parse_git_inventory(&run(&input)?);
    Ok((validated, inventory_truncated || output_truncated))
}

fn search_git_posix(
    candidates: &[&str],
    mut truncated: bool,
    mut run: impl FnMut(&[u8]) -> Result<Vec<u8>, ProjectFileError>,
) -> Result<ProjectFileListing, ProjectFileError> {
    let mut entries = Vec::new();
    let mut offset = 0;
    while offset < candidates.len() {
        let mut input = Vec::new();
        let mut count = 0;
        while offset < candidates.len() && count < REMOTE_GIT_FILTER_BATCH_COUNT {
            let path = candidates[offset].as_bytes();
            if !input.is_empty() && input.len() + path.len() + 1 > REMOTE_GIT_FILTER_BATCH_BYTES {
                break;
            }
            input.extend_from_slice(path);
            input.push(0);
            offset += 1;
            count += 1;
        }
        for path in run(&input)?
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let Ok(path) = std::str::from_utf8(path) else {
                continue;
            };
            if validate_relative_path(path, false).is_err() {
                continue;
            }
            if entries.len() == SEARCH_RESULT_LIMIT {
                truncated = true;
                break;
            }
            entries.push(search_entry(path.to_owned()));
        }
        if entries.len() == SEARCH_RESULT_LIMIT {
            truncated |= offset < candidates.len();
            break;
        }
    }
    Ok(ProjectFileListing { entries, truncated })
}

fn wsl_filter_error(error: crate::project_git::GitError) -> ProjectFileError {
    if error.message.contains("SORENO_FILE_NOT_DIRECTORY") {
        not_directory()
    } else {
        ProjectFileError::new("wsl", error.message)
    }
}

/// Reads NUL-separated paths relative to `$root` and keeps regular files reached without links.
const GIT_FILTER_COMMAND: &str = "xargs -0 sh -c 'root=$1; shift; for rel do target=$root; rest=$rel; linked=0; while :; do case $rest in */*) part=${rest%%/*}; rest=${rest#*/};; *) part=$rest; rest=;; esac; target=$target/$part; if [ -L \"$target\" ]; then linked=1; break; fi; [ -n \"$rest\" ] || break; done; if [ \"$linked\" -eq 0 ] && [ -f \"$target\" ]; then printf \"%s\\000\" \"$rel\"; fi; done' sh \"$root\"";

fn remote_git_filter_script(root: &str) -> String {
    format!(
        "set -eu; root={}; [ -d \"$root\" ] || {{ printf 'SORENO_FILE_NOT_DIRECTORY\\n' >&2; exit 43; }}; {GIT_FILTER_COMMAND}",
        crate::ssh::quote(root),
    )
}

#[cfg(not(windows))]
fn open_local(root: &Path, relative: &str) -> Result<File, ProjectFileError> {
    let path = resolve_local(root, relative)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options
        .open(&path)
        .map_err(|error| file_io_error(relative, error))
}

#[cfg(windows)]
fn open_local(root: &Path, relative: &str) -> Result<File, ProjectFileError> {
    let (root, root_path) = open_windows_root(root)?;
    let (parent, name) = open_windows_parent(&root, &root_path, relative)?;
    let file = open_windows_relative(&parent, name, false, false)
        .map_err(|error| file_io_error(relative, error))?;
    reject_windows_reparse_point(&file)?;
    ensure_windows_handle_in_root(&file, &root_path)?;
    Ok(file)
}

fn read_local(root: &Path, relative: &str) -> Result<Vec<u8>, ProjectFileError> {
    read_open_file(open_local(root, relative)?, relative)
}

fn read_open_file(file: File, path: &str) -> Result<Vec<u8>, ProjectFileError> {
    let metadata = file
        .metadata()
        .map_err(|error| file_io_error(path, error))?;
    if !metadata.is_file() {
        return Err(not_file());
    }
    if metadata.len() > FILE_LIMIT {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| file_io_error(path, error))?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(too_large());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn write_local(
    root: &Path,
    relative: &str,
    content: &[u8],
    expected_version: &str,
) -> Result<(), ProjectFileError> {
    // Keep the original component-by-component checks, then use directory descriptors so later
    // path swaps cannot redirect the write outside the validated project root.
    resolve_local(root, relative)?;
    let mut parent = open_root(root)?;
    let parts: Vec<_> = relative.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        parent = open_at(
            &parent,
            &c_name(part),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
        .map_err(|error| file_io_error(relative, error))?;
    }
    let name = parts[parts.len() - 1];
    let current_file = open_at(
        &parent,
        &c_name(name),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
    .map_err(|error| file_io_error(relative, error))?;
    let permissions = current_file
        .metadata()
        .map_err(|error| file_io_error(relative, error))?
        .mode();
    let current = read_open_file(current_file, relative)?;
    validate_text_bytes(&current)?;
    ensure_expected_version(&current, expected_version)?;

    let (temp_name, mut temp) = create_unix_temp(&parent, relative)?;
    let mut renamed = false;
    let result = (|| {
        temp.write_all(content)
            .and_then(|_| temp.flush())
            .map_err(|error| file_io_error(relative, error))?;
        if unsafe { libc::fchmod(temp.as_raw_fd(), (permissions & 0o7777) as libc::mode_t) } != 0 {
            return Err(file_io_error(relative, std::io::Error::last_os_error()));
        }
        temp.sync_all()
            .map_err(|error| file_io_error(relative, error))?;

        let latest = read_open_file(
            open_at(
                &parent,
                &c_name(name),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0,
            )
            .map_err(|error| file_io_error(relative, error))?,
            relative,
        )?;
        validate_text_bytes(&latest)?;
        ensure_expected_version(&latest, expected_version)?;

        let temp_c = std::ffi::CString::new(temp_name.as_bytes()).unwrap();
        let name_c = std::ffi::CString::new(name.as_bytes()).unwrap();
        if unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temp_c.as_ptr(),
                parent.as_raw_fd(),
                name_c.as_ptr(),
            )
        } != 0
        {
            return Err(file_io_error(relative, std::io::Error::last_os_error()));
        }
        renamed = true;
        parent
            .sync_all()
            .map_err(|error| file_io_error(relative, error))?;
        Ok(())
    })();
    if !renamed {
        let temp_c = std::ffi::CString::new(temp_name.as_bytes()).unwrap();
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temp_c.as_ptr(), 0);
        }
    }
    result
}

#[cfg(unix)]
fn create_unix_temp(parent: &File, path: &str) -> Result<(String, File), ProjectFileError> {
    for _ in 0..128 {
        let name = format!(
            ".soreno-{}-{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        match open_at(
            parent,
            &c_name(&name),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        ) {
            Ok(file) => return Ok((name, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(file_io_error(path, error)),
        }
    }
    Err(file_io_error(
        path,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "impossible de créer un fichier temporaire unique",
        ),
    ))
}

#[cfg(windows)]
fn write_local(
    root: &Path,
    relative: &str,
    content: &[u8],
    expected_version: &str,
) -> Result<(), ProjectFileError> {
    let (root, root_path) = open_windows_root(root)?;
    let (parent, name) = open_windows_parent(&root, &root_path, relative)?;
    let current_file = open_windows_relative(&parent, name, false, false)
        .map_err(|error| file_io_error(relative, error))?;
    reject_windows_reparse_point(&current_file)?;
    ensure_windows_handle_in_root(&current_file, &root_path)?;
    let permissions = current_file
        .metadata()
        .map_err(|error| file_io_error(relative, error))?
        .permissions();
    let current = read_open_file(current_file, relative)?;
    validate_text_bytes(&current)?;
    ensure_expected_version(&current, expected_version)?;

    let mut temp = create_windows_temp(&parent, relative)?;
    let mut replaced = false;
    let result = (|| {
        temp.write_all(content)
            .and_then(|_| temp.flush())
            .and_then(|_| temp.set_permissions(permissions))
            .and_then(|_| temp.sync_all())
            .map_err(|error| file_io_error(relative, error))?;
        ensure_windows_handle_in_root(&temp, &root_path)?;

        let latest_file = open_windows_relative(&parent, name, false, false)
            .map_err(|error| file_io_error(relative, error))?;
        reject_windows_reparse_point(&latest_file)?;
        ensure_windows_handle_in_root(&latest_file, &root_path)?;
        let latest = read_open_file(latest_file, relative)?;
        validate_text_bytes(&latest)?;
        ensure_expected_version(&latest, expected_version)?;

        rename_windows_file(&temp, &parent, name, true)
            .map_err(|error| file_io_error(relative, error))?;
        replaced = true;
        Ok(())
    })();
    if !replaced {
        let _ = delete_windows_file(&temp);
    }
    result
}

#[cfg(not(any(unix, windows)))]
fn write_local(
    root: &Path,
    relative: &str,
    content: &[u8],
    expected_version: &str,
) -> Result<(), ProjectFileError> {
    let target = resolve_local(root, relative)?;
    let current = read_local(root, relative)?;
    validate_text_bytes(&current)?;
    ensure_expected_version(&current, expected_version)?;
    let permissions = fs::metadata(&target)
        .map_err(|error| file_io_error(relative, error))?
        .permissions();
    let (temp_path, mut temp) = create_portable_temp(&target, relative)?;
    let mut replaced = false;
    let result = (|| {
        temp.write_all(content)
            .and_then(|_| temp.flush())
            .and_then(|_| temp.set_permissions(permissions))
            .and_then(|_| temp.sync_all())
            .map_err(|error| file_io_error(relative, error))?;
        drop(temp);

        let latest_target = resolve_local(root, relative)?;
        if latest_target != target {
            return Err(conflict());
        }
        let latest = read_local(root, relative)?;
        validate_text_bytes(&latest)?;
        ensure_expected_version(&latest, expected_version)?;
        fs::rename(&temp_path, &target).map_err(|error| file_io_error(relative, error))?;
        replaced = true;
        Ok(())
    })();
    if !replaced {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn create_portable_temp(target: &Path, path: &str) -> Result<(PathBuf, File), ProjectFileError> {
    let parent = target.parent().ok_or_else(invalid_path)?;
    for _ in 0..128 {
        let temp_path = parent.join(format!(
            ".soreno-{}-{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&temp_path) {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(file_io_error(path, error)),
        }
    }
    Err(file_io_error(
        path,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "impossible de créer un fichier temporaire unique",
        ),
    ))
}

fn entry_value(directory: &str, name: String, kind: &str) -> ProjectFileEntry {
    let path = if directory.is_empty() {
        name.clone()
    } else {
        format!("{directory}/{name}")
    };
    let previewable = kind == "file" && image_mime_type(&path).is_some();
    ProjectFileEntry {
        editable: kind == "file" && !previewable,
        previewable,
        symlink: false,
        name,
        path,
        kind: kind.into(),
    }
}

fn link_entry_value(directory: &str, name: String, kind: &str) -> ProjectFileEntry {
    ProjectFileEntry {
        editable: false,
        previewable: false,
        symlink: true,
        ..entry_value(directory, name, kind)
    }
}

fn search_entry(path: String) -> ProjectFileEntry {
    let previewable = image_mime_type(&path).is_some();
    ProjectFileEntry {
        name: path.rsplit('/').next().unwrap_or(&path).to_owned(),
        editable: !previewable,
        previewable,
        symlink: false,
        path,
        kind: "file".into(),
    }
}

fn sort_search_entries(entries: &mut [ProjectFileEntry]) {
    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn sort_entries(entries: &mut [ProjectFileEntry]) {
    entries.sort_by(|left, right| {
        let left_file = left.kind == "file";
        let right_file = right.kind == "file";
        left_file
            .cmp(&right_file)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn file_io_error(path: &str, error: std::io::Error) -> ProjectFileError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::PermissionDenied => "permission",
        _ => "io",
    };
    ProjectFileError::new(code, format!("{path}: {error}"))
}

#[path = "project_files/content.rs"]
mod content;
#[path = "project_files/errors.rs"]
mod errors;
#[path = "project_files/git_inventory.rs"]
mod git_inventory;
#[path = "project_files/media.rs"]
pub(crate) mod media;
#[path = "project_files/operations.rs"]
mod operations;
#[path = "project_files/paths.rs"]
mod paths;
#[path = "project_files/remote.rs"]
mod remote;
#[path = "project_files/search_rank.rs"]
mod search_rank;
#[path = "project_files/text_search.rs"]
mod text_search;
#[cfg(windows)]
#[path = "project_files/windows_handles.rs"]
mod windows_handles;

use content::{content_from_bytes, ensure_expected_version, validate_text_bytes, version};
#[cfg(not(any(unix, windows)))]
use errors::conflict;
use errors::{invalid_path, not_directory, not_file, too_large};
use git_inventory::{
    git_inventory, invalidate_search_cache, parse_git_inventory, GitInventoryPath,
};
#[cfg(test)]
use git_inventory::{
    search_cache_key, CachedGitInventory, SearchCacheKey, SearchCacheState, SEARCH_CACHE,
};
use media::image_mime_type;
#[cfg(test)]
use media::valid_image_signature;
#[cfg(unix)]
use operations::unix::{c_name, open_at, open_root};
pub use operations::{create, delete, duplicate, import_files, rename, ProjectFileKind};
use paths::{filesystem_root, is_local_link, resolve_local, validate_relative_path};
use remote::{download_remote, list_remote, read_remote, remote_run, search_remote, write_remote};
#[cfg(test)]
use remote::{parse_remote_listing, parse_remote_search, remote_guard, remote_search_script};
#[cfg(all(test, unix))]
use remote::{remote_list_script, remote_read_script, remote_write_script};
use search_rank::{search_score, with_recent_files};
pub use text_search::{search_text, ProjectTextSearchOptions, ProjectTextSearchResult};
#[cfg(windows)]
use windows_handles::{
    create_windows_temp, delete_windows_file, ensure_windows_handle_in_root, open_windows_parent,
    open_windows_relative, open_windows_root, reject_windows_reparse_point, rename_windows_file,
};

#[cfg(test)]
#[path = "project_files_tests.rs"]
mod tests;
