use super::super::GitError;
use crate::agent_sessions::AgentProject;

pub(super) fn remote_read_timeout() -> Result<(std::time::Duration, bool), GitError> {
    super::super::check_read_deadline()?;
    let started = std::time::Instant::now();
    let ssh_deadline = started + crate::ssh::TIMEOUT;
    let (deadline, read_budget_expires_first) =
        super::super::bounded_by_read_deadline(super::super::read_deadline(), ssh_deadline);
    let timeout = deadline.saturating_duration_since(started);
    Ok((timeout, read_budget_expires_first))
}

pub(super) fn remote_read_error(message: String, read_budget_expires_first: bool) -> GitError {
    if message.contains("Délai SSH") && read_budget_expires_first {
        super::super::read_timeout_error()
    } else if message.contains("Délai SSH") {
        GitError::new("timeout", message)
    } else {
        GitError::new("inaccessible", message)
    }
}

pub(super) fn remote_read(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    let (timeout, read_budget_expires_first) = remote_read_timeout()?;
    let connection = super::super::ssh_connection(project)?;
    match crate::ssh::run_read_output_with_timeout(
        connection,
        script,
        input,
        8 * 1024 * 1024,
        timeout,
    ) {
        Ok(output) if output.status == 0 => {
            super::super::check_read_deadline()?;
            Ok(output.stdout)
        }
        Ok(output) => Err(GitError::new(
            "inaccessible",
            crate::ssh::failure_message(&output.stderr),
        )),
        Err(message) => Err(remote_read_error(message, read_budget_expires_first)),
    }
}

pub(super) fn posix_read(
    project: &AgentProject,
    script: &str,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    if project.environment.kind == "wsl" {
        super::super::check_read_deadline()?;
        let output = super::super::run_wsl_readonly(project, script, input.unwrap_or_default())?;
        super::super::check_read_deadline()?;
        Ok(output)
    } else {
        remote_read(project, script, input)
    }
}
