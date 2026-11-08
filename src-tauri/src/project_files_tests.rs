use super::*;
use crate::{agent_sessions::AgentEnvironment, project_git::test_fixtures::local_project};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

struct TempProject(PathBuf);

impl TempProject {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "soreno-project-files-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn project(&self) -> AgentProject {
        local_project("project", "Project", &self.0)
    }

    fn git_init(&self) -> Option<std::process::ExitStatus> {
        match std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&self.0)
            .status()
        {
            Ok(status) => Some(status),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("git init failed: {error}"),
        }
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn validates_confined_paths() {
    assert!(validate_relative_path("src/file.ts", false).is_ok());
    for path in [
        "",
        "/tmp/file.ts",
        "../file.ts",
        "src/../file.ts",
        ".git/hooks/test.sh",
        ".GIT/config.json",
        "src\\file.ts",
    ] {
        assert_eq!(
            validate_relative_path(path, false).unwrap_err().code,
            "invalidPath"
        );
    }
}

#[test]
fn lists_directories_first_and_hides_git() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("src")).unwrap();
    fs::create_dir(temp.0.join(".git")).unwrap();
    fs::write(temp.0.join("z.txt"), "text").unwrap();
    fs::write(temp.0.join("image.png"), "png").unwrap();

    let listing = list(&temp.project(), "").unwrap();
    assert_eq!(
        listing.entries,
        vec![
            entry_value("", "src".into(), "directory"),
            entry_value("", "image.png".into(), "file"),
            entry_value("", "z.txt".into(), "file"),
        ]
    );
    assert!(!listing.truncated);
    assert!(!listing.entries[1].editable);
    assert!(listing.entries[1].previewable);
    assert!(listing.entries[2].editable);
}

#[cfg(unix)]
#[test]
fn lists_symlinks_as_unopenable_entries_locally_and_remotely() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("src")).unwrap();
    fs::write(temp.0.join("z.txt"), "text").unwrap();
    std::os::unix::fs::symlink(temp.0.join("z.txt"), temp.0.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(temp.0.join("src"), temp.0.join("linked-src")).unwrap();
    std::os::unix::fs::symlink(temp.0.join("missing"), temp.0.join("broken.png")).unwrap();
    let link = |name: &str, kind: &str| ProjectFileEntry {
        name: name.into(),
        path: name.into(),
        kind: kind.into(),
        editable: false,
        previewable: false,
        symlink: true,
    };
    let expected = vec![
        link("linked-src", "directory"),
        entry_value("", "src".into(), "directory"),
        link("broken.png", "file"),
        link("link.txt", "file"),
        entry_value("", "z.txt".into(), "file"),
    ];

    assert_eq!(list(&temp.project(), "").unwrap().entries, expected);
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_list_script(temp.0.to_str().unwrap(), ""))
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        parse_remote_listing(&output.stdout, "").unwrap().entries,
        expected
    );
    assert_eq!(search(&temp.project(), "link").unwrap().entries, vec![]);
}

#[test]
fn searches_nested_files_and_excludes_git_and_symlinks() {
    let temp = TempProject::new();
    fs::create_dir_all(temp.0.join("src/nested")).unwrap();
    fs::create_dir(temp.0.join(".git")).unwrap();
    fs::write(temp.0.join("src/nested/App.TSX"), "app").unwrap();
    fs::write(temp.0.join("src/image.png"), "png").unwrap();
    fs::write(temp.0.join(".git/hidden.ts"), "hidden").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&temp.0, temp.0.join("src/link")).unwrap();

    let project = temp.project();
    let matched = search(&project, "NESTED/app").unwrap();
    assert_eq!(
        matched.entries,
        vec![search_entry("src/nested/App.TSX".into())]
    );
    assert!(!matched.truncated);

    let src = search(&project, "src/").unwrap();
    assert_eq!(
        src.entries,
        vec![
            search_entry("src/image.png".into()),
            search_entry("src/nested/App.TSX".into()),
        ]
    );
    assert!(!src.entries[0].editable);
    assert!(src.entries[0].previewable);
    assert!(src.entries[1].editable);
    assert!(search(&project, "hidden").unwrap().entries.is_empty());
}

