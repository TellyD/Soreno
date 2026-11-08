use super::*;
use crate::agent_sessions::{
    tests::{terminal as terminal_output, unique_temp_path},
    AgentSession, AgentSessions,
};
use crate::project_git::test_fixtures::{isolated_git, local_project, successful_bytes};
use std::{
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

struct TempRepository {
    root: PathBuf,
    repository: PathBuf,
    sessions: AgentSessions,
}

impl TempRepository {
    fn new(label: &str) -> Self {
        let root = unique_temp_path(&format!("soreno-git-mutations-{label}"));
        let repository = root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        let sessions = AgentSessions::open(&root.join("app-data")).unwrap();
        let temp = Self {
            root,
            repository,
            sessions,
        };
        temp.git(&["init", "-q"]);
        temp.git(&["config", "--local", "commit.gpgSign", "false"]);
        temp.git(&["config", "--local", "core.autocrlf", "false"]);
        temp.git(&["config", "--local", "core.eol", "lf"]);
        temp.save_project("project", &temp.repository.clone());
        temp
    }

    fn project(&self, id: &str, path: &std::path::Path) -> AgentProject {
        local_project(id, id, path)
    }

    fn save_project(&self, id: &str, path: &std::path::Path) {
        self.sessions.save_project(self.project(id, path)).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.repository, args)
    }

    fn git_fails(&self, args: &[&str]) {
        let output = isolated_git(&self.root, &self.repository, args)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "git {args:?} succeeded unexpectedly"
        );
    }

    fn git_at(&self, directory: &std::path::Path, args: &[&str]) -> String {
        String::from_utf8(self.git_bytes_at(directory, args))
            .unwrap()
            .trim()
            .into()
    }

    fn git_bytes(&self, args: &[&str]) -> Vec<u8> {
        self.git_bytes_at(&self.repository, args)
    }

    fn git_bytes_at(&self, directory: &std::path::Path, args: &[&str]) -> Vec<u8> {
        successful_bytes(
            isolated_git(&self.root, directory, args).output().unwrap(),
            args,
        )
    }

    fn identify(&self) {
        self.git(&["config", "--local", "user.name", "Soreno Test"]);
        self.git(&["config", "--local", "user.email", "test@soreno.invalid"]);
    }

    fn commit_direct(&self, message: &str) {
        self.identify();
        self.git(&["commit", "-qm", message]);
    }

    fn snapshot(&self, id: &str) -> GitRepository {
        repository(&self.sessions.project(id).unwrap()).unwrap()
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn stages_and_unstages_only_selected_paths_including_unborn_repositories() {
    let temp = TempRepository::new("partial");
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    std::fs::write(temp.repository.join("two"), "two\n").unwrap();
    let version = temp.snapshot("project").version;
    stage(&temp.sessions, "project", vec!["one".into()], &version).unwrap();
    assert_eq!(temp.git(&["diff", "--cached", "--name-only"]), "one");
    assert!(temp.repository.join("two").exists());

    let version = temp.snapshot("project").version;
    unstage(&temp.sessions, "project", vec!["one".into()], &version).unwrap();
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert!(temp.repository.join("one").exists());

    temp.git(&["add", "one", "two"]);
    temp.commit_direct("initial");
    std::fs::write(temp.repository.join("one"), "changed one\n").unwrap();
    std::fs::write(temp.repository.join("two"), "changed two\n").unwrap();
    let version = temp.snapshot("project").version;
    stage(&temp.sessions, "project", vec!["one".into()], &version).unwrap();
    assert_eq!(temp.git(&["diff", "--cached", "--name-only"]), "one");
    let version = temp.snapshot("project").version;
    unstage(&temp.sessions, "project", vec!["one".into()], &version).unwrap();
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(temp.git(&["diff", "--name-only"]), "one\ntwo");
}

#[test]
fn handles_literal_pathspecs_and_both_sides_of_a_rename() {
    let temp = TempRepository::new("literal");
    for path in ["old", "file[1]", "-dash"] {
        std::fs::write(temp.repository.join(path), "base\n").unwrap();
    }
    temp.git(&["add", "--", "old", "file[1]", "-dash"]);
    temp.commit_direct("initial");
    temp.git(&["mv", "old", "new"]);
    let version = temp.snapshot("project").version;
    unstage(&temp.sessions, "project", vec!["new".into()], &version).unwrap();
    assert!(temp.repository.join("new").exists());
    assert!(!temp.repository.join("old").exists());
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());

    std::fs::write(temp.repository.join("file[1]"), "changed\n").unwrap();
    std::fs::write(temp.repository.join("-dash"), "changed\n").unwrap();
    let version = temp.snapshot("project").version;
    stage(
        &temp.sessions,
        "project",
        vec!["file[1]".into(), "-dash".into()],
        &version,
    )
    .unwrap();
    let names = temp.git(&["diff", "--cached", "--name-only"]);
    assert!(names.lines().any(|path| path == "file[1]"));
    assert!(names.lines().any(|path| path == "-dash"));
}

