use super::*;
use crate::project_git::test_fixtures::local_project;
#[cfg(unix)]
use std::path::Path;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempProject(PathBuf);

impl TempProject {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "soreno-project-file-operations-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn project(&self) -> AgentProject {
        local_project("project", "Project", &self.0)
    }

    #[cfg(unix)]
    fn root(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, ProjectFileError>) -> String {
    result.unwrap_err().code
}

/// Runs a remote script with the local shell and returns (success, stdout, stderr).
#[cfg(unix)]
fn run_script(script: &str) -> (bool, String, String) {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .output()
        .unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[cfg(unix)]
fn run_script_with_input(script: &str, input: &[u8]) -> (bool, String, String) {
    use std::io::Write;
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn duplicate_names_follow_copy_naming_rules() {
    let names = |name, directory| duplicate_names(name, directory).collect::<Vec<_>>();
    let files = names("photo.tar.gz", false);
    assert_eq!(files[0], "photo.tar copy.gz");
    assert_eq!(files[1], "photo.tar copy 2.gz");
    assert_eq!(files.len(), 100);
    assert_eq!(files[99], "photo.tar copy 100.gz");
    assert_eq!(names(".env", false)[0], ".env copy");
    assert_eq!(names("Makefile", false)[1], "Makefile copy 2");
    assert_eq!(names("src.v2", true)[0], "src.v2 copy");
    assert_eq!(names("src.v2", true)[1], "src.v2 copy 2");
}

#[test]
fn creates_files_and_directories_with_missing_parents() {
    let temp = TempProject::new();
    let project = temp.project();

    let file = create(&project, "src/nested/main.rs", ProjectFileKind::File).unwrap();
    assert_eq!(file.path, "src/nested/main.rs");
    assert_eq!(file.name, "main.rs");
    assert_eq!(file.kind, "file");
    assert!(file.editable);
    assert_eq!(fs::read(temp.0.join("src/nested/main.rs")).unwrap(), b"");

    let directory = create(&project, "assets/icons", ProjectFileKind::Directory).unwrap();
    assert_eq!(directory.path, "assets/icons");
    assert_eq!(directory.kind, "directory");
    assert!(temp.0.join("assets/icons").is_dir());

    assert_eq!(
        code(create(
            &project,
            "src/nested/main.rs",
            ProjectFileKind::File
        )),
        "exists"
    );
    assert_eq!(
        code(create(&project, "assets/icons", ProjectFileKind::File)),
        "exists"
    );
    assert_eq!(
        code(create(
            &project,
            "src/nested/main.rs/child",
            ProjectFileKind::File
        )),
        "notDirectory"
    );
}

#[test]
fn renames_and_moves_files_and_directories() {
    let temp = TempProject::new();
    let project = temp.project();
    fs::create_dir_all(temp.0.join("src/inner")).unwrap();
    fs::write(temp.0.join("src/inner/a.txt"), "a").unwrap();
    fs::write(temp.0.join("note.md"), "note").unwrap();
    fs::write(temp.0.join("other.md"), "other").unwrap();

    let renamed = rename(&project, "note.md", "readme.md").unwrap();
    assert_eq!(
        (renamed.path.as_str(), renamed.kind.as_str()),
        ("readme.md", "file")
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("readme.md")).unwrap(),
        "note"
    );
    assert!(!temp.0.join("note.md").exists());

    let moved = rename(&project, "readme.md", "docs/guide/readme.md").unwrap();
    assert_eq!(moved.path, "docs/guide/readme.md");
    assert_eq!(
        fs::read_to_string(temp.0.join("docs/guide/readme.md")).unwrap(),
        "note"
    );

    let directory = rename(&project, "src", "lib").unwrap();
    assert_eq!(
        (directory.path.as_str(), directory.kind.as_str()),
        ("lib", "directory")
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("lib/inner/a.txt")).unwrap(),
        "a"
    );

    assert_eq!(code(rename(&project, "other.md", "lib")), "exists");
    assert_eq!(code(rename(&project, "missing.md", "found.md")), "notFound");
    assert_eq!(
        fs::read_to_string(temp.0.join("other.md")).unwrap(),
        "other"
    );
}

#[test]
fn refuses_invalid_paths_for_every_operation() {
    let temp = TempProject::new();
    let project = temp.project();
    fs::create_dir(temp.0.join("src")).unwrap();
    for path in [
        "",
        "../x",
        "/etc/passwd",
        ".git/config",
        "a/./b",
        "a\\b",
        "src/",
    ] {
        assert_eq!(
            code(create(&project, path, ProjectFileKind::File)),
            "invalidPath"
        );
        assert_eq!(code(rename(&project, "src", path)), "invalidPath");
        assert_eq!(code(delete(&project, path)), "invalidPath");
        assert_eq!(code(duplicate(&project, path)), "invalidPath");
    }
    assert_eq!(code(rename(&project, "src", "src")), "invalidPath");
    assert_eq!(code(rename(&project, "src", "src/inner")), "invalidPath");
    assert!(temp.0.join("src").is_dir());
}

#[test]
fn deletes_files_and_directories_recursively() {
    let temp = TempProject::new();
    let project = temp.project();
    fs::create_dir_all(temp.0.join("build/deep/er")).unwrap();
    fs::write(temp.0.join("build/deep/er/out.o"), "o").unwrap();
    fs::write(temp.0.join("build/top.txt"), "t").unwrap();
    fs::write(temp.0.join("note.md"), "n").unwrap();

    delete(&project, "note.md").unwrap();
    assert!(!temp.0.join("note.md").exists());
    delete(&project, "build").unwrap();
    assert!(!temp.0.join("build").exists());
    assert_eq!(code(delete(&project, "build")), "notFound");
}

#[test]
fn duplicates_files_and_directories() {
    let temp = TempProject::new();
    let project = temp.project();
    fs::create_dir_all(temp.0.join("pkg/src")).unwrap();
    fs::write(temp.0.join("pkg/src/lib.rs"), "lib").unwrap();
    fs::write(temp.0.join("pkg/run.sh"), "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.0.join("pkg/run.sh"), fs::Permissions::from_mode(0o751)).unwrap();
    }

    let first = duplicate(&project, "pkg/run.sh").unwrap();
    assert_eq!(
        (first.path.as_str(), first.kind.as_str()),
        ("pkg/run copy.sh", "file")
    );
    let second = duplicate(&project, "pkg/run.sh").unwrap();
    assert_eq!(second.path, "pkg/run copy 2.sh");
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg/run copy 2.sh")).unwrap(),
        "#!/bin/sh\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(temp.0.join("pkg/run copy.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o7777, 0o751);
    }

    let directory = duplicate(&project, "pkg").unwrap();
    assert_eq!(
        (directory.path.as_str(), directory.kind.as_str()),
        ("pkg copy", "directory")
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg copy/src/lib.rs")).unwrap(),
        "lib"
    );
    assert!(temp.0.join("pkg copy/run copy 2.sh").is_file());
    assert_eq!(duplicate(&project, "pkg").unwrap().path, "pkg copy 2");
    assert_eq!(code(duplicate(&project, "missing")), "notFound");
}

#[test]
fn duplicate_reports_exists_when_every_name_is_taken() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    for name in duplicate_names("a.txt", false) {
        fs::write(temp.0.join(name), "").unwrap();
    }
    assert_eq!(code(duplicate(&temp.project(), "a.txt")), "exists");
}