#[test]
fn excludes_files_matched_by_gitignore() {
    let temp = TempProject::new();
    let Some(status) = temp.git_init() else {
        return;
    };
    assert!(status.success());
    fs::create_dir_all(temp.0.join("ignored")).unwrap();
    fs::create_dir_all(temp.0.join("visible")).unwrap();
    fs::write(temp.0.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    fs::write(temp.0.join("ignored/match.ts"), "ignored").unwrap();
    fs::write(temp.0.join("visible/match.ts"), "visible").unwrap();
    fs::write(temp.0.join("visible/match.log"), "ignored").unwrap();

    let result = search(&temp.project(), "match").unwrap();
    assert_eq!(
        result.entries,
        vec![search_entry("visible/match.ts".into())]
    );
    assert!(!result.truncated);
}

#[test]
fn finds_git_ignored_files_only_once_recently_opened() {
    let temp = TempProject::new();
    let Some(status) = temp.git_init() else {
        return;
    };
    assert!(status.success());
    fs::write(temp.0.join(".gitignore"), "*.local\n").unwrap();
    fs::write(temp.0.join(".env.local"), "opened").unwrap();
    fs::write(temp.0.join("never.local"), "never opened").unwrap();
    fs::write(temp.0.join("env.ts"), "visible").unwrap();
    let project = temp.project();
    let recent = [".env.local".to_owned(), "env.ts".to_owned()];

    let result = search_with_refresh(&project, "local", false, &recent).unwrap();
    assert_eq!(result.entries, vec![search_entry(".env.local".into())]);
    assert_eq!(result.recent_count, 1);

    let result = search_with_refresh(&project, "env", false, &recent).unwrap();
    assert_eq!(
        result.entries,
        vec![
            search_entry("env.ts".into()),
            search_entry(".env.local".into())
        ]
    );
    assert_eq!(result.recent_count, 2);
    assert!(search(&project, "local").unwrap().entries.is_empty());
}

#[test]
fn refreshes_the_cached_git_inventory_explicitly() {
    let temp = TempProject::new();
    let Some(status) = temp.git_init() else {
        return;
    };
    assert!(status.success());
    let project = temp.project();
    fs::write(temp.0.join("first.ts"), "first").unwrap();
    assert_eq!(search(&project, "first").unwrap().entries.len(), 1);

    fs::write(temp.0.join("second.ts"), "second").unwrap();
    assert_eq!(
        search_with_refresh(&project, "second", true, &[])
            .unwrap()
            .entries,
        vec![search_entry("second.ts".into())]
    );
}

#[test]
fn refresh_to_non_git_invalidates_the_cached_inventory() {
    let temp = TempProject::new();
    let Some(status) = temp.git_init() else {
        return;
    };
    assert!(status.success());
    let project = temp.project();
    fs::write(temp.0.join("first.ts"), "first").unwrap();
    assert_eq!(search(&project, "first").unwrap().entries.len(), 1);

    fs::remove_dir_all(temp.0.join(".git")).unwrap();
    fs::write(temp.0.join("second.ts"), "second").unwrap();
    assert_eq!(
        search_with_refresh(&project, "second", true, &[])
            .unwrap()
            .entries,
        vec![search_entry("second.ts".into())]
    );

    fs::write(temp.0.join("third.ts"), "third").unwrap();
    assert_eq!(
        search(&project, "third").unwrap().entries,
        vec![search_entry("third.ts".into())]
    );
}

#[test]
fn bounds_file_search_results() {
    let temp = TempProject::new();
    for index in 0..=SEARCH_RESULT_LIMIT {
        fs::write(temp.0.join(format!("match-{index:03}.txt")), "text").unwrap();
    }
    let result = search(&temp.project(), "match-").unwrap();
    assert_eq!(result.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(result.truncated);
    assert_eq!(result.entries[0].path, "match-000.txt");

    fs::remove_file(temp.0.join(format!("match-{SEARCH_RESULT_LIMIT:03}.txt"))).unwrap();
    assert!(!search(&temp.project(), "match-").unwrap().truncated);
}

#[cfg(unix)]
#[test]
fn processes_the_collected_batch_when_the_scan_limit_is_reached() {
    let temp = TempProject::new();
    for index in 0..=FALLBACK_SEARCH_SCAN_LIMIT {
        File::create(temp.0.join(format!("match-{index:05}.txt"))).unwrap();
    }

    let result = search(&temp.project(), "match-").unwrap();
    assert_eq!(result.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(result.truncated);
}

#[test]
fn git_inventory_depth_counts_directories_not_the_file() {
    let allowed = "d/".repeat(SEARCH_DEPTH_LIMIT) + "match.txt";
    let rejected = format!("d/{allowed}");
    let inventory = format!("{allowed}\0{rejected}\0");
    let (inventory, inventory_truncated) = parse_git_inventory(inventory.as_bytes());

    let candidates = git_search_candidates(&inventory, "match");
    assert_eq!(candidates, vec![allowed.as_str()]);
    assert!(inventory_truncated);
}

#[test]
fn searches_the_complete_git_inventory_and_ranks_file_names() {
    let mut inventory: Vec<GitInventoryPath> = (0..20_001)
        .map(|index| GitInventoryPath::new(format!("generated/file-{index:05}.txt")))
        .collect();
    inventory.extend(
        [
            "src/components/AgentForms.tsx",
            "docs/agent-forms.md",
            "agentForms.test.ts",
        ]
        .map(|path| GitInventoryPath::new(path.into())),
    );

    let tail = git_search_candidates(&inventory, "file-20000");
    assert_eq!(tail, vec!["generated/file-20000.txt"]);

    let ranked = git_search_candidates(&inventory, "agtfrm");
    assert_eq!(ranked.first().unwrap(), &"src/components/AgentForms.tsx");
    assert!(ranked.contains(&"agentForms.test.ts"));
}

#[test]
fn git_search_orders_equal_scores_by_normalized_then_original_path() {
    let inventory = ["B/amatch.ts", "a/zmatch.ts", "a/Zmatch.ts"]
        .map(|path| GitInventoryPath::new(path.into()));

    assert_eq!(
        git_search_candidates(&inventory, "match"),
        vec!["a/Zmatch.ts", "a/zmatch.ts", "B/amatch.ts"]
    );
}

#[test]
fn git_search_skips_more_than_one_hundred_deleted_candidates() {
    let temp = TempProject::new();
    fs::write(temp.0.join("match-999.txt"), "valid").unwrap();
    let mut inventory: Vec<GitInventoryPath> = (0..=SEARCH_RESULT_LIMIT)
        .map(|index| GitInventoryPath::new(format!("match-{index:03}.txt")))
        .collect();
    inventory.push(GitInventoryPath::new("match-999.txt".into()));

    let candidates = git_search_candidates(&inventory, "match");
    let result = search_git_local(&temp.project(), &candidates, false).unwrap();

    assert_eq!(result.entries, vec![search_entry("match-999.txt".into())]);
    assert!(!result.truncated);
}

#[test]
fn posix_git_search_batches_past_invalid_candidates_and_truncates_results() {
    let invalid: Vec<_> = (0..=SEARCH_RESULT_LIMIT)
        .map(|index| format!("missing-{index:03}.txt"))
        .collect();
    let mut candidates: Vec<_> = invalid.iter().map(String::as_str).collect();
    candidates.push("match-999.txt");
    let mut calls = 0;
    let result = search_git_posix(&candidates, false, |input| {
        calls += 1;
        Ok(input
            .split(|byte| *byte == 0)
            .filter(|path| *path == b"match-999.txt")
            .flat_map(|path| path.iter().copied().chain(std::iter::once(0)))
            .collect())
    })
    .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(result.entries, vec![search_entry("match-999.txt".into())]);
    assert!(!result.truncated);

    let valid: Vec<_> = (0..=SEARCH_RESULT_LIMIT)
        .map(|index| format!("match-{index:03}.txt"))
        .collect();
    let candidates: Vec<_> = valid.iter().map(String::as_str).collect();
    let result = search_git_posix(&candidates, false, |input| Ok(input.to_vec())).unwrap();
    assert_eq!(result.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(result.truncated);
}

#[test]
fn validates_the_complete_wsl_inventory_before_caching() {
    let inventory = (0..=SEARCH_RESULT_LIMIT)
        .map(|index| format!("src/file-{index:03}.ts\0"))
        .chain(["linked/file.ts\0".into(), "missing.ts\0".into()])
        .collect::<String>();
    let parsed = parse_git_inventory(inventory.as_bytes());
    let mut calls = 0;
    let (validated, truncated) = validate_git_inventory_posix(parsed, |input| {
        calls += 1;
        let received = input
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(received.len(), SEARCH_RESULT_LIMIT + 3);
        let mut output = input
            .split(|byte| *byte == 0)
            .filter(|path| path.starts_with(b"src/"))
            .flat_map(|path| path.iter().copied().chain(std::iter::once(0)))
            .collect::<Vec<_>>();
        output.extend_from_slice(b"../invalid.ts\0");
        Ok(output)
    })
    .unwrap();

    assert_eq!(calls, 1);
    assert_eq!(validated.len(), SEARCH_RESULT_LIMIT + 1);
    assert!(validated
        .iter()
        .all(|path| path.original.starts_with("src/")));
    assert!(truncated);
}

#[test]
fn empty_wsl_inventory_skips_validation_transport() {
    let mut calls = 0;
    let (validated, truncated) = validate_git_inventory_posix((Vec::new(), false), |_| {
        calls += 1;
        Ok(Vec::new())
    })
    .unwrap();

    assert_eq!(calls, 0);
    assert!(validated.is_empty());
    assert!(!truncated);
}

#[test]
fn warm_wsl_search_is_in_memory_and_truncates_only_above_one_hundred() {
    let paths = (0..=SEARCH_RESULT_LIMIT)
        .map(|index| format!("match-{index:03}.ts"))
        .collect::<Vec<_>>();
    let hundred = paths[..SEARCH_RESULT_LIMIT]
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let exact = search_git_wsl(&hundred, false);
    assert_eq!(exact.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(!exact.truncated);

    let hundred_and_one = paths.iter().map(String::as_str).collect::<Vec<_>>();
    let overflow = search_git_wsl(&hundred_and_one, false);
    assert_eq!(overflow.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(overflow.truncated);
    assert!(search_git_wsl(&[], true).truncated);
}

#[test]
fn wsl_git_search_maps_only_the_missing_root_marker() {
    let missing = wsl_filter_error(crate::project_git::GitError::new(
        "failed",
        "SORENO_FILE_NOT_DIRECTORY",
    ));
    assert_eq!(missing.code, "notDirectory");

    let other = wsl_filter_error(crate::project_git::GitError::new("failed", "boom"));
    assert_eq!(other.code, "wsl");
    assert_eq!(other.message, "boom");
}

#[test]
fn empty_refresh_populates_git_cache_but_returns_no_entries() {
    let temp = TempProject::new();
    let Some(status) = temp.git_init() else {
        return;
    };
    assert!(status.success());
    fs::write(temp.0.join("cached.ts"), "cached").unwrap();
    let project = temp.project();

    let refreshed = search_with_refresh(&project, "", true, &[".env".into()]).unwrap();
    assert_eq!(refreshed, ProjectFileSearchResult::default());
    assert_eq!(search(&project, "cached").unwrap().entries.len(), 1);
}

#[test]
fn empty_non_git_refresh_does_not_walk_the_project() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("nested")).unwrap();
    fs::write(temp.0.join("nested/match.ts"), "match").unwrap();

    assert_eq!(
        search_with_refresh(&temp.project(), "", true, &[]).unwrap(),
        ProjectFileSearchResult::default()
    );
}

fn inventory(path: &str) -> CachedGitInventory {
    CachedGitInventory {
        paths: Arc::new(vec![GitInventoryPath::new(path.into())]),
        truncated: false,
    }
}

fn cached_path(state: &mut SearchCacheState, key: &SearchCacheKey) -> Option<String> {
    state
        .get(key)
        .map(|cached| cached.paths[0].original.clone())
}

#[test]
fn concurrent_acquisitions_of_distinct_projects_are_all_cached() {
    let temp = TempProject::new();
    let first_key = search_cache_key(&temp.project());
    let mut second_project = temp.project();
    second_project.id = "second".into();
    let second_key = search_cache_key(&second_project);
    let mut state = SearchCacheState::new();
    let first = state.begin_acquisition(&first_key);
    let second = state.begin_acquisition(&second_key);

    state.publish(&second_key, second, inventory("second.ts"));
    state.publish(&first_key, first, inventory("first.ts"));
    state.discard(&second_key);
    state.invalidate(&second_key);

    assert_eq!(
        cached_path(&mut state, &first_key).as_deref(),
        Some("first.ts")
    );
    assert_eq!(cached_path(&mut state, &second_key), None);
}

#[test]
fn stale_acquisitions_cannot_publish_over_newer_cache() {
    let temp = TempProject::new();
    let key = search_cache_key(&temp.project());
    let mut state = SearchCacheState::new();
    let stale = state.begin_acquisition(&key);
    let current = state.begin_acquisition(&key);

    state.publish(&key, current, inventory("new.ts"));
    state.publish(&key, stale, inventory("old.ts"));

    assert_eq!(cached_path(&mut state, &key).as_deref(), Some("new.ts"));
}

#[test]
fn least_recently_used_projects_are_evicted() {
    let temp = TempProject::new();
    let keys: Vec<_> = (0..9)
        .map(|index| {
            let mut project = temp.project();
            project.id = format!("project-{index}");
            search_cache_key(&project)
        })
        .collect();
    let mut state = SearchCacheState::new();
    for key in &keys[..8] {
        let token = state.begin_acquisition(key);
        state.publish(key, token, inventory("cached.ts"));
    }
    assert!(state.get(&keys[0]).is_some());

    let token = state.begin_acquisition(&keys[8]);
    state.publish(&keys[8], token, inventory("cached.ts"));

    assert!(state.get(&keys[0]).is_some());
    assert!(state.get(&keys[1]).is_none());
    assert!(state.get(&keys[8]).is_some());
}

#[test]
fn invalidation_clears_matching_key_despite_concurrent_acquisition() {
    let temp = TempProject::new();
    let key = search_cache_key(&temp.project());
    let mut state = SearchCacheState::new();
    let seed = state.begin_acquisition(&key);
    state.publish(&key, seed, inventory("stale.ts"));
    let _refresh = state.begin_acquisition(&key);
    state.begin_acquisition(&key);

    state.invalidate(&key);

    assert!(state.get(&key).is_none());
}

#[test]
fn discard_clears_key_and_rejects_in_flight_publication() {
    let temp = TempProject::new();
    let key = search_cache_key(&temp.project());
    let mut state = SearchCacheState::new();
    let seed = state.begin_acquisition(&key);
    state.publish(&key, seed, inventory("stale.ts"));
    let in_flight = state.begin_acquisition(&key);

    state.discard(&key);
    state.publish(&key, in_flight, inventory("pre-mutation.ts"));

    assert!(state.get(&key).is_none());
}

#[test]
fn cache_key_includes_the_complete_ssh_identity() {
    let temp = TempProject::new();
    let mut project = temp.project();
    project.environment.kind = "ssh".into();
    project.environment.ssh = Some(crate::ssh::SshConnection {
        host: "host-a".into(),
        user: Some("user-a".into()),
        port: Some(22),
        identity_file: Some("key-a".into()),
        host_key: Some("host-key-a".into()),
    });
    let original = search_cache_key(&project);

    for connection in [
        crate::ssh::SshConnection {
            host: "host-b".into(),
            ..project.environment.ssh.clone().unwrap()
        },
        crate::ssh::SshConnection {
            user: Some("user-b".into()),
            ..project.environment.ssh.clone().unwrap()
        },
        crate::ssh::SshConnection {
            port: Some(2222),
            ..project.environment.ssh.clone().unwrap()
        },
        crate::ssh::SshConnection {
            identity_file: Some("key-b".into()),
            ..project.environment.ssh.clone().unwrap()
        },
        crate::ssh::SshConnection {
            host_key: Some("host-key-b".into()),
            ..project.environment.ssh.clone().unwrap()
        },
    ] {
        project.environment.ssh = Some(connection);
        assert_ne!(search_cache_key(&project), original);
    }
}

#[test]
fn reads_writes_and_rejects_stale_versions() {
    let temp = TempProject::new();
    fs::write(temp.0.join("note.md"), "first\r\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.0.join("note.md"), fs::Permissions::from_mode(0o640)).unwrap();
    }
    let project = temp.project();
    let opened = read(&project, "note.md").unwrap();
    assert_eq!(opened.content, "first\r\n");

    let saved = write(&project, "note.md", "second\r\n".into(), &opened.version).unwrap();
    assert_eq!(read(&project, "note.md").unwrap().version, saved.version);
    assert_eq!(
        fs::read_to_string(temp.0.join("note.md")).unwrap(),
        "second\r\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(temp.0.join("note.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }

    fs::write(temp.0.join("note.md"), "agent change\n").unwrap();
    let error = write(
        &project,
        "note.md",
        "editor change\n".into(),
        &saved.version,
    )
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(
        fs::read_to_string(temp.0.join("note.md")).unwrap(),
        "agent change\n"
    );
}

#[test]
fn only_one_concurrent_write_accepts_the_same_version() {
    let temp = TempProject::new();
    fs::write(temp.0.join("note.md"), "first\n").unwrap();
    let expected = read(&temp.project(), "note.md").unwrap().version;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for content in ["second\n", "third\n"] {
        let root = temp.0.clone();
        let expected = expected.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let project = local_project("project", "Project", &root);
            barrier.wait();
            write(&project, "note.md", content.into(), &expected)
        }));
    }

    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(error) if error.code == "conflict"))
            .count(),
        1
    );
}