#[test]
fn staging_an_unstaged_rename_target_does_not_stage_its_old_path() {
    let temp = TempRepository::new("rename-side");
    std::fs::write(temp.repository.join("old"), "base\n").unwrap();
    temp.git(&["add", "old"]);
    temp.commit_direct("initial");
    temp.git(&["mv", "old", "new"]);
    std::fs::write(temp.repository.join("new"), "changed\n").unwrap();
    std::fs::write(temp.repository.join("old"), "base\n").unwrap();

    let version = temp.snapshot("project").version;
    stage(&temp.sessions, "project", vec!["new".into()], &version).unwrap();

    assert!(temp.git(&["ls-files", "--stage", "--", "old"]).is_empty());
    assert_eq!(
        temp.git(&["status", "--short", "--", "old"]),
        "D  old\n?? old"
    );
    assert_eq!(temp.git(&["show", ":new"]), "changed");
}

#[test]
fn rejects_file_directory_collisions_without_changing_the_index() {
    let temp = TempRepository::new("directory-collision");
    std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
    temp.git(&["add", "tracked"]);
    temp.commit_direct("initial");
    std::fs::remove_file(temp.repository.join("tracked")).unwrap();
    std::fs::create_dir(temp.repository.join("tracked")).unwrap();
    std::fs::write(temp.repository.join("tracked/unselected"), "keep\n").unwrap();

    let before = temp.git(&["ls-files", "--stage"]);
    let version = temp.snapshot("project").version;
    assert_eq!(
        stage(&temp.sessions, "project", vec!["tracked".into()], &version)
            .unwrap_err()
            .code,
        "pathCollision"
    );
    assert_eq!(temp.git(&["ls-files", "--stage"]), before);
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());

    temp.git(&["add", "-A", "--", "tracked"]);
    let before = temp.git(&["ls-files", "--stage"]);
    let version = temp.snapshot("project").version;
    assert_eq!(
        unstage(&temp.sessions, "project", vec!["tracked".into()], &version)
            .unwrap_err()
            .code,
        "pathCollision"
    );
    assert_eq!(temp.git(&["ls-files", "--stage"]), before);
}

#[test]
fn rejects_blank_messages_and_an_empty_unborn_index() {
    let temp = TempRepository::new("empty-unborn");
    let version = temp.snapshot("project").version;
    assert_eq!(
        commit(&temp.sessions, "project", " \n\t".into(), &version)
            .unwrap_err()
            .code,
        "invalidMessage"
    );
    assert_eq!(
        commit(&temp.sessions, "project", "message".into(), &version)
            .unwrap_err()
            .code,
        "empty"
    );
    assert!(temp.snapshot("project").head.is_none());
}

