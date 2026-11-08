use crate::agent_sessions::{AgentEnvironment, AgentProject};
use std::{
    path::Path,
    process::{Command, Output},
};

pub(crate) fn local_project(id: &str, name: &str, path: &Path) -> AgentProject {
    AgentProject {
        id: id.into(),
        name: name.into(),
        path: path.to_string_lossy().into(),
        environment: AgentEnvironment {
            kind: "local".into(),
            distribution: None,
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    }
}

/// Runs Git isolated in `home`, with the test identity passed as `-c` options.
pub(super) fn git_with_config_identity(home: &Path, directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Soreno Test",
            "-c",
            "user.email=test@soreno.invalid",
            "-c",
            "commit.gpgSign=false",
            "-C",
        ])
        .arg(directory)
        .args(args)
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("config"))
        .output()
        .unwrap();
    successful_stdout(output, args)
}

/// Runs Git isolated in `home`, with the test identity passed as author/committer variables.
pub(super) fn git_with_env_identity(home: &Path, directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("config"))
        .env("GIT_AUTHOR_NAME", "Soreno Test")
        .env("GIT_AUTHOR_EMAIL", "test@soreno.invalid")
        .env("GIT_COMMITTER_NAME", "Soreno Test")
        .env("GIT_COMMITTER_EMAIL", "test@soreno.invalid")
        .output()
        .unwrap();
    successful_stdout(output, args)
}

/// Git isolated in `home`, ignoring any repository selected by the caller's environment.
pub(super) fn isolated_git(home: &Path, directory: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(directory)
        .args(args)
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("global-config"))
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    command
}

pub(super) fn successful_bytes(output: Output, args: &[&str]) -> Vec<u8> {
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

pub(crate) fn successful_stdout(output: Output, args: &[&str]) -> String {
    String::from_utf8(successful_bytes(output, args))
        .unwrap()
        .trim()
        .into()
}