#[test]
fn imports_outside_files_beside_taken_names() {
    let temp = TempProject::new();
    let project = temp.project();
    let outside = TempProject::new();
    fs::create_dir(temp.0.join("assets")).unwrap();
    fs::write(temp.0.join("assets/photo.png"), "old").unwrap();
    fs::write(outside.0.join("photo.png"), "new").unwrap();
    fs::write(outside.0.join("notes.txt"), "notes").unwrap();
    let sources = [outside.0.join("photo.png"), outside.0.join("notes.txt")];

    let entries = import_files(&project, "assets", &sources).unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.kind.as_str()))
            .collect::<Vec<_>>(),
        [
            ("assets/photo copy.png", "file"),
            ("assets/notes.txt", "file")
        ]
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("assets/photo.png")).unwrap(),
        "old"
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("assets/photo copy.png")).unwrap(),
        "new"
    );
    assert_eq!(
        import_files(&project, "", &sources[1..]).unwrap()[0].path,
        "notes.txt"
    );
    assert_eq!(
        fs::read_to_string(outside.0.join("notes.txt")).unwrap(),
        "notes"
    );

    assert_eq!(
        code(import_files(&project, "missing", &sources)),
        "notFound"
    );
    assert_eq!(
        code(import_files(&project, "../outside", &sources)),
        "invalidPath"
    );
}

#[test]
fn import_checks_every_source_before_copying() {
    let temp = TempProject::new();
    let project = temp.project();
    let outside = TempProject::new();
    fs::write(outside.0.join("a.txt"), "a").unwrap();
    fs::create_dir(outside.0.join("folder")).unwrap();

    for (invalid, expected) in [("folder", "pastedDirectory"), ("gone.txt", "notFound")] {
        let sources = [outside.0.join("a.txt"), outside.0.join(invalid)];
        assert_eq!(code(import_files(&project, "", &sources)), expected);
    }
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn import_refuses_a_linked_target_directory() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("a.txt"), "a").unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
    assert_eq!(
        code(import_files(
            &temp.project(),
            "linked",
            &[outside.0.join("a.txt")]
        )),
        "symlink"
    );
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
}

#[test]
fn mutations_invalidate_the_cached_git_inventory() {
    let temp = TempProject::new();
    let project = temp.project();
    let key = super::super::search_cache_key(&project);
    {
        let mut cache = super::super::SEARCH_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let token = cache.begin_acquisition(&key);
        cache.publish(
            &key,
            token,
            super::super::CachedGitInventory {
                paths: std::sync::Arc::new(Vec::new()),
                truncated: false,
            },
        );
    }
    create(&project, "new.txt", ProjectFileKind::File).unwrap();
    let mut cache = super::super::SEARCH_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(cache.get(&key).is_none());
}

#[cfg(unix)]
#[test]
fn refuses_symlink_components_and_keeps_outside_content() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
    fs::write(temp.0.join("inside.txt"), "inside").unwrap();
    let project = temp.project();

    assert_eq!(
        code(create(&project, "linked/new.txt", ProjectFileKind::File)),
        "symlink"
    );
    assert_eq!(
        code(create(&project, "linked/dir", ProjectFileKind::Directory)),
        "symlink"
    );
    assert_eq!(
        code(rename(&project, "linked/secret.txt", "taken.txt")),
        "symlink"
    );
    assert_eq!(
        code(rename(&project, "inside.txt", "linked/inside.txt")),
        "symlink"
    );
    assert_eq!(code(rename(&project, "linked", "renamed")), "symlink");
    assert_eq!(code(delete(&project, "linked/secret.txt")), "symlink");
    assert_eq!(code(delete(&project, "linked")), "symlink");
    assert_eq!(code(duplicate(&project, "linked/secret.txt")), "symlink");
    assert_eq!(code(duplicate(&project, "linked")), "symlink");

    assert_eq!(
        fs::read_dir(&outside.0).unwrap().count(),
        1,
        "outside directory must stay untouched"
    );
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.txt")).unwrap(),
        "secret"
    );
    assert!(temp.0.join("inside.txt").is_file());
    assert!(fs::symlink_metadata(temp.0.join("linked"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn deleting_a_directory_removes_inner_links_but_not_their_targets() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "secret").unwrap();
    fs::create_dir(temp.0.join("dir")).unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("dir/linked")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("secret.txt"), temp.0.join("dir/file-link")).unwrap();

    delete(&temp.project(), "dir").unwrap();

    assert!(!temp.0.join("dir").exists());
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.txt")).unwrap(),
        "secret"
    );
}

#[cfg(unix)]
#[test]
fn duplicating_a_directory_recreates_inner_links_as_links() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("dir")).unwrap();
    fs::write(temp.0.join("dir/target.txt"), "t").unwrap();
    std::os::unix::fs::symlink("target.txt", temp.0.join("dir/link")).unwrap();

    duplicate(&temp.project(), "dir").unwrap();

    let link = temp.0.join("dir copy/link");
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("target.txt"));
}

#[cfg(unix)]
#[test]
fn rename_keeps_the_same_inode_case_only_rule_strict_on_case_sensitive_filesystems() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "lower").unwrap();
    fs::write(temp.0.join("A.txt"), "upper").unwrap();
    let project = temp.project();
    if fs::read_to_string(temp.0.join("a.txt")).unwrap() == "upper" {
        return;
    }
    assert_eq!(code(rename(&project, "a.txt", "A.txt")), "exists");
    delete(&project, "A.txt").unwrap();
    rename(&project, "a.txt", "A.txt").unwrap();
    assert_eq!(fs::read_to_string(temp.0.join("A.txt")).unwrap(), "lower");
}

#[cfg(unix)]
#[test]
fn rename_refuses_case_only_names_that_are_hard_links_to_one_file() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    if temp.0.join("A.txt").exists() {
        return; // Case-insensitive filesystem: both names are one entry.
    }
    fs::hard_link(temp.0.join("a.txt"), temp.0.join("A.txt")).unwrap();
    let project = temp.project();
    assert_eq!(code(rename(&project, "a.txt", "A.txt")), "exists");
    assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(temp.0.join("A.txt")).unwrap(), "a");
    let mut names: Vec<_> = fs::read_dir(&temp.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["A.txt", "a.txt"]);

    rename(&project, "a.txt", "b.txt").unwrap();
    assert_eq!(fs::read_to_string(temp.0.join("b.txt")).unwrap(), "a");
    assert!(!temp.0.join("a.txt").exists());
    assert_eq!(fs::read_to_string(temp.0.join("A.txt")).unwrap(), "a");
}