#[test]
fn rejects_binary_and_invalid_utf8_originals_before_writing() {
    let temp = TempProject::new();
    let project = temp.project();
    for (name, bytes, code) in [
        ("binary.txt", b"a\0b".as_slice(), "binary"),
        ("invalid.txt", b"\xff".as_slice(), "encoding"),
    ] {
        fs::write(temp.0.join(name), bytes).unwrap();
        let error = write(&project, name, "replacement".into(), &version(bytes)).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(fs::read(temp.0.join(name)).unwrap(), bytes);
    }
}

#[cfg(windows)]
#[test]
fn rejects_windows_directory_reparse_points() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "outside").unwrap();
    match std::os::windows::fs::symlink_dir(&outside.0, temp.0.join("linked")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return,
        Err(error) => panic!("failed to create test directory symlink: {error}"),
    }

    let error = read(&temp.project(), "linked/secret.txt").unwrap_err();
    assert_eq!(error.code, "symlink");
    let error = write(
        &temp.project(),
        "linked/secret.txt",
        "replacement".into(),
        &version(b"outside"),
    )
    .unwrap_err();
    assert_eq!(error.code, "symlink");
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.txt")).unwrap(),
        "outside"
    );
}

#[test]
fn reads_text_and_images_and_rejects_invalid_binary_large_and_symlink_files() {
    let temp = TempProject::new();
    fs::write(temp.0.join("binary.png"), b"a\0b").unwrap();
    fs::write(temp.0.join("image.webp"), b"RIFF\x04\x00\x00\x00WEBPdata").unwrap();
    fs::write(temp.0.join(".env"), "TOKEN=value").unwrap();
    fs::write(temp.0.join("LICENSE"), "license").unwrap();
    File::create(temp.0.join("large.txt"))
        .unwrap()
        .set_len(FILE_LIMIT + 1)
        .unwrap();
    let project = temp.project();
    let env = read(&project, ".env").unwrap();
    assert_eq!(env.content, "TOKEN=value");
    write(&project, ".env", "TOKEN=updated".into(), &env.version).unwrap();
    assert_eq!(read(&project, ".env").unwrap().content, "TOKEN=updated");
    assert_eq!(read(&project, "LICENSE").unwrap().content, "license");
    let image = read(&project, "image.webp").unwrap();
    assert_eq!(image.media_type.as_deref(), Some("image/webp"));
    assert!(image.content.starts_with("data:image/webp;base64,"));
    assert_eq!(read(&project, "binary.png").unwrap_err().code, "binary");
    assert_eq!(read(&project, "large.txt").unwrap_err().code, "tooLarge");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.0.join("binary.png"), temp.0.join("link.txt")).unwrap();
        assert_eq!(read(&project, "link.txt").unwrap_err().code, "symlink");
    }
}

