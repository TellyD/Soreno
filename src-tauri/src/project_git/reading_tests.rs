use super::*;
use crate::{
    project_git::test_fixtures::{local_project, successful_stdout},
    ssh::SshConnection,
};
use std::{
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct TempRepository(PathBuf);

impl TempRepository {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "soreno-git-reading-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn project(&self, path: &Path) -> AgentProject {
        local_project("project", "Projet", path)
    }

    fn configure(&self, directory: &Path) {
        self.git(directory, &["config", "--local", "core.autocrlf", "false"]);
        self.git(directory, &["config", "--local", "core.eol", "lf"]);
    }

    fn git(&self, directory: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "commit.gpgSign=false",
                "-c",
                "user.name=Soreno Test",
                "-c",
                "user.email=test@example.invalid",
                "-C",
            ])
            .arg(directory)
            .args(args)
            .env("HOME", &self.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.0.join("config"))
            .output()
            .unwrap();
        successful_stdout(output, args)
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn status_entry(conflict: bool, submodule: bool) -> StatusEntry {
    StatusEntry {
        path: b"file".to_vec(),
        old_path: None,
        index_status: b'M',
        worktree_status: b'M',
        conflict,
        submodule,
        mode: if submodule { "160000" } else { "100644" }.into(),
        representable: true,
        objects: None,
    }
}

#[cfg(unix)]
fn fingerprint_entry(path: &[u8], index_status: u8, worktree_status: u8) -> StatusEntry {
    StatusEntry {
        path: path.to_vec(),
        old_path: None,
        index_status,
        worktree_status,
        conflict: false,
        submodule: false,
        mode: "100644".into(),
        representable: true,
        objects: None,
    }
}

#[cfg(unix)]
fn fingerprints_with_lanes(
    project: &AgentProject,
    identity: &GitIdentity,
    entries: &mut [StatusEntry],
    lanes: usize,
) -> Result<Vec<WorktreeFingerprint>, GitError> {
    worktree_fingerprints_with_lanes(
        project,
        identity,
        entries,
        lanes,
        &FingerprintMemo::default(),
        &mut FingerprintMemo::default(),
    )
    .map(|scan| scan.fingerprints)
}

#[test]
fn parses_bounded_remote_metadata_and_encodes_paths_without_record_injection() {
    let oid = "a".repeat(40);
    let response = format!(
        "T\0100\0M\0F\0100755\0F\0100644\0L\0target\nline\n\0S\0 3 \n{}\nH\0{oid}\n",
        FILE_LIMIT + 1
    );
    assert_eq!(
        parse_remote_metadata(response.as_bytes(), &[None; 4], false).unwrap(),
        [
            RemoteMetadata::Missing,
            RemoteMetadata::Regular {
                mode: "100755".into(),
                size: 3,
                oid: Some(oid.clone()),
                stamp: None,
            },
            RemoteMetadata::Regular {
                mode: "100644".into(),
                size: FILE_LIMIT + 1,
                oid: None,
                stamp: None,
            },
            RemoteMetadata::Symlink(b"target\nline".to_vec()),
        ]
    );
    let all_hashes = format!(
        "T\0100\0F\0100644\0F\0100644\0S\03\n{}\nH\0{oid}\n{oid}\n",
        FILE_LIMIT + 1
    );
    assert!(matches!(
        &parse_remote_metadata(all_hashes.as_bytes(), &[None; 2], true).unwrap()[1],
        RemoteMetadata::Regular { oid: Some(hash), .. } if hash == &oid
    ));
    assert!(parse_remote_metadata(b"T\0100\0F\0100644\0", &[None], false).is_err());
    assert!(parse_remote_metadata(b"T\0100\0U\0", &[None], false).is_err());
    assert!(parse_remote_metadata(b"F\0100644\0S\03\nH\0", &[None], false).is_err());
    assert!(parse_remote_metadata(b"T\0100\0F\0100644\0S\0H\0", &[None], false).is_err());
    assert!(parse_remote_metadata(b"T\0100\0F\0100644\0S\03:1:1\nH\0", &[None], false).is_err());
    assert_eq!(
        remote_path_record("dossier/été\nfile name".as_bytes()).unwrap(),
        b"dossier/\\303\\251t\\303\\251\\012file\\040name"
    );
    assert_eq!(
        remote_path_record(b"Copie 1.txt").unwrap(),
        b"Copie\\040\\061.txt"
    );
}

#[test]
fn remote_stamps_skip_hashing_only_when_unchanged_and_settle_after_the_clock_tick() {
    let oid = "b".repeat(40);
    let response = format!(
        "T\0100\0F\0100644\0F\0100644\0F\0100644\0S\03:96:97:5\n3:98:98:6\n3:90:90:7\nH\0{oid}\n{oid}\n"
    );
    let metadata = parse_remote_metadata(
        response.as_bytes(),
        &[Some("3:96:97:5"), Some("3:1:1:6"), None],
        false,
    )
    .unwrap();
    let stamps = metadata
        .iter()
        .map(|entry| match entry {
            RemoteMetadata::Regular { oid, stamp, .. } => {
                (oid.is_some(), stamp.as_ref().map(|stamp| stamp.settled))
            }
            other => panic!("{other:?}"),
        })
        .collect::<Vec<_>>();
    // Unchanged stamp: not hashed. Changed or unknown: hashed. Two seconds old is not yet settled.
    assert_eq!(
        stamps,
        [(false, Some(true)), (true, Some(false)), (true, Some(true))]
    );
    // `stat` prints pre-1970 times as negative seconds.
    let (size, stamp) = remote_size_line(b"3:-86400:98:5", 100).unwrap();
    assert_eq!((size, stamp.map(|stamp| stamp.settled)), (3, Some(false)));
    let (size, stamp) = remote_size_line(b"7:-86400:-86400:5", 100).unwrap();
    assert_eq!((size, stamp.map(|stamp| stamp.settled)), (7, Some(true)));
    for malformed in ["-3:1:1:5", "3:1:1:-5", "3:-:1:5", "3:1-:1:5", "3:--1:1:5"] {
        assert!(remote_size_line(malformed.as_bytes(), 100).is_err());
    }
}

#[test]
fn remote_reads_use_the_remaining_budget_and_keep_timeout_classification() {
    assert_eq!(remote_read_timeout().unwrap(), (crate::ssh::TIMEOUT, false));
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    super::super::with_read_deadline(deadline, || {
        let (timeout, budget_first) = remote_read_timeout()?;
        assert!(budget_first);
        assert!(timeout <= Duration::from_millis(100));
        assert!(timeout > Duration::ZERO);
        Ok(())
    })
    .unwrap();

    let budget = remote_read_error("Délai SSH dépassé.".into(), true);
    assert_eq!(budget.code, "timeout");
    assert!(budget.message.contains("lecture Git complète"));
    let normal = remote_read_error("Délai SSH dépassé.".into(), false);
    assert_eq!(normal.code, "timeout");
    assert!(!normal.message.contains("lecture Git complète"));
    assert_eq!(
        remote_read_error("Connexion SSH interrompue.".into(), false).code,
        "inaccessible"
    );
}

