use super::*;
use crate::agent_sessions::tests::unique_temp_path;
use crate::project_git::{
    repository,
    test_fixtures::{git_with_config_identity, local_project},
};
use std::path::PathBuf;

struct TempRepository {
    root: PathBuf,
    repository: PathBuf,
    sessions: AgentSessions,
}

impl TempRepository {
    fn new() -> Self {
        let root = unique_temp_path("soreno-git-branches");
        let repository = root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        // Git reports worktrees by real path; macOS temp_dir() goes through the /var symlink.
        let root = std::fs::canonicalize(root).unwrap();
        let repository = root.join("repository");
        let sessions = AgentSessions::open(&root.join("app-data")).unwrap();
        let temp = Self {
            root,
            repository,
            sessions,
        };
        temp.git(&["init", "-q"]);
        temp.git(&["config", "--local", "core.autocrlf", "false"]);
        temp.git(&["config", "--local", "core.eol", "lf"]);
        temp.sessions
            .save_project(local_project("project", "Project", &temp.repository))
            .unwrap();
        std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
        std::fs::write(temp.repository.join(".gitignore"), "local-only\n").unwrap();
        temp.git(&["add", "tracked", ".gitignore"]);
        temp.git(&["commit", "-qm", "initial"]);
        temp
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.repository, args)
    }

    fn git_at(&self, directory: &std::path::Path, args: &[&str]) -> String {
        git_with_config_identity(&self.root, directory, args)
    }

    fn project(&self) -> AgentProject {
        self.sessions.project("project").unwrap()
    }

    fn project_at(&self, id: &str, path: &std::path::Path) -> AgentProject {
        local_project(id, "Project", path)
    }

    fn version(&self) -> String {
        repository(&self.project()).unwrap().version
    }

    fn worktree_at(&self, path: &std::path::Path) -> GitWorktree {
        worktrees(&self.project())
            .unwrap()
            .into_iter()
            .find(|worktree| {
                same_worktree_path(
                    &self.project().environment,
                    &worktree.path,
                    &path.to_string_lossy(),
                )
            })
            .unwrap()
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn reads_refs_from_subdirectories_and_bare_repositories_without_weakening_mutations() {
    let temp = TempRepository::new();
    temp.git(&["branch", "feature"]);
    temp.git(&["config", "diff.relative", "true"]);
    let nested = temp.repository.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let nested_project = temp.project_at("nested", &nested);

    super::super::version(&nested_project).unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let nested_branches = branches(&nested_project).unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 1));
    assert_eq!(nested_branches, branches(&temp.project()).unwrap());

    let bare = temp.root.join("bare.git");
    temp.git(&["clone", "-q", "--bare", ".", bare.to_str().unwrap()]);
    let bare_project = temp.project_at("bare", &bare);
    let bare_repository = repository(&bare_project).unwrap();
    assert_eq!(bare_repository.availability, "bare");
    assert_eq!(
        branches(&bare_project).unwrap(),
        branches(&temp.project()).unwrap()
    );
    temp.sessions.save_project(bare_project).unwrap();
    assert_eq!(
        create_branch(
            &temp.sessions,
            "bare",
            "refused".into(),
            &bare_repository.version,
        )
        .unwrap_err()
        .code,
        "unavailable"
    );
}