#[test]
fn downloads_binary_files_beyond_the_read_limit_even_over_the_source() {
    let temp = TempProject::new();
    let mut bytes = vec![0u8; FILE_LIMIT as usize + 1];
    bytes[0] = 7;
    fs::write(temp.0.join("archive.bin"), &bytes).unwrap();
    fs::create_dir(temp.0.join("folder")).unwrap();
    let project = temp.project();
    let outside = TempProject::new();
    let destination = outside.0.join("copy.bin");
    fs::write(&destination, "older").unwrap();

    download(&project, "archive.bin", &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    download(&project, "archive.bin", &temp.0.join("archive.bin")).unwrap();
    assert_eq!(fs::read(temp.0.join("archive.bin")).unwrap(), bytes);
    assert!(download(&project, "folder", &outside.0.join("folder")).is_err());
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o7777;
        let source = temp.0.join("archive.bin");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        download(&project, "archive.bin", &source).unwrap();
        assert_eq!(mode(&source), 0o600);
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
        download(&project, "archive.bin", &destination).unwrap();
        assert_eq!(mode(&destination), 0o640);
        fs::set_permissions(&source, fs::Permissions::from_mode(0o4750)).unwrap();
        let fresh = outside.0.join("fresh.bin");
        download(&project, "archive.bin", &fresh).unwrap();
        assert_eq!(mode(&fresh), 0o750);
    }
}