#[test]
fn parses_remote_file_metadata_and_arbitrary_body_in_one_response() {
    assert_eq!(
        parse_remote_file(b"M\0".to_vec()).unwrap(),
        RemoteFile::Missing
    );
    assert_eq!(
        parse_remote_file(b"L\0target\nline\n".to_vec()).unwrap(),
        RemoteFile::Symlink(b"target\nline".to_vec())
    );
    assert_eq!(
        parse_remote_file([b"F\0100755\0 5 \0".as_slice(), b"a\0b\nc"].concat()).unwrap(),
        RemoteFile::Regular {
            mode: "100755".into(),
            size: 5,
            bytes: b"a\0b\nc".to_vec(),
        }
    );
    assert_eq!(
        parse_remote_file(b"U\0".to_vec()).unwrap_err().code,
        "invalidPath"
    );
    assert_eq!(
        parse_remote_file(b"E\0".to_vec()).unwrap_err().code,
        "inaccessible"
    );
    for malformed in [
        b"M\0extra".as_slice(),
        b"L\0missing-newline",
        b"F\0100600\01\0x",
        b"F\0100644\0nope\0",
        b"unknown",
    ] {
        assert_eq!(
            parse_remote_file(malformed.to_vec()).unwrap_err().code,
            "malformed"
        );
    }

    let identity = GitIdentity {
        root: String::new(),
        git_dir: String::new(),
        common_dir: String::new(),
        object_format: super::super::object_hash::ObjectFormat::Sha1,
    };
    let expected = WorktreeFingerprint::Present {
        mode: "100644".into(),
        kind: "size",
        hash: (FILE_LIMIT + 1).to_string(),
    };
    let large = RemoteFile::Regular {
        mode: "100644".into(),
        size: FILE_LIMIT + 1,
        bytes: Vec::new(),
    };
    let content = remote_file_content_checked(&identity, large, Some(&expected))
        .unwrap()
        .unwrap();
    assert_eq!(content.reason.as_deref(), Some("tooLarge"));
    assert_eq!(content.oid, None);
    let changed_size = RemoteFile::Regular {
        mode: "100644".into(),
        size: FILE_LIMIT + 2,
        bytes: Vec::new(),
    };
    assert_eq!(
        remote_file_content_checked(&identity, changed_size, Some(&expected)).unwrap(),
        None
    );
}

#[test]
fn parses_remote_object_and_file_without_confusing_binary_framing() {
    let oid = "1111111111111111111111111111111111111111";
    let response = [b"G\0 3 \0a\0bF\0100644\0 4 \0".as_slice(), b"work"].concat();
    let (object, file) =
        parse_remote_object_and_file(response, "100644".into(), oid.into()).unwrap();
    assert_eq!(object.oid.as_deref(), Some(oid));
    assert_eq!(object.size, 3);
    assert_eq!(object.reason.as_deref(), Some("binary"));
    assert_eq!(
        file,
        RemoteFile::Regular {
            mode: "100644".into(),
            size: 4,
            bytes: b"work".to_vec(),
        }
    );

    let response = format!("G\0{}\0M\0", FILE_LIMIT + 1).into_bytes();
    let (object, file) =
        parse_remote_object_and_file(response, "100644".into(), oid.into()).unwrap();
    assert_eq!(object.reason.as_deref(), Some("tooLarge"));
    assert_eq!(file, RemoteFile::Missing);

    assert_eq!(
        parse_remote_object_and_file(b"G\04\0abc".to_vec(), "100644".into(), oid.into())
            .unwrap_err()
            .code,
        "malformed"
    );
}

#[test]
fn snapshot_cache_key_includes_the_complete_ssh_target() {
    let root = TempRepository::new("ssh-cache-key");
    let mut project = root.project(&root.0);
    project.environment.kind = "ssh".into();
    project.environment.ssh = Some(SshConnection {
        host: "first.example".into(),
        user: Some("user".into()),
        port: Some(22),
        identity_file: None,
        host_key: None,
    });
    let first = snapshot_cache_key(&project);
    project.environment.ssh.as_mut().unwrap().host = "second.example".into();
    assert_ne!(first, snapshot_cache_key(&project));
    project.environment.ssh.as_mut().unwrap().host = "first.example".into();
    project.environment.ssh.as_mut().unwrap().host_key = Some("ssh-ed25519 AAAA".into());
    assert_ne!(first, snapshot_cache_key(&project));
}

#[test]
fn parses_binary_numstat_and_escapes_only_invalid_filename_bytes() {
    let counts = parse_numstat(b"2\t3\ta b\0-\t-\tbin\0").unwrap();
    assert_eq!(counts[b"a b".as_slice()].added, Some(2));
    assert_eq!(counts[b"bin".as_slice()].deleted, None);
    assert_eq!(display_path(b"caf\xC3\xA9").0, "café");
    assert_eq!(display_path(b"bad\xFFname"), ("bad\\xFFname".into(), false));
}

#[test]
fn parses_v2_records_without_treating_spaces_or_newlines_as_separators() {
    let status = b"# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\01 M. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb space and\nline\02 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new name\0old name\0? -dash\0";
    let (branch, entries) = parse_status(status).unwrap();
    assert_eq!(branch.branch.as_deref(), Some("main"));
    assert_eq!((branch.ahead, branch.behind), (2, 3));
    assert!(branch.tracking_known);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, b"space and\nline");
    assert_eq!(entries[1].old_path.as_deref(), Some(b"old name".as_slice()));
    assert_eq!(entries[2].path, b"-dash");
}

#[test]
fn marks_tracking_unknown_when_upstream_exists_without_ahead_behind_counts() {
    let status = b"# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0# branch.upstream origin/main\0";
    let (branch, entries) = parse_status(status).unwrap();
    assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
    assert_eq!((branch.ahead, branch.behind), (0, 0));
    assert!(!branch.tracking_known);
    assert!(entries.is_empty());
}

#[test]
fn actionability_only_tracks_path_validity_and_snapshot_limit() {
    assert!(is_actionable(&status_entry(true, false), false, true));
    assert!(is_actionable(&status_entry(false, true), false, true));
    assert!(!is_actionable(&status_entry(false, false), true, true));
    assert!(!is_actionable(&status_entry(false, false), false, false));
}

#[test]
fn bounded_file_streams_match_raw_sha256_and_collection_limits() {
    let root = TempRepository::new("bounded");
    let path = root.0.join("file");
    for size in [
        0,
        64 * 1024 - 1,
        64 * 1024,
        64 * 1024 + 1,
        FILE_LIMIT as usize,
        FILE_LIMIT as usize + 1,
    ] {
        let bytes = (0..size)
            .map(|index| match index % 7 {
                0 => 0,
                1 => b'\r',
                2 => b'\n',
                3 => 0xff,
                _ => (index % 251) as u8,
            })
            .collect::<Vec<_>>();
        fs::write(&path, &bytes).unwrap();

        let mut streamed = Sha256::new();
        let complete = read_file_chunks(&path, "file", |block| streamed.update(block)).unwrap();
        assert_eq!(
            format!("{:x}", streamed.finalize()),
            snapshot_version(&bytes)
        );
        assert_eq!(complete, size <= FILE_LIMIT as usize);

        let hash = hash_file_bounded(&path, "file").unwrap();
        let collected = read_file_bounded(&path, "file").unwrap();
        if complete {
            assert_eq!(hash.as_deref(), Some(snapshot_version(&bytes).as_str()));
            assert!(matches!(
                collected,
                BoundedRead::Complete(read) if read == bytes
            ));
        } else {
            assert!(hash.is_none());
            assert!(matches!(collected, BoundedRead::TooLarge));
        }
    }
}

