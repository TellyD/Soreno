use super::*;
use crate::agent_sessions::tests::unique_temp_path;
use crate::project_git::{
    repository,
    test_fixtures::{git_with_config_identity, local_project},
};
use std::path::PathBuf;

struct TempRepository(PathBuf);

impl TempRepository {
    fn new() -> Self {
        let path = unique_temp_path("soreno-git-history");
        std::fs::create_dir_all(&path).unwrap();
        let temp = Self(path);
        temp.git(&["init", "-q"]);
        temp.git(&["config", "--local", "core.autocrlf", "false"]);
        temp.git(&["config", "--local", "core.eol", "lf"]);
        temp
    }

    fn project(&self) -> AgentProject {
        self.project_at(&self.0)
    }

    fn project_at(&self, path: &std::path::Path) -> AgentProject {
        local_project("project", "Project", path)
    }

    fn git(&self, args: &[&str]) -> String {
        git_with_config_identity(&self.0, &self.0, args)
    }

    fn commit(&self, number: usize) -> String {
        std::fs::write(self.0.join("file"), format!("{number}\n")).unwrap();
        self.git(&["add", "file"]);
        self.git(&["commit", "-qm", &format!("commit {number}")]);
        self.git(&["rev-parse", "HEAD"])
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn uses_grouped_commit_metadata_and_exact_renamed_blob_modes() {
    let temp = TempRepository::new();
    temp.commit(0);
    std::fs::create_dir(temp.0.join("nested")).unwrap();
    std::fs::write(temp.0.join("nested/inside"), "inside\n").unwrap();
    std::fs::write(temp.0.join("nested/changed"), "inside base\n").unwrap();
    std::fs::write(temp.0.join("outside"), "outside base\n").unwrap();
    temp.git(&["add", "nested", "outside"]);
    temp.git(&["commit", "-qm", "nested base"]);
    std::fs::rename(temp.0.join("file"), temp.0.join("renamed")).unwrap();
    std::fs::rename(temp.0.join("nested/inside"), temp.0.join("nested/moved")).unwrap();
    std::fs::write(temp.0.join("nested/changed"), "inside changed\n").unwrap();
    std::fs::write(temp.0.join("outside"), "outside changed\n").unwrap();
    std::fs::write(temp.0.join("binary"), b"binary\0bytes").unwrap();
    temp.git(&["add", "-A"]);
    temp.git(&["update-index", "--chmod=+x", "renamed"]);
    temp.git(&["commit", "-qm", "renames and binary"]);
    temp.git(&["config", "diff.relative", "true"]);
    let oid = temp.git(&["rev-parse", "HEAD"]);
    let project = temp.project();
    let nested = temp.project_at(&temp.0.join("nested"));
    super::super::version(&project).unwrap();
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    let detail = commit_detail(&project, &oid).unwrap();
    assert_eq!(detail.files.len(), 5);
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 1));
    assert_eq!(commit_detail(&nested, &oid).unwrap(), detail);
    assert_eq!(
        history(&nested, None, 0, None).unwrap(),
        history(&project, None, 0, None).unwrap()
    );
    for path in ["nested/moved", "nested/changed", "outside"] {
        assert_eq!(
            commit_comparison(&nested, &oid, path).unwrap(),
            commit_comparison(&project, &oid, path).unwrap()
        );
    }
    let preview = commit_comparison(&project, &oid, "renamed").unwrap();
    assert_eq!(preview.old_path.as_deref(), Some("file"));
    assert_eq!(preview.before.mode, "100644");
    assert_eq!(preview.after.mode, "100755");
    assert_eq!(preview.before.text.as_deref(), Some("0\n"));
    assert_eq!(preview.before.text, preview.after.text);
    super::super::TEST_GIT_COMMANDS.with(|count| count.set(0));
    assert_eq!(
        commit_comparison(&project, &oid, "renamed").unwrap(),
        preview
    );
    super::super::TEST_GIT_COMMANDS.with(|count| assert_eq!(count.get(), 0));
    assert_eq!(
        commit_comparison(&project, &oid, "file").unwrap_err().code,
        "stalePath"
    );
    assert_eq!(
        commit_comparison(&project, &oid, "binary")
            .unwrap()
            .after
            .reason
            .as_deref(),
        Some("binary")
    );

    let bare_path = temp.0.join("bare.git");
    temp.git(&["clone", "-q", "--bare", ".", bare_path.to_str().unwrap()]);
    let bare = temp.project_at(&bare_path);
    assert_eq!(repository(&bare).unwrap().availability, "bare");
    assert_eq!(
        history(&bare, None, 0, None).unwrap(),
        history(&project, None, 0, None).unwrap()
    );
    assert_eq!(commit_detail(&bare, &oid).unwrap(), detail);
    assert_eq!(
        commit_comparison(&bare, &oid, "nested/changed").unwrap(),
        commit_comparison(&project, &oid, "nested/changed").unwrap()
    );