#[test]
fn creates_switches_tracks_and_refuses_unsafe_switches() {
    let temp = TempRepository::new();
    let initial = temp.git(&["branch", "--show-current"]);
    create_branch(&temp.sessions, "project", "feature".into(), &temp.version()).unwrap();
    assert_eq!(temp.git(&["branch", "--show-current"]), initial);
    let stale_clean_version = temp.version();
    std::fs::write(temp.repository.join("tracked"), "changed outside Soreno\n").unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "feature".into(),
            false,
            &stale_clean_version,
        )
        .unwrap_err()
        .code,
        "stale"
    );
    std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
    let version = temp.version();
    super::super::reset_test_git_commands();
    let switched =
        switch_branch(&temp.sessions, "project", "feature".into(), false, &version).unwrap();
    assert!((3..=4).contains(&super::super::test_git_commands()));
    assert_eq!(switched.oid, None);
    assert_eq!(temp.git(&["branch", "--show-current"]), "feature");
    std::fs::write(temp.repository.join("local-only"), "tracked on feature\n").unwrap();
    temp.git(&["add", "-f", "local-only"]);
    temp.git(&["commit", "-qm", "track ignored file"]);
    temp.git(&["switch", &initial]);
    std::fs::write(temp.repository.join("local-only"), "keep local\n").unwrap();
    assert!(repository(&temp.project()).unwrap().files.is_empty());
    assert!(switch_branch(
        &temp.sessions,
        "project",
        "feature".into(),
        false,
        &temp.version(),
    )
    .is_err());
    assert_eq!(temp.git(&["branch", "--show-current"]), initial);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("local-only")).unwrap(),
        "keep local\n"
    );
    std::fs::remove_file(temp.repository.join("local-only")).unwrap();
    switch_branch(
        &temp.sessions,
        "project",
        "feature".into(),
        false,
        &temp.version(),
    )
    .unwrap();

    temp.git(&["switch", "-q", "-c", "diverged"]);
    std::fs::write(temp.repository.join("tracked"), "diverged\n").unwrap();
    temp.git(&["commit", "-qam", "diverge tracked"]);
    temp.git(&["switch", "-q", "feature"]);
    temp.git(&["branch", "same-commit"]);
    std::fs::write(temp.repository.join("tracked"), "dirty\n").unwrap();
    switch_branch(
        &temp.sessions,
        "project",
        "same-commit".into(),
        false,
        &temp.version(),
    )
    .unwrap();
    assert_eq!(temp.git(&["branch", "--show-current"]), "same-commit");
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "dirty\n"
    );
    let head = temp.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "diverged".into(),
            false,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "dirty"
    );
    assert_eq!(temp.git(&["branch", "--show-current"]), "same-commit");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "dirty\n"
    );
    let dirty_version = temp.version();
    std::fs::write(temp.repository.join("tracked"), "dirty again\n").unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "diverged".into(),
            false,
            &dirty_version,
        )
        .unwrap_err()
        .code,
        "stale"
    );
    assert_eq!(temp.git(&["branch", "--show-current"]), "same-commit");
    let dirty_version = temp.version();
    std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "diverged".into(),
            false,
            &dirty_version,
        )
        .unwrap_err()
        .code,
        "stale"
    );
    assert_eq!(temp.git(&["branch", "--show-current"]), "same-commit");
    std::fs::write(
        temp.repository.join(".git/MERGE_HEAD"),
        format!("{}\n", temp.git(&["rev-parse", "HEAD"])),
    )
    .unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            initial.clone(),
            false,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "operation"
    );
    std::fs::remove_file(temp.repository.join(".git/MERGE_HEAD")).unwrap();

    temp.git(&["switch", "-q", "-c", "dir-file"]);
    std::fs::write(temp.repository.join("dir"), "file\n").unwrap();
    temp.git(&["add", "dir"]);
    temp.git(&["commit", "-qm", "add dir file"]);
    temp.git(&["switch", "-q", "same-commit"]);
    std::fs::create_dir(temp.repository.join("dir")).unwrap();
    std::fs::write(temp.repository.join("dir/local.txt"), "keep\n").unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "dir-file".into(),
            false,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "dirty"
    );
    assert_eq!(temp.git(&["branch", "--show-current"]), "same-commit");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("dir/local.txt")).unwrap(),
        "keep\n"
    );
    std::fs::remove_dir_all(temp.repository.join("dir")).unwrap();

    temp.git(&["switch", "--detach", "HEAD"]);
    create_branch(&temp.sessions, "project", "rescue".into(), &temp.version()).unwrap();
    assert!(temp.git(&["branch", "--show-current"]).is_empty());
    temp.git(&["switch", &initial]);

    let remote = temp.root.join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    temp.git(&["init", "--bare", remote.to_str().unwrap()]);
    temp.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    temp.git(&["push", "-u", "origin", "feature"]);
    temp.git(&["remote", "set-head", "origin", "feature"]);
    temp.git(&["branch", "-D", "feature"]);
    let listed = branches(&temp.project()).unwrap();
    assert!(listed
        .iter()
        .any(|branch| branch.name == "origin/feature" && branch.remote));
    assert!(!listed.iter().any(|branch| branch.name == "origin/HEAD"));
    std::fs::write(temp.repository.join("local-only"), "keep remote local\n").unwrap();
    assert_eq!(
        switch_branch(
            &temp.sessions,
            "project",
            "origin/feature".into(),
            true,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "dirty"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("local-only")).unwrap(),
        "keep remote local\n"
    );
    std::fs::remove_file(temp.repository.join("local-only")).unwrap();
    switch_branch(
        &temp.sessions,
        "project",
        "origin/feature".into(),
        true,
        &temp.version(),
    )
    .unwrap();
    assert_eq!(temp.git(&["branch", "--show-current"]), "feature");
    assert_eq!(
        temp.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/feature"
    );

    temp.git(&["switch", &initial]);
    let occupied = temp.root.join("occupied");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        occupied.to_str().unwrap(),
        "feature",
    ]);
    assert!(switch_branch(
        &temp.sessions,
        "project",
        "feature".into(),
        false,
        &temp.version(),
    )
    .is_err());
}