#[cfg(unix)]
#[test]
fn eight_lane_fingerprints_preserve_serial_modes_order_and_tokens() {
    use std::os::unix::fs::PermissionsExt;

    let root = TempRepository::new("fingerprint-lanes");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("text"), b"text\n").unwrap();
    fs::write(root.0.join("binary"), b"bin\0ary").unwrap();
    File::create(root.0.join("large"))
        .unwrap()
        .set_len(FILE_LIMIT + 1)
        .unwrap();
    fs::write(root.0.join("staged"), b"staged\n").unwrap();
    fs::write(root.0.join("target"), b"target\n").unwrap();
    std::os::unix::fs::symlink("target", root.0.join("link")).unwrap();
    fs::write(root.0.join("executable"), b"#!/bin/sh\n").unwrap();
    let mut permissions = fs::metadata(root.0.join("executable"))
        .unwrap()
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(root.0.join("executable"), permissions).unwrap();

    let project = root.project(&root.0);
    let identity = discover_repository(&project).unwrap().identity.unwrap();
    let entries = vec![
        fingerprint_entry(b"text", b'?', b'?'),
        fingerprint_entry(b"binary", b'?', b'?'),
        fingerprint_entry(b"large", b'?', b'?'),
        fingerprint_entry(b"deleted", b'M', b'D'),
        fingerprint_entry(b"missing", b'M', b'M'),
        fingerprint_entry(b"staged", b'M', b'.'),
        fingerprint_entry(b"link", b'?', b'?'),
        fingerprint_entry(b"executable", b'?', b'?'),
    ];
    let mut serial_entries = entries.clone();
    let serial = fingerprints_with_lanes(&project, &identity, &mut serial_entries, 1).unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let mut parallel_entries = entries.clone();
    let parallel = fingerprints_with_lanes(&project, &identity, &mut parallel_entries, 8).unwrap();

    assert_eq!(parallel, serial);
    assert_eq!(
        parallel_entries
            .iter()
            .map(|entry| (&entry.path, &entry.mode, entry.submodule))
            .collect::<Vec<_>>(),
        serial_entries
            .iter()
            .map(|entry| (&entry.path, &entry.mode, entry.submodule))
            .collect::<Vec<_>>()
    );
    assert_eq!(parallel_entries[6].mode, "120000");
    assert_eq!(parallel_entries[7].mode, "100755");
    assert_eq!(
        parallel[0],
        WorktreeFingerprint::Present {
            mode: "100644".into(),
            kind: "sha256",
            hash: snapshot_version(b"text\n"),
        }
    );
    assert_eq!(
        parallel[1],
        WorktreeFingerprint::Present {
            mode: "100644".into(),
            kind: "sha256",
            hash: snapshot_version(b"bin\0ary"),
        }
    );
    assert!(matches!(
        parallel[2],
        WorktreeFingerprint::Present { kind: "gitOid", .. }
    ));
    assert_eq!(parallel[3], WorktreeFingerprint::Skipped);
    assert_eq!(parallel[4], WorktreeFingerprint::Missing);
    assert_eq!(parallel[5], WorktreeFingerprint::Skipped);
    assert_eq!(
        parallel[6],
        WorktreeFingerprint::Present {
            mode: "120000".into(),
            kind: "sha256",
            hash: snapshot_version(b"target"),
        }
    );
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 1));
}

#[cfg(unix)]
#[test]
fn eight_lane_fingerprints_reject_a_parent_outside_the_root_like_serial() {
    let root = TempRepository::new("fingerprint-parent");
    let repository_path = root.0.join("repository");
    let outside = root.0.join("outside");
    fs::create_dir_all(&repository_path).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("file"), b"outside\n").unwrap();
    root.git(&repository_path, &["init", "-q"]);
    root.configure(&repository_path);
    std::os::unix::fs::symlink(&outside, repository_path.join("escape")).unwrap();
    let project = root.project(&repository_path);
    let identity = discover_repository(&project).unwrap().identity.unwrap();
    let mut entries = (0..7)
        .map(|index| fingerprint_entry(format!("skip-{index}").as_bytes(), b'M', b'.'))
        .collect::<Vec<_>>();
    entries.push(fingerprint_entry(b"escape/file", b'M', b'M'));

    let serial = fingerprints_with_lanes(&project, &identity, &mut entries.clone(), 1).unwrap_err();
    let parallel = fingerprints_with_lanes(&project, &identity, &mut entries, 8).unwrap_err();
    assert_eq!(parallel, serial);
    assert_eq!(parallel.code, "invalidPath");
}

#[test]
fn comparison_selects_the_requested_side_for_duplicate_status_paths() {
    let root = TempRepository::new("duplicate-path");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    root.git(&root.0, &["rm", "-q", "file"]);
    fs::write(root.0.join("file"), "recreated\n").unwrap();
    let project = root.project(&root.0);
    let snapshot = snapshot(&project, true, MemoUse::Reuse).unwrap();

    let staged = comparison_from_snapshot(&snapshot, "file", GitSide::Staged, true)
        .unwrap()
        .unwrap();
    let unstaged = comparison_from_snapshot(&snapshot, "file", GitSide::Unstaged, true)
        .unwrap()
        .unwrap();
    assert_eq!(staged.before.text.as_deref(), Some("base\n"));
    assert_eq!(staged.after.text.as_deref(), Some(""));
    assert_eq!(unstaged.before.text.as_deref(), Some(""));
    assert_eq!(unstaged.after.text.as_deref(), Some("recreated\n"));
    assert_eq!(staged.version, unstaged.version);
}

#[test]
fn staged_comparison_batches_both_blobs_after_resolving_head() {
    let root = TempRepository::new("staged-batch");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "before\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), "after\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    let project = root.project(&root.0);
    let snapshot = snapshot(&project, true, MemoUse::Reuse).unwrap();
    let cache = GitContentCache::default();

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let comparison =
        comparison_from_snapshot_with_cache(&snapshot, "file", GitSide::Staged, false, &cache)
            .unwrap()
            .unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 3));
    assert_eq!(comparison.before.text.as_deref(), Some("before\n"));
    assert_eq!(comparison.after.text.as_deref(), Some("after\n"));
}

#[test]
fn cached_unstaged_comparison_reuses_immutable_content() {
    let root = TempRepository::new("cached-comparison");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), "content\n").unwrap();
    let project = root.project(&root.0);
    let snapshot = Arc::new(snapshot(&project, true, MemoUse::Reuse).unwrap());
    let snapshots = SnapshotCache::default();
    let contents = GitContentCache::default();
    snapshots.store(snapshot_cache_key(&project), Arc::clone(&snapshot));

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let cold = preview_comparison_with_caches(
        &snapshots,
        &contents,
        &project,
        "file",
        GitSide::Unstaged,
        Some(&snapshot.repository.version),
    )
    .unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 2));

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let warm = preview_comparison_with_caches(
        &snapshots,
        &contents,
        &project,
        "file",
        GitSide::Unstaged,
        Some(&snapshot.repository.version),
    )
    .unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 0));
    assert_eq!(warm, cold);
    assert_eq!(warm.before.text.as_deref(), Some("base\n"));
    assert_eq!(warm.after.text.as_deref(), Some("content\n"));
    assert_eq!(warm.version, snapshot.repository.version);
}

#[test]
fn git_oid_fingerprints_are_reused_for_posix_reads_and_verify_the_blob() {
    let bytes = b"content\n";
    let fingerprint = WorktreeFingerprint::Present {
        mode: "100644".into(),
        kind: "gitOid",
        hash: blob_oid(super::super::object_hash::ObjectFormat::Sha1, bytes),
    };
    assert!(reusable_worktree_fingerprint(&fingerprint, "ssh"));
    assert!(reusable_worktree_fingerprint(&fingerprint, "wsl"));
    assert!(!reusable_worktree_fingerprint(&fingerprint, "local"));
    let size = WorktreeFingerprint::Present {
        mode: "100644".into(),
        kind: "size",
        hash: "1".into(),
    };
    assert!(reusable_worktree_fingerprint(&size, "ssh"));
    assert!(!reusable_worktree_fingerprint(&size, "wsl"));
    assert!(!reusable_worktree_fingerprint(&size, "local"));
    assert!(fingerprint_matches(
        Some(&fingerprint),
        "100644",
        bytes,
        super::super::object_hash::ObjectFormat::Sha1,
    ));
    assert!(!fingerprint_matches(
        Some(&fingerprint),
        "100644",
        b"changed\n",
        super::super::object_hash::ObjectFormat::Sha1,
    ));
}