#[test]
fn rejects_a_stale_snapshot_after_head_changes() {
    let temp = TempRepository::new("stale");
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    temp.git(&["add", "one"]);
    temp.commit_direct("one");
    std::fs::write(temp.repository.join("two"), "two\n").unwrap();
    let stale = temp.snapshot("project").version;
    temp.git(&["add", "two"]);
    temp.commit_direct("two");
    std::fs::write(temp.repository.join("three"), "three\n").unwrap();
    let error = stage(&temp.sessions, "project", vec!["three".into()], &stale).unwrap_err();
    assert_eq!(error.code, "stale");
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());
}

#[test]
fn commits_the_whole_index_without_staging_worktree_changes() {
    let temp = TempRepository::new("commit");
    temp.identify();
    std::fs::write(temp.repository.join("staged"), "base\n").unwrap();
    std::fs::write(temp.repository.join("unstaged"), "base\n").unwrap();
    temp.git(&["add", "staged", "unstaged"]);
    temp.commit_direct("initial");
    std::fs::write(temp.repository.join("staged"), "next\n").unwrap();
    std::fs::write(temp.repository.join("unstaged"), "next\n").unwrap();
    temp.git(&["add", "staged"]);
    let version = temp.snapshot("project").version;
    let result = commit(&temp.sessions, "project", "selected".into(), &version).unwrap();
    assert_eq!(
        result.oid.as_deref(),
        Some(temp.git(&["rev-parse", "HEAD"]).as_str())
    );
    assert_eq!(temp.git(&["show", "HEAD:staged"]), "next");
    assert_eq!(temp.git(&["show", "HEAD:unstaged"]), "base");
    assert_eq!(temp.git(&["diff", "--name-only"]), "unstaged");
}

#[test]
fn quick_commit_stages_then_commits_the_generated_message_after_checking_identity() {
    let temp = TempRepository::new("quick-commit");
    temp.git(&["config", "--local", "user.name", ""]);
    temp.git(&["config", "--local", "user.email", ""]);
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    let version = temp.snapshot("project").version;
    let error = quick_commit(
        &temp.sessions,
        "project",
        vec!["one".into()],
        &version,
        |_, _| panic!("generated without an identity"),
    )
    .unwrap_err();
    assert_eq!(error.code, "identity");
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());

    temp.identify();
    let version = temp.snapshot("project").version;
    let result = quick_commit(
        &temp.sessions,
        "project",
        vec!["one".into()],
        &version,
        |project, staged| {
            assert_eq!(repository(project).unwrap().version, staged);
            Ok("Generated message".into())
        },
    )
    .unwrap();
    assert_eq!(
        result.oid.as_deref(),
        Some(temp.git(&["rev-parse", "HEAD"]).as_str())
    );
    assert_eq!(temp.git(&["log", "-1", "--format=%s"]), "Generated message");
    assert!(temp.git(&["status", "--porcelain"]).is_empty());
}

#[cfg(unix)]
#[test]
fn preserves_hooks_reports_tree_changes_and_propagates_hook_failures() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempRepository::new("hooks");
    temp.identify();
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    temp.git(&["add", "one"]);
    let hook = temp.repository.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let version = temp.snapshot("project").version;
    assert!(commit(&temp.sessions, "project", "blocked".into(), &version).is_err());
    assert!(temp.snapshot("project").head.is_none());

    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf 'hook\\n' > hooked\ngit add -- hooked\n",
    )
    .unwrap();
    let version = temp.snapshot("project").version;
    let result = commit(&temp.sessions, "project", "hooked".into(), &version).unwrap();
    assert!(result.warning.is_some());
    assert_eq!(temp.git(&["show", "HEAD:hooked"]), "hook");
}