#[test]
fn portable_implementation_handles_the_main_operations() {
    let temp = TempProject::new();
    let root = temp.0.as_path();
    portable::create(root, "src/nested/main.rs", ProjectFileKind::File).unwrap();
    portable::create(root, "assets", ProjectFileKind::Directory).unwrap();
    assert!(temp.0.join("src/nested/main.rs").is_file());
    assert!(temp.0.join("assets").is_dir());
    assert_eq!(
        code(portable::create(root, "assets", ProjectFileKind::File)),
        "exists"
    );
    assert_eq!(
        code(portable::create(
            root,
            "src/nested/main.rs/x",
            ProjectFileKind::File
        )),
        "notDirectory"
    );

    fs::write(temp.0.join("src/nested/main.rs"), "fn main() {}").unwrap();
    assert_eq!(
        portable::rename(root, "src/nested/main.rs", "bin/app.rs").unwrap(),
        ProjectFileKind::File
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("bin/app.rs")).unwrap(),
        "fn main() {}"
    );
    assert_eq!(
        code(portable::rename(root, "bin/app.rs", "assets")),
        "exists"
    );
    assert_eq!(code(portable::rename(root, "missing", "other")), "notFound");
    assert_eq!(
        portable::rename(root, "src", "lib").unwrap(),
        ProjectFileKind::Directory
    );
    assert!(temp.0.join("lib/nested").is_dir());

    assert_eq!(
        portable::duplicate(root, "bin/app.rs").unwrap(),
        ("app copy.rs".into(), ProjectFileKind::File)
    );
    assert_eq!(
        portable::duplicate(root, "bin/app.rs").unwrap(),
        ("app copy 2.rs".into(), ProjectFileKind::File)
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("bin/app copy 2.rs")).unwrap(),
        "fn main() {}"
    );
    assert_eq!(
        portable::duplicate(root, "bin").unwrap(),
        ("bin copy".into(), ProjectFileKind::Directory)
    );
    assert!(temp.0.join("bin copy/app copy.rs").is_file());
    let source = temp.0.join("bin/app copy 2.rs");
    let mut file = fs::File::open(&source).unwrap();
    assert_eq!(
        portable::import(root, "bin/app.rs", &mut file).unwrap(),
        "app copy 3.rs"
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("bin/app copy 3.rs")).unwrap(),
        "fn main() {}"
    );

    portable::delete(root, "bin/app.rs").unwrap();
    assert!(!temp.0.join("bin/app.rs").exists());
    portable::delete(root, "bin copy").unwrap();
    assert!(!temp.0.join("bin copy").exists());
    assert_eq!(code(portable::delete(root, "bin copy")), "notFound");
}

#[cfg(unix)]
#[test]
fn portable_implementation_refuses_links() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
    fs::create_dir(temp.0.join("tree")).unwrap();
    fs::write(temp.0.join("tree/file.txt"), "f").unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("tree/linked")).unwrap();
    let root = temp.0.as_path();

    assert_eq!(
        code(portable::create(root, "linked/x", ProjectFileKind::File)),
        "symlink"
    );
    assert_eq!(
        code(portable::rename(root, "linked/secret.txt", "x")),
        "symlink"
    );
    assert_eq!(code(portable::rename(root, "linked", "x")), "symlink");
    assert_eq!(code(portable::delete(root, "linked")), "symlink");
    assert_eq!(
        code(portable::duplicate(root, "linked/secret.txt")),
        "symlink"
    );
    assert_eq!(code(portable::duplicate(root, "tree")), "symlink");
    assert!(
        !temp.0.join("tree copy").exists(),
        "partial copy is removed"
    );

    portable::delete(root, "tree").unwrap();
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn remote_create_script_creates_and_reports_conflicts() {
    let temp = TempProject::new();
    let (ok, _, stderr) = run_script(&remote_create_script(
        temp.root(),
        "src/-nested/main.rs",
        ProjectFileKind::File,
    ));
    assert!(ok, "{stderr}");
    assert!(temp.0.join("src/-nested/main.rs").is_file());

    let (ok, _, stderr) = run_script(&remote_create_script(
        temp.root(),
        "assets/icons",
        ProjectFileKind::Directory,
    ));
    assert!(ok, "{stderr}");
    assert!(temp.0.join("assets/icons").is_dir());

    let (ok, _, stderr) = run_script(&remote_create_script(
        temp.root(),
        "assets/icons",
        ProjectFileKind::File,
    ));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn remote_rename_script_moves_and_reports_conflicts() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("src")).unwrap();
    fs::write(temp.0.join("src/a.txt"), "a").unwrap();
    fs::write(temp.0.join("b.txt"), "b").unwrap();

    let (ok, stdout, stderr) = run_script(&remote_rename_script(
        temp.root(),
        "src/a.txt",
        "docs/new/a.txt",
    ));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f");
    assert_eq!(
        fs::read_to_string(temp.0.join("docs/new/a.txt")).unwrap(),
        "a"
    );

    let (ok, stdout, stderr) = run_script(&remote_rename_script(temp.root(), "docs", "lib"));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "d");
    assert!(temp.0.join("lib/new/a.txt").is_file());

    let (ok, _, stderr) = run_script(&remote_rename_script(temp.root(), "b.txt", "lib"));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert!(temp.0.join("b.txt").is_file());

    let (ok, _, stderr) = run_script(&remote_rename_script(temp.root(), "missing", "x"));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_NOT_FOUND"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn remote_delete_script_removes_trees_and_reports_missing_targets() {
    let temp = TempProject::new();
    fs::create_dir_all(temp.0.join("build/deep")).unwrap();
    fs::write(temp.0.join("build/deep/out.o"), "o").unwrap();

    let (ok, _, stderr) = run_script(&remote_delete_script(temp.root(), "build"));
    assert!(ok, "{stderr}");
    assert!(!temp.0.join("build").exists());

    let (ok, _, stderr) = run_script(&remote_delete_script(temp.root(), "build"));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_NOT_FOUND"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn remote_duplicate_script_picks_the_first_free_name() {
    let temp = TempProject::new();
    fs::create_dir_all(temp.0.join("pkg/src")).unwrap();
    fs::write(temp.0.join("pkg/src/lib.rs"), "lib").unwrap();
    fs::write(temp.0.join("pkg/run.sh"), "run").unwrap();

    let (ok, stdout, stderr) = run_script(&remote_duplicate_script(temp.root(), "pkg/run.sh"));
    assert!(ok, "{stderr}");
    assert_eq!(
        parse_remote_duplicate(stdout.as_bytes(), "run.sh").unwrap(),
        ("run copy.sh".into(), ProjectFileKind::File)
    );
    let (ok, stdout, stderr) = run_script(&remote_duplicate_script(temp.root(), "pkg/run.sh"));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f\nrun copy 2.sh");
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg/run copy 2.sh")).unwrap(),
        "run"
    );

    let (ok, stdout, stderr) = run_script(&remote_duplicate_script(temp.root(), "pkg"));
    assert!(ok, "{stderr}");
    assert_eq!(
        parse_remote_duplicate(stdout.as_bytes(), "pkg").unwrap(),
        ("pkg copy".into(), ProjectFileKind::Directory)
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg copy/src/lib.rs")).unwrap(),
        "lib"
    );

    assert!(parse_remote_duplicate(b"f\n../escape", "run.sh").is_err());
    assert!(parse_remote_duplicate(b"d\nrun copy.sh", "run.sh").is_err());
}

#[cfg(unix)]
#[test]
fn remote_duplicate_script_reports_exhaustion() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    for name in duplicate_names("a.txt", false) {
        fs::write(temp.0.join(name), "").unwrap();
    }
    let (ok, _, stderr) = run_script(&remote_duplicate_script(temp.root(), "a.txt"));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn remote_import_script_writes_stdin_under_the_first_free_name() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("pkg")).unwrap();

    let (ok, stdout, stderr) =
        run_script_with_input(&remote_import_script(temp.root(), "pkg/a b.png"), b"one");
    assert!(ok, "{stderr}");
    assert_eq!(
        parse_remote_import(stdout.as_bytes(), "a b.png").unwrap(),
        "a b.png"
    );
    let (ok, stdout, stderr) =
        run_script_with_input(&remote_import_script(temp.root(), "pkg/a b.png"), b"two");
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "a b copy.png");
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg/a b.png")).unwrap(),
        "one"
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg/a b copy.png")).unwrap(),
        "two"
    );

    let outside = TempProject::new();
    fs::write(outside.0.join("target.png"), "outside").unwrap();
    std::os::unix::fs::symlink(outside.0.join("target.png"), temp.0.join("pkg/link.png")).unwrap();
    let (ok, stdout, stderr) =
        run_script_with_input(&remote_import_script(temp.root(), "pkg/link.png"), b"three");
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "link copy.png");
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg/link copy.png")).unwrap(),
        "three"
    );
    assert_eq!(
        fs::read_to_string(outside.0.join("target.png")).unwrap(),
        "outside"
    );

    let (ok, _, stderr) = run_script(&remote_import_script(temp.root(), "missing/a.png"));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_NOT_FOUND"), "{stderr}");
    assert!(parse_remote_import(b"../a.png", "a.png").is_err());
}

