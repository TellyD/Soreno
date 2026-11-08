use super::*;
use crate::{
    agent_sessions::{tests::unique_temp_path, AgentSessions},
    project_git::test_fixtures::{isolated_git, local_project, successful_stdout},
};
use std::path::PathBuf;

struct TempRepository {
    root: PathBuf,
    repository: PathBuf,
    sessions: AgentSessions,
}

impl TempRepository {
    fn new(label: &str, committed: bool) -> Self {
        let root = unique_temp_path(&format!("soreno-git-restore-{label}"));
        let repository = root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        let sessions = AgentSessions::open(&root.join("app-data")).unwrap();
        let temp = Self {
            root,
            repository,
            sessions,
        };
        temp.git(&["init", "-q"]);
        temp.git(&["config", "--local", "user.name", "Soreno Test"]);
        temp.git(&["config", "--local", "user.email", "test@soreno.invalid"]);
        temp.git(&["config", "--local", "commit.gpgSign", "false"]);
        temp.git(&["config", "--local", "core.autocrlf", "false"]);
        temp.git(&["config", "--local", "core.eol", "lf"]);
        temp.sessions
            .save_project(local_project("project", "Project", &temp.repository))
            .unwrap();
        if committed {
            std::fs::write(temp.repository.join("tracked"), "base\n").unwrap();
            temp.git(&["add", "tracked"]);
            temp.git(&["commit", "-qm", "initial"]);
        }
        temp
    }

    fn git(&self, args: &[&str]) -> String {
        let output = isolated_git(&self.root, &self.repository, args)
            .output()
            .unwrap();
        successful_stdout(output, args)
    }

    fn project(&self) -> AgentProject {
        self.sessions.project("project").unwrap()
    }

    fn snapshot(&self) -> GitRepository {
        repository(&self.project()).unwrap()
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn restore_preserves_the_exact_index_and_non_selected_files() {
    let temp = TempRepository::new("restore-partial", true);
    std::fs::write(temp.repository.join("other"), "base\n").unwrap();
    temp.git(&["add", "other"]);
    temp.git(&["commit", "-qm", "other"]);
    std::fs::write(temp.repository.join("tracked"), "index\n").unwrap();
    temp.git(&["add", "tracked"]);
    std::fs::write(temp.repository.join("tracked"), "worktree\n").unwrap();
    std::fs::write(temp.repository.join("other"), "untouched\n").unwrap();
    let index = temp.git(&["ls-files", "--stage"]);
    let version = temp.snapshot().version;
    let result = restore(&temp.sessions, "project", vec!["tracked".into()], &version).unwrap();

    assert!(result.oid.is_some());
    assert_eq!(temp.git(&["ls-files", "--stage"]), index);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "index\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("other")).unwrap(),
        "untouched\n"
    );
}

#[test]
fn restore_does_not_cross_from_an_unstaged_rename_target_to_its_old_path() {
    let temp = TempRepository::new("restore-rename-side", true);
    temp.git(&["mv", "tracked", "renamed"]);
    std::fs::write(temp.repository.join("renamed"), "worktree\n").unwrap();
    let index = temp.git(&["ls-files", "--stage"]);
    let version = temp.snapshot().version;
    restore(&temp.sessions, "project", vec!["renamed".into()], &version).unwrap();

    assert_eq!(temp.git(&["ls-files", "--stage"]), index);
    assert!(!temp.repository.join("tracked").exists());
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("renamed")).unwrap(),
        "base\n"
    );
}

#[test]
fn restore_rejects_a_file_to_directory_pathspec_collision() {
    let temp = TempRepository::new("restore-directory-collision", true);
    std::fs::remove_file(temp.repository.join("tracked")).unwrap();
    std::fs::create_dir(temp.repository.join("tracked")).unwrap();
    std::fs::write(temp.repository.join("tracked/descendant"), "keep\n").unwrap();
    let version = temp.snapshot().version;
    let error = restore(&temp.sessions, "project", vec!["tracked".into()], &version).unwrap_err();

    assert_eq!(error.code, "pathCollision");
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked/descendant")).unwrap(),
        "keep\n"
    );
    assert!(list_backup_oids(&temp.project()).unwrap().is_empty());
}

#[test]
fn restore_rejects_an_unborn_repository() {
    let temp = TempRepository::new("unborn", false);
    std::fs::write(temp.repository.join("new"), "content\n").unwrap();
    let version = temp.snapshot().version;
    assert_eq!(
        restore(&temp.sessions, "project", vec!["new".into()], &version)
            .unwrap_err()
            .code,
        "unborn"
    );
}

#[test]
fn restore_accepts_an_untracked_backup_when_git_reports_a_pathspec_failure() {
    let temp = TempRepository::new("untracked-backup", true);
    std::fs::write(temp.repository.join("new file"), "untracked\n").unwrap();
    let result = restore(
        &temp.sessions,
        "project",
        vec!["new file".into()],
        &temp.snapshot().version,
    )
    .unwrap();
    let backups = list_backup_oids(&temp.project()).unwrap();
    assert_eq!(backups.len(), 1);
    let oid = &backups[0];
    assert_eq!(result.oid.as_ref(), Some(oid));
    assert!(!temp.repository.join("new file").exists());
    assert_eq!(
        temp.git(&["show", &format!("{oid}^3:new file")]),
        "untracked"
    );
}

#[test]
fn restore_backup_is_recoverable_with_git_and_keeps_existing_stashes() {
    let temp = TempRepository::new("recovery", true);
    std::fs::write(temp.repository.join("tracked"), "previous backup\n").unwrap();
    temp.git(&["stash", "push", "-m", "existing"]);
    let existing = temp.git(&["rev-parse", "refs/stash"]);
    std::fs::write(temp.repository.join("tracked"), "changed\n").unwrap();
    std::fs::write(temp.repository.join("new file"), "untracked\n").unwrap();
    let result = restore(
        &temp.sessions,
        "project",
        vec!["tracked".into()],
        &temp.snapshot().version,
    )
    .unwrap();
    let oid = result.oid.unwrap();
    assert_ne!(oid, existing);
    assert_eq!(
        list_backup_oids(&temp.project()).unwrap(),
        [oid.clone(), existing.clone()]
    );
    assert!(temp.repository.join("new file").exists());
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "base\n"
    );

    temp.git(&["stash", "apply", "--index", &oid]);
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("tracked")).unwrap(),
        "changed\n"
    );
    assert_eq!(
        std::fs::read_to_string(temp.repository.join("new file")).unwrap(),
        "untracked\n"
    );
    assert_eq!(temp.git(&["diff", "--cached", "--exit-code"]), "");
    assert_eq!(list_backup_oids(&temp.project()).unwrap(), [oid, existing]);
}