#[test]
fn resolves_conflicts_only_after_marker_confirmation_including_deletions() {
    let temp = TempRepository::new("resolve-markers");
    temp.identify();
    std::fs::write(temp.repository.join("conflict"), "base\n").unwrap();
    temp.git(&["add", "conflict"]);
    temp.commit_direct("base");
    let main = temp.git(&["branch", "--show-current"]);
    temp.git(&["switch", "-c", "side"]);
    std::fs::write(temp.repository.join("conflict"), "side\n").unwrap();
    temp.git(&["commit", "-am", "side", "-q"]);
    temp.git(&["switch", &main]);
    std::fs::write(temp.repository.join("conflict"), "main\n").unwrap();
    temp.git(&["commit", "-am", "main", "-q"]);
    temp.git_fails(&["merge", "side"]);

    let version = temp.snapshot("project").version;
    assert_eq!(
        stage(&temp.sessions, "project", vec!["conflict".into()], &version,)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        resolve(
            &temp.sessions,
            "project",
            vec!["conflict".into()],
            &version,
            false,
        )
        .unwrap_err()
        .code,
        "markers"
    );
    resolve(
        &temp.sessions,
        "project",
        vec!["conflict".into()],
        &version,
        true,
    )
    .unwrap();
    assert!(temp.git(&["ls-files", "-u"]).is_empty());

    let deletion = TempRepository::new("resolve-deletion");
    deletion.identify();
    std::fs::write(deletion.repository.join("removed"), "base\n").unwrap();
    deletion.git(&["add", "removed"]);
    deletion.commit_direct("base");
    let main = deletion.git(&["branch", "--show-current"]);
    deletion.git(&["switch", "-c", "delete-side"]);
    deletion.git(&["rm", "removed"]);
    deletion.commit_direct("delete");
    deletion.git(&["switch", &main]);
    std::fs::write(deletion.repository.join("removed"), "changed\n").unwrap();
    deletion.git(&["commit", "-am", "change", "-q"]);
    deletion.git_fails(&["merge", "delete-side"]);
    std::fs::remove_file(deletion.repository.join("removed")).unwrap();
    let version = deletion.snapshot("project").version;
    resolve(
        &deletion.sessions,
        "project",
        vec!["removed".into()],
        &version,
        false,
    )
    .unwrap();
    assert!(deletion.git(&["ls-files", "-u"]).is_empty());
    assert_eq!(
        deletion.git(&["diff", "--cached", "--name-status"]),
        "D\tremoved"
    );
}