#[test]
fn reads_git_lfs_image_pointer_as_text() {
    let pointer =
        b"version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 123\n";

    let content = content_from_bytes("photo.png", pointer.to_vec()).unwrap();

    assert_eq!(content.content.as_bytes(), pointer);
    assert_eq!(content.media_type, None);
}

#[test]
fn accepts_avif_as_a_compatible_brand_for_mif1() {
    let bytes = b"\0\0\0\x14ftypmif1\0\0\0\0avif";

    assert!(valid_image_signature("image/avif", bytes));
}

#[test]
fn accepts_avis_as_a_compatible_brand_for_msf1() {
    let bytes = b"\0\0\0\x14ftypmsf1\0\0\0\0avis";

    assert!(valid_image_signature("image/avif", bytes));
}

#[test]
fn accepts_avif_with_an_extended_ftyp_size() {
    let bytes = b"\0\0\0\x01ftyp\0\0\0\0\0\0\0\x1cmsf1\0\0\0\0avif";

    assert!(valid_image_signature("image/avif", bytes));
}

#[test]
fn rejects_an_avif_primary_brand_in_a_truncated_ftyp_box() {
    let bytes = b"\0\0\0\x14ftypavif\0\0\0\0";

    assert!(!valid_image_signature("image/avif", bytes));
}

