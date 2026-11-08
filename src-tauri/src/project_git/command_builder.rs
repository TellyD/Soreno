use super::{ssh_connection, AgentProject, GitError, GIT_OVERRIDES};
use std::process::Command;

fn git_arguments(project: &AgentProject, args: &[&str]) -> Result<Vec<String>, GitError> {
    let version_only = args == ["--version"];
    let mut git_args = vec!["--no-replace-objects".to_string()];
    if version_only {
        git_args.push("--version".into());
    } else {
        git_args.extend(
            [
                "--no-pager",
                "--no-optional-locks",
                "-c",
                "color.ui=false",
                "-c",
                "core.pager=cat",
                "-c",
                "diff.external=",
                "-C",
                &project.path,
            ]
            .map(str::to_string),
        );
        let Some((subcommand, rest)) = args.split_first() else {
            return Err(GitError::new("malformed", "Sous-commande Git absente."));
        };
        git_args.push((*subcommand).into());
        if matches!(
            *subcommand,
            "diff" | "show" | "log" | "diff-tree" | "diff-index" | "diff-files"
        ) {
            git_args.extend(["--no-ext-diff".into(), "--no-textconv".into()]);
        }
        git_args.extend(rest.iter().map(|argument| (*argument).to_string()));
    }
    Ok(git_args)
}

pub(super) fn posix_git_environment() -> String {
    format!("unset {}; export LC_ALL=C GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_ALLOW_PROTOCOL=https:ssh:file;", GIT_OVERRIDES.join(" "))
}

pub(super) fn ssh_git_script(project: &AgentProject, args: &[&str]) -> Result<String, GitError> {
    if args != ["--version"] {
        crate::ssh::validate_path(&project.path)
            .map_err(|message| GitError::new("invalidPath", message))?;
    }
    let mut script = format!("{} exec git", posix_git_environment());
    for argument in git_arguments(project, args)? {
        script.push(' ');
        script.push_str(&crate::ssh::quote(&argument));
    }
    Ok(script)
}

pub(crate) fn git_command(project: &AgentProject, args: &[&str]) -> Result<Command, GitError> {
    if project.environment.kind == "ssh" {
        let connection = ssh_connection(project)?;
        let mut command = crate::ssh::command(connection, &ssh_git_script(project, args)?)
            .map_err(|message| GitError::new("inaccessible", message))?;
        command.env("SORENO_GIT_SSH_COMMAND", "1");
        return Ok(command);
    }

    let git_args = git_arguments(project, args)?;
    let mut command = git_program(project);
    command.args(&git_args[1..]);
    Ok(command)
}

pub(super) fn git_program(project: &AgentProject) -> Command {
    let mut command = if project.environment.kind == "wsl" {
        let mut command = Command::new("wsl.exe");
        command.current_dir(std::env::temp_dir()).args([
            "--distribution",
            project.environment.distribution.as_deref().unwrap_or(""),
            "--exec",
            "env",
        ]);
        for name in GIT_OVERRIDES {
            command.args(["-u", name]);
        }
        command.args([
            "LC_ALL=C",
            "GIT_PAGER=cat",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_EDITOR=true",
            "GIT_ALLOW_PROTOCOL=https:ssh:file",
            "git",
        ]);
        command
    } else {
        Command::new("git")
    };
    clear_git_overrides(&mut command);
    command
        .arg("--no-replace-objects")
        .env("LC_ALL", "C")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_ALLOW_PROTOCOL", "https:ssh:file");
    #[cfg(windows)]
    command.env("WSLENV", crate::agent_sessions::host_wslenv());
    command
}

pub(super) fn clear_git_overrides(command: &mut Command) {
    for name in GIT_OVERRIDES {
        command.env_remove(name);
    }
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        if name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_") {
            command.env_remove(name.as_ref());
        }
    }
}

#[cfg(any(windows, test))]
pub(super) fn wsl_readonly_command(distribution: &str, script: &str) -> Command {
    let mut command = Command::new("wsl.exe");
    crate::agent_sessions::wsl_root_script(&mut command, distribution, script);
    clear_git_overrides(&mut command);
    command
}