#[cfg(unix)]
#[test]
fn remote_scripts_refuse_links_and_paths_outside_the_root() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
    fs::write(temp.0.join("inside.txt"), "inside").unwrap();

    for script in [
        remote_create_script(temp.root(), "linked/new.txt", ProjectFileKind::File),
        remote_rename_script(temp.root(), "linked/secret.txt", "x.txt"),
        remote_rename_script(temp.root(), "inside.txt", "linked/inside.txt"),
        remote_delete_script(temp.root(), "linked"),
        remote_delete_script(temp.root(), "linked/secret.txt"),
        remote_duplicate_script(temp.root(), "linked/secret.txt"),
        remote_import_script(temp.root(), "linked/new.txt"),
    ] {
        let (ok, _, stderr) = run_script(&script);
        assert!(!ok);
        assert!(stderr.contains("SORENO_FILE_SYMLINK"), "{stderr}");
    }
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
    assert!(temp.0.join("inside.txt").is_file());

    // Simulate a parent that resolves physically outside the root's real location.
    let nested = temp.0.join("inside-root");
    fs::create_dir(&nested).unwrap();
    let nested_root = nested.to_str().unwrap();
    let script = remote_create_script(nested_root, "x.txt", ProjectFileKind::File).replacen(
        &format!("root_real=$(cd -P -- {}", crate::ssh::quote(nested_root)),
        &format!("root_real=$(cd -P -- {}", crate::ssh::quote(outside.root())),
        1,
    );
    assert!(script.contains(&crate::ssh::quote(outside.root())));
    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_OUTSIDE"), "{stderr}");
    assert!(!nested.join("x.txt").exists());
}

#[test]
fn plain_components_refuse_drive_relative_and_stream_names_on_windows() {
    for path in ["C:x", "a/C:x", "C:/x", "a/b:stream", "file.txt::$DATA"] {
        assert!(!plain_components(path, true), "{path}");
    }
    for path in ["a", "a/b.txt", "dir/with space/x"] {
        assert!(plain_components(path, true), "{path}");
        assert!(plain_components(path, false), "{path}");
    }
    #[cfg(not(windows))]
    assert!(plain_components("a/C:x", false));
}

#[cfg(windows)]
#[test]
fn refuses_drive_relative_names_before_touching_the_filesystem() {
    let temp = TempProject::new();
    let project = temp.project();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    assert_eq!(
        code(create(&project, "C:x", ProjectFileKind::File)),
        "invalidPath"
    );
    assert_eq!(
        code(create(&project, "dir/C:x", ProjectFileKind::Directory)),
        "invalidPath"
    );
    assert_eq!(code(rename(&project, "a.txt", "C:a.txt")), "invalidPath");
    assert_eq!(code(delete(&project, "C:a.txt")), "invalidPath");
    assert_eq!(code(duplicate(&project, "a.txt:stream")), "invalidPath");
    assert!(!temp.0.join("dir").exists());
}

#[cfg(unix)]
#[test]
fn remote_scripts_keep_trailing_newlines_in_directory_names() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("x")).unwrap();
    fs::create_dir(temp.0.join("x\n")).unwrap();
    fs::write(temp.0.join("x/victim"), "keep").unwrap();
    fs::write(temp.0.join("x\n/victim"), "drop").unwrap();
    fs::write(temp.0.join("x\n/source"), "source").unwrap();

    let (ok, _, stderr) = run_script(&remote_delete_script(temp.root(), "x\n/victim"));
    assert!(ok, "{stderr}");
    assert!(!temp.0.join("x\n/victim").exists());
    assert_eq!(fs::read_to_string(temp.0.join("x/victim")).unwrap(), "keep");

    let (ok, stdout, stderr) = run_script(&remote_duplicate_script(temp.root(), "x\n/source"));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f\nsource copy");
    assert!(temp.0.join("x\n/source copy").is_file());
    assert!(!temp.0.join("x/source copy").exists());

    let (ok, _, stderr) = run_script(&remote_rename_script(
        temp.root(),
        "x\n/source",
        "x\n/renamed",
    ));
    assert!(ok, "{stderr}");
    assert!(temp.0.join("x\n/renamed").is_file());
    assert!(!temp.0.join("x/renamed").exists());

    let root = temp.0.join("r\n");
    fs::create_dir(&root).unwrap();
    fs::create_dir(temp.0.join("r")).unwrap();
    let (ok, _, stderr) = run_script(&remote_create_script(
        root.to_str().unwrap(),
        "a.txt",
        ProjectFileKind::File,
    ));
    assert!(ok, "{stderr}");
    assert!(root.join("a.txt").is_file());
    assert!(!temp.0.join("r/a.txt").exists());
}

#[cfg(unix)]
#[test]
fn remote_scripts_accept_the_filesystem_root() {
    let temp = TempProject::new();
    let real = fs::canonicalize(&temp.0).unwrap();
    let relative = real.to_str().unwrap().trim_start_matches('/').to_owned();

    let (ok, _, stderr) = run_script(&remote_create_script(
        "/",
        &format!("{relative}/nested/a.txt"),
        ProjectFileKind::File,
    ));
    assert!(ok, "{stderr}");
    assert!(real.join("nested/a.txt").is_file());

    let (ok, stdout, stderr) = run_script(&remote_rename_script(
        "/",
        &format!("{relative}/nested/a.txt"),
        &format!("{relative}/b.txt"),
    ));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f");

    let (ok, _, stderr) = run_script(&remote_delete_script("/", &format!("{relative}/b.txt")));
    assert!(ok, "{stderr}");
    assert!(!real.join("b.txt").exists());
}

#[cfg(unix)]
#[test]
fn remote_walk_refuses_links_without_creating_directories_outside() {
    let temp = TempProject::new();
    let outside = TempProject::new();
    std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
    fs::write(temp.0.join("inside.txt"), "inside").unwrap();

    // Without the up-front guards, as if the component became a link after they ran.
    for (script, guarded) in [
        (
            remote_create_script(temp.root(), "linked/sub/x.txt", ProjectFileKind::File),
            vec!["linked/sub/x.txt"],
        ),
        (
            remote_rename_script(temp.root(), "inside.txt", "linked/sub/inside.txt"),
            vec!["inside.txt", "linked/sub/inside.txt"],
        ),
    ] {
        let guards: String = guarded
            .iter()
            .map(|path| remote_guard(temp.root(), path))
            .collect();
        assert!(script.contains(&guards));
        let (ok, _, stderr) = run_script(&script.replacen(&guards, "", 1));
        assert!(!ok);
        assert!(stderr.contains("SORENO_FILE_SYMLINK"), "{stderr}");
    }
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    assert!(temp.0.join("inside.txt").is_file());
}

#[cfg(unix)]
#[test]
fn remote_rename_never_overwrites_an_existing_destination() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::write(temp.0.join("c.txt"), "c").unwrap();

    let script = remote_rename_script(temp.root(), "a.txt", "c.txt");
    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");

    // Destination appearing after the existence check: only `mv -n` stands in the way.
    let check = "if [ -e \"$target\" ] || [ -L \"$target\" ]; then {";
    assert!(script.contains(check));
    let (ok, _, stderr) = run_script(&script.replacen(check, "if false; then {", 1));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert_eq!(fs::read_to_string(temp.0.join("c.txt")).unwrap(), "c");
    assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
}