#[test]
fn treats_text_containing_ftyp_avif_as_text() {
    let bytes = b"testftypavif";

    let content = content_from_bytes("notes.avif", bytes.to_vec()).unwrap();

    assert_eq!(content.content.as_bytes(), bytes);
    assert_eq!(content.media_type, None);
}

#[test]
fn ignores_avif_brands_beyond_the_declared_ftyp_box() {
    let bytes = b"\0\0\0\x14ftypmif1\0\0\0\0heicavif";
    let truncated = b"\0\0\0\x18ftypmif1\0\0\0\0avif";

    assert!(!valid_image_signature("image/avif", bytes));
    assert!(!valid_image_signature("image/avif", truncated));
}

#[test]
fn parses_bounded_remote_directory_records() {
    let listing = parse_remote_listing(b"d\0src\0f\0App.tsx\0f\0image.png\0t\0\0", "").unwrap();
    assert!(listing.truncated);
    assert_eq!(
        listing.entries[0],
        entry_value("", "src".into(), "directory")
    );
    assert!(listing.entries[1].editable);
    assert!(!listing.entries[2].editable);
    assert!(listing.entries[2].previewable);
}

#[test]
fn remote_guard_quotes_every_descendant_component() {
    let guard = remote_guard("/srv/project", "src/a'b/file.ts");
    assert!(guard.contains("'/srv/project/src'"));
    assert!(guard.contains("'/srv/project/src/a'\"'\"'b'"));
    assert!(guard.contains("'/srv/project/src/a'\"'\"'b/file.ts'"));
}

