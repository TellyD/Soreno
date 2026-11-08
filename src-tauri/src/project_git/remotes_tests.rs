use super::*;
use crate::agent_sessions::tests::unique_temp_path;
#[cfg(unix)]
use crate::agent_sessions::AgentSession;
use crate::project_git::{
    repository,
    test_fixtures::{git_with_env_identity, local_project},
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{path::PathBuf, process::Command};

struct Repositories {
    root: PathBuf,
    bare: PathBuf,
    local: PathBuf,
    peer: PathBuf,
    sessions: AgentSessions,
    main: String,
}

impl Repositories {
    fn new(label: &str) -> Self {
        let root = unique_temp_path(&format!("soreno-git-remotes-{label}"));
        let bare = root.join("remote.git");
        let seed = root.join("seed");
        let local = root.join("local");
        let peer = root.join("peer");
        std::fs::create_dir_all(&seed).unwrap();
        Self::git_at(&root, &seed, &["init", "-q"]);
        Self::configure(&root, &seed);
        std::fs::write(seed.join("tracked"), "initial\n").unwrap();
        std::fs::write(seed.join(".gitignore"), "ignored.txt\n").unwrap();
        Self::git_at(&root, &seed, &["add", "tracked", ".gitignore"]);
        Self::git_at(&root, &seed, &["commit", "-qm", "initial"]);
        let main = Self::git_at(&root, &seed, &["branch", "--show-current"]);
        Self::git_at(
            &root,
            &root,
            &["init", "--bare", "-q", bare.to_str().unwrap()],
        );
        Self::git_at(
            &root,
            &seed,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        Self::git_at(&root, &seed, &["push", "-qu", "origin", &main]);
        Self::git_at(
            &root,
            &root,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        Self::git_at(
            &root,
            &root,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                peer.to_str().unwrap(),
            ],
        );
        Self::configure(&root, &local);
        Self::configure(&root, &peer);
        let sessions = AgentSessions::open(&root.join("app-data")).unwrap();
        sessions
            .save_project(local_project("project", "Project", &local))
            .unwrap();
        Self {
            root,
            bare,
            local,
            peer,
            sessions,
            main,
        }
    }

    fn configure(root: &Path, directory: &Path) {
        Self::git_at(
            root,
            directory,
            &["config", "--local", "core.autocrlf", "false"],
        );
        Self::git_at(root, directory, &["config", "--local", "core.eol", "lf"]);
    }

    fn git_at(root: &Path, directory: &Path, args: &[&str]) -> String {
        git_with_env_identity(root, directory, args)
    }

    fn git(&self, directory: &Path, args: &[&str]) -> String {
        Self::git_at(&self.root, directory, args)
    }

    fn commit(&self, directory: &Path, content: &str, message: &str) {
        std::fs::write(directory.join("tracked"), content).unwrap();
        self.git(directory, &["add", "tracked"]);
        self.git(directory, &["commit", "-qm", message]);
    }

    fn project(&self) -> AgentProject {
        self.sessions.project("project").unwrap()
    }

    fn project_at(&self, path: &Path) -> AgentProject {
        local_project("project", "Project", path)
    }

    fn version(&self) -> String {
        repository(&self.project()).unwrap().version
    }

    fn remote_url(&self) -> String {
        remotes(&self.project()).unwrap()[0].url.clone()
    }
}

impl Drop for Repositories {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn reads_remotes_from_subdirectories_and_bare_repositories() {
    let temp = Repositories::new("metadata-paths");
    temp.git(&temp.local, &["config", "diff.relative", "true"]);
    let nested = temp.local.join("nested");
    std::fs::create_dir(&nested).unwrap();
    assert_eq!(
        remotes(&temp.project_at(&nested)).unwrap(),
        remotes(&temp.project()).unwrap()
    );

    temp.git(
        &temp.bare,
        &["remote", "add", "backup", temp.peer.to_str().unwrap()],
    );
    let bare = temp.project_at(&temp.bare);
    assert_eq!(repository(&bare).unwrap().availability, "bare");
    assert_eq!(remotes(&bare).unwrap()[0].name, "backup");
}

#[test]
fn fetches_publishes_and_fast_forwards_without_inherited_side_effects() {
    let temp = Repositories::new("network");
    temp.commit(&temp.peer, "peer one\n", "peer one");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    temp.git(&temp.local, &["config", "fetch.prune", "true"]);
    temp.git(&temp.local, &["config", "fetch.pruneTags", "true"]);
    temp.git(&temp.local, &["config", "remote.origin.tagOpt", "--tags"]);
    temp.git(
        &temp.local,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            &format!("+refs/heads/{}:refs/heads/unrelated", temp.main),
        ],
    );
    temp.git(&temp.local, &["update-ref", "refs/heads/unrelated", "HEAD"]);
    let unrelated = temp.git(&temp.local, &["rev-parse", "refs/heads/unrelated"]);
    temp.git(
        &temp.local,
        &["update-ref", "refs/remotes/origin/stale", "HEAD"],
    );
    temp.git(&temp.peer, &["tag", "not-fetched"]);
    temp.git(&temp.peer, &["push", "-q", "origin", "not-fetched"]);
    let url = temp.remote_url();
    std::fs::write(
        temp.local.join(".gitignore"),
        "ignored.txt\nlocal fetch and push change\n",
    )
    .unwrap();
    fetch(
        &temp.sessions,
        "project",
        "origin".into(),
        url.clone(),
        &temp.version(),
    )
    .unwrap();
    assert_eq!(
        temp.git(
            &temp.local,
            &["rev-parse", "refs/remotes/origin/HEAD^{commit}"]
        ),
        temp.git(&temp.peer, &["rev-parse", "HEAD"])
    );
    assert!(!temp
        .git(
            &temp.local,
            &["show-ref", "--verify", "refs/remotes/origin/stale"]
        )
        .is_empty());
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "refs/heads/unrelated"]),
        unrelated
    );
    assert!(
        Command::new("git")
            .args([
                "-C",
                temp.local.to_str().unwrap(),
                "show-ref",
                "--verify",
                "refs/tags/not-fetched"
            ])
            .output()
            .unwrap()
            .status
            .success()
            == false
    );

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        url.clone(),
        &temp.version(),
        false,
    )
    .unwrap();
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "HEAD"]),
        temp.git(&temp.peer, &["rev-parse", "HEAD"])
    );

    temp.git(&temp.local, &["switch", "-qc", "publish"]);
    temp.commit(&temp.local, "published\n", "published");
    temp.git(&temp.local, &["config", "remote.origin.mirror", "true"]);
    push(
        &temp.sessions,
        "project",
        "origin".into(),
        "published".into(),
        url,
        &temp.version(),
    )
    .unwrap();
    assert_eq!(
        temp.git(&temp.bare, &["rev-parse", "refs/heads/published"]),
        temp.git(&temp.local, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/published"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join(".gitignore")).unwrap(),
        "ignored.txt\nlocal fetch and push change\n"
    );
}