#[cfg(unix)]
#[test]
fn remote_rename_never_moves_the_source_into_a_directory_at_the_target() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::create_dir(temp.0.join("d")).unwrap();

    // A directory appearing at the target after the existence check.
    let check = "if [ -e \"$target\" ] || [ -L \"$target\" ]; then {";
    let script = remote_rename_script(temp.root(), "a.txt", "d");
    assert!(script.contains(check));
    let script = script.replacen(check, "if false; then {", 1);
    let mv_has_target_option = std::process::Command::new("mv")
        .args(["-T", "--version"])
        .output()
        .is_ok_and(|output| output.status.success());
    if mv_has_target_option {
        let (ok, _, stderr) = run_script(&script);
        assert!(!ok);
        assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
        assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
        assert!(!temp.0.join("d/a.txt").exists());
    }

    // Without `mv -T`, the plain `mv -n` fallback is caught by the kind check.
    assert!(script.contains("mv -n -T --"));
    let (ok, _, stderr) = run_script(&script.replacen("mv -n -T --", "mv -n -@ --", 1));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");

    // A directory moved into a directory appearing at the target is caught too.
    fs::create_dir(temp.0.join("src")).unwrap();
    fs::create_dir(temp.0.join("e")).unwrap();
    let script = remote_rename_script(temp.root(), "src", "e")
        .replacen(check, "if false; then {", 1)
        .replacen("mv -n -T --", "mv -n -@ --", 1);
    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn remote_rename_fallback_reports_legitimate_moves_as_success() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::create_dir_all(temp.0.join("dir/sub")).unwrap();
    fs::write(temp.0.join("dir/sub/x"), "x").unwrap();
    // A directory that already holds an entry with its own name.
    fs::create_dir_all(temp.0.join("self/self")).unwrap();
    let fallback = |from, to| {
        let script = remote_rename_script(temp.root(), from, to);
        assert!(script.contains("mv -n -T --"));
        run_script(&script.replacen("mv -n -T --", "mv -n -@ --", 1))
    };

    let (ok, stdout, stderr) = fallback("a.txt", "moved/b.txt");
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f");
    assert_eq!(fs::read_to_string(temp.0.join("moved/b.txt")).unwrap(), "a");

    let (ok, stdout, stderr) = fallback("dir", "moved/renamed");
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "d");
    assert!(temp.0.join("moved/renamed/sub/x").is_file());

    let (ok, stdout, stderr) = fallback("self", "other");
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "d");
    assert!(temp.0.join("other/self").is_dir());
    assert!(!temp.0.join("self").exists());
}

#[cfg(unix)]
#[test]
fn remote_case_only_rename_without_mv_target_option_goes_through_a_temporary_name() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("dir")).unwrap();
    fs::write(temp.0.join("dir/x"), "x").unwrap();
    if temp.0.join("DIR/x").exists() {
        return; // The faked same-file cases below need a case-sensitive filesystem.
    }
    let same_file = "[ \"$source\" -ef \"$target\" ]";
    let script = remote_rename_script(temp.root(), "dir", "DIR");
    assert!(script.contains(same_file) && script.contains("mv -T --"));
    let script = script.replacen("mv -T --", "mv -@ --", 1);

    // A same-file target (faked: the target name is released) receives the source under its exact name.
    fs::create_dir(temp.0.join("DIR")).unwrap();
    let released = script.replacen(same_file, "rmdir -- \"$target\"", 1);
    let (ok, stdout, stderr) = run_script(&released);
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "d");
    assert!(temp.0.join("DIR/x").is_file());
    assert!(!temp.0.join("DIR/dir").exists());
    let leftovers = fs::read_dir(&temp.0)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".soreno-rename.")
        })
        .count();
    assert_eq!(leftovers, 0);

    // A target name that stays distinct (hard links on a case-sensitive host) keeps the source in place.
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::hard_link(temp.0.join("a.txt"), temp.0.join("A.txt")).unwrap();
    let script =
        remote_rename_script(temp.root(), "a.txt", "A.txt").replacen("mv -T --", "mv -@ --", 1);
    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(temp.0.join("A.txt")).unwrap(), "a");

    // A temporary name already taken aborts before anything moves.
    let script = script.replacen("tmp=./.soreno-rename.$$", "tmp=./taken", 1);
    fs::create_dir(temp.0.join("taken")).unwrap();
    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert!(temp.0.join("a.txt").is_file());
    assert_eq!(fs::read_dir(temp.0.join("taken")).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn remote_case_only_rename_restores_the_source_when_the_final_move_does_not_happen() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::write(temp.0.join("A.txt"), "upper").unwrap();
    if fs::read_to_string(temp.0.join("a.txt")).unwrap() == "upper" {
        return; // The faked same-file case below needs a case-sensitive filesystem.
    }
    let leftovers = || {
        fs::read_dir(&temp.0)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".soreno-rename.")
            })
            .count()
    };
    let same_file = "[ \"$source\" -ef \"$target\" ]";
    let final_move = "mv -n -- \"$tmp\" \"$target\"";
    let restore = "mv -n -- \"$tmp\" \"$source\"";
    let script = remote_rename_script(temp.root(), "a.txt", "A.txt");
    assert!(script.contains(same_file) && script.contains("mv -T --"));
    assert!(script.contains(final_move) && script.contains(restore));
    // The target name is released (faked same file) and `mv -T` is unavailable.
    let script = script
        .replacen(same_file, "rm -f -- \"$target\"", 1)
        .replacen("mv -T --", "mv -@ --", 1);

    // A failing final move puts the source back under its name.
    let (ok, _, _) = run_script(&script.replacen(final_move, "false", 1));
    assert!(!ok);
    assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
    assert!(!temp.0.join("A.txt").exists());
    assert_eq!(leftovers(), 0);

    // A destination appearing just before the final move makes it skip; the source is restored too.
    fs::write(temp.0.join("A.txt"), "upper").unwrap();
    let appear = format!("printf t > \"$target\" && {final_move}");
    let (ok, _, stderr) = run_script(&script.replacen(final_move, &appear, 1));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(temp.0.join("A.txt")).unwrap(), "t");
    assert_eq!(leftovers(), 0);

    // When the restoration fails too, the project-relative temporary name holding the entry is
    // reported through the `stranded` marker, without the absolute remote path.
    let strand = |script: String| {
        script
            .replacen(same_file, "rm -f -- \"$target\"", 1)
            .replacen("mv -T --", "mv -@ --", 1)
            .replacen(final_move, "false", 1)
            .replacen(restore, "false", 1)
    };
    let (ok, _, stderr) = run_script(&strand(remote_rename_script(temp.root(), "a.txt", "A.txt")));
    assert!(!ok);
    assert!(
        stderr.contains("SORENO_FILE_STRANDED\0.soreno-rename."),
        "{stderr}"
    );
    assert!(!stderr.contains(temp.root()), "{stderr}");
    let error = crate::project_files::remote::remote_error(50, stderr.as_bytes());
    assert_eq!(error.code, "stranded");
    assert!(
        error.message.starts_with(".soreno-rename."),
        "{}",
        error.message
    );
    assert!(temp.0.join(&error.message).is_file());
    assert_eq!(leftovers(), 1);
    assert!(!temp.0.join("a.txt").exists());

    fs::create_dir(temp.0.join("src")).unwrap();
    fs::write(temp.0.join("src/a.txt"), "nested").unwrap();
    fs::write(temp.0.join("src/A.txt"), "upper").unwrap();
    let (ok, _, stderr) = run_script(&strand(remote_rename_script(
        temp.root(),
        "src/a.txt",
        "src/A.txt",
    )));
    assert!(!ok);
    assert!(!stderr.contains(temp.root()), "{stderr}");
    let error = crate::project_files::remote::remote_error(50, stderr.as_bytes());
    assert_eq!(error.code, "stranded");
    assert!(
        error.message.starts_with("src/.soreno-rename."),
        "{}",
        error.message
    );
    assert_eq!(
        fs::read_to_string(temp.0.join(&error.message)).unwrap(),
        "nested"
    );

    // A parent name containing a newline is reported in full.
    let parent = "src\nnested";
    fs::create_dir(temp.0.join(parent)).unwrap();
    fs::write(temp.0.join(parent).join("a.txt"), "newline").unwrap();
    fs::write(temp.0.join(parent).join("A.txt"), "upper").unwrap();
    let (ok, _, stderr) = run_script(&strand(remote_rename_script(
        temp.root(),
        &format!("{parent}/a.txt"),
        &format!("{parent}/A.txt"),
    )));
    assert!(!ok);
    let error = crate::project_files::remote::remote_error(50, stderr.as_bytes());
    assert_eq!(error.code, "stranded");
    assert!(
        error
            .message
            .starts_with(&format!("{parent}/.soreno-rename.")),
        "{:?}",
        error.message
    );
    assert_eq!(
        fs::read_to_string(temp.0.join(&error.message)).unwrap(),
        "newline"
    );
}