#[cfg(unix)]
#[test]
fn remote_read_script_distinguishes_a_missing_file() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join(".soreno")).unwrap();
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_read_script(
            temp.0.to_str().unwrap(),
            ".soreno/services.json",
            FILE_LIMIT,
        ))
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("SORENO_FILE_NOT_FOUND"));
}

#[cfg(unix)]
#[test]
fn remote_write_script_honours_the_pre_rename_lock() {
    use std::io::Write;
    let temp = TempProject::new();
    fs::write(temp.0.join("notes.txt"), "before").unwrap();
    let script = remote_write_script(temp.0.to_str().unwrap(), "notes.txt", &version(b"before"));
    // uutils mkdir can exit 0 on a directory a racing writer created; `-p` makes that deterministic.
    let real_mkdir = std::process::Command::new("sh")
        .args(["-c", "command -v mkdir"])
        .output()
        .unwrap()
        .stdout;
    let shim = temp.0.with_extension("mkdir-shim");
    fs::create_dir(&shim).unwrap();
    fs::write(
        shim.join("mkdir"),
        format!(
            "#!/bin/sh\nexec {} -p \"$@\"\n",
            String::from_utf8(real_mkdir).unwrap().trim()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(shim.join("mkdir"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!("{}:{}", shim.display(), std::env::var("PATH").unwrap());
    let run = |input: Option<&[u8]>| {
        let stdin = if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        };
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .env("PATH", &path)
            .stdin(stdin)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input).unwrap();
        }
        child.wait_with_output().unwrap()
    };
    let legacy_lock = temp.0.join("notes.txt.telaoi.lock");
    fs::create_dir(&legacy_lock).unwrap();

    let output = run(None);

    assert_eq!(output.status.code(), Some(46));
    assert!(String::from_utf8_lossy(&output.stderr).contains("SORENO_FILE_CONFLICT"));
    assert!(legacy_lock.is_dir());
    assert!(!temp.0.join("notes.txt.soreno.lock").exists());
    assert_eq!(
        fs::read_to_string(temp.0.join("notes.txt")).unwrap(),
        "before"
    );

    fs::remove_dir(&legacy_lock).unwrap();
    let output = run(Some(b"after"));

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("notes.txt")).unwrap(),
        "after"
    );
    let mut entries: Vec<_> = fs::read_dir(&temp.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    entries.sort();
    assert_eq!(entries, ["notes.txt"]);
    fs::remove_dir_all(&shim).unwrap();
}