#[cfg(unix)]
#[test]
fn pull_succeeds_while_an_agent_session_is_running() {
    let temp = Repositories::new("active-session");
    temp.sessions
        .save_session(AgentSession {
            id: "session".into(),
            project_id: "project".into(),
            name: "running".into(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 60".into()],
            created_at: "2026-01-01T00:00:00Z".into(),
            favorite: false,
            design: false,
        })
        .unwrap();
    temp.sessions.start("session", 80, 24, None).unwrap();
    temp.commit(&temp.peer, "remote\n", "remote change");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        false,
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
        "remote\n"
    );
    assert_eq!(
        crate::agent_sessions::tests::terminal(&temp.sessions, "session")
            .unwrap()
            .status
            .state,
        "running"
    );
    temp.sessions.stop("session").unwrap();
}

#[test]
fn pull_succeeds_when_equal_or_ahead_without_moving_head() {
    let temp = Repositories::new("equal-ahead");
    let url = temp.remote_url();
    let equal_head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        url.clone(),
        &temp.version(),
        false,
    )
    .unwrap();
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), equal_head);

    temp.commit(&temp.local, "local ahead\n", "local ahead");
    let ahead_head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        url,
        &temp.version(),
        false,
    )
    .unwrap();
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), ahead_head);
}

#[test]
fn pull_rebases_diverged_commits_onto_the_validated_upstream() {
    let temp = Repositories::new("rebase-success");
    temp.git(&temp.local, &["config", "user.name", "Soreno Test"]);
    temp.git(
        &temp.local,
        &["config", "user.email", "test@soreno.invalid"],
    );
    std::fs::write(temp.local.join("local"), "local\n").unwrap();
    temp.git(&temp.local, &["add", "local"]);
    temp.git(&temp.local, &["commit", "-qm", "local"]);
    let previous_head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    std::fs::write(temp.local.join("ignored.txt"), "unrelated ignored\n").unwrap();
    temp.git(&temp.local, &["config", "commit.gpgSign", "true"]);
    temp.git(&temp.local, &["config", "gpg.program", "false"]);

    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    let remote_head = temp.git(&temp.peer, &["rev-parse", "HEAD"]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap();

    assert_ne!(temp.git(&temp.local, &["rev-parse", "HEAD"]), previous_head);
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD^"]), remote_head);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("local")).unwrap(),
        "local\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("remote")).unwrap(),
        "remote\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("ignored.txt")).unwrap(),
        "unrelated ignored\n"
    );
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
}