#[test]
fn cached_unstaged_comparison_rejects_changed_or_replaced_bytes() {
    let root = TempRepository::new("cached-worktree-change");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), "one\n").unwrap();
    let project = root.project(&root.0);
    let snapshot = Arc::new(snapshot(&project, true, MemoUse::Reuse).unwrap());
    let snapshots = SnapshotCache::default();
    let contents = GitContentCache::default();
    snapshots.store(snapshot_cache_key(&project), Arc::clone(&snapshot));
    preview_comparison_with_caches(
        &snapshots,
        &contents,
        &project,
        "file",
        GitSide::Unstaged,
        Some(&snapshot.repository.version),
    )
    .unwrap();

    fs::write(root.0.join("file"), "two\n").unwrap();
    let changed = preview_comparison_with_caches(
        &snapshots,
        &contents,
        &project,
        "file",
        GitSide::Unstaged,
        Some(&snapshot.repository.version),
    )
    .unwrap();
    assert_eq!(changed.before.text.as_deref(), Some("base\n"));
    assert_eq!(changed.after.text.as_deref(), Some("two\n"));
    assert_ne!(changed.version, snapshot.repository.version);

    #[cfg(unix)]
    {
        fs::remove_file(root.0.join("file")).unwrap();
        std::os::unix::fs::symlink("one\n", root.0.join("file")).unwrap();
        let replaced = preview_comparison_with_caches(
            &snapshots,
            &contents,
            &project,
            "file",
            GitSide::Unstaged,
            Some(&snapshot.repository.version),
        )
        .unwrap();
        assert_eq!(replaced.after.reason.as_deref(), Some("symlink"));
        assert_ne!(replaced.version, snapshot.repository.version);
    }
}

#[test]
fn fresh_comparison_ignores_primed_content_cache() {
    let root = TempRepository::new("fresh-comparison");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), "one\n").unwrap();
    let project = root.project(&root.0);
    let captured = Arc::new(snapshot(&project, true, MemoUse::Reuse).unwrap());
    let snapshots = SnapshotCache::default();
    let contents = GitContentCache::default();
    snapshots.store(snapshot_cache_key(&project), Arc::clone(&captured));
    preview_comparison_with_caches(
        &snapshots,
        &contents,
        &project,
        "file",
        GitSide::Unstaged,
        Some(&captured.repository.version),
    )
    .unwrap();

    fs::write(root.0.join("file"), "two\n").unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let fresh = comparison_from_snapshot_with_cache(
        &snapshot(&project, false, MemoUse::Refresh).unwrap(),
        "file",
        GitSide::Unstaged,
        false,
        &contents,
    )
    .unwrap()
    .unwrap();
    let version = fresh.version.clone();
    assert_eq!(fresh.after.text.as_deref(), Some("two\n"));
    assert_ne!(version, captured.repository.version);
    assert_eq!(
        snapshot(&project, false, MemoUse::Refresh)
            .unwrap()
            .repository
            .version,
        version
    );
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 8));
}

#[test]
fn cached_staged_comparison_keeps_snapshot_oids_and_rename_path() {
    let root = TempRepository::new("cached-staged");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("old"), "base\n").unwrap();
    root.git(&root.0, &["add", "old"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    root.git(&root.0, &["mv", "old", "new"]);
    let project = root.project(&root.0);
    let snapshot = snapshot(&project, true, MemoUse::Reuse).unwrap();

    fs::write(root.0.join("new"), "newer!\n").unwrap();
    root.git(&root.0, &["add", "new"]);
    let comparison = comparison_from_snapshot(&snapshot, "new", GitSide::Staged, true)
        .unwrap()
        .unwrap();
    assert_eq!(comparison.old_path.as_deref(), Some("old"));
    assert_eq!(comparison.before.text.as_deref(), Some("base\n"));
    assert_eq!(comparison.after.text.as_deref(), Some("base\n"));
    assert_eq!(comparison.version, snapshot.repository.version);
}

#[cfg(unix)]
#[test]
fn branch_switch_state_revalidates_the_configured_repository_identity() {
    let root = TempRepository::new("branch-switch-identity");
    let first = root.0.join("first");
    let second = root.0.join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    root.git(&first, &["init", "-q"]);
    root.git(&second, &["init", "-q"]);
    root.configure(&first);
    root.configure(&second);
    let configured = root.0.join("configured");
    std::os::unix::fs::symlink(&first, &configured).unwrap();
    let project = root.project(&configured);
    let snapshot = Arc::new(snapshot(&project, true, MemoUse::Reuse).unwrap());
    let version = snapshot.repository.version.clone();
    let cache = SnapshotCache::default();
    cache.store(snapshot_cache_key(&project), snapshot);

    fs::remove_file(&configured).unwrap();
    std::os::unix::fs::symlink(&second, &configured).unwrap();
    let state = branch_switch_state_with_cache(&cache, &project, &version).unwrap();

    assert_eq!(
        state.identity,
        discover_repository(&project).unwrap().identity
    );
    assert_ne!(state.version, version);
}

#[test]
fn snapshot_cache_requires_the_original_key_and_exact_version() {
    let root = TempRepository::new("isolated-cache");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "content\n").unwrap();
    let project = root.project(&root.0);
    let snapshot = Arc::new(snapshot(&project, true, MemoUse::Reuse).unwrap());
    let cache = SnapshotCache::default();
    cache.store(snapshot_cache_key(&project), Arc::clone(&snapshot));

    assert!(cached_snapshot(&cache, &project, None).is_none());
    assert!(cached_snapshot(&cache, &project, Some("different")).is_none());
    assert!(cached_snapshot(&cache, &project, Some(&snapshot.repository.version)).is_some());
    let mut other = project.clone();
    other.id = "other".into();
    assert!(cached_snapshot(&cache, &other, Some(&snapshot.repository.version)).is_none());
    other = project.clone();
    other.path.push_str("/other");
    assert!(cached_snapshot(&cache, &other, Some(&snapshot.repository.version)).is_none());
    other = project.clone();
    other.environment.kind = "wsl".into();
    other.environment.distribution = Some("Ubuntu".into());
    assert!(cached_snapshot(&cache, &other, Some(&snapshot.repository.version)).is_none());
}

#[test]
fn git_content_cache_key_isolates_every_immutable_input() {
    let root = TempRepository::new("content-cache-key");
    let project = root.project(&root.0);
    let oid = "1111111111111111111111111111111111111111";
    let key = |project: &AgentProject, oid: &str, mode: &str| GitContentCacheKey {
        project: snapshot_cache_key(project),
        oid: oid.into(),
        mode: mode.into(),
    };
    let content = GitContent {
        text: Some("content\n".into()),
        oid: Some(oid.into()),
        size: 8,
        mode: "100644".into(),
        reason: None,
        image_data_url: None,
    };
    let cache = GitContentCache::default();
    cache.store(key(&project, oid, "100644"), content.clone());

    let mut changed = project.clone();
    changed.id = "other".into();
    assert!(cache.get(&key(&changed, oid, "100644")).is_none());
    changed = project.clone();
    changed.path.push_str("-other");
    assert!(cache.get(&key(&changed, oid, "100644")).is_none());
    changed = project.clone();
    changed.environment.kind = "wsl".into();
    assert!(cache.get(&key(&changed, oid, "100644")).is_none());
    changed = project.clone();
    changed.environment.distribution = Some("Ubuntu".into());
    assert!(cache.get(&key(&changed, oid, "100644")).is_none());
    assert!(cache
        .get(&key(
            &project,
            "2222222222222222222222222222222222222222",
            "100644"
        ))
        .is_none());
    assert!(cache.get(&key(&project, oid, "100755")).is_none());
    assert_eq!(cache.get(&key(&project, oid, "100644")), Some(content));
}

#[test]
fn git_content_cache_enforces_lru_count_and_actual_text_bytes() {
    let root = TempRepository::new("content-cache-bounds");
    let project_key = snapshot_cache_key(&root.project(&root.0));
    let key = |digit: char| GitContentCacheKey {
        project: project_key.clone(),
        oid: digit.to_string().repeat(40),
        mode: "100644".into(),
    };
    let content = |text: Option<String>, size| GitContent {
        text,
        oid: None,
        size,
        mode: "100644".into(),
        reason: None,
        image_data_url: None,
    };
    let cache = GitContentCache::with_limits(2, 4);
    cache.store(key('1'), content(Some("aa".into()), 2));
    cache.store(key('2'), content(Some("bb".into()), 2));
    assert!(cache.get(&key('1')).is_some());
    cache.store(key('3'), content(Some("cc".into()), 2));
    assert!(cache.get(&key('2')).is_none());
    assert_eq!(cache.usage(), (2, 4));

    let bytes = GitContentCache::with_limits(4, 5);
    bytes.store(key('4'), content(None, u64::MAX));
    let lossy = String::from_utf8_lossy(&[0xff, 0xff]).into_owned();
    assert_eq!(lossy.len(), 6);
    bytes.store(key('5'), content(Some(lossy), 2));
    assert_eq!(bytes.usage(), (1, 0));
}