#[test]
fn removes_only_merged_non_current_local_branches() {
    let temp = TempRepository::new();
    let initial = temp.git(&["branch", "--show-current"]);
    temp.git(&["branch", "merged"]);

    let merged_oid = temp.git(&["rev-parse", "merged"]);
    remove_branch(
        &temp.sessions,
        "project",
        "merged".into(),
        &merged_oid,
        &temp.version(),
    )
    .unwrap();
    assert!(temp.git(&["branch", "--list", "merged"]).is_empty());

    temp.git(&["switch", "-c", "unmerged"]);
    std::fs::write(temp.repository.join("unmerged"), "unique\n").unwrap();
    temp.git(&["add", "unmerged"]);
    temp.git(&["commit", "-qm", "unmerged"]);
    temp.git(&["switch", &initial]);
    let unmerged_oid = temp.git(&["rev-parse", "unmerged"]);
    let error = remove_branch(
        &temp.sessions,
        "project",
        "unmerged".into(),
        &unmerged_oid,
        &temp.version(),
    )
    .unwrap_err();
    assert_eq!(error.code, "notMerged");
    assert_eq!(error.uncertain, None);
    assert_eq!(temp.git(&["branch", "--list", "unmerged"]), "unmerged");
    assert_eq!(
        remove_branch(
            &temp.sessions,
            "project",
            initial,
            &temp.git(&["rev-parse", "HEAD"]),
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "currentBranch"
    );
}

#[test]
fn refuses_to_remove_a_branch_that_moved_after_confirmation() {
    let temp = TempRepository::new();
    std::fs::write(temp.repository.join("tracked"), "next\n").unwrap();
    temp.git(&["commit", "-qam", "next"]);
    temp.git(&["branch", "merged", "HEAD~1"]);
    let version = temp.version();
    let expected_oid = branches(&temp.project())
        .unwrap()
        .into_iter()
        .find(|branch| branch.name == "merged")
        .unwrap()
        .oid;
    temp.git(&["branch", "-f", "merged", "HEAD"]);
    let moved_oid = temp.git(&["rev-parse", "merged"]);

    let error = remove_branch(
        &temp.sessions,
        "project",
        "merged".into(),
        &expected_oid,
        &version,
    )
    .unwrap_err();

    assert_eq!(error.code, "stale");
    assert_eq!(temp.git(&["rev-parse", "merged"]), moved_oid);
}

#[test]
fn lists_and_creates_registered_worktrees() {
    let temp = TempRepository::new();
    let initial = temp.git(&["branch", "--show-current"]);
    temp.git(&["branch", "feature/worktree"]);
    std::fs::write(temp.repository.join("dirty"), "kept\n").unwrap();
    let request = GitWorktreeRequest {
        id: "feature-worktree".into(),
        name: "Feature worktree".into(),
        parent_path: temp.root.to_string_lossy().into(),
        folder_name: "feature worktree".into(),
        branch: "feature/worktree".into(),
        remote: false,
        create_branch: false,
        version: temp.version(),
    };

    let created = create_worktree(&temp.sessions, "project", request).unwrap();
    assert_eq!(
        created.path,
        temp.root.join("feature worktree").to_string_lossy()
    );
    let registered = temp.sessions.project("feature-worktree").unwrap();
    assert_eq!(registered.id, created.id);
    assert_eq!(registered.path, created.path);
    assert_eq!(registered.environment, created.environment);
    assert_eq!(temp.git(&["branch", "--show-current"]), initial);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("dirty")).unwrap(),
        "kept\n"
    );
    let listed = worktrees(&temp.project()).unwrap();
    assert_eq!(listed.len(), 2);
    assert!(
        listed.iter().any(|worktree| {
            worktree.path == created.path && worktree.branch.as_deref() == Some("feature/worktree")
        }),
        "{listed:?}"
    );

    let direct = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "direct-worktree".into(),
            name: "Direct worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "direct worktree".into(),
            branch: "feature/direct".into(),
            remote: false,
            create_branch: true,
            version: temp.version(),
        },
    )
    .unwrap();
    assert_eq!(
        temp.git(&[
            "branch",
            "--list",
            "--format=%(refname:short)",
            "feature/direct"
        ]),
        "feature/direct"
    );
    assert!(worktrees(&temp.project()).unwrap().iter().any(|worktree| {
        worktree.path == direct.path && worktree.branch.as_deref() == Some("feature/direct")
    }));
    assert_eq!(temp.git(&["branch", "--show-current"]), initial);

    let duplicate = GitWorktreeRequest {
        id: "duplicate-worktree".into(),
        name: "Duplicate".into(),
        parent_path: temp.root.to_string_lossy().into(),
        folder_name: "duplicate worktree".into(),
        branch: "feature/worktree".into(),
        remote: false,
        create_branch: false,
        version: temp.version(),
    };
    assert!(create_worktree(&temp.sessions, "project", duplicate).is_err());
    assert!(temp.sessions.project("duplicate-worktree").is_err());
    assert!(!temp.root.join("duplicate worktree").exists());

    let remote = temp.root.join("remote.git");
    temp.git(&["init", "--bare", remote.to_str().unwrap()]);
    temp.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    temp.git(&["branch", "remote-topic"]);
    temp.git(&["push", "origin", "remote-topic"]);
    temp.git(&["branch", "-D", "remote-topic"]);

    let occupied = temp.root.join("occupied remote worktree");
    std::fs::create_dir(&occupied).unwrap();
    std::fs::write(occupied.join("keep"), "keep\n").unwrap();
    let occupied_error = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "occupied-remote-worktree".into(),
            name: "Occupied remote worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "occupied remote worktree".into(),
            branch: "origin/remote-topic".into(),
            remote: true,
            create_branch: false,
            version: temp.version(),
        },
    )
    .unwrap_err();
    assert_eq!(occupied_error.code, "destinationExists");
    assert_eq!(
        std::fs::read_to_string(occupied.join("keep")).unwrap(),
        "keep\n"
    );
    assert!(temp.git(&["branch", "--list", "remote-topic"]).is_empty());

    let remote_created = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "remote-worktree".into(),
            name: "Remote worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "remote worktree".into(),
            branch: "origin/remote-topic".into(),
            remote: true,
            create_branch: false,
            version: temp.version(),
        },
    )
    .unwrap();
    assert!(worktrees(&temp.project()).unwrap().iter().any(|worktree| {
        worktree.path == remote_created.path && worktree.branch.as_deref() == Some("remote-topic")
    }));
}

#[test]
fn removes_a_clean_worktree_its_branch_and_registration() {
    let temp = TempRepository::new();
    let path = temp.root.join("removed worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/remove",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("removed", &path))
        .unwrap();
    std::fs::write(path.join("unique"), "committed only on the worktree\n").unwrap();
    temp.git_at(&path, &["add", "unique"]);
    temp.git_at(&path, &["commit", "-qm", "unique worktree commit"]);

    let target = temp.worktree_at(&path.join("."));
    remove_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap();

    assert!(!path.exists());
    assert!(temp.git(&["branch", "--list", "feature/remove"]).is_empty());
    assert!(temp.sessions.project("removed").is_err());
}