#[test]
fn remote_error_reports_stranded_only_for_a_framed_record_with_its_status() {
    use crate::project_files::remote::remote_error;
    // A user-chosen name echoed by an ordinary diagnostic cannot forge the record.
    let forged = b"mkdir: cannot create directory 'SORENO_FILE_STRANDED:x/b.txt': No such file";
    assert_ne!(remote_error(1, forged).code, "stranded");
    let framed = b"SORENO_FILE_STRANDED\0src\nnested/.soreno-rename.1\0";
    assert_ne!(remote_error(1, framed).code, "stranded");
    let error = remote_error(50, framed);
    assert_eq!(error.code, "stranded");
    assert_eq!(error.message, "src\nnested/.soreno-rename.1");
    for malformed in [
        &b"SORENO_FILE_STRANDED:src/.soreno-rename.1\n"[..],
        b"SORENO_FILE_STRANDED\0src/.soreno-rename.1",
        b"SORENO_FILE_STRANDED\0\0",
        b"SORENO_FILE_STRANDED\0\xff\0",
    ] {
        assert_eq!(remote_error(50, malformed).code, "ssh");
    }
}

#[cfg(unix)]
#[test]
fn remote_case_only_rename_keeps_the_temporary_entry_when_a_directory_takes_the_source_name() {
    let temp = TempProject::new();
    fs::write(temp.0.join("a.txt"), "a").unwrap();
    fs::write(temp.0.join("A.txt"), "upper").unwrap();
    if fs::read_to_string(temp.0.join("a.txt")).unwrap() == "upper" {
        return; // The faked same-file case below needs a case-sensitive filesystem.
    }
    let same_file = "[ \"$source\" -ef \"$target\" ]";
    let final_move = "mv -n -- \"$tmp\" \"$target\"";
    // The target name is released (faked same file), `mv -T` is unavailable, and a directory appears at
    // the source name instead of the final move happening.
    let script = remote_rename_script(temp.root(), "a.txt", "A.txt")
        .replacen(same_file, "rm -f -- \"$target\"", 1)
        .replacen("mv -T --", "mv -@ --", 1)
        .replacen(final_move, "mkdir -- \"$source\" && false", 1);

    let (ok, _, stderr) = run_script(&script);
    assert!(!ok);
    assert!(
        stderr.contains("SORENO_FILE_STRANDED\0.soreno-rename."),
        "{stderr}"
    );
    assert!(temp.0.join("a.txt").is_dir());
    assert_eq!(fs::read_dir(temp.0.join("a.txt")).unwrap().count(), 0);
    let stranded: Vec<_> = fs::read_dir(&temp.0)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".soreno-rename.")
        })
        .collect();
    assert_eq!(stranded.len(), 1);
    assert_eq!(fs::read_to_string(&stranded[0]).unwrap(), "a");
}

#[cfg(unix)]
#[test]
fn remote_rename_refuses_hard_links_listed_under_both_names() {
    let temp = TempProject::new();
    fs::write(temp.0.join(".a"), "a").unwrap();
    fs::hard_link(temp.0.join(".a"), temp.0.join(".b")).unwrap();
    fs::create_dir(temp.0.join("sub")).unwrap();
    fs::hard_link(temp.0.join(".a"), temp.0.join("sub/c")).unwrap();

    for (from, to) in [(".a", ".b"), ("sub/c", ".b"), (".a", "sub/c")] {
        let (ok, _, stderr) = run_script(&remote_rename_script(temp.root(), from, to));
        assert!(!ok, "{from} -> {to}");
        assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    }
    for name in [".a", ".b", "sub/c"] {
        assert_eq!(fs::read_to_string(temp.0.join(name)).unwrap(), "a");
    }
}

#[cfg(unix)]
mod unix_helpers {
    use super::super::unix::remove_tree;
    use super::TempProject;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn rollback_removes_copied_directories_without_owner_read() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let temp = TempProject::new();
        fs::create_dir_all(temp.0.join("copy/locked/inner")).unwrap();
        fs::write(temp.0.join("copy/locked/inner/file.txt"), "f").unwrap();
        fs::write(temp.0.join("copy/locked/file.txt"), "f").unwrap();
        fs::set_permissions(
            temp.0.join("copy/locked/inner"),
            fs::Permissions::from_mode(0o055),
        )
        .unwrap();
        fs::set_permissions(
            temp.0.join("copy/locked"),
            fs::Permissions::from_mode(0o055),
        )
        .unwrap();
        fs::set_permissions(temp.0.join("copy"), fs::Permissions::from_mode(0o055)).unwrap();
        let parent = fs::File::open(&temp.0).unwrap();

        let removed = remove_tree(&parent, c"copy", true);
        if temp.0.join("copy").exists() {
            for path in ["copy", "copy/locked", "copy/locked/inner"] {
                let _ = fs::set_permissions(temp.0.join(path), fs::Permissions::from_mode(0o755));
            }
        }
        removed.unwrap();
        assert!(!temp.0.join("copy").exists());
    }
}

#[cfg(unix)]
mod rename_fallback {
    use super::super::unix::{fallback_rename, RenamePrimitives};
    use std::{cell::RefCell, io};

    #[derive(Default)]
    struct Fake {
        link: Option<i32>,
        unlink_source: Option<i32>,
        target_exists: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    fn result(error: Option<i32>) -> io::Result<()> {
        error.map_or(Ok(()), |code| Err(io::Error::from_raw_os_error(code)))
    }

    impl RenamePrimitives for Fake {
        fn link(&self) -> io::Result<()> {
            self.calls.borrow_mut().push("link");
            result(self.link)
        }

        fn unlink_source(&self) -> io::Result<()> {
            self.calls.borrow_mut().push("unlink_source");
            result(self.unlink_source)
        }

        fn unlink_target(&self) {
            self.calls.borrow_mut().push("unlink_target");
        }

        fn target_exists(&self) -> io::Result<bool> {
            self.calls.borrow_mut().push("target_exists");
            Ok(self.target_exists)
        }