#[test]
fn pull_rebase_ignores_injected_instruction_format_lines() {
    let temp = Repositories::new("rebase-instruction-format");
    temp.git(&temp.local, &["config", "user.name", "Soreno Test"]);
    temp.git(
        &temp.local,
        &["config", "user.email", "test@soreno.invalid"],
    );
    std::fs::write(temp.local.join("local"), "local\n").unwrap();
    temp.git(&temp.local, &["add", "local"]);
    temp.git(
        &temp.local,
        &[
            "commit",
            "-qm",
            "safe subject\n\nexec touch rebase-injected",
        ],
    );
    temp.git(
        &temp.local,
        &["config", "rebase.instructionFormat", "%s%n%b"],
    );

    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap();

    assert!(!temp.local.join("rebase-injected").exists());
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
}

#[test]
fn pull_rebase_does_not_update_other_branches() {
    let temp = Repositories::new("rebase-update-refs");
    temp.git(&temp.local, &["config", "user.name", "Soreno Test"]);
    temp.git(
        &temp.local,
        &["config", "user.email", "test@soreno.invalid"],
    );
    std::fs::write(temp.local.join("local"), "local\n").unwrap();
    temp.git(&temp.local, &["add", "local"]);
    temp.git(&temp.local, &["commit", "-qm", "local"]);
    let local_head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    temp.git(&temp.local, &["branch", "also-local"]);
    temp.git(&temp.local, &["config", "rebase.updateRefs", "true"]);

    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap();

    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "refs/heads/also-local"]),
        local_head
    );
}

#[test]
fn pull_aborts_a_conflicting_rebase_without_local_loss() {
    let temp = Repositories::new("rebase-conflict");
    temp.commit(&temp.local, "local\n", "local");
    let before = local_state(&temp.project()).unwrap();
    let local_content = std::fs::read_to_string(temp.local.join("tracked")).unwrap();

    temp.commit(&temp.peer, "remote\n", "remote");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "conflict");
    assert_eq!(error.uncertain, None);
    assert!(local_state(&temp.project()).is_ok_and(|state| state == before));
    assert_eq!(
        std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
        local_content
    );
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
}

#[cfg(unix)]
#[test]
fn pull_aborts_a_conflicting_rebase_with_reference_transaction_hook_disabled() {
    let temp = Repositories::new("rebase-abort-hook");
    temp.commit(&temp.local, "local\n", "local");
    let before = local_state(&temp.project()).unwrap();
    temp.commit(&temp.peer, "remote\n", "remote");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    let hook = temp.local.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = prepared ] && grep -q ' refs/heads/'; then\n  exit 1\nfi\nexit 0\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&hook).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&hook, permissions).unwrap();

    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "conflict");
    assert_eq!(error.uncertain, None);
    assert!(local_state(&temp.project()).is_ok_and(|state| state == before));
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
}

#[test]
fn pull_restores_a_non_conflicting_rebase_failure_without_reporting_a_conflict() {
    let temp = Repositories::new("rebase-non-conflict-failure");
    std::fs::write(temp.local.join("local"), "local\n").unwrap();
    temp.git(&temp.local, &["add", "local"]);
    temp.git(&temp.local, &["commit", "-qm", "local"]);
    let before = local_state(&temp.project()).unwrap();

    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    temp.git(&temp.local, &["config", "user.useConfigOnly", "true"]);
    temp.git(&temp.local, &["config", "user.name", ""]);
    temp.git(&temp.local, &["config", "user.email", ""]);

    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "failed");
    assert!(error.message.contains("identity"));
    assert_eq!(error.uncertain, None);
    assert!(local_state(&temp.project()).is_ok_and(|state| state == before));
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
}

#[test]
fn pull_rebase_rejects_a_dirty_worktree_before_fetch() {
    let temp = Repositories::new("rebase-dirty");
    temp.commit(&temp.peer, "remote\n", "remote");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    let tracking = format!("refs/remotes/origin/{}", temp.main);
    let tracking_head = temp.git(&temp.local, &["rev-parse", &tracking]);
    std::fs::write(temp.local.join("tracked"), "dirty\n").unwrap();

    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "dirty");
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", &tracking]),
        tracking_head
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
        "dirty\n"
    );
}