    let blob = temp.git(&["rev-parse", "HEAD:binary"]);
    assert!(commit_detail(&project, &blob).is_err());
}

#[test]
fn commit_numstat_reflects_changed_attributes() {
    let temp = TempRepository::new();
    temp.commit(0);
    let oid = temp.commit(1);
    let project = temp.project();

    let file = &commit_detail(&project, &oid).unwrap().files[0];
    assert_eq!((file.added, file.deleted), (Some(1), Some(1)));

    std::fs::write(temp.0.join(".git/info/attributes"), "* -diff\n").unwrap();
    let file = &commit_detail(&project, &oid).unwrap().files[0];
    assert_eq!((file.added, file.deleted), (None, None));
}

#[test]
fn commit_metadata_reflects_changed_shallow_boundary() {
    let temp = TempRepository::new();
    let root = temp.commit(0);
    let oid = temp.commit(1);
    let project = temp.project();
    let shallow = temp.0.join(".git/shallow");

    std::fs::write(&shallow, format!("{oid}\n")).unwrap();
    assert_eq!(commit_detail(&project, &oid).unwrap().parent, None);
    assert_eq!(
        commit_comparison(&project, &oid, "file")
            .unwrap()
            .before
            .text
            .as_deref(),
        Some("")
    );

    std::fs::remove_file(shallow).unwrap();
    assert_eq!(commit_detail(&project, &oid).unwrap().parent, Some(root));
    assert_eq!(
        commit_comparison(&project, &oid, "file")
            .unwrap()
            .before
            .text
            .as_deref(),
        Some("0\n")
    );
}

#[test]
fn accepts_git_valid_unicode_reference_whitespace() {
    assert_eq!(
        parse_references("tag: refs/tags/v\u{a0}1".as_bytes()).unwrap(),
        [GitCommitReference {
            name: "v\u{a0}1".into(),
            kind: GitCommitReferenceKind::Tag,
        }]
    );
}

#[test]
fn pages_from_immutable_roots_and_returns_all_ref_tips() {
    let temp = TempRepository::new();
    assert!(history(&temp.project(), None, 0, None)
        .unwrap()
        .commits
        .is_empty());
    let root = temp.commit(0);
    let root_comparison = commit_comparison(&temp.project(), &root, "file").unwrap();
    assert_eq!(root_comparison.before.text.as_deref(), Some(""));
    assert_eq!(root_comparison.after.text.as_deref(), Some("0\n"));
    for number in 1..51 {
        temp.commit(number);
    }
    let first = history(&temp.project(), None, 0, None).unwrap();
    assert_eq!(first.commits.len(), 50);
    assert!(first.has_more);
    let roots = first.roots.clone();
    let first_parent = temp.commit(52);
    let second = history(&temp.project(), Some(&roots), 50, None).unwrap();
    assert_eq!(second.commits.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.commits[0].oid, root);

    let main = temp.git(&["branch", "--show-current"]);
    temp.git(&["checkout", "-qb", "side", &root]);
    std::fs::write(temp.0.join("side"), "side\n").unwrap();
    temp.git(&["add", "side"]);
    temp.git(&["commit", "-qm", "side"]);
    let side = temp.git(&["rev-parse", "HEAD"]);
    temp.git(&["checkout", "-q", &main]);
    temp.git(&["merge", "--no-ff", "-qm", "merge", "side"]);
    let merge = temp.git(&["rev-parse", "HEAD"]);
    temp.git(&["tag", "v1.0", &merge]);
    temp.git(&["tag", "@", &merge]);
    temp.git(&["update-ref", "refs/remotes/origin/main", &merge]);
    temp.git(&["config", "log.excludeDecoration", "refs/tags/*"]);
    temp.git(&["checkout", "-qb", "unmerged", &root]);
    std::fs::write(temp.0.join("unmerged"), "unmerged\n").unwrap();
    temp.git(&["add", "unmerged"]);
    temp.git(&["commit", "-qm", "unmerged"]);
    let unmerged = temp.git(&["rev-parse", "HEAD"]);
    temp.git(&["checkout", "-q", &main]);
    assert_eq!(commit_detail(&temp.project(), &root).unwrap().parent, None);
    assert_eq!(
        commit_detail(&temp.project(), &merge).unwrap().parent,
        Some(first_parent.clone())
    );
    assert_ne!(
        commit_detail(&temp.project(), &merge).unwrap().parent,
        Some(side.clone())
    );

    let graph = history(&temp.project(), None, 0, None).unwrap();
    assert!(graph.roots.contains(&merge));
    assert!(graph.roots.contains(&unmerged));
    let merge_commit = graph
        .commits
        .iter()
        .find(|commit| commit.oid == merge)
        .unwrap();
    assert_eq!(merge_commit.parents, [first_parent, side.clone()]);
    assert_eq!(
        merge_commit.references,
        [
            GitCommitReference {
                name: "HEAD".into(),
                kind: GitCommitReferenceKind::Head,
            },
            GitCommitReference {
                name: main,
                kind: GitCommitReferenceKind::LocalBranch,
            },
            GitCommitReference {
                name: "v1.0".into(),
                kind: GitCommitReferenceKind::Tag,
            },
            GitCommitReference {
                name: "@".into(),
                kind: GitCommitReferenceKind::Tag,
            },
            GitCommitReference {
                name: "origin/main".into(),
                kind: GitCommitReferenceKind::RemoteBranch,
            },
        ]
    );
    let graph_next = history(&temp.project(), Some(&graph.roots), PAGE_SIZE, None).unwrap();
    let mut graph_commits = graph.commits.iter().chain(graph_next.commits.iter());
    assert_eq!(
        graph_commits
            .clone()
            .find(|commit| commit.oid == side)
            .unwrap()
            .references,
        [GitCommitReference {
            name: "side".into(),
            kind: GitCommitReferenceKind::LocalBranch,
        }]
    );
    assert_eq!(
        graph_commits
            .find(|commit| commit.oid == unmerged)
            .unwrap()
            .references,
        [GitCommitReference {
            name: "unmerged".into(),
            kind: GitCommitReferenceKind::LocalBranch,
        }]
    );
}