        fn rename(&self) -> io::Result<()> {
            self.calls.borrow_mut().push("rename");
            Ok(())
        }
    }

    #[test]
    fn files_without_hard_links_fail_closed_instead_of_replacing() {
        for code in [libc::EPERM, libc::ENOTSUP, libc::EOPNOTSUPP] {
            let fake = Fake {
                link: Some(code),
                ..Fake::default()
            };
            let error = fallback_rename(&fake, false, "a.txt").unwrap_err();
            assert_eq!(error.code, "io");
            assert!(error.message.contains("écraser"), "{}", error.message);
            assert_eq!(*fake.calls.borrow(), ["link"]);
        }

        let fake = Fake {
            link: Some(libc::EXDEV),
            ..Fake::default()
        };
        let error = fallback_rename(&fake, false, "a.txt").unwrap_err();
        assert!(error.message.starts_with("a.txt: "), "{}", error.message);
        assert_eq!(*fake.calls.borrow(), ["link"]);

        let fake = Fake {
            link: Some(libc::EEXIST),
            ..Fake::default()
        };
        assert_eq!(
            fallback_rename(&fake, false, "a.txt").unwrap_err().code,
            "exists"
        );
    }

    #[test]
    fn files_are_linked_then_unlinked_and_rolled_back_on_failure() {
        let fake = Fake::default();
        fallback_rename(&fake, false, "a.txt").unwrap();
        assert_eq!(*fake.calls.borrow(), ["link", "unlink_source"]);

        let fake = Fake {
            unlink_source: Some(libc::EACCES),
            ..Fake::default()
        };
        assert_eq!(
            fallback_rename(&fake, false, "a.txt").unwrap_err().code,
            "permission"
        );
        assert_eq!(
            *fake.calls.borrow(),
            ["link", "unlink_source", "unlink_target"]
        );
    }

    #[test]
    fn directories_check_then_rename() {
        let fake = Fake::default();
        fallback_rename(&fake, true, "dir").unwrap();
        assert_eq!(*fake.calls.borrow(), ["target_exists", "rename"]);

        let fake = Fake {
            target_exists: true,
            ..Fake::default()
        };
        assert_eq!(
            fallback_rename(&fake, true, "dir").unwrap_err().code,
            "exists"
        );
        assert_eq!(*fake.calls.borrow(), ["target_exists"]);
    }
}

#[cfg(unix)]
mod alias_probe {
    use super::super::unix::{probe_alias_rename, AliasPrimitives};
    use crate::project_files::ProjectFileError;
    use std::{cell::RefCell, ffi::CStr, io};

    /// One directory of a case-insensitive filesystem: stored `(name, inode)` entries.
    struct Fake {
        entries: RefCell<Vec<(String, u32)>>,
        fail_move: Option<usize>,
        moves: RefCell<usize>,
    }

    impl Fake {
        fn new(entries: &[(&str, u32)], fail_move: Option<usize>) -> Self {
            Self {
                entries: RefCell::new(
                    entries
                        .iter()
                        .map(|(name, inode)| (name.to_string(), *inode))
                        .collect(),
                ),
                fail_move,
                moves: RefCell::new(0),
            }
        }

        fn find(&self, name: &CStr) -> Option<usize> {
            let name = name.to_str().unwrap();
            self.entries
                .borrow()
                .iter()
                .position(|(stored, _)| stored.eq_ignore_ascii_case(name))
        }

        fn sorted(&self) -> Vec<(String, u32)> {
            let mut entries = self.entries.borrow().clone();
            entries.sort();
            entries
        }
    }

    impl AliasPrimitives for Fake {
        fn move_entry(&self, from: &CStr, to: &CStr) -> Result<(), ProjectFileError> {
            let call = {
                let mut moves = self.moves.borrow_mut();
                *moves += 1;
                *moves
            };
            if self.fail_move == Some(call) {
                return Err(ProjectFileError::new("io", "refusé"));
            }
            let source = self.find(from).expect("source resolves");
            if self.find(to).is_some_and(|target| target != source) {
                return Err(ProjectFileError::new("exists", "existe"));
            }
            self.entries.borrow_mut()[source].0 = to.to_str().unwrap().to_string();
            Ok(())
        }

        fn resolves(&self, name: &CStr) -> io::Result<bool> {
            Ok(self.find(name).is_some())
        }
    }

    fn entries(entries: &[(&str, u32)]) -> Vec<(String, u32)> {
        let mut entries: Vec<_> = entries
            .iter()
            .map(|(name, inode)| (name.to_string(), *inode))
            .collect();
        entries.sort();
        entries
    }

    #[test]
    fn alias_with_an_unrelated_sibling_hard_link_is_renamed() {
        let fake = Fake::new(&[("a.txt", 7), ("backup.txt", 7)], None);
        probe_alias_rename(&fake, c"a.txt", c"A.txt", "A.txt").unwrap();
        assert_eq!(fake.sorted(), entries(&[("A.txt", 7), ("backup.txt", 7)]));
    }

    #[test]
    fn distinct_hard_link_target_is_refused_and_the_source_restored() {
        // Stored `A.txt` / `B.txt` hard links requested as `a.txt` -> `b.txt`.
        let fake = Fake::new(&[("A.txt", 7), ("B.txt", 7)], None);
        let error = probe_alias_rename(&fake, c"a.txt", c"b.txt", "b.txt").unwrap_err();
        assert_eq!(error.code, "exists");
        assert_eq!(fake.sorted(), entries(&[("B.txt", 7), ("a.txt", 7)]));
    }

    #[test]
    fn failed_restore_or_finish_names_the_temporary_entry() {
        for (stored, target, path) in [
            ("B.txt", c"b.txt", "src/b.txt"),
            ("other.txt", c"A.txt", "src/A.txt"),
        ] {
            let fake = Fake::new(&[("a.txt", 7), (stored, 7)], Some(2));
            let error = probe_alias_rename(&fake, c"a.txt", target, path).unwrap_err();
            let temporary = fake
                .sorted()
                .into_iter()
                .map(|(name, _)| name)
                .find(|name| name.starts_with(".soreno-rename-"))
                .expect("source kept under its temporary name");
            assert_eq!(error.code, "stranded");
            assert_eq!(error.message, format!("src/{temporary}"));
        }
    }
}

#[cfg(unix)]
#[test]
fn remote_duplicate_reserves_its_destination_before_copying() {
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("pkg")).unwrap();
    fs::write(temp.0.join("pkg/.hidden"), "hidden").unwrap();
    fs::write(temp.0.join("run.sh"), "run").unwrap();
    fs::create_dir(temp.0.join("pkg copy")).unwrap();
    fs::write(temp.0.join("pkg copy/mine"), "mine").unwrap();
    fs::write(temp.0.join("run copy.sh"), "other").unwrap();

    // Candidates appearing after the existence check are skipped by the reservation itself.
    let check = "if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; ";
    for (path, expected) in [("pkg", "d\npkg copy 2"), ("run.sh", "f\nrun copy 2.sh")] {
        let script = remote_duplicate_script(temp.root(), path);
        assert!(script.contains(check));
        let (ok, stdout, stderr) = run_script(&script.replacen(check, "", 1));
        assert!(ok, "{stderr}");
        assert_eq!(stdout, expected);
    }
    assert_eq!(
        fs::read_to_string(temp.0.join("pkg copy 2/.hidden")).unwrap(),
        "hidden"
    );
    assert_eq!(
        fs::read_to_string(temp.0.join("run copy 2.sh")).unwrap(),
        "run"
    );
    assert_eq!(fs::read_dir(temp.0.join("pkg copy")).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(temp.0.join("run copy.sh")).unwrap(),
        "other"
    );