#[test]
fn pull_rebase_rejects_hidden_index_changes_before_fetch() {
    for (label, flag) in [
        ("assume-unchanged", "--assume-unchanged"),
        ("skip-worktree", "--skip-worktree"),
    ] {
        let temp = Repositories::new(label);
        temp.commit(&temp.peer, "remote\n", "remote");
        temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
        let tracking = format!("refs/remotes/origin/{}", temp.main);
        let tracking_head = temp.git(&temp.local, &["rev-parse", &tracking]);
        temp.git(&temp.local, &["update-index", flag, "tracked"]);
        std::fs::write(temp.local.join("tracked"), "hidden local\n").unwrap();
        assert!(repository(&temp.project()).unwrap().files.is_empty());

        let error = pull(
            &temp.sessions,
            "project",
            "origin".into(),
            temp.remote_url(),
            &temp.version(),
            true,
        )
        .unwrap_err();

        assert_eq!(error.code, "dirty", "{label}");
        assert_eq!(
            temp.git(&temp.local, &["rev-parse", &tracking]),
            tracking_head,
            "{label}"
        );
        assert_eq!(
            std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
            "hidden local\n",
            "{label}"
        );
    }
}

#[test]
fn pull_fast_forwards_while_preserving_compatible_local_changes() {
    let temp = Repositories::new("dirty-fast-forward");
    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote file"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    std::fs::write(temp.local.join("tracked"), "staged local\n").unwrap();
    temp.git(&temp.local, &["add", "tracked"]);
    std::fs::write(
        temp.local.join(".gitignore"),
        "ignored.txt\nunstaged local\n",
    )
    .unwrap();
    std::fs::write(temp.local.join("untracked"), "untracked local\n").unwrap();
    let staged = temp.git(&temp.local, &["diff", "--cached", "--", "tracked"]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        false,
    )
    .unwrap();

    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "HEAD"]),
        temp.git(&temp.peer, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        temp.git(&temp.local, &["diff", "--cached", "--", "tracked"]),
        staged
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
        "staged local\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join(".gitignore")).unwrap(),
        "ignored.txt\nunstaged local\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("untracked")).unwrap(),
        "untracked local\n"
    );
}

#[test]
fn pull_rejects_tracked_and_untracked_collisions_without_local_loss() {
    let tracked = Repositories::new("tracked-collision");
    tracked.commit(&tracked.peer, "remote\n", "remote change");
    tracked.git(&tracked.peer, &["push", "-q", "origin", &tracked.main]);
    std::fs::write(tracked.local.join("tracked"), "staged local\n").unwrap();
    tracked.git(&tracked.local, &["add", "tracked"]);
    std::fs::write(tracked.local.join("tracked"), "unstaged local\n").unwrap();
    let head = tracked.git(&tracked.local, &["rev-parse", "HEAD"]);
    let index = tracked.git(&tracked.local, &["ls-files", "--stage"]);
    assert_eq!(
        pull(
            &tracked.sessions,
            "project",
            "origin".into(),
            tracked.remote_url(),
            &tracked.version(),
            false,
        )
        .unwrap_err()
        .code,
        "failed"
    );
    assert_eq!(tracked.git(&tracked.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(tracked.git(&tracked.local, &["ls-files", "--stage"]), index);
    assert_eq!(
        std::fs::read_to_string(tracked.local.join("tracked")).unwrap(),
        "unstaged local\n"
    );

    let untracked = Repositories::new("untracked-collision");
    std::fs::write(untracked.peer.join("collision"), "remote\n").unwrap();
    untracked.git(&untracked.peer, &["add", "collision"]);
    untracked.git(&untracked.peer, &["commit", "-qm", "remote collision"]);
    untracked.git(&untracked.peer, &["push", "-q", "origin", &untracked.main]);
    std::fs::write(untracked.local.join("collision"), "local\n").unwrap();
    let head = untracked.git(&untracked.local, &["rev-parse", "HEAD"]);
    let index = untracked.git(&untracked.local, &["ls-files", "--stage"]);
    assert_eq!(
        pull(
            &untracked.sessions,
            "project",
            "origin".into(),
            untracked.remote_url(),
            &untracked.version(),
            false,
        )
        .unwrap_err()
        .code,
        "failed"
    );
    assert_eq!(
        untracked.git(&untracked.local, &["rev-parse", "HEAD"]),
        head
    );
    assert_eq!(
        untracked.git(&untracked.local, &["ls-files", "--stage"]),
        index
    );
    assert_eq!(
        std::fs::read_to_string(untracked.local.join("collision")).unwrap(),
        "local\n"
    );
}

#[test]
fn pull_rebase_rejects_ignored_collisions_without_local_loss() {
    let temp = Repositories::new("ignored-overwrite");
    std::fs::write(temp.local.join("ignored.txt"), "local bytes\n").unwrap();
    std::fs::write(temp.peer.join("ignored.txt"), "remote bytes\n").unwrap();
    temp.git(&temp.peer, &["add", "-f", "ignored.txt"]);
    temp.git(&temp.peer, &["commit", "-qm", "track ignored file"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    let head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "dirty");
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("ignored.txt")).unwrap(),
        "local bytes\n"
    );
}

#[test]
fn pull_rebase_rejects_an_ignored_file_above_an_upstream_path() {
    let temp = Repositories::new("ignored-parent-overwrite");
    std::fs::write(temp.local.join(".git/info/exclude"), "dir\n").unwrap();
    std::fs::write(temp.local.join("dir"), "local bytes\n").unwrap();
    std::fs::create_dir(temp.peer.join("dir")).unwrap();
    std::fs::write(temp.peer.join("dir/file"), "remote bytes\n").unwrap();
    temp.git(&temp.peer, &["add", "dir/file"]);
    temp.git(&temp.peer, &["commit", "-qm", "track nested file"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    let head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "dirty");
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("dir")).unwrap(),
        "local bytes\n"
    );
}

