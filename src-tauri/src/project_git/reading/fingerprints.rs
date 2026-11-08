use super::super::{object_hash::snapshot_version, GitError, GitIdentity};
use super::{
    display_path, hash_file_bounded, hash_regular_paths, posix_worktree_fingerprints,
    read_link_bytes, requires_posix_file_reads, DiskEntry, DiskRoot, FileStamp, FingerprintMemo,
    StatusEntry, FILE_LIMIT,
};
use crate::agent_sessions::AgentProject;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum WorktreeFingerprint {
    Skipped,
    Missing,
    Present {
        mode: String,
        kind: &'static str,
        hash: String,
    },
}

pub(super) struct FingerprintScan {
    pub(super) fingerprints: Vec<WorktreeFingerprint>,
    pub(super) hashed: usize,
    pub(super) reused: usize,
}

pub(super) fn worktree_fingerprints(
    project: &AgentProject,
    identity: &GitIdentity,
    entries: &mut [StatusEntry],
    previous: &FingerprintMemo,
    next: &mut FingerprintMemo,
) -> Result<FingerprintScan, GitError> {
    if requires_posix_file_reads(project) {
        return posix_worktree_fingerprints(project, identity, entries, previous, next);
    }
    // Eight lanes improve measured WSL throughput with at most 512 KiB of streaming buffers.
    let lanes = if cfg!(windows) && project.environment.kind == "wsl" && entries.len() >= 8 {
        8
    } else {
        1
    };
    worktree_fingerprints_with_lanes(project, identity, entries, lanes, previous, next)
}

enum WorktreeFingerprintScan {
    Fingerprint(WorktreeFingerprint),
    Disk {
        fingerprint: WorktreeFingerprint,
        stamp: Option<FileStamp>,
        reused: bool,
    },
    HashWithGit {
        path: Vec<u8>,
        mode: String,
        stamp: Option<FileStamp>,
    },
}

#[derive(Default)]
struct ChunkScan {
    large: Vec<(usize, Vec<u8>, String)>,
    hashed: usize,
    reused: usize,
}

pub(super) fn worktree_fingerprints_with_lanes(
    project: &AgentProject,
    identity: &GitIdentity,
    entries: &mut [StatusEntry],
    lanes: usize,
    previous: &FingerprintMemo,
    next: &mut FingerprintMemo,
) -> Result<FingerprintScan, GitError> {
    let mut scan = FingerprintScan {
        fingerprints: vec![WorktreeFingerprint::Skipped; entries.len()],
        hashed: 0,
        reused: 0,
    };
    if entries.is_empty() {
        return Ok(scan);
    }
    let root = if entries.iter().any(worktree_entry_needs_fingerprint) {
        super::super::check_read_deadline()?;
        Some(DiskRoot::new(project, identity)?)
    } else {
        None
    };
    let mut stamps = vec![None; entries.len()];
    let lanes = lanes.clamp(1, 8).min(entries.len());
    let chunks = if lanes == 1 {
        vec![scan_worktree_chunk(
            root.as_ref(),
            0,
            entries,
            &mut scan.fingerprints,
            &mut stamps,
            previous,
        )?]
    } else {
        let chunk_size = (entries.len() + lanes - 1) / lanes;
        let deadline = super::super::read_deadline();
        std::thread::scope(|scope| -> Result<Vec<_>, GitError> {
            let mut handles = Vec::new();
            for (chunk_index, ((entry_chunk, fingerprint_chunk), stamp_chunk)) in entries
                .chunks_mut(chunk_size)
                .zip(scan.fingerprints.chunks_mut(chunk_size))
                .zip(stamps.chunks_mut(chunk_size))
                .enumerate()
            {
                let root = root.as_ref();
                handles.push(scope.spawn(move || {
                    super::super::READ_DEADLINE.with(|current| current.set(deadline));
                    scan_worktree_chunk(
                        root,
                        chunk_index * chunk_size,
                        entry_chunk,
                        fingerprint_chunk,
                        stamp_chunk,
                        previous,
                    )
                }));
            }
            handles
                .into_iter()
                .map(|handle| match handle.join() {
                    Ok(result) => result,
                    Err(panic) => std::panic::resume_unwind(panic),
                })
                .collect()
        })?
    };
    let mut large = Vec::new();
    for chunk in chunks {
        scan.hashed += chunk.hashed;
        scan.reused += chunk.reused;
        large.extend(chunk.large);
    }
    let paths = large
        .iter()
        .map(|(_, path, _)| path.as_slice())
        .collect::<Vec<_>>();
    let oids = hash_regular_paths(project, &paths)?;
    for ((index, _, mode), oid) in large.into_iter().zip(oids) {
        scan.fingerprints[index] = WorktreeFingerprint::Present {
            mode,
            kind: "gitOid",
            hash: oid,
        };
    }
    for ((entry, stamp), fingerprint) in entries.iter().zip(&stamps).zip(&scan.fingerprints) {
        if let Some(stamp) = stamp {
            next.remember(&entry.path, stamp, fingerprint);
        }
    }
    Ok(scan)
}