#[test]
fn keeps_a_branch_that_advances_after_removal_preparation() {
    let temp = TempRepository::new();
    let path = temp.root.join("advanced worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/advanced",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("advanced", &path))
        .unwrap();
    let confirmed = temp.worktree_at(&path);
    let removal = prepare_worktree_removal(
        &temp.sessions,
        "project",
        &confirmed.path,
        &confirmed.head,
        confirmed.branch.as_deref(),
    )
    .unwrap();
    std::fs::write(path.join("late"), "late\n").unwrap();
    temp.git_at(&path, &["add", "late"]);
    temp.git_at(&path, &["commit", "-qm", "late commit"]);
    let advanced = temp.git_at(&path, &["rev-parse", "HEAD"]);

    let result = finish_worktree_removal(
        removal,
        &confirmed.path,
        &confirmed.head,
        None,
        "Worktree supprimé.",
    )
    .unwrap();

    assert!(!path.exists());
    assert!(result.warning.is_some());
    assert_eq!(temp.git(&["rev-parse", "feature/advanced"]), advanced);
    assert!(temp.sessions.project("advanced").is_err());
}

#[test]
fn ignores_an_inaccessible_unrelated_project_when_removing_a_worktree() {
    let temp = TempRepository::new();
    let path = temp.root.join("target worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/target",
        path.to_str().unwrap(),
    ]);
    let missing = temp.root.join("unrelated-missing");
    std::fs::create_dir(&missing).unwrap();
    temp.sessions
        .save_project(temp.project_at("unrelated-missing", &missing))
        .unwrap();
    std::fs::remove_dir(&missing).unwrap();
    let target = temp.worktree_at(&path);

    remove_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap();

    assert!(!path.exists());
    assert!(temp.sessions.project("unrelated-missing").is_ok());
}

#[test]
fn removes_a_linked_worktree_from_a_bare_repository_and_refuses_merge() {
    let temp = TempRepository::new();
    let bare = temp.root.join("linked.git");
    temp.git(&["clone", "-q", "--bare", ".", bare.to_str().unwrap()]);
    let linked = temp.root.join("bare linked worktree");
    temp.git_at(
        &bare,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "bare-feature",
            linked.to_str().unwrap(),
        ],
    );
    temp.sessions
        .save_project(temp.project_at("bare", &bare))
        .unwrap();
    temp.sessions
        .save_project(temp.project_at("bare-linked", &linked))
        .unwrap();
    let target = worktrees(&temp.sessions.project("bare").unwrap())
        .unwrap()
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some("bare-feature"))
        .unwrap();

    let error = merge_worktree(
        &temp.sessions,
        "bare",
        target.path.clone(),
        target.head.clone(),
        "bare-feature".into(),
        temp.git_at(&bare, &["symbolic-ref", "--short", "HEAD"]),
    )
    .unwrap_err();
    assert_eq!(error.code, "missingPrimaryWorktree");
    assert!(linked.exists());

    remove_worktree(
        &temp.sessions,
        "bare",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap();

    assert!(!linked.exists());
    assert!(temp
        .git_at(&bare, &["branch", "--list", "bare-feature"])
        .is_empty());
    assert!(temp.sessions.project("bare-linked").is_err());
    assert!(temp.sessions.project("bare").is_ok());
}

#[test]
fn refuses_dirty_and_primary_worktree_removal_without_deleting_data() {
    let temp = TempRepository::new();
    let path = temp.root.join("dirty worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/dirty",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("dirty", &path))
        .unwrap();
    std::fs::write(path.join("unsaved"), "keep\n").unwrap();

    let dirty = temp.worktree_at(&path);
    assert!(remove_worktree(
        &temp.sessions,
        "project",
        dirty.path,
        dirty.head,
        dirty.branch,
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(path.join("unsaved")).unwrap(),
        "keep\n"
    );
    assert!(temp
        .git(&["branch", "--list", "feature/dirty"])
        .contains("feature/dirty"));
    assert!(temp.sessions.project("dirty").is_ok());

    let primary = temp.worktree_at(&temp.repository);
    let error = remove_worktree(
        &temp.sessions,
        "project",
        temp.repository.join(".").to_string_lossy().into(),
        primary.head,
        primary.branch,
    )
    .unwrap_err();
    assert_eq!(error.code, "primaryWorktree");
    assert!(temp.repository.exists());
    assert!(temp.sessions.project("project").is_ok());
}

#[test]
fn rejects_stale_worktree_head_and_branch() {
    let temp = TempRepository::new();
    let path = temp.root.join("stale worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "stale",
        path.to_str().unwrap(),
    ]);
    let stale_head = temp.worktree_at(&path);
    std::fs::write(path.join("change"), "change\n").unwrap();
    temp.git_at(&path, &["add", "change"]);
    temp.git_at(&path, &["commit", "-qm", "change"]);

    assert_eq!(
        remove_worktree(
            &temp.sessions,
            "project",
            stale_head.path,
            stale_head.head,
            stale_head.branch,
        )
        .unwrap_err()
        .code,
        "stale"
    );

    let stale_branch = temp.worktree_at(&path);
    temp.git_at(&path, &["switch", "--detach", "HEAD"]);
    assert_eq!(
        remove_worktree(
            &temp.sessions,
            "project",
            stale_branch.path,
            stale_branch.head,
            stale_branch.branch,
        )
        .unwrap_err()
        .code,
        "stale"
    );
    assert!(path.exists());
}

#[test]
fn removes_from_a_secondary_only_registration_via_the_fresh_primary_path() {
    let temp = TempRepository::new();
    let path = temp.root.join("secondary only");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "secondary-only",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("secondary", &path))
        .unwrap();
    let target = temp.worktree_at(&path);
    temp.sessions.delete_project("project").unwrap();

    remove_worktree(
        &temp.sessions,
        "secondary",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap();

    assert!(!path.exists());
    assert!(temp.sessions.project("secondary").is_err());
    assert!(temp.git(&["branch", "--list", "secondary-only"]).is_empty());
}

