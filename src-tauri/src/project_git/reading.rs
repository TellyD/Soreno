use super::{
    discover_repository, execute, object_hash::snapshot_version, validate_oid,
    validate_relative_path, GitComparison, GitConflictStage, GitContent, GitError, GitFile,
    GitIdentity, GitOperation, GitRepository, GitSide,
};
use crate::agent_sessions::AgentProject;
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

#[cfg(test)]
use super::object_hash::blob_oid;
#[cfg(test)]
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

const FILE_LIMIT: u64 = 1024 * 1024;
const LINE_LIMIT: usize = 20_000;
const STATUS_LIMIT: usize = 10_000;
const HASH_PATHS_INPUT_LIMIT: usize = 64 * 1024;
const SNAPSHOT_ATTEMPTS: usize = 3;
const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
];

#[derive(Clone, Debug)]
struct StatusEntry {
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
    index_status: u8,
    worktree_status: u8,
    conflict: bool,
    submodule: bool,
    mode: String,
    representable: bool,
    /// Porcelain v2 `mH mI mW hH hI`; absent for untracked and unmerged entries.
    objects: Option<Vec<u8>>,
}

#[derive(Default)]
struct BranchState {
    head: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    tracking_known: bool,
}

#[derive(Clone, Copy, Default)]
struct Counts {
    added: Option<u64>,
    deleted: Option<u64>,
}

#[path = "reading/content_cache.rs"]
mod content_cache;
use content_cache::{git_content_cache, GitContentCache, GitContentCacheKey};
#[path = "reading/memo.rs"]
mod memo;
use memo::{CountsMemo, FileStamp, FingerprintMemo, ReadMemo, ReadMemoStore, READ_MEMOS};
#[path = "reading/snapshot_cache.rs"]
mod snapshot_cache;
use snapshot_cache::{
    cached_snapshot, snapshot_cache, snapshot_cache_key, SnapshotCache, SnapshotCacheKey,
};
#[path = "reading/status.rs"]
mod status;
use status::{display_path, merge_counts, parse_numstat, parse_status, read_numstat};
#[path = "reading/numstat.rs"]
mod numstat;
use numstat::{memo_numstat, numstat_plan};
#[path = "reading/path_hash.rs"]
mod path_hash;
#[cfg(test)]
use path_hash::git_quoted_path;
use path_hash::hash_regular_paths;
#[path = "reading/posix_metadata.rs"]
mod posix_metadata;
#[cfg(all(test, unix))]
use posix_metadata::posix_metadata_script;
#[cfg(test)]
use posix_metadata::{parse_remote_metadata, remote_path_record, remote_size_line};
use posix_metadata::{posix_metadata, RemoteMetadata};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum NumstatRead {
    #[default]
    Skipped,
    Cached,
    Partial(usize),
    Full,
}

impl std::fmt::Display for NumstatRead {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Skipped => formatter.write_str("skipped"),
            Self::Cached => formatter.write_str("cached"),
            Self::Partial(paths) => write!(formatter, "partial:{paths}"),
            Self::Full => formatter.write_str("full"),
        }
    }
}

/// Cost breakdown of the last complete snapshot read on this thread, for the diagnostics log.
#[derive(Clone, Debug, Default)]
pub(crate) struct SnapshotStats {
    files: usize,
    status: Duration,
    details: Duration,
    staged: NumstatRead,
    unstaged: NumstatRead,
    hashed: usize,
    reused: usize,
}

impl std::fmt::Display for SnapshotStats {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "files={} status_ms={:.1} details_ms={:.1} staged={} unstaged={} hashed={} reused={}",
            self.files,
            self.status.as_secs_f64() * 1_000.0,
            self.details.as_secs_f64() * 1_000.0,
            self.staged,
            self.unstaged,
            self.hashed,
            self.reused,
        )
    }
}

thread_local! {
    static SNAPSHOT_STATS: RefCell<Option<SnapshotStats>> = const { RefCell::new(None) };
}

pub(crate) fn take_snapshot_stats() -> Option<SnapshotStats> {
    SNAPSHOT_STATS.with(|stats| stats.borrow_mut().take())
}

