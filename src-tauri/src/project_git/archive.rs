//! Immutable commit comparisons, never mutation authority.
use super::{
    ascii, display_path, execute, git_content_cache, object_content_pair, parse_numstat,
    snapshot_cache_key, validate_object_mode, validate_oid, validate_relative_path, GitComparison,
    GitError, GitFile, GitOperation, SnapshotCacheKey,
};
use crate::{agent_sessions::AgentProject, project_git::GitCommitDetail};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const ARCHIVE_CACHE_LIMIT: usize = 4;

#[derive(Clone)]
struct ArchiveFile {
    file: GitFile,
    representable: bool,
    before: Option<(String, String)>,
    after: Option<(String, String)>,
}

#[derive(Clone)]
struct Archive {
    parent: Option<String>,
    files: Vec<ArchiveFile>,
}

#[derive(Clone)]
struct ArchiveCacheEntry {
    project: SnapshotCacheKey,
    oid: String,
    archive: Archive,
}

static ARCHIVE_CACHE: OnceLock<Mutex<VecDeque<ArchiveCacheEntry>>> = OnceLock::new();

fn archive_cache() -> &'static Mutex<VecDeque<ArchiveCacheEntry>> {
    ARCHIVE_CACHE.get_or_init(Mutex::default)
}

fn cached_archive(project: &AgentProject, oid: &str) -> Option<Archive> {
    let project_key = snapshot_cache_key(project);
    let mut cache = archive_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let index = cache
        .iter()
        .position(|entry| entry.project == project_key && entry.oid == oid)?;
    let entry = cache.remove(index)?;
    let archive = entry.archive.clone();
    cache.push_back(entry);
    Some(archive)
}

fn store_archive(project: &AgentProject, oid: &str, archive: &Archive) {
    let project_key = snapshot_cache_key(project);
    let mut cache = archive_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = cache
        .iter()
        .position(|entry| entry.project == project_key && entry.oid == oid)
    {
        cache.remove(index);
    }
    if cache.len() == ARCHIVE_CACHE_LIMIT {
        cache.pop_front();
    }
    cache.push_back(ArchiveCacheEntry {
        project: project_key,
        oid: oid.into(),
        archive: archive.clone(),
    });
}

fn read_archive(project: &AgentProject, after: &str) -> Result<Archive, GitError> {
    super::super::check_read_deadline()?;
    validate_oid(after)?;
    // One command validates the direct commit, returns its parents and both raw OIDs/counts.
    let output = execute(
        project,
        &[
            "log",
            "--no-show-signature",
            "--no-relative",
            "-1",
            "--format=%H%x00%P",
            "--root",
            "--diff-merges=first-parent",
            "--raw",
            "--numstat",
            "-z",
            "--no-abbrev",
            "-M",
            after,
            "--",
        ],
        GitOperation::Read,
        None,
    )?
    .stdout;
    let mut bytes = output.as_slice();
    if take_record(&mut bytes)? != after.as_bytes() {
        return Err(malformed());
    }
    let parents = ascii(take_record(&mut bytes)?)?;
    for parent in parents.split_ascii_whitespace() {
        validate_oid(parent)?;
    }
    Ok(Archive {
        parent: parents.split_ascii_whitespace().next().map(str::to_owned),
        files: parse_files(bytes.strip_prefix(b"\n").unwrap_or(bytes))?,
    })
}

pub(in crate::project_git) fn commit_detail(
    project: &AgentProject,
    oid: &str,
) -> Result<GitCommitDetail, GitError> {
    let archive = read_archive(project, oid)?;
    store_archive(project, oid, &archive);
    Ok(GitCommitDetail {
        oid: oid.into(),
        parent: archive.parent,
        files: archive.files.into_iter().map(|entry| entry.file).collect(),
    })
}

pub(in crate::project_git) fn commit_comparison(
    project: &AgentProject,
    oid: &str,
    path: &str,
) -> Result<Option<GitComparison>, GitError> {
    validate_relative_path(path)?;
    let archive = match cached_archive(project, oid) {
        Some(archive) => archive,
        None => {
            let archive = read_archive(project, oid)?;
            store_archive(project, oid, &archive);
            archive
        }
    };
    comparison(project, &archive, path, oid)
}

/// Changes between two commits (`git diff base head`), e.g. a pull request against its merge base.
pub(in crate::project_git) fn range_files(
    project: &AgentProject,
    base: &str,
    head: &str,
) -> Result<Vec<GitFile>, GitError> {
    let key = format!("{base}..{head}");
    let archive = read_range(project, base, head)?;
    store_archive(project, &key, &archive);
    Ok(archive.files.into_iter().map(|entry| entry.file).collect())
}