#[cfg(unix)]
#[test]
fn refuses_to_remove_a_worktree_with_a_running_session_without_changing_anything() {
    use crate::agent_sessions::AgentSession;

    let temp = TempRepository::new();
    let path = temp.root.join("duplicate registrations");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "duplicates",
        path.to_str().unwrap(),
    ]);
    for id in ["duplicate-a", "duplicate-b"] {
        temp.sessions
            .save_project(temp.project_at(id, &path))
            .unwrap();
    }
    temp.sessions
        .save_session(AgentSession {
            id: "running-duplicate".into(),
            project_id: "duplicate-b".into(),
            name: "Running".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: "sh".into(),
            args: vec!["-c".into(), "sleep 60".into()],
            created_at: chrono::Utc::now().to_rfc3339(),
            favorite: false,
            design: false,
        })
        .unwrap();
    temp.sessions
        .start("running-duplicate", 80, 24, None)
        .unwrap();
    let target = temp.worktree_at(&path);

    let error = remove_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap_err();
    temp.sessions.stop("running-duplicate").unwrap();

    assert_eq!(error.code, "worktreeSessionsRunning");
    assert!(path.exists());
    assert!(!temp.git(&["branch", "--list", "duplicates"]).is_empty());
    assert!(temp.sessions.project("duplicate-a").is_ok());
    assert!(temp.sessions.project("duplicate-b").is_ok());
}

#[cfg(unix)]
#[test]
fn reports_branch_deletion_failure_without_exposing_hook_errors() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempRepository::new();
    let path = temp.root.join("warning worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "warning",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("warning", &path))
        .unwrap();
    let target = temp.worktree_at(&path);
    let marker = "SENSITIVE-BRANCH-DELETION-MARKER";
    let hook = temp.repository.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nif [ \"$1\" = prepared ] && grep -q ' refs/heads/warning$'; then\n  echo '{marker}' >&2\n  exit 1\nfi\nexit 0\n"
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let hook_error = execute(
        &temp.project(),
        &[
            "update-ref",
            "--no-deref",
            "-d",
            "refs/heads/warning",
            &target.head,
        ],
        GitOperation::LocalMutation,
        None,
    )
    .unwrap_err();
    assert!(hook_error.message.contains(marker));

    let result = remove_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        target.branch,
    )
    .unwrap();

    assert!(!path.exists());
    let warning = result.warning.unwrap();
    assert!(!warning.contains(marker), "{warning}");
    assert_eq!(temp.git(&["branch", "--list", "warning"]), "warning");
    assert!(temp.sessions.project("warning").is_err());
}

#[test]
fn merges_a_worktree_by_fast_forward_then_removes_it_and_its_branch() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("merged worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/merge",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("merged", &path))
        .unwrap();
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    let target = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        target.branch.unwrap(),
        "main".into(),
    )
    .unwrap();

    assert_eq!(temp.git(&["rev-parse", "HEAD"]), target.head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("feature")).unwrap(),
        "feature\n"
    );
    assert!(!path.exists());
    assert!(temp.git(&["branch", "--list", "feature/merge"]).is_empty());
    assert!(temp.sessions.project("merged").is_err());
}

#[cfg(unix)]
#[test]
fn refuses_to_merge_a_worktree_with_a_running_session_before_touching_the_base() {
    use crate::agent_sessions::AgentSession;

    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let base_head = temp.git(&["rev-parse", "HEAD"]);
    let path = temp.root.join("busy worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/busy",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("busy", &path))
        .unwrap();
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    temp.sessions
        .save_session(AgentSession {
            id: "running-busy".into(),
            project_id: "busy".into(),
            name: "Running".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: "sh".into(),
            args: vec!["-c".into(), "sleep 60".into()],
            created_at: chrono::Utc::now().to_rfc3339(),
            favorite: false,
            design: false,
        })
        .unwrap();
    temp.sessions.start("running-busy", 80, 24, None).unwrap();
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        target.branch.unwrap(),
        "main".into(),
    )
    .unwrap_err();
    temp.sessions.stop("running-busy").unwrap();

    assert_eq!(error.code, "worktreeSessionsRunning");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), base_head);
    assert!(path.exists());
    assert!(temp.sessions.project("busy").is_ok());
}

#[test]
fn refuses_to_overwrite_ignored_primary_files_when_merging() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("ignored worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/ignored",
        path.to_str().unwrap(),
    ]);
    temp.sessions
        .save_project(temp.project_at("ignored", &path))
        .unwrap();
    std::fs::write(temp.repository.join("local-only"), "keep\n").unwrap();
    std::fs::write(path.join("local-only"), "tracked on feature\n").unwrap();
    temp.git_at(&path, &["add", "-f", "local-only"]);
    temp.git_at(&path, &["commit", "-qm", "track ignored file"]);
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        "feature/ignored".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(
        std::fs::read_to_string(temp.repository.join("local-only")).unwrap(),
        "keep\n"
    );
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
    assert!(path.exists());
    assert!(temp
        .git(&["branch", "--list", "feature/ignored"])
        .contains("feature/ignored"));
    assert!(temp.sessions.project("ignored").is_ok());
}

#[test]
fn merges_despite_configured_squash_merge_options() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    temp.git(&["config", "branch.main.mergeOptions", "--squash"]);
    let path = temp.root.join("squash worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/squash",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    let target = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        target.branch.unwrap(),
        "main".into(),
    )
    .unwrap();

    assert_eq!(temp.git(&["rev-parse", "HEAD"]), target.head);
    assert!(!path.exists());
    assert!(temp.git(&["branch", "--list", "feature/squash"]).is_empty());
}