struct Snapshot {
    repository: GitRepository,
    entries: Vec<StatusEntry>,
    fingerprints: Vec<WorktreeFingerprint>,
    index: Vec<u8>,
    project: AgentProject,
    cache_key: SnapshotCacheKey,
}

pub(super) fn repository(project: &AgentProject) -> Result<GitRepository, GitError> {
    let key = snapshot_cache_key(project);
    let snapshot = Arc::new(snapshot(project, true, MemoUse::Reuse)?);
    let repository = snapshot.repository.clone();
    snapshot_cache().store(key, snapshot);
    Ok(repository)
}

pub(super) fn repository_state(project: &AgentProject) -> Result<GitRepository, GitError> {
    Ok(snapshot(project, false, MemoUse::Refresh)?.repository)
}

pub(super) fn branch_switch_state(
    project: &AgentProject,
    version: &str,
) -> Result<GitRepository, GitError> {
    branch_switch_state_with_cache(snapshot_cache(), project, version)
}

fn branch_switch_state_with_cache(
    cache: &SnapshotCache,
    project: &AgentProject,
    version: &str,
) -> Result<GitRepository, GitError> {
    let Some(snapshot) = cached_snapshot(cache, project, Some(version)) else {
        return repository_state(project);
    };
    let repository = &snapshot.repository;
    if discover_repository(project)?.identity != repository.identity {
        return repository_state(project);
    }
    if repository.availability != "ready" || repository.operation.is_some() {
        return Ok(repository.clone());
    }
    let status = execute(&snapshot.project, STATUS_ARGS, GitOperation::Read, None)?.stdout;
    let (branch, entries) = parse_status(&status)?;
    let identity = repository
        .identity
        .as_ref()
        .ok_or_else(|| GitError::new("malformed", "Identité Git absente."))?;
    let operation = operation_state(&snapshot.project, identity)?.0;
    if entries.is_empty()
        && repository.files.is_empty()
        && operation.is_none()
        && branch.head == repository.head
        && branch.branch == repository.branch
        && branch.upstream == repository.upstream
        && branch.ahead == repository.ahead
        && branch.behind == repository.behind
        && branch.tracking_known == repository.tracking_known
    {
        Ok(repository.clone())
    } else {
        repository_state(project)
    }
}

pub(super) fn comparison(
    project: &AgentProject,
    path: &str,
    side: GitSide,
) -> Result<GitComparison, GitError> {
    comparison_with_memo(project, path, side, MemoUse::Refresh)
}

fn comparison_with_memo(
    project: &AgentProject,
    path: &str,
    side: GitSide,
    memo_use: MemoUse,
) -> Result<GitComparison, GitError> {
    validate_relative_path(path)?;
    let current = snapshot(project, false, memo_use)?;
    require_ready(&current)?;
    let comparison = comparison_from_snapshot(&current, path, side, false)?.ok_or_else(|| {
        GitError::new(
            "stalePath",
            "Ce côté du fichier ne figure plus dans les changements Git.",
        )
    })?;
    if snapshot(&current.project, false, memo_use)?
        .repository
        .version
        != comparison.version
    {
        return Err(GitError::new(
            "stale",
            "L’état Git a changé pendant la lecture de la comparaison.",
        ));
    }
    Ok(comparison)
}

pub(super) fn preview_comparison(
    project: &AgentProject,
    path: &str,
    side: GitSide,
    version: Option<&str>,
) -> Result<GitComparison, GitError> {
    preview_comparison_with_cache(snapshot_cache(), project, path, side, version)
}

fn preview_comparison_with_cache(
    cache: &SnapshotCache,
    project: &AgentProject,
    path: &str,
    side: GitSide,
    version: Option<&str>,
) -> Result<GitComparison, GitError> {
    preview_comparison_with_caches(cache, git_content_cache(), project, path, side, version)
}