#[test]
fn pull_rebase_rejects_ignored_paths_touched_only_by_intermediate_local_commits() {
    let temp = Repositories::new("ignored-intermediate-overwrite");
    std::fs::write(temp.local.join("ignored.txt"), "committed bytes\n").unwrap();
    temp.git(&temp.local, &["add", "-f", "ignored.txt"]);
    temp.git(&temp.local, &["commit", "-qm", "add ignored path"]);
    temp.git(&temp.local, &["rm", "-q", "ignored.txt"]);
    temp.git(&temp.local, &["commit", "-qm", "remove ignored path"]);
    std::fs::write(temp.local.join("ignored.txt"), "local bytes\n").unwrap();

    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);

    let head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "dirty");
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("ignored.txt")).unwrap(),
        "local bytes\n"
    );
}

#[test]
fn pull_rebase_disables_directory_renames_that_target_an_ignored_file() {
    let temp = Repositories::new("rebase-directory-renames");
    temp.git(&temp.local, &["config", "user.name", "Soreno Test"]);
    temp.git(
        &temp.local,
        &["config", "user.email", "test@soreno.invalid"],
    );
    std::fs::create_dir_all(temp.peer.join("old-dir")).unwrap();
    std::fs::create_dir_all(temp.peer.join("new-dir")).unwrap();
    std::fs::write(temp.peer.join("old-dir/base"), "base\n").unwrap();
    std::fs::write(temp.peer.join("new-dir/keep"), "keep\n").unwrap();
    temp.git(&temp.peer, &["add", "old-dir/base", "new-dir/keep"]);
    temp.git(&temp.peer, &["commit", "-qm", "add directories"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        false,
    )
    .unwrap();

    std::fs::write(temp.local.join("old-dir/ignored.txt"), "committed\n").unwrap();
    temp.git(&temp.local, &["add", "-f", "old-dir/ignored.txt"]);
    temp.git(&temp.local, &["commit", "-qm", "add old directory file"]);
    temp.git(&temp.peer, &["mv", "old-dir/base", "new-dir/base"]);
    temp.git(&temp.peer, &["commit", "-qm", "rename directory"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    std::fs::write(temp.local.join("new-dir/ignored.txt"), "local bytes\n").unwrap();
    temp.git(&temp.local, &["config", "merge.directoryRenames", "true"]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(temp.local.join("new-dir/ignored.txt")).unwrap(),
        "local bytes\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("old-dir/ignored.txt")).unwrap(),
        "committed\n"
    );
}

#[test]
fn pull_rebase_ignores_rebase_merges_config_and_preserves_ignored_files() {
    let temp = Repositories::new("rebase-merges");
    temp.git(&temp.local, &["config", "user.name", "Soreno Test"]);
    temp.git(
        &temp.local,
        &["config", "user.email", "test@soreno.invalid"],
    );
    std::fs::write(temp.peer.join("ignored.txt"), "old tracked bytes\n").unwrap();
    temp.git(&temp.peer, &["add", "-f", "ignored.txt"]);
    temp.git(&temp.peer, &["commit", "-qm", "add old ignored path"]);
    let old_base = temp.git(&temp.peer, &["rev-parse", "HEAD"]);
    temp.git(&temp.peer, &["rm", "-q", "ignored.txt"]);
    temp.git(&temp.peer, &["commit", "-qm", "remove old ignored path"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        false,
    )
    .unwrap();

    temp.git(&temp.local, &["switch", "-qc", "side", &old_base]);
    std::fs::write(temp.local.join("side"), "side\n").unwrap();
    temp.git(&temp.local, &["add", "side"]);
    temp.git(&temp.local, &["commit", "-qm", "side"]);
    temp.git(&temp.local, &["switch", "-q", &temp.main]);
    temp.git(
        &temp.local,
        &["merge", "--no-ff", "-qm", "merge side", "side"],
    );
    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    std::fs::write(temp.local.join("ignored.txt"), "local bytes\n").unwrap();
    temp.git(&temp.local, &["config", "rebase.rebaseMerges", "true"]);

    pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(temp.local.join("ignored.txt")).unwrap(),
        "local bytes\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.local.join("side")).unwrap(),
        "side\n"
    );
}

#[test]
fn pull_rebase_checks_roots_even_when_log_show_root_is_disabled() {
    let temp = Repositories::new("rebase-log-root");
    temp.git(&temp.local, &["switch", "--orphan", "unrelated"]);
    std::fs::write(temp.local.join("ignored.txt"), "committed bytes\n").unwrap();
    std::fs::write(temp.local.join("side"), "side\n").unwrap();
    temp.git(&temp.local, &["add", "-f", "ignored.txt", "side"]);
    temp.git(&temp.local, &["commit", "-qm", "unrelated root"]);
    temp.git(&temp.local, &["switch", "-q", &temp.main]);
    temp.git(
        &temp.local,
        &[
            "merge",
            "--allow-unrelated-histories",
            "--no-commit",
            "unrelated",
        ],
    );
    temp.git(&temp.local, &["rm", "-q", "--cached", "ignored.txt"]);
    temp.git(&temp.local, &["commit", "-qm", "merge unrelated root"]);
    std::fs::write(temp.local.join("ignored.txt"), "local bytes\n").unwrap();
    temp.git(&temp.local, &["config", "log.showRoot", "false"]);
    std::fs::write(temp.peer.join("remote"), "remote\n").unwrap();
    temp.git(&temp.peer, &["add", "remote"]);
    temp.git(&temp.peer, &["commit", "-qm", "remote"]);
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    let head = temp.git(&temp.local, &["rev-parse", "HEAD"]);

    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.remote_url(),
        &temp.version(),
        true,
    )
    .unwrap_err();

    assert_eq!(error.code, "dirty");
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(repository(&temp.project()).unwrap().operation, None);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("ignored.txt")).unwrap(),
        "local bytes\n"
    );
}