    if unsafe { libc::geteuid() } != 0 {
        use std::os::unix::fs::PermissionsExt;
        fs::write(temp.0.join("pkg/locked"), "locked").unwrap();
        fs::set_permissions(temp.0.join("pkg/locked"), fs::Permissions::from_mode(0)).unwrap();
        let (ok, _, _) = run_script(&remote_duplicate_script(temp.root(), "pkg"));
        assert!(!ok);
        assert!(
            !temp.0.join("pkg copy 3").exists(),
            "failed copy is removed"
        );
    }

    // Candidates that are links (dangling or not) are never written through.
    let outside = TempProject::new();
    fs::write(outside.0.join("secret.txt"), "secret").unwrap();
    fs::remove_file(temp.0.join("run copy.sh")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("secret.txt"), temp.0.join("run copy.sh")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("new.txt"), temp.0.join("run copy 3.sh")).unwrap();
    let script = remote_duplicate_script(temp.root(), "run.sh").replacen(check, "", 1);
    let (ok, stdout, stderr) = run_script(&script);
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f\nrun copy 4.sh");
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.txt")).unwrap(),
        "secret"
    );
    assert!(!outside.0.join("new.txt").exists());

    // A reserved directory swapped for a link before the copy is refused.
    let swap = format!(
        "rmdir -- \"$target\"; ln -s -- {} \"$target\"; cd -P -- \"$target\"",
        crate::ssh::quote(outside.root())
    );
    let script = remote_duplicate_script(temp.root(), "pkg");
    assert!(script.contains("cd -P -- \"$target\""));
    let (ok, _, stderr) = run_script(&script.replacen("cd -P -- \"$target\"", &swap, 1));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_SYMLINK"), "{stderr}");
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn remote_duplicate_removes_a_failed_copy_of_a_read_only_directory() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let temp = TempProject::new();
    fs::create_dir(temp.0.join("ro")).unwrap();
    fs::write(temp.0.join("ro/ok.txt"), "ok").unwrap();
    fs::write(temp.0.join("ro/locked"), "locked").unwrap();
    fs::set_permissions(temp.0.join("ro/locked"), fs::Permissions::from_mode(0)).unwrap();
    fs::set_permissions(temp.0.join("ro"), fs::Permissions::from_mode(0o555)).unwrap();

    let (ok, _, _) = run_script(&remote_duplicate_script(temp.root(), "ro"));
    let copy_left = temp.0.join("ro copy").exists();
    if copy_left {
        let _ = fs::set_permissions(temp.0.join("ro copy"), fs::Permissions::from_mode(0o755));
    }
    fs::set_permissions(temp.0.join("ro"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!ok);
    assert!(!copy_left, "failed copy is removed");
}

#[cfg(unix)]
#[test]
fn duplicate_removes_a_failed_copy_holding_a_read_only_directory() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let temp = TempProject::new();
    let project = temp.project();
    fs::create_dir_all(temp.0.join("pkg/ro")).unwrap();
    fs::write(temp.0.join("pkg/ro/file.txt"), "f").unwrap();
    fs::write(temp.0.join("pkg/locked"), "locked").unwrap();
    fs::set_permissions(temp.0.join("pkg/locked"), fs::Permissions::from_mode(0)).unwrap();
    // The read-only directory must be copied before the unreadable file fails the copy; recreating it
    // under a new name changes its place in the directory order.
    let mut directory = "ro".to_owned();
    for attempt in 0.. {
        let order: Vec<_> = fs::read_dir(temp.0.join("pkg"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        if order.iter().position(|name| *name == directory)
            < order.iter().position(|name| name == "locked")
        {
            break;
        }
        if attempt == 32 {
            return;
        }
        let renamed = format!("ro{attempt}");
        fs::rename(
            temp.0.join("pkg").join(&directory),
            temp.0.join("pkg").join(&renamed),
        )
        .unwrap();
        directory = renamed;
    }
    fs::set_permissions(
        temp.0.join("pkg").join(&directory),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();

    let result = duplicate(&project, "pkg");
    let copy_left = temp.0.join("pkg copy").exists();
    if copy_left {
        let _ = fs::set_permissions(
            temp.0.join("pkg copy").join(&directory),
            fs::Permissions::from_mode(0o755),
        );
    }
    fs::set_permissions(
        temp.0.join("pkg").join(&directory),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(result.is_err());
    assert!(!copy_left, "failed copy is removed");
}

#[cfg(unix)]
#[test]
fn remote_file_reservations_refuse_existing_non_regular_names() {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let temp = TempProject::new();
    let outside = TempProject::new();
    fs::write(temp.0.join("run.sh"), "run").unwrap();
    // A named pipe with a reader would receive anything written through the link.
    let pipe = outside.0.join("pipe");
    let pipe_name = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(pipe_name.as_ptr(), 0o600) }, 0);
    let mut reader = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&pipe)
        .unwrap();
    std::os::unix::fs::symlink(&pipe, temp.0.join("run copy.sh")).unwrap();

    // The existence pre-checks are bypassed, as if the link appeared right after them.
    let check = "if [ -e \"$target\" ] || [ -L \"$target\" ]; then continue; fi; ";
    let script = remote_duplicate_script(temp.root(), "run.sh");
    assert!(script.contains(check));
    let (ok, stdout, stderr) = run_script(&script.replacen(check, "", 1));
    assert!(!ok, "{stdout}");
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert!(fs::symlink_metadata(temp.0.join("run copy.sh"))
        .unwrap()
        .file_type()
        .is_symlink());
    let mut written = Vec::new();
    if let Err(error) = reader.read_to_end(&mut written) {
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
    }
    assert!(written.is_empty(), "written through the link: {written:?}");

    // A link to a device is refused the same way, before any content is copied.
    fs::remove_file(temp.0.join("run copy.sh")).unwrap();
    std::os::unix::fs::symlink("/dev/null", temp.0.join("run copy.sh")).unwrap();
    let (ok, stdout, stderr) = run_script(&script.replacen(check, "", 1));
    assert!(!ok, "{stdout}");
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");

    // The create walk refuses a link already at the name, so it appears only after every check.
    let check = "if [ -e \"$target\" ] || [ -L \"$target\" ]; then { printf 'SORENO_FILE_EXISTS\\n' >&2; exit 48; }; fi; ";
    let script = remote_create_script(temp.root(), "new.txt", ProjectFileKind::File);
    assert!(script.contains(check));
    let appear = "ln -s /dev/null \"$target\"; ";
    let (ok, _, stderr) = run_script(&script.replacen(check, appear, 1));
    assert!(!ok);
    assert!(stderr.contains("SORENO_FILE_EXISTS"), "{stderr}");
    assert!(fs::symlink_metadata(temp.0.join("new.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn remote_duplicate_copies_file_content_and_permission_bits() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempProject::new();
    fs::write(temp.0.join("run.sh"), "#!/bin/sh\necho run\n").unwrap();
    fs::set_permissions(temp.0.join("run.sh"), fs::Permissions::from_mode(0o751)).unwrap();

    let (ok, stdout, stderr) = run_script(&remote_duplicate_script(temp.root(), "run.sh"));
    assert!(ok, "{stderr}");
    assert_eq!(stdout, "f\nrun copy.sh");
    let copy = temp.0.join("run copy.sh");
    assert_eq!(fs::read_to_string(&copy).unwrap(), "#!/bin/sh\necho run\n");
    assert_eq!(
        fs::metadata(&copy).unwrap().permissions().mode() & 0o7777,
        0o751
    );
}