fn preview_comparison_with_caches(
    snapshot_cache: &SnapshotCache,
    content_cache: &GitContentCache,
    project: &AgentProject,
    path: &str,
    side: GitSide,
    version: Option<&str>,
) -> Result<GitComparison, GitError> {
    validate_relative_path(path)?;
    if let Some(snapshot) = cached_snapshot(snapshot_cache, project, version) {
        match comparison_from_snapshot_with_cache(&snapshot, path, side, true, content_cache) {
            Ok(Some(comparison)) => return Ok(comparison),
            Err(error) if error.code == "conflict" => return Err(error),
            _ => {}
        }
    }
    comparison_with_memo(project, path, side, MemoUse::Reuse)
}

fn require_ready(snapshot: &Snapshot) -> Result<(), GitError> {
    if snapshot.repository.availability == "ready" {
        Ok(())
    } else {
        Err(GitError::new(
            "unavailable",
            "La comparaison exige un dépôt Git avec une copie de travail.",
        ))
    }
}

fn comparison_from_snapshot(
    snapshot: &Snapshot,
    path: &str,
    side: GitSide,
    cached: bool,
) -> Result<Option<GitComparison>, GitError> {
    comparison_from_snapshot_with_cache(snapshot, path, side, cached, git_content_cache())
}

fn comparison_from_snapshot_with_cache(
    snapshot: &Snapshot,
    path: &str,
    side: GitSide,
    cached: bool,
    content_cache: &GitContentCache,
) -> Result<Option<GitComparison>, GitError> {
    require_ready(snapshot)?;
    let Some((entry_index, entry)) = snapshot.entries.iter().enumerate().find(|(_, entry)| {
        entry.representable
            && display_path(&entry.path).0 == path
            && match side {
                GitSide::Staged => entry.index_status != b'.' && entry.index_status != b'?',
                GitSide::Unstaged => entry.worktree_status != b'.',
            }
    }) else {
        return Ok(None);
    };
    if entry.conflict && side == GitSide::Staged {
        return Err(GitError::new(
            "conflict",
            "Un conflit se consulte depuis sa copie de travail.",
        ));
    }
    let expected_fingerprint = if cached && side == GitSide::Unstaged {
        match snapshot.fingerprints.get(entry_index) {
            Some(fingerprint)
                if reusable_worktree_fingerprint(
                    fingerprint,
                    &snapshot.project.environment.kind,
                ) =>
            {
                Some(fingerprint)
            }
            _ => return Ok(None),
        }
    } else {
        None
    };

    let identity = snapshot
        .repository
        .identity
        .as_ref()
        .ok_or_else(|| GitError::new("malformed", "Identité Git absente."))?;
    let old_path = entry.old_path.as_ref().map(|value| display_path(value).0);
    let before_path = match side {
        GitSide::Staged => entry.old_path.as_deref().unwrap_or(&entry.path),
        GitSide::Unstaged if matches!(entry.worktree_status, b'R' | b'C') => {
            entry.old_path.as_deref().unwrap_or(&entry.path)
        }
        GitSide::Unstaged => &entry.path,
    };
    let (before, after) = if side == GitSide::Staged {
        staged_contents(
            &snapshot.project,
            &snapshot.cache_key,
            snapshot.repository.head.as_deref(),
            before_path,
            &snapshot.index,
            &entry.path,
            content_cache,
        )?
    } else if cached
        && snapshot.project.environment.kind == "ssh"
        && !entry.conflict
        && !entry.submodule
    {
        match remote_unstaged_contents(
            &snapshot.project,
            &snapshot.cache_key,
            &snapshot.index,
            before_path,
            identity,
            path,
            expected_fingerprint.expect("empreinte SSH réutilisable"),
            content_cache,
        )? {
            Some(contents) => contents,
            None => return Ok(None),
        }
    } else {
        let before = match side {
            GitSide::Staged => unreachable!("comparaison staged déjà traitée"),
            GitSide::Unstaged if entry.conflict => index_content(
                &snapshot.project,
                &snapshot.cache_key,
                &snapshot.index,
                before_path,
                2,
                cached,
                content_cache,
            )?,
            GitSide::Unstaged => index_content(
                &snapshot.project,
                &snapshot.cache_key,
                &snapshot.index,
                before_path,
                0,
                cached,
                content_cache,
            )?,
        };
        let after = match side {
            GitSide::Staged => unreachable!("comparaison staged déjà traitée"),
            GitSide::Unstaged if entry.submodule => {
                unreadable_content(None, 0, "160000".into(), "submodule")
            }
            GitSide::Unstaged => {
                match disk_content_checked(&snapshot.project, identity, path, expected_fingerprint)?
                {
                    Some(content) => content,
                    None => return Ok(None),
                }
            }
        };
        (before, after)
    };
    let conflict_stages = if entry.conflict {
        let mut stages = Vec::new();
        for stage in 1..=3 {
            let content = index_content(
                &snapshot.project,
                &snapshot.cache_key,
                &snapshot.index,
                &entry.path,
                stage,
                cached,
                content_cache,
            )?;
            if content.mode != "000000" {
                stages.push(GitConflictStage { stage, content });
            }
        }
        Some(stages)
    } else {
        None
    };

    Ok(Some(GitComparison {
        path: path.into(),
        old_path,
        version: snapshot.repository.version.clone(),
        before,
        after,
        conflict_stages,
    }))
}