pub(in crate::project_git) fn range_comparison(
    project: &AgentProject,
    base: &str,
    head: &str,
    path: &str,
) -> Result<Option<GitComparison>, GitError> {
    validate_relative_path(path)?;
    let key = format!("{base}..{head}");
    let archive = match cached_archive(project, &key) {
        Some(archive) => archive,
        None => {
            let archive = read_range(project, base, head)?;
            store_archive(project, &key, &archive);
            archive
        }
    };
    comparison(project, &archive, path, &key)
}

fn read_range(project: &AgentProject, base: &str, head: &str) -> Result<Archive, GitError> {
    super::super::check_read_deadline()?;
    validate_oid(base)?;
    validate_oid(head)?;
    let output = execute(
        project,
        &[
            "diff",
            "--no-relative",
            "--raw",
            "--numstat",
            "-z",
            "--no-abbrev",
            "-M",
            base,
            head,
            "--",
        ],
        GitOperation::Read,
        None,
    )?
    .stdout;
    Ok(Archive {
        parent: Some(base.into()),
        files: parse_files(&output)?,
    })
}

fn comparison(
    project: &AgentProject,
    archive: &Archive,
    path: &str,
    version: &str,
) -> Result<Option<GitComparison>, GitError> {
    let Some(entry) = archive
        .files
        .iter()
        .find(|entry| entry.representable && entry.file.path == path)
    else {
        return Ok(None);
    };
    let [before, after] = object_content_pair(
        project,
        &snapshot_cache_key(project),
        [&entry.before, &entry.after],
        git_content_cache(),
    )?;
    Ok(Some(GitComparison {
        path: path.into(),
        old_path: entry.file.old_path.clone(),
        version: version.into(),
        before,
        after,
        conflict_stages: None,
    }))
}

fn malformed() -> GitError {
    GitError::new("malformed", "Diff Git brut invalide.")
}

fn take_record<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], GitError> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(malformed)?;
    let record = &bytes[..end];
    *bytes = &bytes[end + 1..];
    Ok(record)
}

fn parse_files(mut bytes: &[u8]) -> Result<Vec<ArchiveFile>, GitError> {
    let mut files = Vec::new();
    let mut paths = Vec::new();
    while bytes.starts_with(b":") {
        let metadata = take_record(&mut bytes)?;
        let fields = metadata.split(|byte| *byte == b' ').collect::<Vec<_>>();
        if fields.len() != 5 || fields[4].is_empty() {
            return Err(malformed());
        }
        let object = |mode: &[u8], oid: &[u8]| -> Result<Option<(String, String)>, GitError> {
            let (mode, oid) = (ascii(mode)?, ascii(oid)?);
            validate_object_mode(&mode)?;
            validate_oid(&oid)?;
            Ok((mode != "000000").then_some((mode, oid)))
        };
        let before = object(&fields[0][1..], fields[2])?;
        let after = object(fields[1], fields[3])?;
        let first_path = take_record(&mut bytes)?;
        let (path, old_path) = if matches!(fields[4][0], b'R' | b'C') {
            (take_record(&mut bytes)?, Some(first_path))
        } else {
            (first_path, None)
        };
        if path.is_empty() || old_path.is_some_and(|path| path.is_empty()) {
            return Err(malformed());
        }
        let mode = after
            .as_ref()
            .or(before.as_ref())
            .ok_or_else(malformed)?
            .0
            .clone();
        paths.push(path.to_vec());
        files.push(ArchiveFile {
            representable: std::str::from_utf8(path).is_ok()
                && old_path.is_none_or(|path| std::str::from_utf8(path).is_ok()),
            file: GitFile {
                path: display_path(path).0,
                old_path: old_path.map(|path| display_path(path).0),
                index_status: char::from(fields[4][0]).to_string(),
                worktree_status: ".".into(),
                conflict: false,
                submodule: mode == "160000",
                actionable: false,
                mode,
                added: None,
                deleted: None,
            },
            before,
            after,
        });
    }
    let counts = parse_numstat(bytes)?;
    for (entry, path) in files.iter_mut().zip(paths) {
        if let Some(counts) = counts.get(&path) {
            entry.file.added = counts.added;
            entry.file.deleted = counts.deleted;
        }
    }
    Ok(files)
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