#[test]
fn object_pair_batches_two_cold_blobs_and_reuses_mode_scoped_cache() {
    let root = TempRepository::new("object-pair");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("first"), b"first\n").unwrap();
    fs::write(root.0.join("second"), b"second\0\xff\n").unwrap();
    let first = root.git(&root.0, &["hash-object", "-w", "first"]);
    let second = root.git(&root.0, &["hash-object", "-w", "second"]);
    let objects = [
        Some(("100644".into(), first)),
        Some(("100755".into(), second)),
    ];
    let project = root.project(&root.0);
    let key = snapshot_cache_key(&project);
    let cache = GitContentCache::default();

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let cold = object_content_pair(&project, &key, [&objects[0], &objects[1]], &cache).unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 2));
    assert_eq!(cold[0].text.as_deref(), Some("first\n"));
    assert_eq!(cold[1].reason.as_deref(), Some("binary"));
    assert_eq!(cold[1].mode, "100755");

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    assert_eq!(
        object_content_pair(&project, &key, [&objects[0], &objects[1]], &cache).unwrap(),
        cold
    );
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 0));
}

#[test]
fn object_pair_keeps_two_modes_for_one_oid_and_never_reads_large_bodies() {
    let root = TempRepository::new("object-pair-modes");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("target"), b"target\xff\n").unwrap();
    let oid = root.git(&root.0, &["hash-object", "-w", "target"]);
    let objects = [
        Some(("100644".into(), oid.clone())),
        Some(("120000".into(), oid)),
    ];
    let project = root.project(&root.0);
    let cache = GitContentCache::default();
    let contents = object_content_pair(
        &project,
        &snapshot_cache_key(&project),
        [&objects[0], &objects[1]],
        &cache,
    )
    .unwrap();
    assert_eq!(contents[0].reason.as_deref(), Some("nonUtf8"));
    assert_eq!(contents[1].reason.as_deref(), Some("symlink"));
    assert_eq!(contents[1].text.as_deref(), Some("target�\n"));
    assert_eq!(cache.usage().0, 2);

    File::create(root.0.join("large"))
        .unwrap()
        .set_len(FILE_LIMIT + 1)
        .unwrap();
    fs::write(root.0.join("limit"), vec![b'x'; FILE_LIMIT as usize]).unwrap();
    let large = root.git(&root.0, &["hash-object", "-w", "large"]);
    let limit = root.git(&root.0, &["hash-object", "-w", "limit"]);
    let objects = [
        Some(("100644".into(), large)),
        Some(("100644".into(), limit)),
    ];
    let cache = GitContentCache::default();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let contents = object_content_pair(
        &project,
        &snapshot_cache_key(&project),
        [&objects[0], &objects[1]],
        &cache,
    )
    .unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 2));
    assert_eq!(contents[0].reason.as_deref(), Some("tooLarge"));
    assert_eq!(contents[0].size, FILE_LIMIT + 1);
    assert_eq!(contents[1].size, FILE_LIMIT);
    assert_eq!(
        contents[1].text.as_ref().unwrap().len(),
        FILE_LIMIT as usize
    );
}

#[test]
fn batch_parsers_reject_wrong_identity_size_framing_and_trailing_bytes() {
    let a = "a".repeat(40);
    let b = "b".repeat(64);
    assert_eq!(
        parse_batch_check(format!("{a} blob 4\n{b} blob 3\n").as_bytes(), &[&a, &b]).unwrap(),
        [4, 3]
    );
    for malformed in [
        format!("{a} missing\n"),
        format!("{a} tree 4\n"),
        format!("{} blob 4\n", "c".repeat(40)),
        format!("{a} blob nope\n"),
        format!("{a} blob 4\ntrailing"),
    ] {
        assert!(parse_batch_check(malformed.as_bytes(), &[&a]).is_err());
    }

    let framed = format!("{a} blob 4\n").into_bytes();
    assert_eq!(
        parse_batch_output([framed.clone(), b"a\0\nb\n".to_vec()].concat(), &[(&a, 4)]).unwrap(),
        [b"a\0\nb".to_vec()]
    );
    for malformed in [
        [format!("{a} blob 3\n").into_bytes(), b"abc\n".to_vec()].concat(),
        [framed.clone(), b"abc".to_vec()].concat(),
        [framed.clone(), b"abcdx".to_vec()].concat(),
        [framed.clone(), b"abcd\ntrailing".to_vec()].concat(),
    ] {
        assert!(parse_batch_output(malformed, &[(&a, 4)]).is_err());
    }
}

#[test]
fn object_pair_does_not_cache_missing_batch_objects() {
    let root = TempRepository::new("object-pair-missing");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("valid"), b"valid").unwrap();
    let valid = root.git(&root.0, &["hash-object", "-w", "valid"]);
    let objects = [
        Some(("100644".into(), valid)),
        Some(("100644".into(), "f".repeat(40))),
    ];
    let project = root.project(&root.0);
    let cache = GitContentCache::default();
    assert!(object_content_pair(
        &project,
        &snapshot_cache_key(&project),
        [&objects[0], &objects[1]],
        &cache,
    )
    .is_err());
    assert_eq!(cache.usage(), (0, 0));
}

#[test]
fn git_content_cache_does_not_cache_failures_or_skip_hit_guards() {
    let root = TempRepository::new("content-cache-failure");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let project_key = snapshot_cache_key(&project);
    let cache = GitContentCache::default();
    let missing = "ffffffffffffffffffffffffffffffffffffffff";

    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    assert!(object_content(
        &project,
        &project_key,
        "100644".into(),
        missing.into(),
        true,
        &cache
    )
    .is_err());
    assert!(object_content(
        &project,
        &project_key,
        "100644".into(),
        missing.into(),
        true,
        &cache
    )
    .is_err());
    assert_eq!(cache.usage(), (0, 0));
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 2));

    let oid = "1111111111111111111111111111111111111111";
    cache.store(
        GitContentCacheKey {
            project: snapshot_cache_key(&project),
            oid: oid.into(),
            mode: "100644".into(),
        },
        empty_content(),
    );
    assert!(object_content(
        &project,
        &project_key,
        "invalid".into(),
        oid.into(),
        true,
        &cache
    )
    .is_err());
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let error = super::super::with_read_budget(Duration::from_millis(1), || {
        std::thread::sleep(Duration::from_millis(5));
        object_content(
            &project,
            &project_key,
            "100644".into(),
            oid.into(),
            true,
            &cache,
        )
    })
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 0));
}