struct SnapshotFailure {
    error: GitError,
    status: Option<(AgentProject, Vec<u8>)>,
}

impl From<GitError> for SnapshotFailure {
    fn from(error: GitError) -> Self {
        Self {
            error,
            status: None,
        }
    }
}

/// Display reads reuse memoized fingerprints and counts; mutation validation recomputes them.
#[derive(Clone, Copy)]
enum MemoUse {
    Reuse,
    Refresh,
}

fn snapshot(
    project: &AgentProject,
    include_counts: bool,
    memo_use: MemoUse,
) -> Result<Snapshot, GitError> {
    snapshot_with_memos(&READ_MEMOS, project, include_counts, memo_use)
}

fn snapshot_with_memos(
    memos: &ReadMemoStore,
    project: &AgentProject,
    include_counts: bool,
    memo_use: MemoUse,
) -> Result<Snapshot, GitError> {
    SNAPSHOT_STATS.with(|stats| stats.borrow_mut().take());
    retry_while_status_changes(
        || snapshot_attempt(memos, project, include_counts, memo_use),
        |root, status| {
            execute(root, STATUS_ARGS, GitOperation::Read, None)
                .is_ok_and(|current| current.stdout != status)
        },
    )
}

// Files listed by `git status` can vanish before they are hashed or diffed while an agent writes.
fn retry_while_status_changes<T>(
    mut attempt: impl FnMut() -> Result<T, SnapshotFailure>,
    mut status_changed: impl FnMut(&AgentProject, &[u8]) -> bool,
) -> Result<T, GitError> {
    let mut attempts = 1;
    loop {
        let failure = match attempt() {
            Ok(value) => return Ok(value),
            Err(failure) => failure,
        };
        let retry = attempts < SNAPSHOT_ATTEMPTS
            && failure.error.code != "timeout"
            && failure
                .status
                .as_ref()
                .is_some_and(|(root, status)| status_changed(root, status));
        if !retry {
            return Err(failure.error);
        }
        attempts += 1;
    }
}

fn snapshot_attempt(
    memos: &ReadMemoStore,
    project: &AgentProject,
    include_counts: bool,
    memo_use: MemoUse,
) -> Result<Snapshot, SnapshotFailure> {
    let cache_key = snapshot_cache_key(project);
    let discovered = discover_repository(project)?;
    let git_version = discovered.version;
    if discovered.availability == "notRepository" {
        let version = snapshot_version(format!("notRepository\0{git_version}").as_bytes());
        return Ok(Snapshot {
            repository: empty_repository("notRepository", None, version),
            entries: Vec::new(),
            fingerprints: Vec::new(),
            index: Vec::new(),
            project: project.clone(),
            cache_key,
        });
    }
    let identity = discovered
        .identity
        .ok_or_else(|| GitError::new("malformed", "Identité Git absente."))?;
    let root_project = AgentProject {
        path: identity.root.clone(),
        ..project.clone()
    };
    if discovered.availability == "bare" {
        let mut token = b"bare\0".to_vec();
        append_identity(&mut token, &identity);
        token.extend_from_slice(git_version.as_bytes());
        let version = snapshot_version(&token);
        return Ok(Snapshot {
            repository: empty_repository("bare", Some(identity), version),
            entries: Vec::new(),
            fingerprints: Vec::new(),
            index: Vec::new(),
            project: root_project,
            cache_key,
        });
    }

    let started = Instant::now();
    let status = execute(&root_project, STATUS_ARGS, GitOperation::Read, None)?.stdout;
    let status_time = started.elapsed();
    ready_snapshot(
        &root_project,
        identity,
        &status,
        include_counts,
        (memos, memo_use),
        cache_key,
        status_time,
    )
    .map_err(|error| SnapshotFailure {
        error,
        status: Some((root_project, status)),
    })
}