#[test]
fn refuses_dirty_worktree_merges_before_changing_anything() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("dirty merge worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/dirty-merge",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    std::fs::write(path.join("unsaved"), "keep\n").unwrap();
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let dirty = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        dirty.path,
        dirty.head,
        "feature/dirty-merge".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "worktreeDirty");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
    assert_eq!(
        std::fs::read_to_string(path.join("unsaved")).unwrap(),
        "keep\n"
    );
    assert!(temp
        .git(&["branch", "--list", "feature/dirty-merge"])
        .contains("feature/dirty-merge"));
}

#[test]
fn refuses_to_merge_into_a_dirty_primary_worktree() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("clean feature");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/clean",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    std::fs::write(temp.repository.join("unsaved"), "keep\n").unwrap();
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        "feature/clean".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "primaryDirty");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
    assert!(path.exists());
}

fn diverged_worktree(temp: &TempRepository, name: &str, main_content: (&str, &str)) -> PathBuf {
    temp.git(&["branch", "-M", "main"]);
    temp.git(&["config", "--local", "user.name", "Soreno Test"]);
    temp.git(&["config", "--local", "user.email", "test@soreno.invalid"]);
    temp.git(&["config", "--local", "commit.gpgSign", "false"]);
    let path = temp.root.join(name);
    temp.git(&["worktree", "add", "-q", "-b", name, path.to_str().unwrap()]);
    std::fs::write(path.join("tracked"), "feature\n").unwrap();
    temp.git_at(&path, &["commit", "-qam", "feature commit"]);
    std::fs::write(temp.repository.join(main_content.0), main_content.1).unwrap();
    temp.git(&["add", main_content.0]);
    temp.git(&["commit", "-qm", "main commit"]);
    path
}

#[test]
fn integrates_a_diverged_worktree_despite_dangerous_merge_options() {
    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "clean-merge", ("other", "main moved\n"));
    temp.git(&["config", "branch.main.mergeOptions", "-s ours --no-commit"]);
    temp.git(&[
        "config",
        "branch.clean-merge.mergeOptions",
        "-s ours --no-commit",
    ]);
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    temp.sessions
        .save_project(temp.project_at("clean-merge", &path))
        .unwrap();
    let target = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        "clean-merge".into(),
        "main".into(),
    )
    .unwrap();

    let integrated_head = temp.git(&["rev-parse", "HEAD"]);
    let synchronized_head = temp.git(&["rev-parse", "HEAD^2"]);
    assert_eq!(temp.git(&["rev-parse", "HEAD^1"]), main_head);
    assert_eq!(temp.git(&["rev-parse", "HEAD^2^1"]), target.head);
    assert_eq!(temp.git(&["rev-parse", "HEAD^2^2"]), main_head);
    assert_eq!(
        temp.git(&["log", "--first-parent", "--format=%s"]),
        "Merge branch 'clean-merge' into main\nmain commit\ninitial"
    );
    assert_ne!(integrated_head, synchronized_head);
    assert_eq!(temp.git(&["rev-parse", "main"]), integrated_head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "feature\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("other")).unwrap(),
        "main moved\n"
    );
    assert!(!path.exists());
    assert!(temp.git(&["branch", "--list", "clean-merge"]).is_empty());
    assert!(temp.sessions.project("clean-merge").is_err());
}

#[test]
fn merges_branches_containing_equals_when_merge_options_are_absent() {
    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "feature=2", ("other", "main moved\n"));
    temp.git(&["branch", "-M", "release/v=2"]);
    let target = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        "feature=2".into(),
        "release/v=2".into(),
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "feature\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("other")).unwrap(),
        "main moved\n"
    );
    assert!(!path.exists());
}

#[test]
fn refuses_ambiguous_merge_options_before_mutating_the_worktree() {
    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "feature=2", ("other", "main moved\n"));
    temp.git(&["branch", "-M", "release/v=2"]);
    temp.git(&["config", "branch.release/v=2.mergeOptions", "-s ours"]);
    let base_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        "feature=2".into(),
        "release/v=2".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "mergeOptions");
    assert!(error.message.contains("branch.release/v=2.mergeOptions"));
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), base_head);
    assert_eq!(temp.git_at(&path, &["rev-parse", "HEAD"]), target.head);
    assert!(repository(&temp.project_at("target", &path))
        .unwrap()
        .operation
        .is_none());
    assert!(path.exists());
}

#[test]
fn reads_signed_commit_parents_with_signature_display_enabled() {
    let temp = TempRepository::new();
    let parent = temp.git(&["rev-parse", "HEAD"]);
    let tree = temp.git(&["rev-parse", "HEAD^{tree}"]);
    let commit = temp.root.join("signed-commit");
    std::fs::write(
        &commit,
        format!(
            "tree {tree}\nparent {parent}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nsigned\n"
        ),
    )
    .unwrap();
    let signed = temp.git(&[
        "hash-object",
        "-t",
        "commit",
        "-w",
        commit.to_str().unwrap(),
    ]);
    temp.git(&["config", "log.showSignature", "true"]);
    temp.git(&["config", "gpg.program", "git"]);

    assert_eq!(commit_parents(&temp.project(), &signed).unwrap(), [parent]);
}

#[test]
fn leaves_conflicting_base_merges_in_the_worktree_without_touching_the_base() {
    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "conflict-merge", ("tracked", "main moved\n"));
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        "conflict-merge".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "mergeConflict");
    assert!(error.message.contains("tracked"));
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "main moved\n"
    );
    assert_eq!(temp.git_at(&path, &["rev-parse", "MERGE_HEAD"]), main_head);
    assert!(temp
        .git(&["branch", "--list", "conflict-merge"])
        .contains("conflict-merge"));

    let target = temp.worktree_at(&path);
    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        "conflict-merge".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "mergeConflict");
    assert!(error.message.contains("tracked"));
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
}