#[test]
fn rejects_noncanonical_upstream_mapping_and_remote_vcs_before_fetch() {
    let temp = Repositories::new("unsafe-config");
    let url = temp.remote_url();
    let tracking = format!("refs/remotes/origin/{}", temp.main);
    let before = temp.git(&temp.local, &["rev-parse", &tracking]);
    temp.git(
        &temp.local,
        &["config", "--unset-all", "remote.origin.fetch"],
    );
    temp.git(
        &temp.local,
        &[
            "config",
            "remote.origin.fetch",
            &format!("+refs/heads/{}:refs/remotes/origin/alias", temp.main),
        ],
    );
    assert_eq!(
        pull(
            &temp.sessions,
            "project",
            "origin".into(),
            url.clone(),
            &temp.version(),
            false,
        )
        .unwrap_err()
        .code,
        "wrongUpstream"
    );
    assert_eq!(temp.git(&temp.local, &["rev-parse", &tracking]), before);

    temp.git(&temp.local, &["config", "remote.origin.vcs", "ext"]);
    assert_eq!(
        fetch(
            &temp.sessions,
            "project",
            "origin".into(),
            url,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "unsafeRemote"
    );
}

#[test]
fn rejects_diverged_stale_and_non_fast_forward_operations_without_local_loss() {
    let temp = Repositories::new("refusals");
    let url = temp.remote_url();
    temp.commit(&temp.local, "local\n", "local");
    temp.commit(&temp.peer, "peer\n", "peer");
    temp.git(&temp.peer, &["push", "-q", "origin", &temp.main]);
    let head = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    let index = temp.git(&temp.local, &["ls-files", "--stage"]);
    let tracked = std::fs::read_to_string(temp.local.join("tracked")).unwrap();
    let remote_head = temp.git(
        &temp.bare,
        &["rev-parse", &format!("refs/heads/{}", temp.main)],
    );
    let tracking_ref = format!("refs/remotes/origin/{}", temp.main);
    let tracking_head = temp.git(&temp.local, &["rev-parse", &tracking_ref]);
    assert_ne!(tracking_head, remote_head);
    temp.git(
        &temp.local,
        &["config", "advice.pushUpdateRejected", "false"],
    );
    let error = push(
        &temp.sessions,
        "project",
        "origin".into(),
        temp.main.clone(),
        url.clone(),
        &temp.version(),
    )
    .unwrap_err();
    assert_eq!(error.code, "nonFastForward");
    assert_eq!(error.uncertain, None);
    assert_eq!(
        temp.git(
            &temp.bare,
            &["rev-parse", &format!("refs/heads/{}", temp.main)]
        ),
        remote_head
    );
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", &tracking_ref]),
        tracking_head
    );

    let error = pull(
        &temp.sessions,
        "project",
        "origin".into(),
        url.clone(),
        &temp.version(),
        false,
    )
    .unwrap_err();
    assert_eq!(error.code, "diverged");
    assert_eq!(error.uncertain, None);
    assert_eq!(temp.git(&temp.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(temp.git(&temp.local, &["ls-files", "--stage"]), index);
    assert_eq!(
        std::fs::read_to_string(temp.local.join("tracked")).unwrap(),
        tracked
    );

    temp.git(
        &temp.local,
        &["remote", "set-url", "origin", temp.root.to_str().unwrap()],
    );
    assert_eq!(
        fetch(
            &temp.sessions,
            "project",
            "origin".into(),
            url,
            &temp.version()
        )
        .unwrap_err()
        .code,
        "staleUrl"
    );
}

#[test]
fn validates_and_masks_remote_urls_and_network_preconditions() {
    for url in [
        "ext::sh -c nope",
        "http://example.invalid/repo",
        "https://user:secret@example.invalid/repo",
        "ssh://-oProxyCommand=x@example.invalid/repo",
        "hg::example",
        "-option",
        "https://example.invalid/repo\nsecret",
        "https://example.invalid/repo%00secret",
        "file://example.invalid/tmp/remote.git",
        "file://user@localhost/tmp/remote.git",
        "git@example invalid:repo",
        "user@example.invalid:repo",
    ] {
        assert!(validate_remote_url(url).is_err(), "{url}");
    }
    for url in [
        "https://example.invalid/repo.git",
        "ssh://git@example.invalid/repo.git",
        "git@example.invalid:repo.git",
        "../remote.git",
        "/tmp/remote.git",
        "file:///tmp/remote.git",
        "file:///C:/Temp/remote.git",
        #[cfg(windows)]
        "C:/Temp/remote.git",
    ] {
        assert!(validate_remote_url(url).is_ok(), "{url}");
    }
    assert!(!display_url("https://user:secret@example.invalid/repo").contains("secret"));
    assert!(display_url("ssh://alice@example.invalid/repo").contains("alice@"));
    assert_ne!(
        display_url("ssh://alice@example.invalid/repo"),
        display_url("ssh://bob@example.invalid/repo")
    );
    let masked = display_url("https://example.invalid/repo?token=secret#private");
    assert!(!masked.contains("token"));
    assert!(!masked.contains("secret"));
    assert!(!masked.contains("private"));
    let redacted = redact_error(GitError::new(
        "failed",
        "fatal: https://user:secret@example.invalid/repo refused",
    ));
    assert!(!redacted.message.contains("user"));
    assert!(!redacted.message.contains("secret"));
    let redacted = redact_error(GitError::new(
        "failed",
        "fatal: https://example.invalid/repo?token=secret#private refused",
    ));
    assert!(!redacted.message.contains("token"));
    assert!(!redacted.message.contains("secret"));
    assert!(!redacted.message.contains("private"));

    let temp = Repositories::new("set");
    temp.git(
        &temp.local,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://alice@example.invalid/repo",
        ],
    );
    let alice = remotes(&temp.project()).unwrap()[0].url.clone();
    temp.git(
        &temp.local,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://bob@example.invalid/repo",
        ],
    );
    assert_eq!(
        fetch(
            &temp.sessions,
            "project",
            "origin".into(),
            alice,
            &temp.version(),
        )
        .unwrap_err()
        .code,
        "staleUrl"
    );
    temp.git(
        &temp.local,
        &[
            "remote",
            "set-url",
            "origin",
            "https://user:secret@example.invalid/repo",
        ],
    );
    let listed = remotes(&temp.project()).unwrap();
    assert!(!listed[0].url.contains("user"));
    assert!(!listed[0].url.contains("secret"));
    temp.git(
        &temp.local,
        &["remote", "set-url", "origin", temp.bare.to_str().unwrap()],
    );
    temp.git(
        &temp.local,
        &[
            "config",
            "url.ext::blocked.insteadOf",
            "https://rewrite.invalid/",
        ],
    );
    assert_eq!(
        validate_remote_url(
            &resolve_candidate(&temp.project(), "https://rewrite.invalid/repo").unwrap(),
        )
        .unwrap_err()
        .code,
        "unsafeUrl"
    );
    temp.git(
        &temp.local,
        &["config", "--unset-all", "url.ext::blocked.insteadOf"],
    );
    let previous = temp.remote_url();
    temp.git(
        &temp.local,
        &[
            "remote",
            "set-url",
            "--add",
            "origin",
            temp.root.to_str().unwrap(),
        ],
    );
    assert_eq!(
        remotes(&temp.project())
            .unwrap()
            .into_iter()
            .find(|remote| remote.name == "origin")
            .unwrap()
            .ambiguous,
        Some(true)
    );
    assert_eq!(
        fetch(
            &temp.sessions,
            "project",
            "origin".into(),
            previous,
            &temp.version()
        )
        .unwrap_err()
        .code,
        "ambiguousRemote"
    );
}

