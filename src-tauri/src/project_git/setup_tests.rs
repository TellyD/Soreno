use super::*;
use crate::agent_sessions::tests::unique_temp_path;
use crate::project_git::test_fixtures::{git_with_env_identity, local_project};
use std::fs;

struct Temp {
    root: PathBuf,
    sessions: AgentSessions,
}

impl Temp {
    fn new(label: &str) -> Self {
        let root = unique_temp_path(&format!("soreno-git-setup-{label}"));
        fs::create_dir_all(&root).unwrap();
        let sessions = AgentSessions::open(&root.join("app-data")).unwrap();
        Self { root, sessions }
    }

    fn environment() -> AgentEnvironment {
        AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        }
    }

    fn project(&self, id: &str, path: &Path) -> AgentProject {
        local_project(id, id, path)
    }

    fn configure(&self, directory: &Path) {
        self.git(directory, &["config", "--local", "core.autocrlf", "false"]);
        self.git(directory, &["config", "--local", "core.eol", "lf"]);
    }

    fn git(&self, directory: &Path, args: &[&str]) -> String {
        git_with_env_identity(&self.root, directory, args)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        self.sessions.shutdown();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn initializes_only_a_fresh_non_repository_with_an_unborn_main_branch() {
    let temp = Temp::new("init");
    let directory = temp.root.join("new repository");
    fs::create_dir(&directory).unwrap();
    temp.sessions
        .save_project(temp.project("new", &directory))
        .unwrap();
    let project = temp.sessions.project("new").unwrap();
    let version = repository(&project).unwrap().version;
    init(&temp.sessions, "new", &version).unwrap();
    assert_eq!(temp.git(&directory, &["branch", "--show-current"]), "main");
    assert!(temp.git(&directory, &["rev-list", "--all"]).is_empty());

    let child = directory.join("child");
    fs::create_dir(&child).unwrap();
    temp.sessions
        .save_project(temp.project("child", &child))
        .unwrap();
    let child_version = repository(&temp.sessions.project("child").unwrap())
        .unwrap()
        .version;
    assert_eq!(
        init(&temp.sessions, "child", &child_version)
            .unwrap_err()
            .code,
        "repositoryExists"
    );

    let bare = temp.root.join("bare.git");
    fs::create_dir(&bare).unwrap();
    temp.git(&bare, &["init", "--bare"]);
    temp.configure(&bare);
    temp.sessions
        .save_project(temp.project("bare", &bare))
        .unwrap();
    let bare_version = repository(&temp.sessions.project("bare").unwrap())
        .unwrap()
        .version;
    assert_eq!(
        init(&temp.sessions, "bare", &bare_version)
            .unwrap_err()
            .code,
        "repositoryExists"
    );
}

#[test]
fn clones_literal_paths_and_preserves_failed_or_occupied_destinations() {
    let temp = Temp::new("clone");
    let source = temp.root.join("source ;$(touch injected)");
    let parent = temp.root.join("parent with spaces");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&parent).unwrap();
    temp.git(&source, &["init", "--initial-branch=main"]);
    temp.configure(&source);
    fs::write(source.join("tracked"), "content\n").unwrap();
    temp.git(&source, &["add", "tracked"]);
    temp.git(&source, &["commit", "-m", "initial"]);

    let project = clone(
        &temp.sessions,
        GitCloneRequest {
            id: "cloned".into(),
            name: "Cloned".into(),
            environment: Temp::environment(),
            parent_path: parent.to_string_lossy().into(),
            folder_name: "copy with spaces".into(),
            url: source.to_string_lossy().into(),
        },
    )
    .unwrap();
    assert_eq!(
        temp.git(Path::new(&project.path), &["rev-parse", "HEAD:tracked"]),
        temp.git(&source, &["rev-parse", "HEAD:tracked"])
    );
    assert!(!temp.root.join("injected").exists());

    temp.git(&parent, &["init"]);
    temp.configure(&parent);
    temp.git(
        &parent,
        &[
            "config",
            &format!("url.{}.insteadOf", source.to_string_lossy()),
            "https://rewrite.invalid/repository",
        ],
    );
    let rewritten_path = parent.join("rewritten");
    assert_eq!(
        clone(
            &temp.sessions,
            GitCloneRequest {
                id: "rewritten".into(),
                name: "Rewritten".into(),
                environment: Temp::environment(),
                parent_path: parent.to_string_lossy().into(),
                folder_name: "rewritten".into(),
                url: "https://rewrite.invalid/repository".into(),
            },
        )
        .unwrap_err()
        .code,
        "rewrittenUrl"
    );
    assert!(!rewritten_path.exists());
    temp.git(
        &parent,
        &[
            "config",
            "--unset-all",
            &format!("url.{}.insteadOf", source.to_string_lossy()),
        ],
    );

    let duplicate_path = parent.join("duplicate id");
    let duplicate_error = clone(
        &temp.sessions,
        GitCloneRequest {
            id: "cloned".into(),
            name: "Duplicate".into(),
            environment: Temp::environment(),
            parent_path: parent.to_string_lossy().into(),
            folder_name: "duplicate id".into(),
            url: source.to_string_lossy().into(),
        },
    )
    .unwrap_err();
    assert_eq!(duplicate_error.code, "busy");
    assert!(!duplicate_path.exists());

    let occupied = parent.join("occupied");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep"), "keep").unwrap();
    let occupied_error = clone(
        &temp.sessions,
        GitCloneRequest {
            id: "occupied".into(),
            name: "Occupied".into(),
            environment: Temp::environment(),
            parent_path: parent.to_string_lossy().into(),
            folder_name: "occupied".into(),
            url: source.to_string_lossy().into(),
        },
    )
    .unwrap_err();
    assert_eq!(occupied_error.code, "destinationExists");
    assert_eq!(fs::read_to_string(occupied.join("keep")).unwrap(), "keep");

    let partial_path = parent.join("partial");
    let partial_error = clone(
        &temp.sessions,
        GitCloneRequest {
            id: "partial".into(),
            name: "Partial".into(),
            environment: Temp::environment(),
            parent_path: parent.to_string_lossy().into(),
            folder_name: "partial".into(),
            url: temp.root.join("missing.git").to_string_lossy().into(),
        },
    )
    .unwrap_err();
    assert_eq!(
        partial_error.path.as_deref(),
        Some(partial_path.to_str().unwrap())
    );
    assert!(partial_path.is_dir());
}