fn ready_snapshot(
    root_project: &AgentProject,
    identity: GitIdentity,
    status: &[u8],
    include_counts: bool,
    (memos, memo_use): (&ReadMemoStore, MemoUse),
    cache_key: SnapshotCacheKey,
    status_time: Duration,
) -> Result<Snapshot, GitError> {
    let started = Instant::now();
    let (branch, mut entries) = parse_status(status)?;
    let staged_counts = include_counts
        && entries
            .iter()
            .any(|entry| !matches!(entry.index_status, b'.' | b'?'));
    let unstaged_counts = include_counts
        && entries
            .iter()
            .any(|entry| entry.index_status != b'?' && entry.worktree_status != b'.');
    let fingerprint_count = entries.len().min(STATUS_LIMIT);
    let previous = memos.get(&cache_key, &identity);
    let mut next = previous.successor(&identity);
    let lookup = match memo_use {
        MemoUse::Reuse => Arc::clone(&previous),
        MemoUse::Refresh => Arc::default(),
    };
    let mut stats = SnapshotStats {
        files: entries.len(),
        status: status_time,
        ..SnapshotStats::default()
    };
    let (counts, operation, merge_message, index, fingerprints) =
        if root_project.environment.kind == "ssh" {
            remote_snapshot_details(
                &root_project,
                &identity,
                &mut entries,
                fingerprint_count,
                (staged_counts, unstaged_counts),
                (&lookup, &mut next),
                &mut stats,
            )?
        } else {
            let scan = worktree_fingerprints(
                &root_project,
                &identity,
                &mut entries[..fingerprint_count],
                &lookup.fingerprints,
                &mut next.fingerprints,
            )?;
            (stats.hashed, stats.reused) = (scan.hashed, scan.reused);
            let mut counts = HashMap::new();
            if staged_counts {
                (counts, stats.staged) = memo_numstat(
                    &root_project,
                    &numstat_plan(true, &entries, &[]),
                    true,
                    &lookup.counts,
                    &mut next.counts,
                )?;
            }
            if unstaged_counts {
                let unstaged;
                (unstaged, stats.unstaged) = memo_numstat(
                    &root_project,
                    &numstat_plan(false, &entries, &scan.fingerprints),
                    false,
                    &lookup.counts,
                    &mut next.counts,
                )?;
                merge_counts(&mut counts, unstaged);
            }
            let (operation, merge_message) = operation_state(&root_project, &identity)?;
            let index = execute(
                &root_project,
                &["ls-files", "--stage", "-z"],
                GitOperation::Read,
                None,
            )?
            .stdout;
            (counts, operation, merge_message, index, scan.fingerprints)
        };
    // Carried counts keep `previous`'s epoch, so they still expire with it.
    if !include_counts {
        next.counts.clone_from(&previous.counts);
    }
    memos.store(cache_key.clone(), next);
    stats.details = started.elapsed();
    SNAPSHOT_STATS.with(|current| *current.borrow_mut() = Some(stats));

    let truncated = entries.len() > STATUS_LIMIT;
    let limited = truncated
        || entries
            .iter()
            .any(|entry| entry.index_status == b'?' && entry.path.ends_with(b"/"));
    let mut token = b"ready\0".to_vec();
    append_identity(&mut token, &identity);
    token.extend_from_slice(b"\0head\0");
    token.extend_from_slice(branch.head.as_deref().unwrap_or("").as_bytes());
    token.extend_from_slice(b"\0index\0");
    token.extend_from_slice(&index);
    token.extend_from_slice(b"\0status\0");
    token.extend_from_slice(&status);
    token.extend_from_slice(b"\0operation\0");
    token.extend_from_slice(operation.as_deref().unwrap_or("").as_bytes());
    token.extend_from_slice(b"\0message\0");
    token.extend_from_slice(merge_message.as_deref().unwrap_or("").as_bytes());
    for (entry, fingerprint) in entries.iter().take(STATUS_LIMIT).zip(&fingerprints) {
        super::check_read_deadline()?;
        let WorktreeFingerprint::Present { mode, kind, hash } = fingerprint else {
            if matches!(fingerprint, WorktreeFingerprint::Missing) {
                token.extend_from_slice(b"\0worktree\0");
                token.extend_from_slice(&entry.path);
                token.extend_from_slice(b"\0missing");
            }
            continue;
        };
        token.extend_from_slice(b"\0worktree\0");
        token.extend_from_slice(&entry.path);
        token.extend_from_slice(b"\0mode\0");
        token.extend_from_slice(mode.as_bytes());
        token.extend_from_slice(b"\0fingerprint\0");
        token.extend_from_slice(kind.as_bytes());
        token.push(0);
        token.extend_from_slice(hash.as_bytes());
    }
    let version = snapshot_version(&token);

    let files = entries
        .iter_mut()
        .take(STATUS_LIMIT)
        .map(|entry| {
            super::check_read_deadline()?;
            if entry.index_status == b'?' && entry.path.ends_with(b"/") {
                entry.mode = "160000".into();
                entry.submodule = true;
            }
            let (path, representable) = display_path(&entry.path);
            let file_counts = counts.get(&entry.path).copied().unwrap_or_default();
            Ok(GitFile {
                path,
                old_path: entry.old_path.as_ref().map(|value| display_path(value).0),
                index_status: char::from(entry.index_status).to_string(),
                worktree_status: char::from(entry.worktree_status).to_string(),
                conflict: entry.conflict,
                submodule: entry.submodule,
                actionable: is_actionable(entry, limited, representable),
                mode: entry.mode.clone(),
                added: file_counts.added,
                deleted: file_counts.deleted,
            })
        })
        .collect::<Result<Vec<_>, GitError>>()?;

    Ok(Snapshot {
        repository: GitRepository {
            availability: "ready".into(),
            identity: Some(identity),
            version,
            head: branch.head,
            branch: branch.branch,
            upstream: branch.upstream,
            ahead: branch.ahead,
            behind: branch.behind,
            tracking_known: branch.tracking_known,
            operation,
            merge_message,
            files,
            limited,
            truncated,
        },
        entries,
        fingerprints,
        index,
        project: root_project.clone(),
        cache_key,
    })
}