#[test]
fn integrates_a_conflict_resolution_without_reversing_the_final_parents() {
    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "resolved-merge", ("tracked", "main moved\n"));
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    assert_eq!(
        merge_worktree(
            &temp.sessions,
            "project",
            target.path,
            target.head.clone(),
            "resolved-merge".into(),
            "main".into(),
        )
        .unwrap_err()
        .code,
        "mergeConflict"
    );
    std::fs::write(path.join("tracked"), "resolved\n").unwrap();
    temp.git_at(&path, &["add", "tracked"]);
    let resolved = temp.worktree_at(&path);
    assert_eq!(
        merge_worktree(
            &temp.sessions,
            "project",
            resolved.path,
            resolved.head,
            "resolved-merge".into(),
            "main".into(),
        )
        .unwrap_err()
        .code,
        "sourceMergePending"
    );
    temp.git_at(&path, &["commit", "-qm", "resolve base merge"]);
    let synchronized = temp.worktree_at(&path);

    merge_worktree(
        &temp.sessions,
        "project",
        synchronized.path,
        synchronized.head.clone(),
        "resolved-merge".into(),
        "main".into(),
    )
    .unwrap();

    assert_eq!(temp.git(&["rev-parse", "HEAD^1"]), main_head);
    assert_eq!(temp.git(&["rev-parse", "HEAD^2"]), synchronized.head);
    assert_eq!(temp.git(&["rev-parse", "HEAD^2^1"]), target.head);
    assert_eq!(temp.git(&["rev-parse", "HEAD^2^2"]), main_head);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "resolved\n"
    );
    assert!(!path.exists());
}

#[test]
fn refuses_to_merge_a_worktree_that_moved_after_confirmation() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("moved worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/moved",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "confirmed commit"]);
    let confirmed = temp.worktree_at(&path);
    std::fs::write(path.join("late"), "late\n").unwrap();
    temp.git_at(&path, &["add", "late"]);
    temp.git_at(&path, &["commit", "-qm", "late commit"]);
    let main_head = temp.git(&["rev-parse", "HEAD"]);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        confirmed.path,
        confirmed.head,
        "feature/moved".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "stale");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), main_head);
    assert!(path.join("late").exists());
    assert!(temp
        .git(&["branch", "--list", "feature/moved"])
        .contains("feature/moved"));
}

#[test]
fn refuses_to_merge_when_the_primary_worktree_is_not_on_the_expected_base() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("feature worktree");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/base",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    temp.git(&["switch", "-q", "-c", "release"]);
    let release_head = temp.git(&["rev-parse", "HEAD"]);
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        "feature/base".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "stale");
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), release_head);
    assert_eq!(temp.git(&["rev-parse", "main"]), release_head);
    assert!(path.exists());
    assert!(temp
        .git(&["branch", "--list", "feature/base"])
        .contains("feature/base"));
}

#[cfg(unix)]
#[test]
fn refuses_a_primary_branch_change_during_divergence_preparation() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempRepository::new();
    let path = diverged_worktree(&temp, "branch-race", ("other", "main moved\n"));
    let main_head = temp.git(&["rev-parse", "HEAD"]);
    let hooks = temp.root.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-merge");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nunset $(git rev-parse --local-env-vars)\ngit -C '{}' switch -q -c release\nrm -- \"$0\"\n",
            temp.repository.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    temp.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let target = temp.worktree_at(&path);

    let error = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head,
        "branch-race".into(),
        "main".into(),
    )
    .unwrap_err();

    assert_eq!(error.code, "stale");
    assert_eq!(temp.git(&["branch", "--show-current"]), "release");
    assert_eq!(temp.git(&["rev-parse", "main"]), main_head);
    assert!(path.exists());
    assert!(temp
        .git(&["branch", "--list", "branch-race"])
        .contains("branch-race"));
}

#[cfg(unix)]
#[test]
fn merges_while_a_session_runs_on_the_primary_worktree_like_pull() {
    use crate::agent_sessions::AgentSession;

    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    let path = temp.root.join("busy primary");
    temp.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/busy",
        path.to_str().unwrap(),
    ]);
    std::fs::write(path.join("feature"), "feature\n").unwrap();
    temp.git_at(&path, &["add", "feature"]);
    temp.git_at(&path, &["commit", "-qm", "feature commit"]);
    temp.sessions
        .save_session(AgentSession {
            id: "running-main".into(),
            project_id: "project".into(),
            name: "Running".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: "sh".into(),
            args: vec!["-c".into(), "sleep 60".into()],
            created_at: chrono::Utc::now().to_rfc3339(),
            favorite: false,
            design: false,
        })
        .unwrap();
    temp.sessions.start("running-main", 80, 24, None).unwrap();
    let target = temp.worktree_at(&path);

    let result = merge_worktree(
        &temp.sessions,
        "project",
        target.path,
        target.head.clone(),
        "feature/busy".into(),
        "main".into(),
    );
    temp.sessions.stop("running-main").unwrap();

    result.unwrap();
    assert_eq!(temp.git(&["rev-parse", "HEAD"]), target.head);
    assert!(!path.exists());
}