#[test]
fn nested_untracked_repository_does_not_block_other_file_reads() {
    let root = TempRepository::new("nested-repository");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("tracked"), "base\n").unwrap();
    root.git(&root.0, &["add", "tracked"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    let nested = root.0.join("nested");
    fs::create_dir(&nested).unwrap();
    root.git(&nested, &["init", "-q"]);
    root.configure(&nested);
    fs::write(nested.join("file"), "nested\n").unwrap();
    fs::write(root.0.join("other"), "readable\n").unwrap();
    let project = root.project(&root.0);

    let state = repository(&project).unwrap();
    let directory = state
        .files
        .iter()
        .find(|file| file.path == "nested/")
        .unwrap();
    assert!(state.limited);
    assert!(!state.truncated);
    assert!(directory.submodule);
    assert_eq!(directory.mode, "160000");
    assert!(!directory.actionable);
    assert!(crate::project_git::mutations::selected_paths(
        &state,
        &["nested/".into()],
        crate::project_git::mutations::ChangeSide::Unstaged,
    )
    .is_err());
    assert!(state.files.iter().any(|file| file.path == "other"));
    let other = comparison(&project, "other", GitSide::Unstaged).unwrap();
    assert_eq!(other.after.text.as_deref(), Some("readable\n"));
}

#[test]
fn status_is_truncated_only_beyond_the_entry_limit() {
    let root = TempRepository::new("status-limit");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    for index in 0..STATUS_LIMIT {
        fs::write(root.0.join(format!("file-{index}")), "").unwrap();
    }
    let project = root.project(&root.0);

    let at_limit = repository(&project).unwrap();
    assert_eq!(at_limit.files.len(), STATUS_LIMIT);
    assert!(!at_limit.truncated);
    assert!(!at_limit.limited);

    fs::write(root.0.join("one-more"), "").unwrap();
    let beyond = repository(&project).unwrap();
    assert_eq!(beyond.files.len(), STATUS_LIMIT);
    assert!(beyond.truncated);
    assert!(beyond.limited);
}

#[test]
fn batch_hashes_special_paths_like_single_file_hashes() {
    let root = TempRepository::new("batch-special-paths");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let common_paths = vec![
        b"normal".to_vec(),
        b"-option".to_vec(),
        b"space name".to_vec(),
        "accent-é".as_bytes().to_vec(),
    ];
    #[cfg(unix)]
    let paths = common_paths
        .into_iter()
        .chain([
            b"line\nbreak".to_vec(),
            b"quo\"te".to_vec(),
            b"back\\slash".to_vec(),
        ])
        // APFS refuses file names that are not UTF-8.
        .chain(cfg!(not(target_os = "macos")).then(|| b"raw-\xff".to_vec()))
        .collect::<Vec<_>>();
    #[cfg(not(unix))]
    let paths = common_paths;
    let mut expected = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let content = format!("content-{index}\n");
        fs::write(root.0.join(raw_path_component(path).unwrap()), &content).unwrap();
        let bytes_oid = blob_oid(
            super::super::object_hash::ObjectFormat::Sha1,
            content.as_bytes(),
        );
        if std::str::from_utf8(path).is_ok() {
            assert_eq!(hash_worktree_path(&project, path).unwrap(), bytes_oid);
        }
        expected.push(bytes_oid);
    }
    let references = paths.iter().map(Vec::as_slice).collect::<Vec<_>>();
    assert_eq!(hash_regular_paths(&project, &references).unwrap(), expected);
}

#[test]
fn git_path_quoting_uses_three_digit_octal_for_unsafe_bytes() {
    assert_eq!(
        git_quoted_path(b"a\n\"\\\x7f\xc3"),
        b"\"a\\012\\042\\134\\177\\303\"\n"
    );
}

#[test]
fn batch_hash_input_is_split_at_64_kib() {
    let root = TempRepository::new("batch-chunks");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let paths = (0..300)
        .map(|index| format!("{index:03}-{}", "é".repeat(30)).into_bytes())
        .collect::<Vec<_>>();
    for path in &paths {
        fs::write(root.0.join(raw_path_component(path).unwrap()), b"same\n").unwrap();
    }
    assert!(
        paths
            .iter()
            .map(|path| git_quoted_path(path).len())
            .sum::<usize>()
            > 64 * 1024
    );
    let references = paths.iter().map(Vec::as_slice).collect::<Vec<_>>();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let oids = hash_regular_paths(&project, &references).unwrap();
    assert_eq!(oids.len(), paths.len());
    assert!(oids.windows(2).all(|pair| pair[0] == pair[1]));
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 2));
}