#[test]
fn remote_git_search_reaches_a_blocked_connection() {
    let project = AgentProject {
        id: "blocked-search".into(),
        name: "SSH".into(),
        path: "/srv/project".into(),
        environment: AgentEnvironment {
            kind: "ssh".into(),
            distribution: None,
            ssh: Some(crate::ssh::SshConnection {
                host: "blocked-search.invalid".into(),
                user: None,
                port: None,
                identity_file: None,
                host_key: None,
            }),
        },
        icon_data_url: None,
        icon: None,
        color: None,
    };
    let connection = project.environment.ssh.as_ref().unwrap();
    crate::ssh::block(connection);

    let result = search_git_remote(&project, &["src/App.tsx"], false);

    crate::ssh::unblock(connection);
    let error = result.unwrap_err();
    assert_eq!(error.code, "ssh");
    assert!(!error.message.contains("trop volumineuse"));
}

#[cfg(unix)]
#[test]
fn remote_git_filter_rejects_links_in_every_path_component() {
    let temp = TempProject::new();
    fs::write(temp.0.join("visible.ts"), "visible").unwrap();
    fs::create_dir(temp.0.join("real")).unwrap();
    fs::write(temp.0.join("real/secret.ts"), "secret").unwrap();
    fs::create_dir(temp.0.join("space\nname")).unwrap();
    fs::write(temp.0.join("space\nname/file name.ts"), "visible").unwrap();
    std::os::unix::fs::symlink(temp.0.join("visible.ts"), temp.0.join("link.ts")).unwrap();
    std::os::unix::fs::symlink(temp.0.join("real"), temp.0.join("linked")).unwrap();
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_git_filter_script(temp.0.to_str().unwrap()))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"visible.ts\0link.ts\0linked/secret.ts\0space\nname/file name.ts\0missing.ts\0")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"visible.ts\0space\nname/file name.ts\0");
}

#[cfg(unix)]
#[test]
fn remote_search_script_keeps_sibling_frames_and_skips_hidden_links() {
    let temp = TempProject::new();
    fs::create_dir_all(temp.0.join("a/nested")).unwrap();
    fs::create_dir_all(temp.0.join("b")).unwrap();
    fs::create_dir(temp.0.join(".git")).unwrap();
    fs::write(temp.0.join("a/nested/App.tsx"), "app").unwrap();
    fs::write(temp.0.join("b/App.tsx"), "app").unwrap();
    fs::write(temp.0.join(".git/App.tsx"), "hidden").unwrap();
    std::os::unix::fs::symlink(&temp.0, temp.0.join("a/link")).unwrap();

    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_search_script(&temp.project().path, "APP"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = parse_remote_search(&output.stdout).unwrap();
    assert_eq!(
        result.entries,
        vec![
            search_entry("a/nested/App.tsx".into()),
            search_entry("b/App.tsx".into()),
        ]
    );
    assert!(!result.truncated);
}

#[cfg(unix)]
#[test]
fn remote_search_script_reports_normal_truncation_under_set_e() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("matches")).unwrap();
    for index in 0..=SEARCH_RESULT_LIMIT {
        fs::write(
            temp.0.join(format!("matches/match-{index:03}.txt")),
            "match",
        )
        .unwrap();
    }
    fs::write(temp.0.join("z.txt"), "after recursion").unwrap();

    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(remote_search_script(&temp.project().path, "match"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = parse_remote_search(&output.stdout).unwrap();
    assert_eq!(result.entries.len(), SEARCH_RESULT_LIMIT);
    assert!(result.truncated);
}

#[test]
fn remote_search_quotes_queries_and_parses_bounded_results() {
    let query = "a'$(touch /tmp/soreno)*";
    let script = remote_search_script("/srv/project", query);
    assert!(script.contains(&format!("query={};", crate::ssh::quote(query))));

    let result = parse_remote_search(b"f\0src/App.tsx\0f\0image.png\0t\0\0").unwrap();
    assert!(result.truncated);
    assert_eq!(result.entries[0], search_entry("image.png".into()));
    assert_eq!(result.entries[1], search_entry("src/App.tsx".into()));
    assert!(!result.entries[0].editable);
    assert!(result.entries[0].previewable);
    assert!(result.entries[1].editable);
}