type SnapshotDetails = (
    HashMap<Vec<u8>, Counts>,
    Option<String>,
    Option<String>,
    Vec<u8>,
    Vec<WorktreeFingerprint>,
);

fn remote_snapshot_details(
    project: &AgentProject,
    identity: &GitIdentity,
    entries: &mut [StatusEntry],
    fingerprint_count: usize,
    (staged_counts, unstaged_counts): (bool, bool),
    (previous, next): (&ReadMemo, &mut ReadMemo),
    stats: &mut SnapshotStats,
) -> Result<SnapshotDetails, GitError> {
    let deadline = super::read_deadline();
    let staged_plan = staged_counts.then(|| numstat_plan(true, entries, &[]));
    let fingerprint_entries = &mut entries[..fingerprint_count];
    let ((mut counts, staged_read), (operation, merge_message), index, scan) =
        std::thread::scope(|scope| {
            let staged = scope.spawn(|| {
                super::READ_DEADLINE.with(|current| current.set(deadline));
                match &staged_plan {
                    Some(plan) => {
                        memo_numstat(project, plan, true, &previous.counts, &mut next.counts)
                    }
                    None => Ok((HashMap::new(), NumstatRead::Skipped)),
                }
            });
            let operation = scope.spawn(|| {
                super::READ_DEADLINE.with(|current| current.set(deadline));
                operation_state(project, identity)
            });
            let index = scope.spawn(|| {
                super::READ_DEADLINE.with(|current| current.set(deadline));
                execute(
                    project,
                    &["ls-files", "--stage", "-z"],
                    GitOperation::Read,
                    None,
                )
                .map(|output| output.stdout)
            });
            let fingerprints = scope.spawn(|| {
                super::READ_DEADLINE.with(|current| current.set(deadline));
                worktree_fingerprints(
                    project,
                    identity,
                    fingerprint_entries,
                    &previous.fingerprints,
                    &mut next.fingerprints,
                )
            });
            Ok::<_, GitError>((
                join_snapshot_read(staged.join())?,
                join_snapshot_read(operation.join())?,
                join_snapshot_read(index.join())?,
                join_snapshot_read(fingerprints.join())?,
            ))
        })?;
    (stats.staged, stats.hashed, stats.reused) = (staged_read, scan.hashed, scan.reused);
    // Unstaged counts are keyed by worktree fingerprints, so they follow the scan.
    if unstaged_counts {
        let unstaged;
        (unstaged, stats.unstaged) = memo_numstat(
            project,
            &numstat_plan(false, entries, &scan.fingerprints),
            false,
            &previous.counts,
            &mut next.counts,
        )?;
        merge_counts(&mut counts, unstaged);
    }
    Ok((counts, operation, merge_message, index, scan.fingerprints))
}