#[test]
fn batch_hashes_match_sha256_single_file_hashes() {
    let root = TempRepository::new("batch-sha256");
    root.git(&root.0, &["init", "--object-format=sha256", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let path = "sha256-é".as_bytes();
    let content = b"sha256 content\n";
    fs::write(root.0.join(raw_path_component(path).unwrap()), content).unwrap();
    let expected = blob_oid(super::super::object_hash::ObjectFormat::Sha256, content);
    assert_eq!(hash_worktree_path(&project, path).unwrap(), expected);
    assert_eq!(hash_regular_paths(&project, &[path]).unwrap(), [expected]);
}

#[cfg(unix)]
#[test]
fn snapshot_hashes_a_symlink_without_following_its_target() {
    let root = TempRepository::new("symlink-target");
    let repository_path = root.0.join("repository");
    fs::create_dir(&repository_path).unwrap();
    root.git(&repository_path, &["init", "-q"]);
    root.configure(&repository_path);
    let target = root.0.join("target");
    fs::write(&target, b"one\n").unwrap();
    std::os::unix::fs::symlink(&target, repository_path.join("link")).unwrap();
    let project = root.project(&repository_path);
    let before = repository(&project).unwrap().version;
    fs::write(target, b"two\n").unwrap();
    assert_eq!(repository(&project).unwrap().version, before);
}

#[cfg(unix)]
#[test]
fn untracked_file_mode_changes_the_snapshot_version() {
    let root = TempRepository::new("untracked-mode");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    fs::write(root.0.join("entry"), b"target").unwrap();
    let regular = repository(&project).unwrap().version;
    fs::remove_file(root.0.join("entry")).unwrap();
    std::os::unix::fs::symlink("target", root.0.join("entry")).unwrap();
    let symlink = repository(&project).unwrap().version;
    assert_ne!(regular, symlink);
}

#[test]
fn same_size_worktree_content_changes_the_snapshot_version() {
    let root = TempRepository::new("same-size-content");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    fs::write(root.0.join("file"), b"one\n").unwrap();
    let before = repository(&project).unwrap().version;
    fs::write(root.0.join("file"), b"two\n").unwrap();
    assert_ne!(repository(&project).unwrap().version, before);
}

#[test]
fn snapshot_versions_cover_the_small_and_large_file_boundary() {
    let root = TempRepository::new("snapshot-boundary");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let mut bytes = vec![b'a'; FILE_LIMIT as usize];
    fs::write(root.0.join("file"), &bytes).unwrap();
    let exact = repository(&project).unwrap().version;
    bytes[FILE_LIMIT as usize - 1] = b'b';
    fs::write(root.0.join("file"), &bytes).unwrap();
    let changed = repository(&project).unwrap().version;
    bytes.push(b'c');
    fs::write(root.0.join("file"), &bytes).unwrap();
    let large = repository(&project).unwrap().version;
    assert_ne!(exact, changed);
    assert_ne!(changed, large);
}

#[test]
fn sha256_repository_uses_git_oid_for_disk_content_and_opaque_versions() {
    let root = TempRepository::new("snapshot-sha256");
    root.git(&root.0, &["init", "--object-format=sha256", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    let bytes = b"content\r\n";
    fs::write(root.0.join("file"), bytes).unwrap();
    let state = repository(&project).unwrap();
    let content = disk_content_checked(&project, state.identity.as_ref().unwrap(), "file", None)
        .unwrap()
        .unwrap();
    let expected = blob_oid(super::super::object_hash::ObjectFormat::Sha256, bytes);
    assert_eq!(content.oid.as_deref(), Some(expected.as_str()));
}

// APFS refuses file names that are not UTF-8.
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn raw_unix_filename_is_hashed_but_remains_non_actionable() {
    let root = TempRepository::new("raw-unix-path");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let raw = b"raw-\xff";
    fs::write(root.0.join(raw_path_component(raw).unwrap()), b"one\n").unwrap();
    let project = root.project(&root.0);
    let before = repository(&project).unwrap();
    assert!(!before.files[0].actionable);
    fs::write(root.0.join(raw_path_component(raw).unwrap()), b"two\n").unwrap();
    assert_ne!(before.version, repository(&project).unwrap().version);
}

#[test]
fn counts_are_optional_and_never_change_the_snapshot_version() {
    let root = TempRepository::new("optional-counts");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), b"base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), b"first\nsecond\n").unwrap();
    let project = root.project(&root.0);

    let complete = snapshot(&project, true, MemoUse::Reuse).unwrap().repository;
    let state = snapshot(&project, false, MemoUse::Refresh)
        .unwrap()
        .repository;
    assert_eq!(complete.version, state.version);
    assert_eq!(complete.files[0].added, Some(2));
    assert!(state.files[0].added.is_none());
    assert!(state.files[0].deleted.is_none());
}

#[test]
fn numstat_rereads_only_changed_paths_and_keeps_full_diff_counts() {
    let root = TempRepository::new("numstat-memo");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    for (name, content) in [
        ("a", "1\n2\n"),
        ("b", "1\n2\n"),
        ("c", "1\n"),
        ("d", "keep\n"),
    ] {
        fs::write(root.0.join(name), content).unwrap();
    }
    root.git(&root.0, &["add", "."]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("a"), b"1\n2\n3\n").unwrap();
    fs::write(root.0.join("b"), b"1\n").unwrap();
    fs::write(root.0.join("c"), b"1\nx\n").unwrap();
    root.git(&root.0, &["add", "c"]);
    root.git(&root.0, &["mv", "d", "e"]);
    let project = root.project(&root.0);
    let memos = ReadMemoStore::default();
    let read = || {
        let repository = snapshot_with_memos(&memos, &project, true, MemoUse::Reuse)
            .unwrap()
            .repository;
        let stats = take_snapshot_stats().unwrap();
        let counts = repository
            .files
            .into_iter()
            .map(|file| (file.path, (file.added, file.deleted)))
            .collect::<HashMap<_, _>>();
        (counts, (stats.staged, stats.unstaged))
    };

    let (first, reads) = read();
    assert_eq!(reads, (NumstatRead::Partial(2), NumstatRead::Partial(2)));
    assert_eq!(first["a"], (Some(1), Some(0)));
    assert_eq!(first["b"], (Some(0), Some(1)));
    assert_eq!(first["c"], (Some(1), Some(0)));
    assert_eq!(first["e"], (Some(0), Some(0)));

    let (second, reads) = read();
    assert_eq!(reads, (NumstatRead::Cached, NumstatRead::Cached));
    assert_eq!(second, first);

    fs::write(root.0.join("a"), b"1\n2\n3\n4\n").unwrap();
    let (third, reads) = read();
    assert_eq!(reads, (NumstatRead::Cached, NumstatRead::Partial(1)));
    assert_eq!(third["a"], (Some(2), Some(0)));
    for path in ["b", "c", "e"] {
        assert_eq!(third[path], first[path]);
    }
}

#[cfg(unix)]
#[test]
fn settled_stamps_reuse_fingerprints_until_the_file_changes() {
    let root = TempRepository::new("fingerprint-memo");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), b"one\n").unwrap();
    let project = root.project(&root.0);
    let identity = discover_repository(&project).unwrap().identity.unwrap();
    let stamp = DiskRoot::new(&project, &identity)
        .unwrap()
        .metadata(b"file")
        .unwrap()
        .unwrap()
        .stamp
        .unwrap();
    let remembered = WorktreeFingerprint::Present {
        mode: "100644".into(),
        kind: "sha256",
        hash: "remembered".into(),
    };
    let mut previous = FingerprintMemo::default();
    let unsettled = FileStamp {
        settled: false,
        ..stamp.clone()
    };
    previous.remember(b"file", &unsettled, &remembered);
    assert_eq!(previous.stamp(b"file"), None);
    previous.remember(
        b"file",
        &FileStamp {
            settled: true,
            ..stamp
        },
        &remembered,
    );
    let scan = |previous: &FingerprintMemo| {
        let mut entries = vec![fingerprint_entry(b"file", b'?', b'?')];
        worktree_fingerprints(
            &project,
            &identity,
            &mut entries,
            previous,
            &mut FingerprintMemo::default(),
        )
        .unwrap()
    };

    let reused = scan(&previous);
    assert_eq!(reused.fingerprints, [remembered]);
    assert_eq!((reused.reused, reused.hashed), (1, 0));

    fs::write(root.0.join("file"), b"two\n").unwrap();
    File::options()
        .write(true)
        .open(root.0.join("file"))
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();
    let fresh = scan(&previous);
    assert_eq!(
        fresh.fingerprints,
        [WorktreeFingerprint::Present {
            mode: "100644".into(),
            kind: "sha256",
            hash: snapshot_version(b"two\n"),
        }]
    );
    assert_eq!((fresh.reused, fresh.hashed), (0, 1));
}

#[test]
fn read_memos_older_than_the_ttl_are_ignored() {
    let root = TempRepository::new("memo-ttl");
    root.git(&root.0, &["init", "-q"]);
    let project = root.project(&root.0);
    let identity = discover_repository(&project).unwrap().identity.unwrap();
    let key = snapshot_cache_key(&project);
    let memos = ReadMemoStore::default();
    let memo = |epoch| {
        let mut memo = ReadMemo::new(&identity);
        memo.epoch = epoch;
        memo.counts.remember(b"key".to_vec(), None);
        memo
    };

    let recent = Instant::now().checked_sub(memo::READ_MEMO_TTL / 2);
    memos.store(key.clone(), memo(recent));
    let valid = memos.get(&key, &identity);
    assert!(valid.counts.get(b"key").is_some());
    assert_eq!(valid.successor(&identity).epoch, recent);

    let expired = Instant::now().checked_sub(memo::READ_MEMO_TTL + Duration::from_secs(1));
    assert!(expired.is_some());
    memos.store(key.clone(), memo(expired));
    let ignored = memos.get(&key, &identity);
    assert!(ignored.counts.get(b"key").is_none());
    let restarted = ignored.successor(&identity).epoch.unwrap();
    assert!(restarted.elapsed() < memo::READ_MEMO_TTL);
}

#[cfg(unix)]
#[test]
fn mutation_validation_ignores_the_read_memo_and_refreshes_it() {
    let root = TempRepository::new("memo-refresh");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), b"base\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    fs::write(root.0.join("file"), b"changed\n").unwrap();
    let project = root.project(&root.0);
    let identity = discover_repository(&project).unwrap().identity.unwrap();
    let stamp = DiskRoot::new(&project, &identity)
        .unwrap()
        .metadata(b"file")
        .unwrap()
        .unwrap()
        .stamp
        .unwrap();
    let mut planted = ReadMemo::new(&identity);
    planted.fingerprints.remember(
        b"file",
        &FileStamp {
            settled: true,
            ..stamp
        },
        &WorktreeFingerprint::Present {
            mode: "100644".into(),
            kind: "sha256",
            hash: "stale".into(),
        },
    );
    let memos = ReadMemoStore::default();
    memos.store(snapshot_cache_key(&project), planted);
    let version = |include_counts, memo_use| {
        snapshot_with_memos(&memos, &project, include_counts, memo_use)
            .unwrap()
            .repository
            .version
    };

    let memoized = version(true, MemoUse::Reuse);
    let exact = version(false, MemoUse::Refresh);
    assert_ne!(memoized, exact);
    assert_eq!(version(true, MemoUse::Reuse), exact);
}

