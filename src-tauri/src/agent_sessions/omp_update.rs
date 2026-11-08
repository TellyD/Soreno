//! Checks and installs updates of the `omp` a project's conversations run, in its environment.
use super::{AgentProject, Result};
use crate::codex_cli::process::{run_command_output, CommandFailure};
use std::time::Duration;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);
const OUTPUT_LIMIT: usize = 64 * 1024;

/// The newer version `omp update --check` reports; none when up to date or managed elsewhere.
pub(super) fn available(project: &AgentProject) -> Result<Option<String>> {
    Ok(newer_version(&run(
        project,
        &["update", "--check"],
        CHECK_TIMEOUT,
    )?))
}

/// `omp update` exits 0 without updating a Nix install: a version still pending fails with its output.
pub(super) fn install(project: &AgentProject) -> Result<()> {
    let output = run(project, &["update"], UPDATE_TIMEOUT)?;
    match available(project)? {
        None => Ok(()),
        Some(_) => Err(output.trim().into()),
    }
}

/// `omp`'s stdout, or its error output when it fails.
fn run(project: &AgentProject, args: &[&str], timeout: Duration) -> Result<String> {
    let script = crate::ssh::login_shell_script(&format!("exec omp {}", args.join(" ")));
    let (success, stdout, stderr) = if project.environment.kind == "ssh" {
        let connection = project
            .environment
            .ssh
            .as_ref()
            .ok_or("Connexion SSH manquante.")?;
        let _access = crate::ssh::begin_access(connection)?;
        let output =
            crate::ssh::run_output_with_timeout(connection, &script, None, OUTPUT_LIMIT, timeout)?;
        (
            output.status == 0,
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    } else {
        let output = run_command_output(
            &mut command(project, args, &script)?,
            timeout,
            true,
            OUTPUT_LIMIT as u64,
        )
        .map_err(|failure| match failure {
            CommandFailure::Io(error) => error,
            CommandFailure::Timeout => "OMP n’a pas répondu à temps.".into(),
        })?;
        (output.status.success(), output.stdout, output.stderr)
    };
    if success {
        Ok(stdout)
    } else if stderr.trim().is_empty() {
        Err(stdout.trim().into())
    } else {
        Err(stderr.trim().into())
    }
}

fn command(project: &AgentProject, args: &[&str], script: &str) -> Result<std::process::Command> {
    if project.environment.kind == "wsl" {
        #[cfg(windows)]
        return Ok(crate::subscription_usage::wsl_command(
            project
                .environment
                .distribution
                .as_deref()
                .ok_or("Distribution WSL manquante.")?,
            script,
        ));
        #[cfg(not(windows))]
        return Err("WSL n’est disponible que sous Windows.".into());
    }
    #[cfg(unix)]
    {
        let _ = args;
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        Ok(command)
    }
    #[cfg(windows)]
    {
        let _ = script;
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-EncodedCommand",
            &super::windows_launcher("omp", &args, true)?,
        ]);
        Ok(command)
    }
}

fn newer_version(output: &str) -> Option<String> {
    let (_, rest) = output.split_once("New version available: ")?;
    let version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect();
    (!version.is_empty()).then_some(version)
}

#[cfg(test)]
mod tests {
    use super::newer_version;

    #[test]
    fn reads_the_newer_version_omp_reports() {
        assert_eq!(
            newer_version("Current version: 18.11.1\n\u{1b}[36mNew version available: 18.12.0-rc.1\u{1b}[39m\n"),
            Some("18.12.0-rc.1".into())
        );
        assert_eq!(
            newer_version("Current version: 18.11.1\n✔ Already up to date\n"),
            None
        );
        assert_eq!(
            newer_version("omp is installed and kept up to date by brew; update it from brew.\n"),
            None
        );
    }
}