#[test]
fn reads_and_checks_out_pull_requests_without_touching_other_refs() {
    use crate::project_git::{request_changes, request_checkout, RequestSource};
    let temp = Repositories::new("requests");
    let base = temp.git(&temp.local, &["rev-parse", "HEAD"]);
    temp.git(&temp.peer, &["switch", "-qc", "feature"]);
    temp.commit(&temp.peer, "feature\n", "feature");
    let head = temp.git(&temp.peer, &["rev-parse", "HEAD"]);
    temp.git(
        &temp.peer,
        &["push", "-q", "origin", "HEAD:refs/pull/7/head"],
    );
    temp.git(&temp.peer, &["push", "-q", "origin", "feature"]);
    // Git accepts this name but Soreno refuses it; it must not hide `origin`.
    temp.git(
        &temp.local,
        &[
            "remote",
            "add",
            "fork/alice",
            "https://example.com/alice.git",
        ],
    );
    assert_eq!(
        crate::project_git::first_remote_url(&temp.project(), &["upstream", "origin"])
            .unwrap()
            .map(|(name, _)| name)
            .as_deref(),
        Some("origin")
    );
    let refs_before = temp.git(&temp.local, &["for-each-ref"]);

    let changes = request_changes(
        &temp.sessions,
        "project",
        &RequestSource {
            remote: "origin",
            head_ref: "refs/pull/7/head",
            fallback_ref: None,
            head_oid: &head,
            base_oid: &base,
        },
    )
    .unwrap();
    assert_eq!(
        (changes.base.as_str(), changes.head.as_str()),
        (base.as_str(), head.as_str())
    );
    assert_eq!(
        changes
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["tracked"]
    );
    assert_eq!(temp.git(&temp.local, &["for-each-ref"]), refs_before);
    let comparison =
        crate::project_git::range_comparison(&temp.project(), &base, &head, "tracked").unwrap();
    assert_eq!(comparison.before.text.as_deref(), Some("initial\n"));
    assert_eq!(comparison.after.text.as_deref(), Some("feature\n"));

    // The forge deleted the request ref; the same-repository branch still has the commit.
    temp.commit(&temp.peer, "later\n", "later");
    let later = temp.git(&temp.peer, &["rev-parse", "HEAD"]);
    temp.git(&temp.peer, &["push", "-q", "origin", "feature"]);
    let expired = |fallback_ref, head_oid: &str| {
        request_changes(
            &temp.sessions,
            "project",
            &RequestSource {
                remote: "origin",
                head_ref: "refs/merge-requests/7/head",
                fallback_ref,
                head_oid,
                base_oid: &base,
            },
        )
    };
    assert!(expired(None, &"0".repeat(40)).is_err());
    assert_eq!(
        expired(Some("refs/heads/feature"), &later).unwrap().head,
        later
    );
    // Neither the request ref nor the branch remains, but the forge keeps the commit (GitLab keep-around).
    temp.commit(&temp.peer, "kept\n", "kept");
    let kept = temp.git(&temp.peer, &["rev-parse", "HEAD"]);
    temp.git(
        &temp.peer,
        &["push", "-q", "origin", "HEAD:refs/keep-around/kept"],
    );
    assert_eq!(expired(Some("refs/heads/gone"), &kept).unwrap().head, kept);
    // The branch survives but no longer contains the head, which the forge still keeps.
    temp.commit(&temp.peer, "rewritten\n", "rewritten");
    let rewritten = temp.git(&temp.peer, &["rev-parse", "HEAD"]);
    temp.git(
        &temp.peer,
        &["push", "-q", "origin", "HEAD:refs/keep-around/rewritten"],
    );
    assert_eq!(
        expired(Some("refs/heads/feature"), &rewritten)
            .unwrap()
            .head,
        rewritten
    );
    assert_eq!(temp.git(&temp.local, &["for-each-ref"]), refs_before);

    let fork = request_checkout(
        &temp.sessions,
        "project",
        &temp.version(),
        "origin",
        "refs/pull/7/head",
        "pr/7",
    )
    .unwrap();
    assert_eq!(
        (fork.name.as_str(), fork.remote, fork.oid.as_str()),
        ("origin/pr/7", true, head.as_str())
    );

    temp.git(&temp.local, &["branch", "feature", &base]);
    let existing = request_checkout(
        &temp.sessions,
        "project",
        &temp.version(),
        "origin",
        "refs/heads/feature",
        "feature",
    )
    .unwrap();
    assert_eq!(
        (existing.name.as_str(), existing.remote),
        ("feature", false)
    );
    assert_eq!(
        temp.git(&temp.local, &["rev-parse", "refs/remotes/origin/feature"]),
        later
    );
}