pub(super) fn worktree_entry_needs_fingerprint(entry: &StatusEntry) -> bool {
    !entry.submodule
        && (entry.worktree_status != b'.' || entry.index_status == b'?')
        && entry.worktree_status != b'D'
        && !entry.path.ends_with(b"/")
}

fn scan_worktree_chunk(
    root: Option<&DiskRoot>,
    offset: usize,
    entries: &mut [StatusEntry],
    fingerprints: &mut [WorktreeFingerprint],
    stamps: &mut [Option<FileStamp>],
    memo: &FingerprintMemo,
) -> Result<ChunkScan, GitError> {
    let mut chunk = ChunkScan::default();
    for (index, ((entry, fingerprint), stamp)) in entries
        .iter_mut()
        .zip(fingerprints.iter_mut())
        .zip(stamps.iter_mut())
        .enumerate()
    {
        match scan_worktree_entry(root, entry, memo)? {
            WorktreeFingerprintScan::Fingerprint(value) => *fingerprint = value,
            WorktreeFingerprintScan::Disk {
                fingerprint: value,
                stamp: value_stamp,
                reused,
            } => {
                *fingerprint = value;
                *stamp = value_stamp;
                if reused {
                    chunk.reused += 1;
                } else {
                    chunk.hashed += 1;
                }
            }
            WorktreeFingerprintScan::HashWithGit {
                path,
                mode,
                stamp: value_stamp,
            } => {
                *stamp = value_stamp;
                chunk.hashed += 1;
                chunk.large.push((offset + index, path, mode));
            }
        }
    }
    Ok(chunk)
}

fn scan_worktree_entry(
    root: Option<&DiskRoot>,
    entry: &mut StatusEntry,
    memo: &FingerprintMemo,
) -> Result<WorktreeFingerprintScan, GitError> {
    super::super::check_read_deadline()?;
    if !worktree_entry_needs_fingerprint(entry) {
        return Ok(WorktreeFingerprintScan::Fingerprint(
            WorktreeFingerprint::Skipped,
        ));
    }
    let root = root.expect("la racine disque doit exister pour une empreinte");
    let Some(DiskEntry {
        mode,
        size,
        path: filesystem_path,
        stamp,
    }) = root.metadata(&entry.path)?
    else {
        return Ok(WorktreeFingerprintScan::Fingerprint(
            WorktreeFingerprint::Missing,
        ));
    };
    if entry.index_status == b'?' {
        entry.mode.clone_from(&mode);
        entry.submodule = mode == "160000";
    }
    if mode == "120000" {
        return Ok(WorktreeFingerprintScan::Fingerprint(
            WorktreeFingerprint::Present {
                mode,
                kind: "sha256",
                hash: snapshot_version(&read_link_bytes(&filesystem_path)?),
            },
        ));
    }
    if let Some(fingerprint) = stamp
        .as_ref()
        .and_then(|stamp| memo.get(&entry.path, &stamp.key, &mode))
    {
        return Ok(WorktreeFingerprintScan::Disk {
            fingerprint: fingerprint.clone(),
            stamp,
            reused: true,
        });
    }
    if size <= FILE_LIMIT {
        let display = display_path(&entry.path).0;
        if let Some(hash) = hash_file_bounded(&filesystem_path, &display)? {
            return Ok(WorktreeFingerprintScan::Disk {
                fingerprint: WorktreeFingerprint::Present {
                    mode,
                    kind: "sha256",
                    hash,
                },
                stamp,
                reused: false,
            });
        }
    }
    Ok(WorktreeFingerprintScan::HashWithGit {
        path: entry.path.clone(),
        mode,
        stamp,
    })
}

pub(super) fn reusable_worktree_fingerprint(
    fingerprint: &WorktreeFingerprint,
    environment: &str,
) -> bool {
    match fingerprint {
        WorktreeFingerprint::Present { kind: "sha256", .. } => true,
        WorktreeFingerprint::Present { kind: "gitOid", .. } => {
            matches!(environment, "ssh" | "wsl")
        }
        WorktreeFingerprint::Present { kind: "size", .. } => environment == "ssh",
        _ => false,
    }
}