#[test]
fn filters_history_by_project_relative_path_with_connected_parents() {
    let temp = TempRepository::new();
    std::fs::create_dir(temp.0.join("nested")).unwrap();
    std::fs::write(temp.0.join("nested/tracked"), "1\n").unwrap();
    temp.git(&["add", "nested/tracked"]);
    temp.git(&["commit", "-qm", "add tracked"]);
    let first = temp.git(&["rev-parse", "HEAD"]);
    temp.commit(1);
    std::fs::write(temp.0.join("nested/tracked"), "2\n").unwrap();
    temp.git(&["commit", "-qam", "change tracked"]);
    let second = temp.git(&["rev-parse", "HEAD"]);

    let project = temp.project();
    let nested = temp.project_at(&temp.0.join("nested"));
    let filtered = history(&project, None, 0, Some("nested/tracked")).unwrap();
    assert_eq!(
        filtered
            .commits
            .iter()
            .map(|commit| (commit.oid.clone(), commit.parents.clone()))
            .collect::<Vec<_>>(),
        [(second.clone(), vec![first.clone()]), (first, Vec::new())]
    );
    assert_eq!(
        history(&nested, None, 0, Some("tracked")).unwrap(),
        filtered
    );
    assert_eq!(
        history(&project, None, 0, Some("nested"))
            .unwrap()
            .commits
            .len(),
        2
    );
    assert_eq!(
        history(&project, None, 0, Some("../file"))
            .unwrap_err()
            .code,
        "invalidPath"
    );

    assert_eq!(path_prefix(&project).unwrap().as_deref(), Some(""));
    assert_eq!(path_prefix(&nested).unwrap().as_deref(), Some("nested/"));
    let outside = unique_temp_path("soreno-git-prefix");
    std::fs::create_dir_all(&outside).unwrap();
    let result = path_prefix(&temp.project_at(&outside));
    let _ = std::fs::remove_dir_all(&outside);
    assert_eq!(result.unwrap(), None);
}

#[test]
fn filters_history_by_literal_path_without_pathspec_magic() {
    let temp = TempRepository::new();
    std::fs::write(temp.0.join("file1.txt"), "plain\n").unwrap();
    temp.git(&["add", "file1.txt"]);
    temp.git(&["commit", "-qm", "add plain"]);
    std::fs::write(temp.0.join("file[1].txt"), "bracket\n").unwrap();
    temp.git(&["add", "--", ":(literal)file[1].txt"]);
    temp.git(&["commit", "-qm", "add bracket"]);
    let bracket = temp.git(&["rev-parse", "HEAD"]);
    std::fs::write(temp.0.join("file1.txt"), "plain 2\n").unwrap();
    temp.git(&["commit", "-qam", "change plain"]);

    let filtered = history(&temp.project(), None, 0, Some("file[1].txt")).unwrap();
    assert_eq!(
        filtered
            .commits
            .iter()
            .map(|commit| commit.oid.clone())
            .collect::<Vec<_>>(),
        [bracket]
    );
}