#[test]
fn allows_a_merge_commit_when_the_index_tree_matches_head() {
    let temp = TempRepository::new("empty-merge");
    temp.identify();
    std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
    temp.git(&["add", "tracked"]);
    temp.commit_direct("base");
    let main = temp.git(&["branch", "--show-current"]);
    temp.git(&["switch", "-c", "side"]);
    std::fs::write(temp.repository.join("temporary"), "content\n").unwrap();
    temp.git(&["add", "temporary"]);
    temp.commit_direct("add");
    temp.git(&["rm", "temporary"]);
    temp.commit_direct("remove");
    temp.git(&["switch", &main]);
    temp.git(&["merge", "--no-ff", "--no-commit", "side"]);
    let snapshot = temp.snapshot("project");
    assert_eq!(snapshot.operation.as_deref(), Some("merge"));
    assert!(snapshot.files.is_empty());
    commit(
        &temp.sessions,
        "project",
        snapshot.merge_message.unwrap(),
        &snapshot.version,
    )
    .unwrap();
    assert_eq!(
        temp.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[test]
fn leaves_index_locks_in_place_and_releases_the_lease_after_errors() {
    let temp = TempRepository::new("lock");
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    let lock = temp.repository.join(".git/index.lock");
    std::fs::write(&lock, "owned elsewhere").unwrap();
    let version = temp.snapshot("project").version;
    assert!(stage(&temp.sessions, "project", vec!["one".into()], &version).is_err());
    assert!(lock.exists());
    let lease = temp.sessions.begin_git_operation("project").unwrap();
    assert!(temp.sessions.begin_git_operation("project").is_err());
    assert!(temp
        .sessions
        .save_project(temp.project("other", &temp.repository))
        .is_err());
    assert!(temp.sessions.delete_project("project").is_err());
    drop(lease);
    temp.sessions.begin_git_operation("project").unwrap();
}

#[test]
fn validates_last_local_identity_values_and_rejects_missing_or_invalid_values() {
    let temp = TempRepository::new("identity-values");
    temp.git(&["config", "--local", "--add", "user.name", ""]);
    temp.git(&["config", "--local", "--add", "user.name", "Last Name"]);
    temp.git(&["config", "--local", "user.email", "last@example.invalid"]);
    validate_identity_output(temp.git_bytes(&[
        "config",
        "--null",
        "--get-regexp",
        "^user\\.(name|email)$",
    ]))
    .unwrap();

    temp.git(&["config", "--local", "--unset-all", "user.email"]);
    assert_eq!(
        validate_identity_output(temp.git_bytes(&[
            "config",
            "--null",
            "--get-regexp",
            "^user\\.(name|email)$",
        ]))
        .unwrap_err()
        .code,
        "identity"
    );

    temp.git(&["config", "--local", "user.email", "\t"]);
    assert_eq!(
        validate_identity_output(temp.git_bytes(&[
            "config",
            "--null",
            "--get-regexp",
            "^user\\.(name|email)$",
        ]))
        .unwrap_err()
        .code,
        "identity"
    );
}

#[test]
fn validates_only_effective_identity_values_as_utf8() {
    validate_identity_output(
        b"user.name\n\xff\0user.name\nValid Name\0user.email\nvalid@example.invalid\0".to_vec(),
    )
    .unwrap();

    assert_eq!(
        validate_identity_output(
            b"user.name\nValid Name\0user.email\nvalid@example.invalid\0user.name\n\xff\0".to_vec(),
        )
        .unwrap_err()
        .code,
        "malformed"
    );
}

#[test]
fn requires_identity_and_writes_only_local_identity() {
    let temp = TempRepository::new("identity");
    temp.git(&["config", "--local", "user.name", ""]);
    temp.git(&["config", "--local", "user.email", ""]);
    std::fs::write(temp.repository.join("one"), "one\n").unwrap();
    temp.git(&["add", "one"]);
    let version = temp.snapshot("project").version;
    assert_eq!(
        commit(&temp.sessions, "project", "missing".into(), &version)
            .unwrap_err()
            .code,
        "identity"
    );
    let version = temp.snapshot("project").version;
    set_identity(
        &temp.sessions,
        "project",
        "Local Name".into(),
        "local@example.invalid".into(),
        false,
        &version,
    )
    .unwrap();
    assert_eq!(temp.git(&["config", "--local", "user.name"]), "Local Name");
    assert_eq!(
        temp.git(&["config", "--local", "user.email"]),
        "local@example.invalid"
    );
}

#[test]
#[ignore = "subprocess fixture for an idle active agent session"]
fn stage_active_session_fixture() {
    #[cfg(unix)]
    assert!(std::env::var_os("SORENO_AGENT_RUN").is_some());
    println!("SORENO_STAGE_ACTIVE_READY");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

fn start_active_fixture(temp: &TempRepository, session: AgentSession) {
    let session_id = session.id.clone();
    temp.sessions.save_session(session).unwrap();
    temp.sessions.start(&session_id, 80, 24, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let terminal = terminal_output(&temp.sessions, &session_id).unwrap();
        let output = &terminal.bytes;
        if output
            .windows(b"SORENO_STAGE_ACTIVE_READY".len())
            .any(|bytes| bytes == b"SORENO_STAGE_ACTIVE_READY")
        {
            return;
        }
        assert_eq!(terminal.status.state, "running");
        assert!(Instant::now() < deadline, "agent session timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn service_does_not_block_a_branch_switch() {
    let temp = TempRepository::new("service-switch");
    std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
    temp.git(&["add", "tracked"]);
    temp.commit_direct("initial");
    temp.git(&["branch", "next"]);
    start_active_fixture(
        &temp,
        AgentSession {
            id: "service".into(),
            project_id: "project".into(),
            name: "Preview".into(),
            custom_name: None,
            kind: "service".into(),
            service_id: Some("preview".into()),
            working_directory: Some(temp.repository.to_string_lossy().into()),
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--ignored".into(),
                "--exact".into(),
                "project_git::mutations::tests::stage_active_session_fixture".into(),
                "--nocapture".into(),
            ],
            created_at: "2026-01-01T00:00:00Z".into(),
            favorite: false,
            design: false,
        },
    );

    let version = temp.snapshot("project").version;
    super::super::branches::switch_branch(
        &temp.sessions,
        "project",
        "next".into(),
        false,
        &version,
    )
    .unwrap();
    assert_eq!(temp.git(&["branch", "--show-current"]), "next");
    temp.sessions.stop("service").unwrap();
}

#[test]
fn safe_mutations_keep_an_agent_session_active() {
    let temp = TempRepository::new("active-stage");
    std::fs::write(temp.repository.join("selected"), "selected base\n").unwrap();
    std::fs::write(temp.repository.join("unselected"), "unselected base\n").unwrap();
    temp.git(&["add", "selected", "unselected"]);
    temp.commit_direct("initial");
    std::fs::write(temp.repository.join("selected"), "selected staged\n").unwrap();
    std::fs::write(temp.repository.join("unselected"), "unselected changed\n").unwrap();

    start_active_fixture(
        &temp,
        AgentSession {
            id: "session".into(),
            project_id: "project".into(),
            name: "idle".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--ignored".into(),
                "--exact".into(),
                "project_git::mutations::tests::stage_active_session_fixture".into(),
                "--nocapture".into(),
            ],
            created_at: "2026-01-01T00:00:00Z".into(),
            favorite: false,
            design: false,
        },
    );

    let current_branch = temp.git(&["branch", "--show-current"]);
    let version = temp.snapshot("project").version;
    super::super::branches::create_branch(
        &temp.sessions,
        "project",
        "while-agent-active".into(),
        &version,
    )
    .unwrap();
    assert_eq!(temp.git(&["branch", "--show-current"]), current_branch);
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let version = temp.snapshot("project").version;
    stage(&temp.sessions, "project", vec!["selected".into()], &version).unwrap();
    assert_eq!(temp.git(&["diff", "--cached", "--name-only"]), "selected");
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let stale = temp.snapshot("project").version;
    let index = temp.git(&["ls-files", "--stage"]);
    std::fs::write(temp.repository.join("selected"), "selected newer\n").unwrap();
    assert_eq!(
        stage(&temp.sessions, "project", vec!["selected".into()], &stale,)
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(temp.git(&["ls-files", "--stage"]), index);

    let version = temp.snapshot("project").version;
    unstage(&temp.sessions, "project", vec!["selected".into()], &version).unwrap();
    assert!(temp.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("selected")).unwrap(),
        "selected newer\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("unselected")).unwrap(),
        "unselected changed\n"
    );
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let version = temp.snapshot("project").version;
    stage(&temp.sessions, "project", vec!["selected".into()], &version).unwrap();
    assert_eq!(temp.git(&["show", ":selected"]), "selected newer");
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let version = temp.snapshot("project").version;
    set_identity(
        &temp.sessions,
        "project",
        "Active Agent".into(),
        "active@soreno.invalid".into(),
        false,
        &version,
    )
    .unwrap();
    assert_eq!(
        temp.git(&["config", "--local", "user.name"]),
        "Active Agent"
    );
    assert_eq!(
        temp.git(&["config", "--local", "user.email"]),
        "active@soreno.invalid"
    );
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let version = temp.snapshot("project").version;
    commit(&temp.sessions, "project", "selected".into(), &version).unwrap();
    assert_eq!(temp.git(&["show", "HEAD:selected"]), "selected newer");
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );

    let version = temp.snapshot("project").version;
    let result = super::super::restore::restore(
        &temp.sessions,
        "project",
        vec!["unselected".into()],
        &version,
    )
    .unwrap();
    assert!(result.oid.is_some());
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("unselected")).unwrap(),
        "unselected base\n"
    );
    assert_eq!(
        terminal_output(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );
}