#[test]
fn rejects_hostile_folder_names_and_urls() {
    for name in [
        "",
        ".",
        "..",
        ".git",
        "a/b",
        "a\\b",
        "CON",
        "name.",
        "bad\nname",
    ] {
        assert!(validate_folder_name(name).is_err(), "{name:?}");
    }
    for url in [
        "-upload-pack=bad",
        "ext::sh -c bad",
        "http://example.invalid/repo",
    ] {
        assert!(remotes::validate_remote_url(url).is_err(), "{url}");
    }
    assert_eq!(
        logical_destination(
            &AgentEnvironment {
                kind: "wsl".into(),
                distribution: Some("Ubuntu".into()),
                ssh: None,
            },
            "/home/me",
            "repo"
        )
        .unwrap(),
        "/home/me/repo"
    );
}

#[cfg(windows)]
#[test]
fn maps_an_available_wsl_parent_to_unc() {
    let Ok(distribution) = std::env::var("SORENO_TEST_WSL_DISTRO") else {
        return;
    };
    let environment = AgentEnvironment {
        kind: "wsl".into(),
        distribution: Some(distribution.clone()),
        ssh: None,
    };
    assert_eq!(
        picker_default_directory(&environment, Some("/home/me"))
            .unwrap()
            .unwrap(),
        PathBuf::from(format!("\\\\wsl.localhost\\{distribution}\\home\\me"))
    );
    assert_eq!(
        logical_destination(&environment, "/home/me", "repo").unwrap(),
        "/home/me/repo"
    );
}

#[test]
fn keeps_clone_when_registration_capacity_is_exhausted() {
    let temp = Temp::new("registration");
    let source = temp.root.join("source");
    let parent = temp.root.join("parent");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&parent).unwrap();
    temp.git(&source, &["init", "--initial-branch=main"]);
    temp.configure(&source);
    for index in 0..128 {
        let directory = temp.root.join(format!("registered-{index}"));
        fs::create_dir(&directory).unwrap();
        temp.sessions
            .save_project(temp.project(&format!("project-{index}"), &directory))
            .unwrap();
    }
    let path = parent.join("preserved");
    let error = clone(
        &temp.sessions,
        GitCloneRequest {
            id: "overflow".into(),
            name: "Overflow".into(),
            environment: Temp::environment(),
            parent_path: parent.to_string_lossy().into(),
            folder_name: "preserved".into(),
            url: source.to_string_lossy().into(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "registrationFailed");
    assert_eq!(error.path.as_deref(), path.to_str());
    assert!(path.join(".git").is_dir());
}