#[cfg(unix)]
#[test]
fn posix_metadata_script_hashes_new_stamps_and_skips_known_ones() {
    use std::{io::Write, process::Stdio};

    let root = TempRepository::new("posix-metadata");
    root.git(&root.0, &["init", "-q"]);
    fs::create_dir(root.0.join("dir")).unwrap();
    let spaced = "dir/a b é";
    fs::write(root.0.join(spaced), b"one\n").unwrap();
    fs::write(root.0.join("dir/plain"), b"two\n").unwrap();
    let numbered = "dir/a 1.txt";
    fs::write(root.0.join(numbered), b"three\n").unwrap();
    std::os::unix::fs::symlink("plain", root.0.join("dir/link")).unwrap();
    let paths: [&[u8]; 5] = [
        spaced.as_bytes(),
        b"dir/plain",
        numbered.as_bytes(),
        b"dir/link",
        b"dir/missing",
    ];
    let script = posix_metadata_script(&root.0.to_string_lossy(), true);
    let run = |known: &[Option<&str>]| {
        let mut input = Vec::new();
        for (path, known) in paths.iter().zip(known) {
            input.extend(remote_path_record(path).unwrap());
            input.push(b' ');
            input.extend(known.unwrap_or("-").as_bytes());
            input.push(b'\n');
        }
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        parse_remote_metadata(&output.stdout, known, true).unwrap()
    };
    let oid = |bytes: &[u8]| blob_oid(super::super::object_hash::ObjectFormat::Sha1, bytes);

    let first = run(&[None; 5]);
    assert!(
        matches!(&first[0], RemoteMetadata::Regular { oid: Some(hash), stamp: Some(_), .. } if *hash == oid(b"one\n"))
    );
    assert!(
        matches!(&first[1], RemoteMetadata::Regular { oid: Some(hash), stamp: Some(_), .. } if *hash == oid(b"two\n"))
    );
    assert!(
        matches!(&first[2], RemoteMetadata::Regular { oid: Some(hash), stamp: Some(_), .. } if *hash == oid(b"three\n"))
    );
    assert_eq!(first[3], RemoteMetadata::Symlink(b"plain".to_vec()));
    assert_eq!(first[4], RemoteMetadata::Missing);

    let stamps = first
        .iter()
        .map(|entry| match entry {
            RemoteMetadata::Regular { stamp, .. } => stamp.as_ref().map(|stamp| stamp.key.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let known = stamps.iter().map(Option::as_deref).collect::<Vec<_>>();
    let second = run(&known);
    for index in 0..3 {
        assert!(
            matches!(&second[index], RemoteMetadata::Regular { oid: None, stamp: Some(stamp), .. } if Some(stamp.key.as_str()) == known[index])
        );
    }
}

#[test]
fn untracked_files_do_not_receive_false_numstat_counts() {
    let root = TempRepository::new("untracked-counts");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), b"untracked\n").unwrap();
    let project = root.project(&root.0);

    let complete = snapshot(&project, true, MemoUse::Reuse).unwrap().repository;
    let state = snapshot(&project, false, MemoUse::Refresh)
        .unwrap()
        .repository;
    assert_eq!(complete.version, state.version);
    assert!(complete.files[0].added.is_none());
    assert!(complete.files[0].deleted.is_none());
}

#[test]
fn regular_file_count_does_not_multiply_git_commands() {
    let root = TempRepository::new("constant-command-count");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    let project = root.project(&root.0);
    fs::write(root.0.join("file-00"), b"content\n").unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    assert_eq!(repository(&project).unwrap().files.len(), 1);
    let one = super::super::TEST_GIT_COMMANDS.with(|count| count.get());
    for index in 1..50 {
        fs::write(root.0.join(format!("file-{index:02}")), b"content\n").unwrap();
    }
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    assert_eq!(repository(&project).unwrap().files.len(), 50);
    let fifty = super::super::TEST_GIT_COMMANDS.with(|count| count.get());
    assert!(fifty.abs_diff(one) <= 1, "one={one}, fifty={fifty}");
}

#[test]
fn operation_and_merge_message_change_the_snapshot_version() {
    let root = TempRepository::new("operation");
    root.git(&root.0, &["init", "-q"]);
    root.configure(&root.0);
    fs::write(root.0.join("file"), "content\n").unwrap();
    root.git(&root.0, &["add", "file"]);
    root.git(&root.0, &["commit", "-qm", "initial"]);
    let head = root.git(&root.0, &["rev-parse", "HEAD"]);
    let git_dir = root.0.join(".git");
    let project = root.project(&root.0);
    let idle = repository(&project).unwrap();
    fs::write(git_dir.join("MERGE_HEAD"), format!("{head}\n")).unwrap();
    fs::write(git_dir.join("MERGE_MSG"), "premier message\n").unwrap();
    let first = repository(&project).unwrap();
    fs::write(git_dir.join("MERGE_MSG"), "second message\n").unwrap();
    let second = repository(&project).unwrap();
    assert_eq!(first.operation.as_deref(), Some("merge"));
    assert_eq!(second.merge_message.as_deref(), Some("second message\n"));
    assert_ne!(idle.version, first.version);
    assert_ne!(first.version, second.version);
}

#[test]
fn unstaged_submodule_comparison_returns_submodule_metadata() {
    let root = TempRepository::new("submodule");
    let repository_path = root.0.join("repository");
    let module_path = repository_path.join("module");
    fs::create_dir_all(&module_path).unwrap();
    root.git(&repository_path, &["init", "-q"]);
    root.configure(&repository_path);
    root.git(&module_path, &["init", "-q"]);
    root.configure(&module_path);
    fs::write(module_path.join("file"), "one\n").unwrap();
    root.git(&module_path, &["add", "file"]);
    root.git(&module_path, &["commit", "-qm", "one"]);
    let first_oid = root.git(&module_path, &["rev-parse", "HEAD"]);
    root.git(
        &repository_path,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            &first_oid,
            "module",
        ],
    );
    root.git(&repository_path, &["commit", "-qm", "add module"]);
    fs::write(module_path.join("file"), "two\n").unwrap();
    root.git(&module_path, &["add", "file"]);
    root.git(&module_path, &["commit", "-qm", "two"]);

    let project = root.project(&repository_path);
    let state = repository(&project).unwrap();
    let file = state
        .files
        .iter()
        .find(|file| file.path == "module")
        .unwrap();
    assert!(file.submodule);
    assert!(file.actionable);
    let comparison = comparison(&project, "module", GitSide::Unstaged).unwrap();
    assert_eq!(comparison.after.reason.as_deref(), Some("submodule"));
    assert_eq!(comparison.after.mode, "160000");
    assert_eq!(comparison.after.size, 0);
    assert!(comparison.after.text.is_none());
}

fn failure_with_status(code: &str, status: &[u8]) -> SnapshotFailure {
    let project = local_project("project", "Projet", Path::new("/"));
    SnapshotFailure {
        error: GitError::new(code, "échec"),
        status: Some((project, status.to_vec())),
    }
}

#[test]
fn snapshot_retries_only_while_the_status_keeps_changing() {
    let mut attempts = 0;
    let recovered = retry_while_status_changes(
        || {
            attempts += 1;
            if attempts == 1 {
                Err(failure_with_status("inaccessible", b"before"))
            } else {
                Ok(attempts)
            }
        },
        |_, status| status != b"after",
    );
    assert_eq!(recovered.unwrap(), 2);

    let mut attempts = 0;
    let error = retry_while_status_changes::<()>(
        || {
            attempts += 1;
            Err(failure_with_status("malformed", b"stable"))
        },
        |_, status| status != b"stable",
    )
    .unwrap_err();
    assert_eq!((error.code.as_str(), attempts), ("malformed", 1));

    let mut attempts = 0;
    let error = retry_while_status_changes::<()>(
        || {
            attempts += 1;
            Err(failure_with_status("inaccessible", b"churn"))
        },
        |_, _| true,
    )
    .unwrap_err();
    assert_eq!(
        (error.code.as_str(), attempts),
        ("inaccessible", SNAPSHOT_ATTEMPTS)
    );
}

#[test]
fn snapshot_does_not_retry_timeouts_or_failures_before_status() {
    for failure in [
        || failure_with_status("timeout", b"before"),
        || SnapshotFailure::from(GitError::new("notRepo", "absent")),
    ] {
        let mut attempts = 0;
        let mut checks = 0;
        retry_while_status_changes::<()>(
            || {
                attempts += 1;
                Err(failure())
            },
            |_, _| {
                checks += 1;
                true
            },
        )
        .unwrap_err();
        assert_eq!((attempts, checks), (1, 0));
    }
}