fn join_snapshot_read<T>(result: std::thread::Result<Result<T, GitError>>) -> Result<T, GitError> {
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

fn is_actionable(entry: &StatusEntry, limited: bool, path_representable: bool) -> bool {
    !limited && path_representable && entry.representable
}

fn empty_repository(
    availability: &str,
    identity: Option<GitIdentity>,
    version: String,
) -> GitRepository {
    let mut repository = super::empty_repository(availability, version);
    repository.identity = identity;
    repository
}

fn append_identity(token: &mut Vec<u8>, identity: &GitIdentity) {
    for value in [&identity.root, &identity.git_dir, &identity.common_dir] {
        token.push(0);
        token.extend_from_slice(value.as_bytes());
    }
    token.push(0);
    token.extend_from_slice(identity.object_format.as_str().as_bytes());
}

#[path = "archive.rs"]
mod archive;
pub(super) use archive::{commit_comparison, commit_detail, range_comparison, range_files};

#[path = "reading/fingerprints.rs"]
mod fingerprints;
#[cfg(all(test, unix))]
use fingerprints::worktree_fingerprints_with_lanes;
use fingerprints::{
    reusable_worktree_fingerprint, worktree_entry_needs_fingerprint, worktree_fingerprints,
    FingerprintScan, WorktreeFingerprint,
};

fn remote_read_timeout() -> Result<(std::time::Duration, bool), GitError> {
    super::check_read_deadline()?;
    let started = std::time::Instant::now();
    let ssh_deadline = started + crate::ssh::TIMEOUT;
    let (deadline, read_budget_expires_first) =
        super::bounded_by_read_deadline(super::read_deadline(), ssh_deadline);
    let timeout = deadline.saturating_duration_since(started);
    Ok((timeout, read_budget_expires_first))
}

fn remote_read_error(message: String, read_budget_expires_first: bool) -> GitError {
    if message.contains("Délai SSH") && read_budget_expires_first {
        super::read_timeout_error()
    } else if message.contains("Délai SSH") {
        GitError::new("timeout", message)
    } else {
        GitError::new("inaccessible", message)
    }
}

fn remote_read(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    let (timeout, read_budget_expires_first) = remote_read_timeout()?;
    let connection = super::ssh_connection(project)?;
    match crate::ssh::run_read_output_with_timeout(
        connection,
        script,
        input,
        8 * 1024 * 1024,
        timeout,
    ) {
        Ok(output) if output.status == 0 => {
            super::check_read_deadline()?;
            Ok(output.stdout)
        }
        Ok(output) => Err(GitError::new(
            "inaccessible",
            format!(
                "Connexion ou commande SSH échouée : {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        )),
        Err(message) => Err(remote_read_error(message, read_budget_expires_first)),
    }
}

fn posix_read(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    if project.environment.kind == "wsl" {
        super::check_read_deadline()?;
        let output = super::run_wsl_readonly(project, script, input.unwrap_or_default())?;
        super::check_read_deadline()?;
        Ok(output)
    } else {
        remote_read(project, script, input)
    }
}

fn posix_worktree_fingerprints(
    project: &AgentProject,
    identity: &GitIdentity,
    entries: &mut [StatusEntry],
    previous: &FingerprintMemo,
    next: &mut FingerprintMemo,
) -> Result<FingerprintScan, GitError> {
    let mut scan = FingerprintScan {
        fingerprints: vec![WorktreeFingerprint::Skipped; entries.len()],
        hashed: 0,
        reused: 0,
    };
    let selected = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| worktree_entry_needs_fingerprint(entry) && entry.representable)
        .map(|(index, entry)| (index, entry.path.clone()))
        .collect::<Vec<_>>();
    let paths = selected
        .iter()
        .map(|(_, path)| path.as_slice())
        .collect::<Vec<_>>();
    let known = paths
        .iter()
        .map(|path| previous.stamp(path))
        .collect::<Vec<_>>();
    let metadata = posix_metadata(project, &identity.root, &paths, &known)?;
    for ((index, path), metadata) in selected.into_iter().zip(metadata) {
        let fingerprint = &mut scan.fingerprints[index];
        match metadata {
            RemoteMetadata::Missing => *fingerprint = WorktreeFingerprint::Missing,
            RemoteMetadata::Symlink(target) => {
                if entries[index].index_status == b'?' {
                    entries[index].mode = "120000".into();
                }
                *fingerprint = WorktreeFingerprint::Present {
                    mode: "120000".into(),
                    kind: "sha256",
                    hash: snapshot_version(&target),
                };
            }
            RemoteMetadata::Regular {
                mode,
                size,
                oid,
                stamp,
            } => {
                if entries[index].index_status == b'?' {
                    entries[index].mode.clone_from(&mode);
                }
                let reused = stamp
                    .as_ref()
                    .and_then(|stamp| previous.get(&path, &stamp.key, &mode))
                    .filter(|_| oid.is_none());
                *fingerprint = match (oid, reused) {
                    (Some(oid), _) => {
                        scan.hashed += 1;
                        WorktreeFingerprint::Present {
                            mode,
                            kind: "gitOid",
                            hash: oid,
                        }
                    }
                    (None, Some(known)) => {
                        scan.reused += 1;
                        known.clone()
                    }
                    // ponytail: large SSH files use size only; the stamp could replace it if same-size rewrites must invalidate previews.
                    (None, None) => WorktreeFingerprint::Present {
                        mode,
                        kind: "size",
                        hash: size.to_string(),
                    },
                };
                if let Some(stamp) = &stamp {
                    next.remember(&path, stamp, fingerprint);
                }
            }
        }
    }
    Ok(scan)
}

#[path = "reading/content.rs"]
mod content;
use content::{
    ascii, disk_content_checked, file_error, filesystem_root, hash_file_bounded, index_content,
    object_content_pair, read_link_bytes, remote_unstaged_contents, staged_contents,
    validate_object_mode, DiskEntry, DiskRoot,
};
#[cfg(test)]
use content::{
    fingerprint_matches, hash_worktree_path, object_content, parse_batch_check, parse_batch_output,
    parse_remote_file, parse_remote_object_and_file, raw_path_component, read_file_bounded,
    read_file_chunks, remote_file_content_checked, BoundedRead, RemoteFile,
};
#[path = "reading/content_format.rs"]
mod content_format;
#[cfg(test)]
use content_format::empty_content;
use content_format::unreadable_content;

pub(super) fn requires_posix_file_reads(project: &AgentProject) -> bool {
    project.environment.kind == "ssh" || (cfg!(windows) && project.environment.kind == "wsl")
}

#[path = "reading/operation_state.rs"]
mod operation_state;
use operation_state::operation_state;

#[cfg(test)]
#[path = "reading_tests.rs"]
mod tests;