#[test]
fn rejects_symbolic_local_refs_without_touching_their_targets() {
    let temp = TempRepository::new();
    temp.git(&["branch", "-M", "main"]);
    temp.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    temp.git(&["symbolic-ref", "refs/heads/dangling", "refs/heads/missing"]);
    let main_oid = temp.git(&["rev-parse", "refs/heads/main"]);

    let error = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "alias-worktree".into(),
            name: "Alias worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "alias worktree".into(),
            branch: "alias".into(),
            remote: false,
            create_branch: true,
            version: temp.version(),
        },
    )
    .unwrap_err();

    assert_eq!(error.code, "branchExists");
    assert_eq!(
        temp.git(&["symbolic-ref", "refs/heads/alias"]),
        "refs/heads/main"
    );
    assert_eq!(temp.git(&["rev-parse", "refs/heads/main"]), main_oid);
    assert!(!temp.root.join("alias worktree").exists());

    let error = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "dangling-worktree".into(),
            name: "Dangling worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "dangling worktree".into(),
            branch: "dangling".into(),
            remote: false,
            create_branch: true,
            version: temp.version(),
        },
    )
    .unwrap_err();

    assert_eq!(error.code, "branchExists");
    assert_eq!(
        temp.git(&["symbolic-ref", "refs/heads/dangling"]),
        "refs/heads/missing"
    );
    assert!(temp.git(&["branch", "--list", "missing"]).is_empty());
    assert!(!temp.root.join("dangling worktree").exists());
}

#[test]
fn preserves_a_new_branch_when_worktree_checkout_fails() {
    let temp = TempRepository::new();
    std::fs::write(
        temp.repository.join(".gitattributes"),
        "filtered filter=fail\n",
    )
    .unwrap();
    std::fs::write(temp.repository.join("filtered"), "content\n").unwrap();
    temp.git(&["add", ".gitattributes", "filtered"]);
    temp.git(&["commit", "-qm", "add filtered file"]);
    temp.git(&["config", "filter.fail.clean", "cat"]);
    temp.git(&["config", "filter.fail.smudge", "false"]);
    temp.git(&["config", "filter.fail.required", "true"]);
    let destination = temp.root.join("failed worktree");

    let error = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "failed-worktree".into(),
            name: "Failed worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "failed worktree".into(),
            branch: "retryable".into(),
            remote: false,
            create_branch: true,
            version: temp.version(),
        },
    )
    .unwrap_err();
    assert!(error.message.contains("smudge filter fail failed"));
    assert!(!destination.exists());
    assert!(temp.sessions.project("failed-worktree").is_err());
    assert_eq!(temp.git(&["branch", "--list", "retryable"]), "retryable");

    temp.git(&["config", "filter.fail.smudge", "cat"]);
    create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "failed-worktree".into(),
            name: "Failed worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "failed worktree".into(),
            branch: "retryable".into(),
            remote: false,
            create_branch: false,
            version: temp.version(),
        },
    )
    .unwrap();
    assert!(destination.exists());
}

#[test]
fn preserves_a_tracking_branch_when_worktree_checkout_fails() {
    let temp = TempRepository::new();
    std::fs::write(
        temp.repository.join(".gitattributes"),
        "filtered filter=fail\n",
    )
    .unwrap();
    std::fs::write(temp.repository.join("filtered"), "content\n").unwrap();
    temp.git(&["add", ".gitattributes", "filtered"]);
    temp.git(&["commit", "-qm", "add filtered file"]);
    let remote = temp.root.join("remote.git");
    temp.git(&["init", "--bare", remote.to_str().unwrap()]);
    temp.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    temp.git(&["push", "origin", "HEAD:remote-retry"]);
    temp.git(&["fetch", "origin"]);
    temp.git(&["config", "filter.fail.clean", "cat"]);
    temp.git(&["config", "filter.fail.smudge", "false"]);
    temp.git(&["config", "filter.fail.required", "true"]);
    let destination = temp.root.join("failed remote worktree");

    let error = create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "failed-remote-worktree".into(),
            name: "Failed remote worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "failed remote worktree".into(),
            branch: "origin/remote-retry".into(),
            remote: true,
            create_branch: false,
            version: temp.version(),
        },
    )
    .unwrap_err();
    assert!(error.message.contains("smudge filter fail failed"));
    assert_eq!(
        temp.git(&["branch", "--list", "remote-retry"]),
        "remote-retry"
    );
    assert!(!destination.exists());

    temp.git(&["config", "filter.fail.smudge", "cat"]);
    create_worktree(
        &temp.sessions,
        "project",
        GitWorktreeRequest {
            id: "failed-remote-worktree".into(),
            name: "Failed remote worktree".into(),
            parent_path: temp.root.to_string_lossy().into(),
            folder_name: "failed remote worktree".into(),
            branch: "remote-retry".into(),
            remote: false,
            create_branch: false,
            version: temp.version(),
        },
    )
    .unwrap();
    assert!(destination.exists());
}

#[test]
fn parses_normal_and_detached_worktrees_while_ignoring_bare_repositories() {
    let oid = "0123456789012345678901234567890123456789";
    let bytes = format!(
        "worktree /repo.git\0bare\0\0worktree /repo\0HEAD {oid}\0branch refs/heads/main\0\0worktree /repo/other\0HEAD {oid}\0detached\0locked reason\0\0"
    );
    let layout = parse_worktree_layout(bytes.as_bytes()).unwrap();
    assert_eq!(layout.root_path, "/repo.git");
    assert!(layout.primary.is_none());
    let parsed = parse_worktrees(bytes.as_bytes()).unwrap();
    assert_eq!(
        parsed,
        vec![
            GitWorktree {
                path: "/repo".into(),
                head: oid.into(),
                branch: Some("main".into())
            },
            GitWorktree {
                path: "/repo/other".into(),
                head: oid.into(),
                branch: None
            },
        ]
    );
    assert_eq!(
        parse_worktrees(format!("worktree /repo\0branch refs/heads/main\0\0").as_bytes())
            .unwrap_err()
            .code,
        "malformed"
    );
}

#[test]
fn requires_git_2_36_for_worktree_listing() {
    assert_eq!(
        require_worktree_list_version("2.35.9").unwrap_err().code,
        "old"
    );
    assert!(require_worktree_list_version("2.36.0").is_ok());
    assert!(require_worktree_list_version("2.45.1.windows.1").is_ok());
}
